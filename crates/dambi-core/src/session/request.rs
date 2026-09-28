use policy_state::primitives::U256;
use policy_transition::action::Action;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::decode::dto::TransactionDecodingStatusDto;
use crate::snapshot::Snapshot;

use super::{parse_json, SessionError, MAX_SAFE_INTEGER};

pub(super) struct Request {
    pub original: Value,
    pub digest: String,
    pub chain: String,
    pub from: String,
    pub to: String,
    pub actions: Vec<Action>,
    pub partial: bool,
}

pub(super) fn decode(
    input: &str,
    snapshot: &Snapshot,
    now_ms: u64,
    max_bytes: u64,
) -> Result<Request, SessionError> {
    if input.len() as u64 > max_bytes.saturating_mul(6).saturating_add(1024) {
        return Err(SessionError::new(
            "LIMIT_EXCEEDED",
            "request exceeds input size limit",
        ));
    }
    let raw = parse_json(input, "INVALID_REQUEST")?;
    let object = raw
        .as_object()
        .ok_or_else(|| invalid("request must be an object"))?;
    let kind = text(object, "kind")?;
    let fields: &[&str] = match kind {
        "transaction" => &["kind", "chainId", "from", "to", "data", "value"],
        "typed_signature" => &["kind", "chainId", "from", "typedData"],
        "untyped_signature" => {
            text(object, "message")?;
            if let Some(from) = object.get("from") {
                address(from, "from")?;
            }
            return Err(unsupported("untyped signatures are not implemented"));
        }
        "venue_order" => {
            address(required(object, "from")?, "from")?;
            required(object, "order")?;
            return Err(unsupported("venue orders are not implemented"));
        }
        _ => return Err(unsupported("unsupported request kind")),
    };
    let mut original = Map::new();
    for field in fields {
        if let Some(value) = object.get(*field) {
            original.insert((*field).into(), value.clone());
        }
    }
    let original = Value::Object(original);
    let canonical = serde_json_canonicalizer::to_vec(&json!({
        "domain": "dambi.core.request.v1", "request": original
    }))
    .map_err(|error| invalid(error.to_string()))?;
    if canonical.len() as u64 > max_bytes {
        return Err(SessionError::new(
            "LIMIT_EXCEEDED",
            "canonical request exceeds maxRequestBytes",
        ));
    }
    let digest = format!("0x{}", hex::encode(Sha256::digest(&canonical)));
    let chain = text(object, "chainId")?.to_owned();
    let chain_id = chain_number(&chain)?;
    let from = address(required(object, "from")?, "from")?.to_owned();
    let registry = snapshot.decoder().registry();
    let (to, actions, partial) = if kind == "transaction" {
        let data = optional_text(object, "data")?.unwrap_or("0x");
        if !data.starts_with("0x")
            || data.len() % 2 != 0
            || !data.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(invalid("data must be even-length 0x hexadecimal bytes"));
        }
        let value = optional_text(object, "value")?.unwrap_or("0");
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid("value must be a decimal uint256 string"));
        }
        U256::from_str_radix(value, 10).map_err(|_| invalid("value exceeds the uint256 range"))?;
        // Reject malformed provided fields before classifying a target-less
        // transaction as unsupported. Creation bytecode need not be a selector.
        let to = match object.get("to") {
            Some(to) => address(to, "to")?,
            None => return Err(unsupported("contract creation is not supported")),
        };
        if data.len() > 2 && data.len() < 10 {
            return Err(invalid("calldata is shorter than a selector"));
        }
        let wire = json!({ "chain_id": chain_id, "to": to,
            "selector": if data.len() >= 10 { &data[..10] } else { "0x00000000" },
            "calldata": data, "value": value, "submitter": from,
            "submitted_at": now_ms / 1000
        });
        let decoded = registry.route_request(&wire.to_string()).map_err(|error| {
            let code = match error.kind.as_str() {
                "no_declarative_v3_mapper" | "route_failed" => "UNSUPPORTED_REQUEST",
                "input_too_large" => "LIMIT_EXCEEDED",
                _ => "INVALID_REQUEST",
            };
            SessionError::new(code, error.message)
        })?;
        let partial = decoded
            .decoding
            .is_some_and(|value| value.status == TransactionDecodingStatusDto::Partial);
        (to.to_owned(), decoded.actions, partial)
    } else {
        let typed_data = required(object, "typedData")?;
        if let Some(encoded) = typed_data.as_str() {
            // The legacy v4 decoder also accepts encoded JSON. Validate its
            // duplicate members/numbers/Unicode before its ordinary parser,
            // while preserving this exact string in the request and digest.
            parse_json(encoded, "INVALID_REQUEST")?;
        }
        let wire = json!({ "typed_data": typed_data, "requested_signer": from,
            "submitter": from, "submitted_at": now_ms / 1000,
            "routing": { "chain_id": chain_id }
        });
        let decoded = registry
            .route_typed_data_v4(&wire.to_string())
            .map_err(|error| {
                let code = match error.kind.as_str() {
                    "no_typed_data_mapper" | "unsupported_typed_data_contract" => {
                        "UNSUPPORTED_REQUEST"
                    }
                    "input_too_large" => "LIMIT_EXCEEDED",
                    _ => "INVALID_REQUEST",
                };
                SessionError::new(code, error.message)
            })?;
        (
            decoded.request.routing.verifying_contract,
            decoded.actions,
            false,
        )
    };
    if actions.is_empty() {
        return Err(unsupported("decoder emitted no actions"));
    }
    Ok(Request {
        original,
        digest,
        chain,
        from,
        to,
        actions,
        partial,
    })
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, SessionError> {
    required(object, key)?
        .as_str()
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}

fn optional_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, SessionError> {
    object
        .get(key)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| invalid(format!("{key} must be a string")))
        })
        .transpose()
}

fn required<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Value, SessionError> {
    object
        .get(key)
        .ok_or_else(|| invalid(format!("missing {key}")))
}

fn address<'a>(value: &'a Value, field: &str) -> Result<&'a str, SessionError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid(format!("{field} must be an address")))?;
    if value.len() != 42
        || !value.starts_with("0x")
        || !value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(invalid(format!("{field} must be a 20-byte hex address")));
    }
    Ok(value)
}

fn chain_number(chain: &str) -> Result<u64, SessionError> {
    let digits = chain
        .strip_prefix("eip155:")
        .ok_or_else(|| unsupported("only eip155 chains are supported"))?;
    let value = digits
        .parse::<u64>()
        .map_err(|_| invalid("invalid CAIP-2 chainId"))?;
    if value == 0 || value > MAX_SAFE_INTEGER || value.to_string() != digits {
        return Err(invalid(
            "chainId must contain a positive canonical safe integer",
        ));
    }
    Ok(value)
}

fn invalid(message: impl Into<String>) -> SessionError {
    SessionError::new("INVALID_REQUEST", message)
}
fn unsupported(message: impl Into<String>) -> SessionError {
    SessionError::new("UNSUPPORTED_REQUEST", message)
}
