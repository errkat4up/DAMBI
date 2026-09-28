use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value};

use super::{config::Limits, parse_json, PendingPlan, Report, MAX_SAFE_INTEGER};

/// Validate provenance before passing the original semantic response to runtime.
/// Projection deliberately does not occur here: runtime materializes each
/// matching policy's own schema exactly once.
pub(super) fn validate(
    input: &str,
    plan_id: &str,
    plan: &PendingPlan,
    limits: &Limits,
    now_ms: u64,
    report: &mut Report,
) -> BTreeMap<String, Value> {
    if input.len() as u64 > limits.max_fact_bytes {
        report.fail(
            "limit_exceeded",
            "FactBatch exceeds maxFactBytes",
            None,
            None,
        );
        return BTreeMap::new();
    }
    let value = match parse_json(input, "INVALID_REQUEST") {
        Ok(value) => value,
        Err(error) => {
            report.fail("invalid_fact", error.message, None, None);
            return BTreeMap::new();
        }
    };
    let Some(batch) = value.as_object() else {
        report.fail("invalid_fact", "FactBatch must be an object", None, None);
        return BTreeMap::new();
    };
    if batch
        .keys()
        .any(|key| !matches!(key.as_str(), "planId" | "results"))
    {
        report.fail("invalid_fact", "unknown FactBatch field", None, None);
    }
    if batch.get("planId").and_then(Value::as_str) != Some(plan_id) {
        report.fail(
            "fact_plan_mismatch",
            "FactBatch belongs to a different plan",
            None,
            None,
        );
        return BTreeMap::new();
    }
    let Some(results) = batch.get("results").and_then(Value::as_object) else {
        report.fail(
            "invalid_fact",
            "FactBatch.results must be an object",
            None,
            None,
        );
        return BTreeMap::new();
    };
    let known: HashSet<&str> = plan
        .nodes
        .iter()
        .flat_map(|node| node.calls.iter().map(|call| call.id.as_str()))
        .collect();
    for key in results.keys().filter(|key| !known.contains(key.as_str())) {
        report.fail(
            "unknown_fact_call",
            "Fact result has no call in this plan",
            Some(key),
            None,
        );
    }
    let mut accepted = BTreeMap::new();
    for node in &plan.nodes {
        for call in &node.calls {
            let Some(value) = results.get(&call.id) else {
                continue;
            };
            match validate_result(value, limits, now_ms) {
                Ok(raw) => {
                    accepted.insert(call.id.clone(), raw.clone());
                    report.facts.push(value.clone());
                }
                Err((code, message)) => {
                    report.fail(code, message, Some(&call.id), Some(&node.path))
                }
            }
        }
    }
    accepted
}

fn validate_result<'a>(
    value: &'a Value,
    limits: &Limits,
    now_ms: u64,
) -> Result<&'a Value, (&'static str, &'static str)> {
    let object = value
        .as_object()
        .ok_or(("invalid_fact", "FactResult must be an object"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "value" | "source" | "observedAt" | "blockNumber"
        )
    }) {
        return Err(("invalid_fact", "unknown FactResult field"));
    }
    let raw = object
        .get("value")
        .ok_or(("invalid_fact", "missing FactResult.value"))?;
    let source = string(object, "source")?;
    if source.trim().is_empty() {
        return Err(("invalid_fact", "source must be non-empty"));
    }
    let observed = object
        .get("observedAt")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or((
            "invalid_fact",
            "observedAt must be a nonnegative safe integer in milliseconds",
        ))?;
    if observed > now_ms + limits.allowed_clock_skew_ms {
        return Err(("invalid_fact", "Fact observation is in the future"));
    }
    if now_ms.saturating_sub(observed) > limits.max_fact_age_ms {
        return Err(("fact_stale", "Fact observation exceeds maxFactAgeMs"));
    }
    if object.contains_key("blockNumber") {
        let block = string(object, "blockNumber")?;
        if block.is_empty() || !block.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err((
                "invalid_fact",
                "blockNumber must be a decimal integer string",
            ));
        }
    }
    Ok(raw)
}

fn string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, (&'static str, &'static str)> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(("invalid_fact", "Fact provenance field must be a string"))
}
