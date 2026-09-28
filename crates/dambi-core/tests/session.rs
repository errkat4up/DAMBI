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
    assert!(result["metadata"]["engineVersion"].as_str().unwrap().len() > 0);
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
