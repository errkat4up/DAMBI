use super::*;
use alloy_dyn_abi::{DynSolValue, JsonAbiExt};
use alloy_json_abi::Function;
use alloy_primitives::{Address as AlloyAddress, U256};
use serde_json::{json, Value};

// ──────────────────────────────────────────────────────────────────────
// Phase 4B — declarative_route_request_v3_json
// ──────────────────────────────────────────────────────────────────────

fn v3_route_input() -> Value {
    json!({
        "chain_id":    1,
        "to":          "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
        "selector":    "0x38ed1739",
        "calldata":    "0x38ed1739dead",
        "value":       "0",
        "gas_limit":   "200000",
        "gas_price":   "20000000000",
        "submitter":   "0x000000000000000000000000000000000000aaaa",
        "submitted_at": 1_700_000_000_u64,
        "nonce": 42_u64,
        "block_timestamp": 1_700_000_010_u64
    })
}

// ── Uniswap V2/V3 CREATE2 pool derivation ($resolved.pool injection) ──
// Golden anchors verified against on-chain pools (Etherscan); constants are
// 1st-party (v2/v3-periphery + Uniswap docs deployment pages).
const T_USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const T_WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const V3_USDC_WETH_500: &str = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const V2_USDC_WETH: &str = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";

#[test]
fn uniswap_v3_pool_create2_golden() {
    // Mainnet USDC/WETH 0.05% pool. Token order must not matter (sorted).
    assert_eq!(
        compute_uniswap_v3_pool(1, T_USDC, T_WETH, 500).as_deref(),
        Some(V3_USDC_WETH_500)
    );
    assert_eq!(
        compute_uniswap_v3_pool(1, T_WETH, T_USDC, 500).as_deref(),
        Some(V3_USDC_WETH_500)
    );
    // Base uses a different factory → a different (here just non-equal) pool.
    assert_ne!(
        compute_uniswap_v3_pool(8453, T_USDC, T_WETH, 500).as_deref(),
        Some(V3_USDC_WETH_500)
    );
    // Unsupported chain → None (dormant, never a wrong pool).
    assert_eq!(compute_uniswap_v3_pool(999, T_USDC, T_WETH, 500), None);
}

#[test]
fn uniswap_v2_pair_create2_golden() {
    assert_eq!(
        compute_uniswap_v2_pair(1, T_USDC, T_WETH).as_deref(),
        Some(V2_USDC_WETH)
    );
    assert_eq!(
        compute_uniswap_v2_pair(1, T_WETH, T_USDC).as_deref(),
        Some(V2_USDC_WETH)
    );
    // V2 is mainnet-only here (L2 init-hash not 1st-party) → None off-mainnet.
    assert_eq!(compute_uniswap_v2_pair(10, T_USDC, T_WETH), None);
}

#[test]
fn maybe_compute_uniswap_pool_dispatches_by_arg_shape() {
    // v3-nfpm mint shape: token0/token1/fee → V3 pool.
    let mint = json!({ "token0": T_USDC, "token1": T_WETH, "fee": 500 });
    assert_eq!(
        maybe_compute_uniswap_pool(1, &mint).as_deref(),
        Some(V3_USDC_WETH_500)
    );
    // swap-router exactInputSingle shape: tokenIn/tokenOut/fee → V3 pool.
    let swap = json!({ "tokenIn": T_WETH, "tokenOut": T_USDC, "fee": 500 });
    assert_eq!(
        maybe_compute_uniswap_pool(1, &swap).as_deref(),
        Some(V3_USDC_WETH_500)
    );
    // v2-router addLiquidity shape: tokenA/tokenB (no fee) → V2 pair.
    let add = json!({ "tokenA": T_USDC, "tokenB": T_WETH });
    assert_eq!(
        maybe_compute_uniswap_pool(1, &add).as_deref(),
        Some(V2_USDC_WETH)
    );
    // token0/token1 WITHOUT a fee, and an unrelated shape → None (no inject).
    assert_eq!(
        maybe_compute_uniswap_pool(1, &json!({ "token0": T_USDC, "token1": T_WETH })),
        None
    );
    assert_eq!(
        maybe_compute_uniswap_pool(1, &json!({ "marketParams": [] })),
        None
    );
}

#[test]
fn route_request_v3_misses_without_v3_install() {
    let registry = DecoderRegistry::default();
    // M2 contract: a callkey with no v3 manifest installed surfaces
    // `no_declarative_v3_mapper` so the SW caller can surface the gap.
    let out = registry.declarative_route_request_v3_json(v3_route_input().to_string());
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(
        parsed["error"]["kind"], "no_declarative_v3_mapper",
        "{parsed}"
    );
}

#[test]
fn route_request_v3_rejects_invalid_json() {
    let registry = DecoderRegistry::default();
    let out = registry.declarative_route_request_v3_json("{not json".to_owned());
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "invalid_input_json");
}

#[test]
fn route_request_v3_rejects_invalid_address() {
    let registry = DecoderRegistry::default();
    let mut input = v3_route_input();
    input["submitter"] = json!("not-an-address");
    let out = registry.declarative_route_request_v3_json(input.to_string());
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "invalid_input_json");
    let message = parsed["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("submitter"),
        "expected submitter diagnostic, got: {message}"
    );
}

#[test]
fn route_request_v3_serde_defaults_round_trip_through_miss() {
    let registry = DecoderRegistry::default();
    // Pin the serde defaults for `value` / `gas_limit` / `gas_price` /
    // `nonce` — they're still part of the wire contract even though the
    // miss path never builds the meta. We assert via the error envelope:
    // the early-parse stage succeeds (no `invalid_input_json` kind) and
    // the bridge lookup is what fails.
    let input = json!({
        "chain_id":    8453,
        "to":          "0x0000000000000000000000000000000000001234",
        "selector":    "0x12345678",
        "calldata":    "0x12345678",
        "submitter":   "0x000000000000000000000000000000000000aaaa",
        "submitted_at": 1_700_000_000_u64
    });
    let out = registry.declarative_route_request_v3_json(input.to_string());
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    // Bridge miss — the defaults parsed successfully (no
    // `invalid_input_json` from the U256 / address parsers above).
    assert_eq!(
        parsed["error"]["kind"], "no_declarative_v3_mapper",
        "{parsed}"
    );
}

#[test]
fn declarative_install_replaces_existing_bridge_for_same_callkey() {
    let mut registry = DecoderRegistry::default();
    // Registry entries can be updated or version-bumped while a WASM module
    // is alive. Re-installing the same (chain,to,selector) must route to the
    // latest bundle, not the first bundle that populated the bridge.
    let contract = "0x000000000000000000000000000000000000f00d";
    let submitter = "0x000000000000000000000000000000000000aaaa";
    let f = Function::parse("replaceMe(uint256)").unwrap();
    let calldata = f
        .abi_encode_input(&[DynSolValue::Uint(U256::from(7_u64), 256)])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));
    let make_bundle = |id: &str| {
        json!({
            "type": "adapter_action",
            "id": id,
            "publisher": "test",
            "schema_version": "3",
            "match": {
                "selector": selector,
                "chain_to_addresses": { "1": [contract] }
            },
            "abi_fragment": {
                "function_name": "replaceMe",
                "abi": {
                    "name": "replaceMe",
                    "type": "function",
                    "stateMutability": "nonpayable",
                    "inputs": [{ "name": "amount", "type": "uint256" }],
                    "outputs": []
                }
            },
            "emit": {
                "strategy": "single_emit",
                "body": {
                    "domain": "unknown",
                    "unknown": {
                        "target": "$to",
                        "chain": "$chain",
                        "calldata": "$calldata",
                        "value": "$tx.value"
                    }
                }
            },
            "requires": {
                "imperative": [],
                "adapter_capabilities": [],
                "host_capabilities": [],
                "extension": ">=0.1.0"
            }
        })
    };

    let first: Value = serde_json::from_str(
        &registry.declarative_install_v3_json(make_bundle("test/replace-a@1.0.0").to_string()),
    )
    .unwrap();
    assert_eq!(first["ok"], true, "{first}");
    let second: Value = serde_json::from_str(
        &registry.declarative_install_v3_json(make_bundle("test/replace-b@2.0.0").to_string()),
    )
    .unwrap();
    assert_eq!(second["ok"], true, "{second}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1,
            "to": contract,
            "selector": selector,
            "calldata": calldata_hex,
            "submitter": submitter,
            "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["decoder_id"], "test/replace-b@2.0.0",
        "bridge must point at the latest install, not the first one: {parsed}"
    );
}

// ──────────────────────────────────────────────────────────────────────
// N2/N3/K3 — a batch leg the decoder cannot map must surface as `Unknown`
// (warn-closed downstream), NOT be silently dropped (which let a benign
// sibling, or an empty batch, aggregate to PASS).
// ──────────────────────────────────────────────────────────────────────

#[test]
fn opcode_stream_all_unknown_warn_closes_not_empty_multicall() {
    // An opcode stream whose commands are ALL unmapped used to drop every leg
    // and return an EMPTY Multicall — which aggregates to PASS (N2 fail-open).
    // Each unmapped opcode under `warn` now surfaces an `Unknown` leg, so the
    // stream warn-closes (here: a single-opcode stream → Multicall[Unknown]).
    let args = json!({});
    let ctx = V3MapContext {
        chain: V3ChainId::new("eip155:1".to_string()),
        tx_to: parse_v3_address("0x000000000000000000000000000000000000babe", "to").unwrap(),
        tx_from: parse_v3_address("0x000000000000000000000000000000000000aaaa", "from").unwrap(),
        value: V3U256::ZERO,
        submitted_at: V3Time::from_unix(1_700_000_000),
        args_json: &args,
        raw_calldata: "0xabcdef",
        resolved: std::collections::BTreeMap::new(),
        derived: std::collections::BTreeMap::new(),
        inputs: None,
    };
    let per_opcode_body = serde_json::Map::new(); // nothing mapped → 0x01 unknown
    let commands = [0x01u8];
    let body = dispatch_opcode_stream(
        &ctx,
        &per_opcode_body,
        &commands,
        &[],
        0xff,
        0x00,
        V3UnknownOpcodePolicy::Warn,
        0,
        5,
    )
    .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    // Warn-closes: a Multicall carrying the Unknown leg (NOT an empty
    // Multicall that would aggregate to PASS).
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    let acts = body_json["actions"].as_array().unwrap();
    assert_eq!(acts.len(), 1, "{body_json}");
    assert_eq!(acts[0]["domain"], "unknown", "{body_json}");
}

#[test]
fn opcode_stream_partial_unmapped_leg_warn_closes_not_dropped() {
    // H2 regression guard: a PARTIAL decode (one MAPPED opcode + one UNMAPPED)
    // must keep the mapped leg AND carry an `Unknown` for the unmapped one, so
    // the whole stream warn-closes. Previously the unmapped leg was silently
    // dropped and the stream aggregated to PASS — the exact fund-redirect
    // fail-open (a SWEEP-to-attacker opcode hidden inside a benign swap).
    let args = json!({});
    let ctx = V3MapContext {
        chain: V3ChainId::new("eip155:1".to_string()),
        tx_to: parse_v3_address("0x000000000000000000000000000000000000babe", "to").unwrap(),
        tx_from: parse_v3_address("0x000000000000000000000000000000000000aaaa", "from").unwrap(),
        value: V3U256::ZERO,
        submitted_at: V3Time::from_unix(1_700_000_000),
        args_json: &args,
        raw_calldata: "0xabcdef",
        resolved: std::collections::BTreeMap::new(),
        derived: std::collections::BTreeMap::new(),
        inputs: None,
    };
    // 0x00 → a fully-literal (no `$args`) Erc20Transfer leg that builds with
    // no decoded inputs; 0x01 → unmapped (must warn-close, not vanish).
    let mut per_opcode_body = serde_json::Map::new();
    per_opcode_body.insert(
        "0x00".to_string(),
        json!({
            "body": {
                "domain": "token",
                "token": {
                    "action": "erc20_transfer",
                    "erc20_transfer": {
                        "token": { "key": { "standard": "erc20", "chain": "eip155:1",
                            "address": "0x000000000000000000000000000000000000c0de" } },
                        "recipient": "0x0000000000000000000000000000000000001234",
                        "amount": "0x1"
                    }
                }
            }
        }),
    );
    let commands = [0x00u8, 0x01u8];
    let body = dispatch_opcode_stream(
        &ctx,
        &per_opcode_body,
        &commands,
        &[],
        0xff,
        0x00,
        V3UnknownOpcodePolicy::Warn,
        0,
        5,
    )
    .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    let acts = body_json["actions"].as_array().unwrap();
    assert_eq!(
        acts.len(),
        2,
        "mapped leg kept AND unmapped leg surfaced (not dropped): {body_json}"
    );
    assert_eq!(acts[0]["domain"], "token", "{body_json}");
    assert_eq!(
        acts[1]["domain"], "unknown",
        "the unmapped opcode must warn-close as Unknown, not vanish: {body_json}"
    );
}

#[test]
fn array_emit_empty_array_routes_to_unknown_not_empty_multicall() {
    let mut registry = DecoderRegistry::default();
    // N2 catch-all: an `array_emit` over a length-0 dynamic array (Permit2
    // lockdown([]) / permitBatch([]) etc.) builds an empty Multicall, which
    // would aggregate to PASS. The route-level guard must surface it as Unknown
    // so it warn-closes. (An empty batch is an on-chain no-op — warn-closing
    // costs the user nothing; it just denies the silent PASS.)
    let contract = "0x000000000000000000000000000000000000c0de";
    let batch_fn = Function::parse("batch(uint256[] xs)").unwrap();
    let calldata = batch_fn
        .abi_encode_input(&[DynSolValue::Array(vec![])])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    let bundle = json!({
        "type": "adapter_action", "id": "test/array-emit-empty@1.0.0",
        "publisher": "test", "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [contract] } },
        "abi_fragment": { "function_name": "batch", "abi": {
            "name": "batch", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "xs", "type": "uint256[]" }], "outputs": [] } },
        "emit": { "strategy": "array_emit", "array_source": "$args.xs", "body": {
            "domain": "token", "token": { "action": "erc20_transfer", "erc20_transfer": {
                "token": { "key": { "standard": "erc20", "chain": "$chain", "address": "$to" } },
                "recipient": "$submitter", "amount": "$inputs" } } } },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": contract, "selector": selector, "calldata": calldata_hex,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["actions"][0]["body"]["domain"], "unknown",
        "empty array_emit must route to Unknown, not an empty Multicall (PASS): {parsed}"
    );
}

#[test]
fn array_emit_max_elements_routes_to_error() {
    let mut registry = DecoderRegistry::default();
    let contract = "0x000000000000000000000000000000000000c0df";
    let batch_fn = Function::parse("batchLimit(uint256[] xs)").unwrap();
    let calldata = batch_fn
        .abi_encode_input(&[DynSolValue::Array(vec![
            DynSolValue::Uint(U256::from(1_u64), 256),
            DynSolValue::Uint(U256::from(2_u64), 256),
        ])])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    let bundle = json!({
        "type": "adapter_action", "id": "test/array-emit-max@1.0.0",
        "publisher": "test", "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [contract] } },
        "abi_fragment": { "function_name": "batchLimit", "abi": {
            "name": "batchLimit", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "xs", "type": "uint256[]" }], "outputs": [] } },
        "emit": {
            "strategy": "array_emit",
            "array_source": "$args.xs",
            "max_elements": 1,
            "body": {
                "domain": "token", "token": { "action": "erc20_transfer", "erc20_transfer": {
                    "token": { "key": { "standard": "erc20", "chain": "$chain", "address": "$to" } },
                    "recipient": "$submitter", "amount": "$inputs" } } }
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": contract, "selector": selector, "calldata": calldata_hex,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(
        parsed["error"]["kind"], "build_array_emit_failed",
        "{parsed}"
    );
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("exceeding max_elements=1"),
        "{parsed}"
    );
}

#[test]
fn array_emit_missing_max_elements_uses_default_cap() {
    let mut registry = DecoderRegistry::default();
    let contract = "0x000000000000000000000000000000000000c0e1";
    let batch_fn = Function::parse("batchDefaultLimit(uint256[] xs)").unwrap();
    let values: Vec<DynSolValue> = (0..=DEFAULT_ARRAY_EMIT_MAX_ELEMENTS)
        .map(|i| DynSolValue::Uint(U256::from(i as u64), 256))
        .collect();
    let calldata = batch_fn
        .abi_encode_input(&[DynSolValue::Array(values)])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    let bundle = json!({
        "type": "adapter_action", "id": "test/array-emit-default-max@1.0.0",
        "publisher": "test", "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [contract] } },
        "abi_fragment": { "function_name": "batchDefaultLimit", "abi": {
            "name": "batchDefaultLimit", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "xs", "type": "uint256[]" }], "outputs": [] } },
        "emit": {
            "strategy": "array_emit",
            "array_source": "$args.xs",
            "body": {
                "domain": "token", "token": { "action": "erc20_transfer", "erc20_transfer": {
                    "token": { "key": { "standard": "erc20", "chain": "$chain", "address": "$to" } },
                    "recipient": "$submitter", "amount": "$inputs" } } }
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": contract, "selector": selector, "calldata": calldata_hex,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(
        parsed["error"]["kind"], "build_array_emit_failed",
        "{parsed}"
    );
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("exceeding max_elements=64"),
        "{parsed}"
    );
}

#[test]
fn array_emit_explicit_max_elements_over_hard_cap_is_invalid_bundle() {
    let mut registry = DecoderRegistry::default();
    let contract = "0x000000000000000000000000000000000000c0e2";
    let batch_fn = Function::parse("batchHardLimit(uint256[] xs)").unwrap();
    let calldata = batch_fn
        .abi_encode_input(&[DynSolValue::Array(vec![DynSolValue::Uint(
            U256::from(1_u64),
            256,
        )])])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    let bundle = json!({
        "type": "adapter_action", "id": "test/array-emit-hard-max@1.0.0",
        "publisher": "test", "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [contract] } },
        "abi_fragment": { "function_name": "batchHardLimit", "abi": {
            "name": "batchHardLimit", "type": "function", "stateMutability": "nonpayable",
            "inputs": [{ "name": "xs", "type": "uint256[]" }], "outputs": [] } },
        "emit": {
            "strategy": "array_emit",
            "array_source": "$args.xs",
            "max_elements": HARD_ARRAY_EMIT_MAX_ELEMENTS + 1,
            "body": {
                "domain": "token", "token": { "action": "erc20_transfer", "erc20_transfer": {
                    "token": { "key": { "standard": "erc20", "chain": "$chain", "address": "$to" } },
                    "recipient": "$submitter", "amount": "$inputs" } } }
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": contract, "selector": selector, "calldata": calldata_hex,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(parsed["error"]["kind"], "invalid_bundle", "{parsed}");
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("max_elements must be <= 64"),
        "{parsed}"
    );
}

#[test]
fn composite_array_emit_max_elements_routes_to_error() {
    let mut registry = DecoderRegistry::default();
    let contract = "0x000000000000000000000000000000000000c0e0";
    let combo_fn = Function::parse("comboLimit(uint256[] xs,uint256 y)").unwrap();
    let calldata = combo_fn
        .abi_encode_input(&[
            DynSolValue::Array(vec![
                DynSolValue::Uint(U256::from(1_u64), 256),
                DynSolValue::Uint(U256::from(2_u64), 256),
            ]),
            DynSolValue::Uint(U256::from(3_u64), 256),
        ])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&calldata[0..4]));
    let calldata_hex = format!("0x{}", hex::encode(&calldata));

    let bundle = json!({
        "type": "adapter_action", "id": "test/composite-array-emit-max@1.0.0",
        "publisher": "test", "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [contract] } },
        "abi_fragment": { "function_name": "comboLimit", "abi": {
            "name": "comboLimit", "type": "function", "stateMutability": "nonpayable",
            "inputs": [
                { "name": "xs", "type": "uint256[]" },
                { "name": "y", "type": "uint256" }
            ],
            "outputs": [] } },
        "emit": {
            "strategy": "composite_emit",
            "parts": [
                {
                    "strategy": "array_emit",
                    "array_source": "$args.xs",
                    "max_elements": 1,
                    "body": {
                        "domain": "token", "token": { "action": "erc20_transfer", "erc20_transfer": {
                            "token": { "key": { "standard": "erc20", "chain": "$chain", "address": "$to" } },
                            "recipient": "$submitter", "amount": "$inputs" } } }
                },
                {
                    "strategy": "single_emit",
                    "body": {
                        "domain": "unknown",
                        "unknown": {
                            "target": "$to",
                            "chain": "$chain",
                            "calldata": "$calldata",
                            "value": "$tx.value"
                        }
                    }
                }
            ]
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": contract, "selector": selector, "calldata": calldata_hex,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(
        parsed["error"]["kind"], "build_array_emit_failed",
        "{parsed}"
    );
    assert!(
        parsed["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("exceeding max_elements=1"),
        "{parsed}"
    );
}

#[test]
fn typed_data_array_emit_empty_array_routes_to_unknown_not_empty_multicall() {
    let mut registry = DecoderRegistry::default();
    // Same N2 guard as calldata, but through the EIP-712 route. Permit2
    // PermitBatch-style typed-data manifests use array_emit; an empty batch
    // must not become a PASS-valued empty Multicall.
    let permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
    let submitter = "0x000000000000000000000000000000000000aaaa";

    let bundle = json!({
        "type": "adapter_action",
        "id": "test/typed-array-emit-empty@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": {
            "selector": "0x000000aa",
            "chain_to_addresses": { "1": [permit2] },
            "typed_data": {
                "domain_name": "Permit2",
                "verifying_contract": permit2,
                "primary_type": "PermitBatchEmptyAudit",
                "types": {
                    "PermitBatchEmptyAudit": [
                        { "name": "details", "type": "PermitDetails[]" },
                        { "name": "spender", "type": "address" },
                        { "name": "sigDeadline", "type": "uint256" }
                    ],
                    "PermitDetails": [
                        { "name": "token", "type": "address" },
                        { "name": "amount", "type": "uint160" },
                        { "name": "expiration", "type": "uint48" },
                        { "name": "nonce", "type": "uint48" }
                    ]
                }
            }
        },
        "abi_fragment": {
            "function_name": "permit",
            "abi": {
                "name": "permit",
                "type": "function",
                "inputs": [
                    { "name": "owner", "type": "address" },
                    {
                        "name": "permitBatch",
                        "type": "tuple",
                        "components": [
                            {
                                "name": "details",
                                "type": "tuple[]",
                                "components": [
                                    { "name": "token", "type": "address" },
                                    { "name": "amount", "type": "uint160" },
                                    { "name": "expiration", "type": "uint48" },
                                    { "name": "nonce", "type": "uint48" }
                                ]
                            },
                            { "name": "spender", "type": "address" },
                            { "name": "sigDeadline", "type": "uint256" }
                        ]
                    },
                    { "name": "signature", "type": "bytes" }
                ]
            }
        },
        "emit": {
            "strategy": "array_emit",
            "array_source": "$args.permitBatch[0]",
            "body": {
                "domain": "token",
                "token": {
                    "action": "permit2_sign_allowance",
                    "permit2_sign_allowance": {
                        "token": {
                            "key": {
                                "standard": "erc20",
                                "chain": "$chain",
                                "address": "$inputs[0]"
                            }
                        },
                        "spender": "$args.permitBatch[1]",
                        "amount": "$inputs[1]",
                        "expires_at": "$inputs[2]",
                        "sig_deadline": "$args.permitBatch[2]",
                        "nonce": "$inputs[3]"
                    }
                }
            }
        },
        "requires": {
            "imperative": [],
            "adapter_capabilities": [],
            "host_capabilities": [],
            "extension": ">=0.1.0"
        }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let out = registry.declarative_route_typed_data_v3_json(
        json!({
            "chain_id": 1,
            "verifying_contract": permit2,
            "primary_type": "PermitBatchEmptyAudit",
            "domain_name": "Permit2",
            "message": {
                "details": [],
                "spender": "0x000000000000000000000000000000000000b0b0",
                "sigDeadline": "1700000300"
            },
            "submitter": submitter,
            "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true, "{parsed}");
    assert_eq!(
        parsed["data"]["actions"][0]["body"]["domain"], "unknown",
        "typed-data empty array_emit must route to Unknown, not an empty Multicall (PASS): {parsed}"
    );
}

// ──────────────────────────────────────────────────────────────────────
// Address-agnostic (selector-only) route tier — standard NFT
// `setApprovalForAll`. Decodes on ANY collection, registered or not, so the
// #1 NFT-drain vector is no longer warn-closed for unlisted collections.
// ──────────────────────────────────────────────────────────────────────

fn set_approval_for_all_agnostic_bundle() -> Value {
    json!({
        "type": "adapter_action",
        "id": "standard/nft/set-approval-for-all@1.0.0",
        "schema_version": "3",
        "match": { "selector": "0xa22cb465", "address_agnostic": true, "chain_ids": [1] },
        "abi_fragment": { "function_name": "setApprovalForAll", "abi": {
            "name": "setApprovalForAll", "type": "function", "stateMutability": "nonpayable",
            "inputs": [
                { "name": "operator", "type": "address" },
                { "name": "approved", "type": "bool" }
            ],
            "outputs": [] } },
        "emit": { "strategy": "single_emit", "body": {
            "domain": "token", "token": {
                "action": "nft_set_approval_for_all",
                "nft_set_approval_for_all": {
                    "chain": "$chain", "contract": "$to",
                    "spender": "$args.operator", "approved": "$args.approved" } } },
            "live_inputs": {} },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    })
}

#[test]
fn address_agnostic_set_approval_for_all_decodes_on_unregistered_collection() {
    let mut registry = DecoderRegistry::default();
    let installed: Value = serde_json::from_str(
        &registry.declarative_install_v3_json(set_approval_for_all_agnostic_bundle().to_string()),
    )
    .unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    // A collection address NEVER registered as a per-address callkey.
    let collection = "0x000000000000000000000000000000000000beef";
    let operator = "0x000000000000000000000000000000000000cafe";
    // setApprovalForAll(operator, approved=true)
    let calldata = format!(
        "0xa22cb465{:0>64}{:0>64}",
        operator.trim_start_matches("0x"),
        "1"
    );

    let out = registry.declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": collection, "selector": "0xa22cb465", "calldata": calldata,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        parsed["ok"], true,
        "address-agnostic decode must hit on an unregistered collection: {parsed}"
    );

    // ActionBody serializes FLAT (internally tagged on domain + action):
    // {domain:"token", action:"nft_set_approval_for_all", chain, contract, spender, approved}.
    let body = &parsed["data"]["actions"][0]["body"];
    assert_eq!(body["domain"], "token", "{body}");
    assert_eq!(body["action"], "nft_set_approval_for_all", "{body}");
    assert_eq!(
        body["contract"].as_str().unwrap().to_lowercase(),
        collection,
        "contract must be the live tx `to` (the collection) — proves address-agnostic routing: {body}"
    );
    assert_eq!(
        body["spender"].as_str().unwrap().to_lowercase(),
        operator,
        "{body}"
    );
    assert_eq!(body["approved"], true, "{body}");
}

/// TRUST BOUNDARY (WP4): an address-agnostic install for a NON-allowlisted
/// selector — here erc20 `approve` `0x095ea7b3` — must be REFUSED. Otherwise a
/// compromised / MITM'd registry could register an any-contract decoder for a
/// fungible selector and force every such call through an attacker-chosen
/// bundle. The allowlisted `setApprovalForAll` agnostic install still succeeds
/// (`address_agnostic_set_approval_for_all_decodes_on_unregistered_collection`).
#[test]
fn agnostic_install_refused_for_non_allowlisted_selector() {
    let mut registry = DecoderRegistry::default();
    let mut bundle = set_approval_for_all_agnostic_bundle();
    bundle["match"]["selector"] = json!("0x095ea7b3"); // erc20 approve — NOT allowlisted
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], false, "{installed}");
    assert_eq!(
        installed["error"]["kind"], "agnostic_selector_not_allowed",
        "{installed}"
    );
}

#[test]
fn address_agnostic_bridge_is_chain_scoped_not_a_catch_all() {
    let mut registry = DecoderRegistry::default();
    // The selector-only fallback stays keyed by `(chain_id, selector)`: the
    // same selector on a chain the bundle did NOT declare still misses
    // (warn-closed), proving the tier is not a blanket selector wildcard.
    let installed: Value = serde_json::from_str(
        &registry.declarative_install_v3_json(set_approval_for_all_agnostic_bundle().to_string()),
    )
    .unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let calldata = format!(
        "0xa22cb465{:0>64}{:0>64}",
        "000000000000000000000000000000000000cafe", "1"
    );
    let out = registry.declarative_route_request_v3_json(
        json!({
            // chain 999 is NOT in the bundle's `chain_ids: [1]`.
            "chain_id": 999, "to": "0x000000000000000000000000000000000000beef",
            "selector": "0xa22cb465", "calldata": calldata,
            "submitter": "0x000000000000000000000000000000000000aaaa", "submitted_at": 1_700_000_000_u64
        })
        .to_string(),
    );
    let parsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], false, "{parsed}");
    assert_eq!(
        parsed["error"]["kind"], "no_declarative_v3_mapper",
        "{parsed}"
    );
}

#[test]
fn multicall_recurse_uses_explicit_recurse_arg_when_sibling_arrays_exist() {
    let mut registry = DecoderRegistry::default();
    let router = "0x000000000000000000000000000000000000babe";
    let submitter = "0x000000000000000000000000000000000000aaaa";
    let child_fn = Function::parse("foo(uint256)").unwrap();
    let child_calldata = child_fn
        .abi_encode_input(&[DynSolValue::Uint(U256::from(123_u64), 256)])
        .unwrap();
    let child_selector = format!("0x{}", hex::encode(&child_calldata[0..4]));
    let child_hex = format!("0x{}", hex::encode(&child_calldata));

    let child_bundle = json!({
        "type": "adapter_action",
        "id": "test/multicall-recurse-child@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": {
            "selector": child_selector,
            "chain_to_addresses": { "1": [router] }
        },
        "abi_fragment": {
            "function_name": "foo",
            "abi": {
                "name": "foo",
                "type": "function",
                "stateMutability": "nonpayable",
                "inputs": [{ "name": "amount", "type": "uint256" }],
                "outputs": []
            }
        },
        "emit": {
            "strategy": "single_emit",
            "body": {
                "domain": "unknown",
                "unknown": {
                    "target": "$to",
                    "chain": "$chain",
                    "calldata": "$calldata",
                    "value": "$tx.value"
                }
            }
        },
        "requires": {
            "imperative": [],
            "adapter_capabilities": [],
            "host_capabilities": [],
            "extension": ">=0.1.0"
        }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(child_bundle.to_string()))
            .unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let args = json!({
        "permitBatch": [],
        "permitSignatures": [],
        "permit2Batch": {
            "details": [],
            "spender": "0x0000000000000000000000000000000000000000",
            "sigDeadline": "0"
        },
        "permit2Signature": "0x",
        "multicallData": [child_hex]
    });

    let ambiguous = registry
        .build_multicall_recurse_body(
            1,
            router,
            submitter,
            1_700_000_000,
            &args,
            &json!({
                "strategy": "multicall_recurse",
                "recurse_rule_id": "self_array_bytes_last_arg",
                "max_depth": 3
            }),
        )
        .unwrap_err();
    assert!(
        ambiguous.message.contains("ambiguous"),
        "expected ambiguous sibling-array error, got {ambiguous:?}"
    );

    let body = registry
        .build_multicall_recurse_body(
            1,
            router,
            submitter,
            1_700_000_000,
            &args,
            &json!({
                "strategy": "multicall_recurse",
                "recurse_rule_id": "self_array_bytes_last_arg",
                "recurse_arg": "multicallData",
                "max_depth": 3
            }),
        )
        .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    assert_eq!(body_json["actions"].as_array().unwrap().len(), 1);
    assert_eq!(body_json["actions"][0]["domain"], "unknown", "{body_json}");
}

#[test]
fn multicall_recurse_unmapped_child_surfaces_unknown_instead_of_dropping() {
    let mut registry = DecoderRegistry::default();
    let router = "0x000000000000000000000000000000000000ba01";
    let submitter = "0x000000000000000000000000000000000000aaaa";
    let child_fn = Function::parse("mappedChild(uint256)").unwrap();
    let child_calldata = child_fn
        .abi_encode_input(&[DynSolValue::Uint(U256::from(123_u64), 256)])
        .unwrap();
    let child_selector = format!("0x{}", hex::encode(&child_calldata[0..4]));
    let child_hex = format!("0x{}", hex::encode(&child_calldata));
    let unmapped_hex = "0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001";

    let child_bundle = json!({
        "type": "adapter_action",
        "id": "test/multicall-recurse-mapped-child@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": {
            "selector": child_selector,
            "chain_to_addresses": { "1": [router] }
        },
        "abi_fragment": {
            "function_name": "mappedChild",
            "abi": {
                "name": "mappedChild",
                "type": "function",
                "stateMutability": "nonpayable",
                "inputs": [{ "name": "amount", "type": "uint256" }],
                "outputs": []
            }
        },
        "emit": {
            "strategy": "single_emit",
            "body": {
                "domain": "unknown",
                "unknown": {
                    "target": "$to",
                    "chain": "$chain",
                    "calldata": "$calldata",
                    "value": "$tx.value"
                }
            }
        },
        "requires": {
            "imperative": [],
            "adapter_capabilities": [],
            "host_capabilities": [],
            "extension": ">=0.1.0"
        }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(child_bundle.to_string()))
            .unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let args = json!({ "multicallData": [child_hex, unmapped_hex] });
    let body = registry
        .build_multicall_recurse_body(
            1,
            router,
            submitter,
            1_700_000_000,
            &args,
            &json!({
                "strategy": "multicall_recurse",
                "recurse_rule_id": "self_array_bytes_last_arg",
                "recurse_arg": "multicallData",
                "max_depth": 3
            }),
        )
        .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    let actions = body_json["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 2, "{body_json}");
    assert_eq!(actions[0]["domain"], "unknown", "{body_json}");
    assert_eq!(
        actions[0]["calldata"], args["multicallData"][0],
        "{body_json}"
    );
    assert_eq!(actions[1]["domain"], "unknown", "{body_json}");
    assert_eq!(
        actions[1]["calldata"],
        json!(unmapped_hex),
        "unmapped child must remain policy-visible as Unknown, not vanish: {body_json}"
    );
}

/// `parallel_tagged_dispatch` end-to-end: a Compound v3
/// `Bulker.invoke(bytes32[] actions, bytes[] data)` with two index-aligned
/// legs (`ACTION_SUPPLY_ASSET` + `ACTION_CLAIM_REWARD`) decodes — through the
/// real install + route path — to a `Multicall` of one `lending::supply` and
/// one `airdrop::claim`. Crucially asserts the per-element `resolve_from_inputs`
/// mechanism: `base_asset` is resolved from the DECODED `comet` (cUSDCv3 →
/// USDC), NOT from `$to` (the Bulker) — the wrinkle that makes the strategy
/// necessary.
#[test]
fn parallel_tagged_dispatch_bulker_invoke_fans_out_to_multicall() {
    let mut registry = DecoderRegistry::default();
    use alloy_primitives::B256;

    let bulker = "0xa397a8c2086c554b531c02e29f3291c9704b00c7";
    let comet = "0xc3d688b66703497daa19211eedff47f25384cdc3"; // cUSDCv3 → base USDC
    let usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    let user = "0x000000000000000000000000000000000000aaaa";
    let asset = "0x1111111111111111111111111111111111111111";
    let rewards = "0x1b0e765f6224c21223aea2af16c1c46e38885a40"; // CometRewards mainnet
    let src = "0x000000000000000000000000000000000000bbbb";

    // bytes32 ASCII tags (right-zero-padded action names).
    let tag = |name: &str| -> B256 {
        let mut b = [0u8; 32];
        b[..name.len()].copy_from_slice(name.as_bytes());
        B256::from(b)
    };

    // data[i] = abi.encode(...) — params encoding (selector-stripped).
    let params_enc = |sig: &str, vals: &[DynSolValue]| -> Vec<u8> {
        let f = Function::parse(sig).unwrap();
        f.abi_encode_input(vals).unwrap()[4..].to_vec()
    };
    let supply_data = params_enc(
        "x(address,address,address,uint256)",
        &[
            DynSolValue::Address(comet.parse().unwrap()),
            DynSolValue::Address(user.parse().unwrap()),
            DynSolValue::Address(asset.parse().unwrap()),
            DynSolValue::Uint(U256::from(5000_u64), 256),
        ],
    );
    let claim_data = params_enc(
        "x(address,address,address,bool)",
        &[
            DynSolValue::Address(comet.parse().unwrap()),
            DynSolValue::Address(rewards.parse().unwrap()),
            DynSolValue::Address(src.parse().unwrap()),
            DynSolValue::Bool(true),
        ],
    );

    // outer invoke(bytes32[],bytes[]) calldata.
    let invoke_fn = Function::parse("invoke(bytes32[],bytes[])").unwrap();
    let invoke_cd = invoke_fn
        .abi_encode_input(&[
            DynSolValue::Array(vec![
                DynSolValue::FixedBytes(tag("ACTION_SUPPLY_ASSET"), 32),
                DynSolValue::FixedBytes(tag("ACTION_CLAIM_REWARD"), 32),
            ]),
            DynSolValue::Array(vec![
                DynSolValue::Bytes(supply_data),
                DynSolValue::Bytes(claim_data),
            ]),
        ])
        .unwrap();
    let invoke_selector = format!("0x{}", hex::encode(&invoke_cd[0..4]));
    let invoke_hex = format!("0x{}", hex::encode(&invoke_cd));

    let bundle = json!({
        "type": "adapter_action",
        "id": "test/bulker-invoke@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": {
            "selector": invoke_selector,
            "chain_to_addresses": { "1": [bulker] }
        },
        "abi_fragment": {
            "function_name": "invoke",
            "abi": {
                "name": "invoke",
                "type": "function",
                "stateMutability": "payable",
                "inputs": [
                    { "name": "actions", "type": "bytes32[]" },
                    { "name": "data", "type": "bytes[]" }
                ],
                "outputs": []
            }
        },
        "emit": {
            "strategy": "parallel_tagged_dispatch",
            "actions_source": "$args.actions",
            "data_source": "$args.data",
            "tag_encoding": "bytes32_ascii",
            "max_elements": 32,
            "unknown_tag_policy": "warn",
            "resolve_from_inputs": { "compound_v3_base_asset": "comet" },
            "per_tag": {
                "ACTION_SUPPLY_ASSET": {
                    "inputs_abi": "(address comet, address to, address asset, uint256 amount)",
                    "body": {
                        "domain": "lending",
                        "lending": {
                            "action": "supply",
                            "supply": {
                                "venue": {
                                    "name": "compound_v3",
                                    "chain": "$chain",
                                    "comet": "$inputs.comet",
                                    "base_asset": { "key": { "standard": "erc20", "chain": "$chain", "address": "$resolved.compound_v3_base_asset" } }
                                },
                                "asset": { "key": { "standard": "erc20", "chain": "$chain", "address": "$inputs.asset" } },
                                "amount": "$inputs.amount",
                                "on_behalf_of": "$inputs.to"
                            }
                        }
                    },
                    "live_inputs": {
                        "reserve_state": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_reserve_state" }, "ttl_s": 30 },
                        "supply_apy": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_supply_apy" }, "ttl_s": 30 },
                        "a_token_price_usd": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_a_token_price_usd" }, "ttl_s": 60 },
                        "eligible_as_collat": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_eligible_as_collat" }, "ttl_s": 60 },
                        "user_state_before": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_user_state_before" }, "ttl_s": 12 }
                    }
                },
                "ACTION_CLAIM_REWARD": {
                    "inputs_abi": "(address comet, address rewards, address src, bool shouldAccrue)",
                    "body": {
                        "domain": "airdrop",
                        "airdrop": {
                            "action": "claim",
                            "claim": {
                                "source": { "name": "compound" },
                                "claim_target": { "kind": "staking_claim", "chain": "$chain", "contract": "$inputs.rewards" },
                                "recipient": "$inputs.src",
                                "proof": null,
                                "sig": null
                            }
                        }
                    },
                    "live_inputs": {
                        "is_still_claimable": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_is_still_claimable" }, "ttl_s": 30 },
                        "actual_amount": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_actual_amount" }, "ttl_s": 60 },
                        "claim_token": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_claim_token" }, "ttl_s": 60 },
                        "claim_window": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "compound_v3_claim_window" }, "ttl_s": 60 }
                    }
                }
            }
        },
        "requires": {
            "imperative": [],
            "adapter_capabilities": [],
            "host_capabilities": [],
            "extension": ">=0.1.0"
        }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(bundle.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let route_input = json!({
        "chain_id": 1,
        "to": bulker,
        "selector": invoke_selector,
        "calldata": invoke_hex,
        "value": "0",
        "submitter": user,
        "submitted_at": 1_700_000_000_u64
    });
    let out: Value =
        serde_json::from_str(&registry.declarative_route_request_v3_json(route_input.to_string()))
            .unwrap();
    assert_eq!(out["ok"], true, "{out}");

    // One routed Action whose body is a Multicall of the two legs.
    let routed = out["data"]["actions"].as_array().unwrap();
    assert_eq!(routed.len(), 1, "{out}");
    let body = &routed[0]["body"];
    assert_eq!(body["domain"], "multicall", "{body}");
    let children = body["actions"].as_array().unwrap();
    assert_eq!(children.len(), 2, "{body}");

    // Leg 0 — lending::supply, base_asset RESOLVED FROM the decoded comet.
    // ActionBody serialises internally-tagged (flat): `{domain, action, …}`.
    let c0 = &children[0];
    assert_eq!(c0["domain"], "lending", "{c0}");
    assert_eq!(c0["action"], "supply", "{c0}");
    assert_eq!(c0["venue"]["name"], "compound_v3", "{c0}");
    assert_eq!(c0["venue"]["comet"].as_str().unwrap().to_lowercase(), comet);
    assert_eq!(
        c0["venue"]["base_asset"]["key"]["address"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        usdc,
        "base_asset must resolve from $inputs.comet (cUSDCv3→USDC), not $to (the Bulker): {c0}"
    );
    assert_eq!(
        c0["asset"]["key"]["address"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        asset
    );
    let amount_hex = c0["amount"].as_str().unwrap();
    let amount = u64::from_str_radix(amount_hex.strip_prefix("0x").unwrap_or(amount_hex), 16)
        .unwrap_or_else(|_| panic!("amount not hex: {amount_hex}"));
    assert_eq!(amount, 5000, "{c0}");
    assert_eq!(c0["on_behalf_of"].as_str().unwrap().to_lowercase(), user);

    // Leg 1 — airdrop::claim, recipient = decoded src, target = decoded rewards.
    let c1 = &children[1];
    assert_eq!(c1["domain"], "airdrop", "{c1}");
    assert_eq!(c1["action"], "claim", "{c1}");
    assert_eq!(
        c1["recipient"].as_str().unwrap().to_lowercase(),
        src,
        "{c1}"
    );
    assert_eq!(
        c1["claim_target"]["contract"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        rewards,
        "{c1}"
    );
}

#[test]
fn multicall_call_array_routes_each_leg_by_its_own_to() {
    let mut registry = DecoderRegistry::default();
    // Per-leg-to: the child mapper is installed ONLY at `adapter`. If the
    // decode wrongly used a fixed outer `to` it would MISS — so a successful
    // decode structurally proves each leg is routed at its own `Call.to`.
    let adapter = "0x000000000000000000000000000000000000ada9";
    let submitter = "0x000000000000000000000000000000000000aaaa";
    let zero32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    let child_fn = Function::parse("foo(uint256)").unwrap();
    let child_calldata = child_fn
        .abi_encode_input(&[DynSolValue::Uint(U256::from(777_u64), 256)])
        .unwrap();
    let child_selector = format!("0x{}", hex::encode(&child_calldata[0..4]));
    let child_hex = format!("0x{}", hex::encode(&child_calldata));

    let child_bundle = json!({
        "type": "adapter_action",
        "id": "test/mca-child@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": { "selector": child_selector, "chain_to_addresses": { "1": [adapter] } },
        "abi_fragment": {
            "function_name": "foo",
            "abi": {
                "name": "foo", "type": "function", "stateMutability": "nonpayable",
                "inputs": [{ "name": "amount", "type": "uint256" }], "outputs": []
            }
        },
        "emit": {
            "strategy": "single_emit",
            "body": { "domain": "unknown", "unknown": {
                "target": "$to", "chain": "$chain", "calldata": "$calldata", "value": "$tx.value"
            } }
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(child_bundle.to_string()))
            .unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    // Decoded `Call[]` bundle: each leg is a POSITIONAL tuple array
    // [to, data, value, skipRevert, callbackHash]. One mapped leg → adapter.
    let args = json!({ "bundle": [[adapter, child_hex, "0", false, zero32]] });
    let body = registry
        .build_multicall_call_array_body(
            1,
            submitter,
            1_700_000_000,
            &args,
            &json!({ "strategy": "multicall_call_array", "recurse_arg": "bundle", "max_depth": 3 }),
        )
        .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    assert_eq!(body_json["actions"].as_array().unwrap().len(), 1);
    assert_eq!(body_json["actions"][0]["domain"], "unknown", "{body_json}");
    // (Per-leg-to is proven structurally: the child mapper is installed ONLY at
    // `adapter`, so a successful decode REQUIRES routing the leg at its own `to`.)

    // A bundle whose ONLY selector-bearing leg targets an uninstalled `to`
    // must still produce an Unknown leg. Dropping it would turn partial
    // decode into a misleading no-op.
    let unmapped = "0x000000000000000000000000000000000000dead";
    let only_unmapped = json!({ "bundle": [[unmapped, child_hex, "0", false, zero32]] });
    let body = registry
        .build_multicall_call_array_body(
            1,
            submitter,
            1_700_000_000,
            &only_unmapped,
            &json!({ "strategy": "multicall_call_array", "recurse_arg": "bundle" }),
        )
        .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    assert_eq!(body_json["actions"].as_array().unwrap().len(), 1);
    assert_eq!(body_json["actions"][0]["domain"], "unknown", "{body_json}");
    assert_eq!(
        body_json["actions"][0]["calldata"], child_hex,
        "unmapped selector-bearing Call[] leg must remain visible: {body_json}"
    );

    // Selector-less value/fallback legs have no route key but can still move
    // native value to `Call.to`; preserve them as Unknown too.
    let bare_value = json!({ "bundle": [[unmapped, "0x", "42", false, zero32]] });
    let body = registry
        .build_multicall_call_array_body(
            1,
            submitter,
            1_700_000_000,
            &bare_value,
            &json!({ "strategy": "multicall_call_array", "recurse_arg": "bundle" }),
        )
        .unwrap();
    let body_json = serde_json::to_value(body).unwrap();
    assert_eq!(body_json["domain"], "multicall", "{body_json}");
    assert_eq!(body_json["actions"].as_array().unwrap().len(), 1);
    assert_eq!(body_json["actions"][0]["domain"], "unknown", "{body_json}");
    assert_eq!(
        body_json["actions"][0]["target"],
        json!(unmapped),
        "{body_json}"
    );
    assert_eq!(
        body_json["actions"][0]["value"],
        json!("0x2a"),
        "bare value leg must retain its native value: {body_json}"
    );
}

#[test]
fn multicall_call_array_unknown_vault_metamorpho_fails_whole_bundle() {
    let mut registry = DecoderRegistry::default();
    // D-A: a GeneralAdapter1 `erc4626*` leg whose vault is OUTSIDE the
    // committed `metamorpho_underlying` snapshot cannot resolve its required
    // `asset` (the underlying is a runtime arg, not in calldata) → placeholder
    // substitution falls back to 0x0. We REFUSE the whole bundle rather than
    // emit a confidently-wrong 0x0-asset Supply. A KNOWN vault still decodes
    // with its real underlying (proving the guard is value-gated, not a blanket
    // metamorpho block).
    let adapter = "0x4a6c312ec70e8747a587ee860a0353cd42be0ae0"; // GeneralAdapter1
    let submitter = "0x000000000000000000000000000000000000aaaa";
    let zero32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    let erc4626 = Function::parse(
        "erc4626Deposit(address vault, uint256 assets, uint256 maxSharePriceE27, address receiver)",
    )
    .unwrap();
    let probe = erc4626
        .abi_encode_input(&[
            DynSolValue::Address(AlloyAddress::ZERO),
            DynSolValue::Uint(U256::ZERO, 256),
            DynSolValue::Uint(U256::ZERO, 256),
            DynSolValue::Address(AlloyAddress::ZERO),
        ])
        .unwrap();
    let selector = format!("0x{}", hex::encode(&probe[0..4]));

    // Synthetic copy of the real GA1 erc4626Deposit manifest (body +
    // live_inputs skeleton); only the `match` is test-local.
    let manifest = json!({
        "type": "adapter_action",
        "id": "test/mca-erc4626@1.0.0",
        "publisher": "test",
        "schema_version": "3",
        "match": { "selector": selector, "chain_to_addresses": { "1": [adapter] } },
        "abi_fragment": {
            "function_name": "erc4626Deposit",
            "abi": {
                "name": "erc4626Deposit", "type": "function", "stateMutability": "nonpayable",
                "inputs": [
                    { "name": "vault", "type": "address" },
                    { "name": "assets", "type": "uint256" },
                    { "name": "maxSharePriceE27", "type": "uint256" },
                    { "name": "receiver", "type": "address" }
                ],
                "outputs": []
            }
        },
        "emit": {
            "strategy": "single_emit",
            "body": { "domain": "lending", "lending": { "action": "supply", "supply": {
                "venue": { "name": "metamorpho", "chain": "$chain", "vault": "$args.vault" },
                "asset": { "key": { "standard": "erc20", "chain": "$chain", "address": "$derived.metamorpho_underlying" } },
                "amount": "$args.assets",
                "on_behalf_of": "$args.receiver"
            } } },
            "live_inputs": {
                "reserve_state": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "metamorpho_reserve_state_skeleton" }, "ttl_s": 30 },
                "supply_apy": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "metamorpho_supply_apy_skeleton" }, "ttl_s": 30 },
                "a_token_price_usd": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "metamorpho_share_price_skeleton" }, "ttl_s": 60 },
                "eligible_as_collat": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "metamorpho_collat_flag_skeleton" }, "ttl_s": 60 },
                "user_state_before": { "source": { "kind": "derived_from", "inputs": [], "calc_id": "metamorpho_user_state_skeleton" }, "ttl_s": 12 }
            }
        },
        "requires": { "imperative": [], "adapter_capabilities": [], "host_capabilities": [], "extension": ">=0.1.0" }
    });
    let installed: Value =
        serde_json::from_str(&registry.declarative_install_v3_json(manifest.to_string())).unwrap();
    assert_eq!(installed["ok"], true, "{installed}");

    let receiver: AlloyAddress = submitter.parse().unwrap();
    let emit =
        json!({ "strategy": "multicall_call_array", "recurse_arg": "bundle", "max_depth": 3 });
    let encode_leg = |vault: &str| -> String {
        let cd = erc4626
            .abi_encode_input(&[
                DynSolValue::Address(vault.parse().unwrap()),
                DynSolValue::Uint(U256::from(1_000_000_u64), 256),
                DynSolValue::Uint(U256::ZERO, 256),
                DynSolValue::Address(receiver),
            ])
            .unwrap();
        format!("0x{}", hex::encode(cd))
    };

    // KNOWN vault (snapshot[0]) → underlying resolves to USDC, decodes clean.
    let known_vault = "0x0b2d98bbf3e38df1d1b7be7343732e32e8b1f818";
    let known_underlying: AlloyAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        .parse()
        .unwrap();
    let known_bundle =
        json!({ "bundle": [[adapter, encode_leg(known_vault), "0", false, zero32]] });
    let body = registry
        .build_multicall_call_array_body(1, submitter, 1_700_000_000, &known_bundle, &emit)
        .expect("known-vault metamorpho leg should decode");
    let v3_action::ActionBody::Multicall { actions } = body else {
        panic!("expected a multicall body");
    };
    assert_eq!(actions.len(), 1);
    let v3_action::ActionBody::Lending(v3_action::lending::LendingAction::Supply(supply)) =
        &actions[0]
    else {
        panic!("expected a metamorpho supply leg, got {:?}", actions[0]);
    };
    assert_eq!(
        supply.asset.key.contract(),
        Some(&known_underlying),
        "known vault underlying must resolve from the snapshot"
    );

    // UNKNOWN vault (not in the snapshot) → underlying unresolved → the whole
    // bundle is REFUSED (no 0x0-asset Supply leaks through).
    let unknown_vault = "0x000000000000000000000000000000000000dead";
    let unknown_bundle =
        json!({ "bundle": [[adapter, encode_leg(unknown_vault), "0", false, zero32]] });
    let err = registry
        .build_multicall_call_array_body(1, submitter, 1_700_000_000, &unknown_bundle, &emit)
        .unwrap_err();
    assert!(
        err.message.contains("underlying unresolved"),
        "expected a metamorpho-underlying rejection, got {err:?}"
    );
}

#[test]
fn decode_reenter_call_array_decodes_callback_legs() {
    // The reenter callback is raw abi.encode(Call[]) (the route surfaces it as
    // `data.reenter_callback` via the manifest's `reenter_callback_arg`). The
    // decoder is protocol-agnostic — no selector knowledge. Build a 2-leg
    // callback and assert the positional Call[] decode.
    let a1 = AlloyAddress::from([0x11; 20]);
    let a2 = AlloyAddress::from([0x22; 20]);
    let mk_call = |to: AlloyAddress, sel: u32| {
        DynSolValue::Tuple(vec![
            DynSolValue::Address(to),
            DynSolValue::Bytes(sel.to_be_bytes().to_vec()),
            DynSolValue::Uint(U256::ZERO, 256),
            DynSolValue::Bool(false),
            DynSolValue::FixedBytes(alloy_primitives::B256::ZERO, 32),
        ])
    };
    // abi.encode(Call[]) == the args encoding of `reenter(Call[])` minus its
    // 4-byte selector.
    let reenter =
        Function::parse("reenter((address,bytes,uint256,bool,bytes32)[] bundle)").unwrap();
    let reenter_calldata = reenter
        .abi_encode_input(&[DynSolValue::Array(vec![
            mk_call(a1, 0xaabb_ccdd),
            mk_call(a2, 0x1122_3344),
        ])])
        .unwrap();
    let callback_hex = format!("0x{}", hex::encode(&reenter_calldata[4..]));

    let legs = decode_reenter_call_array(&callback_hex)
        .unwrap()
        .expect("non-empty callback");
    assert_eq!(legs.len(), 2, "callback Call[] should decode 2 legs");
    let leg_to = |i: usize| {
        legs[i].as_array().unwrap()[0]
            .as_str()
            .unwrap()
            .parse::<AlloyAddress>()
            .unwrap()
    };
    assert_eq!(leg_to(0), a1, "leg0 `to`");
    assert_eq!(leg_to(1), a2, "leg1 `to`");

    // Empty callback → None (a plain leg with no re-entry).
    assert!(decode_reenter_call_array("0x").unwrap().is_none());
    assert!(decode_reenter_call_array("").unwrap().is_none());
}

#[test]
fn decode_inputs_abi_tuple_handles_v4_path_key_arrays() {
    let currency_in = AlloyAddress::ZERO;
    let currency_out = AlloyAddress::from([0x22; 20]);
    let hook = AlloyAddress::from([0x33; 20]);
    let path = DynSolValue::Array(vec![DynSolValue::Tuple(vec![
        DynSolValue::Address(currency_out),
        DynSolValue::Uint(U256::from(500_u64), 24),
        DynSolValue::Int(alloy_primitives::I256::try_from(60_i64).unwrap(), 24),
        DynSolValue::Address(hook),
        DynSolValue::Bytes(vec![0xab, 0xcd]),
    ])]);
    let encoder =
        Function::parse("step(address,(address,uint24,int24,address,bytes)[],uint128,uint128)")
            .unwrap();
    let encoded = encoder
        .abi_encode_input(&[
            DynSolValue::Address(currency_in),
            path,
            DynSolValue::Uint(U256::from(1_000_u64), 128),
            DynSolValue::Uint(U256::from(900_u64), 128),
        ])
        .unwrap();

    let decoded = decode_inputs_abi_tuple(
        "(address currencyIn, (address,uint24,int24,address,bytes)[] path, uint128 amountIn, uint128 amountOutMinimum)",
        &encoded[4..],
    )
    .unwrap();

    assert_eq!(
        decoded["currencyIn"],
        json!("0x0000000000000000000000000000000000000000")
    );
    assert_eq!(decoded["amountIn"], json!("1000"));
    assert_eq!(decoded["amountOutMinimum"], json!("900"));
    assert_eq!(decoded["path"][0][0], json!(format!("{currency_out:?}")));
    assert_eq!(decoded["path"][0][1], json!(500_u64));
    assert_eq!(decoded["path"][0][2], json!(60_i64));
    assert_eq!(decoded["path"][0][3], json!(format!("{hook:?}")));
    assert_eq!(decoded["path"][0][4], json!("0xabcd"));
}

#[test]
fn maybe_inject_v4_pool_id_handles_v4_swap_params_tuple() {
    let currency0 = AlloyAddress::from([0x11; 20]);
    let currency1 = AlloyAddress::from([0x22; 20]);
    let hook = AlloyAddress::from([0x33; 20]);
    let pool_key = DynSolValue::Tuple(vec![
        DynSolValue::Address(currency0),
        DynSolValue::Address(currency1),
        DynSolValue::Uint(U256::from(500_u64), 24),
        DynSolValue::Int(alloy_primitives::I256::try_from(60_i64).unwrap(), 24),
        DynSolValue::Address(hook),
    ]);
    let encoder = Function::parse(
        "step(((address,address,uint24,int24,address),bool,uint128,uint128,bytes))",
    )
    .unwrap();
    let encoded = encoder
        .abi_encode_input(&[DynSolValue::Tuple(vec![
            pool_key,
            DynSolValue::Bool(true),
            DynSolValue::Uint(U256::from(1_000_u64), 128),
            DynSolValue::Uint(U256::from(900_u64), 128),
            DynSolValue::Bytes(Vec::new()),
        ])])
        .unwrap();

    let mut decoded = decode_inputs_abi_tuple(
        "(((address,address,uint24,int24,address),bool,uint128,uint128,bytes) params)",
        &encoded[4..],
    )
    .unwrap();
    maybe_inject_v4_pool_id(&mut decoded);

    let expected = compute_v4_pool_id(
        &format!("{currency0:?}"),
        &format!("{currency1:?}"),
        &json!(500_u64),
        &json!(60_i64),
        &format!("{hook:?}"),
    )
    .unwrap();
    assert_eq!(decoded["pool_id"], json!(expected));
}

#[test]
fn maybe_inject_uniswap_v3_path_extracts_endpoints_and_fee() {
    let mut path = Vec::new();
    path.extend_from_slice(&[0x11; 20]);
    path.extend_from_slice(&[0x00, 0x01, 0xf4]);
    path.extend_from_slice(&[0x22; 20]);
    path.extend_from_slice(&[0x00, 0x0b, 0xb8]);
    path.extend_from_slice(&[0x33; 20]);

    let args = json!({ "path": format!("0x{}", hex::encode(path)) });
    let mut derived = BTreeMap::new();
    maybe_inject_uniswap_v3_path(&args, &mut derived);

    assert_eq!(
        derived["v3_path_first_token"],
        json!("0x1111111111111111111111111111111111111111")
    );
    assert_eq!(
        derived["v3_path_last_token"],
        json!("0x3333333333333333333333333333333333333333")
    );
    assert_eq!(derived["fee_tier_bp"], json!(500_u64));
}

#[test]
fn decode_stream_inputs_uses_v4_inputs_abi_alternatives_and_normalizes_params() {
    let currency_in = AlloyAddress::ZERO;
    let currency_out = AlloyAddress::from([0x22; 20]);
    let path = DynSolValue::Array(vec![DynSolValue::Tuple(vec![
        DynSolValue::Address(currency_out),
        DynSolValue::Uint(U256::from(500_u64), 24),
        DynSolValue::Int(alloy_primitives::I256::try_from(60_i64).unwrap(), 24),
        DynSolValue::Address(AlloyAddress::ZERO),
        DynSolValue::Bytes(Vec::new()),
    ])]);
    let encoder =
        Function::parse("step((address,(address,uint24,int24,address,bytes)[],uint128,uint128))")
            .unwrap();
    let encoded = encoder
        .abi_encode_input(&[DynSolValue::Tuple(vec![
            DynSolValue::Address(currency_in),
            path,
            DynSolValue::Uint(U256::from(1_000_u64), 128),
            DynSolValue::Uint(U256::from(900_u64), 128),
        ])])
        .unwrap();
    let inputs = vec![json!(format!("0x{}", hex::encode(&encoded[4..])))];
    let mut table = serde_json::Map::new();
    table.insert(
        "0x07".to_owned(),
        json!({
            "inputs_abi": "((address,(address,uint24,int24,address,bytes)[],uint256[],uint128,uint128) params)",
            "inputs_abi_alternatives": [
                "((address,(address,uint24,int24,address,bytes)[],uint128,uint128) params)"
            ]
        }),
    );

    let decoded = decode_stream_inputs(&table, &[0x07], &inputs, 0xff).unwrap();

    assert_eq!(
        decoded[0]["currencyIn"],
        json!("0x0000000000000000000000000000000000000000")
    );
    assert_eq!(decoded[0]["amountIn"], json!("1000"));
    assert_eq!(decoded[0]["amountOutMinimum"], json!("900"));
}

fn envelope<T: serde::Serialize>(result: Result<T, EngineErrorDto>) -> String {
    match result {
        Ok(dto) => crate::json::Envelope::ok(dto).to_json(),
        Err(error) => crate::json::Envelope::<()>::err(error.kind, error.message).to_json(),
    }
}

impl DecoderRegistry {
    fn declarative_install_v3_json(&mut self, bundle_json: String) -> String {
        envelope(self.install(&bundle_json))
    }
    fn declarative_route_request_v3_json(&self, input_json: String) -> String {
        envelope(self.route_request(&input_json))
    }
    fn declarative_route_typed_data_v3_json(&self, input_json: String) -> String {
        envelope(self.route_typed_data_v3(&input_json))
    }
}
