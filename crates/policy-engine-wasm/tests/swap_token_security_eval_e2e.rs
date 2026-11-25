//! E2E: the five `token.security_flags` swap warnings in the policy catalog
//! (`policy_catalog_v2/action/swap/swap-buy-*`) evaluated through the literal
//! extension entry point `evaluate_action_v2_json`: lower the swap → plan the
//! `token.security_flags` call on `tokenOut` → replay the server's projection into
//! `context.custom` → Cedar → aggregate verdict.
//!
//! Each policy carries a user blank (`_template` in its manifest); the literal in
//! its `when` clause is the default. These tests pin, per policy, that a feed
//! value on the warning side of the default fires, one on the other side stays
//! quiet, and an omitted result (feed down / unsupported chain) stays quiet.
//!
//! Run: `cargo test -p policy-engine-wasm --test swap_token_security_eval_e2e`
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use serde_json::{json, Value};

use policy_engine_wasm::evaluate_action_v2_json;

const SUBMITTER: &str = "0x000000000000000000000000000000000000aaaa";

fn set_dir(id: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../policy-engine/tests/fixtures/policy_catalog_v2/action/swap")
        .join(id)
}

fn bundle(id: &str) -> Value {
    let dir = set_dir(id);
    let read = |f: &str| {
        std::fs::read_to_string(dir.join(f)).unwrap_or_else(|e| panic!("read {id}/{f}: {e}"))
    };
    json!({
        "policy": read("policy.cedar"),
        "manifest": serde_json::from_str::<Value>(&read("manifest.json")).expect("manifest parses"),
    })
}

/// USDC → WETH exact-input swap on Uniswap V3 (the day-1 SDK swap template).
fn swap_action() -> Value {
    let token = |address: &str| json!({ "key": { "standard": "erc20", "chain": "eip155:1", "address": address } });
    let live = |value: Value| json!({ "value": value, "source": { "kind": "user_supplied" }, "synced_at": 1_700_000_000u64 });
    json!({
        "domain": "amm",
        "action": "swap",
        "venue": { "name": "uniswap_v3", "chain": "eip155:1", "pool": "0x00000000000000000000000000000000deadbeef", "fee_tier_bp": 500 },
        "params": {
            "token_in": token("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
            "token_out": token("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
            "direction": { "kind": "exact_input", "amount_in": "0x1", "min_amount_out": "0x1" },
            "recipient": SUBMITTER,
            "slippage_bp": 50
        },
        "live_inputs": {
            "route": live(json!({ "paths": [] })),
            "expected_amount_out": live(json!("0x1")),
            "price_impact_bp": live(json!(0)),
            "gas_estimate": live(json!("0x30d40"))
        }
    })
}

fn meta() -> Value {
    json!({
        "submitted_at": 1_700_000_000u64,
        "submitter": SUBMITTER,
        "nature": {
            "kind": "onchain_tx",
            "chain": "eip155:1",
            "nonce": 1,
            "gas_limit": "0x30d40",
            "gas_price": { "value": "0x1", "source": { "kind": "user_supplied" }, "synced_at": 1_700_000_000u64 },
            "value": "0x0"
        }
    })
}

/// Evaluate `id` alone with the `token.security_flags` projection `feed`
/// (`None` = result omitted). Returns whether the policy matched.
fn fires(id: &str, feed: Option<Value>) -> bool {
    let results = match feed {
        Some(v) => json!({ format!("{id}::out-token-sec"): v }),
        None => json!({}),
    };
    let input = json!({
        "action": swap_action(),
        "meta": meta(),
        "tx": { "chain_id": "eip155:1", "from": SUBMITTER, "to": "0x00000000000000000000000000000000deadbeef" },
        "bundles": [bundle(id)],
        "results": results
    });
    let p: Value = serde_json::from_str(&evaluate_action_v2_json(input.to_string()))
        .expect("entry returns JSON");
    assert_eq!(p["ok"], true, "envelope not ok: {p}");
    let matched = p["data"]["verdict"]["matched"]
        .as_array()
        .is_some_and(|a| a.iter().any(|m| m["policy_id"].as_str() == Some(id)));
    let kind = p["data"]["verdict"]["kind"].as_str().unwrap_or("<none>");
    let expected_kind = if matched { "warn" } else { "pass" };
    assert_eq!(kind, expected_kind, "{id}: matched/kind disagree: {p}");
    matched
}

/// A clean server projection with `overrides` merged in.
fn feed(overrides: Value) -> Option<Value> {
    let mut base = json!({
        "tokenIsHoneypot": false, "tokenIsMalicious": false,
        "tokenOwnerPrivileges": [], "tokenCodeTraits": []
    });
    for (k, v) in overrides.as_object().unwrap() {
        base[k] = v.clone();
    }
    Some(base)
}

#[test]
fn unsellable_token_warns_on_honeypot_or_full_sell_tax() {
    let id = "swap-buy-unsellable-token";
    assert!(fires(id, feed(json!({ "tokenIsHoneypot": true }))));
    assert!(fires(id, feed(json!({ "tokenSellTaxBps": 10000 }))));
    assert!(!fires(id, feed(json!({ "tokenSellTaxBps": 9900 }))));
    assert!(!fires(id, None));
}

#[test]
fn high_buy_tax_warns_at_the_default_blank() {
    let id = "swap-buy-high-buy-tax";
    assert!(fires(id, feed(json!({ "tokenBuyTaxBps": 1000 }))));
    assert!(!fires(id, feed(json!({ "tokenBuyTaxBps": 500 }))));
    assert!(!fires(id, feed(json!({}))));
    assert!(!fires(id, None));
}

#[test]
fn owner_privileges_warn_only_for_listed_controls() {
    let id = "swap-buy-owner-privileged-token";
    assert!(fires(
        id,
        feed(json!({ "tokenOwnerPrivileges": ["mint", "balance_change"] }))
    ));
    assert!(fires(
        id,
        feed(json!({ "tokenOwnerPrivileges": ["take_back_ownership"] }))
    ));
    // `mint` is a choice the user can add, not in the default list.
    assert!(!fires(
        id,
        feed(json!({ "tokenOwnerPrivileges": ["mint"] }))
    ));
    assert!(!fires(id, None));
}

#[test]
fn code_traits_warn_only_for_listed_traits() {
    let id = "swap-buy-flagged-code-token";
    assert!(fires(
        id,
        feed(json!({ "tokenCodeTraits": ["closed_source"] }))
    ));
    assert!(!fires(id, feed(json!({ "tokenCodeTraits": ["proxy"] }))));
    assert!(!fires(id, None));
}

#[test]
fn honeypot_creator_warns_on_creator_history() {
    let id = "swap-buy-honeypot-creator-token";
    assert!(fires(
        id,
        feed(json!({ "tokenSameCreatorHoneypot": true, "tokenCreatorHoldBps": 0 }))
    ));
    assert!(!fires(
        id,
        feed(json!({ "tokenSameCreatorHoneypot": false, "tokenCreatorHoldBps": 5000 }))
    ));
    assert!(!fires(id, None));
}
