//! Public plan/evaluate boundary, with authentic policy and Decoder inputs.

#[path = "support/snapshot.rs"]
mod support;

use dambi_core::session::{CoreSession, SessionError};
use serde_json::{json, Value};
use support::{
    approve_bundle, artifact, canonical, day1, digest, policy_value, signed_policy, PolicyWire,
    CONTRACT, NOW, SECOND_CONTRACT,
};

const SENDER: &str = "0x000000000000000000000000000000000000aaaa";

fn config(bundles: Vec<Value>) -> Value {
    let artifact = artifact(bundles);
    let keys: Value =
        serde_json::from_str(include_str!("fixtures/policy-bundle/test-only-keys.json")).unwrap();
    json!({
        "decoderSnapshot": { "artifact": String::from_utf8(artifact.bytes).unwrap(), "expectedDigest": artifact.digest },
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
    })
}

fn wire(policy: PolicyWire) -> String {
    let mut value = json!({ "payload":String::from_utf8(policy.payload).unwrap(),"signature":policy.signature });
    if let Some(key_id) = policy.key_id {
        value["keyId"] = json!(key_id);
    }
    value.to_string()
}

fn session() -> CoreSession {
    CoreSession::new(
        &config(vec![approve_bundle()]).to_string(),
        &wire(day1()),
        NOW,
    )
    .unwrap()
}

fn request(amount: &str) -> Value {
    json!({
        "kind":"transaction","chainId":"eip155:1","from":SENDER,"to":CONTRACT,
        "data":format!("0x095ea7b3{:0>64}{amount:0>64}",&SECOND_CONTRACT[2..])
    })
}

fn empty_facts(plan: &Value) -> String {
    json!({"planId":plan["planId"],"results":{}}).to_string()
}

fn evaluate(session: &mut CoreSession, plan: &Value, facts: &str, now: u64) -> Value {
    session
        .evaluate(plan["planId"].as_str().unwrap(), facts, now)
        .unwrap()
}

fn error_code<T>(result: Result<T, SessionError>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.code, expected, "{error:?}"),
        Ok(_) => panic!("expected {expected}"),
    }
}

fn diagnostic(verdict: &Value, code: &str) -> bool {
    verdict["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["code"] == code)
}

fn has_reason(verdict: &Value, id: &str) -> bool {
    verdict["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["policyId"] == id)
}

#[test]
fn real_decode_evaluation_and_digest_use_the_pinned_declared_request() {
    let mut session = session();
    let original = request(&"f".repeat(64));
    let expected = digest(&canonical(
        &json!({"domain":"dambi.core.request.v1","request":original}),
    ));
    let mut with_transport = original;
    with_transport["hostname"] = json!("excluded.example");
    let plan = session.plan(&with_transport.to_string(), NOW).unwrap();
    assert_eq!(plan["expiresAt"], NOW + 10000);
    assert!(plan["calls"].as_array().unwrap().is_empty());
    with_transport["data"] = request("0")["data"].clone();
    let result = evaluate(&mut session, &plan, &empty_facts(&plan), NOW);
    assert_eq!(result["decision"], "warn");
    assert_eq!(result["source"], "evaluated");
    assert_eq!(result["enforcement"], "advisory");
    assert!(has_reason(&result, "unlimited-approval-deny"));
    assert_eq!(result["metadata"]["requestDigest"], expected);
    assert_eq!(result["metadata"]["policyVersion"], "42");
    assert!(!result["metadata"]["engineVersion"]
        .as_str()
        .unwrap()
        .is_empty());
    error_code(
        session.evaluate(plan["planId"].as_str().unwrap(), &empty_facts(&plan), NOW),
        "PLAN_CONSUMED",
    );
}

#[test]
fn foreign_forged_expired_and_disposed_handles_cannot_evaluate() {
    let mut first = session();
    let mut second = session();
    let plan = first.plan(&request("7").to_string(), NOW).unwrap();
    let id = plan["planId"].as_str().unwrap();
    error_code(
        second.evaluate(id, &empty_facts(&plan), NOW),
        "INVALID_PLAN",
    );
    error_code(
        first.evaluate("forged", &empty_facts(&plan), NOW),
        "INVALID_PLAN",
    );
    error_code(
        first.evaluate(id, &empty_facts(&plan), NOW + 10000),
        "PLAN_EXPIRED",
    );
    let live = second.plan(&request("7").to_string(), NOW).unwrap();
    second.dispose();
    second.dispose();
    error_code(second.plan(&request("7").to_string(), NOW), "DISPOSED");
    error_code(
        second.evaluate(live["planId"].as_str().unwrap(), &empty_facts(&live), NOW),
        "DISPOSED",
    );
}

#[test]
fn refresh_keeps_existing_plan_policy_and_cannot_accept_a_stale_response() {
    let mut session = session();
    let request = request(&"f".repeat(64)).to_string();
    let old = session.plan(&request, NOW).unwrap();
    let mut replacement = policy_value(43);
    let cedar = replacement["policies"][0]["policy"]
        .as_str()
        .unwrap()
        .replace("@severity(\"warn\")", "@severity(\"deny\")");
    replacement["policies"][0]["policy"] = json!(cedar);
    let earlier = session.begin_refresh().unwrap();
    let latest = session.begin_refresh().unwrap();
    let replacement = wire(signed_policy(replacement));
    error_code(
        session.commit_refresh(earlier, &replacement, NOW),
        "ABORTED",
    );
    session.commit_refresh(latest, &replacement, NOW).unwrap();
    let new = session.plan(&request, NOW).unwrap();
    let before = evaluate(&mut session, &old, &empty_facts(&old), NOW);
    let after = evaluate(&mut session, &new, &empty_facts(&new), NOW);
    assert_eq!(
        (
            before["decision"].as_str(),
            before["metadata"]["policyVersion"].as_str()
        ),
        (Some("warn"), Some("42"))
    );
    assert_eq!(
        (
            after["decision"].as_str(),
            after["metadata"]["policyVersion"].as_str()
        ),
        (Some("deny"), Some("43"))
    );
}

#[test]
fn valid_handle_is_consumed_when_trust_or_fact_batch_validation_fails() {
    let mut policy = policy_value(42);
    policy["expires_at"] = json!(NOW / 1000 + 1);
    let mut session = CoreSession::new(
        &config(vec![approve_bundle()]).to_string(),
        &wire(signed_policy(policy)),
        NOW,
    )
    .unwrap();
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    let result = evaluate(&mut session, &plan, &empty_facts(&plan), NOW + 1000);
    assert_eq!(result["decision"], "deny");
    assert_eq!(result["source"], "fail_closed");
    assert!(diagnostic(&result, "trust_expired"));
    error_code(
        session.evaluate(
            plan["planId"].as_str().unwrap(),
            &empty_facts(&plan),
            NOW + 1000,
        ),
        "PLAN_CONSUMED",
    );

    let mut session = self::session();
    for (batch, code) in [
        ("{".to_owned(), "invalid_fact"),
        (
            json!({"planId":"wrong","results":{}}).to_string(),
            "fact_plan_mismatch",
        ),
    ] {
        let plan = session.plan(&request("7").to_string(), NOW).unwrap();
        let result = evaluate(&mut session, &plan, &batch, NOW);
        assert_eq!(result["source"], "fail_closed");
        assert!(diagnostic(&result, code), "{result}");
        error_code(
            session.evaluate(plan["planId"].as_str().unwrap(), &empty_facts(&plan), NOW),
            "PLAN_CONSUMED",
        );
    }
}

fn fact_policy(tag: &str, action: &str, optional: bool) -> Value {
    let id = "test-balance";
    json!({
        "id":id,
        "policy":format!("@id(\"{id}\") @severity(\"deny\") forbid(principal, action == Token::Action::\"{action}\", resource) when {{ context has custom && context.custom has balance && context.custom.balance == \"0x64\" }};"),
        "manifest": {
            "id":id,"schema_version":2,"trigger":{"where":{"action.tag":{"eq":tag}}},
            "policy_rpc":[{"id":"balance","method":"portfolio.balance","params":{"amount":"$.action.amount","chain_id":"$.root.chain_id"},
                "outputs":[{"kind":"context","field":"balance","type":"String","from":"$.result.balance","required":!optional}],"optional":optional}],
            "custom_context":{"fields":{"balance":"String"}}
        }
    })
}

fn with_policies(entries: Vec<Value>) -> String {
    let mut value = policy_value(42);
    value["policies"] = json!(entries);
    wire(signed_policy(value))
}

fn fact(value: Value) -> Value {
    json!({"value":value,"source":"fixture:eip155:1","observedAt":NOW,"blockNumber":"20000000"})
}

fn one_fact(plan: &Value, value: Value) -> String {
    let mut results = serde_json::Map::new();
    results.insert(
        plan["calls"][0]["callId"].as_str().unwrap().to_owned(),
        value,
    );
    json!({"planId":plan["planId"],"results":results}).to_string()
}

#[test]
fn required_facts_validate_metadata_and_project_the_method_response_once() {
    let mut session = CoreSession::new(
        &config(vec![approve_bundle()]).to_string(),
        &with_policies(vec![fact_policy("erc20_approve", "Erc20Approve", false)]),
        NOW,
    )
    .unwrap();
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    assert_eq!(plan["calls"][0]["method"], "portfolio.balance");
    assert_eq!(plan["calls"][0]["params"]["amount"], "0x7");
    let good = fact(json!({"balance":"0x64"}));
    let result = evaluate(&mut session, &plan, &one_fact(&plan, good.clone()), NOW);
    assert_eq!(result["source"], "evaluated");
    assert!(has_reason(&result, "test-balance"));
    assert_eq!(result["facts"], json!([good]));

    for (pointer, value, diagnostic_code) in [
        ("/source", json!(""), "invalid_fact"),
        ("/observedAt", json!(NOW - 1001), "fact_stale"),
        ("/observedAt", json!(NOW + 5001), "invalid_fact"),
        ("/blockNumber", json!("-1"), "invalid_fact"),
    ] {
        let plan = session.plan(&request("7").to_string(), NOW).unwrap();
        let mut invalid = fact(json!({"balance":"0x64"}));
        *invalid.pointer_mut(pointer).unwrap() = value;
        let result = evaluate(&mut session, &plan, &one_fact(&plan, invalid), NOW);
        assert_eq!(result["source"], "fail_closed");
        assert!(diagnostic(&result, diagnostic_code), "{result}");
    }
    for value in [
        json!({"result":{"balance":"0x64"}}),
        json!("0x64"),
        json!({"balance":64}),
    ] {
        let plan = session.plan(&request("7").to_string(), NOW).unwrap();
        let result = evaluate(&mut session, &plan, &one_fact(&plan, fact(value)), NOW);
        assert_eq!(result["source"], "fail_closed");
        assert!(diagnostic(&result, "projection_failed"), "{result}");
    }
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    let result = evaluate(&mut session, &plan, &empty_facts(&plan), NOW);
    assert!(diagnostic(&result, "required_fact_missing"), "{result}");
}

#[test]
fn missing_or_unprojectable_optional_fact_retains_absence_without_zero_or_warning() {
    let mut session = CoreSession::new(
        &config(vec![approve_bundle()]).to_string(),
        &with_policies(vec![fact_policy("erc20_approve", "Erc20Approve", true)]),
        NOW,
    )
    .unwrap();
    for missing in [true, false] {
        let plan = session.plan(&request("7").to_string(), NOW).unwrap();
        let facts = if missing {
            empty_facts(&plan)
        } else {
            one_fact(&plan, fact(json!({})))
        };
        let result = evaluate(&mut session, &plan, &facts, NOW);
        assert_eq!(result["decision"], "allow");
        assert_eq!(result["source"], "evaluated");
        assert!(result["reasons"].as_array().unwrap().is_empty());
    }
}

fn action(tag: &str, amount: &str) -> Value {
    let mut value = json!({"domain":"token","action":tag,"token":{"key":{"standard":"erc20","chain":"eip155:1","address":CONTRACT}},"amount":amount});
    value[if tag == "erc20_approve" {
        "spender"
    } else {
        "recipient"
    }] = json!(SECOND_CONTRACT);
    value
}

fn tree_bundle(children: Vec<Value>) -> Value {
    let mut bundle = approve_bundle();
    bundle["id"] = json!("test/tree@1");
    bundle["emit"]["body"] = json!({"domain":"multicall","actions":children});
    bundle
}

#[test]
fn repeated_child_manifests_get_distinct_calls_and_keep_results_separate() {
    let bundle = tree_bundle(vec![
        action("erc20_approve", "0x7"),
        action("erc20_approve", "0x8"),
    ]);
    let mut session = CoreSession::new(
        &config(vec![bundle]).to_string(),
        &with_policies(vec![fact_policy("erc20_approve", "Erc20Approve", false)]),
        NOW,
    )
    .unwrap();
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    let calls = plan["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_ne!(calls[0]["callId"], calls[1]["callId"]);
    assert_eq!(calls[0]["manifestId"], calls[1]["manifestId"]);
    assert_eq!(calls[0]["params"]["amount"], "0x7");
    assert_eq!(calls[1]["params"]["amount"], "0x8");
    let mut results = serde_json::Map::new();
    results.insert(
        calls[0]["callId"].as_str().unwrap().into(),
        fact(json!({"balance":"0x64"})),
    );
    results.insert(
        calls[1]["callId"].as_str().unwrap().into(),
        fact(json!({"balance":"0x0"})),
    );
    let result = evaluate(
        &mut session,
        &plan,
        &json!({"planId":plan["planId"],"results":results}).to_string(),
        NOW,
    );
    assert_eq!(result["decision"], "deny");
    assert_eq!(result["source"], "evaluated");
    assert!(has_reason(&result, "test-balance"));
    assert_eq!(result["facts"].as_array().unwrap().len(), 2);
}

#[test]
fn sibling_deny_survives_unknown_planning_and_fact_errors_in_both_orders() {
    let deny = json!({
        "id":"test-static-deny", "policy":"@id(\"test-static-deny\") @severity(\"deny\") forbid(principal, action == Token::Action::\"Erc20Approve\", resource);",
        "manifest":{"id":"test-static-deny","schema_version":2,"trigger":{"where":{"action.tag":{"eq":"erc20_approve"}}}}
    });
    for mode in ["unknown", "planning", "missing", "projection"] {
        for reversed in [false, true] {
            let sibling = if mode == "unknown" {
                json!({"domain":"unknown","target":CONTRACT,"chain":"eip155:1","calldata":"0xdeadbeef","value":"0x0"})
            } else {
                action("erc20_transfer", "0x1")
            };
            let mut children = vec![action("erc20_approve", "0x7"), sibling];
            if reversed {
                children.reverse();
            }
            let mut policies = vec![deny.clone()];
            if mode == "unknown" {
                policies.push(json!({
                    "id":"test-unknown-deny", "policy":"@id(\"test-unknown-deny\") @severity(\"deny\") forbid(principal, action == Core::Action::\"Unknown\", resource);",
                    "manifest":{"id":"test-unknown-deny","schema_version":2,"trigger":{"where":{"action.domain":{"eq":"unknown"}}}}
                }));
            } else {
                let mut policy = fact_policy("erc20_transfer", "Erc20Transfer", false);
                if mode == "planning" {
                    policy["manifest"]["policy_rpc"][0]["params"]["amount"] =
                        json!("$.action.nonexistent");
                }
                policies.push(policy);
            }
            let mut session = CoreSession::new(
                &config(vec![tree_bundle(children)]).to_string(),
                &with_policies(policies),
                NOW,
            )
            .unwrap();
            let plan = session.plan(&request("7").to_string(), NOW).unwrap();
            let facts = if mode == "projection" {
                one_fact(&plan, fact(json!({"balance":null})))
            } else {
                empty_facts(&plan)
            };
            let result = evaluate(&mut session, &plan, &facts, NOW);
            assert_eq!(result["decision"], "deny", "{mode}: {result}");
            assert!(has_reason(&result, "test-static-deny"), "{mode}: {result}");
            if mode == "unknown" {
                assert!(has_reason(&result, "test-unknown-deny"), "{result}");
            }
            let code = match mode {
                "unknown" => "partial_decode",
                "planning" => "engine_error",
                "missing" => "required_fact_missing",
                _ => "projection_failed",
            };
            assert!(diagnostic(&result, code), "{mode}: {result}");
            assert_eq!(
                result["source"],
                if mode == "unknown" {
                    "evaluated"
                } else {
                    "fail_closed"
                }
            );
        }
    }
}

#[test]
fn pending_plan_limit_releases_expired_plans_and_input_limits_fail_closed() {
    let mut cfg = config(vec![approve_bundle()]);
    cfg["limits"]["maxPendingPlans"] = json!(1);
    let mut session = CoreSession::new(&cfg.to_string(), &wire(day1()), NOW).unwrap();
    session.plan(&request("7").to_string(), NOW).unwrap();
    error_code(
        session.plan(&request("7").to_string(), NOW),
        "LIMIT_EXCEEDED",
    );
    session
        .plan(&request("7").to_string(), NOW + 10000)
        .unwrap();

    cfg["limits"]["maxRequestBytes"] = json!(1);
    let mut session = CoreSession::new(&cfg.to_string(), &wire(day1()), NOW).unwrap();
    error_code(
        session.plan(&request("7").to_string(), NOW),
        "LIMIT_EXCEEDED",
    );
    cfg["limits"]["maxRequestBytes"] = json!(100000);
    cfg["limits"]["maxFactBytes"] = json!(1);
    let mut session = CoreSession::new(&cfg.to_string(), &wire(day1()), NOW).unwrap();
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    let result = evaluate(&mut session, &plan, &empty_facts(&plan), NOW);
    assert_eq!(result["decision"], "deny");
    assert!(diagnostic(&result, "limit_exceeded"));
}

#[test]
fn check_failures_consume_plans_and_keep_pinned_metadata_and_policy_reasons() {
    let mut session = session();
    for failure in ["aborted", "timeout", "fact_fetch_failed"] {
        let plan = session
            .plan(&request(&"f".repeat(64)).to_string(), NOW)
            .unwrap();
        let id = plan["planId"].as_str().unwrap();
        let result = session
            .evaluate_check(id, &empty_facts(&plan), NOW, failure)
            .unwrap();
        assert_eq!(result["decision"], "deny");
        assert_eq!(result["source"], "fail_closed");
        assert_eq!(result["metadata"]["status"], "available");
        assert_eq!(result["metadata"]["policyVersion"], "42");
        assert!(has_reason(&result, "unlimited-approval-deny"));
        assert!(diagnostic(&result, failure));
        error_code(
            session.evaluate(id, &empty_facts(&plan), NOW),
            "PLAN_CONSUMED",
        );
    }
    let plan = session.plan(&request("7").to_string(), NOW).unwrap();
    let id = plan["planId"].as_str().unwrap();
    error_code(
        session.evaluate_check(id, &empty_facts(&plan), NOW, "allow"),
        "ENGINE_ERROR",
    );
    let result = session
        .evaluate_check(id, &empty_facts(&plan), NOW + 10000, "")
        .unwrap();
    assert_eq!(result["decision"], "deny");
    assert_eq!(result["source"], "fail_closed");
    assert_eq!(result["metadata"]["status"], "available");
    assert!(diagnostic(&result, "timeout"));
    error_code(
        session.evaluate(id, &empty_facts(&plan), NOW + 10000),
        "PLAN_EXPIRED",
    );
}

#[test]
fn strict_permit_routes_and_malformed_known_requests_never_become_success() {
    let permit: Value =
        serde_json::from_str(include_str!("fixtures/erc20-permit.manifest.json")).unwrap();
    let input: Value =
        serde_json::from_str(include_str!("fixtures/typed-permit-numeric-request.json")).unwrap();
    let mut session =
        CoreSession::new(&config(vec![permit]).to_string(), &wire(day1()), NOW).unwrap();
    let mut req = json!({"kind":"typed_signature","chainId":"eip155:1","from":input["requested_signer"],"typedData":input["typed_data"]});
    let plan = session.plan(&req.to_string(), NOW).unwrap();
    let result = evaluate(&mut session, &plan, &empty_facts(&plan), NOW);
    assert_eq!(result["decision"], "allow");
    assert!(diagnostic(&result, "no_matching_policy"));
    let typed_json = req["typedData"].to_string();
    let duplicate = typed_json.replace(
        "\"value\":\"1000000\"",
        "\"value\":\"7\",\"value\":\"1000000\"",
    );
    assert_ne!(typed_json, duplicate);
    let mut duplicate_req = req.clone();
    duplicate_req["typedData"] = json!(duplicate);
    error_code(
        session.plan(&duplicate_req.to_string(), NOW),
        "INVALID_REQUEST",
    );
    req["typedData"]["message"]["owner"] = json!(SECOND_CONTRACT);
    error_code(session.plan(&req.to_string(), NOW), "INVALID_REQUEST");
    for malformed in [json!({"data":123}), json!({"value":"bad"})] {
        let mut creation = json!({"kind":"transaction","chainId":"eip155:1","from":SENDER});
        creation
            .as_object_mut()
            .unwrap()
            .extend(malformed.as_object().unwrap().clone());
        error_code(session.plan(&creation.to_string(), NOW), "INVALID_REQUEST");
    }
    error_code(session.plan("{", NOW), "INVALID_REQUEST");
    error_code(
        session.plan(
            &json!({"kind":"untyped_signature","message":"opaque"}).to_string(),
            NOW,
        ),
        "UNSUPPORTED_REQUEST",
    );
}

#[test]
fn configured_scam_without_a_bundle_never_weakens_policy_or_installs_a_stub() {
    let req = request(&"f".repeat(64)).to_string();
    let mut original = session();
    let original_plan = original.plan(&req, NOW).unwrap();
    let baseline = evaluate(
        &mut original,
        &original_plan,
        &empty_facts(&original_plan),
        NOW,
    );
    assert!(baseline.get("scam").is_none());

    let mut local = config(vec![approve_bundle()]);
    let settings = json!({
        "enabled": true, "presetId": "fixture", "overrides": [],
        "additionalRules": [], "locale": "ko"
    });
    // This session has policy trust only; the independent existing development
    // key is assigned to scam, not also installed as Decoder trust.
    let key = support::key("decoder", dambi_core::bundle::KeyRole::Scam);
    let scam_key = json!({"keyId":key.key_id,"role":"scam",
        "publicKeySpkiBase64":key.public_key_spki_base64});
    local["scam"] = json!({
        "settings": settings,
        "trust": {"env":"staging", "profile":"default", "keys":[scam_key]},
        "limits": {
            "scamTimeoutMs":2500, "scamEvalReserveMs":200,
            "maxBundleBytes":1000000, "maxResultBytes":1000000,
            "maxCalls":4, "maxTargets":2, "maxRules":16,
            "maxLogs":20000, "maxPoints":20000, "maxAlgorithmWorkUnits":100000
        }
    });
    let mut core = CoreSession::new(&local.to_string(), &wire(day1()), NOW).unwrap();
    error_code(
        core.set_scam_settings("{\"enabled\":\"false\"}"),
        "INVALID_CONFIG",
    );
    let pinned = core.plan(&req, NOW).unwrap();
    let mut disabled = settings;
    disabled["enabled"] = json!(false);
    core.set_scam_settings(&disabled.to_string()).unwrap();

    let result = evaluate(&mut core, &pinned, &empty_facts(&pinned), NOW);
    assert_eq!(result["decision"], baseline["decision"]);
    assert_eq!(result["source"], baseline["source"]);
    assert_eq!(result["reasons"], baseline["reasons"]);
    assert_eq!(result["scam"]["status"], "insufficient");
    assert_eq!(result["scam"]["reasons"], json!(["bundle_unavailable"]));
    assert!(result["scam"].get("analysisMode").is_none());

    let next = core.plan(&req, NOW).unwrap();
    let result = evaluate(&mut core, &next, &empty_facts(&next), NOW);
    assert_eq!(result["decision"], baseline["decision"]);
    assert_eq!(result["scam"]["status"], "disabled");
}

fn scam_config() -> Value {
    let mut local = config(vec![approve_bundle()]);
    let key = support::key("decoder", dambi_core::bundle::KeyRole::Scam);
    local["scam"] = json!({
        "settings":{"enabled":true,"presetId":"default","overrides":[],"additionalRules":[],"locale":"ko"},
        "trust":{"env":"staging","profile":"default","keys":[{
            "keyId":key.key_id,"role":"scam","publicKeySpkiBase64":key.public_key_spki_base64
        }]},
        "limits":{"scamTimeoutMs":2500,"scamEvalReserveMs":200,
            "maxBundleBytes":1000000,"maxResultBytes":1000000,"maxCalls":4,"maxTargets":2,
            "maxRules":16,"maxLogs":20000,"maxPoints":20000,"maxAlgorithmWorkUnits":100000}
    });
    local
}

fn scam_bundle(sequence: &str) -> Value {
    let preset = json!({"id":"base","rules":[{
        "id":"liquidity-drop","kind":"window_drop","enabled":true,"metric":"quote_reserve",
        "lookbackSec":60,"windowSec":10,"dropBps":5000
    }],"bucketMs":1000,"gridOriginMs":0,"warmupSec":1,"maxDataAgeSec":30});
    json!({
        "kind":"scam_bundle","schema":"0.1","sequence":sequence,
        "issuedAtMs":NOW-1000,"expiresAtMs":NOW+60000,"env":"staging","profile":"default",
        "compatibility":{"engineRange":"*","builderRange":"dambi-v2/2","contractVersion":"0.1","algorithm":null},
        "support":[{"chainId":1,"venue":"uniswap_v2","factories":[CONTRACT],
            "quoteTokens":[SECOND_CONTRACT],"exemptTokens":[],"allowedBucketMs":[1000],"confirmDepth":2}],
        "presets":[{"id":"default","purpose":"default",
            "selection":{"ageThresholdSec":60,"unknownAge":"new_provisional_insufficient"},
            "newMarket":preset,"established":preset}],"templates":{},"model":null
    })
}

fn scam_wire(payload: &str) -> String {
    json!({"payload":payload,"signature":support::sign("decoder",payload.as_bytes()),
        "keyId":"ignored-remote-key-id"})
    .to_string()
}

fn refresh_scam(core: &mut CoreSession, payload: &str, now: u64) -> Result<(), SessionError> {
    let ticket = core.begin_scam_refresh()?;
    core.commit_scam_refresh(ticket, &scam_wire(payload), now)
}

fn scam_report(core: &mut CoreSession, now: u64) -> Value {
    let plan = core
        .plan(&request(&"f".repeat(64)).to_string(), now)
        .unwrap();
    evaluate(core, &plan, &empty_facts(&plan), now)
}

#[test]
fn scam_trust_requires_valid_curve_keys_and_separation_from_policy_and_decoder() {
    let local = scam_config();
    CoreSession::new(&local.to_string(), &wire(day1()), NOW).unwrap();
    let mut invalid = local.clone();
    invalid["scam"]["trust"]["keys"][0]["publicKeySpkiBase64"] = json!("not-spki");
    error_code(
        CoreSession::new(&invalid.to_string(), &wire(day1()), NOW),
        "INVALID_CONFIG",
    );
    let mut shared = local.clone();
    shared["scam"]["trust"]["keys"][0]["publicKeySpkiBase64"] =
        local["trust"]["keys"][0]["publicKeySpkiBase64"].clone();
    error_code(
        CoreSession::new(&shared.to_string(), &wire(day1()), NOW),
        "INVALID_CONFIG",
    );
    let mut decoder = local["scam"]["trust"]["keys"][0].clone();
    decoder["role"] = json!("decoder");
    let mut shared = local;
    shared["trust"]["keys"]
        .as_array_mut()
        .unwrap()
        .push(decoder);
    error_code(
        CoreSession::new(&shared.to_string(), &wire(day1()), NOW),
        "INVALID_CONFIG",
    );
}

#[test]
fn scam_refresh_authenticates_original_utf8_and_never_uses_remote_key_selection() {
    let mut core = CoreSession::new(&scam_config().to_string(), &wire(day1()), NOW).unwrap();
    let mut bundle = scam_bundle("1");
    bundle["templates"]["ko"] = json!("분석 범위 확인");
    let payload = serde_json::to_string_pretty(&bundle).unwrap();
    let signed: Value = serde_json::from_str(&scam_wire(&payload)).unwrap();
    let mut tampered = signed.clone();
    tampered["payload"] = json!(bundle.to_string());
    let ticket = core.begin_scam_refresh().unwrap();
    error_code(
        core.commit_scam_refresh(ticket, &tampered.to_string(), NOW),
        "INVALID_SIGNATURE",
    );
    let report = scam_report(&mut core, NOW);
    assert_eq!(report["scam"]["reasons"], json!(["bundle_unavailable"]));
    assert_eq!(report["decision"], "warn");

    let mut wrong_role = signed.clone();
    wrong_role["signature"] = json!(support::sign("policy", payload.as_bytes()));
    let ticket = core.begin_scam_refresh().unwrap();
    error_code(
        core.commit_scam_refresh(ticket, &wrong_role.to_string(), NOW),
        "INVALID_SIGNATURE",
    );
    for signature in [
        "AA==".to_owned(),
        signed["signature"]
            .as_str()
            .unwrap()
            .trim_end_matches('=')
            .to_owned(),
    ] {
        let mut bad = signed.clone();
        bad["signature"] = json!(signature);
        let ticket = core.begin_scam_refresh().unwrap();
        error_code(
            core.commit_scam_refresh(ticket, &bad.to_string(), NOW),
            "INVALID_SIGNATURE",
        );
    }
    refresh_scam(&mut core, &payload, NOW).unwrap();
    let report = scam_report(&mut core, NOW);
    assert_eq!(
        report["scam"]["pinned"]["bundleDigest"],
        digest(payload.as_bytes())
    );
    assert_eq!(
        report["scam"]["pinned"]["algorithm"]["state"],
        "unavailable"
    );
    assert_ne!(report["scam"]["status"], "quiet");

    let duplicate = payload.replacen("\"kind\":", "\"kind\":\"scam_bundle\",\"kind\":", 1);
    error_code(
        refresh_scam(&mut core, &duplicate, NOW),
        "INVALID_SCAM_BUNDLE",
    );
    let mut unknown = signed;
    unknown["unexpected"] = json!(true);
    let ticket = core.begin_scam_refresh().unwrap();
    error_code(
        core.commit_scam_refresh(ticket, &unknown.to_string(), NOW),
        "INVALID_SCAM_BUNDLE",
    );
}

#[test]
fn scam_refresh_rejects_scope_semantic_sequence_and_lifetime_failures_atomically() {
    let mut core = CoreSession::new(&scam_config().to_string(), &wire(day1()), NOW).unwrap();
    let original = scam_bundle("2").to_string();
    refresh_scam(&mut core, &original, NOW).unwrap();
    refresh_scam(&mut core, &original, NOW).unwrap();
    error_code(
        refresh_scam(&mut core, &scam_bundle("1").to_string(), NOW),
        "SCAM_SEQUENCE_REJECTED",
    );
    let differently_encoded = serde_json::to_string_pretty(&scam_bundle("2")).unwrap();
    error_code(
        refresh_scam(&mut core, &differently_encoded, NOW),
        "SCAM_SEQUENCE_REJECTED",
    );
    for (pointer, value, expected) in [
        ("/env", json!("production"), "SCAM_SCOPE_MISMATCH"),
        ("/profile", json!("foreign"), "SCAM_SCOPE_MISMATCH"),
        ("/schema", json!("9"), "INVALID_SCAM_BUNDLE"),
        ("/sequence", json!("03"), "INVALID_SCAM_BUNDLE"),
        (
            "/compatibility/engineRange",
            json!("^0.1.0"),
            "INVALID_SCAM_BUNDLE",
        ),
        (
            "/compatibility/builderRange",
            json!("remote-builder"),
            "INVALID_SCAM_BUNDLE",
        ),
        (
            "/compatibility/contractVersion",
            json!("0.2"),
            "INVALID_SCAM_BUNDLE",
        ),
        ("/presets/0/id", json!("unselected"), "INVALID_SCAM_BUNDLE"),
        (
            "/presets/0/newMarket/bucketMs",
            json!(2000),
            "INVALID_SCAM_BUNDLE",
        ),
        ("/model", json!({"id":"unlinked"}), "INVALID_SCAM_BUNDLE"),
        ("/issuedAtMs", json!(NOW + 1), "SCAM_EXPIRED"),
        ("/expiresAtMs", json!(NOW), "SCAM_EXPIRED"),
        ("/expiresAtMs", json!(NOW - 1000), "INVALID_SCAM_BUNDLE"),
    ] {
        let mut candidate = scam_bundle("3");
        *candidate.pointer_mut(pointer).unwrap() = value;
        error_code(
            refresh_scam(&mut core, &candidate.to_string(), NOW),
            expected,
        );
    }
    let mut missing = scam_bundle("3");
    missing.as_object_mut().unwrap().remove("model");
    error_code(
        refresh_scam(&mut core, &missing.to_string(), NOW),
        "INVALID_SCAM_BUNDLE",
    );
    let report = scam_report(&mut core, NOW);
    assert_eq!(report["scam"]["pinned"]["bundleSequence"], "2");
    assert_eq!(
        report["scam"]["pinned"]["bundleDigest"],
        digest(original.as_bytes())
    );
    assert_eq!(report["decision"], "warn");
    let mut sensitive_default = scam_bundle("3");
    sensitive_default["presets"][0]["newMarket"]["rules"] = json!([{
        "id":"r1","kind":"change_count","enabled":true,"metric":"quote_reserve",
        "lookbackSec":60,"direction":"either","changeMode":"step","thresholdBps":500,"count":2
    }]);
    error_code(
        refresh_scam(&mut core, &sensitive_default.to_string(), NOW),
        "INVALID_SCAM_BUNDLE",
    );
    sensitive_default["presets"][0]["purpose"] = json!("demo");
    refresh_scam(&mut core, &sensitive_default.to_string(), NOW).unwrap();
    error_code(
        refresh_scam(&mut core, &original, NOW + 60000),
        "SCAM_EXPIRED",
    );
}

#[test]
fn scam_refresh_tickets_are_independent_and_existing_plans_keep_their_pinned_bundle() {
    let mut core = CoreSession::new(&scam_config().to_string(), &wire(day1()), NOW).unwrap();
    let earlier = core.begin_scam_refresh().unwrap();
    let latest = core.begin_scam_refresh().unwrap();
    error_code(
        core.commit_scam_refresh(earlier, &scam_wire(&scam_bundle("1").to_string()), NOW),
        "ABORTED",
    );
    error_code(core.cancel_scam_refresh(earlier), "ABORTED");
    let mut other = CoreSession::new(&scam_config().to_string(), &wire(day1()), NOW).unwrap();
    error_code(other.commit_scam_refresh(latest, "{}", NOW), "ABORTED");
    core.commit_scam_refresh(latest, &scam_wire(&scam_bundle("1").to_string()), NOW)
        .unwrap();
    let pinned = core
        .plan(&request(&"f".repeat(64)).to_string(), NOW)
        .unwrap();

    let policy_ticket = core.begin_refresh().unwrap();
    let scam_ticket = core.begin_scam_refresh().unwrap();
    core.commit_refresh(policy_ticket, &wire(signed_policy(policy_value(43))), NOW)
        .unwrap();
    core.commit_scam_refresh(scam_ticket, &scam_wire(&scam_bundle("2").to_string()), NOW)
        .unwrap();
    let before = evaluate(&mut core, &pinned, &empty_facts(&pinned), NOW);
    let after = scam_report(&mut core, NOW);
    assert_eq!(before["scam"]["pinned"]["bundleSequence"], "1");
    assert_eq!(before["metadata"]["policyVersion"], "42");
    assert_eq!(after["scam"]["pinned"]["bundleSequence"], "2");
    assert_eq!(after["metadata"]["policyVersion"], "43");

    let cancelled = core.begin_scam_refresh().unwrap();
    core.cancel_scam_refresh(cancelled).unwrap();
    error_code(
        core.commit_scam_refresh(cancelled, &scam_wire(&scam_bundle("3").to_string()), NOW),
        "ABORTED",
    );
    let mut expiring = scam_bundle("3");
    expiring["expiresAtMs"] = json!(NOW + 100);
    refresh_scam(&mut core, &expiring.to_string(), NOW).unwrap();
    let old = core
        .plan(&request(&"f".repeat(64)).to_string(), NOW)
        .unwrap();
    refresh_scam(&mut core, &scam_bundle("4").to_string(), NOW).unwrap();
    let expired = evaluate(&mut core, &old, &empty_facts(&old), NOW + 100);
    assert_eq!(expired["scam"]["reasons"], json!(["bundle_invalid"]));
    assert_eq!(expired["decision"], "warn");
    let pending = core.begin_scam_refresh().unwrap();
    core.dispose();
    error_code(core.commit_scam_refresh(pending, "{}", NOW), "DISPOSED");
    error_code(core.begin_scam_refresh(), "DISPOSED");
}
