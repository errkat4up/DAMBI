//! Signature authentication is distinct from later policy/Decoder semantics.

use base64::{engine::general_purpose::STANDARD, Engine};
use dambi_core::bundle::{
    parse_policy_bundle, parse_policy_envelope, KeyRole, PolicyParseErrorKind, SignatureError,
    SignatureErrorKind, SignatureVerifiedPolicyBundle, TrustedKeys, VerificationKey,
};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::DecodePrivateKey,
};
use serde_json::{json, Value};

const DAY1: &[u8] = include_bytes!("fixtures/policy-bundle/day1.envelope.json");
const KEYS: &str = include_str!("fixtures/policy-bundle/test-only-keys.json");
const LIMIT: usize = 1_000_000;
const BASE: &str = r#"{"policies":[{"id":"p","policy":"permit(principal, action, resource);","manifest":{"id":"p","schema_version":2}}],"sequence":42,"issued_at":1,"expires_at":null,"env":"staging","profile":"default","registry_ref":null}"#;

fn key(name: &str, role: KeyRole) -> VerificationKey {
    let keys: Value = serde_json::from_str(KEYS).unwrap();
    VerificationKey {
        key_id: keys[name]["key_id"].as_str().unwrap().to_owned(),
        role,
        public_key_spki_base64: keys[name]["public_key_spki_b64"]
            .as_str()
            .unwrap()
            .to_owned(),
    }
}

fn signing_key(name: &str) -> SigningKey {
    let keys: Value = serde_json::from_str(KEYS).unwrap();
    let pem = keys[name]["private_key_pkcs8_pem"].as_str().unwrap();
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    SigningKey::from_pkcs8_der(&STANDARD.decode(body).unwrap()).unwrap()
}

fn sign(name: &str, message: &[u8]) -> Signature {
    signing_key(name).sign(message)
}

fn encoded_signature(name: &str, message: &[u8]) -> String {
    STANDARD.encode(sign(name, message).to_bytes())
}

fn trust() -> TrustedKeys {
    TrustedKeys::new(&[
        key("policy", KeyRole::Policy),
        key("decoder", KeyRole::Decoder),
    ])
    .unwrap()
}

fn verify_policy(
    trusted: &TrustedKeys,
    payload: &[u8],
    signature: &str,
    key_id: Option<&str>,
) -> Result<SignatureVerifiedPolicyBundle, SignatureError> {
    let parsed = parse_policy_bundle(payload, signature, key_id, LIMIT).unwrap();
    trusted.verify_policy_bundle(parsed)
}

fn assert_kind(error: SignatureError, kind: SignatureErrorKind) {
    let code = match kind {
        SignatureErrorKind::InvalidConfig => "INVALID_CONFIG",
        SignatureErrorKind::InvalidSignature => "INVALID_SIGNATURE",
        SignatureErrorKind::InvalidDecoderSnapshot => "INVALID_DECODER_SNAPSHOT",
        SignatureErrorKind::LimitExceeded => "LIMIT_EXCEEDED",
    };
    assert_eq!(error.kind, kind, "{error:?}");
    assert_eq!(error.code(), code);
    assert!(!error.message.is_empty());
}

#[test]
fn node_day1_signature_is_verified_without_resigning() {
    // This signature was created by the existing Node fixture producer. Do not
    // replace it with a Rust-generated signature: it pins wire interoperability.
    let envelope: Value = serde_json::from_slice(DAY1).unwrap();
    let parsed = parse_policy_envelope(DAY1, LIMIT).unwrap();
    let verified = trust().verify_policy_bundle(parsed).unwrap();
    assert_eq!(verified.signer_key_id(), "d4-test-only-policy");
    assert_eq!(
        verified.parsed().payload_bytes(),
        envelope["payload"].as_str().unwrap().as_bytes()
    );
    assert_eq!(verified.parsed().key_id(), envelope["key_id"].as_str());
}

#[test]
fn policy_binds_exact_bytes_and_accepts_both_ecdsa_s_forms() {
    let trusted = trust();
    let original = sign("policy", BASE.as_bytes());
    let low = original.normalize_s().unwrap_or(original);
    let high = Signature::from_scalars(low.r().to_bytes(), (-low.s()).to_bytes()).unwrap();
    assert_ne!(low.to_bytes(), high.to_bytes());
    assert_eq!(high.normalize_s(), Some(low));
    for signature in [low, high] {
        let verified = verify_policy(
            &trusted,
            BASE.as_bytes(),
            &STANDARD.encode(signature.to_bytes()),
            None,
        )
        .unwrap();
        assert_eq!(verified.parsed().payload_bytes(), BASE.as_bytes());
    }

    let signature = STANDARD.encode(low.to_bytes());
    let reordered = format!(
        r#"{{"sequence":42,{}}}"#,
        BASE.strip_prefix('{')
            .unwrap()
            .strip_suffix('}')
            .unwrap()
            .replace(r#","sequence":42"#, "")
    );
    let original_value: Value = serde_json::from_str(BASE).unwrap();
    for changed in [format!(" \n{BASE}\t"), reordered] {
        assert_ne!(changed.as_bytes(), BASE.as_bytes());
        assert_eq!(
            serde_json::from_str::<Value>(&changed).unwrap(),
            original_value
        );
        assert_kind(
            verify_policy(&trusted, changed.as_bytes(), &signature, None).unwrap_err(),
            SignatureErrorKind::InvalidSignature,
        );
    }
}

#[test]
fn policy_rejects_bitflips_zero_and_out_of_range_scalars() {
    let trusted = trust();
    let valid = sign("policy", BASE.as_bytes()).to_bytes();
    let mut flipped = valid.to_vec();
    flipped[0] ^= 1;
    let mut zero_r = valid.to_vec();
    zero_r[..32].fill(0);
    let mut out_of_range_s = valid.to_vec();
    out_of_range_s[32..].fill(0xff);
    for bytes in [flipped, vec![0; 64], zero_r, out_of_range_s] {
        // The parser accepts these 64-byte encodings; ECDSA authentication must
        // reject invalid scalars as well as a well-encoded mismatched signature.
        assert_kind(
            verify_policy(&trusted, BASE.as_bytes(), &STANDARD.encode(bytes), None).unwrap_err(),
            SignatureErrorKind::InvalidSignature,
        );
    }
}

#[test]
fn der_signatures_are_not_accepted_as_p1363() {
    let signature = sign("policy", BASE.as_bytes()).to_der();
    let error = parse_policy_bundle(
        BASE.as_bytes(),
        &STANDARD.encode(signature.as_bytes()),
        None,
        LIMIT,
    )
    .unwrap_err();
    assert_eq!(error.kind, PolicyParseErrorKind::InvalidSignatureEncoding);
    let decoder_signature = sign("decoder", b"{}").to_der();
    assert_kind(
        trust()
            .verify_decoder_bundle(
                b"{}",
                &STANDARD.encode(decoder_signature.as_bytes()),
                None,
                LIMIT,
            )
            .unwrap_err(),
        SignatureErrorKind::InvalidSignature,
    );
}

#[test]
fn policy_and_decoder_keys_cannot_cross_roles() {
    let trusted = trust();
    assert_kind(
        verify_policy(
            &trusted,
            BASE.as_bytes(),
            &encoded_signature("decoder", BASE.as_bytes()),
            Some("d4-test-only-policy"),
        )
        .unwrap_err(),
        SignatureErrorKind::InvalidSignature,
    );
    assert_kind(
        trusted
            .verify_decoder_bundle(
                b"{}",
                &encoded_signature("policy", b"{}"),
                Some("d4-test-only-decoder"),
                LIMIT,
            )
            .unwrap_err(),
        SignatureErrorKind::InvalidSignature,
    );
}

#[test]
fn response_key_ids_are_only_telemetry_for_both_roles() {
    let trusted = trust();
    let policy_signature = encoded_signature("policy", BASE.as_bytes());
    let decoder_signature = encoded_signature("decoder", b"{}");
    for key_id in [
        None,
        Some(""),
        Some("unknown-remote-key"),
        Some("d4-test-only-policy"),
        Some("d4-test-only-decoder"),
    ] {
        let policy = verify_policy(&trusted, BASE.as_bytes(), &policy_signature, key_id).unwrap();
        assert_eq!(policy.signer_key_id(), "d4-test-only-policy");
        assert_eq!(policy.parsed().key_id(), key_id);
        let decoder = trusted
            .verify_decoder_bundle(b"{}", &decoder_signature, key_id, LIMIT)
            .unwrap();
        assert_eq!(decoder.signer_key_id(), "d4-test-only-decoder");
        assert_eq!(decoder.key_id(), key_id);
    }
}

#[test]
fn rotation_tries_all_locally_configured_policy_candidates() {
    // Reuse the two fixture points with the same role; no new keys are generated.
    let mut stale = key("decoder", KeyRole::Policy);
    stale.key_id = "stale-policy".into();
    let mut active = key("policy", KeyRole::Policy);
    active.key_id = "active-policy".into();
    let trusted = TrustedKeys::new(&[stale, active]).unwrap();
    let verified = verify_policy(
        &trusted,
        BASE.as_bytes(),
        &encoded_signature("policy", BASE.as_bytes()),
        Some("stale-policy"),
    )
    .unwrap();
    assert_eq!(verified.signer_key_id(), "active-policy");
    // Decoder-role keys are optional in config, but their absence grants no
    // fallback to Policy-role keys even when that public point is configured.
    assert_kind(
        trusted
            .verify_decoder_bundle(b"{}", &encoded_signature("decoder", b"{}"), None, LIMIT)
            .unwrap_err(),
        SignatureErrorKind::InvalidSignature,
    );
}

#[test]
fn invalid_local_key_layouts_fail_configuration() {
    let policy = key("policy", KeyRole::Policy);
    let decoder = key("decoder", KeyRole::Decoder);
    let mut empty_id = policy.clone();
    empty_id.key_id.clear();
    let mut duplicate_id = decoder.clone();
    duplicate_id.key_id.clone_from(&policy.key_id);
    let mut cross_role = policy.clone();
    cross_role.key_id = "same-point-different-role".into();
    cross_role.role = KeyRole::Decoder;

    // The same P-256 point in compressed SPKI remains the same trust identity.
    let mut compressed_cross_role = cross_role.clone();
    let mut compressed_der =
        hex::decode("3039301306072a8648ce3d020106082a8648ce3d030107032200").unwrap();
    compressed_der.extend_from_slice(
        signing_key("policy")
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes(),
    );
    compressed_cross_role.public_key_spki_base64 = STANDARD.encode(compressed_der);
    TrustedKeys::new(&[VerificationKey {
        role: KeyRole::Policy,
        ..compressed_cross_role.clone()
    }])
    .unwrap();
    for config in [
        vec![],
        vec![decoder],
        vec![empty_id],
        vec![policy.clone(), duplicate_id],
        vec![policy.clone(), cross_role],
        vec![policy, compressed_cross_role],
    ] {
        assert_kind(
            TrustedKeys::new(&config).unwrap_err(),
            SignatureErrorKind::InvalidConfig,
        );
    }
}

#[test]
fn invalid_base64_der_and_non_p256_spki_fail_configuration() {
    // A valid P-384 public point from ring's ecdsa_verify_tests.txt, wrapped in
    // secp384r1 SPKI. Rejection must enforce P-256, not merely a valid EC key.
    let p384_spki = hex::decode(concat!(
        "3076301006072a8648ce3d020106052b8104002203620004",
        "0874a2e0b8ff448f0e54321e27f4f1e64d064cdeb7d26f458c32e930120f4e57dc85c2693f977eed4a8ecc8db981b4d9",
        "1f69446df4f4c6f5de19003f45f891d0ebcd2fffdb5c81c040e8d6994c43c7feedb98a4a31edfb35e89a30013c3b9267"
    ))
    .unwrap();
    for malformed in [
        "%%%".to_owned(),
        STANDARD.encode([0x30, 0]),
        STANDARD.encode(p384_spki),
    ] {
        let mut invalid = key("decoder", KeyRole::Decoder);
        invalid.public_key_spki_base64 = malformed;
        // A valid Policy key cannot cause a bad optional Decoder key to be skipped.
        assert_kind(
            TrustedKeys::new(&[key("policy", KeyRole::Policy), invalid]).unwrap_err(),
            SignatureErrorKind::InvalidConfig,
        );
    }
}

#[test]
fn decoder_jcs_matches_independent_fixed_canonical_strings() {
    let trusted = trust();
    for (wire, canonical) in [
        (r#" { "z":2, "a": 1 } "#, r#"{"a":1,"z":2}"#),
        (
            r#"{"value":4.2e1,"tiny":1e-7,"decimal":0.1}"#,
            r#"{"decimal":0.1,"tiny":1e-7,"value":42}"#,
        ),
        (
            r#"{"\ue000":1,"\ud83d\ude00":2,"a":0}"#,
            "{\"a\":0,\"😀\":2,\"\u{e000}\":1}",
        ),
    ] {
        // Expected strings are literal JCS vectors, never generated with the
        // canonicalizer under test. The last case pins UTF-16 key ordering.
        let verified = trusted
            .verify_decoder_bundle(
                wire.as_bytes(),
                &encoded_signature("decoder", canonical.as_bytes()),
                None,
                LIMIT,
            )
            .unwrap();
        assert_eq!(verified.canonical_bytes(), canonical.as_bytes());
        assert_eq!(
            verified.bundle(),
            &serde_json::from_str::<Value>(canonical).unwrap()
        );
        assert_eq!(verified.signer_key_id(), "d4-test-only-decoder");
    }
}

#[test]
fn decoder_signatures_bind_jcs_rather_than_received_formatting() {
    let trusted = trust();
    let wire = br#" { "z":2, "a": 1 } "#;
    let canonical = br#"{"a":1,"z":2}"#;
    assert_kind(
        trusted
            .verify_decoder_bundle(wire, &encoded_signature("decoder", wire), None, LIMIT)
            .unwrap_err(),
        SignatureErrorKind::InvalidSignature,
    );
    let signature = encoded_signature("decoder", canonical);
    for received in [wire.as_slice(), canonical.as_slice()] {
        assert_eq!(
            trusted
                .verify_decoder_bundle(received, &signature, None, LIMIT)
                .unwrap()
                .canonical_bytes(),
            canonical
        );
    }
}

#[test]
fn decoder_parse_and_resource_guards_precede_authentication() {
    let trusted = trust();
    let signature = encoded_signature("decoder", b"{}");
    let malformed: &[&[u8]] = &[
        br#"{"a":1,"a":2}"#,
        br#"{"outer":{"x":1,"\u0078":2}}"#,
        br#"{"value":9007199254740992}"#,
        br#"{"value":1.0000000000000001}"#,
        b"{}{}",
        b"{\"x\":\"\xff\"}",
        b"[]",
    ];
    for raw in malformed {
        assert_kind(
            trusted
                .verify_decoder_bundle(raw, &signature, None, LIMIT)
                .unwrap_err(),
            SignatureErrorKind::InvalidDecoderSnapshot,
        );
    }
    let too_deep = format!("{}0{}", "{\"x\":".repeat(129), "}".repeat(129));
    assert_kind(
        trusted
            .verify_decoder_bundle(too_deep.as_bytes(), &signature, None, LIMIT)
            .unwrap_err(),
        SignatureErrorKind::LimitExceeded,
    );
    let wire = b"  {}\n";
    trusted
        .verify_decoder_bundle(wire, &signature, None, wire.len())
        .unwrap();
    for (limit, kind) in [
        (wire.len() - 1, SignatureErrorKind::LimitExceeded),
        (0, SignatureErrorKind::InvalidConfig),
    ] {
        assert_kind(
            trusted
                .verify_decoder_bundle(wire, &signature, None, limit)
                .unwrap_err(),
            kind,
        );
    }
}

#[test]
fn authenticated_bytes_still_require_later_semantic_validation() {
    let trusted = trust();
    let mut payload: Value = serde_json::from_str(BASE).unwrap();
    payload["issued_at"] = json!(100);
    payload["expires_at"] = json!(1);
    payload["env"] = json!("production");
    payload["profile"] = json!("unconfigured-profile");
    payload["registry_ref"] = json!("not-a-registry-digest");
    payload["policies"][0]["manifest"]["id"] = json!("different-manifest-id");
    payload["policies"][0]["policy"] = json!("not valid Cedar");
    let duplicate = payload["policies"][0].clone();
    payload["policies"].as_array_mut().unwrap().push(duplicate);
    let raw = payload.to_string();
    let verified = verify_policy(
        &trusted,
        raw.as_bytes(),
        &encoded_signature("policy", raw.as_bytes()),
        Some("untrusted-telemetry"),
    )
    .unwrap();
    assert_eq!(verified.parsed().payload(), &payload);

    // A signed JSON object is not yet an installable Decoder bundle.
    let decoder = br#"{"schema_version":"unsupported"}"#;
    assert_eq!(
        trusted
            .verify_decoder_bundle(decoder, &encoded_signature("decoder", decoder), None, LIMIT)
            .unwrap()
            .canonical_bytes(),
        decoder
    );
}
