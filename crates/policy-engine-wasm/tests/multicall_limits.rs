//! DEC-06c: focused native checks for request-scoped multicall decoding.
//!
//! Actual committed manifests are installed on each test's thread. These tests
//! exercise the public JSON boundary with ABI-encoded calldata; they do not
//! substitute decoded argument JSON or synthetic routing manifests. The wider
//! 64/65, depth and malformed-byte matrix lives in the Node fixture suite.

use alloy_dyn_abi::DynSolValue;
use alloy_primitives::{Address, B256, U256};
use policy_engine_wasm::{
    declarative_install_v3_json, declarative_route_request_v3_json,
    declarative_route_typed_data_v3_json,
};
use serde_json::{json, Value};

const BUNDLER: &str = "0x6566194141eefa99af43bb5aa71460ca2dc90245";
const NFPM: &str = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
const ADAPTER: &str = "0x4a6c312ec70e8747a587ee860a0353cd42be0ae0";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SUBMITTER: &str = "0x000000000000000000000000000000000000aaaa";
const REFUND: &str = "0x12210e8a";
const BUNDLER_ID: &str = "morpho/bundler3/1-multicall@1.0.0";
const SELF_ID: &str = "uniswap/v3-nfpm/multicall@1.0.0";
const REFUND_ID: &str = "uniswap/v3-nfpm/refundETH@1.0.0";
const FLASH_ID: &str = "morpho/general-adapter1/1-morphoFlashLoan@1.0.0";

const BUNDLER_SOURCE: &str =
    include_str!("../../../registryV2/manifests/morpho/bundler3/1-multicall@1.0.0.json");
const SELF_SOURCE: &str =
    include_str!("../../../registryV2/manifests/uniswap/v3-nfpm/multicall@1.0.0.json");
const REFUND_SOURCE: &str =
    include_str!("../../../registryV2/manifests/uniswap/v3-nfpm/refundETH@1.0.0.json");
const MINT_SOURCE: &str =
    include_str!("../../../registryV2/manifests/uniswap/v3-nfpm/mint@1.0.0.json");
const FLASH_SOURCE: &str = include_str!(
    "../../../registryV2/manifests/morpho/general-adapter1/1-morphoFlashLoan@1.0.0.json"
);
const PERMIT_SOURCE: &str =
    include_str!("../../../registryV2/manifests/standard/erc20/permit@1.0.0.json");
const BATCH_SOURCE: &str =
    include_str!("../../../registryV2/manifests/uniswap/permit2/permitBatch@1.0.0.json");
const PERMIT_FIXTURE: &str =
    include_str!("../../../fixtures/decoder-policy/typed-permit.cases.json");
const BATCH_FIXTURE: &str =
    include_str!("../../../fixtures/decoder-policy/permit2-batch.cases.json");

fn parse(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}

fn install(source: &str) {
    let id = parse(source)["id"].clone();
    assert_eq!(
        parse(&declarative_install_v3_json(source.to_owned())),
        json!({ "ok": true, "data": { "decoder_id": id, "bundle_id": id }, "error": null })
    );
}

fn install_calls() {
    for source in [BUNDLER_SOURCE, SELF_SOURCE, REFUND_SOURCE, FLASH_SOURCE] {
        install(source);
    }
}

fn bytes(data: &str) -> Vec<u8> {
    hex::decode(data.strip_prefix("0x").unwrap()).unwrap()
}

fn encode(selector: &str, args: Vec<DynSolValue>) -> String {
    format!(
        "{selector}{}",
        hex::encode(DynSolValue::Tuple(args).abi_encode_params())
    )
}

#[derive(Clone)]
struct Call {
    to: &'static str,
    data: String,
    value: u64,
    skip_revert: bool,
}

fn call(to: &'static str, data: &str, value: u64) -> Call {
    Call {
        to,
        data: data.to_owned(),
        value,
        skip_revert: false,
    }
}

fn call_array(calls: &[Call]) -> DynSolValue {
    DynSolValue::Array(
        calls
            .iter()
            .map(|leg| {
                DynSolValue::Tuple(vec![
                    DynSolValue::Address(leg.to.parse::<Address>().unwrap()),
                    DynSolValue::Bytes(bytes(&leg.data)),
                    DynSolValue::Uint(U256::from(leg.value), 256),
                    DynSolValue::Bool(leg.skip_revert),
                    DynSolValue::FixedBytes(B256::ZERO, 32),
                ])
            })
            .collect(),
    )
}

fn bundler(calls: &[Call]) -> String {
    encode("0x374f435d", vec![call_array(calls)])
}

fn self_call(data: &str) -> String {
    encode(
        "0xac9650d8",
        vec![DynSolValue::Array(vec![DynSolValue::Bytes(bytes(data))])],
    )
}

fn callback(calls: &[Call]) -> String {
    // The callback is abi.encode(Call[]), with NO reenter selector.
    format!(
        "0x{}",
        hex::encode(DynSolValue::Tuple(vec![call_array(calls)]).abi_encode_params())
    )
}

fn flash(callback_data: &str) -> String {
    encode(
        "0xe2975912",
        vec![
            DynSolValue::Address(USDC.parse::<Address>().unwrap()),
            DynSolValue::Uint(U256::from(100_u64), 256),
            DynSolValue::Bytes(bytes(callback_data)),
        ],
    )
}

fn route(to: &str, calldata: &str, value: u64) -> Value {
    parse(&declarative_route_request_v3_json(
        json!({
            "chain_id": 1, "to": to, "selector": &calldata[..10],
            "calldata": calldata, "value": value.to_string(),
            "submitter": SUBMITTER, "submitted_at": 1_700_000_000_u64,
            "nonce": 9, "gas_limit": "200000", "gas_price": "7"
        })
        .to_string(),
    ))
}

fn refund_body() -> Value {
    json!({
        "domain": "token", "action": "refund_native",
        "token": { "key": { "standard": "native", "chain": "eip155:1" } },
        "recipient": SUBMITTER
    })
}

fn unknown(to: &str, data: &str, value: u64) -> Value {
    json!({
        "domain": "unknown", "target": to, "chain": "eip155:1",
        "calldata": data, "value": format!("0x{value:x}")
    })
}

fn multicall(actions: Vec<Value>) -> Value {
    json!({ "domain": "multicall", "actions": actions })
}

fn decoding(diagnostics: Vec<Value>) -> Value {
    json!({
        "status": if diagnostics.is_empty() { "complete" } else { "partial" },
        "diagnostics": diagnostics
    })
}

fn success(
    id: &str,
    body: Value,
    value: u64,
    report: Option<Value>,
    raw_callback: Option<&str>,
) -> Value {
    let mut data = json!({
        "decoder_id": id,
        "actions": [{
            "body": body,
            "meta": {
                "submitted_at": 1_700_000_000_u64, "submitter": SUBMITTER,
                "nature": {
                    "kind": "onchain_tx", "chain": "eip155:1", "nonce": 9,
                    "gas_limit": "0x30d40",
                    "gas_price": {
                        "value": "0x7",
                        "source": { "kind": "oracle_feed", "provider": "pyth", "feed_id": "gas/eip155:1" },
                        "synced_at": 1_700_000_000_u64
                    },
                    "value": format!("0x{value:x}")
                }
            }
        }]
    });
    if let Some(report) = report {
        data["decoding"] = report;
    }
    if let Some(raw_callback) = raw_callback {
        data["reenter_callback"] = json!(raw_callback);
    }
    json!({ "ok": true, "data": data, "error": null })
}

#[test]
fn mixed_call_array_and_self_reentry_share_the_inherited_depth_limit() {
    install_calls();
    let mut data = REFUND.to_owned();
    let mut expected = unknown(NFPM, REFUND, 0);
    for _ in 0..4 {
        data = self_call(&data);
        expected = multicall(vec![expected]);
    }

    // Root Call[] = depth 0; the first self manifest at depth 1 allows through
    // depth 4. Its deepest refund child at depth 5 is not routed. Normal root
    // siblings before and after the opaque child remain in their original order.
    let input = bundler(&[
        call(NFPM, REFUND, 17),
        call(NFPM, &data, 19),
        call(NFPM, REFUND, 23),
    ]);
    let mut path = vec![json!({ "kind": "call", "index": 1 })];
    path.extend((0..4).map(|_| json!({ "kind": "self", "index": 0 })));
    assert_eq!(
        route(BUNDLER, &input, 999),
        success(
            BUNDLER_ID,
            multicall(vec![refund_body(), expected.clone(), refund_body()]),
            999,
            Some(decoding(vec![
                json!({ "code": "depth_limit", "path": path, "decoder_id": null })
            ])),
            None,
        )
    );

    // A separate direct self root has max_depth 3, not the previous request's
    // inherited depth 4. Re-entering self must not reset the local manifest cap.
    assert_eq!(
        route(NFPM, &data, 41),
        success(
            SELF_ID,
            expected,
            41,
            Some(decoding(vec![json!({
                "code": "depth_limit",
                "path": (0..4).map(|_| json!({ "kind": "self", "index": 0 })).collect::<Vec<_>>(),
                "decoder_id": null
            })])),
            None,
        )
    );
}

#[test]
fn sibling_call_arrays_share_one_node_budget_and_next_request_starts_fresh() {
    install_calls();
    let leaves = vec![call(NFPM, REFUND, 37); 63];
    let nested = bundler(&leaves);
    let input = bundler(&vec![call(BUNDLER, &nested, 11); 4]);

    // 1 root + 4 nested routes + 4*63 leaves = 257 nodes. Every array is below
    // its 64-child cap and depth is only 2, so only the final leaf is opaque.
    let mut last = vec![refund_body(); 62];
    last.push(unknown(NFPM, REFUND, 37));
    let mut bodies = vec![multicall(vec![refund_body(); 63]); 3];
    bodies.push(multicall(last));
    assert_eq!(
        route(BUNDLER, &input, 999),
        success(
            BUNDLER_ID,
            multicall(bodies),
            999,
            Some(decoding(vec![json!({
                "code": "node_limit",
                "path": [{ "kind": "call", "index": 3 }, { "kind": "call", "index": 62 }],
                "decoder_id": null
            })])),
            None,
        )
    );

    assert_eq!(
        route(NFPM, &self_call(REFUND), 41),
        success(
            SELF_ID,
            multicall(vec![refund_body()]),
            41,
            Some(decoding(vec![])),
            None
        )
    );
    // A plain direct transaction keeps the legacy result shape: no null or
    // empty decoding field is added merely because the previous call was partial.
    assert_eq!(
        route(NFPM, REFUND, 41),
        success(REFUND_ID, refund_body(), 41, None, None)
    );
}

#[test]
fn callback_only_root_expands_and_depth_cutoff_preserves_the_callback_segment() {
    install_calls();
    let raw_callback = callback(&[call(NFPM, REFUND, 17)]);
    let flash_data = flash(&raw_callback);
    assert_eq!(
        route(ADAPTER, &flash_data, 41),
        success(
            FLASH_ID,
            multicall(vec![refund_body()]),
            41,
            Some(decoding(vec![])),
            Some(&raw_callback),
        )
    );

    // Four Call[] containers place the adapter at depth 4. The callback
    // container would be depth 5: keep its selector-less original bytes with
    // the adapter's target/value, without guessing or routing callback children.
    let mut input = bundler(&[call(ADAPTER, &flash_data, 37)]);
    let mut expected = multicall(vec![unknown(ADAPTER, &raw_callback, 37)]);
    for _ in 0..3 {
        input = bundler(&[call(BUNDLER, &input, 11)]);
        expected = multicall(vec![expected]);
    }
    let mut path: Vec<_> = (0..4)
        .map(|_| json!({ "kind": "call", "index": 0 }))
        .collect();
    path.push(json!({ "kind": "callback" }));
    assert_eq!(
        route(BUNDLER, &input, 999),
        success(
            BUNDLER_ID,
            expected,
            999,
            Some(decoding(vec![
                json!({ "code": "depth_limit", "path": path, "decoder_id": FLASH_ID })
            ])),
            None,
        )
    );
}

fn assert_hard_error(actual: &Value, kind: &str, message_prefix: &str) {
    let message = actual["error"]["message"].as_str().expect("error message");
    assert!(message.starts_with(message_prefix), "{actual}");
    assert_eq!(
        actual,
        &json!({
            "ok": false, "data": null, "error": { "kind": kind, "message": message }
        })
    );
}

#[test]
fn malformed_registered_child_and_callback_still_fail_the_whole_request() {
    install_calls();
    install(MINT_SOURCE);
    // The installed mint ABI requires its tuple; selector-only calldata is
    // malformed. skipRevert remains an input flag, not a decoder error bypass.
    let input = bundler(&[
        call(NFPM, REFUND, 17),
        Call {
            skip_revert: true,
            ..call(NFPM, "0x88316456", 19)
        },
        call(NFPM, REFUND, 23),
    ]);
    assert_hard_error(
        &route(BUNDLER, &input, 999),
        "build_multicall_failed",
        "multicall_call_array leg #1 (0x88316456): decode_failed:",
    );
    assert_hard_error(
        &route(ADAPTER, &flash("0x01"), 41),
        "build_multicall_failed",
        "reenter callback: Call[] decode failed:",
    );
}

#[test]
fn typed_results_and_permit2_batch_limit_keep_the_existing_wire_contract() {
    install(PERMIT_SOURCE);
    install(BATCH_SOURCE);
    let permit = parse(PERMIT_FIXTURE);
    let expected = &permit["expected_permit"];
    assert_eq!(
        parse(&declarative_route_typed_data_v3_json(
            permit["defaults"].to_string()
        )),
        json!({
            "ok": true,
            "data": {
                "actions": [{ "body": expected["body"], "meta": expected["meta"] }],
                "decoder_id": expected["decoder_id"]
            },
            "error": null
        })
    );

    let batch = parse(BATCH_FIXTURE);
    let mut input = batch["defaults"].clone();
    assert_eq!(
        parse(&declarative_route_typed_data_v3_json(input.to_string())),
        json!({
            "ok": true,
            "data": {
                "actions": [batch["expected_action"]],
                "decoder_id": "uniswap/permit2/permitBatch@1.0.0"
            },
            "error": null
        })
    );

    input["message"]["details"] = json!(vec![input["message"]["details"][0].clone(); 65]);
    assert_eq!(
        parse(&declarative_route_typed_data_v3_json(input.to_string())),
        json!({
            "ok": false, "data": null,
            "error": {
                "kind": "build_array_emit_failed",
                "message": "array_emit array_source $args.permitBatch[0] has 65 element(s), exceeding max_elements=64"
            }
        })
    );
}
