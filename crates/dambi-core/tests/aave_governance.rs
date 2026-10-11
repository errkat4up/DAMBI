//! Original Aave governance manifests through pinned installation and raw ABI.
//! Day1 has no governance-specific policy; an evaluated allow below confirms
//! the ordinary no-matching-policy path, not proposal or representative safety.

#[path = "support/snapshot.rs"]
mod support;

use alloy_dyn_abi::{DynSolValue, JsonAbiExt};
use alloy_json_abi::Function;
use alloy_primitives::U256;
use dambi_core::{session::CoreSession, snapshot::SnapshotStore};
use serde_json::{json, Value};
use support::{artifact, config, day1, Artifact, NOW};

const MANIFESTS: [&str; 2] = [
    include_str!("../../../registryV2/manifests/aave/governance/core-redeemCancellationFee@1.0.0.json"),
    include_str!(
        "../../../registryV2/manifests/aave/governance/core-updateRepresentativesForChain@1.0.0.json"
    ),
];
const GOVERNANCE: &str = "0x9aee0b04504cef83a65ac3f0e838d0593bcb2bc7";
const SENDER: &str = "0x000000000000000000000000000000000000aaaa";
const OTHER: &str = "0x000000000000000000000000000000000000bbbb";

fn manifests() -> Vec<Value> {
    MANIFESTS
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect()
}

fn session(artifact: &Artifact) -> CoreSession {
    let keys: Value =
        serde_json::from_str(include_str!("fixtures/policy-bundle/test-only-keys.json")).unwrap();
    let config = json!({
        "decoderSnapshot": {
            "artifact": String::from_utf8(artifact.bytes.clone()).unwrap(),
            "expectedDigest": artifact.digest
        },
        "trust": { "env":"staging", "profile":"default", "keys":[{
            "keyId":keys["policy"]["key_id"], "role":"policy",
            "publicKeySpkiBase64":keys["policy"]["public_key_spki_b64"]
        }] },
        "enforcement":"advisory",
        "limits": {
            "allowedClockSkewMs":5000,"maxPolicyBytes":1000000,"maxDecoderBytes":1000000,
            "maxRequestBytes":100000,"maxFactBytes":100000,"maxPlanCalls":32,
            "planTtlMs":10000,"maxPendingPlans":8,"maxFactAgeMs":1000,
            "factTimeoutMs":1000,"policyTimeoutMs":1000
        }
    });
    let policy = day1();
    let wire = json!({
        "payload":String::from_utf8(policy.payload).unwrap(),
        "signature":policy.signature,
        "keyId":policy.key_id.unwrap()
    });
    CoreSession::new(&config.to_string(), &wire.to_string(), NOW).unwrap()
}

fn request(manifest: &Value, elements: Vec<DynSolValue>) -> Value {
    let function: Function =
        serde_json::from_value(manifest["abi_fragment"]["abi"].clone()).unwrap();
    let calldata = function
        .abi_encode_input(&[DynSolValue::Array(elements)])
        .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(&calldata[..4])),
        manifest["match"]["selector"].as_str().unwrap()
    );
    json!({
        "kind":"transaction", "chainId":"eip155:1", "from":SENDER, "to":GOVERNANCE,
        "data":format!("0x{}", hex::encode(calldata))
    })
}

fn decoded(store: &SnapshotStore, request: &Value, manifest: &Value) -> Value {
    let data = request["data"].as_str().unwrap();
    let wire = json!({
        "chain_id":1,"to":GOVERNANCE,"selector":&data[..10],"calldata":data,
        "submitter":SENDER,"submitted_at":NOW / 1000
    });
    let decoded = serde_json::to_value(
        store
            .current(NOW)
            .unwrap()
            .decoder()
            .registry()
            .route_request(&wire.to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded["decoder_id"], manifest["id"]);
    assert_eq!(decoded["actions"].as_array().unwrap().len(), 1);
    decoded["actions"][0]["body"].clone()
}

fn venue() -> Value {
    json!({"name":"aave_governance_v3", "chain":"eip155:1", "governance":GOVERNANCE})
}

fn evaluate(session: &mut CoreSession, request: &Value) -> Value {
    let plan = session.plan(&request.to_string(), NOW).unwrap();
    assert!(plan["calls"].as_array().unwrap().is_empty());
    session
        .evaluate(
            plan["planId"].as_str().unwrap(),
            &json!({"planId":plan["planId"],"results":{}}).to_string(),
            NOW,
        )
        .unwrap()
}

fn assert_day1_no_matching_policy(session: &mut CoreSession, request: &Value) {
    let verdict = evaluate(session, request);
    assert_eq!(verdict["decision"], "allow", "{verdict}");
    assert_eq!(verdict["source"], "evaluated", "{verdict}");
    assert!(verdict["reasons"].as_array().unwrap().is_empty());
    assert!(verdict["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|diagnostic| diagnostic["code"] == "no_matching_policy"));
}

#[test]
fn cancellation_fee_array_preserves_proposal_order_and_full_u256_precision() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    let proposals = [U256::MAX, U256::from(7_u64)];
    let request = request(
        &manifests[0],
        proposals
            .iter()
            .map(|id| DynSolValue::Uint(*id, 256))
            .collect(),
    );
    let expected: Vec<Value> = proposals
        .iter()
        .map(|id| {
            json!({
                "domain":"governance", "action":"redeem_cancellation_fee",
                "venue":venue(), "proposal_id":format!("{id:#x}")
            })
        })
        .collect();
    assert_eq!(
        decoded(&store, &request, &manifests[0]),
        json!({"domain":"multicall", "actions":expected})
    );
    assert_day1_no_matching_policy(&mut session, &request);
}

#[test]
fn representative_array_preserves_addresses_order_and_destination_chain_ids() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    // The represented chain is independent from the execution chain. The
    // second value is an ABI precision probe, not a claimed live deployment.
    let representatives = [(OTHER, 10_u64), (SENDER, 9_007_199_254_740_993_u64)];
    let request = request(
        &manifests[1],
        representatives
            .iter()
            .map(|(address, chain)| {
                DynSolValue::Tuple(vec![
                    DynSolValue::Address(address.parse().unwrap()),
                    DynSolValue::Uint(U256::from(*chain), 256),
                ])
            })
            .collect(),
    );
    let expected: Vec<Value> = representatives
        .iter()
        .map(|(address, chain)| {
            json!({
                "domain":"governance", "action":"update_representative", "venue":venue(),
                "representative":address, "representative_chain_id":format!("{chain:#x}")
            })
        })
        .collect();
    assert_eq!(
        decoded(&store, &request, &manifests[1]),
        json!({"domain":"multicall", "actions":expected})
    );
    assert_day1_no_matching_policy(&mut session, &request);
}

#[test]
fn governance_arrays_keep_existing_empty_batch_and_malformed_calldata_guards() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    for manifest in &manifests {
        let mut request = request(manifest, Vec::new());
        assert_eq!(decoded(&store, &request, manifest)["domain"], "unknown");
        let verdict = evaluate(&mut session, &request);
        assert_eq!(verdict["decision"], "warn", "{verdict}");
        assert_eq!(verdict["source"], "evaluated", "{verdict}");
        assert!(verdict["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "partial_decode"));

        request["data"] = manifest["match"]["selector"].clone();
        let error = session.plan(&request.to_string(), NOW).unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST", "{error}");
    }
}
