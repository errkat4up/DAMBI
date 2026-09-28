//! Shared JSON boundary types and input-size guard.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<EngineErrorDto>,
}

impl<T: Serialize> Envelope<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(EngineErrorDto::new(kind, message)),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("envelope serialization cannot fail")
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineErrorDto {
    pub kind: String,
    pub message: String,
}

impl EngineErrorDto {
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

/// Maximum accepted JSON input byte length at the WASM boundary (4 MiB).
///
/// Round 1 audit (P1) — bound `String` inputs before `serde_json::from_str` so
/// a hostile caller cannot drive the WASM allocator into an OOM with a giant
/// payload. 4 MiB easily covers every legitimate request: an
/// `evaluate_policy_rpc_json` plan with all of the supported manifests, a full
/// Universal-Router opcode stream, and the largest declarative bundle all sit
/// under ~50 KiB.
pub const MAX_WASM_INPUT_JSON_LEN: usize = 4 * 1024 * 1024;

/// Reject WASM JSON inputs that exceed [`MAX_WASM_INPUT_JSON_LEN`].
///
/// Returns an `EngineErrorDto` with `kind = "input_too_large"` so callers can
/// distinguish a size violation from a malformed-JSON case.
pub fn check_input_size(input_json: &str, entry: &str) -> Result<(), EngineErrorDto> {
    if input_json.len() > MAX_WASM_INPUT_JSON_LEN {
        return Err(EngineErrorDto::new(
            "input_too_large",
            format!(
                "{entry} input json length {} exceeds {} byte limit",
                input_json.len(),
                MAX_WASM_INPUT_JSON_LEN
            ),
        ));
    }
    Ok(())
}
