//! SF2: bounded, synchronous algorithm boundary shared by Native and WASM.
//!
//! No detector, RPC provider, CoreSession wiring or policy verdict composition.
//! PinnedInvocation is supplied by the native plan owner, never trusted from a
//! host fact. Missing/error results remain errors; this module cannot emit quiet.

pub mod types;
mod validation;

#[cfg(test)]
mod tests;

use std::io::{self, Write};

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub use types::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The real library implements this port during algorithm handoff. No implicit
/// default implementation exists. Implementations must honor all work/size
/// limits and return errors rather than panic; this is not a trap/OOM sandbox.
pub trait AlgorithmModule {
    fn identity(&self) -> AlgorithmIdentity;
    fn supported_limits(&self) -> AlgorithmLimits;
    fn work_unit(&self) -> &str;
    fn analysis_mode(&self) -> AnalysisMode;
    fn supports(&self, rule: &RuleSpec) -> AlgorithmSupport;
    fn analyze(
        &self,
        request: &AnalysisRequest,
        limits: &AlgorithmLimits,
    ) -> Result<ScamAnalysis, AlgorithmError>;
}

/// SF3 supplies these from its immutable native plan and validated provider
/// envelope. Coverage provenance cannot be reconstructed from the slim request.
#[derive(Debug, Clone, Serialize)]
pub struct PinnedInvocation {
    pub binding: AnalysisBinding,
    pub rules: Vec<RuleSpec>,
    pub history_coverage: DataCoverage,
    pub profile_coverage: DataCoverage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedAnalysis {
    pub binding: AnalysisBinding,
    pub analysis: ScamAnalysis,
    pub rules: Vec<RuleResult>,
}

pub struct AlgorithmAdapter<'a> {
    module: Option<&'a dyn AlgorithmModule>,
    allow_stub: bool,
}

impl<'a> AlgorithmAdapter<'a> {
    pub fn new(module: Option<&'a dyn AlgorithmModule>) -> Self {
        Self { module, allow_stub: false }
    }

    /// Tests must explicitly opt in. This constructor does not exist in a
    /// normal Native/WASM library build; stubs cannot become product defaults.
    #[cfg(any(test, feature = "scam-test-fixtures"))]
    pub(crate) fn with_test_stub(module: &'a dyn AlgorithmModule) -> Self {
        Self { module: Some(module), allow_stub: true }
    }

    pub fn evaluate(
        &self,
        pinned: &PinnedInvocation,
        request_json: Option<&str>,
        requested_limits: &AlgorithmLimits,
        deadline_ms: u64,
        mut now_ms: impl FnMut() -> u64,
    ) -> Result<ValidatedAnalysis, FailureReason> {
        let module = self.module.ok_or(FailureReason::AlgorithmUnavailable)?;
        let identity = module.identity();
        let mode = module.analysis_mode();
        if identity != pinned.binding.algorithm
            || identity.contract_version != 1
            || identity.id.is_empty()
            || identity.version.is_empty()
            || module.work_unit().is_empty()
            || (mode == AnalysisMode::Stub && !self.allow_stub)
        {
            return Err(FailureReason::AlgorithmIncompatible);
        }
        let supported = module.supported_limits();
        validate_limits(&supported).map_err(|_| FailureReason::AlgorithmIncompatible)?;
        validate_limits(requested_limits)?;
        let limits = intersect_limits(requested_limits, &supported);
        check_encoded_size(pinned, limits.max_input_bytes)?;
        let started_at = now_ms();
        if deadline_ms > MAX_SAFE_INTEGER || started_at > MAX_SAFE_INTEGER {
            return Err(FailureReason::InvalidScamInput);
        }
        if started_at >= deadline_ms {
            return Err(FailureReason::NoTimeBudget);
        }
        let input = request_json.ok_or(FailureReason::ScamResultsMissing)?;
        if input.len() as u64 > limits.max_input_bytes {
            return Err(FailureReason::ResourceLimit);
        }
        // Reuse strict JSON syntax/duplicate-member/number checks, not policy
        // fact validation. Map every failure to the dedicated scam channel.
        let value = crate::bundle::strict_json::parse(input)
            .map_err(|_| FailureReason::InvalidScamInput)?;
        for field in ["poolCreatedMs", "ageLowerBoundMs"] {
            if value.get("tokenProfile").and_then(|p| p.get(field)).is_some_and(|v| v.is_null()) {
                return Err(FailureReason::InvalidScamInput);
            }
        }
        let request: AnalysisRequest = serde_json::from_value(value)
            .map_err(|_| FailureReason::InvalidScamInput)?;
        validation::validate_request(&request, &pinned.binding, &pinned.rules, &limits)?;
        validate_coverage(&pinned.history_coverage, &request.pool_history.missing, &request, request.pool_history.from_ms)?;
        let profile_from = request.as_of.t_ms.saturating_sub(request.rules.iter()
            .filter(|r| matches!(r, RuleSpec::EventCount { .. }))
            .map(|r| r.lookback_sec() * 1000).max().unwrap_or(0));
        validate_coverage(&pinned.profile_coverage, &request.token_profile.missing, &request, profile_from)?;

        let mut requirements = Vec::with_capacity(request.rules.len());
        for rule in &request.rules {
            match module.supports(rule) {
                AlgorithmSupport::Supported { requirements: needed }
                    if needed.minimum_warmup_ms <= MAX_SAFE_INTEGER => requirements.push(needed),
                _ => return Err(FailureReason::AlgorithmIncompatible),
            }
        }
        let expected_hash = rules_hash(&request.rules)?;
        // Input parsing and compatibility checks also consume the time budget.
        let before_call = now_ms();
        check_deadline(before_call, started_at, deadline_ms)?;
        let result = module.analyze(&request, &limits);
        let after_call = now_ms();
        check_deadline(after_call, before_call, deadline_ms)?;
        let analysis = result.map_err(map_algorithm_error)?;
        check_encoded_size(&analysis, limits.max_output_bytes)?;
        validation::validate_output(
            &analysis, &request, &identity, mode, &expected_hash, &limits, &requirements,
        )?;

        let mut rules = Vec::with_capacity(request.rules.len());
        // Output order need not equal request order; return the pinned order.
        for (rule, requirement) in request.rules.iter().zip(&requirements) {
            let output = analysis.rules.iter().find(|r| r.rule_id == rule.id())
                .ok_or(FailureReason::InvalidAlgorithmOutput)?;
            let coverage = if matches!(rule, RuleSpec::EventCount { .. }) {
                &pinned.profile_coverage
            } else {
                &pinned.history_coverage
            };
            if output.outcome == RuleState::Clear && !coverage.unavailable.is_empty() {
                return Err(FailureReason::InvalidAlgorithmOutput);
            }
            let mut reasons = output.reason.as_ref().map(map_rule_reason).into_iter().collect::<Vec<_>>();
            if !coverage.unavailable.is_empty() && !reasons.contains(&FailureReason::FieldUnavailable) {
                reasons.push(FailureReason::FieldUnavailable);
            }
            let initial_state = if matches!(rule, RuleSpec::EventCount { .. })
                || !requirement.requires_initial_state
            {
                "not_required"
            } else if validation::initial_state_satisfied(&request, rule, output, requirement) {
                "satisfied"
            } else {
                "unsatisfied"
            };
            rules.push(RuleResult {
                rule_id: output.rule_id.clone(),
                state: output.outcome,
                coverage: coverage.clone(),
                initial_state: initial_state.into(),
                reasons,
                evidence: serde_json::to_value(output)
                    .map_err(|_| FailureReason::InvalidAlgorithmOutput)?,
            });
        }
        let validated = ValidatedAnalysis { binding: pinned.binding.clone(), analysis, rules };
        // Include retained provenance and mapped evidence in the result budget.
        check_encoded_size(&validated, limits.max_output_bytes)?;
        check_deadline(now_ms(), after_call, deadline_ms)?;
        Ok(validated)
    }
}

fn check_deadline(now: u64, previous: u64, deadline: u64) -> Result<(), FailureReason> {
    if now > MAX_SAFE_INTEGER || now < previous || now >= deadline {
        Err(FailureReason::Timeout)
    } else {
        Ok(())
    }
}

fn validate_limits(limits: &AlgorithmLimits) -> Result<(), FailureReason> {
    let values = [limits.max_input_bytes, limits.max_output_bytes, limits.max_points,
        limits.max_rules, limits.max_evidence_events_per_rule, limits.max_work_units];
    if values.iter().any(|&v| v == 0 || v > MAX_SAFE_INTEGER) {
        return Err(FailureReason::InvalidScamInput);
    }
    Ok(())
}

fn intersect_limits(a: &AlgorithmLimits, b: &AlgorithmLimits) -> AlgorithmLimits {
    AlgorithmLimits {
        max_input_bytes: a.max_input_bytes.min(b.max_input_bytes),
        max_output_bytes: a.max_output_bytes.min(b.max_output_bytes),
        max_points: a.max_points.min(b.max_points),
        max_rules: a.max_rules.min(b.max_rules),
        max_evidence_events_per_rule: a.max_evidence_events_per_rule.min(b.max_evidence_events_per_rule).min(64),
        max_work_units: a.max_work_units.min(b.max_work_units),
    }
}

fn map_algorithm_error(error: AlgorithmError) -> FailureReason {
    match error {
        AlgorithmError::InvalidInput => FailureReason::InvalidScamInput,
        AlgorithmError::UnsupportedRule => FailureReason::AlgorithmIncompatible,
        AlgorithmError::ResourceLimit => FailureReason::ResourceLimit,
        AlgorithmError::WorkBudgetExhausted => FailureReason::Timeout,
    }
}

fn map_rule_reason(reason: &AlgorithmRuleReason) -> FailureReason {
    match reason {
        AlgorithmRuleReason::PartialCoverage | AlgorithmRuleReason::NoUsableSegment => FailureReason::DataMissing,
        AlgorithmRuleReason::WarmupIncomplete => FailureReason::InitialStateUnknown,
        AlgorithmRuleReason::ResolutionTooCoarse => FailureReason::UnsupportedResolution,
        AlgorithmRuleReason::MetricUnavailable => FailureReason::FieldUnavailable,
    }
}

/// Hash only the validated, frozen RuleSpec representation. This is not a
/// signing primitive and must never reserialize an original signed payload.
pub fn rules_hash(rules: &[RuleSpec]) -> Result<String, FailureReason> {
    let bytes = serde_json_canonicalizer::to_vec(&json!({
        "domain": "dambi.scam.rules/1", "rules": rules,
    })).map_err(|_| FailureReason::InvalidScamInput)?;
    Ok(format!("0x{}", hex::encode(Sha256::digest(bytes))))
}

/// Count serialized bytes without allocating another unbounded JSON string.
fn check_encoded_size(value: &impl Serialize, limit: u64) -> Result<(), FailureReason> {
    struct Counter { written: u64, limit: u64 }
    impl Write for Counter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let next = self.written.checked_add(buf.len() as u64)
                .filter(|&next| next <= self.limit)
                .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "scam result exceeds byte limit"))?;
            self.written = next;
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    serde_json::to_writer(Counter { written: 0, limit }, value)
        .map_err(|_| FailureReason::ResourceLimit)
}

fn validate_coverage(
    coverage: &DataCoverage,
    missing: &[SnapshotInterval],
    request: &AnalysisRequest,
    from: u64,
) -> Result<(), FailureReason> {
    let to = request.as_of.t_ms;
    if coverage.from_ms > from || coverage.to_ms != to
        || coverage.from_ms > MAX_SAFE_INTEGER
        || coverage.from_block.is_empty()
        || (coverage.from_block.len() > 1 && coverage.from_block.starts_with('0'))
        || !coverage.from_block.bytes().all(|v| v.is_ascii_digit())
        || alloy_primitives::U256::from_str_radix(&coverage.from_block, 10).is_err()
    {
        return Err(FailureReason::InvalidScamInput);
    }
    let mut previous = coverage.from_ms;
    let mut selected = Vec::new();
    for gap in &coverage.missing {
        if gap.from_ms < previous || gap.from_ms >= gap.to_ms || gap.to_ms > to || gap.reason.is_empty() {
            return Err(FailureReason::InvalidScamInput);
        }
        previous = gap.to_ms;
        if gap.to_ms > from {
            selected.push(SnapshotInterval { from_ms: gap.from_ms.max(from), to_ms: gap.to_ms });
        }
    }
    let relevant = missing.iter().filter(|gap| gap.to_ms > from)
        .map(|gap| SnapshotInterval { from_ms: gap.from_ms.max(from), to_ms: gap.to_ms }).collect::<Vec<_>>();
    if selected != relevant || coverage.unavailable.iter().any(|v| v.field.is_empty() || v.reason.is_empty()) {
        return Err(FailureReason::InvalidScamInput);
    }
    Ok(())
}
