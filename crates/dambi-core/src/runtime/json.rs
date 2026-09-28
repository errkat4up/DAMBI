//! JSON input validation and verdict DTO conversion for action evaluation.
//!
//! The WASM wrapper supplies envelope serialization. Entry-point labels and
//! error messages retain the existing WASM wire contract.

use policy_engine::policy::{MatchedPolicy, Severity, Verdict};
use serde_json::Value;

use super::dto::{
    EvaluateActionInput, EvaluateActionOutput, MatchedPolicyDto, PlanActionInput, PlanActionOutput,
    VerdictDto,
};
use crate::json::{check_input_size, EngineErrorDto};

/// Parse and plan an action request using the existing v2 JSON input shape.
pub fn plan_action_rpc_v2(input_json: &str) -> Result<PlanActionOutput, EngineErrorDto> {
    check_input_size(input_json, "plan_action_rpc_v2_json")?;
    let input: PlanActionInput =
        serde_json::from_str(input_json).map_err(|error| invalid_input(&error.to_string()))?;
    super::plan_action(&input)
}

/// Parse and evaluate an action request, converting global errors to a Fail DTO.
///
/// The wrapper always places this payload in an `ok` envelope, including input
/// errors. Bundle-local quarantine and required Fact failures are handled by
/// [`evaluate_action`](crate::runtime::evaluate_action).
#[must_use]
pub fn evaluate_action_v2(input_json: &str) -> EvaluateActionOutput {
    let verdict = (|| -> Result<Verdict, EngineErrorDto> {
        check_input_size(input_json, "evaluate_action_v2_json")?;
        let input: EvaluateActionInput =
            serde_json::from_str(input_json).map_err(|error| invalid_input(&error.to_string()))?;
        super::evaluate_action(&input)
    })();

    let dto = match verdict {
        Ok(verdict) => verdict_to_dto(&verdict),
        Err(error) => engine_error_verdict(error),
    };
    EvaluateActionOutput { verdict: dto }
}

/// Parse the evaluate input shape and return its diagnostic lowered context.
///
/// The runtime preserves best-effort materialization independently of verdict
/// evaluation; this boundary reports input and lowering errors unchanged.
pub fn debug_lowered_context_v2(input_json: &str) -> Result<Value, EngineErrorDto> {
    check_input_size(input_json, "debug_lowered_context_v2_json")?;
    let input: EvaluateActionInput =
        serde_json::from_str(input_json).map_err(|error| invalid_input(&error.to_string()))?;
    super::debug_lowered_context(&input)
}

fn invalid_input(message: &str) -> EngineErrorDto {
    EngineErrorDto::new(
        "invalid_input_json",
        format!("invalid input json: {message}"),
    )
}

fn verdict_to_dto(verdict: &Verdict) -> VerdictDto {
    match verdict {
        Verdict::Pass => VerdictDto::Pass,
        Verdict::Warn(matched) => VerdictDto::Warn {
            matched: matched.iter().map(matched_to_dto).collect(),
        },
        Verdict::Fail(matched) => VerdictDto::Fail {
            matched: matched.iter().map(matched_to_dto).collect(),
        },
    }
}

fn matched_to_dto(matched: &MatchedPolicy) -> MatchedPolicyDto {
    MatchedPolicyDto {
        policy_id: matched.policy_id.clone(),
        reason: matched.reason.clone(),
        severity: match matched.severity {
            Severity::Deny => "deny".to_owned(),
            Severity::Warn => "warn".to_owned(),
        },
        origin: match matched.origin {
            policy_engine::PolicyRequestOrigin::Action => "action".to_owned(),
            policy_engine::PolicyRequestOrigin::Tx => "tx".to_owned(),
        },
    }
}

/// Convert a global engine error to the existing fail-closed verdict shape.
fn engine_error_verdict(error: EngineErrorDto) -> VerdictDto {
    let policy_id = format!("__engine::{}", error.kind);
    let reason = if error.message.is_empty() {
        policy_id.clone()
    } else {
        error.message
    };
    VerdictDto::Fail {
        matched: vec![MatchedPolicyDto {
            policy_id,
            reason: Some(reason),
            severity: "deny".to_owned(),
            // The synthetic Fail retains the boundary-specific origin.
            origin: "engine_error".to_owned(),
        }],
    }
}
