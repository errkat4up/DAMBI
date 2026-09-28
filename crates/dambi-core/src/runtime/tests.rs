use super::dto::{BundleInput, TxInput};
use crate::json::Envelope;
use crate::runtime::dto::{EvaluateActionInput, PlanActionInput};
use crate::runtime::{evaluate_action, json as runtime_json, plan_action};
use policy_engine::policy::{PolicyEngine, Verdict};
use policy_engine::policy_rpc::{ManifestV2, MAX_POLICY_RPC_V2_MANIFESTS};
use policy_engine::schema::compose_per_policy;
use policy_transition::action::ActionBody;
use serde_json::{json, Value};
use std::str::FromStr;

use policy_state::live_field::{DataSource, OracleProvider};
use policy_state::primitives::{Address, ChainId, Duration, Time, U128, U256};
use policy_state::token::{TokenKey, TokenRef};
use policy_state::LiveField;
use policy_transition::action::amm::{
    AmmAction, AmmVenue, PoolState, RouteHop, RoutePath, SwapAction, SwapDirection, SwapLiveInputs,
    SwapParams, SwapRoute,
};
use policy_transition::action::hyperliquid_core::{HlUnknownAction, HyperliquidCoreAction};
use policy_transition::action::{ActionMeta, ActionNature};

// Keep the established envelope assertions while calling the SDK-owned
// JSON adapters. These helpers are private to this test module.
fn plan_action_rpc_v2_json(input_json: String) -> String {
    match runtime_json::plan_action_rpc_v2(&input_json) {
        Ok(data) => Envelope::ok(data).to_json(),
        Err(error) => Envelope::<()>::err(error.kind, error.message).to_json(),
    }
}

fn evaluate_action_v2_json(input_json: String) -> String {
    Envelope::ok(runtime_json::evaluate_action_v2(&input_json)).to_json()
}

const FROM: &str = "0x1111111111111111111111111111111111111111";
const TO: &str = "0x2222222222222222222222222222222222222222";

/// A faithful UniswapV3 swap `ActionBody` + `ActionMeta` (mirrors the
/// `materialize_v2` reference fixture).
fn swap_sample() -> (ActionBody, ActionMeta) {
    let now = Time::from_unix(1_738_000_000);
    let user = Address::from_str("0x000000000000000000000000000000000000a01c").unwrap();
    let chain = ChainId::arbitrum();
    let usdc = TokenRef {
        key: TokenKey::Erc20 {
            chain: chain.clone(),
            address: Address::from_str("0xaf88d065e77c8cc2239327c5edb3a432268e5831").unwrap(),
        },
    };
    let weth = TokenRef {
        key: TokenKey::Erc20 {
            chain: chain.clone(),
            address: Address::from_str("0x82af49447d8a07e3bd95bd0d56f35241523fbab1").unwrap(),
        },
    };
    let pool = Address::from_str("0xc6962004f452be9203591991d15f6b388e09e8d0").unwrap();
    let v3 = AmmVenue::UniswapV3 {
        chain: chain.clone(),
        pool,
        fee_tier_bp: 500,
    };
    let pool_state = PoolState::Concentrated {
        sqrt_price_x96: U256::from(1u64),
        tick: 0,
        liquidity: U128::from(0u64),
        ticks: vec![],
    };
    let pool_source = DataSource::OnchainView {
        chain: chain.clone(),
        contract: pool,
        function: "slot0()".into(),
        decoder_id: "uniswap_v3_slot0".into(),
    };
    let route = SwapRoute {
        paths: vec![RoutePath {
            share_bp: 10000,
            hops: vec![RouteHop {
                token_in: usdc.clone(),
                token_out: weth.clone(),
                venue: v3.clone(),
                pool_state,
                effective_fee_bp: 5,
                estimated_out: U256::from(305_000_000_000_000_000u64),
            }],
            estimated_out: U256::from(305_000_000_000_000_000u64),
        }],
        aggregator: None,
    };
    let swap = AmmAction::Swap(SwapAction {
        venue: v3,
        params: SwapParams {
            token_in: usdc,
            token_out: Some(weth),
            direction: SwapDirection::ExactInput {
                amount_in: U256::from(1_000_000_000u64),
                min_amount_out: U256::from(300_000_000_000_000_000u64),
            },
            recipient: user,
            slippage_bp: 50,
        },
        live_inputs: SwapLiveInputs {
            route: LiveField::new(route, pool_source.clone(), now)
                .with_ttl(Duration::from_secs(12)),
            expected_amount_out: LiveField::new(
                U256::from(305_000_000_000_000_000u64),
                pool_source.clone(),
                now,
            ),
            price_impact_bp: LiveField::new(12u32, pool_source, now),
            gas_estimate: LiveField::new(
                U256::from(180_000u64),
                DataSource::OracleFeed {
                    provider: OracleProvider::Pyth,
                    feed_id: "gas/arbitrum".into(),
                },
                now,
            ),
        },
    });
    let meta = ActionMeta {
        submitted_at: now,
        submitter: user,
        nature: ActionNature::OnchainTx {
            chain,
            nonce: 42,
            gas_limit: U256::from(200_000u64),
            gas_price: LiveField::new(
                U256::from(100_000_000u64),
                DataSource::OracleFeed {
                    provider: OracleProvider::Pyth,
                    feed_id: "ETH/USD".into(),
                },
                now,
            ),
            value: U256::ZERO,
        },
    };
    (ActionBody::Amm(swap), meta)
}

/// A swap manifest: trigger matches `swap`, one policy_rpc call writing
/// `context.custom.totalInputUsd` (decimal), declared in `custom_context`.
fn swap_manifest() -> Value {
    json!({
        "id": "large-swap-usd-warning",
        "schema_version": 2,
        "trigger": { "where": { "action.tag": { "eq": "swap" } } },
        "policy_rpc": [{
            "id": "total-input-usd",
            "method": "oracle.usd_value",
            "params": {
                "chain_id": "$.root.chain_id",
                "recipient": "$.action.recipient"
            },
            "outputs": [{
                "kind": "context",
                "field": "totalInputUsd",
                "type": "Decimal",
                "from": "$.result.usd"
            }]
        }],
        "custom_context": { "fields": { "totalInputUsd": "decimal" } }
    })
}

fn swap_manifest_with_id(id: &str) -> Value {
    let mut manifest = swap_manifest();
    manifest["id"] = json!(id);
    manifest
}

/// A Cedar policy that warns when `context.custom.totalInputUsd` exceeds
/// 1000. `custom` is optional and `totalInputUsd` is a `decimal` extension
/// value, so the guard must `has`-check the path and use `greaterThan`.
fn warn_policy() -> &'static str {
    "@id(\"large-input\")\n@severity(\"warn\")\n\
         @reason(\"large USD input\")\n\
         forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
         when { context has custom && context.custom has totalInputUsd \
         && context.custom.totalInputUsd.greaterThan(decimal(\"1000.0000\")) };\n"
}

fn tx() -> Value {
    json!({ "chain_id": "eip155:42161", "from": FROM, "to": TO })
}

#[test]
fn plan_action_rpc_v2_returns_oracle_call() {
    let (body, meta) = swap_sample();
    let input = json!({
        "manifests": [swap_manifest()],
        "action": body,
        "meta": meta,
        "tx": tx(),
    });
    let out = plan_action_rpc_v2_json(input.to_string());
    let parsed: Value = serde_json::from_str(&out).unwrap();

    assert_eq!(parsed["ok"], true, "{parsed}");
    let planned = parsed["data"]["planned"].as_array().expect("planned array");
    assert_eq!(planned.len(), 1, "{parsed}");
    assert_eq!(
        planned[0]["call_id"],
        "large-swap-usd-warning::total-input-usd"
    );
    assert_eq!(planned[0]["method"], "oracle.usd_value");
    assert_eq!(planned[0]["params"]["chain_id"], "eip155:42161");
}

/// End-to-end: plan → simulate an oracle result → evaluate → Warn.
#[test]
fn evaluate_action_v2_warns_on_large_input() {
    let (body, meta) = swap_sample();

    // 1. PLAN — recover the call_id the host must key its result under.
    let plan_out = plan_action_rpc_v2_json(
        json!({
            "manifests": [swap_manifest()],
            "action": body,
            "meta": meta,
            "tx": tx(),
        })
        .to_string(),
    );
    let plan_parsed: Value = serde_json::from_str(&plan_out).unwrap();
    let call_id = plan_parsed["data"]["planned"][0]["call_id"]
        .as_str()
        .expect("call_id")
        .to_owned();
    assert_eq!(call_id, "large-swap-usd-warning::total-input-usd");

    // 2. EVALUATE — the host returns a $3500 oracle valuation, which the
    //    warn policy (threshold 1000) trips. The evaluate phase plans from
    //    the bundle's own manifest, so the planned call_id matches the one
    //    the plan phase produced and the host keyed its result under.
    let eval_out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": tx(),
            "bundles": [{ "policy": warn_policy(), "manifest": swap_manifest() }],
            "results": { call_id: { "usd": "3500.1200" } }
        })
        .to_string(),
    );
    let eval_parsed: Value = serde_json::from_str(&eval_out).unwrap();
    assert_eq!(eval_parsed["ok"], true, "{eval_parsed}");
    assert_eq!(
        eval_parsed["data"]["verdict"]["kind"], "warn",
        "{eval_parsed}"
    );
    assert_eq!(
        eval_parsed["data"]["verdict"]["matched"][0]["policy_id"], "large-input",
        "{eval_parsed}"
    );
}

/// No bundles installed → the aggregate of zero verdicts is `Pass`.
#[test]
fn evaluate_action_v2_no_bundle_baseline_passes() {
    let (body, meta) = swap_sample();
    let eval_out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": tx(),
            "bundles": [],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&eval_out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "pass", "{parsed}");
}

/// 호스트(dapp)가 checksum 케이스 `tx.from`을 줘도 `principal.address` 비교가
/// 오탐하지 않는다 — 엔진 내부 주소는 전부 소문자라 입구에서 정규화해야 한다
/// (UNI-01 `swap-recipient-not-self-deny` 거짓 양성 회귀).
#[test]
fn evaluate_action_v2_normalizes_checksummed_tx_from() {
    let (body, meta) = swap_sample();
    // swap_sample의 recipient = 0x…a01c (소문자). tx.from은 같은 주소의
    // checksum 케이스 — 정규화 없으면 `recipient != principal.address`가 발화.
    let policy = "@id(\"swap-recipient-not-self-deny\")\n@severity(\"deny\")\n\
             @reason(\"recipient is not your wallet\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when { context.recipient != principal.address };\n";
    let manifest = json!({
        "id": "swap-recipient-not-self-deny",
        "schema_version": 2,
        "trigger": { "where": { "action.tag": { "eq": "swap" } } }
    });
    let checksummed_from = "0x000000000000000000000000000000000000A01C";
    let checksummed_to = "0x000000000000000000000000000000000000BEEF";
    let eval_out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": {
                "chain_id": "eip155:42161",
                "from": checksummed_from,
                "to": checksummed_to
            },
            "bundles": [{ "policy": policy, "manifest": manifest }],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&eval_out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "pass", "{parsed}");

    // Native callers bypass JSON deserialization. Their constructor must
    // preserve the same normalization for planning selectors and Cedar.
    let native_tx = TxInput::new(
        "eip155:42161".to_owned(),
        checksummed_from.to_owned(),
        checksummed_to.to_owned(),
    );
    let mut planning_manifest = swap_manifest();
    planning_manifest["policy_rpc"][0]["params"] = json!({
        "from": "$.root.from",
        "to": "$.root.to"
    });
    let native_plan = plan_action(&PlanActionInput {
        manifests: vec![serde_json::from_value(planning_manifest).unwrap()],
        action: body.clone(),
        meta: meta.clone(),
        tx: native_tx.clone(),
        token_decimals: Default::default(),
        account_leverage: Default::default(),
        order_enrichment: Default::default(),
    })
    .unwrap();
    assert_eq!(native_plan.planned.len(), 1);
    assert_eq!(
        native_plan.planned[0].params["from"],
        checksummed_from.to_ascii_lowercase()
    );
    assert_eq!(
        native_plan.planned[0].params["to"],
        checksummed_to.to_ascii_lowercase()
    );
    let native_verdict = evaluate_action(&EvaluateActionInput {
        action: body,
        meta,
        tx: native_tx,
        bundles: vec![BundleInput {
            policy: policy.to_owned(),
            manifest: serde_json::from_value(manifest).unwrap(),
        }],
        results: Default::default(),
        token_decimals: Default::default(),
        account_leverage: Default::default(),
        order_enrichment: Default::default(),
    })
    .unwrap();
    assert_eq!(native_verdict, Verdict::Pass);
}

/// Missing or unusable required results fail closed as `__system__`.
/// Optional calls skip the same failures without synthesizing a value.
#[test]
fn evaluate_action_v2_missing_required_result_system_fails() {
    let (body, meta) = swap_sample();
    // Any projected value triggers this policy, including a fabricated zero.
    let presence_policy = "@id(\"projected-value\")\n@severity(\"warn\")\n\
            forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
            when { context has custom && context.custom has totalInputUsd };\n";
    for (case, results) in [
        ("missing result", json!({})),
        (
            "missing selector",
            json!({ "large-swap-usd-warning::total-input-usd": {} }),
        ),
        (
            "wrong value type",
            json!({ "large-swap-usd-warning::total-input-usd": { "usd": 3500 } }),
        ),
    ] {
        for optional in [false, true] {
            let mut manifest = swap_manifest();
            manifest["policy_rpc"][0]["optional"] = json!(optional);
            let eval_out = evaluate_action_v2_json(
                json!({
                    "action": body,
                    "meta": meta,
                    "tx": tx(),
                    "bundles": [{ "policy": presence_policy, "manifest": manifest }],
                    "results": results
                })
                .to_string(),
            );
            let parsed: Value = serde_json::from_str(&eval_out).unwrap();
            assert_eq!(parsed["ok"], true, "{case}, optional={optional}: {parsed}");
            let verdict = &parsed["data"]["verdict"];
            if optional {
                assert_eq!(verdict["kind"], "pass", "{case}: {parsed}");
                assert!(verdict.get("matched").is_none(), "{case}: {parsed}");
            } else {
                assert_eq!(verdict["kind"], "fail", "{case}: {parsed}");
                let matched = verdict["matched"].as_array().unwrap();
                assert_eq!(matched.len(), 1, "{case}: {parsed}");
                assert_eq!(matched[0]["policy_id"], "__system__", "{case}: {parsed}");
                assert_eq!(matched[0]["severity"], "deny", "{case}: {parsed}");
            }
        }
    }
}

/// Regression for the divergent-manifest fail-open (Task #7 review,
/// high). Before the fix, `evaluate_action_v2_json` drove the SystemFail
/// gate off a standalone `manifests` list while evaluating a SEPARATE
/// `bundles[].manifest`. A bundle whose required RPC manifest was *absent*
/// from `manifests` was never planned, never materialized, never
/// SystemFailed — and the has-guarded forbid reading the absent custom
/// field short-circuited to Pass (fail-open).
///
/// The fix derives the planned set from `bundles[].manifest`, so there is
/// no second list to diverge: a bundle requiring an RPC call whose result
/// the host never returns now ALWAYS SystemFails to a `__system__` Fail.
/// Here we reproduce the historical attack shape — a (now-ignored)
/// `manifests` side list that does NOT contain the bundle's manifest, with
/// empty `results` — and assert it fails closed.
#[test]
fn evaluate_action_v2_divergent_manifest_fails_closed_not_open() {
    let (body, meta) = swap_sample();
    let eval_out = evaluate_action_v2_json(
        json!({
            // Historical fail-open vector: a side list that does NOT carry
            // the bundle's manifest. It is now ignored entirely — the
            // planned set comes from `bundles[].manifest`.
            "manifests": [],
            "action": body,
            "meta": meta,
            "tx": tx(),
            "bundles": [{ "policy": warn_policy(), "manifest": swap_manifest() }],
            // Host returned nothing for the bundle's required call.
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&eval_out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["kind"], "fail",
        "divergent manifest must fail closed, not Pass: {parsed}"
    );
    assert_eq!(
        parsed["data"]["verdict"]["matched"][0]["policy_id"], "__system__",
        "{parsed}"
    );
}

// ── Per-bundle install-quarantine (F-SCHEMA-1 / F-REQRPC amplification fix) ──
//
// A broken bundle must be isolated to a warn-closed `__engine::quarantine::*`
// verdict instead of short-circuiting the whole `evaluate_matching_bundles`
// loop to a blanket `__engine` Fail. The broken policy below is the literal
// F-SCHEMA-1 shape: a forbid reading the UNDECLARED `context.protocol.name`
// (the declared field is `context.venue.name`), which fails Cedar
// install/validation → a broken bundle.

/// A bundle that fails to install (references undeclared `context.protocol.*`).
fn broken_schema_policy() -> &'static str {
    "@id(\"bridge-protocol-not-allowlisted-warn\")\n@severity(\"warn\")\n\
         @reason(\"protocol not allowlisted\")\n\
         forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
         when { context.protocol.name == \"evil\" };\n"
}

/// A single broken bundle quarantines to `warn` (NOT a blanket `__engine` deny).
#[test]
fn evaluate_action_v2_broken_bundle_quarantined_to_warn() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
            json!({
                "action": body, "meta": meta, "tx": tx(),
                "bundles": [{ "policy": broken_schema_policy(), "manifest": dashboard_manifest("broken") }],
                "results": {}
            })
            .to_string(),
        );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["kind"], "warn",
        "a broken bundle must quarantine to warn, not blanket-deny the tag: {parsed}"
    );
    let pid = parsed["data"]["verdict"]["matched"][0]["policy_id"]
        .as_str()
        .unwrap_or_default();
    assert!(
        pid.starts_with("__engine::quarantine"),
        "quarantine verdict must carry __engine::quarantine::*, got {pid}: {parsed}"
    );
}

/// A malformed bundle whose trigger does not match this action must not
/// poison the position during planning. Broken matching bundles quarantine,
/// but non-matching ones should be invisible to the verdict.
#[test]
fn evaluate_action_v2_invalid_non_matching_bundle_is_skipped() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{
                "policy": broken_schema_policy(),
                "manifest": {
                    "id": "invalid-lending-only",
                    "schema_version": 999,
                    "trigger": { "where": { "action.domain": { "eq": "lending" } } }
                }
            }],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "invalid non-matching bundle must not fail or warn an unrelated swap: {out}"
    );
}

/// Matching manifest/projection faults quarantine to warn. A healthy deny
/// remains present and controls aggregation regardless of bundle order.
#[test]
fn evaluate_action_v2_invalid_matching_manifest_quarantined_to_warn() {
    let (body, meta) = swap_sample();
    let duplicate_manifest = json!({
        "id": "invalid-matching-duplicate-rpc",
        "schema_version": 2,
        "trigger": { "where": { "action.tag": { "eq": "swap" } } },
        "policy_rpc": [
            { "id": "dup", "method": "oracle.usd_value", "outputs": [] },
            { "id": "dup", "method": "oracle.usd_value", "outputs": [] }
        ]
    });
    let mut projection_manifest = swap_manifest_with_id("invalid-projection");
    projection_manifest["policy_rpc"][0]["outputs"][0]["kind"] = json!("entity");
    // The existing manifest validator checks field coverage, not kind.
    // This case therefore reaches materialization's structural failure.
    serde_json::from_value::<ManifestV2>(projection_manifest.clone())
        .unwrap()
        .validate()
        .unwrap();
    let healthy_policy = "@id(\"healthy-deny\")\n@severity(\"deny\")\n\
            @reason(\"slippage exceeds limit\")\n\
            forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
            when { context.slippageBp > 10 };\n";
    let healthy = json!({
        "policy": healthy_policy,
        "manifest": dashboard_manifest("healthy-deny")
    });

    for (error_kind, manifest, results) in [
        ("invalid_manifest", duplicate_manifest, json!({})),
        (
            "projection_failed",
            projection_manifest,
            json!({ "invalid-projection::total-input-usd": { "usd": "3500.1200" } }),
        ),
    ] {
        let broken =
            json!({ "policy": "permit(principal, action, resource);", "manifest": manifest });
        let quarantine_id = format!("__engine::quarantine::{error_kind}");
        for bundles in [
            vec![broken.clone()],
            vec![broken.clone(), healthy.clone()],
            vec![healthy.clone(), broken.clone()],
        ] {
            let has_healthy_deny = bundles.len() == 2;
            let out = evaluate_action_v2_json(
                json!({
                    "action": body, "meta": meta, "tx": tx(),
                    "bundles": bundles,
                    "results": results
                })
                .to_string(),
            );
            let parsed: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(parsed["ok"], true, "{error_kind}: {parsed}");
            let verdict = &parsed["data"]["verdict"];
            assert_eq!(
                verdict["kind"],
                if has_healthy_deny { "fail" } else { "warn" },
                "{error_kind}: {parsed}"
            );
            let matched = verdict["matched"].as_array().unwrap();
            assert_eq!(
                matched.len(),
                if has_healthy_deny { 2 } else { 1 },
                "{parsed}"
            );
            let quarantined = matched
                .iter()
                .find(|item| item["policy_id"] == quarantine_id)
                .unwrap_or_else(|| panic!("missing {quarantine_id}: {parsed}"));
            assert_eq!(quarantined["severity"], "warn", "{parsed}");
            if has_healthy_deny {
                let denied = matched
                    .iter()
                    .find(|item| item["policy_id"] == "healthy-deny")
                    .unwrap_or_else(|| panic!("healthy deny was discarded: {parsed}"));
                assert_eq!(denied["severity"], "deny", "{parsed}");
                assert_eq!(denied["reason"], "slippage exceeds limit", "{parsed}");
            }
        }
    }
}

/// The extension calls PLAN before EVALUATE. Runtime planning must therefore
/// skip invalid matching manifests instead of throwing, while still planning
/// required RPC calls from healthy siblings.
#[test]
fn plan_action_rpc_v2_skips_invalid_matching_manifest_preserves_healthy_sibling() {
    let (body, meta) = swap_sample();
    let out = plan_action_rpc_v2_json(
        json!({
            "manifests": [
                {
                    "id": "invalid-matching-duplicate-rpc",
                    "schema_version": 2,
                    "trigger": { "where": { "action.tag": { "eq": "swap" } } },
                    "policy_rpc": [
                        { "id": "dup", "method": "oracle.usd_value", "outputs": [] },
                        { "id": "dup", "method": "oracle.usd_value", "outputs": [] }
                    ]
                },
                swap_manifest()
            ],
            "action": body,
            "meta": meta,
            "tx": tx()
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    let planned = parsed["data"]["planned"].as_array().unwrap();
    assert_eq!(
        planned.len(),
        1,
        "invalid matching manifest must not block healthy sibling planning: {parsed}"
    );
    assert_eq!(
        planned[0]["call_id"], "large-swap-usd-warning::total-input-usd",
        "{parsed}"
    );
}

/// `call_id` is `<manifest_id>::<spec_id>`, so matching valid manifests must
/// have unique ids before host dispatch builds the result map.
#[test]
fn plan_action_rpc_v2_rejects_duplicate_matching_manifest_ids() {
    let (body, meta) = swap_sample();
    let out = plan_action_rpc_v2_json(
        json!({
            "manifests": [swap_manifest(), swap_manifest()],
            "action": body,
            "meta": meta,
            "tx": tx()
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "duplicate_manifest_id", "{parsed}");
}

#[test]
fn evaluate_action_v2_duplicate_matching_manifest_ids_fail_closed() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [
                { "policy": warn_policy(), "manifest": swap_manifest() },
                { "policy": "permit(principal, action, resource);", "manifest": swap_manifest() }
            ],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "fail", "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["matched"][0]["policy_id"], "__engine::duplicate_manifest_id",
        "{parsed}"
    );
}

/// `context.custom` is a per-policy schema extension. Two healthy matching
/// bundles may legitimately use the same custom field name; materialization
/// must isolate them per bundle instead of treating the shared field as a
/// global overwrite fault.
#[test]
fn evaluate_action_v2_custom_context_field_collision_is_per_bundle() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [
                { "policy": warn_policy(), "manifest": swap_manifest() },
                {
                    "policy": "permit(principal, action, resource);",
                    "manifest": swap_manifest_with_id("large-swap-usd-warning-copy")
                }
            ],
            "results": {
                "large-swap-usd-warning::total-input-usd": { "usd": "1500.0000" },
                "large-swap-usd-warning-copy::total-input-usd": { "usd": "1.0000" }
            }
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
            parsed["data"]["verdict"]["kind"], "warn",
            "shared custom field names across healthy bundles must not blanket-fail projection: {parsed}"
        );
    let ids: Vec<&str> = parsed["data"]["verdict"]["matched"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|matched| matched["policy_id"].as_str())
        .collect();
    assert!(ids.contains(&"large-input"), "{parsed}");
}

/// A broken bundle must NOT poison a sibling HEALTHY policy that passes. The
/// `only-usdt` forbid does not fire on the WETH sample (Pass), so with the
/// broken bundle quarantined the aggregate is `warn` — pre-fix the broken
/// bundle's `?` short-circuited the whole function to a blanket `__engine` Fail.
#[test]
fn evaluate_action_v2_broken_bundle_does_not_poison_healthy_pass() {
    let (body, meta) = swap_sample();
    let healthy_pass = format!(
        "@id(\"only-usdt\")\n@severity(\"deny\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ context has tokenOut && context.tokenOut.key has address \
             && context.tokenOut.key.address == \"{USDT}\" }};\n"
    );
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [
                { "policy": broken_schema_policy(), "manifest": dashboard_manifest("broken") },
                { "policy": healthy_pass, "manifest": dashboard_manifest("only-usdt") }
            ],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["kind"], "warn",
        "a healthy pass must not be flipped to a deny by a sibling broken bundle: {parsed}"
    );
}

/// A healthy DENY still fires even when a SIBLING bundle is broken and listed
/// FIRST: pre-fix the broken bundle's `?` exited before the deny was ever
/// evaluated (blanket `__engine` fail, real deny absent). Post-fix the broken
/// bundle is quarantined and `block-non-usdt` is evaluated and present in the
/// matched set (deny-overrides → Fail).
#[test]
fn evaluate_action_v2_healthy_deny_survives_broken_bundle() {
    let (body, meta) = swap_sample();
    let healthy_deny = format!(
            "@id(\"block-non-usdt\")\n@severity(\"deny\")\n@reason(\"output token is not USDT\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ context has tokenOut \
             && !(context.tokenOut.key has address && context.tokenOut.key.address == \"{USDT}\") }};\n"
        );
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [
                { "policy": broken_schema_policy(), "manifest": dashboard_manifest("broken") },
                { "policy": healthy_deny, "manifest": dashboard_manifest("block-non-usdt") }
            ],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "fail", "{parsed}");
    let matched = parsed["data"]["verdict"]["matched"].as_array().unwrap();
    let ids: Vec<&str> = matched
        .iter()
        .filter_map(|m| m["policy_id"].as_str())
        .collect();
    assert!(
            ids.contains(&"block-non-usdt"),
            "the healthy deny must be evaluated despite a broken sibling listed first, got {ids:?}: {parsed}"
        );
}

#[test]
fn invalid_input_returns_error_envelope() {
    let out = plan_action_rpc_v2_json("not json".to_owned());
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "invalid_input_json", "{parsed}");
}

#[test]
fn plan_action_rpc_v2_rejects_too_many_manifests() {
    let (body, meta) = swap_sample();
    let manifests: Vec<Value> = (0..=MAX_POLICY_RPC_V2_MANIFESTS)
        .map(|i| dashboard_manifest(&format!("m{i}")))
        .collect();

    let out = plan_action_rpc_v2_json(
        json!({
            "manifests": manifests,
            "action": body,
            "meta": meta,
            "tx": tx(),
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();

    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "input_too_large", "{parsed}");
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("manifest/bundle count"),
        "{parsed}"
    );
}

#[test]
fn evaluate_action_v2_too_many_bundles_fails_closed() {
    let (body, meta) = swap_sample();
    let bundles: Vec<Value> = (0..=MAX_POLICY_RPC_V2_MANIFESTS)
        .map(|i| {
            json!({
                "policy": "permit(principal, action, resource);",
                "manifest": dashboard_manifest(&format!("m{i}"))
            })
        })
        .collect();

    let out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": tx(),
            "bundles": bundles,
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();

    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "fail", "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["matched"][0]["policy_id"], "__engine::input_too_large",
        "{parsed}"
    );
}

// ── Dashboard policy (Option B) — synthesized minimal manifest ──────────
//
// `policies-loader-v2.ts` projects each user-authored dashboard policy to a
// bundle whose manifest is the MINIMAL `{ id, schema_version: 2 }`: empty
// trigger (matches every action), no `policy_rpc`, no `custom_context`. The
// next two tests pin that exact shape through the real Cedar engine — a
// base-context `forbid` reading `context.tokenOut.key.address` compiles
// against the full base schema and evaluates conditionally on the token.

const USDT: &str = "0xdac17f958d2ee523a2206206994597c13d831ec7";

/// The minimal manifest `policies-loader-v2` synthesizes for a dashboard
/// policy id. Empty trigger ⇒ the Cedar head is the sole filter.
fn dashboard_manifest(id: &str) -> Value {
    json!({ "id": id, "schema_version": 2 })
}

/// Run `evaluate_action_v2_json` for the WETH-output `swap_sample` with one
/// dashboard bundle (synthesized manifest) and return the parsed envelope.
fn eval_dashboard(policy: &str, id: &str) -> Value {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": tx(),
            "bundles": [{ "policy": policy, "manifest": dashboard_manifest(id) }],
            "results": {}
        })
        .to_string(),
    );
    serde_json::from_str(&out).unwrap()
}

#[test]
fn evaluate_action_v2_unknown_domain_trigger_matches_hl_unknown_alias() {
    let now = Time::from_unix(1_738_000_000);
    let user = Address::from_str(FROM).unwrap();
    let body = ActionBody::HyperliquidCore(HyperliquidCoreAction::Unknown(HlUnknownAction {
        action_type: "unrecognizedCoreWriterAction".to_owned(),
    }));
    let meta = ActionMeta {
        submitted_at: now,
        submitter: user,
        nature: ActionNature::OnchainTx {
            chain: ChainId::new("eip155:999"),
            nonce: 1,
            gas_limit: U256::from(100_000u64),
            gas_price: LiveField::new(
                U256::from(1u64),
                DataSource::OracleFeed {
                    provider: OracleProvider::Pyth,
                    feed_id: "gas/hyperevm".into(),
                },
                now,
            ),
            value: U256::ZERO,
        },
    };
    let policy = "@id(\"unknown-blind-sign-warning\")\n@severity(\"warn\")\n\
             @reason(\"Unrecognized action\")\n\
             forbid(principal, action == Core::Action::\"Unknown\", resource)\n\
             when { context has actionType && context.actionType == \"unrecognizedCoreWriterAction\" };\n";
    let out = evaluate_action_v2_json(
        json!({
            "action": body,
            "meta": meta,
            "tx": { "chain_id": "eip155:999", "from": FROM, "to": TO },
            "bundles": [{
                "policy": policy,
                "manifest": {
                    "id": "unknown-blind-sign-warning",
                    "schema_version": 2,
                    "trigger": { "where": { "action.domain": { "eq": "unknown" } } }
                }
            }],
            "results": {}
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "warn", "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["matched"][0]["policy_id"], "unknown-blind-sign-warning",
        "{parsed}"
    );
}

/// HOLYMOLY shape: block a swap whose output token is NOT USDT. The sample
/// outputs WETH, so the `!= USDT` forbid fires → Fail (deny).
#[test]
fn evaluate_action_v2_dashboard_minimal_manifest_blocks_non_usdt_swap() {
    let policy = format!(
        "@id(\"block-non-usdt\")\n@severity(\"deny\")\n\
             @reason(\"output token is not USDT\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ context has tokenOut \
             && !(context.tokenOut.key has address \
             && context.tokenOut.key.address == \"{USDT}\") }};\n"
    );
    let parsed = eval_dashboard(&policy, "dashboard::block-non-usdt");
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "fail", "{parsed}");
    assert_eq!(
        parsed["data"]["verdict"]["matched"][0]["policy_id"], "block-non-usdt",
        "{parsed}"
    );
}

/// Control (inverted guard): forbid when output IS USDT. The WETH sample is
/// not USDT, so the `has address && == USDT` guard is false → forbid does
/// not fire → Pass. Proves the guard actually reads the token address rather
/// than firing unconditionally.
#[test]
fn evaluate_action_v2_dashboard_minimal_manifest_passes_when_guard_false() {
    let policy = format!(
        "@id(\"only-usdt\")\n@severity(\"deny\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when {{ context has tokenOut \
             && context.tokenOut.key has address \
             && context.tokenOut.key.address == \"{USDT}\" }};\n"
    );
    let parsed = eval_dashboard(&policy, "dashboard::only-usdt");
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(parsed["data"]["verdict"]["kind"], "pass", "{parsed}");
}

// ── A1 scope×position gate (multicall per-child fan-out) ─────────────────
//
// `evaluate_matching_bundles` decides, from the action's own shape, whether
// a bundle fires at THIS position: `Inner` (default) policies fire on a leaf
// and are SKIPPED on the multicall (they fire when the SW re-dispatches each
// child — `orchestrator.ts::evaluateBodyTree`); `Outer` policies fire on the
// multicall batch and are SKIPPED on a leaf. The four cases below form two
// controlled pairs that differ ONLY in manifest `scope`, with EMPTY triggers
// so trigger-matching is neutral and the scope gate alone decides — each skip
// case would fire were the gate absent (its sibling proves the policy fires).

/// Wrap the reference swap in a one-child `Multicall` (reusing its meta), so
/// one fixture drives both the leaf and the batch position.
fn multicall_of_swap() -> (ActionBody, ActionMeta) {
    let (swap_body, meta) = swap_sample();
    (
        ActionBody::Multicall {
            actions: vec![swap_body],
        },
        meta,
    )
}

/// Empty-trigger manifest, default (`Inner`) scope — matches every position.
fn always_inner_manifest() -> Value {
    json!({ "id": "always-inner", "schema_version": 2 })
}

/// Empty-trigger manifest, default (`Inner`) scope, with one required RPC.
/// On a multicall outer/batch position this bundle is skipped by scope, so
/// the required RPC must not be materialized there.
fn always_inner_required_rpc_manifest() -> Value {
    json!({
        "id": "always-inner-required-rpc",
        "schema_version": 2,
        "policy_rpc": [{
            "id": "must-not-run-on-batch",
            "method": "oracle.usd_value",
            "params": { "chain_id": "$.root.chain_id" },
            "outputs": []
        }]
    })
}

/// Empty-trigger manifest, `Outer` scope — matches every position.
fn always_outer_manifest() -> Value {
    json!({ "id": "always-outer", "schema_version": 2, "trigger": { "scope": "outer" } })
}

/// `forbid` on the swap leaf (`slippageBp > 10`; the fixture's 50 trips it).
fn swap_forbid_policy() -> &'static str {
    "@id(\"swap-guard\")\n@severity(\"warn\")\n@reason(\"swap leaf\")\n\
         forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
         when { context.slippageBp > 10 };\n"
}

/// `forbid` on the multicall batch (`childCount >= 1`; the fixture has 1).
fn multicall_forbid_policy() -> &'static str {
    "@id(\"batch-guard\")\n@severity(\"warn\")\n@reason(\"batch\")\n\
         forbid(principal, action == Core::Action::\"Multicall\", resource)\n\
         when { context.childCount >= 1 };\n"
}

fn verdict_kind(eval_out: &str) -> Value {
    let parsed: Value = serde_json::from_str(eval_out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    parsed["data"]["verdict"]["kind"].clone()
}

/// Inner policy + leaf swap → FIRES (the per-child position).
#[test]
fn scope_inner_fires_on_leaf_swap() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{ "policy": swap_forbid_policy(), "manifest": always_inner_manifest() }],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "warn",
        "inner policy must fire on a leaf swap: {out}"
    );
}

/// Inner policy + multicall → SKIPPED by the gate (it fires per-child).
/// Same policy + same multicall fires under `Outer` scope
/// (`scope_outer_fires_on_multicall`), so a `pass` here is the gate, not a
/// trigger/schema miss.
#[test]
fn scope_inner_skipped_on_multicall() {
    let (body, meta) = multicall_of_swap();
    let out = evaluate_action_v2_json(
            json!({
                "action": body, "meta": meta, "tx": tx(),
                "bundles": [{ "policy": multicall_forbid_policy(), "manifest": always_inner_manifest() }],
                "results": {}
            })
            .to_string(),
        );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "inner policy must be skipped on the multicall batch: {out}"
    );
}

/// Inner-scope also has to gate policy-RPC planning/materialization. A broad
/// Inner policy may require host facts for every child action, but the
/// multicall batch position itself is skipped; missing results for that
/// skipped position must not become a synthetic `__system__` Fail.
#[test]
fn scope_inner_required_rpc_skipped_on_multicall_batch_position() {
    let (body, meta) = multicall_of_swap();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{
                "policy": multicall_forbid_policy(),
                "manifest": always_inner_required_rpc_manifest()
            }],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "inner required RPC must be skipped on the multicall batch before materialization: {out}"
    );
}

/// Outer policy + multicall → FIRES (the batch position).
#[test]
fn scope_outer_fires_on_multicall() {
    let (body, meta) = multicall_of_swap();
    let out = evaluate_action_v2_json(
            json!({
                "action": body, "meta": meta, "tx": tx(),
                "bundles": [{ "policy": multicall_forbid_policy(), "manifest": always_outer_manifest() }],
                "results": {}
            })
            .to_string(),
        );
    assert_eq!(
        verdict_kind(&out),
        "warn",
        "outer policy must fire on the multicall batch: {out}"
    );
}

/// Outer policy + leaf swap → SKIPPED by the gate (batch-only policy).
/// Same policy + same swap fires under `Inner` scope
/// (`scope_inner_fires_on_leaf_swap`), so a `pass` here is the gate.
#[test]
fn scope_outer_skipped_on_leaf_swap() {
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{ "policy": swap_forbid_policy(), "manifest": always_outer_manifest() }],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "outer policy must be skipped on a standalone leaf swap: {out}"
    );
}

/// The per-child example set must stay structurally valid: every manifest
/// passes `ManifestV2::validate` and every Cedar policy COMPILES against its
/// synthesized per-policy schema (catching a base-field / action-uid typo,
/// an orphan custom-context field, or a bad enrichment projection).
///
/// The bundles are embedded INLINE (not `include_str!`) — the human-facing
/// copy lives at the gitignored build-output path
/// `browser-extension/public/default-policies/examples/per-child-multicall.example.json`
/// (alongside the equally-gitignored shipped `policy-set-v2.json`), so a
/// clone / CI would not have it. Keep this mirror in sync with that file.
/// Demonstrates each scope: three Inner bundles (swap-slippage,
/// transfer-allowlist, swap-usd-cap) + one Outer bundle (large-batch).
#[test]
fn per_child_example_bundles_compile() {
    let raw: &str = r##"[
  { "id": "swap-slippage-guard",
    "policy": "@id(\"swap-slippage-guard\")\n@severity(\"warn\")\n@reason(\"Swap slippage tolerance above 1% (100 bp)\")\nforbid(principal, action == Amm::Action::\"Swap\", resource)\nwhen { context.slippageBp > 100 };\n",
    "manifest": { "id": "swap-slippage-guard", "schema_version": 2,
      "trigger": { "where": { "action.tag": { "eq": "swap" } } } } },
  { "id": "transfer-recipient-allowlist",
    "policy": "@id(\"transfer-recipient-allowlist\")\n@severity(\"deny\")\n@reason(\"ERC-20 transfer recipient is not on the allow-list\")\nforbid(principal, action == Token::Action::\"Erc20Transfer\", resource)\nwhen {\n  !([\n    \"0xd8da6bf26964af9d7eed9e03e53415d37aa96045\",\n    \"0xae2fc483527b8ef99eb5d9b44875f005ba1fae13\"\n  ].contains(context.recipient))\n};\n",
    "manifest": { "id": "transfer-recipient-allowlist", "schema_version": 2,
      "trigger": { "where": { "action.tag": { "eq": "erc20_transfer" } } } } },
  { "id": "large-batch-warn",
    "policy": "@id(\"large-batch-warn\")\n@severity(\"warn\")\n@reason(\"Batch bundles more than 8 actions\")\nforbid(principal, action == Core::Action::\"Multicall\", resource)\nwhen { context.childCount > 8 };\n",
    "manifest": { "id": "large-batch-warn", "schema_version": 2,
      "trigger": { "scope": "outer", "where": { "action.domain": { "eq": "multicall" } } } } },
  { "id": "swap-usd-cap",
    "policy": "@id(\"swap-usd-cap\")\n@severity(\"warn\")\n@reason(\"Swap input value exceeds $5,000\")\nforbid(principal, action == Amm::Action::\"Swap\", resource)\nwhen {\n  context has custom &&\n  context.custom has inputUsd &&\n  context.custom.inputUsd.greaterThan(decimal(\"5000.0000\"))\n};\n",
    "manifest": { "id": "swap-usd-cap", "schema_version": 2,
      "trigger": { "where": { "action.tag": { "eq": "swap" } } },
      "policy_rpc": [ { "id": "input-usd", "method": "oracle.usd_value",
        "params": { "chain_id": "$.root.chain_id", "asset": "$.action.inputToken.asset", "amount": "$.action.inputToken.amount.value" },
        "outputs": [ { "kind": "context", "field": "inputUsd", "type": "Decimal", "from": "$.result.usd" } ] } ],
      "custom_context": { "fields": { "inputUsd": "decimal" } } } }
]"##;
    let bundles: Vec<Value> =
        serde_json::from_str(raw).expect("example bundles are a valid JSON array");
    assert_eq!(bundles.len(), 4, "example set has 4 bundles");

    for bundle in &bundles {
        let id = bundle["id"].as_str().expect("bundle id");
        let policy = bundle["policy"].as_str().expect("bundle policy text");
        let manifest: ManifestV2 = serde_json::from_value(bundle["manifest"].clone())
            .unwrap_or_else(|e| panic!("bundle `{id}` manifest parses as ManifestV2: {e}"));
        manifest
            .validate()
            .unwrap_or_else(|e| panic!("bundle `{id}` manifest is valid: {e}"));
        let schema = compose_per_policy(&manifest)
            .unwrap_or_else(|e| panic!("bundle `{id}` composes a per-policy schema: {e}"));
        PolicyEngine::build_from_per_policy(&[(policy.to_owned(), schema)])
            .unwrap_or_else(|e| panic!("bundle `{id}` Cedar must compile against its schema: {e}"));
    }
}

/// The SHIPPED default `high-slippage-warning` bundle (verbatim from
/// `browser-extension/public/default-policies/policy-set-v2.json`): an
/// Inner-scoped (no `trigger.scope` → default Inner) `forbid` on
/// `Amm::Action::"Swap"` when `slippageBp > 100`.
fn shipped_high_slippage_bundle() -> Value {
    json!({
        "policy": "@id(\"high-slippage-warning\")\n@severity(\"warn\")\nforbid(principal, action == Amm::Action::\"Swap\", resource)\nwhen { context.slippageBp > 100 };\n",
        "manifest": { "id": "high-slippage-warning", "schema_version": 2,
            "trigger": { "where": { "action.tag": { "eq": "swap" } } } }
    })
}

/// `swap_sample` but with a caller-chosen `slippage_bp` so the shipped
/// `slippageBp > 100` guard can be made to trip (150) or not (50).
fn swap_sample_with_slippage(bp: u32) -> (ActionBody, ActionMeta) {
    let (body, meta) = swap_sample();
    let ActionBody::Amm(AmmAction::Swap(mut swap)) = body else {
        unreachable!("swap_sample yields an amm swap")
    };
    swap.params.slippage_bp = bp;
    (ActionBody::Amm(AmmAction::Swap(swap)), meta)
}

/// END-TO-END (question stage c): the REAL shipped `high-slippage-warning`
/// Inner-scoped swap policy FIRES on a UR-style child swap (slippage 150 >
/// 100 → warn). This is the per-child position `evaluateBodyTree` re-enters
/// with: lower → trigger-match (`action.tag == "swap"`) → Cedar eval → warn.
#[test]
fn shipped_swap_policy_fires_on_child_swap_position() {
    let (body, meta) = swap_sample_with_slippage(150);
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [ shipped_high_slippage_bundle() ],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "warn",
        "shipped high-slippage policy must WARN on the child swap (slippage 150 > 100): {out}"
    );
}

/// END-TO-END control: same shipped Inner policy + the SAME swap wrapped in a
/// `Multicall` (the batch/Outer position) → SKIPPED by the scope gate (so it
/// PASSes here). Proves the Inner policy is routed to the child, NOT the
/// batch — `evaluateBodyTree` re-enters with the child where it fires (above).
#[test]
fn shipped_swap_policy_skipped_on_multicall_batch_position() {
    let (swap, meta) = swap_sample_with_slippage(150);
    let batch = ActionBody::Multicall {
        actions: vec![swap],
    };
    let out = evaluate_action_v2_json(
        json!({
            "action": batch, "meta": meta, "tx": tx(),
            "bundles": [ shipped_high_slippage_bundle() ],
            "results": {}
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "Inner swap policy must be SKIPPED on the multicall batch (fires per-child): {out}"
    );
}

// ── token_decimals → amountNano quantity-cap (the nano feature) ──────────
//
// With host-injected `token_decimals`, the lowering fills the base
// `direction.amountInNano` Long sibling, so a quantity-cap Cedar policy
// (`amountInNano >= N`) fires. Without decimals the field is omitted, so the
// `has`-guarded cap short-circuits to Pass (dormant) — proving the cap is
// driven by the injected decimals, not firing unconditionally.

/// The `swap_sample` sells 1_000_000_000 raw USDC (6dp) → nano 1e12. A cap
/// at 1e12 fires WITH decimals and is dormant WITHOUT them.
#[test]
fn evaluate_action_v2_amount_in_nano_cap_driven_by_token_decimals() {
    // `swap_sample`'s tokenIn is Arbitrum USDC (6 decimals).
    let usdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
    let policy = "@id(\"in-cap\")\n@severity(\"warn\")\n@reason(\"input amount cap\")\n\
             forbid(principal, action == Amm::Action::\"Swap\", resource)\n\
             when { context.direction has amountInNano \
             && context.direction.amountInNano >= 1000000000000 };\n";
    let manifest = json!({
        "id": "in-cap", "schema_version": 2,
        "trigger": { "where": { "action.tag": { "eq": "swap" } } }
    });

    // WITH decimals → amountInNano = 1e12 → cap (>= 1e12) → warn.
    let (body, meta) = swap_sample();
    let mut decimals = serde_json::Map::new();
    decimals.insert(usdc.to_owned(), json!(6));
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{ "policy": policy, "manifest": manifest }],
            "results": {},
            "token_decimals": Value::Object(decimals),
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "warn",
        "amountInNano cap must fire when token_decimals are injected: {out}"
    );

    // WITHOUT decimals → amountInNano omitted → has-guard false → pass.
    let (body, meta) = swap_sample();
    let out = evaluate_action_v2_json(
        json!({
            "action": body, "meta": meta, "tx": tx(),
            "bundles": [{ "policy": policy, "manifest": manifest }],
            "results": {},
        })
        .to_string(),
    );
    assert_eq!(
        verdict_kind(&out),
        "pass",
        "nano cap must be dormant without token_decimals: {out}"
    );
}
