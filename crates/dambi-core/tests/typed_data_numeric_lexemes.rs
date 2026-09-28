//! Native numeric-lexeme regressions. Package-local inputs are pinned copies of
//! the USDC Permit manifest and the DEC-04b strict request defaults. The shared
//! Node matrix stays separate: JavaScript cannot preserve every numeric token.

use dambi_core::decode::DecoderRegistry;
use serde_json::{json, Value};

const PERMIT_SOURCE: &str = include_str!("fixtures/erc20-permit.manifest.json");
const REQUEST: &str = include_str!("fixtures/typed-permit-numeric-request.json");

fn registry_and_request() -> (DecoderRegistry, Value) {
    let mut registry = DecoderRegistry::default();
    let installed = registry.install(PERMIT_SOURCE).unwrap();
    assert_eq!(installed.decoder_id, "standard/erc20/permit@1.0.0");
    let request = serde_json::from_str(REQUEST).unwrap();
    // Establish that the pinned input is valid before changing only a number.
    registry.route_typed_data_v4(REQUEST).unwrap();
    (registry, request)
}

fn assert_numeric_error(registry: &DecoderRegistry, raw: &str, field: &str, label: &str) {
    let error = registry.route_typed_data_v4(raw).unwrap_err();
    assert_eq!(error.kind, "invalid_typed_data", "{label}: {error:?}");
    assert_eq!(
        error.path.as_deref(),
        Some(format!("typed_data.message.{field}").as_str()),
        "{label}: {error:?}"
    );
    assert!(!error.message.is_empty(), "{label}: {error:?}");
}

#[test]
fn unsafe_numeric_lexemes_are_rejected_even_without_javascript_rounding() {
    let (registry, defaults) = registry_and_request();
    // serde_json preserves these u64 tokens, including 2^53+1, which JavaScript
    // would already have rounded before serializing the request.
    for value in [9_007_199_254_740_992_u64, 9_007_199_254_740_993, u64::MAX] {
        for field in ["value", "nonce", "deadline"] {
            let mut input = defaults.clone();
            input["typed_data"]["message"][field] = json!(value);
            assert_numeric_error(&registry, &input.to_string(), field, field);
        }
    }
}

#[test]
fn fraction_or_exponent_json_lexemes_cannot_round_into_valid_integer_input() {
    let (registry, defaults) = registry_and_request();
    for literal in ["1.0", "1e0", "1.0000000000000001", "-0.0"] {
        for field in ["value", "nonce", "deadline"] {
            let mut input = defaults.clone();
            input["typed_data"]["message"][field] = json!("NUMERIC_LEXEME");
            let raw = input.to_string().replace("\"NUMERIC_LEXEME\"", literal);
            assert_numeric_error(&registry, &raw, field, literal);
        }
    }
}
