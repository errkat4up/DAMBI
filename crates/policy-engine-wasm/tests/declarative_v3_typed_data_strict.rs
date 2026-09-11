//! DEC-04b: the full-input v4 boundary with the actual v3 USDC manifest.
//!
//! Node and native Rust replay the same request matrix. These repository paths
//! are temporary pre-SDK fixture dependencies, not an independent SDK package.
//! Each native test installs its own source on its thread; no reset API is used.
//! The legacy 04a fixtures and v3 integration tests remain independent.

use policy_engine_wasm::{
    declarative_install_v3_json, declarative_route_typed_data_v3_json,
    declarative_route_typed_data_v4_json,
};
use serde_json::{json, Value};

const PERMIT_SOURCE: &str =
    include_str!("../../../registryV2/manifests/standard/erc20/permit@1.0.0.json");
const UNSUPPORTED_SOURCE: &str =
    include_str!("../../../registryV2/manifests/lido/steth/permit@1.0.0.json");
const STRICT_FIXTURE: &str =
    include_str!("../../../fixtures/decoder-policy/typed-permit-strict.cases.json");
const LEGACY_FIXTURE: &str =
    include_str!("../../../fixtures/decoder-policy/typed-permit.cases.json");
const PERMIT_ID: &str = "standard/erc20/permit@1.0.0";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

fn parse(value: &str) -> Value {
    serde_json::from_str(value).unwrap()
}

fn install(source: &str) {
    let actual = parse(&declarative_install_v3_json(source.to_owned()));
    assert_eq!(actual["ok"], true, "{actual}");
    assert_eq!(actual["data"]["decoder_id"], parse(source)["id"]);
}

fn route(input: &Value) -> Value {
    parse(&declarative_route_typed_data_v4_json(input.to_string()))
}

fn set_path(input: &mut Value, path: &str, replacement: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = input;
    for part in &parts[..parts.len() - 1] {
        current = &mut current[*part];
    }
    current[parts[parts.len() - 1]] = replacement;
}

fn request_case(fixture: &Value, case: &Value) -> Value {
    let mut input = fixture["defaults"].clone();
    if let Some(changes) = case["set"].as_object() {
        for (path, value) in changes {
            set_path(&mut input, path, value.clone());
        }
    }
    if let Some(paths) = case["omit"].as_array() {
        for path in paths {
            let path = path.as_str().unwrap();
            let parts: Vec<&str> = path.split('.').collect();
            let mut current = &mut input;
            for part in &parts[..parts.len() - 1] {
                current = &mut current[*part];
            }
            assert!(current
                .as_object_mut()
                .unwrap()
                .remove(parts[parts.len() - 1])
                .is_some());
        }
    }
    // serde_json::Map may sort keys. The Node peer additionally changes the
    // serialized insertion order for reverse_object_keys; values stay equal.
    if case["typed_data_encoding"] == "json" {
        input["typed_data"] = json!(serde_json::to_string_pretty(&input["typed_data"]).unwrap());
    }
    input
}

fn small_uint(value: &Value) -> u64 {
    if let Some(number) = value.as_u64() {
        return number;
    }
    let raw = value.as_str().unwrap();
    if let Some(hex) = raw.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).unwrap()
    } else {
        raw.parse().unwrap()
    }
}

fn assert_error(actual: &Value, kind: &str, path: Option<&str>, label: &str) {
    assert_eq!(actual["ok"], false, "{label}: {actual}");
    assert!(actual["data"].is_null(), "{label}: {actual}");
    assert_eq!(actual["error"]["kind"], kind, "{label}: {actual}");
    assert!(!actual["error"]["message"].as_str().unwrap().is_empty());
    if let Some(path) = path {
        assert_eq!(actual["error"]["path"], path, "{label}: {actual}");
    }
    if matches!(
        kind,
        "no_typed_data_mapper" | "unsupported_typed_data_contract"
    ) {
        assert!(actual["error"]["message"]
            .as_str()
            .unwrap()
            .contains("detailed validation not performed"));
    }
}

fn assert_permit(actual: &Value, input: &Value, case: &Value, legacy: &Value) {
    let id = case["id"].as_str().unwrap();
    let mut original = input.clone();
    if let Some(raw) = original["typed_data"].as_str().map(str::to_owned) {
        original["typed_data"] = parse(&raw);
        original["typed_data_json"] = json!(raw);
    }
    let message = &original["typed_data"]["message"];
    let domain = &original["typed_data"]["domain"];
    let deadline = small_uint(&message["deadline"]);
    let owner = message["owner"].as_str().unwrap().to_ascii_lowercase();
    let signer = input["requested_signer"]
        .as_str()
        .unwrap()
        .to_ascii_lowercase();
    let submitter = input
        .get("submitter")
        .unwrap_or(&input["requested_signer"])
        .as_str()
        .unwrap()
        .to_ascii_lowercase();
    let mut body = legacy["expected_permit"]["body"].clone();
    body["spender"] = json!(message["spender"].as_str().unwrap().to_ascii_lowercase());
    body["amount"] = case["expected"]
        .get("amount")
        .cloned()
        .unwrap_or_else(|| json!("0xf4240"));
    body["deadline"] = json!(deadline);
    body["nonce"]["synced_at"] = input["submitted_at"].clone();
    let mut meta = legacy["expected_permit"]["meta"].clone();
    meta["submitted_at"] = input["submitted_at"].clone();
    meta["submitter"] = json!(submitter);
    meta["nature"]["deadline"] = json!(deadline);
    for key in ["version", "salt"] {
        if let Some(value) = domain.get(key) {
            meta["nature"]["domain"][key] = value.clone();
        }
    }
    let nonce = case["expected"]
        .get("signed_nonce")
        .cloned()
        .unwrap_or_else(|| json!("7"));
    let expected = json!({
        "ok": true,
        "error": null,
        "data": {
            "decoder_id": PERMIT_ID,
            "actions": [{"body": body, "meta": meta}],
            "request": {
                "original": original,
                "routing": {"chain_id": 1, "verifying_contract": USDC, "primary_type": "Permit"},
                "validated": {
                    "owner": owner, "requested_signer": signer, "submitter": submitter,
                    "signed_nonce": nonce, "deadline_seconds": deadline.to_string()
                },
                "validation": {"signature_verification": "not_performed"}
            }
        }
    });
    assert_eq!(actual, &expected, "{id}");
    assert_eq!(
        actual["data"]["actions"][0]["body"]["nonce"]["value"],
        "0x0"
    );
    assert!(actual["data"]["actions"][0]["body"].get("owner").is_none());
}

#[test]
fn actual_usdc_shared_full_input_matrix() {
    install(PERMIT_SOURCE);
    let fixture = parse(STRICT_FIXTURE);
    let legacy = parse(LEGACY_FIXTURE);
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 163);
    assert_eq!(legacy["cases"].as_array().unwrap().len(), 44);
    assert_eq!(
        fixture["defaults"]["typed_data"]["types"],
        parse(PERMIT_SOURCE)["match"]["typed_data"]["types"]
    );
    for case in cases {
        let input = request_case(&fixture, case);
        let actual = route(&input);
        if let Some(kind) = case["expected"]["error_kind"].as_str() {
            assert_error(
                &actual,
                kind,
                case["expected"]["error_path"].as_str(),
                case["id"].as_str().unwrap(),
            );
        } else {
            assert_permit(&actual, &input, case, &legacy);
        }
    }
}

#[test]
fn malformed_outer_json_has_its_own_error_kind() {
    install(PERMIT_SOURCE);
    for raw in ["{", "{\"typed_data\":", "{]}"] {
        let actual = parse(&declarative_route_typed_data_v4_json(raw.to_owned()));
        assert_error(&actual, "invalid_input_json", None, raw);
    }
}

#[test]
fn unsafe_numeric_lexemes_are_rejected_even_without_javascript_rounding() {
    install(PERMIT_SOURCE);
    let defaults = parse(STRICT_FIXTURE)["defaults"].clone();
    // serde_json preserves these u64 JSON lexemes; the strict boundary still
    // rejects them, including 2^53+1 that JavaScript would already round.
    for value in [9_007_199_254_740_992_u64, 9_007_199_254_740_993, u64::MAX] {
        for field in ["value", "nonce", "deadline"] {
            let mut input = defaults.clone();
            input["typed_data"]["message"][field] = json!(value);
            assert_error(
                &route(&input),
                "invalid_typed_data",
                Some(&format!("typed_data.message.{field}")),
                field,
            );
        }
    }
}

#[test]
fn fraction_or_exponent_json_lexemes_cannot_round_into_valid_integer_input() {
    install(PERMIT_SOURCE);
    let defaults = parse(STRICT_FIXTURE)["defaults"].clone();
    for literal in ["1.0", "1e0", "1.0000000000000001", "-0.0"] {
        for field in ["value", "nonce", "deadline"] {
            let mut input = defaults.clone();
            input["typed_data"]["message"][field] = json!("NUMERIC_LEXEME");
            let raw = input.to_string().replace("\"NUMERIC_LEXEME\"", literal);
            let actual = parse(&declarative_route_typed_data_v4_json(raw));
            assert_error(
                &actual,
                "invalid_typed_data",
                Some(&format!("typed_data.message.{field}")),
                literal,
            );
        }
    }
}

#[test]
fn another_actual_installed_permit_is_outside_strict_support_before_owner_validation() {
    install(UNSUPPORTED_SOURCE);
    let source = parse(UNSUPPORTED_SOURCE);
    let mut input = parse(STRICT_FIXTURE)["defaults"].clone();
    input["typed_data"]["domain"]["name"] = source["match"]["typed_data"]["domain_name"].clone();
    input["typed_data"]["domain"]["verifyingContract"] =
        source["match"]["typed_data"]["verifying_contract"].clone();
    input["typed_data"]["message"]["owner"] = json!("malformed");
    assert_error(
        &route(&input),
        "unsupported_typed_data_contract",
        None,
        "actual stETH manifest is not a strict USDC success",
    );
}

#[test]
fn bundle_and_emitter_faults_do_not_become_unsupported_or_success() {
    let input = parse(STRICT_FIXTURE)["defaults"].clone();
    // Fault injection damages a declaration or emitter in the actual source.
    // These bundles never replace the normative positive fixture above.
    for (path, replacement, kind) in [
        (
            "match.typed_data.domain_name",
            Value::Null,
            "invalid_bundle",
        ),
        ("emit", Value::Null, "invalid_bundle"),
        ("emit.strategy", json!("array_emit"), "invalid_bundle"),
        ("emit.body", Value::Null, "invalid_bundle"),
        (
            "emit.body.token.erc20_permit.amount",
            json!("not-a-uint256"),
            "typed_interpretation_failed",
        ),
        (
            "emit.body.token.erc20_permit.deadline",
            json!("0"),
            "typed_interpretation_failed",
        ),
    ] {
        let mut damaged = parse(PERMIT_SOURCE);
        set_path(&mut damaged, path, replacement);
        install(&damaged.to_string());
        assert_error(&route(&input), kind, None, path);
    }
}

#[test]
fn legacy_v3_owner_gap_does_not_bypass_v4_and_keeps_its_original_envelope() {
    install(PERMIT_SOURCE);
    let legacy = parse(LEGACY_FIXTURE);
    let mut old_input = legacy["defaults"].clone();
    old_input["message"]
        .as_object_mut()
        .unwrap()
        .remove("owner");
    let old_result = parse(&declarative_route_typed_data_v3_json(old_input.to_string()));
    assert_eq!(
        old_result,
        json!({
            "ok": true, "error": null,
            "data": {"decoder_id": PERMIT_ID, "actions": [{
                "body": legacy["expected_permit"]["body"],
                "meta": legacy["expected_permit"]["meta"]
            }]}
        })
    );
    let mut strict_input = parse(STRICT_FIXTURE)["defaults"].clone();
    strict_input["typed_data"]["message"]
        .as_object_mut()
        .unwrap()
        .remove("owner");
    assert_error(
        &route(&strict_input),
        "invalid_typed_data",
        Some("typed_data.message.owner"),
        "strict must not retry v3",
    );
}
