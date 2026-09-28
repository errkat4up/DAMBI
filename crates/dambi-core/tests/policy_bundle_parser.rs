//! Policy wire parsing only: these tests do not verify signatures or trust.

use dambi_core::bundle::{
    parse_policy_bundle, parse_policy_envelope, ParsedPolicyBundle, PolicyParseError,
    PolicyParseErrorKind,
};
use serde_json::{json, Value};

const DAY1: &[u8] = include_bytes!("fixtures/policy-bundle/day1.envelope.json");
const LIMIT: usize = 1_000_000;
const BASE: &str = r#"{"policies":[{"id":"p","policy":"permit(principal, action, resource);","manifest":{"id":"p","schema_version":2}}],"sequence":42,"issued_at":1,"expires_at":null,"env":"staging","profile":"default","registry_ref":null}"#;

fn signature() -> String {
    // Canonical Base64 for 64 zero bytes. Encoding validity grants no trust.
    format!("{}==", "A".repeat(86))
}

fn parse(raw: &[u8]) -> Result<ParsedPolicyBundle, PolicyParseError> {
    parse_policy_bundle(raw, &signature(), None, LIMIT)
}

fn base() -> Value {
    serde_json::from_str(BASE).unwrap()
}

fn envelope(payload: &str) -> Value {
    json!({ "payload": payload, "signature": signature() })
}

fn assert_kind(error: PolicyParseError, kind: PolicyParseErrorKind) {
    let code = match kind {
        PolicyParseErrorKind::InvalidConfig => "INVALID_CONFIG",
        PolicyParseErrorKind::InputTooLarge | PolicyParseErrorKind::DepthLimit => "LIMIT_EXCEEDED",
        _ => "INVALID_POLICY_BUNDLE",
    };
    assert_eq!(error.kind, kind, "{error:?}");
    assert_eq!(error.code(), code);
    assert!(!error.message.is_empty());
}

fn structure_error(value: Value) {
    assert_kind(
        parse(value.to_string().as_bytes()).unwrap_err(),
        PolicyParseErrorKind::InvalidStructure,
    );
}

fn with_probe(raw_number: &str) -> String {
    BASE.replace(
        r#""schema_version":2"#,
        &format!(r#""schema_version":2,"trigger":{{"probe":{raw_number}}}"#),
    )
}

#[test]
fn day1_envelope_and_raw_entry_keep_the_original_payload() {
    let wire: Value = serde_json::from_slice(DAY1).unwrap();
    let original = wire["payload"].as_str().unwrap();
    let outer = parse_policy_envelope(DAY1, LIMIT).unwrap();
    let raw = parse_policy_bundle(
        original.as_bytes(),
        wire["signature"].as_str().unwrap(),
        wire["key_id"].as_str(),
        LIMIT,
    )
    .unwrap();
    assert_eq!(outer.payload_bytes(), original.as_bytes());
    assert_eq!(raw.payload_bytes(), outer.payload_bytes());
    assert_eq!(raw.payload(), outer.payload());
    assert_eq!(raw.signature(), outer.signature());
    assert_eq!(raw.key_id(), wire["key_id"].as_str());
    assert_eq!(raw.payload()["policies"].as_array().unwrap().len(), 5);
    assert_eq!(raw.payload()["sequence"], 42);
}

#[test]
fn whitespace_member_order_and_unicode_are_not_reserialized() {
    let mut payload = base();
    payload["profile"] = json!("한글 테스트");
    let original = format!(" \n{}\t", serde_json::to_string_pretty(&payload).unwrap());
    let parsed = parse(original.as_bytes()).unwrap();
    assert_eq!(parsed.payload_bytes(), original.as_bytes());
    assert_eq!(parsed.payload(), &payload);
    let wire = envelope(&original).to_string();
    assert_eq!(
        parse_policy_envelope(wire.as_bytes(), LIMIT)
            .unwrap()
            .payload_bytes(),
        original.as_bytes()
    );
}

#[test]
fn size_limit_counts_payload_bytes_and_zero_is_invalid_configuration() {
    let original = BASE.replace("default", "한글");
    let wire = envelope(&original).to_string();
    assert!(wire.len() > original.len());
    parse_policy_envelope(wire.as_bytes(), original.len()).unwrap();
    parse_policy_bundle(original.as_bytes(), &signature(), None, original.len()).unwrap();
    for error in [
        parse_policy_envelope(wire.as_bytes(), original.len() - 1).unwrap_err(),
        parse_policy_bundle(original.as_bytes(), &signature(), None, original.len() - 1)
            .unwrap_err(),
        parse_policy_bundle(
            original.as_bytes(),
            &signature(),
            None,
            original.chars().count(),
        )
        .unwrap_err(),
    ] {
        assert_kind(error, PolicyParseErrorKind::InputTooLarge);
    }
    for error in [
        parse_policy_envelope(wire.as_bytes(), 0).unwrap_err(),
        parse_policy_bundle(BASE.as_bytes(), &signature(), None, 0).unwrap_err(),
    ] {
        assert_kind(error, PolicyParseErrorKind::InvalidConfig);
    }
}

#[test]
fn malformed_utf8_and_leading_bom_are_rejected() {
    assert_kind(
        parse(&[0xff]).unwrap_err(),
        PolicyParseErrorKind::InvalidUtf8,
    );
    assert_kind(
        parse_policy_envelope(&[0xff], LIMIT).unwrap_err(),
        PolicyParseErrorKind::InvalidUtf8,
    );
    let payload_bom = format!("\u{feff}{BASE}");
    assert_kind(
        parse(payload_bom.as_bytes()).unwrap_err(),
        PolicyParseErrorKind::InvalidJson,
    );
    let outer_bom = format!("\u{feff}{}", envelope(BASE));
    assert_kind(
        parse_policy_envelope(outer_bom.as_bytes(), LIMIT).unwrap_err(),
        PolicyParseErrorKind::InvalidJson,
    );
    let inside = BASE.replace("default", "a\u{feff}b");
    assert_eq!(
        parse(inside.as_bytes()).unwrap().payload()["profile"],
        "a\u{feff}b"
    );
}

#[test]
fn unicode_escape_pairs_are_valid_but_lone_surrogates_are_not() {
    for escape in [r"\ud800", r"\udc00", r"\ud800x", r"\ud800\u0041"] {
        let raw = BASE.replace("default", escape);
        assert_kind(
            parse(raw.as_bytes()).unwrap_err(),
            PolicyParseErrorKind::InvalidJson,
        );
    }
    let paired = BASE.replace("default", r"\ud83d\ude00");
    let parsed = parse(paired.as_bytes()).unwrap();
    assert_eq!(parsed.payload()["profile"], "😀");
    assert_eq!(parsed.payload_bytes(), paired.as_bytes());
}

#[test]
fn invalid_json_and_trailing_values_are_rejected() {
    for raw in [
        "".to_owned(),
        "{".to_owned(),
        format!("{BASE} null"),
        format!("{BASE}{{}}"),
        BASE.replace("default", "line\nbreak"),
        BASE.replace("default", r"bad\x20escape"),
    ] {
        assert_kind(
            parse(raw.as_bytes()).unwrap_err(),
            PolicyParseErrorKind::InvalidJson,
        );
    }
    let trailing_outer = format!("{} []", envelope(BASE));
    assert_kind(
        parse_policy_envelope(trailing_outer.as_bytes(), LIMIT).unwrap_err(),
        PolicyParseErrorKind::InvalidJson,
    );
}

#[test]
fn duplicate_members_are_rejected_after_unescaping_at_every_depth() {
    for (raw, expected_path) in [
        (
            BASE.replace(r#""sequence":42"#, r#""sequence":41,"sequence":42"#),
            "$/sequence",
        ),
        (
            BASE.replacen(r#""id":"p""#, r#""id":"p","\u0069d":"q""#, 1),
            "$/policies/0/id",
        ),
        (
            BASE.replace(
                r#""schema_version":2"#,
                r#""schema_version":2,"trigger":{"where":{"x":1,"x":2}}"#,
            ),
            "$/policies/0/manifest/trigger/where/x",
        ),
        (
            BASE.replace(
                r#""schema_version":2"#,
                r#""schema_version":2,"trigger":{"é":1,"\u00e9":2}"#,
            ),
            "$/policies/0/manifest/trigger/é",
        ),
    ] {
        let error = parse(raw.as_bytes()).unwrap_err();
        assert_eq!(error.path, expected_path);
        assert_kind(error, PolicyParseErrorKind::DuplicateKey);
    }
    let raw = envelope(BASE).to_string();
    let duplicate_outer = raw.replacen("{", r#"{"key_id":"a","key_\u0069d":"b","#, 1);
    assert_kind(
        parse_policy_envelope(duplicate_outer.as_bytes(), LIMIT).unwrap_err(),
        PolicyParseErrorKind::DuplicateKey,
    );
}

#[test]
fn unsafe_integer_tokens_are_rejected_even_in_open_manifest_objects() {
    for literal in [
        "9007199254740992",
        "9007199254740993",
        "18446744073709551615",
        "-9007199254740992",
    ] {
        assert_kind(
            parse(with_probe(literal).as_bytes()).unwrap_err(),
            PolicyParseErrorKind::InvalidNumber,
        );
    }
    for field in [r#""sequence":42"#, r#""issued_at":1"#] {
        let replacement = format!("{}:9007199254740992", field.split(':').next().unwrap());
        assert_kind(
            parse(BASE.replace(field, &replacement).as_bytes()).unwrap_err(),
            PolicyParseErrorKind::InvalidNumber,
        );
    }
}

#[test]
fn lossy_fraction_overflow_and_underflow_tokens_are_rejected() {
    for literal in [
        "1e309",
        "1e-400",
        "1.0000000000000001",
        "9007199254740990.5",
    ] {
        assert_kind(
            parse(with_probe(literal).as_bytes()).unwrap_err(),
            PolicyParseErrorKind::InvalidNumber,
        );
    }
}

#[test]
fn exact_decimal_and_integer_exponent_tokens_are_accepted() {
    for literal in ["42.0", "4.2e1", "9007199254740991"] {
        let raw = BASE.replace(r#""sequence":42"#, &format!(r#""sequence":{literal}"#));
        assert_eq!(
            parse(raw.as_bytes()).unwrap().payload_bytes(),
            raw.as_bytes()
        );
    }
    let decimal = with_probe("0.1");
    assert_eq!(
        parse(decimal.as_bytes()).unwrap().payload()["policies"][0]["manifest"]["trigger"]["probe"],
        json!(0.1)
    );
}

#[test]
fn depth_limit_precedes_structural_validation() {
    // The root is an array, so a successfully parsed depth-128 value fails the
    // object schema. One more container must hit the parser's recursion limit.
    let nested = |depth: usize| format!("{}null{}", "[".repeat(depth), "]".repeat(depth));
    assert_kind(
        parse(nested(128).as_bytes()).unwrap_err(),
        PolicyParseErrorKind::InvalidStructure,
    );
    assert_kind(
        parse(nested(129).as_bytes()).unwrap_err(),
        PolicyParseErrorKind::DepthLimit,
    );
}

#[test]
fn envelope_requires_flat_fields_and_rejects_unknown_members() {
    let good = envelope(BASE);
    for field in ["payload", "signature"] {
        let mut value = good.clone();
        value.as_object_mut().unwrap().remove(field);
        assert_kind(
            parse_policy_envelope(value.to_string().as_bytes(), LIMIT).unwrap_err(),
            PolicyParseErrorKind::InvalidStructure,
        );
    }
    for (field, replacement) in [
        ("payload", base()),
        ("payload", Value::Null),
        ("payload", json!("")),
        ("signature", json!({ "sig_b64": signature() })),
        ("key_id", json!(1)),
        (
            "sig",
            json!({ "alg": "ECDSA_P256_SHA256", "sig_b64": signature() }),
        ),
        ("unknown", json!(true)),
    ] {
        let mut value = good.clone();
        value[field] = replacement;
        assert_kind(
            parse_policy_envelope(value.to_string().as_bytes(), LIMIT).unwrap_err(),
            PolicyParseErrorKind::InvalidStructure,
        );
    }
}

#[test]
fn payload_has_seven_required_fields_and_no_version_extension() {
    for field in [
        "policies",
        "sequence",
        "issued_at",
        "expires_at",
        "env",
        "profile",
        "registry_ref",
    ] {
        let mut value = base();
        value.as_object_mut().unwrap().remove(field);
        structure_error(value);
    }
    let mut versioned = base();
    versioned["schema_version"] = json!(1);
    structure_error(versioned);
    structure_error(Value::Null);
    structure_error(json!([]));
}

#[test]
fn payload_value_constraints_match_the_wire_contract() {
    for (field, replacement) in [
        ("policies", json!([])),
        ("policies", Value::Null),
        ("sequence", json!("42")),
        ("sequence", json!(0)),
        ("sequence", json!(42.5)),
        ("issued_at", json!(-1)),
        ("issued_at", json!(1.5)),
        ("expires_at", json!(1.5)),
        ("env", json!("fixture")),
        ("profile", json!("")),
        ("registry_ref", json!(1)),
    ] {
        let mut value = base();
        value[field] = replacement;
        structure_error(value);
    }
}

#[test]
fn policy_entries_and_manifest_skeleton_are_closed_and_typed() {
    for field in ["id", "policy", "manifest"] {
        let mut value = base();
        value["policies"][0].as_object_mut().unwrap().remove(field);
        structure_error(value);
    }
    for (pointer, replacement) in [
        ("/policies/0", json!([])),
        ("/policies/0/id", json!("")),
        ("/policies/0/policy", json!("")),
        ("/policies/0/manifest", json!({})),
        ("/policies/0/manifest", json!([])),
        ("/policies/0/manifest/schema_version", json!(1)),
    ] {
        let mut value = base();
        *value.pointer_mut(pointer).unwrap() = replacement;
        structure_error(value);
    }
    for (field, replacement) in [
        ("trigger", json!([])),
        ("policy_rpc", json!({})),
        ("policy_rpc", json!([1])),
        ("custom_context", json!([])),
        ("unknown", json!(true)),
    ] {
        let mut value = base();
        value["policies"][0]["manifest"][field] = replacement;
        structure_error(value);
    }
    let mut extra = base();
    extra["policies"][0]["unknown"] = json!(true);
    structure_error(extra);
}

#[test]
fn signature_requires_canonical_padded_base64_for_64_bytes() {
    for encoded in [
        String::new(),
        "AA==".to_owned(),
        "A".repeat(88),
        "A".repeat(86),
        format!("{}=", "A".repeat(86)),
        format!("{}B==", "A".repeat(85)), // Nonzero discarded padding bits.
        format!("-{}==", "A".repeat(85)), // URL-safe alphabet is not the wire alphabet.
        format!("{}\n", signature()),
    ] {
        assert_kind(
            parse_policy_bundle(BASE.as_bytes(), &encoded, None, LIMIT).unwrap_err(),
            PolicyParseErrorKind::InvalidSignatureEncoding,
        );
    }
    assert_eq!(parse(BASE.as_bytes()).unwrap().signature(), &[0_u8; 64]);
    let known_encoding =
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==";
    let expected: [u8; 64] = std::array::from_fn(|index| index as u8);
    let parsed = parse_policy_bundle(BASE.as_bytes(), known_encoding, None, LIMIT).unwrap();
    assert_eq!(parsed.signature(), &expected);
}

#[test]
fn key_id_is_optional_telemetry_and_never_parsed_as_trust() {
    for key_id in [
        None,
        Some(""),
        Some("unknown-key"),
        Some("decoder-key"),
        Some("로컬 표시"),
    ] {
        let raw = parse_policy_bundle(BASE.as_bytes(), &signature(), key_id, LIMIT).unwrap();
        assert_eq!(raw.key_id(), key_id);
        let mut wire = envelope(BASE);
        if let Some(key_id) = key_id {
            wire["key_id"] = json!(key_id);
        }
        let parsed = parse_policy_envelope(wire.to_string().as_bytes(), LIMIT).unwrap();
        assert_eq!(parsed.key_id(), key_id);
    }
}

#[test]
fn semantics_and_signature_validity_remain_deferred() {
    let mut duplicate_policy = base();
    let entry = duplicate_policy["policies"][0].clone();
    duplicate_policy["policies"]
        .as_array_mut()
        .unwrap()
        .push(entry);
    let mut mismatch = base();
    mismatch["policies"][0]["manifest"]["id"] = json!("different-id");
    let mut bad_cedar = base();
    bad_cedar["policies"][0]["policy"] = json!("not valid Cedar");
    for value in [duplicate_policy, mismatch, bad_cedar] {
        parse(value.to_string().as_bytes()).unwrap();
    }
    for (field, replacement) in [
        ("expires_at", json!(0)), // Before issued_at and already expired.
        ("issued_at", json!(0)),  // Age checks are not parser checks.
        ("sequence", json!(1)),   // Rollback depends on accepted state.
        ("env", json!("production")),
        ("profile", json!("different-profile")),
        ("registry_ref", json!("remote-root")),
    ] {
        let mut value = base();
        value[field] = replacement;
        parse(value.to_string().as_bytes()).unwrap();
    }
    let mut wire: Value = serde_json::from_slice(DAY1).unwrap();
    wire["payload"] = json!(format!("{}\n", wire["payload"].as_str().unwrap()));
    wire["signature"] = json!(signature());
    parse_policy_envelope(wire.to_string().as_bytes(), LIMIT).unwrap();
}
