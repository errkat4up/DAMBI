//! Actual Umbrella tuple calldata -> per-token intents -> a signed test policy.
//! This verifies restake preference, not permit validity or on-chain execution.
//! Semantics: aave-dao/aave-umbrella src/contracts/helpers/UmbrellaBatchHelper.sol
//! claimRewardsPermit/_claimRewardsPermit: restake may fall back to a direct
//! reward payment; the final beneficiary is the caller in either case.

#[path = "support/snapshot.rs"]
mod support;

use alloy_dyn_abi::{DynSolValue, JsonAbiExt};
use alloy_json_abi::Function;
use alloy_primitives::{B256, U256};
use dambi_core::{session::CoreSession, snapshot::SnapshotStore};
use serde_json::{json, Value};
use support::{artifact, config, day1, policy_value, signed_policy, Artifact, PolicyWire, NOW};

const MANIFEST: &str =
    include_str!("../../../registryV2/manifests/aave/umbrella/batch-claimRewardsPermit@1.0.0.json");
const HELPER: &str = "0xce6ced23118edeb23054e06118a702797b13fc2f";
const SENDER: &str = "0x000000000000000000000000000000000000aaaa";
// Synthetic addresses exercise ABI ordering without claiming live stake paths.
const STAKE: &str = "0x3333333333333333333333333333333333333333";
const REWARDS: [&str; 2] = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
];
const TEST_POLICY: &str = "test-umbrella-restake-intent";

fn manifest() -> Value {
    serde_json::from_str(MANIFEST).unwrap()
}

fn session(artifact: &Artifact, policy: PolicyWire) -> CoreSession {
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
    let wire = json!({
        "payload":String::from_utf8(policy.payload).unwrap(),
        "signature":policy.signature
    });
    CoreSession::new(&config.to_string(), &wire.to_string(), NOW).unwrap()
}

fn request(rewards: &[&str], restake: bool) -> Value {
    let manifest = manifest();
    let function: Function =
        serde_json::from_value(manifest["abi_fragment"]["abi"].clone()).unwrap();
    let calldata = function
        .abi_encode_input(&[DynSolValue::Tuple(vec![
            DynSolValue::Address(STAKE.parse().unwrap()),
            DynSolValue::Array(
                rewards
                    .iter()
                    .map(|token| DynSolValue::Address(token.parse().unwrap()))
                    .collect(),
            ),
            DynSolValue::Uint(U256::from(NOW / 1000 + 60), 256),
            DynSolValue::Uint(U256::from(27_u64), 8),
            DynSolValue::FixedBytes(B256::ZERO, 32),
            DynSolValue::FixedBytes(B256::ZERO, 32),
            DynSolValue::Bool(restake),
        ])])
        .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(&calldata[..4])),
        manifest["match"]["selector"]
    );
    json!({
        "kind":"transaction", "chainId":"eip155:1", "from":SENDER, "to":HELPER,
        "data":format!("0x{}", hex::encode(calldata))
    })
}

fn decoded(store: &SnapshotStore, request: &Value) -> Value {
    let data = request["data"].as_str().unwrap();
    let wire = json!({
        "chain_id":1,"to":HELPER,"selector":&data[..10],"calldata":data,
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
    assert_eq!(decoded["decoder_id"], manifest()["id"]);
    assert_eq!(decoded["actions"].as_array().unwrap().len(), 1);
    decoded["actions"][0]["body"].clone()
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

#[test]
fn umbrella_tuple_retains_reward_order_helper_and_restake_through_policy_evaluation() {
    let artifact = artifact(vec![manifest()]);
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    // A test-only policy proves that the bool reaches Cedar. Day1 and published
    // product policies are unchanged; true is not inherently unsafe.
    let mut policies = policy_value(42);
    policies["policies"].as_array_mut().unwrap().push(json!({
        "id":TEST_POLICY,
        "policy":format!(r#"@id("{TEST_POLICY}") @severity("deny")
            forbid(principal, action == Staking::Action::"ClaimRewards", resource)
            when {{ context has restake && context.restake
                && context.venue.name == "aave_umbrella_batch_helper"
                && context.venue has helper && context.venue.helper == "{HELPER}"
                && context has recipient && context.recipient == "{SENDER}" }};"#),
        "manifest":{
            "id":TEST_POLICY,"schema_version":2,
            "trigger":{"where":{"action.tag":{"eq":"claim_rewards"}}},
            "policy_rpc":[],"custom_context":{"fields":{}}
        }
    }));
    let mut session = session(&artifact, signed_policy(policies));
    for restake in [false, true] {
        let request = request(&REWARDS, restake);
        let expected: Vec<Value> = REWARDS.iter().map(|token| json!({
            "domain":"staking", "action":"claim_rewards",
            "venue":{"name":"aave_umbrella_batch_helper", "chain":"eip155:1", "helper":HELPER},
            "reward_token":{"key":{"standard":"erc20", "chain":"eip155:1", "address":token}},
            "gauges":[STAKE], "on_behalf_of":SENDER, "recipient":SENDER, "restake":restake
        })).collect();
        assert_eq!(
            decoded(&store, &request),
            json!({"domain":"multicall","actions":expected})
        );
        let verdict = evaluate(&mut session, &request);
        assert_eq!(verdict["source"], "evaluated", "{verdict}");
        assert_eq!(
            verdict["decision"],
            if restake { "deny" } else { "allow" },
            "{verdict}"
        );
        assert_eq!(
            verdict["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|reason| reason["policyId"] == TEST_POLICY),
            restake,
            "{verdict}"
        );
    }
}

#[test]
fn umbrella_empty_rewards_and_malformed_tuple_keep_existing_guards() {
    let artifact = artifact(vec![manifest()]);
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact, day1());
    let mut request = request(&[], true);
    assert_eq!(decoded(&store, &request)["domain"], "unknown");
    let verdict = evaluate(&mut session, &request);
    assert_eq!(verdict["decision"], "warn", "{verdict}");
    assert!(
        verdict["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "partial_decode"),
        "{verdict}"
    );
    request["data"] = manifest()["match"]["selector"].clone();
    let error = session.plan(&request.to_string(), NOW).unwrap_err();
    assert_eq!(error.code, "INVALID_REQUEST", "{error}");
}
