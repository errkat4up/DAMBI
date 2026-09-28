//! Strict policy wire parsing. Parsed bundles remain unverified.

mod strict_json;
mod structure;

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyParseErrorKind {
    InvalidConfig,
    InputTooLarge,
    InvalidUtf8,
    InvalidJson,
    DuplicateKey,
    InvalidNumber,
    InvalidStructure,
    InvalidSignatureEncoding,
    DepthLimit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyParseError {
    pub kind: PolicyParseErrorKind,
    /// JSON pointer within B, or within the envelope for envelope errors.
    pub path: String,
    pub message: String,
}

impl PolicyParseError {
    fn new(
        kind: PolicyParseErrorKind,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            path: path.into(),
            message: message.into(),
        }
    }

    /// Maps parser details to the existing public Core error categories.
    pub fn code(&self) -> &'static str {
        match self.kind {
            PolicyParseErrorKind::InvalidConfig => "INVALID_CONFIG",
            PolicyParseErrorKind::InputTooLarge | PolicyParseErrorKind::DepthLimit => {
                "LIMIT_EXCEEDED"
            }
            _ => "INVALID_POLICY_BUNDLE",
        }
    }
}

impl std::fmt::Display for PolicyParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}: {}", self.code(), self.path, self.message)
    }
}

impl std::error::Error for PolicyParseError {}

/// An immutable parsed view of B together with its exact, unnormalized bytes.
/// Neither this type nor a well-formed signature establishes trust.
#[derive(Debug)]
pub struct ParsedPolicyBundle {
    payload_bytes: Vec<u8>,
    payload: Value,
    signature: [u8; 64],
    key_id: Option<String>,
}

impl ParsedPolicyBundle {
    pub fn payload_bytes(&self) -> &[u8] {
        &self.payload_bytes
    }
    pub fn payload(&self) -> &Value {
        &self.payload
    }
    pub fn signature(&self) -> &[u8; 64] {
        &self.signature
    }
    /// Telemetry only; never a selector for trusted keys.
    pub fn key_id(&self) -> Option<&str> {
        self.key_id.as_deref()
    }
}

fn check_limit(max_policy_bytes: usize) -> Result<(), PolicyParseError> {
    if max_policy_bytes == 0 {
        return Err(PolicyParseError::new(
            PolicyParseErrorKind::InvalidConfig,
            "$",
            "maxPolicyBytes must be positive",
        ));
    }
    Ok(())
}

fn too_large() -> PolicyParseError {
    PolicyParseError::new(
        PolicyParseErrorKind::InputTooLarge,
        "$",
        "policy B exceeds maxPolicyBytes",
    )
}

fn utf8(bytes: &[u8]) -> Result<&str, PolicyParseError> {
    std::str::from_utf8(bytes).map_err(|_| {
        PolicyParseError::new(
            PolicyParseErrorKind::InvalidUtf8,
            "$",
            "input is not valid UTF-8",
        )
    })
}

/// Parse the PolicySource fields. Size is checked before parsing or copying B.
/// No trimming, JCS canonicalization, signature verification or policy activation.
pub fn parse_policy_bundle(
    payload: &[u8],
    signature: &str,
    key_id: Option<&str>,
    max_policy_bytes: usize,
) -> Result<ParsedPolicyBundle, PolicyParseError> {
    check_limit(max_policy_bytes)?;
    if payload.len() > max_policy_bytes {
        return Err(too_large());
    }
    let value = strict_json::parse(utf8(payload)?)?;
    structure::validate_payload(&value)?;
    let signature = structure::decode_signature(signature)?;
    Ok(ParsedPolicyBundle {
        payload_bytes: payload.to_vec(),
        payload: value,
        signature,
        key_id: key_id.map(str::to_owned),
    })
}

/// Parse the closed HTTP wire envelope (`payload`, `signature`, `key_id?`).
/// The configured policy limit applies to decoded B UTF-8 bytes, not the HTTP
/// envelope; the transport owns its response-size limit. Unknown/duplicate outer
/// members and malformed Unicode are rejected before returning a parsed bundle.
pub fn parse_policy_envelope(
    envelope: &[u8],
    max_policy_bytes: usize,
) -> Result<ParsedPolicyBundle, PolicyParseError> {
    check_limit(max_policy_bytes)?;
    let members = strict_json::object_members(utf8(envelope)?, "$")?;
    let mut payload = None;
    let mut signature = None;
    let mut key_id = None;
    for (key, value) in members {
        let path = strict_json::child_path("$", &key);
        match key.as_str() {
            "payload" => {
                // A JSON string needs at most six encoded bytes per B byte,
                // plus its quotes. Bound the copy even for escaped payloads.
                if value.get().len() > max_policy_bytes.saturating_mul(6).saturating_add(2) {
                    return Err(too_large());
                }
                let text = strict_json::string(value, &path)?;
                if text.is_empty() {
                    return Err(PolicyParseError::new(
                        PolicyParseErrorKind::InvalidStructure,
                        path,
                        "payload must be a non-empty string",
                    ));
                }
                payload = Some(text);
            }
            "signature" => signature = Some(strict_json::string(value, &path)?),
            "key_id" => key_id = Some(strict_json::string(value, &path)?),
            _ => {
                return Err(PolicyParseError::new(
                    PolicyParseErrorKind::InvalidStructure,
                    path,
                    "unknown envelope field",
                ))
            }
        }
    }
    let required = |name: &str| {
        PolicyParseError::new(
            PolicyParseErrorKind::InvalidStructure,
            format!("$/{name}"),
            "missing required field",
        )
    };
    let payload = payload.ok_or_else(|| required("payload"))?;
    let signature = signature.ok_or_else(|| required("signature"))?;
    parse_policy_bundle(
        payload.as_bytes(),
        &signature,
        key_id.as_deref(),
        max_policy_bytes,
    )
}
