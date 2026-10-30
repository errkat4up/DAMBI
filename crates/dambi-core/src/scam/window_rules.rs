//! Translation between the SDK envelope and the independently supplied detector.
//! Event generation stays in scam-filter; this module pins identity and budgets.
use scam_filter::{AlgorithmPort, WindowRules};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::json;

use super::*;

#[derive(Default)]
pub(crate) struct WindowRulesModule;

fn translate<T: Serialize, U: DeserializeOwned>(value: &T) -> Result<U, AlgorithmError> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| AlgorithmError::InvalidInput)
}

fn rule_input(rule: &RuleSpec) -> Result<scam_filter::RuleSpec, AlgorithmError> {
    let metric = |m: Metric| match m {
        Metric::PriceQuotePerToken => "price",
        Metric::QuoteReserve => "liquidity",
    };
    let value = match rule {
        RuleSpec::ChangeCount {
            id,
            lookback_sec,
            metric: m,
            direction,
            change_mode,
            threshold_bps,
            count,
            ..
        } => json!({
            "kind":"change_count", "id":id, "lookbackSec":lookback_sec, "metric":metric(*m),
            "direction":match direction { Direction::Either => "both", Direction::Up => "up", Direction::Down => "down" },
            "mode":change_mode, "minChangeBps":threshold_bps, "minCount":count,
        }),
        RuleSpec::SwitchDensity {
            id,
            lookback_sec,
            metric: m,
            window_sec,
            reversal_bps,
            count,
            ..
        } => json!({
            "kind":"switch_density", "id":id, "lookbackSec":lookback_sec, "metric":metric(*m),
            "windowSec":window_sec, "reversalBps":reversal_bps, "switchKind":"both", "minCount":count,
        }),
        RuleSpec::WindowDrop {
            id,
            lookback_sec,
            metric: m,
            window_sec,
            drop_bps,
            ..
        } => {
            if *m != Metric::QuoteReserve {
                return Err(AlgorithmError::UnsupportedRule);
            }
            json!({"kind":"window_drop", "id":id, "lookbackSec":lookback_sec,
                "windowSec":window_sec, "minDropBps":drop_bps})
        }
        RuleSpec::EventCount {
            id,
            lookback_sec,
            event_kinds,
            count,
            ..
        } => json!({
            "kind":"event_count", "id":id, "lookbackSec":lookback_sec,
            "kinds":event_kinds, "minCount":count,
        }),
    };
    serde_json::from_value(value).map_err(|_| AlgorithmError::UnsupportedRule)
}

pub(crate) fn minimum_warmup_sec(rule: &RuleSpec) -> u64 {
    match rule {
        RuleSpec::ChangeCount {
            change_mode: ChangeMode::Cumulative,
            ..
        }
        | RuleSpec::SwitchDensity { .. } => scam_filter::rules::WARMUP_SEC,
        RuleSpec::WindowDrop { window_sec, .. } => *window_sec,
        _ => 0,
    }
}

impl AlgorithmModule for WindowRulesModule {
    fn identity(&self) -> AlgorithmIdentity {
        AlgorithmIdentity {
            id: WindowRules.id().into(),
            version: WindowRules.version().into(),
            contract_version: WindowRules.contract_version(),
        }
    }

    fn supported_limits(&self) -> AlgorithmLimits {
        let limits = scam_filter::Limits::default();
        AlgorithmLimits {
            max_input_bytes: 16_000_000,
            max_output_bytes: 16_000_000,
            max_points: limits.max_points as u64,
            max_rules: limits.max_rules as u64,
            max_evidence_events_per_rule: limits.max_evidence_events as u64,
            max_work_units: 100_000_000,
        }
    }

    fn work_unit(&self) -> &str {
        "window-rules-bounded-visits/1"
    }
    fn analysis_mode(&self) -> AnalysisMode {
        AnalysisMode::Real
    }

    fn supports(&self, rule: &RuleSpec) -> AlgorithmSupport {
        match rule_input(rule).map(|rule| WindowRules.supports(&rule)) {
            Ok(scam_filter::Support::Supported) => AlgorithmSupport::Supported {
                requirements: AlgorithmRuleRequirements {
                    minimum_warmup_ms: minimum_warmup_sec(rule) * 1000,
                    // Even step requires the host's faithful-history assertion.
                    requires_initial_state: !matches!(rule, RuleSpec::EventCount { .. }),
                },
            },
            _ => AlgorithmSupport::Unsupported {
                reason: "unsupported window-rule parameters".into(),
            },
        }
    }

    fn analyze(
        &self,
        request: &AnalysisRequest,
        limits: &AlgorithmLimits,
    ) -> Result<ScamAnalysis, AlgorithmError> {
        let defaults = scam_filter::Limits::default();
        if request.rules.len() as u64 > limits.max_rules
            || request.pool_history.points.len() as u64 > limits.max_points
            || request.token_profile.admin_events.len() > defaults.max_admin_events
        {
            return Err(AlgorithmError::ResourceLimit);
        }
        // The supplied detector has a quadratic R2 search. Bound it before
        // entering synchronous WASM; a host timer cannot interrupt that call.
        let n = request.pool_history.points.len() as u64;
        let m = request.pool_history.missing.len() as u64;
        let a = request.token_profile.admin_events.len() as u64;
        let p = request.token_profile.missing.len() as u64;
        let mut work = 0_u64;
        for rule in &request.rules {
            let base = if matches!(rule, RuleSpec::EventCount { .. }) {
                a.saturating_add(p)
                    .saturating_add(1)
                    .saturating_mul(16)
                    .saturating_add(p.saturating_mul(p))
            } else {
                n.saturating_add(m)
                    .saturating_add(1)
                    .saturating_mul(16)
                    .saturating_add(n.saturating_mul(m).saturating_mul(2))
                    .saturating_add(m.saturating_mul(m).saturating_mul(2))
            };
            work = work.saturating_add(base);
            if matches!(rule, RuleSpec::SwitchDensity { .. }) {
                work = work.saturating_add(n.saturating_mul(n).saturating_mul(8));
            }
            if work > limits.max_work_units {
                return Err(AlgorithmError::ResourceLimit);
            }
        }
        let input = scam_filter::AnalysisRequest {
            subject: translate(&request.subject)?,
            as_of: translate(&request.as_of)?,
            rules: request
                .rules
                .iter()
                .map(rule_input)
                .collect::<Result<_, _>>()?,
            rules_hash: rules_hash(&request.rules).map_err(|_| AlgorithmError::InvalidInput)?,
            pool_history: translate(&request.pool_history)?,
            token_profile: translate(&request.token_profile)?,
        };
        let bounded = scam_filter::Limits {
            max_rules: defaults
                .max_rules
                .min(usize::try_from(limits.max_rules).unwrap_or(usize::MAX)),
            max_points: defaults
                .max_points
                .min(usize::try_from(limits.max_points).unwrap_or(usize::MAX)),
            max_admin_events: defaults.max_admin_events,
            max_evidence_events: defaults
                .max_evidence_events
                .min(usize::try_from(limits.max_evidence_events_per_rule).unwrap_or(usize::MAX)),
        };
        let result = WindowRules
            .analyze(&input, &bounded)
            .map_err(|error| match error {
                scam_filter::AlgorithmError::LimitExceeded(_) => AlgorithmError::ResourceLimit,
                scam_filter::AlgorithmError::Unsupported { .. } => AlgorithmError::UnsupportedRule,
                scam_filter::AlgorithmError::InvalidInput(_) => AlgorithmError::InvalidInput,
            })?;
        translate(&result)
    }
}
