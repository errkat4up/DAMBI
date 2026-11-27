//! Real Registry manifests, pinned installation, raw calldata and Day1 policy.
//!
//! These cases cover calldata token/amount intent and V3 recipients, not market data.
//! Missing swap slippage and live observations must remain absent; unresolved
//! venue identities still require separate integration work. These tests do not
//! claim complete Universal Router command/chain coverage.
//! V4's swap recipient is the manifest's tx.from; final TAKE/SETTLE recipients
//! and actual EVM execution are not covered by that case.

#[path = "support/snapshot.rs"]
mod support;

use alloy_dyn_abi::{DynSolValue, JsonAbiExt};
use alloy_json_abi::Function;
use alloy_primitives::{Address, U256};
use dambi_core::{session::CoreSession, snapshot::SnapshotStore};
use serde_json::{json, Value};
use support::{artifact, config, day1, Artifact, NOW};

const MANIFESTS: [&str; 2] = [
    include_str!("../../../registryV2/manifests/uniswap/universal-router/execute-v2@1.0.0.json"),
    include_str!(
        "../../../registryV2/manifests/uniswap/universal-router/execute-v2-no-deadline@1.0.0.json"
    ),
];
const ROUTER: &str = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const SENDER: &str = "0x000000000000000000000000000000000000aaaa";
const OTHER: &str = "0x000000000000000000000000000000000000bbbb";
const TOKEN_IN: &str = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT: &str = "0x2222222222222222222222222222222222222222";
const SWAP_POLICY: &str = "swap-recipient-not-self-deny";

fn manifests() -> Vec<Value> {
    MANIFESTS
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect()
}

fn session(artifact: &Artifact) -> CoreSession {
    let policy = day1();
    session_with_policy(
        artifact,
        &json!({
            "payload":String::from_utf8(policy.payload).unwrap(),
            "signature":policy.signature,
            "keyId":policy.key_id.unwrap()
        }),
    )
}

fn session_with_policy(artifact: &Artifact, wire: &Value) -> CoreSession {
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
    CoreSession::new(&config.to_string(), &wire.to_string(), NOW).unwrap()
}

fn address(value: &str) -> DynSolValue {
    DynSolValue::Address(value.parse().unwrap())
}

fn uint(value: u64, bits: usize) -> DynSolValue {
    DynSolValue::Uint(U256::from(value), bits)
}

fn params(signature: &str, values: &[DynSolValue]) -> Vec<u8> {
    Function::parse(signature)
        .unwrap()
        .abi_encode_input(values)
        .unwrap()[4..]
        .to_vec()
}

fn request(manifest: &Value, commands: &[u8], inputs: Vec<Vec<u8>>) -> Value {
    let with_deadline = manifest["abi_fragment"]["abi"]["inputs"]
        .as_array()
        .unwrap()
        .len()
        == 3;
    let signature = if with_deadline {
        "execute(bytes,bytes[],uint256)"
    } else {
        "execute(bytes,bytes[])"
    };
    let mut values = vec![
        DynSolValue::Bytes(commands.to_vec()),
        DynSolValue::Array(inputs.into_iter().map(DynSolValue::Bytes).collect()),
    ];
    if with_deadline {
        values.push(uint(NOW / 1000 + 60, 256));
    }
    let encoded = Function::parse(signature)
        .unwrap()
        .abi_encode_input(&values)
        .unwrap();
    assert_eq!(
        format!("0x{}", hex::encode(&encoded[..4])),
        manifest["match"]["selector"].as_str().unwrap()
    );
    json!({
        "kind":"transaction", "chainId":"eip155:1", "from":SENDER, "to":ROUTER,
        "data":format!("0x{}", hex::encode(encoded))
    })
}

fn decoded(store: &SnapshotStore, request: &Value) -> Value {
    let data = request["data"].as_str().unwrap();
    let wire = json!({
        "chain_id":1,"to":ROUTER,"selector":&data[..10],"calldata":data,
        "submitter":SENDER,"submitted_at":NOW / 1000
    });
    serde_json::to_value(
        store
            .current(NOW)
            .unwrap()
            .decoder()
            .registry()
            .route_request(&wire.to_string())
            .unwrap(),
    )
    .unwrap()
}

fn assert_swap(swap: &Value, recipient: &str) {
    assert_eq!(swap["domain"], "amm", "{swap}");
    assert_eq!(swap["action"], "swap", "{swap}");
    assert_eq!(swap["params"]["token_in"]["key"]["address"], TOKEN_IN);
    assert_eq!(swap["params"]["token_out"]["key"]["address"], TOKEN_OUT);
    assert_eq!(swap["params"]["recipient"], recipient);
    assert_eq!(swap["params"]["direction"]["kind"], "exact_input");
    assert_eq!(swap["params"]["direction"]["amount_in"], "0x3e8");
    assert_eq!(swap["params"]["direction"]["min_amount_out"], "0x384");
}

fn assert_verdict(session: &mut CoreSession, request: &Value, expected: &str) {
    let plan = session.plan(&request.to_string(), NOW).unwrap();
    assert!(plan["calls"].as_array().unwrap().is_empty());
    let facts = json!({"planId":plan["planId"],"results":{}});
    let verdict = session
        .evaluate(plan["planId"].as_str().unwrap(), &facts.to_string(), NOW)
        .unwrap();
    assert_eq!(verdict["decision"], expected, "{verdict}");
    assert_eq!(verdict["source"], "evaluated", "{verdict}");
    assert_eq!(
        verdict["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason["policyId"] == SWAP_POLICY),
        expected == "deny",
        "{verdict}"
    );
}

#[test]
fn both_execute_selectors_preserve_v3_swap_intent_and_day1_recipient_decisions() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    let mut path = TOKEN_IN.parse::<Address>().unwrap().as_slice().to_vec();
    path.extend_from_slice(&[0x00, 0x01, 0xf4]);
    path.extend_from_slice(TOKEN_OUT.parse::<Address>().unwrap().as_slice());

    for manifest in &manifests {
        for (recipient, expected) in [(SENDER, "allow"), (OTHER, "deny")] {
            let input = params(
                "step(address,uint256,uint256,bytes,bool)",
                &[
                    address(recipient),
                    uint(1000, 256),
                    uint(900, 256),
                    DynSolValue::Bytes(path.clone()),
                    DynSolValue::Bool(true),
                ],
            );
            let request = request(manifest, &[0x00], vec![input]);
            let decoded = decoded(&store, &request);
            assert_eq!(decoded["decoder_id"], manifest["id"]);
            assert_eq!(decoded["actions"].as_array().unwrap().len(), 1);
            let root = &decoded["actions"][0]["body"];
            assert_eq!(root["domain"], "multicall");
            assert_eq!(root["actions"].as_array().unwrap().len(), 1);
            assert_swap(&root["actions"][0], recipient);
            assert_verdict(&mut session, &request, expected);
        }
    }
}

#[test]
fn zero_output_floor_without_observations_preserves_independent_recipient_deny() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    let mut path = TOKEN_IN.parse::<Address>().unwrap().as_slice().to_vec();
    path.extend_from_slice(&[0x00, 0x01, 0xf4]);
    path.extend_from_slice(TOKEN_OUT.parse::<Address>().unwrap().as_slice());

    // Both selected execute selectors must preserve the ABI's literal zero.
    // A missing quote must neither invalidate the request nor suppress the
    // independently evaluable, signed recipient deny.
    for manifest in &manifests {
        let input = params(
            "step(address,uint256,uint256,bytes,bool)",
            &[
                address(OTHER),
                uint(1000, 256),
                uint(0, 256),
                DynSolValue::Bytes(path.clone()),
                DynSolValue::Bool(true),
            ],
        );
        let request = request(manifest, &[0x00], vec![input]);
        let decoded = decoded(&store, &request);
        assert_eq!(decoded["decoder_id"], manifest["id"]);
        let root = &decoded["actions"][0]["body"];
        assert_eq!(root["domain"], "multicall");
        assert_eq!(root["actions"].as_array().unwrap().len(), 1);
        let swap = &root["actions"][0];
        assert_eq!(swap["domain"], "amm");
        assert_eq!(swap["action"], "swap");
        assert_eq!(swap["params"]["recipient"], OTHER);
        assert_eq!(swap["params"]["direction"]["kind"], "exact_input");
        assert_eq!(swap["params"]["direction"]["amount_in"], "0x3e8");
        assert_eq!(swap["params"]["direction"]["min_amount_out"], "0x0");
        assert!(swap["params"].get("slippage_bp").is_none());
        let live = swap["live_inputs"].as_object().unwrap();
        for field in [
            "route",
            "expected_amount_out",
            "price_impact_bp",
            "gas_estimate",
        ] {
            assert!(live.get(field).is_none(), "unobserved {field}: {swap}");
        }
        assert_verdict(&mut session, &request, "deny");
    }
}

// These are local test policies, signed using the explicitly test-only key.
// Keep the real recipient policy's action scope and trigger so a misspelled
// action namespace cannot turn the missing-attribute case into a policy miss.
fn observation_policy(field: &str) -> (Value, String) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use p256::pkcs8::DecodePrivateKey;

    let keys: Value =
        serde_json::from_str(include_str!("fixtures/policy-bundle/test-only-keys.json")).unwrap();
    assert_eq!(keys["test_only"], true);
    let mut payload: Value = serde_json::from_slice(&day1().payload).unwrap();
    let recipient = payload["policies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == SWAP_POLICY)
        .unwrap()
        .clone();
    let id = format!("check-observed-{field}");
    let mut dependent = recipient.clone();
    dependent["id"] = json!(id);
    dependent["manifest"]["id"] = json!(id);
    let original = recipient["policy"].as_str().unwrap();
    let (head, _) = original.split_once("when").unwrap();
    dependent["policy"] = json!(format!(
        "{} when {{ context.{field} == context.{field} }};",
        head.replace(SWAP_POLICY, &id)
    ));
    payload["policies"] = json!([recipient, dependent]);
    let payload = serde_json::to_string(&payload).unwrap();
    let pem = keys["policy"]["private_key_pkcs8_pem"].as_str().unwrap();
    let encoded: String = pem
        .lines()
        .filter(|line| !line.starts_with("---"))
        .collect();
    let key = SigningKey::from_pkcs8_der(&STANDARD.decode(encoded).unwrap()).unwrap();
    let signature: Signature = key.sign(payload.as_bytes());
    (
        json!({
            "payload":payload,
            "signature":STANDARD.encode(signature.to_bytes()),
            "keyId":keys["policy"]["key_id"]
        }),
        id,
    )
}

// Inject explicit observations only into the control fixture's swap templates.
// The baseline manifest remains unchanged. This is not a claim that calldata
// supplies market observations or a generated product snapshot modification.
fn supply_zero_observations(value: &mut Value) -> usize {
    use policy_state::live_field::{DataSource, LiveField};
    use policy_state::primitives::Time;
    use policy_transition::action::amm::{SwapLiveInputs, SwapRoute};

    let mut count = 0;
    match value {
        Value::Object(object) => {
            if object
                .get("params")
                .and_then(|p| p.get("direction"))
                .is_some()
                && object.contains_key("venue")
            {
                object.get_mut("params").unwrap()["slippage_bp"] = json!(0);
                let time = Time::from_unix(NOW / 1000 - 7);
                object.insert(
                    "live_inputs".into(),
                    serde_json::to_value(SwapLiveInputs {
                        declared_route: None,
                        route: Some(LiveField::new(
                            SwapRoute {
                                paths: vec![],
                                aggregator: None,
                            },
                            DataSource::UserSupplied,
                            time,
                        )),
                        expected_amount_out: Some(LiveField::new(
                            U256::ZERO,
                            DataSource::UserSupplied,
                            time,
                        )),
                        price_impact_bp: Some(LiveField::new(0u32, DataSource::UserSupplied, time)),
                        gas_estimate: Some(LiveField::new(
                            U256::ZERO,
                            DataSource::UserSupplied,
                            time,
                        )),
                    })
                    .unwrap(),
                );
                count += 1;
            }
            for child in object.values_mut() {
                count += supply_zero_observations(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                count += supply_zero_observations(child);
            }
        }
        _ => {}
    }
    count
}

#[test]
fn positive_floor_missing_observation_policy_preserves_recipient_deny() {
    let mut path = TOKEN_IN.parse::<Address>().unwrap().as_slice().to_vec();
    path.extend_from_slice(&[0x00, 0x01, 0xf4]);
    path.extend_from_slice(TOKEN_OUT.parse::<Address>().unwrap().as_slice());

    for manifest in manifests() {
        let input = params(
            "step(address,uint256,uint256,bytes,bool)",
            &[
                address(OTHER),
                uint(1000, 256),
                uint(900, 256),
                DynSolValue::Bytes(path.clone()),
                DynSolValue::Bool(true),
            ],
        );
        let request = request(&manifest, &[0x00], vec![input]);
        for observed in [false, true] {
            let mut selected = manifest.clone();
            if observed {
                assert!(supply_zero_observations(&mut selected["emit"]) > 0);
            }
            let artifact = artifact(vec![selected]);
            let store =
                SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
            let decoded = decoded(&store, &request);
            let swap = &decoded["actions"][0]["body"]["actions"][0];
            assert_swap(swap, OTHER);
            if observed {
                assert_eq!(swap["params"]["slippage_bp"], 0);
                assert_eq!(swap["live_inputs"]["expected_amount_out"]["value"], "0x0");
                assert_eq!(swap["live_inputs"]["price_impact_bp"]["value"], 0);
                assert_eq!(swap["live_inputs"]["gas_estimate"]["value"], "0x0");
                assert_eq!(swap["live_inputs"]["route"]["value"]["paths"], json!([]));
            } else {
                assert!(swap["params"].get("slippage_bp").is_none());
                for field in [
                    "route",
                    "expected_amount_out",
                    "price_impact_bp",
                    "gas_estimate",
                ] {
                    assert!(swap["live_inputs"].get(field).is_none(), "{swap}");
                }
            }
            // Separate policies avoid short-circuiting the first missing read
            // and accidentally leaving the other four fields untested.
            for field in [
                "slippageBp",
                "expectedAmountOut",
                "priceImpactBp",
                "gasEstimate",
                "routeEstimatedOut",
            ] {
                let (wire, dependent_id) = observation_policy(field);
                let mut session = session_with_policy(&artifact, &wire);
                let plan = session.plan(&request.to_string(), NOW).unwrap();
                assert!(plan["calls"].as_array().unwrap().is_empty());
                let facts = json!({"planId":plan["planId"], "results":{}});
                let verdict = session
                    .evaluate(plan["planId"].as_str().unwrap(), &facts.to_string(), NOW)
                    .unwrap();
                assert_eq!(verdict["source"], "evaluated", "{field}: {verdict}");
                assert_eq!(verdict["decision"], "deny", "{field}: {verdict}");
                let reasons = verdict["reasons"].as_array().unwrap();
                assert!(
                    reasons.iter().any(|r| r["policyId"] == SWAP_POLICY),
                    "{verdict}"
                );
                assert_eq!(
                    reasons.iter().any(|r| r["policyId"] == dependent_id),
                    observed,
                    "{field}: {verdict}"
                );
                let diagnostics = verdict["diagnostics"].as_array().unwrap();
                assert!(!diagnostics.iter().any(|d| d["code"] == "invalid_request"));
                // The enclosing Batch has no policy; the child Swap matched both triggers.
                assert!(diagnostics
                    .iter()
                    .any(|d| { d["code"] == "no_matching_policy" && d["nodePath"] == json!([]) }));
                assert!(!diagnostics
                    .iter()
                    .any(|d| { d["code"] == "no_matching_policy" && d["nodePath"] == json!([0]) }));
                assert_eq!(
                    diagnostics.iter().any(|d| {
                        d["code"] == "engine_error"
                            && d["nodePath"] == json!([0])
                            && d["message"]
                                .as_str()
                                .is_some_and(|message| message.contains(field))
                    }),
                    !observed,
                    "missing attribute must remain diagnosable: {field}: {verdict}"
                );
            }
        }
    }
}

fn v4_input(alternative: bool) -> Vec<u8> {
    let mut tuple = vec![
        address(TOKEN_IN),
        DynSolValue::Array(vec![DynSolValue::Tuple(vec![
            address(TOKEN_OUT),
            uint(500, 24),
            DynSolValue::Int(alloy_primitives::I256::try_from(60_i64).unwrap(), 24),
            DynSolValue::Address(Address::ZERO),
            DynSolValue::Bytes(Vec::new()),
        ])]),
    ];
    let signature = if alternative {
        "step((address,(address,uint24,int24,address,bytes)[],uint128,uint128))"
    } else {
        tuple.push(DynSolValue::Array(vec![uint(1, 256)]));
        "step((address,(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128))"
    };
    tuple.extend([uint(1000, 128), uint(900, 128)]);
    let swap = params(signature, &[DynSolValue::Tuple(tuple)]);
    params(
        "step(bytes,bytes[])",
        &[
            DynSolValue::Bytes(vec![0x07]),
            DynSolValue::Array(vec![DynSolValue::Bytes(swap)]),
        ],
    )
}

#[test]
fn nested_v4_primary_and_alternative_abis_reach_the_native_session() {
    let manifests = manifests();
    let artifact = artifact(manifests.clone());
    let store = SnapshotStore::new(config(), artifact.input(), day1().input(), NOW).unwrap();
    let mut session = session(&artifact);
    for manifest in &manifests {
        for alternative in [false, true] {
            let request = request(manifest, &[0x10], vec![v4_input(alternative)]);
            let decoded = decoded(&store, &request);
            assert_eq!(decoded["decoder_id"], manifest["id"]);
            assert_eq!(decoded["actions"].as_array().unwrap().len(), 1);
            let root = &decoded["actions"][0]["body"];
            assert_eq!(root["domain"], "multicall");
            assert_eq!(root["actions"].as_array().unwrap().len(), 1);
            let nested = &root["actions"][0];
            assert_eq!(nested["domain"], "multicall");
            assert_eq!(nested["actions"].as_array().unwrap().len(), 1);
            assert_swap(&nested["actions"][0], SENDER);
            assert_verdict(&mut session, &request, "allow");
        }
    }

    // Removing ONLY the alternative from an otherwise real manifest must
    // reject the old tuple layout; acceptance above cannot be a primary-ABI
    // decode that happened to produce plausible values.
    let mut primary_only = manifests;
    for manifest in &mut primary_only {
        manifest
            .pointer_mut("/emit/per_opcode_body/0x10/nested/per_opcode_body/0x07")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("inputs_abi_alternatives");
    }
    let mut primary_session = self::session(&support::artifact(primary_only.clone()));
    for manifest in &primary_only {
        let request = request(manifest, &[0x10], vec![v4_input(true)]);
        let error = primary_session.plan(&request.to_string(), NOW).unwrap_err();
        // Rejection is the contract. The first missing input field depends on
        // template traversal order, not on whether the alternative ABI is used.
        assert_eq!(error.code, "INVALID_REQUEST", "{error}");
    }
}
