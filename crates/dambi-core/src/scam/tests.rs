//! Boundary tests only: the explicit test module returns fixed answers and never
//! implements event generation, percentage arithmetic, or window detection.

use super::*;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

const POOL: &str = "0x0000000000000000000000000000000000000001";
const TOKEN: &str = "0x0000000000000000000000000000000000000002";
const QUOTE: &str = "0x0000000000000000000000000000000000000003";
const FACTORY: &str = "0x0000000000000000000000000000000000000004";
const BLOCK_HASH: &str =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_HASH: &str =
    "0x2222222222222222222222222222222222222222222222222222222222222222";

fn limits() -> AlgorithmLimits {
    AlgorithmLimits {
        max_input_bytes: 65_536,
        max_output_bytes: 65_536,
        max_points: 128,
        max_rules: 16,
        max_evidence_events_per_rule: 64,
        max_work_units: 10_000,
    }
}

fn request() -> AnalysisRequest {
    serde_json::from_value(json!({
        "subject": {
            "chainId": 91342, "pool": POOL, "token": TOKEN,
            "quote": QUOTE, "venue": "uniswap_v2"
        },
        "asOf": {"block": "100", "blockHash": BLOCK_HASH, "tMs": 12000},
        "rules": [{
            "id": "r1", "enabled": true, "kind": "change_count",
            "lookbackSec": 10, "metric": "price_quote_per_token",
            "direction": "either", "changeMode": "step",
            "thresholdBps": 500, "count": 2
        }],
        "poolHistory": {
            "schema": "scam.pool_history/1", "builderVersion": "fixture/1",
            "fromMs": 1000, "bucketMs": 1000,
            "points": (1_u64..=12).map(|i| json!({
                "tMs": i * 1000, "reserveQuote": "1000", "reserveToken": "1000",
                "decimalsQuote": 18, "decimalsToken": 18
            })).collect::<Vec<_>>(),
            "missing": [], "warmup": {"fromMs": 1000, "complete": true}
        },
        "tokenProfile": {
            "schema": "scam.token_profile/1", "poolCreatedMs": 0,
            "adminEvents": [], "missing": []
        }
    }))
    .expect("the test request matches the SF1 wire DTO")
}

fn pinned(request: &AnalysisRequest) -> PinnedInvocation {
    let binding = serde_json::from_value(json!({
        "planId": "test-plan", "subject": {
            "chainId": 91342, "pool": POOL, "token": TOKEN,
            "quoteToken": QUOTE, "factory": FACTORY, "venue": "uniswap_v2",
            "actionPaths": ["actions[0]"]
        },
        "reference": {
            "block": {"number": "100", "hash": BLOCK_HASH, "timestampMs": 12000},
            "requiredConfirmDepth": 2,
            "checkedHead": {"number": "102", "hash": OTHER_HASH, "timestampMs": 14000},
            "observedConfirmDepth": 2
        },
        "settingsHash": OTHER_HASH, "settingsHashScheme": "sha256-jcs-scam-v1",
        "bundleSequence": "7", "selectedPreset": "established",
        "selectionReason": "exact_mature", "effectiveSettingsHash": OTHER_HASH,
        "algorithm": {"id": "test-fixed", "version": "1.0.0", "contractVersion": 1},
        "builderVersion": "fixture/1", "fromMs": 1000, "toMs": 12000,
        "bucketMs": 1000, "gridOriginMs": 0, "warmupSec": 1
    }))
    .expect("the pinned fixture matches the SDK binding DTO");
    let coverage = DataCoverage {
        from_block: "1".into(),
        from_ms: 1000,
        to_ms: 12000,
        missing: vec![],
        unavailable: vec![],
    };
    PinnedInvocation {
        binding,
        rules: request.rules.clone(),
        history_coverage: coverage.clone(),
        profile_coverage: coverage,
    }
}

fn answer(request: &AnalysisRequest, state: RuleState) -> ScamAnalysis {
    ScamAnalysis {
        algorithm_id: "test-fixed".into(),
        algorithm_version: "1.0.0".into(),
        contract_version: 1,
        analysis_mode: AnalysisMode::Stub,
        binding: AlgorithmBinding {
            chain_id: request.subject.chain_id,
            pool: request.subject.pool.clone(),
            as_of_block: request.as_of.block.clone(),
            as_of_block_hash: request.as_of.block_hash.clone(),
            rules_hash: rules_hash(&request.rules).expect("fixed rules are hashable"),
        },
        rules: vec![AlgorithmRuleResult {
            rule_id: request.rules[0].id().into(),
            outcome: state,
            reason: match state {
                RuleState::Incomplete => Some(AlgorithmRuleReason::PartialCoverage),
                RuleState::NotEvaluable => Some(AlgorithmRuleReason::NoUsableSegment),
                _ => None,
            },
            observed: Some(if state == RuleState::Fired { 2.0 } else { 0.0 }),
            threshold: 2.0,
            window: (state == RuleState::Fired).then_some(EvidenceWindow {
                start_ms: 2000,
                end_ms: 12000,
            }),
            events: (state == RuleState::Fired).then_some(vec![
                EvidenceEvent { t_ms: 5000, kind: "up".into() },
                EvidenceEvent { t_ms: 6000, kind: "down".into() },
            ]),
            coverage_bps: if state == RuleState::Incomplete { 9000 } else { 10000 },
            warmup_complete: true,
        }],
    }
}

/// This type only exists under the parent's cfg(test) module. Its output is
/// supplied by the test, never calculated from market observations.
struct FixedModule {
    calls: Cell<usize>,
    last_limits: RefCell<Option<AlgorithmLimits>>,
    identity: AlgorithmIdentity,
    mode: AnalysisMode,
    supported: bool,
    work_unit: &'static str,
    output: ScamAnalysis,
    error: Option<AlgorithmError>,
}

impl FixedModule {
    fn new(request: &AnalysisRequest, state: RuleState) -> Self {
        Self {
            calls: Cell::new(0),
            last_limits: RefCell::new(None),
            identity: AlgorithmIdentity {
                id: "test-fixed".into(), version: "1.0.0".into(), contract_version: 1,
            },
            mode: AnalysisMode::Stub,
            supported: true,
            work_unit: "fixture-return/1",
            output: answer(request, state),
            error: None,
        }
    }
}

impl AlgorithmModule for FixedModule {
    fn identity(&self) -> AlgorithmIdentity { self.identity.clone() }
    fn supported_limits(&self) -> AlgorithmLimits { limits() }
    fn work_unit(&self) -> &str { self.work_unit }
    fn analysis_mode(&self) -> AnalysisMode { self.mode }
    fn supports(&self, _rule: &RuleSpec) -> AlgorithmSupport {
        if self.supported {
            AlgorithmSupport::Supported {
                requirements: AlgorithmRuleRequirements {
                    minimum_warmup_ms: 1000,
                    requires_initial_state: true,
                },
            }
        } else {
            AlgorithmSupport::Unsupported { reason: "fixture unsupported mode".into() }
        }
    }
    fn analyze(
        &self,
        _request: &AnalysisRequest,
        limits: &AlgorithmLimits,
    ) -> Result<ScamAnalysis, AlgorithmError> {
        self.calls.set(self.calls.get() + 1);
        self.last_limits.replace(Some(limits.clone()));
        self.error.map_or_else(|| Ok(self.output.clone()), Err)
    }
}

fn evaluate(
    module: &FixedModule,
    context: &PinnedInvocation,
    request: &AnalysisRequest,
) -> Result<ValidatedAnalysis, FailureReason> {
    let encoded = serde_json::to_string(request).expect("serialize fixed request");
    AlgorithmAdapter::with_test_stub(module).evaluate(
        context, Some(&encoded), &limits(), 1000, || 0,
    )
}

#[test]
fn module_and_input_absence_never_create_a_stub_answer() {
    let request = request();
    let context = pinned(&request);
    assert_eq!(
        AlgorithmAdapter::new(None)
            .evaluate(&context, None, &limits(), 1000, || 0).err(),
        Some(FailureReason::AlgorithmUnavailable),
    );
    let module = FixedModule::new(&request, RuleState::Clear);
    assert_eq!(
        AlgorithmAdapter::with_test_stub(&module)
            .evaluate(&context, None, &limits(), 1000, || 0).err(),
        Some(FailureReason::ScamResultsMissing),
    );
    assert_eq!(module.calls.get(), 0);
}

#[test]
fn stub_requires_explicit_test_opt_in_and_an_identical_output_mode() {
    let request = request();
    let context = pinned(&request);
    let mut module = FixedModule::new(&request, RuleState::Clear);
    let encoded = serde_json::to_string(&request).unwrap();
    assert_eq!(
        AlgorithmAdapter::new(Some(&module))
            .evaluate(&context, Some(&encoded), &limits(), 1000, || 0).err(),
        Some(FailureReason::AlgorithmIncompatible),
    );
    assert_eq!(module.calls.get(), 0);
    assert!(evaluate(&module, &context, &request).is_ok());
    module.output.analysis_mode = AnalysisMode::Real;
    assert_eq!(evaluate(&module, &context, &request).err(),
        Some(FailureReason::InvalidAlgorithmOutput));
    module.mode = AnalysisMode::Real;
    assert!(AlgorithmAdapter::new(Some(&module))
        .evaluate(&context, Some(&encoded), &limits(), 1000, || 0).is_ok());
}

#[test]
fn module_compatibility_is_checked_before_invocation() {
    let request = request();
    let context = pinned(&request);
    let cases: [(&str, fn(&mut FixedModule)); 4] = [
        ("wire version", |m| m.identity.contract_version = 2),
        ("pinned implementation version", |m| m.identity.version = "2.0.0".into()),
        ("unsupported rule", |m| m.supported = false),
        ("undeclared work counter", |m| m.work_unit = ""),
    ];
    for (label, change) in cases {
        let mut module = FixedModule::new(&request, RuleState::Clear);
        change(&mut module);
        assert_eq!(evaluate(&module, &context, &request).err(),
            Some(FailureReason::AlgorithmIncompatible), "{label}");
        assert_eq!(module.calls.get(), 0, "{label}");
    }
}

#[test]
fn malformed_or_unbound_input_is_rejected_before_invocation() {
    let request = request();
    let context = pinned(&request);
    let valid = serde_json::to_value(&request).unwrap();
    let cases: [(&str, fn(&mut Value)); 7] = [
        ("numeric reserve", |v| v["poolHistory"]["points"][0]["reserveQuote"] = json!(1000)),
        ("noncanonical integer", |v| v["poolHistory"]["points"][0]["reserveQuote"] = json!("01")),
        ("different pool", |v| v["subject"]["pool"] = json!(FACTORY)),
        ("different reference", |v| v["asOf"]["blockHash"] = json!(OTHER_HASH)),
        ("future point", |v| v["poolHistory"]["points"][11]["tMs"] = json!(13000)),
        ("off-grid point", |v| v["poolHistory"]["points"][5]["tMs"] = json!(6500)),
        ("extra policy payload", |v| v["policyFacts"] = json!({"deny": false})),
    ];
    let mut malformed = vec![
        ("syntax", "{".to_string()),
        ("duplicate JSON key", serde_json::to_string(&valid).unwrap()
            .replacen("\"chainId\":91342", "\"chainId\":91342,\"chainId\":91342", 1)),
    ];
    for (label, change) in cases {
        let mut value = valid.clone();
        change(&mut value);
        malformed.push((label, serde_json::to_string(&value).unwrap()));
    }
    for (label, encoded) in malformed {
        let module = FixedModule::new(&request, RuleState::Clear);
        assert!(AlgorithmAdapter::with_test_stub(&module)
            .evaluate(&context, Some(&encoded), &limits(), 1000, || 0).is_err(), "{label}");
        assert_eq!(module.calls.get(), 0, "{label}");
    }
}

#[test]
fn resource_limits_are_checked_before_invocation() {
    let request = request();
    let context = pinned(&request);
    let encoded = serde_json::to_string(&request).unwrap();
    for (label, limited) in [
        ("input bytes", AlgorithmLimits { max_input_bytes: 1, ..limits() }),
        ("point count", AlgorithmLimits { max_points: 1, ..limits() }),
    ] {
        let module = FixedModule::new(&request, RuleState::Clear);
        assert_eq!(AlgorithmAdapter::with_test_stub(&module)
            .evaluate(&context, Some(&encoded), &limited, 1000, || 0).err(),
            Some(FailureReason::ResourceLimit), "{label}");
        assert_eq!(module.calls.get(), 0, "{label}");
    }
    let module = FixedModule::new(&request, RuleState::Clear);
    let requested = AlgorithmLimits { max_work_units: 20_000, ..limits() };
    assert!(AlgorithmAdapter::with_test_stub(&module)
        .evaluate(&context, Some(&encoded), &requested, 1000, || 0).is_ok());
    assert_eq!(module.last_limits.borrow().as_ref().unwrap().max_work_units, 10_000);
}

#[test]
fn fixed_rule_states_preserve_binding_evidence_and_provider_provenance() {
    let request = request();
    let context = pinned(&request);
    for state in [RuleState::Clear, RuleState::Fired, RuleState::Incomplete, RuleState::NotEvaluable] {
        let module = FixedModule::new(&request, state);
        let result = evaluate(&module, &context, &request).expect("valid fixed answer");
        assert_eq!(result.binding, context.binding);
        assert_eq!(result.analysis.analysis_mode, AnalysisMode::Stub);
        assert_eq!(result.rules.len(), 1);
        assert_eq!(result.rules[0].state, state);
        assert_eq!(result.rules[0].coverage, context.history_coverage);
        assert_eq!(result.rules[0].evidence["threshold"].as_f64(), Some(2.0));
        if matches!(state, RuleState::Incomplete | RuleState::NotEvaluable) {
            assert!(result.rules[0].reasons.contains(&FailureReason::DataMissing));
        }
        assert_eq!(module.calls.get(), 1);
    }
}

#[test]
fn inconsistent_or_nonfinite_output_is_never_accepted() {
    let request = request();
    let context = pinned(&request);
    let cases: [(&str, fn(&mut ScamAnalysis)); 12] = [
        ("missing rule", |a| a.rules.clear()),
        ("duplicate rule", |a| a.rules.push(a.rules[0].clone())),
        ("unknown rule", |a| a.rules[0].rule_id = "not-requested".into()),
        ("different block", |a| a.binding.as_of_block_hash = OTHER_HASH.into()),
        ("different rules hash", |a| a.binding.rules_hash = OTHER_HASH.into()),
        ("different algorithm", |a| a.algorithm_id = "other".into()),
        ("future evidence", |a| a.rules[0].events.as_mut().unwrap()[0].t_ms = 13000),
        ("left-excluded evidence", |a| a.rules[0].events.as_mut().unwrap()[0].t_ms = 2000),
        ("not a finite count", |a| a.rules[0].observed = Some(f64::NAN)),
        ("not a finite threshold", |a| a.rules[0].threshold = f64::INFINITY),
        ("fractional count", |a| a.rules[0].observed = Some(2.5)),
        ("false clear with threshold met", |a| a.rules[0].outcome = RuleState::Clear),
    ];
    for (label, change) in cases {
        let mut module = FixedModule::new(&request, RuleState::Fired);
        change(&mut module.output);
        assert_eq!(evaluate(&module, &context, &request).err(),
            Some(FailureReason::InvalidAlgorithmOutput), "{label}");
    }
}

#[test]
fn input_gap_or_unknown_initial_state_cannot_be_cleared_by_output_claims() {
    let clean = request();
    let mut request = clean.clone();
    let mut context = pinned(&request);
    request.pool_history.points.retain(|p| p.t_ms != 10000);
    request.pool_history.missing.push(SnapshotInterval { from_ms: 9000, to_ms: 10000 });
    context.history_coverage.missing.push(MissingInterval {
        from_ms: 9000, to_ms: 10000, reason: "rpc_error".into(),
    });
    let module = FixedModule::new(&request, RuleState::Clear);
    assert_eq!(evaluate(&module, &context, &request).err(),
        Some(FailureReason::InvalidAlgorithmOutput));
    let mut module = FixedModule::new(&request, RuleState::Fired);
    module.output.rules[0].coverage_bps = 9000;
    assert_eq!(evaluate(&module, &context, &request).unwrap().rules[0].state, RuleState::Fired);

    let mut request = clean;
    let context = pinned(&request);
    request.pool_history.warmup.complete = false;
    let module = FixedModule::new(&request, RuleState::Clear);
    assert_eq!(evaluate(&module, &context, &request).err(),
        Some(FailureReason::InvalidAlgorithmOutput));
    let module = FixedModule::new(&request, RuleState::Fired);
    let result = evaluate(&module, &context, &request).expect("confirmed events survive incomplete warm-up");
    assert_eq!(result.rules[0].state, RuleState::Fired);
    assert_eq!(result.rules[0].initial_state, "unsatisfied");
}

#[test]
fn admin_event_results_use_profile_coverage_not_market_warmup() {
    let mut clean = request();
    clean.rules = vec![RuleSpec::EventCount {
        id: "admin".into(), enabled: true, lookback_sec: 10,
        event_kinds: vec![AdminEventKind::OwnerChanged], count: 2,
    }];
    let mut missing_history = clean.clone();
    missing_history.pool_history.points.clear();
    missing_history.pool_history.missing = vec![SnapshotInterval {
        from_ms: 1000, to_ms: 12000,
    }];
    missing_history.pool_history.warmup.complete = false;
    let mut context = pinned(&missing_history);
    context.history_coverage.missing = vec![MissingInterval {
        from_ms: 1000, to_ms: 12000, reason: "rpc_error".into(),
    }];
    context.profile_coverage.from_block = "2".into();
    context.profile_coverage.from_ms = 2000;
    let mut module = FixedModule::new(&missing_history, RuleState::Clear);
    module.output.rules[0].warmup_complete = false;
    // FixedModule declares requires_initial_state=true; non-grid event rules
    // must still be independent of market snapshots and market warm-up.
    let result = evaluate(&module, &context, &missing_history)
        .expect("complete empty administrator-event history is evaluable");
    assert_eq!(result.rules[0].state, RuleState::Clear);
    assert_eq!(result.rules[0].initial_state, "not_required");
    assert_eq!(result.rules[0].coverage, context.profile_coverage);

    let mut missing_profile = clean;
    missing_profile.token_profile.missing = vec![SnapshotInterval {
        from_ms: 9000, to_ms: 10000,
    }];
    let mut context = pinned(&missing_profile);
    context.profile_coverage.missing = vec![MissingInterval {
        from_ms: 9000, to_ms: 10000, reason: "rpc_error".into(),
    }];
    let module = FixedModule::new(&missing_profile, RuleState::Clear);
    assert_eq!(evaluate(&module, &context, &missing_profile).err(),
        Some(FailureReason::InvalidAlgorithmOutput));
}

#[test]
fn resolution_contract_rejects_exact_count_span_without_detecting_events() {
    let base = request();
    let r1 = base.rules[0].clone();
    let r2 = |window_sec| RuleSpec::SwitchDensity {
        id: "r2".into(), enabled: true, lookback_sec: 100,
        metric: Metric::PriceQuotePerToken, window_sec, reversal_bps: 500,
        switch_kind: SwitchKind::DirectionReversal, count: 3,
    };
    let drop = |window_sec| RuleSpec::WindowDrop {
        id: "drop".into(), enabled: true, lookback_sec: 100,
        metric: Metric::QuoteReserve, window_sec, drop_bps: 4000,
    };
    let admin = RuleSpec::EventCount {
        id: "admin".into(), enabled: true, lookback_sec: 1,
        event_kinds: vec![AdminEventKind::OwnerChanged], count: 100,
    };
    // These are input/result consistency checks, not algorithm acceptance tests.
    assert!(validation::resolution_too_coarse(&r1, 10_000));
    assert!(!validation::resolution_too_coarse(&r1, 9_999));
    assert!(validation::resolution_too_coarse(&r2(20), 10_000));
    assert!(!validation::resolution_too_coarse(&r2(21), 10_000));
    assert!(validation::resolution_too_coarse(&drop(9), 10_000));
    assert!(!validation::resolution_too_coarse(&drop(10), 10_000));
    assert!(!validation::resolution_too_coarse(&admin, 10_000));

    let mut request = base;
    request.rules = vec![RuleSpec::SwitchDensity {
        id: "r2".into(), enabled: true, lookback_sec: 10,
        metric: Metric::PriceQuotePerToken, window_sec: 3, reversal_bps: 500,
        switch_kind: SwitchKind::DirectionReversal, count: 3,
    }];
    let context = pinned(&request);
    let mut module = FixedModule::new(&request, RuleState::Fired);
    module.output.rules[0].observed = Some(3.0);
    module.output.rules[0].threshold = 3.0;
    module.output.rules[0].window = Some(EvidenceWindow { start_ms: 3000, end_ms: 6000 });
    module.output.rules[0].events = Some(vec![
        EvidenceEvent { t_ms: 4000, kind: "peak".into() },
        EvidenceEvent { t_ms: 5000, kind: "trough".into() },
        EvidenceEvent { t_ms: 6000, kind: "peak".into() },
    ]);
    assert!(evaluate(&module, &context, &request).is_ok());
    module.output.rules[0].events.as_mut().unwrap()[0].t_ms = 3000;
    assert_eq!(evaluate(&module, &context, &request).err(),
        Some(FailureReason::InvalidAlgorithmOutput));

    if let RuleSpec::SwitchDensity { window_sec, .. } = &mut request.rules[0] {
        *window_sec = 2;
    }
    let context = pinned(&request);
    let mut module = FixedModule::new(&request, RuleState::NotEvaluable);
    module.output.rules[0].threshold = 3.0;
    module.output.rules[0].reason = Some(AlgorithmRuleReason::ResolutionTooCoarse);
    let result = evaluate(&module, &context, &request).expect("explicit coarse-resolution answer");
    assert_eq!(result.rules[0].state, RuleState::NotEvaluable);
    assert!(result.rules[0].reasons.contains(&FailureReason::UnsupportedResolution));
}

#[test]
fn quote_zero_is_valid_but_zero_price_denominator_cannot_support_clear() {
    let mut request = request();
    let context = pinned(&request);
    request.pool_history.points[5].reserve_quote = "0".into();
    let module = FixedModule::new(&request, RuleState::Fired);
    assert!(evaluate(&module, &context, &request).is_ok());

    request.pool_history.points[5].reserve_token = "0".into();
    let module = FixedModule::new(&request, RuleState::Clear);
    assert_eq!(evaluate(&module, &context, &request).err(),
        Some(FailureReason::InvalidAlgorithmOutput));
    let mut module = FixedModule::new(&request, RuleState::Incomplete);
    module.output.rules[0].reason = Some(AlgorithmRuleReason::MetricUnavailable);
    let result = evaluate(&module, &context, &request).expect("explicit incomplete result");
    assert!(result.rules[0].reasons.contains(&FailureReason::FieldUnavailable));
}

#[test]
fn cooperative_errors_and_expired_deadlines_are_explicit_failures() {
    let request = request();
    let context = pinned(&request);
    for (error, expected) in [
        (AlgorithmError::InvalidInput, FailureReason::InvalidScamInput),
        (AlgorithmError::UnsupportedRule, FailureReason::AlgorithmIncompatible),
        (AlgorithmError::ResourceLimit, FailureReason::ResourceLimit),
        (AlgorithmError::WorkBudgetExhausted, FailureReason::Timeout),
    ] {
        let mut module = FixedModule::new(&request, RuleState::Clear);
        module.error = Some(error);
        assert_eq!(evaluate(&module, &context, &request).err(), Some(expected));
        assert_eq!(module.calls.get(), 1);
    }
    let encoded = serde_json::to_string(&request).unwrap();
    let module = FixedModule::new(&request, RuleState::Clear);
    assert_eq!(AlgorithmAdapter::with_test_stub(&module)
        .evaluate(&context, Some(&encoded), &limits(), 1000, || 1000).err(),
        Some(FailureReason::NoTimeBudget));
    assert_eq!(module.calls.get(), 0);
    assert_eq!(AlgorithmAdapter::with_test_stub(&module)
        .evaluate(&context, Some(&encoded), &limits(), 1000, || {
            if module.calls.get() == 0 { 0 } else { 1000 }
        }).err(), Some(FailureReason::Timeout));
    assert_eq!(module.calls.get(), 1);
}

#[test]
fn result_size_and_evidence_limits_do_not_truncate_silently() {
    let request = request();
    let context = pinned(&request);
    let encoded = serde_json::to_string(&request).unwrap();
    let module = FixedModule::new(&request, RuleState::Fired);
    for limited in [
        AlgorithmLimits { max_output_bytes: 1, ..limits() },
        AlgorithmLimits { max_evidence_events_per_rule: 1, ..limits() },
    ] {
        assert!(AlgorithmAdapter::with_test_stub(&module)
            .evaluate(&context, Some(&encoded), &limited, 1000, || 0).is_err());
    }
}

#[test]
fn rules_hash_preserves_rule_order_and_ignores_json_object_key_order() {
    let request = request();
    let expected = rules_hash(&request.rules).unwrap();
    let reordered: RuleSpec = serde_json::from_str(r#"{
        "count":2,"thresholdBps":500,"changeMode":"step","direction":"either",
        "metric":"price_quote_per_token","lookbackSec":10,"kind":"change_count",
        "enabled":true,"id":"r1"
    }"#).unwrap();
    assert_eq!(expected, rules_hash(&[reordered.clone()]).unwrap());
    let mut second = serde_json::to_value(&reordered).unwrap();
    second["id"] = json!("r2");
    let second: RuleSpec = serde_json::from_value(second).unwrap();
    assert_ne!(
        rules_hash(&[reordered.clone(), second.clone()]).unwrap(),
        rules_hash(&[second, reordered]).unwrap(),
    );
}
