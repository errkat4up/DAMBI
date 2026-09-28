//! Decoder trust and installation gates are exercised through Store creation.

#[path = "support/snapshot.rs"]
mod support;

use dambi_core::snapshot::{DecoderInput, DecoderTrust, SnapshotStore};
use serde_json::{json, Value};
use std::sync::Arc;
use support::*;

#[test]
fn pinned_container_installs_the_resolved_bundle_and_records_both_identities() {
    let bundle = approve_bundle();
    let bundle_digest = digest(&canonical(&bundle));
    let artifact = artifact(vec![bundle]);
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let snapshot = store.current(NOW).unwrap();
    assert_eq!(snapshot.decoder().digest(), artifact.digest);
    assert_eq!(snapshot.decoder().bundle_ids(), &[BUNDLE_ID.to_owned()]);
    assert_eq!(snapshot.decoder().bundle_digests(), &[bundle_digest]);
    assert_eq!(snapshot.decoder().trust(), &DecoderTrust::PinnedArtifact);
    assert_approve(&snapshot, CONTRACT, BUNDLE_ID);
}

#[test]
fn pinned_hash_binds_exact_container_bytes_while_bundle_hash_uses_jcs() {
    let original = artifact(vec![approve_bundle()]);
    let mut reformatted = original.bytes.clone();
    reformatted.push(b'\n');
    expect_code(
        SnapshotStore::new(
            config(),
            DecoderInput::Pinned {
                artifact: &reformatted,
                expected_digest: &original.digest,
            },
            day1().input(),
            NOW,
        ),
        "DECODER_INTEGRITY_MISMATCH",
    );
    let first_store = SnapshotStore::new(config(), original.input(), day1().input(), NOW).unwrap();
    let reformatted = artifact_bytes(reformatted);
    let second_store =
        SnapshotStore::new(config(), reformatted.input(), day1().input(), NOW).unwrap();
    let first = first_store.current(NOW).unwrap();
    let second = second_store.current(NOW).unwrap();
    assert_ne!(first.decoder().digest(), second.decoder().digest());
    assert_eq!(
        first.decoder().bundle_digests(),
        second.decoder().bundle_digests()
    );
    assert_approve(&second, CONTRACT, BUNDLE_ID);
}

#[test]
fn strict_container_json_and_schema_are_checked_even_with_a_matching_pin() {
    let valid = artifact(vec![approve_bundle()]);
    let raw = String::from_utf8(valid.bytes).unwrap();
    let duplicate_root = raw.replacen(
        "\"schema_version\":1",
        "\"schema_version\":1,\"schema_version\":1",
        1,
    );
    let duplicate_bundle = raw.replacen(
        "\"schema_version\":\"3\"",
        "\"schema_version\":\"3\",\"schema_version\":\"3\"",
        1,
    );
    assert_ne!(duplicate_root, raw);
    assert_ne!(duplicate_bundle, raw);
    for malformed in [
        b"{".to_vec(),
        vec![0xff],
        duplicate_root.into_bytes(),
        duplicate_bundle.into_bytes(),
        br#"{"schema_version":2,"bundles":[]}"#.to_vec(),
        br#"{"schema_version":"1","bundles":[]}"#.to_vec(),
        br#"{"schema_version":1,"bundles":[]}"#.to_vec(),
        br#"{"schema_version":1,"bundles":[null]}"#.to_vec(),
    ] {
        let artifact = artifact_bytes(malformed);
        expect_code(
            SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
            "INVALID_DECODER_SNAPSHOT",
        );
    }
}

#[test]
fn unresolved_sources_and_unsupported_bundle_shapes_are_rejected() {
    let mut unresolved = approve_bundle();
    unresolved["match"]
        .as_object_mut()
        .unwrap()
        .remove("chain_to_addresses");
    unresolved["match"]["chain_to_addresses_source"] = json!("tokens:erc20");
    unresolved["match"]["chain_ids"] = json!([1]);
    let mut wrong_version = approve_bundle();
    wrong_version["schema_version"] = json!("999");
    let mut wrong_type = approve_bundle();
    wrong_type["type"] = json!("adapter_context");
    let mut malformed_route = approve_bundle();
    malformed_route["match"]["chain_to_addresses"] = json!({"1":["not-an-address"]});
    for bundle in [unresolved, wrong_version, wrong_type, malformed_route] {
        let artifact = artifact(vec![bundle]);
        expect_code(
            SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
            "INVALID_DECODER_SNAPSHOT",
        );
    }
    for (pointer, replacement) in [
        ("/abi_fragment/function_name", json!("differentFunction")),
        ("/match/selector", json!("0xdeadbeef")),
        ("/emit", json!({"strategy":"single_emit"})),
        ("/emit/strategy", json!("unknown_emit_strategy")),
        (
            "/emit",
            json!({"strategy":"tagged_dispatch","bytes_source":"$args.data","tag_size":9,"per_action_body":{}}),
        ),
        (
            "/emit/body/token/erc20_approve/amount",
            json!({"$fn":"unsupported_function","$args":[]}),
        ),
        ("/requires/imperative", json!(["unavailable-decoder@^1.0"])),
    ] {
        let mut bundle = approve_bundle();
        *bundle.pointer_mut(pointer).unwrap() = replacement;
        let artifact = artifact(vec![bundle]);
        expect_code(
            SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
            "INVALID_DECODER_SNAPSHOT",
        );
    }
}

#[test]
fn resolved_typed_fixture_and_synthetic_colon_type_route_without_abi_selector_equality() {
    let permit: Value =
        serde_json::from_str(include_str!("fixtures/erc20-permit.manifest.json")).unwrap();
    let strict_request = include_str!("fixtures/typed-permit-numeric-request.json");
    let actual = SnapshotStore::new(
        config(),
        artifact(vec![permit.clone()]).input(),
        day1().input(),
        NOW,
    )
    .unwrap();
    let strict = actual
        .current(NOW)
        .unwrap()
        .decoder()
        .registry()
        .route_typed_data_v4(strict_request)
        .unwrap();
    assert_eq!(strict.decoder_id, "standard/erc20/permit@1.0.0");

    // This is a synthetic boundary probe, not a Hyperliquid product fixture.
    // Off-chain primary types may contain ':' and their selector is synthetic.
    let primary_type = "SyntheticNamespace:PermitProbe";
    let mut synthetic = permit.clone();
    synthetic["id"] = json!("test/synthetic-typed-permit@1");
    synthetic["match"]["selector"] = json!("0x0000000b");
    let fields = synthetic["match"]["typed_data"]["types"]
        .as_object_mut()
        .unwrap()
        .remove("Permit")
        .unwrap();
    synthetic["match"]["typed_data"]["types"] = json!({primary_type: fields});
    synthetic["match"]["typed_data"]["primary_type"] = json!(primary_type);
    let synthetic_store = SnapshotStore::new(
        config(),
        artifact(vec![synthetic]).input(),
        day1().input(),
        NOW,
    )
    .unwrap();
    let request: Value = serde_json::from_str(strict_request).unwrap();
    let input = json!({
        "chain_id": 1,
        "verifying_contract": permit["match"]["typed_data"]["verifying_contract"],
        "primary_type": primary_type,
        "domain_name": "USD Coin",
        "message": request["typed_data"]["message"],
        "submitter": request["requested_signer"],
        "submitted_at": request["submitted_at"]
    })
    .to_string();
    let routed = synthetic_store
        .current(NOW)
        .unwrap()
        .decoder()
        .registry()
        .route_typed_data_v3(&input)
        .unwrap();
    assert_eq!(routed.decoder_id, "test/synthetic-typed-permit@1");
    let routed = serde_json::to_value(routed).unwrap();
    assert_eq!(routed["actions"][0]["body"]["action"], "erc20_permit");
    assert_eq!(routed["actions"][0]["body"]["amount"], "0xf4240");

    // Distinct IDs and calldata selectors cannot hide a competing typed route.
    let mut duplicate_typed = permit.clone();
    duplicate_typed["id"] = json!("test/duplicate-typed@1");
    duplicate_typed["match"]["selector"] = json!("0x0000000c");
    expect_code(
        SnapshotStore::new(
            config(),
            artifact(vec![permit, duplicate_typed]).input(),
            day1().input(),
            NOW,
        ),
        "INVALID_DECODER_SNAPSHOT",
    );
}

fn approval_for_all(id: &str, agnostic: bool) -> Value {
    let mut bundle = approve_bundle();
    bundle["id"] = json!(id);
    bundle["match"] = if agnostic {
        json!({"selector":"0xa22cb465","address_agnostic":true,"chain_ids":[1]})
    } else {
        json!({"selector":"0xa22cb465","chain_to_addresses":{"1":[CONTRACT]}})
    };
    bundle["abi_fragment"] = json!({
        "function_name":"setApprovalForAll",
        "abi":{
            "type":"function","name":"setApprovalForAll","stateMutability":"nonpayable",
            "inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],
            "outputs":[]
        }
    });
    bundle["emit"] = json!({
        "strategy":"single_emit",
        "body":{
            "domain":"unknown",
            "unknown":{"target":"$to","chain":"$chain","calldata":"$calldata","value":"$tx.value"}
        }
    });
    bundle
}

#[test]
fn exact_routes_precede_agnostic_fallback_in_both_orders_and_same_tier_duplicates_fail() {
    let exact = approval_for_all("test/exact-approval@1", false);
    let fallback = approval_for_all("test/agnostic-approval@1", true);
    for bundles in [
        vec![exact.clone(), fallback.clone()],
        vec![fallback.clone(), exact.clone()],
    ] {
        let store =
            SnapshotStore::new(config(), artifact(bundles).input(), day1().input(), NOW).unwrap();
        let snapshot = store.current(NOW).unwrap();
        for (target, expected_id) in [
            (CONTRACT, "test/exact-approval@1"),
            (SECOND_CONTRACT, "test/agnostic-approval@1"),
        ] {
            let mut input: Value = serde_json::from_str(&approve_request(target)).unwrap();
            input["selector"] = json!("0xa22cb465");
            input["calldata"] = json!(format!(
                "0xa22cb465{:0>64}{:064x}",
                &SECOND_CONTRACT[2..],
                1_u64
            ));
            let routed = snapshot
                .decoder()
                .registry()
                .route_request(&input.to_string())
                .unwrap();
            assert_eq!(routed.decoder_id, expected_id);
        }
    }
    let duplicate = approval_for_all("test/duplicate-agnostic@1", true);
    expect_code(
        SnapshotStore::new(
            config(),
            artifact(vec![fallback, duplicate]).input(),
            day1().input(),
            NOW,
        ),
        "INVALID_DECODER_SNAPSHOT",
    );
}

#[test]
fn compact_routing_counts_and_strings_are_bounded_before_materialization() {
    let mut bundle = approve_bundle();
    let chains: Vec<u64> = (1..=257).collect();
    let addresses: Vec<String> = (1..=256).map(|index| format!("0x{index:040x}")).collect();
    bundle["match"] = json!({
        "selector":"0x095ea7b3",
        "chain_ids":chains,
        "to":addresses
    });
    let artifact = artifact(vec![bundle]);
    assert!(artifact.bytes.len() < 20_000);
    // 257 * 256 = 65,792 routes, exceeding the 65,536 installation budget.
    expect_code(
        SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
        "LIMIT_EXCEEDED",
    );

    // Even a modest route count can amplify a long ID beyond the 32 MiB
    // routing-string budget. Reject before cloning the ID into every route.
    let mut long_id = approve_bundle();
    long_id["id"] = json!("x".repeat(4096));
    long_id["match"] = json!({
        "selector":"0x095ea7b3",
        "chain_ids":(1..=8193).collect::<Vec<u64>>(),
        "to":[CONTRACT]
    });
    let artifact = support::artifact(vec![long_id]);
    assert!(artifact.bytes.len() < 100_000);
    expect_code(
        SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
        "LIMIT_EXCEEDED",
    );
}

#[test]
fn duplicate_bundle_ids_or_routes_cannot_silently_overwrite_an_installation() {
    let first = approve_bundle();
    let mut same_id_different_route = first.clone();
    same_id_different_route["match"]["chain_to_addresses"] = json!({"1":[SECOND_CONTRACT]});
    let mut different_id_same_route = first.clone();
    different_id_same_route["id"] = json!("test/other-approve@1");
    for conflicting in [same_id_different_route, different_id_same_route] {
        let artifact = artifact(vec![first.clone(), conflicting]);
        expect_code(
            SnapshotStore::new(config(), artifact.input(), day1().input(), NOW),
            "INVALID_DECODER_SNAPSHOT",
        );
    }
}

#[test]
fn store_byte_limits_bound_the_actual_input_and_reject_zero_configuration() {
    let artifact = artifact(vec![approve_bundle()]);
    let policy = day1();
    let mut exact = config();
    exact.max_decoder_bytes = artifact.bytes.len();
    exact.max_policy_bytes = policy.payload.len();
    SnapshotStore::new(exact.clone(), artifact.input(), policy.input(), NOW).unwrap();
    for decoder_limit in [true, false] {
        let mut too_small = exact.clone();
        if decoder_limit {
            too_small.max_decoder_bytes -= 1;
        } else {
            too_small.max_policy_bytes -= 1;
        }
        expect_code(
            SnapshotStore::new(too_small, artifact.input(), policy.input(), NOW),
            "LIMIT_EXCEEDED",
        );
        let mut invalid = config();
        if decoder_limit {
            invalid.max_decoder_bytes = 0;
        } else {
            invalid.max_policy_bytes = 0;
        }
        expect_code(
            SnapshotStore::new(invalid, artifact.input(), policy.input(), NOW),
            "INVALID_CONFIG",
        );
    }
}

#[test]
fn failed_multi_bundle_or_policy_initialization_cannot_leak_a_partial_registry() {
    let active = store();
    let old = active.current(NOW).unwrap();
    let mut valid_new = approve_bundle();
    valid_new["id"] = json!("test/new-approve@1");
    valid_new["match"]["chain_to_addresses"] = json!({"1":[SECOND_CONTRACT]});
    let mut invalid_second = approve_bundle();
    invalid_second["id"] = json!("test/broken-approve@1");
    invalid_second["match"]["chain_to_addresses"] =
        json!({"1":["0x3333333333333333333333333333333333333333"]});
    invalid_second["abi_fragment"] = Value::Null;
    let partial = artifact(vec![valid_new.clone(), invalid_second]);
    expect_code(
        SnapshotStore::new(config(), partial.input(), day1().input(), NOW),
        "INVALID_DECODER_SNAPSHOT",
    );
    let mut invalid_policy = policy_value(43);
    invalid_policy["policies"][0]["policy"] = json!("not Cedar");
    let invalid_policy = signed_policy(invalid_policy);
    let complete = artifact(vec![valid_new]);
    expect_code(
        SnapshotStore::new(config(), complete.input(), invalid_policy.input(), NOW),
        "INVALID_POLICY_BUNDLE",
    );
    assert!(Arc::ptr_eq(&old, &active.current(NOW).unwrap()));
    assert_approve(&old, CONTRACT, BUNDLE_ID);
    assert!(old
        .decoder()
        .registry()
        .route_request(&approve_request(SECOND_CONTRACT))
        .is_err());
    let independent = SnapshotStore::new(config(), complete.input(), day1().input(), NOW).unwrap();
    assert_approve(
        &independent.current(NOW).unwrap(),
        SECOND_CONTRACT,
        "test/new-approve@1",
    );
    assert!(independent
        .current(NOW)
        .unwrap()
        .decoder()
        .registry()
        .route_request(&approve_request(CONTRACT))
        .is_err());
}

#[test]
fn external_bundle_requires_decoder_role_signature_and_requested_jcs_digest() {
    let bundle = approve_bundle();
    let canonical = canonical(&bundle);
    let expected = digest(&canonical);
    let signature = sign("decoder", &canonical);
    let pretty = serde_json::to_vec_pretty(&bundle).unwrap();
    for wire in [&canonical[..], &pretty[..]] {
        let store = SnapshotStore::new(
            config(),
            DecoderInput::SignedBundle {
                bundle: wire,
                signature: &signature,
                key_id: Some("untrusted-response-key-id"),
                expected_bundle_digest: &expected,
            },
            day1().input(),
            NOW,
        )
        .unwrap();
        let snapshot = store.current(NOW).unwrap();
        assert_eq!(snapshot.decoder().digest(), expected);
        assert_eq!(
            snapshot.decoder().bundle_digests(),
            std::slice::from_ref(&expected)
        );
        assert_eq!(
            snapshot.decoder().trust(),
            &DecoderTrust::SignedBundle {
                signer_key_id: "d4-test-only-decoder".into()
            }
        );
        assert_approve(&snapshot, CONTRACT, BUNDLE_ID);
    }
    let wrong_role = sign("policy", &canonical);
    expect_code(
        SnapshotStore::new(
            config(),
            DecoderInput::SignedBundle {
                bundle: &canonical,
                signature: &wrong_role,
                key_id: Some("d4-test-only-decoder"),
                expected_bundle_digest: &expected,
            },
            day1().input(),
            NOW,
        ),
        "INVALID_SIGNATURE",
    );
    let mut different_valid_bundle = bundle;
    different_valid_bundle["requires"]["extension"] = json!(">=0.2.0");
    let different = support::canonical(&different_valid_bundle);
    let different_signature = sign("decoder", &different);
    // A valid issuer signature does not authorize substitution for another
    // requested bundle digest. The zero-digest case also pins direct mismatch.
    for (bytes, signature, requested) in [
        (&canonical[..], signature.as_str(), ZERO_DIGEST),
        (
            &different[..],
            different_signature.as_str(),
            expected.as_str(),
        ),
    ] {
        expect_code(
            SnapshotStore::new(
                config(),
                DecoderInput::SignedBundle {
                    bundle: bytes,
                    signature,
                    key_id: None,
                    expected_bundle_digest: requested,
                },
                day1().input(),
                NOW,
            ),
            "DECODER_INTEGRITY_MISMATCH",
        );
    }
}
