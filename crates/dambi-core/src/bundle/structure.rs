//! Structural checks for the supported policy wire payload and signature.

use serde_json::{Map, Value};

use super::{PolicyParseError, PolicyParseErrorKind};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PAYLOAD_KEYS: &[&str] = &[
    "policies",
    "sequence",
    "issued_at",
    "expires_at",
    "env",
    "profile",
    "registry_ref",
];
const POLICY_KEYS: &[&str] = &["id", "policy", "manifest"];
const MANIFEST_KEYS: &[&str] = &[
    "id",
    "schema_version",
    "trigger",
    "policy_rpc",
    "custom_context",
];

pub(super) fn validate_payload(value: &Value) -> Result<(), PolicyParseError> {
    let payload = closed_object(value, "$", PAYLOAD_KEYS, PAYLOAD_KEYS)?;
    let policies = payload["policies"]
        .as_array()
        .ok_or_else(|| structure_error("$/policies", "policies must be a non-empty array"))?;
    if policies.is_empty() {
        return Err(structure_error(
            "$/policies",
            "policies must be a non-empty array",
        ));
    }
    for (index, policy) in policies.iter().enumerate() {
        validate_policy(policy, &format!("$/policies/{index}"))?;
    }

    safe_integer(&payload["sequence"], "$/sequence", 1)?;
    safe_integer(&payload["issued_at"], "$/issued_at", 0)?;
    if !payload["expires_at"].is_null() {
        safe_integer(&payload["expires_at"], "$/expires_at", 0)?;
    }
    if !matches!(payload["env"].as_str(), Some("staging" | "production")) {
        return Err(structure_error(
            "$/env",
            "env must be staging or production",
        ));
    }
    non_empty_string(&payload["profile"], "$/profile")?;
    if !payload["registry_ref"].is_null() && !payload["registry_ref"].is_string() {
        return Err(structure_error(
            "$/registry_ref",
            "registry_ref must be a string or null",
        ));
    }
    Ok(())
}

fn validate_policy(value: &Value, path: &str) -> Result<(), PolicyParseError> {
    let policy = closed_object(value, path, POLICY_KEYS, POLICY_KEYS)?;
    non_empty_string(&policy["id"], &format!("{path}/id"))?;
    non_empty_string(&policy["policy"], &format!("{path}/policy"))?;

    let path = format!("{path}/manifest");
    let manifest = closed_object(
        &policy["manifest"],
        &path,
        &["id", "schema_version"],
        MANIFEST_KEYS,
    )?;
    non_empty_string(&manifest["id"], &format!("{path}/id"))?;
    if manifest["schema_version"].as_u64() != Some(2) {
        return Err(structure_error(
            &format!("{path}/schema_version"),
            "manifest schema_version must be 2",
        ));
    }
    for field in ["trigger", "custom_context"] {
        if let Some(value) = manifest.get(field) {
            object(value, &format!("{path}/{field}"))?;
        }
    }
    if let Some(value) = manifest.get("policy_rpc") {
        let path = format!("{path}/policy_rpc");
        let calls = value
            .as_array()
            .ok_or_else(|| structure_error(&path, "policy_rpc must be an array of objects"))?;
        for (index, call) in calls.iter().enumerate() {
            object(call, &format!("{path}/{index}"))?;
        }
    }
    Ok(())
}

fn closed_object<'a>(
    value: &'a Value,
    path: &str,
    required: &[&str],
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, PolicyParseError> {
    let fields = object(value, path)?;
    for key in required {
        if !fields.contains_key(*key) {
            return Err(structure_error(
                &child_path(path, key),
                "required field is missing",
            ));
        }
    }
    for key in fields.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(structure_error(&child_path(path, key), "unsupported field"));
        }
    }
    Ok(fields)
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, PolicyParseError> {
    value
        .as_object()
        .ok_or_else(|| structure_error(path, "expected an object"))
}

fn non_empty_string(value: &Value, path: &str) -> Result<(), PolicyParseError> {
    match value.as_str() {
        Some(text) if !text.is_empty() => Ok(()),
        _ => Err(structure_error(path, "expected a non-empty string")),
    }
}

fn safe_integer(value: &Value, path: &str, minimum: u64) -> Result<(), PolicyParseError> {
    match value.as_u64() {
        Some(number) if (minimum..=MAX_SAFE_INTEGER).contains(&number) => Ok(()),
        _ => Err(structure_error(
            path,
            &format!("expected an integer in {minimum}..={MAX_SAFE_INTEGER}"),
        )),
    }
}

fn child_path(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn structure_error(path: &str, message: &str) -> PolicyParseError {
    PolicyParseError::new(PolicyParseErrorKind::InvalidStructure, path, message)
}

/// Decode only canonical padded standard Base64 for a 64-byte P1363 value.
/// Scalar validity and cryptographic verification are separate later checks.
pub(super) fn decode_signature(signature: &str) -> Result<[u8; 64], PolicyParseError> {
    let encoded = signature.as_bytes();
    if encoded.len() != 88 || encoded[86..] != *b"==" {
        return Err(signature_error());
    }

    let mut sextets = [0_u8; 86];
    for (slot, byte) in sextets.iter_mut().zip(&encoded[..86]) {
        *slot = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(signature_error()),
        };
    }
    // The final sextet has only two data bits: A, Q, g or w. Reject alternate
    // spellings with nonzero padding bits even if they decode to the same bytes.
    if sextets[85] & 0x0f != 0 {
        return Err(signature_error());
    }

    let mut decoded = [0_u8; 64];
    for (input, output) in sextets[..84]
        .chunks_exact(4)
        .zip(decoded[..63].chunks_exact_mut(3))
    {
        output[0] = (input[0] << 2) | (input[1] >> 4);
        output[1] = ((input[1] & 0x0f) << 4) | (input[2] >> 2);
        output[2] = ((input[2] & 0x03) << 6) | input[3];
    }
    decoded[63] = (sextets[84] << 2) | (sextets[85] >> 4);
    Ok(decoded)
}

fn signature_error() -> PolicyParseError {
    PolicyParseError::new(
        PolicyParseErrorKind::InvalidSignatureEncoding,
        "$/signature",
        "signature must be canonical standard Base64 encoding of exactly 64 bytes",
    )
}
