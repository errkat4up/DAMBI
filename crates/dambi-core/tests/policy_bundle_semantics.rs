//! Only authenticated inputs enter these semantic and refresh regressions.

use base64::{engine::general_purpose::STANDARD, Engine};
use dambi_core::bundle::{
    parse_policy_bundle, parse_policy_envelope, validate_policy_bundle, KeyRole,
    PolicySemanticError, PolicySemanticErrorKind, PolicyUpdate, PolicyValidationConfig,
    SignatureVerifiedPolicyBundle, TrustedKeys, ValidatedPolicyBundle, VerificationKey,
};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::DecodePrivateKey,
};
use serde_json::{json, Value};

const DAY1: &[u8] = include_bytes!("fixtures/policy-bundle/day1.envelope.json");
const KEYS: &str = include_str!("fixtures/policy-bundle/test-only-keys.json");
const LIMIT: usize = 1_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ISSUED_SEC: u64 = 1_800_000_000;
const ISSUED_MS: u64 = ISSUED_SEC * 1000;
const NOW_MS: u64 = ISSUED_MS + 10_000;
const DEFAULT_AGE_SEC: u64 = 72 * 60 * 60;

fn config() -> PolicyValidationConfig {
    PolicyValidationConfig {
        env: "staging".into(),
        profile: "default".into(),
        max_bundle_age_sec: None,
        allowed_clock_skew_ms: 5_000,
    }
}

fn trust() -> TrustedKeys {
    let fixture: Value = serde_json::from_str(KEYS).unwrap();
    TrustedKeys::new(&[VerificationKey {
        key_id: fixture["policy"]["key_id"].as_str().unwrap().into(),
        role: KeyRole::Policy,
        public_key_spki_base64: fixture["policy"]["public_key_spki_b64"]
            .as_str()
            .unwrap()
            .into(),
    }])
    .unwrap()
}

fn signed_raw(raw: &[u8], key_id: Option<&str>) -> SignatureVerifiedPolicyBundle {
    let fixture: Value = serde_json::from_str(KEYS).unwrap();
    let body: String = fixture["policy"]["private_key_pkcs8_pem"]
        .as_str()
        .unwrap()
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let key = SigningKey::from_pkcs8_der(&STANDARD.decode(body).unwrap()).unwrap();
    let signature: Signature = key.sign(raw);
    let parsed =
        parse_policy_bundle(raw, &STANDARD.encode(signature.to_bytes()), key_id, LIMIT).unwrap();
    trust().verify_policy_bundle(parsed).unwrap()
}

fn policy(id: &str, severity: Option<&str>) -> String {
    let severity = severity
        .map(|value| format!("@severity(\"{value}\")\n"))
        .unwrap_or_default();
    format!(
        "@id(\"{id}\")\n{severity}forbid(principal, action == Core::Action::\"Unknown\", resource);"
    )
}

fn base() -> Value {
    json!({
        "policies": [{
            "id": "p",
            "policy": policy("p", Some("warn")),
            "manifest": {
                "id": "p",
                "schema_version": 2,
                "trigger": { "where": { "action.domain": { "eq": "unknown" } } }
            }
        }],
        "sequence": 42,
        "issued_at": ISSUED_SEC,
        "expires_at": null,
        "env": "staging",
        "profile": "default",
        "registry_ref": null
    })
}

fn facts_bundle(optional: bool) -> Value {
    let mut payload = base();
    payload["policies"][0]["policy"] = json!(
        "@id(\"p\")\n@severity(\"warn\")\n\
         forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
         when { context has custom && context.custom has totalInputUsd \
         && context.custom.totalInputUsd.greaterThan(decimal(\"1000.0000\")) };"
    );
    payload["policies"][0]["manifest"] = json!({
        "id": "p",
        "schema_version": 2,
        "trigger": { "where": { "action.tag": { "eq": "swap" } } },
        "policy_rpc": [{
            "id": "total-input-usd",
            "method": "oracle.usd_value",
            "params": { "chain_id": "$.root.chain_id" },
            "outputs": [{
                "kind": "context",
                "field": "totalInputUsd",
                "type": "Decimal",
                "from": "$.result.usd",
                "required": !optional
            }],
            "optional": optional
        }],
        "custom_context": { "fields": { "totalInputUsd": "decimal" } }
    });
    payload
}

fn validate(
    payload: &Value,
    config: &PolicyValidationConfig,
    now_ms: u64,
) -> Result<ValidatedPolicyBundle, PolicySemanticError> {
    validate_policy_bundle(
        signed_raw(payload.to_string().as_bytes(), None),
        config,
        now_ms,
    )
}

fn assert_kind(error: PolicySemanticError, expected: PolicySemanticErrorKind) {
    let code = match expected {
        PolicySemanticErrorKind::InvalidConfig => "INVALID_CONFIG",
        PolicySemanticErrorKind::InvalidPolicyBundle => "INVALID_POLICY_BUNDLE",
        PolicySemanticErrorKind::UnsupportedRegistryRef => "UNSUPPORTED_REGISTRY_REF",
        PolicySemanticErrorKind::PolicyScopeMismatch => "POLICY_SCOPE_MISMATCH",
        PolicySemanticErrorKind::PolicyExpired => "POLICY_EXPIRED",
        PolicySemanticErrorKind::PolicySequenceRejected => "POLICY_SEQUENCE_REJECTED",
        PolicySemanticErrorKind::LimitExceeded => "LIMIT_EXCEEDED",
    };
    assert_eq!(error.kind, expected, "{error:?}");
    assert_eq!(error.code(), code);
    assert!(!error.message.is_empty());
}

#[test]
fn node_day1_authenticates_and_validates_all_five_policies() {
    let parsed = parse_policy_envelope(DAY1, LIMIT).unwrap();
    let original = parsed.payload_bytes().to_vec();
    let issued = parsed.payload()["issued_at"].as_u64().unwrap();
    let verified = trust().verify_policy_bundle(parsed).unwrap();
    let validated = validate_policy_bundle(verified, &config(), issued * 1000 + 60_000).unwrap();
    assert_eq!(validated.manifests().len(), 5);
    assert_eq!(validated.sequence(), 42);
    assert_eq!(
        validated.valid_until_ms(),
        (issued + DEFAULT_AGE_SEC) * 1000
    );
    assert_eq!(
        validated.signature_verified().parsed().payload_bytes(),
        original
    );
    assert_eq!(
        validated.signature_verified().signer_key_id(),
        "d4-test-only-policy"
    );
}

#[test]
fn signed_scope_mismatches_and_registry_references_are_rejected() {
    for (field, value, kind) in [
        (
            "env",
            json!("production"),
            PolicySemanticErrorKind::PolicyScopeMismatch,
        ),
        (
            "profile",
            json!("other-profile"),
            PolicySemanticErrorKind::PolicyScopeMismatch,
        ),
        (
            "registry_ref",
            json!(""),
            PolicySemanticErrorKind::UnsupportedRegistryRef,
        ),
        (
            "registry_ref",
            json!("sha256:unresolved"),
            PolicySemanticErrorKind::UnsupportedRegistryRef,
        ),
    ] {
        let mut payload = base();
        payload[field] = value;
        assert_kind(validate(&payload, &config(), NOW_MS).unwrap_err(), kind);
    }
}

#[test]
fn expiry_uses_the_minimum_deadline_and_expires_at_the_exact_millisecond() {
    for (max_age, explicit_age, expected_age) in [
        (None, None, DEFAULT_AGE_SEC),
        (None, Some(60), 60),
        (None, Some(DEFAULT_AGE_SEC + 1), DEFAULT_AGE_SEC),
        (Some(120), None, 120),
        (Some(120), Some(60), 60),
        (Some(120), Some(300), 120),
    ] {
        let mut cfg = config();
        cfg.max_bundle_age_sec = max_age;
        let mut payload = base();
        payload["expires_at"] = explicit_age
            .map(|age| json!(ISSUED_SEC + age))
            .unwrap_or(Value::Null);
        let deadline = (ISSUED_SEC + expected_age) * 1000;
        let valid = validate(&payload, &cfg, deadline - 1).unwrap();
        assert_eq!(valid.valid_until_ms(), deadline);
        assert_kind(
            validate(&payload, &cfg, deadline).unwrap_err(),
            PolicySemanticErrorKind::PolicyExpired,
        );
    }
}

#[test]
fn issued_time_skew_is_in_milliseconds_and_does_not_extend_expiry() {
    let payload = base();
    let cfg = config();
    validate(&payload, &cfg, ISSUED_MS - cfg.allowed_clock_skew_ms).unwrap();
    assert_kind(
        validate(&payload, &cfg, ISSUED_MS - cfg.allowed_clock_skew_ms - 1).unwrap_err(),
        PolicySemanticErrorKind::InvalidPolicyBundle,
    );
    let mut no_skew = config();
    no_skew.allowed_clock_skew_ms = 0;
    validate(&payload, &no_skew, ISSUED_MS).unwrap();
    assert_kind(
        validate(&payload, &no_skew, ISSUED_MS - 1).unwrap_err(),
        PolicySemanticErrorKind::InvalidPolicyBundle,
    );
    for expiry in [ISSUED_SEC - 1, ISSUED_SEC] {
        let mut invalid = base();
        invalid["expires_at"] = json!(expiry);
        assert_kind(
            validate(&invalid, &cfg, NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
}

#[test]
fn unsafe_configuration_numbers_are_rejected_before_policy_work() {
    for max_age in [0, MAX_SAFE_INTEGER + 1] {
        let mut cfg = config();
        cfg.max_bundle_age_sec = Some(max_age);
        assert_kind(
            validate(&base(), &cfg, NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidConfig,
        );
    }
    let mut cfg = config();
    cfg.allowed_clock_skew_ms = MAX_SAFE_INTEGER + 1;
    assert_kind(
        validate(&base(), &cfg, NOW_MS).unwrap_err(),
        PolicySemanticErrorKind::InvalidConfig,
    );
    assert_kind(
        validate(&base(), &config(), MAX_SAFE_INTEGER + 1).unwrap_err(),
        PolicySemanticErrorKind::InvalidConfig,
    );
    let mut upper_bound = config();
    upper_bound.max_bundle_age_sec = Some(MAX_SAFE_INTEGER);
    upper_bound.allowed_clock_skew_ms = MAX_SAFE_INTEGER;
    let valid = validate(&base(), &upper_bound, MAX_SAFE_INTEGER).unwrap();
    // Input numbers are JS-safe; the internal millisecond deadline is a u64.
    assert_eq!(
        valid.valid_until_ms(),
        (ISSUED_SEC + MAX_SAFE_INTEGER) * 1000
    );
    for (env, profile) in [("unknown", "default"), ("staging", "other")] {
        let mut invalid_scope = config();
        invalid_scope.env = env.into();
        invalid_scope.profile = profile.into();
        assert_kind(
            validate(&base(), &invalid_scope, NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidConfig,
        );
    }
}

#[test]
fn entry_manifest_and_cedar_ids_must_agree_and_be_unique() {
    let mut duplicate_entry = base();
    let duplicate = duplicate_entry["policies"][0].clone();
    duplicate_entry["policies"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let mut wrong_manifest = base();
    wrong_manifest["policies"][0]["manifest"]["id"] = json!("other");
    let mut wrong_cedar = base();
    wrong_cedar["policies"][0]["policy"] = json!(policy("other", Some("warn")));
    let mut missing_cedar_id = base();
    missing_cedar_id["policies"][0]["policy"] =
        json!("forbid(principal, action == Core::Action::\"Unknown\", resource);");
    let mut duplicate_manifest = base();
    let mut second = duplicate_manifest["policies"][0].clone();
    second["id"] = json!("second");
    second["policy"] = json!(policy("second", Some("warn")));
    duplicate_manifest["policies"]
        .as_array_mut()
        .unwrap()
        .push(second);
    for payload in [
        duplicate_entry,
        wrong_manifest,
        wrong_cedar,
        missing_cedar_id,
        duplicate_manifest,
    ] {
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }

    // These distinct manifest/call pairs would share a concatenated RPC ID.
    let mut collision = facts_bundle(false);
    let entries: Vec<Value> = [("a::b", "c"), ("a", "b::c")]
        .into_iter()
        .map(|(manifest_id, call_id)| {
            let mut entry = collision["policies"][0].clone();
            entry["id"] = json!(manifest_id);
            entry["manifest"]["id"] = json!(manifest_id);
            entry["manifest"]["policy_rpc"][0]["id"] = json!(call_id);
            entry["policy"] = json!(entry["policy"]
                .as_str()
                .unwrap()
                .replace("@id(\"p\")", &format!("@id(\"{manifest_id}\")")));
            entry
        })
        .collect();
    collision["policies"] = json!(entries);
    assert_kind(
        validate(&collision, &config(), NOW_MS).unwrap_err(),
        PolicySemanticErrorKind::InvalidPolicyBundle,
    );
}

#[test]
fn malformed_nested_manifest_fields_are_not_silently_dropped() {
    for (pointer, replacement) in [
        ("/trigger", json!({"scope":"invalid"})),
        ("/trigger", json!({"where":[]})),
        ("/trigger", json!({"where":{"action.tag":{"eq":7}}})),
        ("/trigger", json!({"unexpected":true})),
        (
            "/policy_rpc/0",
            json!({"id":"c","method":"m","unexpected":true}),
        ),
        ("/policy_rpc/0", json!({"id":"c","outputs":[]})),
        (
            "/policy_rpc/0/outputs/0",
            json!({"kind":"context","field":"totalInputUsd","type":"Decimal","from":"$.result.usd","unexpected":true}),
        ),
        (
            "/custom_context",
            json!({"fields":{"totalInputUsd":"decimal"},"unexpected":true}),
        ),
    ] {
        let mut payload = facts_bundle(false);
        *payload["policies"][0]["manifest"]
            .pointer_mut(pointer)
            .unwrap() = replacement;
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
}

#[test]
fn manifest_outputs_must_match_the_declared_custom_context() {
    for (pointer, replacement) in [
        ("/policy_rpc/0/outputs", json!([])),
        ("/custom_context/fields", json!({})),
        ("/custom_context/fields/totalInputUsd", json!("String")),
        ("/policy_rpc/0/outputs/0/kind", json!("entity")),
        ("/policy_rpc/0/outputs/0/type", json!("Unknown")),
        ("/policy_rpc/0/outputs/0/from", json!("$.result[")),
        ("/policy_rpc/0/outputs/0/from", json!("$.action.recipient")),
        ("/policy_rpc/0/params/chain_id", json!("$.root[")),
        (
            "/custom_context/fields/totalInputUsd",
            json!("decimal } entity Injected {}"),
        ),
    ] {
        let mut payload = facts_bundle(false);
        *payload["policies"][0]["manifest"]
            .pointer_mut(pointer)
            .unwrap() = replacement;
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
    for legacy_type in ["UsdValuation", "WindowStats"] {
        let mut payload = facts_bundle(false);
        payload["policies"][0]["manifest"]["policy_rpc"][0]["outputs"][0]["type"] =
            json!(legacy_type);
        payload["policies"][0]["manifest"]["custom_context"]["fields"]["totalInputUsd"] =
            json!(legacy_type);
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
}

#[test]
fn each_entry_requires_exactly_one_static_well_typed_cedar_policy() {
    let valid = policy("p", Some("warn"));
    for cedar in [
        "not Cedar".to_owned(),
        "// only comments, no executable policy".to_owned(),
        "@id(\"p\") forbid(principal == ?principal, action == Core::Action::\"Unknown\", resource);".to_owned(),
        format!("{valid}\n{}", policy("second", Some("warn"))),
        "@id(\"p\") forbid(principal, action == Core::Action::\"Unknown\", resource) when { \"one\" > 1 };".to_owned(),
        policy("p", Some("unknown")),
    ] {
        let mut payload = base();
        payload["policies"][0]["policy"] = json!(cedar);
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
    let mut mixed = base();
    let mut invalid_second = mixed["policies"][0].clone();
    invalid_second["id"] = json!("second");
    invalid_second["manifest"]["id"] = json!("second");
    invalid_second["policy"] = json!("not Cedar");
    mixed["policies"]
        .as_array_mut()
        .unwrap()
        .push(invalid_second);
    // A healthy sibling cannot turn an invalid bundle into partial acceptance.
    assert_kind(
        validate(&mixed, &config(), NOW_MS).unwrap_err(),
        PolicySemanticErrorKind::InvalidPolicyBundle,
    );
}

#[test]
fn guarded_or_bracketed_undeclared_custom_access_is_rejected_but_text_is_not() {
    for expression in [
        "context has custom && context.custom has ghost && context.custom.ghost == \"x\"",
        "context has custom && context.custom has ghost && context.custom[\"ghost\"] == \"x\"",
        "context has custom && (if true then context.custom else context.custom) has ghost",
        "context has custom && ({ alias: context.custom }).alias has ghost",
    ] {
        let mut payload = facts_bundle(false);
        payload["policies"][0]["policy"] = json!(format!(
            "@id(\"p\")\n@severity(\"warn\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ {expression} }};"
        ));
        assert_kind(
            validate(&payload, &config(), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::InvalidPolicyBundle,
        );
    }
    let mut text_only = facts_bundle(false);
    text_only["policies"][0]["policy"] = json!(
        "// context.custom.ghost and context.custom[\"ghost\"] are examples only.\n\
         @id(\"p\")\n@severity(\"warn\")\n\
         forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
         when { \"context.custom.ghost\" == \"context.custom.ghost\" };"
    );
    validate(&text_only, &config(), NOW_MS).unwrap();
    for expression in [
        "context has custom && (if true then context.custom else context.custom) has totalInputUsd",
        "context has custom && ({ alias: context.custom }).alias has totalInputUsd",
    ] {
        let mut payload = facts_bundle(false);
        payload["policies"][0]["policy"] = json!(format!(
            "@id(\"p\")\n@severity(\"warn\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ {expression} }};"
        ));
        validate(&payload, &config(), NOW_MS).unwrap();
    }
}

#[test]
fn supported_severities_and_engine_default_remain_valid() {
    for severity in [None, Some("warn"), Some("deny")] {
        let mut payload = base();
        payload["policies"][0]["policy"] = json!(policy("p", severity));
        assert_eq!(
            validate(&payload, &config(), NOW_MS)
                .unwrap()
                .manifests()
                .len(),
            1
        );
    }
}

#[test]
fn required_and_optional_fact_manifests_validate_with_their_own_schema() {
    for optional in [false, true] {
        let validated = validate(&facts_bundle(optional), &config(), NOW_MS).unwrap();
        let manifest = &validated.manifests()[0];
        assert_eq!(manifest.id, "p");
        assert_eq!(manifest.policy_rpc.len(), 1);
        assert_eq!(manifest.policy_rpc[0].optional, optional);
        assert_eq!(manifest.policy_rpc[0].outputs[0].required, !optional);
        assert_eq!(manifest.custom_context.fields["totalInputUsd"], "decimal");
    }
}

#[test]
fn updates_accept_initial_and_higher_sequences_but_reject_rollback() {
    let mut cfg = config();
    cfg.max_bundle_age_sec = Some(60);
    let previous = validate(&base(), &cfg, NOW_MS).unwrap();
    assert_eq!(
        previous.check_update(None, NOW_MS).unwrap(),
        PolicyUpdate::Replace
    );
    let refresh_ms = previous.valid_until_ms() + 1;
    assert_kind(
        previous.ensure_fresh(refresh_ms).unwrap_err(),
        PolicySemanticErrorKind::PolicyExpired,
    );
    for (sequence, accepted) in [(41, false), (43, true)] {
        let mut payload = base();
        payload["sequence"] = json!(sequence);
        payload["issued_at"] = json!(ISSUED_SEC + 60);
        let next = validate(&payload, &cfg, refresh_ms).unwrap();
        // An expired previous snapshot still supplies the rollback floor.
        let result = next.check_update(Some(&previous), refresh_ms);
        if accepted {
            assert_eq!(result.unwrap(), PolicyUpdate::Replace);
        } else {
            assert_kind(
                result.unwrap_err(),
                PolicySemanticErrorKind::PolicySequenceRejected,
            );
        }
    }
}

#[test]
fn equal_sequence_requires_identical_payload_bytes_and_preserves_them() {
    let payload = base();
    let raw = payload.to_string();
    let previous =
        validate_policy_bundle(signed_raw(raw.as_bytes(), None), &config(), NOW_MS).unwrap();
    let repeated = validate_policy_bundle(
        signed_raw(raw.as_bytes(), Some("different-untrusted-telemetry")),
        &config(),
        NOW_MS + 1,
    )
    .unwrap();
    assert_eq!(
        repeated.check_update(Some(&previous), NOW_MS + 1).unwrap(),
        PolicyUpdate::Unchanged
    );
    assert_eq!(
        repeated.signature_verified().parsed().payload_bytes(),
        raw.as_bytes()
    );
    let mut changed = payload.clone();
    changed["policies"][0]["policy"] = json!(policy("p", Some("deny")));
    for candidate in [
        format!(" \n{raw}\t"),
        serde_json::to_string_pretty(&payload).unwrap(),
        changed.to_string(),
    ] {
        let next =
            validate_policy_bundle(signed_raw(candidate.as_bytes(), None), &config(), NOW_MS)
                .unwrap();
        assert_eq!(
            next.signature_verified().parsed().payload_bytes(),
            candidate.as_bytes()
        );
        assert_kind(
            next.check_update(Some(&previous), NOW_MS).unwrap_err(),
            PolicySemanticErrorKind::PolicySequenceRejected,
        );
    }
}

#[test]
fn unchanged_refresh_rechecks_expiry_instead_of_extending_it() {
    let mut cfg = config();
    cfg.max_bundle_age_sec = Some(60);
    let previous = validate(&base(), &cfg, NOW_MS).unwrap();
    let repeated = validate(&base(), &cfg, NOW_MS + 1).unwrap();
    let deadline = ISSUED_MS + 60_000;
    assert_eq!(previous.valid_until_ms(), deadline);
    assert_eq!(repeated.valid_until_ms(), deadline);
    assert_eq!(
        repeated
            .check_update(Some(&previous), deadline - 1)
            .unwrap(),
        PolicyUpdate::Unchanged
    );
    for old in [None, Some(&previous)] {
        assert_kind(
            repeated.check_update(old, deadline).unwrap_err(),
            PolicySemanticErrorKind::PolicyExpired,
        );
    }
}
