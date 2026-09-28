//! Per-instance decoder state, using small manifests without Registry builds.

use dambi_core::decode::DecoderRegistry;
use serde_json::{json, Value};

const CONTRACT: &str = "0x0000000000000000000000000000000000001111";
const SUBMITTER: &str = "0x000000000000000000000000000000000000aaaa";
const MARKER_A: &str = "0x000000000000000000000000000000000000a001";
const MARKER_B: &str = "0x000000000000000000000000000000000000b002";
const APPROVE: &str = "0x095ea7b3";

fn unknown_emit(marker: &str) -> Value {
    json!({
        "strategy": "single_emit",
        "body": {
            "domain": "unknown",
            "unknown": {
                "target": marker,
                "chain": "$chain",
                "calldata": "$calldata",
                "value": "$tx.value"
            }
        }
    })
}

fn approve_bundle(id: &str, marker: &str) -> Value {
    json!({
        "type": "adapter_action",
        "id": id,
        "schema_version": "3",
        "match": {
            "selector": APPROVE,
            "chain_to_addresses": { "1": [CONTRACT] }
        },
        "abi_fragment": {
            "function_name": "approve",
            "abi": {
                "type": "function",
                "name": "approve",
                "stateMutability": "nonpayable",
                "inputs": [
                    { "name": "spender", "type": "address" },
                    { "name": "amount", "type": "uint256" }
                ],
                "outputs": [{ "name": "", "type": "bool" }]
            }
        },
        "emit": unknown_emit(marker)
    })
}

fn approve_calldata() -> String {
    format!("{APPROVE}{:0>64}{:064x}", &SUBMITTER[2..], 7_u64)
}

fn request(selector: &str, calldata: &str) -> String {
    json!({
        "chain_id": 1,
        "to": CONTRACT,
        "selector": selector,
        "calldata": calldata,
        "submitter": SUBMITTER,
        "submitted_at": 1_700_000_000_u64
    })
    .to_string()
}

fn install(registry: &mut DecoderRegistry, bundle: Value) {
    let installed = registry.install(&bundle.to_string()).unwrap();
    assert_eq!(installed.bundle_id, bundle["id"].as_str().unwrap());
    assert_eq!(installed.decoder_id, installed.bundle_id);
}

fn routed(registry: &DecoderRegistry, input: &str) -> Value {
    serde_json::to_value(registry.route_request(input).unwrap()).unwrap()
}

fn assert_exact(registry: &DecoderRegistry, id: &str, marker: &str) {
    let result = routed(registry, &request(APPROVE, &approve_calldata()));
    assert_eq!(result["decoder_id"], id);
    assert_eq!(result["actions"][0]["body"]["target"], marker);
}

#[test]
fn exact_routes_reinstall_failure_clear_and_drop_are_instance_local() {
    let mut first = DecoderRegistry::default();
    let mut second = DecoderRegistry::default();
    install(&mut first, approve_bundle("test/first@1.0.0", MARKER_A));
    install(&mut second, approve_bundle("test/second@1.0.0", MARKER_B));
    assert_exact(&first, "test/first@1.0.0", MARKER_A);
    assert_exact(&second, "test/second@1.0.0", MARKER_B);

    // The same call key selects the latest successful installation locally.
    install(&mut first, approve_bundle("test/first@2.0.0", MARKER_A));
    assert_exact(&first, "test/first@2.0.0", MARKER_A);
    assert_exact(&second, "test/second@1.0.0", MARKER_B);

    // Rejected replacement has the current ID and call key. It must not change
    // either the bridge or the stored bundle before returning its error.
    let mut invalid = approve_bundle("test/first@2.0.0", MARKER_B);
    invalid["match"]["address_agnostic"] = json!(true);
    // Valid JSON plus whitespace remains parseable, so only the 4 MiB input
    // bound prevents this oversized replacement from becoming active.
    let oversized = format!(
        "{}{}",
        approve_bundle("test/first@2.0.0", MARKER_B),
        " ".repeat(4 * 1024 * 1024)
    );
    for (input, kind) in [
        ("{not json".to_owned(), "invalid_bundle_json"),
        (invalid.to_string(), "agnostic_selector_not_allowed"),
        (oversized, "input_too_large"),
    ] {
        assert_eq!(first.install(&input).unwrap_err().kind, kind);
        assert_exact(&first, "test/first@2.0.0", MARKER_A);
        assert_exact(&second, "test/second@1.0.0", MARKER_B);
    }

    first.clear();
    assert_eq!(
        first
            .route_request(&request(APPROVE, &approve_calldata()))
            .unwrap_err()
            .kind,
        "no_declarative_v3_mapper"
    );
    assert_exact(&second, "test/second@1.0.0", MARKER_B);
    install(&mut first, approve_bundle("test/first@3.0.0", MARKER_A));
    drop(first);
    assert_exact(&second, "test/second@1.0.0", MARKER_B);
}

#[test]
fn address_agnostic_fallback_and_clear_are_instance_local() {
    let make_bundle = |id: &str, marker: &str| {
        let mut bundle = approve_bundle(id, marker);
        bundle["match"] = json!({
            "selector": "0xa22cb465",
            "address_agnostic": true,
            "chain_ids": [1]
        });
        bundle["abi_fragment"] = json!({
            "function_name": "setApprovalForAll",
            "abi": {
                "type": "function",
                "name": "setApprovalForAll",
                "inputs": [
                    { "name": "operator", "type": "address" },
                    { "name": "approved", "type": "bool" }
                ],
                "outputs": []
            }
        });
        bundle
    };
    let input = request(
        "0xa22cb465",
        &format!("0xa22cb465{:0>64}{:064x}", &SUBMITTER[2..], 1_u64),
    );
    let mut first = DecoderRegistry::default();
    let mut second = DecoderRegistry::default();
    install(&mut first, make_bundle("test/agnostic-a@1.0.0", MARKER_A));
    install(&mut second, make_bundle("test/agnostic-b@1.0.0", MARKER_B));
    assert_eq!(
        routed(&first, &input)["decoder_id"],
        "test/agnostic-a@1.0.0"
    );
    assert_eq!(
        routed(&second, &input)["decoder_id"],
        "test/agnostic-b@1.0.0"
    );

    first.clear();
    assert_eq!(
        first.route_request(&input).unwrap_err().kind,
        "no_declarative_v3_mapper"
    );
    assert_eq!(
        routed(&second, &input)["decoder_id"],
        "test/agnostic-b@1.0.0"
    );
}

#[test]
fn typed_v3_and_strict_v4_lookup_use_their_own_registry() {
    let make_bundle = |id: &str, marker: &str| {
        let mut bundle = approve_bundle(id, marker);
        bundle["match"]["typed_data"] = json!({
            "domain_name": "Isolation test",
            "verifying_contract": CONTRACT,
            "primary_type": "Probe",
            "types": { "Probe": [{ "name": "amount", "type": "uint256" }] }
        });
        bundle
    };
    let legacy_input = json!({
        "chain_id": 1,
        "verifying_contract": CONTRACT,
        "primary_type": "Probe",
        "domain_name": "Isolation test",
        "message": { "amount": "7" },
        "submitter": SUBMITTER,
        "submitted_at": 1_700_000_000_u64
    })
    .to_string();
    let strict_input = json!({
        "typed_data": {
            "domain": {
                "name": "Isolation test",
                "chainId": 1,
                "verifyingContract": CONTRACT
            },
            "types": { "Probe": [{ "name": "amount", "type": "uint256" }] },
            "primaryType": "Probe",
            "message": { "amount": "7" }
        },
        "requested_signer": SUBMITTER,
        "submitted_at": 1_700_000_000_u64
    })
    .to_string();
    let mut first = DecoderRegistry::default();
    let mut second = DecoderRegistry::default();
    install(&mut first, make_bundle("test/typed-a@1.0.0", MARKER_A));
    install(&mut second, make_bundle("test/typed-b@1.0.0", MARKER_B));
    assert_eq!(
        first.route_typed_data_v3(&legacy_input).unwrap().decoder_id,
        "test/typed-a@1.0.0"
    );
    assert_eq!(
        second
            .route_typed_data_v3(&legacy_input)
            .unwrap()
            .decoder_id,
        "test/typed-b@1.0.0"
    );
    // The synthetic contract is deliberately outside strict Permit support.
    // A local hit remains unsupported; it must not turn into a lookup miss.
    assert_eq!(
        first.route_typed_data_v4(&strict_input).unwrap_err().kind,
        "unsupported_typed_data_contract"
    );

    first.clear();
    assert_eq!(
        first.route_typed_data_v3(&legacy_input).unwrap_err().kind,
        "no_typed_data_mapper"
    );
    assert_eq!(
        first.route_typed_data_v4(&strict_input).unwrap_err().kind,
        "no_typed_data_mapper"
    );
    assert_eq!(
        second
            .route_typed_data_v3(&legacy_input)
            .unwrap()
            .decoder_id,
        "test/typed-b@1.0.0"
    );
    assert_eq!(
        second.route_typed_data_v4(&strict_input).unwrap_err().kind,
        "unsupported_typed_data_contract"
    );
}

#[test]
fn multicall_child_reentry_keeps_the_outer_registry() {
    let mut outer = approve_bundle("test/multicall@1.0.0", MARKER_A);
    outer["match"]["selector"] = json!("0xac9650d8");
    outer["abi_fragment"] = json!({
        "function_name": "multicall",
        "abi": {
            "type": "function",
            "name": "multicall",
            "inputs": [{ "name": "data", "type": "bytes[]" }],
            "outputs": []
        }
    });
    outer["emit"] = json!({
        "strategy": "multicall_recurse",
        "recurse_rule_id": "self_array_bytes_last_arg",
        "recurse_arg": "data",
        "max_depth": 3
    });

    // ABI: outer argument offset, array length, element offset, byte length,
    // followed by one approve call padded to the next 32-byte boundary.
    let child = approve_calldata();
    let child_hex = &child[2..];
    let child_padded = format!(
        "{child_hex:0<width$}",
        width = child_hex.len().div_ceil(64) * 64
    );
    let calldata = format!(
        "0xac9650d8{:064x}{:064x}{:064x}{:064x}{child_padded}",
        32_u64,
        1_u64,
        32_u64,
        child_hex.len() / 2
    );
    let input = request("0xac9650d8", &calldata);
    let mut first = DecoderRegistry::default();
    let mut second = DecoderRegistry::default();
    install(&mut first, outer.clone());
    install(&mut second, outer);
    install(&mut first, approve_bundle("test/child-a@1.0.0", MARKER_A));
    install(&mut second, approve_bundle("test/child-b@1.0.0", MARKER_B));

    for (registry, marker) in [(&first, MARKER_A), (&second, MARKER_B)] {
        let result = routed(registry, &input);
        let body = &result["actions"][0]["body"];
        assert_eq!(result["decoder_id"], "test/multicall@1.0.0");
        assert_eq!(body["domain"], "multicall");
        let children = body["actions"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["target"], marker);
        assert_eq!(children[0]["calldata"], child);
    }
}
