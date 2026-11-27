//! Scam pool check — `POST /v1/scam/pool-check`.
//!
//! The extension sends a token and the window rules it wants evaluated; this
//! module looks the token's Uniswap V2 token/WETH pool up on Ethereum mainnet,
//! decides, and answers with the result. Two checks share one pool lookup:
//!
//!  - **pool backdoor** — can the account that created the pool move the
//!    pool's tokens? `transferFrom(pool, caller, 1)` is simulated as the
//!    deployer and as an unrelated control address; it is flagged only when
//!    the deployer succeeds and the control is refused.
//!  - **window rules** — `change_count` rules over the pool's first hour,
//!    evaluated by the unmodified `scam-filter` crate.
//!
//! What the server learns is the token address and the rule values. The
//! request carries no wallet address, amount, transaction or account, the route
//! needs no login, and the token is never written to a log.
//!
//! Read-only (`eth_call`, `eth_getLogs`, `eth_getTransactionByHash`,
//! `eth_getBlockByNumber`) and advisory: a failed lookup, a rate limit or the
//! deadline ends as `undetermined`, never as a warning.
//!
//! The RPC endpoint comes from `POLICY_SCAM_RPC_URL`. It must serve a 30-day
//! filtered `eth_getLogs` (the pool-creation lookup); without that the backdoor
//! check answers `undetermined`. Unset, the route answers 503.

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures::stream::{self, StreamExt};
use scam_filter::{AlgorithmPort, AnalysisRequest, Limits, WindowRules};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;

// ── constants (Ethereum mainnet; selectors and topics are keccak-256 values) ──
pub const CHAIN_ID: u64 = 1;
const UNISWAP_V2_FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
/// Caller of the control simulation: an address with no role in any token.
pub const CONTROL_ADDRESS: &str = "0x000000000000000000000000000000000c0ffee1";
const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";
const SEL_GET_PAIR: &str = "0xe6a43905"; // getPair(address,address)
const SEL_BALANCE_OF: &str = "0x70a08231"; // balanceOf(address)
const SEL_TRANSFER_FROM: &str = "0x23b872dd"; // transferFrom(address,address,uint256)
const SEL_GET_RESERVES: &str = "0x0902f1ac"; // getReserves()
const PAIR_CREATED_TOPIC: &str =
    "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const SYNC_TOPIC: &str = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
/// The backdoor check was validated on pools created in the last 30 days (12 s blocks).
const MAX_POOL_AGE_BLOCKS: u64 = 30 * 7_200;
/// The window: the pool's `Sync` logs over the last this-many blocks (one hour).
const WINDOW_BLOCKS: u64 = 300;
const NEW_POOL_MAX_AGE_SEC: u64 = 3_600;
const BUCKET_MS: u64 = 12_000;
const MAX_RULES: usize = 16;
const BLOCK_TIME_CONCURRENCY: usize = 8;

// ── RPC: "the contract refused" vs "the node failed" ──

/// Why a JSON-RPC request produced no result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcFailure {
    /// The EVM call itself reverted (deterministic).
    Revert,
    /// Transport error, rate limit, node-side timeout, malformed answer.
    Transport(String),
}

/// One JSON-RPC endpoint. A trait so tests can script the chain.
#[async_trait]
pub trait ChainRpc: Send + Sync {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcFailure>;
}

const REVERT_WORDS: [&str; 6] = [
    "revert",
    "invalid opcode",
    "out of gas",
    "invalid jump",
    "stack",
    "execution",
];

/// Does a JSON-RPC error object mean the EVM call itself failed?
fn is_revert_error(error: &Value) -> bool {
    if error.get("code").and_then(Value::as_i64) == Some(3) {
        return true;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    // "execution aborted (timeout = 5s)" is the node giving up, not the contract refusing.
    if message.contains("aborted") || message.contains("timeout") || message.contains("timed out") {
        return false;
    }
    REVERT_WORDS.iter().any(|word| message.contains(word))
}

/// JSON-RPC over HTTP. Only an error object that reads as a revert is a revert;
/// an HTTP failure, a non-JSON body or a timeout never is.
pub struct HttpChainRpc {
    client: reqwest::Client,
    url: String,
}

impl HttpChainRpc {
    #[must_use]
    pub fn new(url: String, timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_default();
        Self { client, url }
    }
}

#[async_trait]
impl ChainRpc for HttpChainRpc {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        // The URL carries the provider key: strip it from every error string.
        let transport = |e: reqwest::Error| RpcFailure::Transport(e.without_url().to_string());
        let response = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        let answer: Value = response
            .json()
            .await
            .map_err(|e| RpcFailure::Transport(format!("http {status}: {}", e.without_url())))?;
        match answer.get("error") {
            Some(error) if !error.is_null() => {
                if is_revert_error(error) {
                    Err(RpcFailure::Revert)
                } else {
                    let mut text = error.to_string();
                    text.truncate(200);
                    Err(RpcFailure::Transport(text))
                }
            }
            _ => match answer.get("result") {
                Some(result) => Ok(result.clone()),
                None => Err(RpcFailure::Transport(format!("http {status}: no result"))),
            },
        }
    }
}

// ── minimal ABI helpers ──

fn is_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A 32-byte word holding `address` (which must be a valid 0x address).
fn pad_address(address: &str) -> String {
    format!("{:0>64}", address[2..].to_lowercase())
}

fn hex_block(number: u64) -> String {
    format!("{number:#x}")
}

/// The `index`-th 32-byte word of ABI data, as 64 hex digits.
fn word_at(data: &str, index: usize) -> Option<&str> {
    let hex = data.strip_prefix("0x").unwrap_or(data);
    let word = hex.get(index * 64..index * 64 + 64)?;
    word.bytes().all(|b| b.is_ascii_hexdigit()).then_some(word)
}

fn word_to_address(word: &str) -> String {
    format!("0x{}", word[24..].to_lowercase())
}

fn word_is_zero(word: &str) -> bool {
    word.bytes().all(|b| b == b'0')
}

/// A `uint112` reserve out of a 32-byte word.
fn word_to_u128(word: &str) -> Option<u128> {
    if !word_is_zero(&word[..32]) {
        return None;
    }
    u128::from_str_radix(&word[32..], 16).ok()
}

/// A JSON-RPC quantity (`0x…`).
fn quantity(value: &Value) -> Option<u64> {
    let digits = value.as_str()?.strip_prefix("0x")?;
    if digits.is_empty() || digits.len() > 16 {
        return None;
    }
    u64::from_str_radix(digits, 16).ok()
}

enum CallResult {
    Ok(String),
    Revert,
    Error,
}

/// `eth_call` that reports a revert as a value.
async fn try_call(
    rpc: &dyn ChainRpc,
    from: Option<&str>,
    to: &str,
    data: String,
    block: &str,
) -> CallResult {
    let mut tx = json!({ "to": to, "data": data });
    if let Some(from) = from {
        tx["from"] = json!(from);
    }
    match rpc.request("eth_call", json!([tx, block])).await {
        Ok(Value::String(data)) => CallResult::Ok(data),
        Ok(_) => CallResult::Ok("0x".to_owned()),
        Err(RpcFailure::Revert) => CallResult::Revert,
        Err(RpcFailure::Transport(_)) => CallResult::Error,
    }
}

/// Why a lookup did not produce a value. A rate limit is worth telling apart.
fn failure_reason(failure: &RpcFailure, fallback: &'static str) -> &'static str {
    let RpcFailure::Transport(text) = failure else {
        return fallback;
    };
    let text = text.to_lowercase();
    if [
        "rate limit",
        "too many requests",
        "429",
        "-32005",
        "capacity",
        "exceed",
    ]
    .iter()
    .any(|word| text.contains(word))
    {
        "rate_limited"
    } else if ["abort", "timeout", "timed out"]
        .iter()
        .any(|word| text.contains(word))
    {
        "rpc_timeout"
    } else {
        fallback
    }
}

// ── the shared pool lookup ──

#[derive(Debug, Clone)]
enum PoolLookup {
    Found {
        pool: String,
        head: u64,
        head_ms: u64,
    },
    /// The factory has no token/WETH pair.
    NoPair,
    Unavailable {
        reason: &'static str,
        pool: Option<String>,
    },
}

/// `factory.getPair(token, WETH)` and the latest block, in parallel.
async fn lookup_pool(rpc: &dyn ChainRpc, token: &str) -> PoolLookup {
    let pair_data = format!("{SEL_GET_PAIR}{}{}", pad_address(token), pad_address(WETH));
    let (pair, head) = tokio::join!(
        try_call(rpc, None, UNISWAP_V2_FACTORY, pair_data, "latest"),
        rpc.request("eth_getBlockByNumber", json!(["latest", false])),
    );
    let pool = match &pair {
        CallResult::Ok(data) => word_at(data, 0).map(word_to_address),
        _ => None,
    };
    let Some(pool) = pool else {
        return PoolLookup::Unavailable {
            reason: "pair_unavailable",
            pool: None,
        };
    };
    if pool == ZERO_ADDRESS {
        return PoolLookup::NoPair;
    }
    let block = head.ok();
    let number = block.as_ref().and_then(|b| quantity(&b["number"]));
    let stamp = block.as_ref().and_then(|b| quantity(&b["timestamp"]));
    match (number, stamp) {
        (Some(head), Some(stamp)) if head > 0 && stamp > 0 => PoolLookup::Found {
            pool,
            head,
            head_ms: stamp * 1_000,
        },
        _ => PoolLookup::Unavailable {
            reason: "head_unavailable",
            pool: Some(pool),
        },
    }
}

// ── pool backdoor ──

/// What was seen for one simulated call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallObservation {
    /// Did not revert and returned nothing or a non-zero word.
    Succeeded,
    /// The node reported a revert, or the call returned `false`.
    Refused,
    /// Not observed: transport error, rate limit, node-side timeout. Never a refusal.
    Unavailable,
}

fn observe(result: &CallResult) -> CallObservation {
    match result {
        CallResult::Error => CallObservation::Unavailable,
        CallResult::Revert => CallObservation::Refused,
        CallResult::Ok(data) => match word_at(data, 0) {
            Some(word) if word_is_zero(word) => CallObservation::Refused,
            _ => CallObservation::Succeeded,
        },
    }
}

/// The pool-backdoor decision. Pure.
///
/// | deployer call | control call        | result                       |
/// |---------------|---------------------|------------------------------|
/// | succeeded     | refused             | `flagged`                    |
/// | refused       | refused / succeeded | `clear`                      |
/// | succeeded     | succeeded           | `undetermined`               |
/// | a call unavailable, pool balance 0 or unreadable, deployer unknown | | `undetermined` |
///
/// This is the definition validated in the experiments. Do not change it
/// without re-running them. Returns `(result, reason)`.
#[must_use]
pub fn evaluate_pool_backdoor(
    deployer: Option<&str>,
    pool_holds_token: Option<bool>,
    deployer_call: CallObservation,
    control_call: CallObservation,
) -> (&'static str, &'static str) {
    use CallObservation::{Succeeded, Unavailable};
    let Some(deployer) = deployer else {
        return ("undetermined", "no_creation_evidence");
    };
    if deployer.eq_ignore_ascii_case(CONTROL_ADDRESS) {
        return ("undetermined", "deployer_is_control");
    }
    match pool_holds_token {
        None => return ("undetermined", "balance_unavailable"),
        Some(false) => return ("undetermined", "pool_empty"),
        Some(true) => {}
    }
    if deployer_call == Unavailable || control_call == Unavailable {
        return ("undetermined", "call_unavailable");
    }
    match (deployer_call, control_call) {
        (Succeeded, Succeeded) => ("undetermined", "control_also_succeeds"),
        (Succeeded, _) => ("flagged", "fired"),
        _ => ("clear", "clear"),
    }
}

/// The backdoor part of the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackdoorOutcome {
    /// `flagged` | `clear` | `undetermined` | `skipped` | `off`.
    pub result: &'static str,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployer: Option<String>,
}

impl BackdoorOutcome {
    fn new(result: &'static str, reason: &'static str) -> Self {
        Self {
            result,
            reason,
            deployer: None,
        }
    }
}

/// A result and whether it may be reused: a result shaped by a transport
/// failure is not cached, so the next request looks again.
struct Checked<T> {
    value: T,
    cacheable: bool,
}

/// Examine one pool. Round trips after the shared lookup:
///   1. `PairCreated` log (last 30 days) · `token.balanceOf(pool)`
///   2. pair-creation transaction → deployer (`from`)
///   3. deployer call · control call
async fn check_backdoor(
    rpc: &dyn ChainRpc,
    token: &str,
    found: &PoolLookup,
) -> Checked<BackdoorOutcome> {
    let (pool, head) = match found {
        PoolLookup::NoPair => {
            return Checked {
                value: BackdoorOutcome::new("skipped", "no_weth_pair"),
                cacheable: true,
            }
        }
        PoolLookup::Unavailable { reason, .. } => {
            return Checked {
                value: BackdoorOutcome::new("undetermined", reason),
                cacheable: false,
            }
        }
        PoolLookup::Found { pool, head, .. } => (pool.as_str(), *head),
    };
    let (token0, token1) = if token < WETH {
        (token, WETH)
    } else {
        (WETH, token)
    };
    let filter = json!([{
        "address": UNISWAP_V2_FACTORY,
        "topics": [PAIR_CREATED_TOPIC, format!("0x{}", pad_address(token0)), format!("0x{}", pad_address(token1))],
        "fromBlock": hex_block(head.saturating_sub(MAX_POOL_AGE_BLOCKS)),
        "toBlock": hex_block(head),
    }]);
    let balance_data = format!("{SEL_BALANCE_OF}{}", pad_address(pool));
    let (logs, balance) = tokio::join!(
        rpc.request("eth_getLogs", filter),
        try_call(rpc, None, token, balance_data, "latest"),
    );
    let Ok(Value::Array(logs)) = logs else {
        return Checked {
            value: BackdoorOutcome::new("undetermined", "logs_unavailable"),
            cacheable: false,
        };
    };
    let pool_holds_token = match &balance {
        CallResult::Ok(data) => word_at(data, 0).map(|word| !word_is_zero(word)),
        _ => None,
    };
    let mut transport_failed = !matches!(balance, CallResult::Ok(_) | CallResult::Revert);
    let conclude = |deployer: Option<String>, dep, ctl, transport_failed: bool| {
        let (result, reason) =
            evaluate_pool_backdoor(deployer.as_deref(), pool_holds_token, dep, ctl);
        Checked {
            value: BackdoorOutcome {
                result,
                reason,
                deployer: deployer.filter(|_| result == "flagged"),
            },
            cacheable: !transport_failed,
        }
    };
    let unavailable = CallObservation::Unavailable;
    // No PairCreated in the window: the pool is older than 30 days (or unknown).
    let Some(tx_hash) = logs.first().and_then(|log| log["transactionHash"].as_str()) else {
        return conclude(None, unavailable, unavailable, transport_failed);
    };
    let logged_pair = logs[0]["data"]
        .as_str()
        .and_then(|data| word_at(data, 0))
        .map(word_to_address);
    if logged_pair.as_deref() != Some(pool) {
        return Checked {
            value: BackdoorOutcome::new("undetermined", "pair_mismatch"),
            cacheable: true,
        };
    }

    // Deployer = sender of the pair-creation transaction (not owner(), not the factory).
    let tx = rpc
        .request("eth_getTransactionByHash", json!([tx_hash]))
        .await;
    transport_failed |= tx.is_err();
    let deployer = tx
        .ok()
        .and_then(|tx| tx["from"].as_str().map(str::to_lowercase))
        .filter(|from| is_address(from));
    let Some(deployer) = deployer else {
        return conclude(None, unavailable, unavailable, transport_failed);
    };
    // Nothing left to learn from the simulations when the pool balance already decides it.
    if pool_holds_token != Some(true) || deployer == CONTROL_ADDRESS {
        return conclude(Some(deployer), unavailable, unavailable, transport_failed);
    }

    // transferFrom(pool, caller, 1), as the deployer and as an unrelated address.
    // The amount is exactly 1: with 0 an ordinary token lets anyone succeed.
    let simulate = |from: &str| {
        let data = format!(
            "{SEL_TRANSFER_FROM}{}{}{:064x}",
            pad_address(pool),
            pad_address(from),
            1
        );
        let from = from.to_owned();
        async move { try_call(rpc, Some(&from), token, data, "latest").await }
    };
    let (dep, ctl) = tokio::join!(simulate(&deployer), simulate(CONTROL_ADDRESS));
    let (dep, ctl) = (observe(&dep), observe(&ctl));
    transport_failed |= dep == unavailable || ctl == unavailable;
    conclude(Some(deployer), dep, ctl, transport_failed)
}

// ── window rules ──

/// A `change_count` rule as the extension stores it. Unknown fields are rejected.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleIn {
    pub id: String,
    pub lookback_sec: u64,
    pub metric: String,
    pub direction: String,
    pub change_mode: String,
    pub threshold_bps: u64,
    pub count: u64,
}

impl RuleIn {
    /// The reason this is not a complete, in-range rule, if any.
    fn invalid(&self) -> Option<&'static str> {
        let id_ok = (1..=128).contains(&self.id.len())
            && self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !id_ok {
            return Some("invalid_id");
        }
        // The window that is fetched is one hour; a longer lookback could not be observed.
        if !(1..=NEW_POOL_MAX_AGE_SEC).contains(&self.lookback_sec) {
            return Some("lookback_out_of_range");
        }
        if !matches!(
            self.metric.as_str(),
            "price_quote_per_token" | "quote_reserve"
        ) {
            return Some("invalid_metric");
        }
        if !matches!(self.direction.as_str(), "up" | "down" | "either") {
            return Some("invalid_direction");
        }
        if !matches!(self.change_mode.as_str(), "step" | "cumulative") {
            return Some("invalid_change_mode");
        }
        if !(1..=1_000_000).contains(&self.threshold_bps) {
            return Some("threshold_out_of_range");
        }
        if !(1..=1_000).contains(&self.count) {
            return Some("count_out_of_range");
        }
        None
    }

    /// The crate's wire names for this rule.
    fn to_engine(&self) -> Value {
        json!({
            "kind": "change_count",
            "id": self.id,
            "lookbackSec": self.lookback_sec,
            "metric": if self.metric == "quote_reserve" { "liquidity" } else { "price" },
            "direction": if self.direction == "either" { "both" } else { self.direction.as_str() },
            "mode": self.change_mode,
            "minChangeBps": self.threshold_bps,
            "minCount": self.count,
        })
    }
}

/// End-of-block reserves of the pool: the last `Sync` of one block.
#[derive(Debug, Clone)]
struct PoolPoint {
    t_ms: u64,
    reserve_quote: u128,
    reserve_token: u128,
}

/// What the chain says about the pool's first hour — independent of the rules,
/// so it is cached per token and the rules are evaluated per request.
#[derive(Debug, Clone)]
enum WindowFacts {
    /// No rule can run; `(result, reason, pool age)`.
    Final(&'static str, &'static str, Option<u64>),
    History {
        pool: String,
        head: u64,
        head_ms: u64,
        pool_age_sec: u64,
        points: Vec<PoolPoint>,
    },
}

struct SyncEntry {
    log_index: u64,
    reserve0: u128,
    reserve1: u128,
    t_ms: Option<u64>,
}

/// Last `Sync` of each block, ascending by block. `None` when a log is not a well-formed Sync.
fn last_sync_per_block(logs: &[Value]) -> Option<BTreeMap<u64, SyncEntry>> {
    let mut per_block: BTreeMap<u64, SyncEntry> = BTreeMap::new();
    for log in logs {
        if log.get("removed").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let block = quantity(&log["blockNumber"])?;
        let log_index = quantity(&log["logIndex"])?;
        let data = log["data"].as_str()?;
        if data.len() != 130 {
            return None;
        }
        let reserve0 = word_to_u128(word_at(data, 0)?)?;
        let reserve1 = word_to_u128(word_at(data, 1)?)?;
        let t_ms = match log.get("blockTimestamp") {
            None | Some(Value::Null) => None,
            Some(stamp) => Some(quantity(stamp)? * 1_000),
        };
        if per_block
            .get(&block)
            .is_some_and(|prev| prev.log_index >= log_index)
        {
            continue;
        }
        per_block.insert(
            block,
            SyncEntry {
                log_index,
                reserve0,
                reserve1,
                t_ms,
            },
        );
    }
    Some(per_block)
}

/// The window's `Sync` logs. With `max_range` the range is split into chunks
/// fetched in parallel, for providers that cap `eth_getLogs` ranges.
async fn sync_logs(
    rpc: &dyn ChainRpc,
    pool: &str,
    from: u64,
    to: u64,
    max_range: Option<u64>,
) -> Result<Vec<Value>, RpcFailure> {
    let span = max_range.unwrap_or(u64::MAX).max(1);
    let mut ranges = Vec::new();
    let mut start = from;
    loop {
        let end = start.saturating_add(span - 1).min(to);
        ranges.push((start, end));
        if end >= to {
            break;
        }
        start = end + 1;
    }
    let chunks = stream::iter(ranges)
        .map(|(a, b)| async move {
            let filter = json!([{ "address": pool, "topics": [SYNC_TOPIC], "fromBlock": hex_block(a), "toBlock": hex_block(b) }]);
            rpc.request("eth_getLogs", filter).await
        })
        .buffered(BLOCK_TIME_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut logs = Vec::new();
    for chunk in chunks {
        match chunk? {
            Value::Array(mut part) => logs.append(&mut part),
            _ => return Err(RpcFailure::Transport("logs not an array".to_owned())),
        }
    }
    Ok(logs)
}

/// Fetch the pool's first-hour history.
///   1. the window's `Sync` logs · `getReserves()` AT block head-300
///   2. (only when the logs carry no `blockTimestamp`) the block headers
///
/// The reserves at the window's first block decide the pool's age without a
/// creation lookup: zero means the `Sync` logs inside the window are the pool's
/// whole history; non-zero means the pool already had liquidity an hour ago.
async fn window_facts(
    rpc: &dyn ChainRpc,
    token: &str,
    found: &PoolLookup,
    logs_max_range: Option<u64>,
) -> Checked<WindowFacts> {
    let fixed = |result, reason, age| Checked {
        value: WindowFacts::Final(result, reason, age),
        cacheable: true,
    };
    let failed = |reason| Checked {
        value: WindowFacts::Final("undetermined", reason, None),
        cacheable: false,
    };
    let (pool, head, head_ms) = match found {
        PoolLookup::NoPair => return fixed("skipped", "no_weth_pair", None),
        PoolLookup::Unavailable { reason, .. } => return failed(reason),
        PoolLookup::Found {
            pool,
            head,
            head_ms,
        } => (pool.as_str(), *head, *head_ms),
    };
    let from_block = head.saturating_sub(WINDOW_BLOCKS);
    let (logs, start) = tokio::join!(
        sync_logs(rpc, pool, from_block, head, logs_max_range),
        rpc.request(
            "eth_call",
            json!([{ "to": pool, "data": SEL_GET_RESERVES }, hex_block(from_block)])
        ),
    );
    let logs = match logs {
        Ok(logs) => logs,
        Err(failure) => return failed(failure_reason(&failure, "logs_unavailable")),
    };
    // A revert here is not "zero liquidity"; it is an answer this check cannot use.
    let start = match start {
        Ok(Value::String(data)) => data,
        Ok(_) | Err(RpcFailure::Revert) => {
            return fixed("undetermined", "start_state_unreadable", None)
        }
        Err(failure) => return failed(failure_reason(&failure, "start_state_unavailable")),
    };
    // No code at that block (the pair did not exist yet) answers with empty data: zero reserves.
    let start_hex = start.strip_prefix("0x").unwrap_or("?");
    if start_hex.len() % 64 != 0 || !start_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fixed("undetermined", "start_state_unreadable", None);
    }
    let had_liquidity = start_hex.len() >= 128
        && !(word_is_zero(&start_hex[..64]) && word_is_zero(&start_hex[64..128]));
    if had_liquidity {
        return fixed("skipped", "pool_older_than_window", None);
    }
    let Some(per_block) = last_sync_per_block(&logs) else {
        return fixed("undetermined", "logs_malformed", None);
    };
    if per_block.is_empty() {
        return fixed("not_evaluable", "no_liquidity_yet", None);
    }

    // Block times: from the logs when the node provides them, otherwise from the headers.
    let untimed: Vec<u64> = per_block
        .iter()
        .filter(|(_, entry)| entry.t_ms.is_none())
        .map(|(block, _)| *block)
        .collect();
    let mut header_times: HashMap<u64, u64> = HashMap::new();
    if !untimed.is_empty() {
        let headers = stream::iter(untimed)
            .map(|block| async move {
                let header = rpc
                    .request("eth_getBlockByNumber", json!([hex_block(block), false]))
                    .await;
                (block, header)
            })
            .buffer_unordered(BLOCK_TIME_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        for (block, header) in headers {
            match header {
                Ok(header) => match quantity(&header["timestamp"]) {
                    Some(stamp) => {
                        header_times.insert(block, stamp * 1_000);
                    }
                    None => return failed("block_time_unavailable"),
                },
                Err(failure) => return failed(failure_reason(&failure, "block_time_unavailable")),
            }
        }
    }
    let token_is_0 = token < WETH;
    let mut points: Vec<PoolPoint> = Vec::with_capacity(per_block.len());
    for (block, entry) in &per_block {
        let t_ms = entry.t_ms.or_else(|| header_times.get(block).copied());
        let in_order = |t: u64| points.last().is_none_or(|last| t > last.t_ms);
        let Some(t_ms) = t_ms.filter(|t| *t <= head_ms && in_order(*t)) else {
            return fixed("undetermined", "block_time_inconsistent", None);
        };
        let (reserve_quote, reserve_token) = if token_is_0 {
            (entry.reserve1, entry.reserve0)
        } else {
            (entry.reserve0, entry.reserve1)
        };
        points.push(PoolPoint {
            t_ms,
            reserve_quote,
            reserve_token,
        });
    }
    // Age counts from first liquidity. The window is 300 blocks, which can be a little more than an hour.
    let pool_age_sec = (head_ms - points[0].t_ms) / 1_000;
    if pool_age_sec > NEW_POOL_MAX_AGE_SEC {
        return fixed("skipped", "pool_older_than_window", Some(pool_age_sec));
    }
    Checked {
        value: WindowFacts::History {
            pool: pool.to_owned(),
            head,
            head_ms,
            pool_age_sec,
            points,
        },
        cacheable: true,
    }
}

/// One rule's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleOutcome {
    pub id: String,
    /// `fired` | `clear` | `incomplete` | `not_evaluable`.
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Events counted in the lookback window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<u64>,
    /// Events needed for the rule to fire.
    pub threshold: u64,
}

/// The window-rule part of the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOutcome {
    /// `fired` | `clear` | `incomplete` | `not_evaluable` | `skipped` | `undetermined` | `off`.
    pub result: String,
    pub reason: String,
    /// Seconds since the pool's first liquidity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_age_sec: Option<u64>,
    pub rules: Vec<RuleOutcome>,
}

impl WindowOutcome {
    fn fixed(result: &str, reason: &str, pool_age_sec: Option<u64>) -> Self {
        Self {
            result: result.to_owned(),
            reason: reason.to_owned(),
            pool_age_sec,
            rules: Vec::new(),
        }
    }
}

/// Run the algorithm over the fetched history.
///
/// Composition (the one the validation numbers were produced with): the
/// history is the points from the pool's first `Sync` on — nothing is
/// synthesised before it — and that first `Sync` is both the start of the
/// history and the pool's creation time for the algorithm. Times are real block
/// timestamps. Decimals are a fixed 18/18: every supported rule looks at
/// relative change, where a constant scale factor cancels out.
fn evaluate_window(token: &str, facts: &WindowFacts, rules: &[RuleIn]) -> WindowOutcome {
    let (pool, head, head_ms, pool_age_sec, points) = match facts {
        WindowFacts::Final(result, reason, age) => {
            return WindowOutcome::fixed(result, reason, *age)
        }
        WindowFacts::History {
            pool,
            head,
            head_ms,
            pool_age_sec,
            points,
        } => (pool, *head, *head_ms, *pool_age_sec, points),
    };
    let from_ms = points.first().map_or(head_ms, |p| p.t_ms);
    let zero_hash = format!("0x{}", "0".repeat(64));
    let request = json!({
        "subject": { "chainId": CHAIN_ID, "pool": pool, "token": token, "quote": WETH, "venue": "uniswap_v2" },
        "asOf": { "block": head.to_string(), "blockHash": zero_hash, "tMs": head_ms },
        "rules": rules.iter().map(RuleIn::to_engine).collect::<Vec<_>>(),
        "rulesHash": zero_hash,
        "poolHistory": {
            "schema": "server.pool_history/1", "builderVersion": "policy-server/1", "fromMs": from_ms, "bucketMs": BUCKET_MS,
            "points": points.iter().map(|p| json!({
                "tMs": p.t_ms, "reserveQuote": p.reserve_quote.to_string(), "reserveToken": p.reserve_token.to_string(),
                "decimalsQuote": 18, "decimalsToken": 18,
            })).collect::<Vec<_>>(),
            "missing": [],
            "warmup": { "fromMs": from_ms, "complete": true },
        },
        "tokenProfile": { "schema": "server.token_profile/1", "poolCreatedMs": from_ms, "adminEvents": [], "missing": [] },
    });
    let failed = || WindowOutcome::fixed("undetermined", "algorithm_error", Some(pool_age_sec));
    let Ok(request) = serde_json::from_value::<AnalysisRequest>(request) else {
        return failed();
    };
    let Ok(analysis) = WindowRules.analyze(&request, &Limits::default()) else {
        return failed();
    };
    let Ok(analysis) = serde_json::to_value(&analysis) else {
        return failed();
    };
    let results: Vec<RuleOutcome> = analysis["rules"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let number = |v: &Value| {
                v.as_u64().or_else(|| {
                    v.as_f64()
                        .filter(|f| f.is_finite() && *f >= 0.0)
                        .and_then(|f| format!("{f:.0}").parse().ok())
                })
            };
            Some(RuleOutcome {
                id: r["ruleId"].as_str()?.to_owned(),
                outcome: r["outcome"].as_str()?.to_owned(),
                reason: r["reason"].as_str().map(str::to_owned),
                observed: number(&r["observed"]),
                threshold: number(&r["threshold"])?,
            })
        })
        .collect();
    let (result, reason) = if results.iter().any(|r| r.outcome == "fired") {
        ("fired".to_owned(), "rule_fired".to_owned())
    } else if !results.is_empty() && results.iter().all(|r| r.outcome == "clear") {
        ("clear".to_owned(), "clear".to_owned())
    } else {
        match results.iter().find(|r| r.outcome != "clear") {
            Some(other) => (
                if other.outcome == "not_evaluable" {
                    "not_evaluable"
                } else {
                    "incomplete"
                }
                .to_owned(),
                other
                    .reason
                    .clone()
                    .unwrap_or_else(|| other.outcome.clone()),
            ),
            None => ("incomplete".to_owned(), "no_result".to_owned()),
        }
    };
    WindowOutcome {
        result,
        reason,
        pool_age_sec: Some(pool_age_sec),
        rules: results,
    }
}

// ── service: cache, limits, deadline ──

/// Tunables. Every field has a production default; tests shorten them.
#[derive(Debug, Clone)]
pub struct ScamConfig {
    /// Each check's own deadline. Past it the check answers `undetermined / timeout`.
    pub check_timeout: Duration,
    /// How long a token's lookup is reused — about one mainnet block.
    pub cache_ttl: Duration,
    /// Requests one client address may make per minute.
    pub per_client_per_min: u32,
    /// Requests one client address may make at once before the per-minute rate applies.
    pub per_client_burst: u32,
    /// Lookups that may be talking to the RPC at the same time, over all clients.
    pub max_concurrent_lookups: usize,
    /// How many proxies in front of the server append to `X-Forwarded-For`
    /// (0 = use the socket address; a Google Cloud HTTP load balancer is 2).
    pub trusted_proxy_hops: usize,
    /// Split the window's log query into ranges of at most this many blocks.
    pub logs_max_range: Option<u64>,
}

impl Default for ScamConfig {
    fn default() -> Self {
        Self {
            check_timeout: Duration::from_millis(2_200),
            cache_ttl: Duration::from_secs(12),
            per_client_per_min: 30,
            per_client_burst: 10,
            max_concurrent_lookups: 16,
            trusted_proxy_hops: 0,
            logs_max_range: None,
        }
    }
}

fn env_number<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok()?.trim().parse().ok()
}

impl ScamConfig {
    #[must_use]
    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Some(n) = env_number("POLICY_SCAM_RATE_PER_MIN") {
            config.per_client_per_min = n;
        }
        if let Some(n) = env_number("POLICY_SCAM_RATE_BURST") {
            config.per_client_burst = n;
        }
        if let Some(n) = env_number("POLICY_SCAM_MAX_CONCURRENT") {
            config.max_concurrent_lookups = n;
        }
        if let Some(n) = env_number("POLICY_SCAM_TRUSTED_PROXY_HOPS") {
            config.trusted_proxy_hops = n;
        }
        config.logs_max_range = env_number::<u64>("POLICY_SCAM_LOGS_MAX_RANGE").filter(|n| *n > 0);
        config
    }
}

struct Bucket {
    tokens: f64,
    refilled: Instant,
}

#[derive(Default)]
struct Cache {
    backdoor: HashMap<String, (Instant, BackdoorOutcome)>,
    window: HashMap<String, (Instant, Arc<WindowFacts>)>,
    pool: HashMap<String, (Instant, Option<String>)>,
}

const CACHE_MAX_TOKENS: usize = 4_096;
const LIMITER_MAX_CLIENTS: usize = 20_000;

/// The check, its cache and its limits.
pub struct ScamService {
    rpc: Option<Arc<dyn ChainRpc>>,
    config: ScamConfig,
    cache: Mutex<Cache>,
    clients: Mutex<HashMap<IpAddr, Bucket>>,
    lookups: Semaphore,
}

/// The whole answer for one token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolCheckResponse {
    pub chain_id: u64,
    pub token: String,
    /// The token/WETH pool, when one was found.
    pub pool: Option<String>,
    pub backdoor: BackdoorOutcome,
    pub window: WindowOutcome,
}

/// Why a request was not served.
#[derive(Debug, PartialEq, Eq)]
pub enum CheckError {
    NotConfigured,
    Busy,
}

impl ScamService {
    #[must_use]
    pub fn new(rpc: Option<Arc<dyn ChainRpc>>, config: ScamConfig) -> Self {
        let lookups = Semaphore::new(config.max_concurrent_lookups.max(1));
        Self {
            rpc,
            config,
            cache: Mutex::default(),
            clients: Mutex::default(),
            lookups,
        }
    }

    /// The service as configured by the environment (`POLICY_SCAM_RPC_URL`, …).
    #[must_use]
    pub fn from_env() -> Self {
        let config = ScamConfig::from_env();
        let rpc = std::env::var("POLICY_SCAM_RPC_URL")
            .ok()
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .map(|url| Arc::new(HttpChainRpc::new(url, config.check_timeout)) as Arc<dyn ChainRpc>);
        Self::new(rpc, config)
    }

    /// Take one request from `client`'s allowance. `Err` carries the seconds to wait.
    fn admit(&self, client: IpAddr) -> Result<(), u64> {
        let per_sec = f64::from(self.config.per_client_per_min) / 60.0;
        let burst = f64::from(self.config.per_client_burst.max(1));
        let now = Instant::now();
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if clients.len() >= LIMITER_MAX_CLIENTS {
            clients
                .retain(|_, bucket| now.duration_since(bucket.refilled) < Duration::from_mins(2));
        }
        let bucket = clients.entry(client).or_insert(Bucket {
            tokens: burst,
            refilled: now,
        });
        bucket.tokens = (bucket.tokens
            + now.duration_since(bucket.refilled).as_secs_f64() * per_sec)
            .min(burst);
        bucket.refilled = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            return Ok(());
        }
        if per_sec <= 0.0 {
            return Err(60);
        }
        let wait = ((1.0 - bucket.tokens) / per_sec).ceil();
        Err(if wait.is_finite() && wait >= 1.0 {
            format!("{wait:.0}").parse().unwrap_or(60)
        } else {
            1
        })
    }

    /// Check one token. `want_backdoor` and an empty `rules` switch a check off:
    /// a check that is off fetches nothing.
    pub async fn check(
        &self,
        token: &str,
        want_backdoor: bool,
        rules: &[RuleIn],
    ) -> Result<PoolCheckResponse, CheckError> {
        let rpc = self.rpc.as_deref().ok_or(CheckError::NotConfigured)?;
        let want_window = !rules.is_empty();
        let ttl = self.config.cache_ttl;
        let (cached_backdoor, cached_window, cached_pool) = {
            let cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let fresh = |at: &Instant| at.elapsed() < ttl;
            (
                cache
                    .backdoor
                    .get(token)
                    .filter(|(at, _)| fresh(at))
                    .map(|(_, v)| v.clone()),
                cache
                    .window
                    .get(token)
                    .filter(|(at, _)| fresh(at))
                    .map(|(_, v)| Arc::clone(v)),
                cache
                    .pool
                    .get(token)
                    .filter(|(at, _)| fresh(at))
                    .map(|(_, v)| v.clone()),
            )
        };
        let need_backdoor = want_backdoor && cached_backdoor.is_none();
        let need_window = want_window && cached_window.is_none();

        let mut pool = cached_pool.flatten();
        let mut backdoor = cached_backdoor;
        let mut facts = cached_window;
        if need_backdoor || need_window {
            let _permit = self.lookups.try_acquire().map_err(|_| CheckError::Busy)?;
            let deadline = self.config.check_timeout;
            let found = match tokio::time::timeout(deadline, lookup_pool(rpc, token)).await {
                Ok(found) => found,
                Err(_) => PoolLookup::Unavailable {
                    reason: "timeout",
                    pool: None,
                },
            };
            let found_pool = match &found {
                PoolLookup::Found { pool, .. } => Some(pool.clone()),
                PoolLookup::Unavailable { pool, .. } => pool.clone(),
                PoolLookup::NoPair => None,
            };
            let pool_known = !matches!(found, PoolLookup::Unavailable { .. });
            let logs_max_range = self.config.logs_max_range;
            let (fresh_backdoor, fresh_facts) = tokio::join!(
                async {
                    if !need_backdoor {
                        return None;
                    }
                    Some(
                        tokio::time::timeout(deadline, check_backdoor(rpc, token, &found))
                            .await
                            .unwrap_or(Checked {
                                value: BackdoorOutcome::new("undetermined", "timeout"),
                                cacheable: false,
                            }),
                    )
                },
                async {
                    if !need_window {
                        return None;
                    }
                    Some(
                        tokio::time::timeout(
                            deadline,
                            window_facts(rpc, token, &found, logs_max_range),
                        )
                        .await
                        .unwrap_or(Checked {
                            value: WindowFacts::Final("undetermined", "timeout", None),
                            cacheable: false,
                        }),
                    )
                },
            );
            let now = Instant::now();
            let mut cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if cache.backdoor.len() + cache.window.len() + cache.pool.len() > CACHE_MAX_TOKENS * 3 {
                *cache = Cache::default();
            }
            if pool_known {
                cache
                    .pool
                    .insert(token.to_owned(), (now, found_pool.clone()));
            }
            if let Some(checked) = fresh_backdoor {
                if checked.cacheable {
                    cache
                        .backdoor
                        .insert(token.to_owned(), (now, checked.value.clone()));
                }
                backdoor = Some(checked.value);
            }
            if let Some(checked) = fresh_facts {
                let value = Arc::new(checked.value);
                if checked.cacheable {
                    cache
                        .window
                        .insert(token.to_owned(), (now, Arc::clone(&value)));
                }
                facts = Some(value);
            }
            pool = found_pool;
        }

        Ok(PoolCheckResponse {
            chain_id: CHAIN_ID,
            token: token.to_owned(),
            pool,
            backdoor: backdoor
                .filter(|_| want_backdoor)
                .unwrap_or_else(|| BackdoorOutcome::new("off", "not_requested")),
            window: match facts.filter(|_| want_window) {
                Some(facts) => evaluate_window(token, &facts, rules),
                None => WindowOutcome::fixed("off", "no_active_rule", None),
            },
        })
    }
}

// ── HTTP ──

/// The request: a token and rule values. Unknown fields are rejected, so a
/// wallet address, an amount or calldata cannot reach this endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolCheckRequest {
    pub chain_id: u64,
    pub token: String,
    /// `false` switches the pool-backdoor check off. Default on.
    #[serde(default = "default_true")]
    pub backdoor: bool,
    /// The window rules to evaluate. Empty switches the window check off.
    #[serde(default)]
    pub rules: Vec<RuleIn>,
}

fn default_true() -> bool {
    true
}

fn refusal(status: StatusCode, error: &str, reason: &str) -> Response {
    (status, Json(json!({ "error": error, "reason": reason }))).into_response()
}

/// The address the request came from: the socket peer, or — behind
/// `trusted_proxy_hops` proxies — the entry that many places from the right of
/// `X-Forwarded-For`. Entries further left are supplied by the client.
fn client_address(headers: &HeaderMap, peer: Option<SocketAddr>, hops: usize) -> IpAddr {
    let forwarded = (hops > 0)
        .then(|| headers.get("x-forwarded-for")?.to_str().ok())
        .flatten()
        .and_then(|list| {
            let entries: Vec<&str> = list.split(',').map(str::trim).collect();
            entries
                .len()
                .checked_sub(hops)
                .and_then(|i| entries[i].parse::<IpAddr>().ok())
        });
    forwarded
        .or(peer.map(|addr| addr.ip()))
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
}

async fn pool_check(
    State(service): State<Arc<ScamService>>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<PoolCheckRequest>,
) -> Response {
    let client = client_address(
        &headers,
        peer.map(|ConnectInfo(addr)| addr),
        service.config.trusted_proxy_hops,
    );
    if let Err(wait_secs) = service.admit(client) {
        let mut response = refusal(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too_many_requests",
        );
        if let Ok(value) = wait_secs.to_string().parse() {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }
    if request.chain_id != CHAIN_ID {
        return refusal(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "unsupported_chain",
        );
    }
    if !is_address(&request.token) {
        return refusal(StatusCode::BAD_REQUEST, "invalid_request", "invalid_token");
    }
    let token = request.token.to_lowercase();
    if token == WETH || token == ZERO_ADDRESS {
        return refusal(StatusCode::BAD_REQUEST, "invalid_request", "invalid_token");
    }
    if request.rules.len() > MAX_RULES {
        return refusal(StatusCode::BAD_REQUEST, "invalid_request", "too_many_rules");
    }
    for (index, rule) in request.rules.iter().enumerate() {
        if let Some(reason) = rule.invalid() {
            return refusal(StatusCode::BAD_REQUEST, "invalid_request", reason);
        }
        if request.rules[..index]
            .iter()
            .any(|earlier| earlier.id == rule.id)
        {
            return refusal(StatusCode::BAD_REQUEST, "invalid_request", "duplicate_id");
        }
    }
    // Nothing about the request is logged: the token is what the user is about to buy.
    match service
        .check(&token, request.backdoor, &request.rules)
        .await
    {
        Ok(answer) => {
            let mut response = Json(answer).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-store"),
            );
            response
        }
        Err(CheckError::NotConfigured) => refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "scam_rpc_not_configured",
        ),
        Err(CheckError::Busy) => {
            let mut response =
                refusal(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "server_busy");
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
            response
        }
    }
}

/// The route, with its own state. Public: no login, no API key.
pub fn router(service: Arc<ScamService>) -> Router {
    Router::new()
        .route("/v1/scam/pool-check", post(pool_check))
        .with_state(service)
}

#[cfg(test)]
mod tests {
    use super::*;
    use CallObservation::{Refused, Succeeded, Unavailable};

    const DEPLOYER: &str = "0x00000000000000000000000000000000000000d0";

    #[test]
    fn backdoor_is_flagged_only_when_the_deployer_succeeds_and_the_control_is_refused() {
        let eval = |dep, ctl| evaluate_pool_backdoor(Some(DEPLOYER), Some(true), dep, ctl);
        assert_eq!(eval(Succeeded, Refused), ("flagged", "fired"));
        assert_eq!(eval(Refused, Refused), ("clear", "clear"));
        assert_eq!(eval(Refused, Succeeded), ("clear", "clear"));
        assert_eq!(
            eval(Succeeded, Succeeded),
            ("undetermined", "control_also_succeeds")
        );
        for (dep, ctl) in [
            (Unavailable, Refused),
            (Succeeded, Unavailable),
            (Unavailable, Unavailable),
        ] {
            assert_eq!(eval(dep, ctl), ("undetermined", "call_unavailable"));
        }
    }

    #[test]
    fn backdoor_is_never_flagged_without_its_preconditions() {
        let flagged = (Succeeded, Refused);
        assert_eq!(
            evaluate_pool_backdoor(None, Some(true), flagged.0, flagged.1),
            ("undetermined", "no_creation_evidence")
        );
        assert_eq!(
            evaluate_pool_backdoor(Some(CONTROL_ADDRESS), Some(true), flagged.0, flagged.1),
            ("undetermined", "deployer_is_control")
        );
        assert_eq!(
            evaluate_pool_backdoor(Some(DEPLOYER), None, flagged.0, flagged.1),
            ("undetermined", "balance_unavailable")
        );
        assert_eq!(
            evaluate_pool_backdoor(Some(DEPLOYER), Some(false), flagged.0, flagged.1),
            ("undetermined", "pool_empty")
        );
    }

    #[test]
    fn a_call_that_returns_false_is_a_refusal_and_an_empty_return_is_a_success() {
        assert_eq!(observe(&CallResult::Ok("0x".to_owned())), Succeeded);
        assert_eq!(observe(&CallResult::Ok(format!("0x{:064x}", 1))), Succeeded);
        assert_eq!(observe(&CallResult::Ok(format!("0x{:064x}", 0))), Refused);
        assert_eq!(observe(&CallResult::Revert), Refused);
        assert_eq!(observe(&CallResult::Error), Unavailable);
    }

    #[test]
    fn a_node_timeout_is_not_a_revert() {
        assert!(is_revert_error(
            &json!({ "code": 3, "message": "execution reverted" })
        ));
        assert!(is_revert_error(
            &json!({ "code": -32000, "message": "execution reverted: nope" })
        ));
        assert!(!is_revert_error(
            &json!({ "code": -32000, "message": "execution aborted (timeout = 5s)" })
        ));
        assert!(!is_revert_error(
            &json!({ "code": -32005, "message": "rate limit exceeded" })
        ));
    }

    #[test]
    fn the_client_address_ignores_forwarded_entries_the_client_supplied() {
        let peer: SocketAddr = "10.0.0.9:443".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "1.1.1.1, 203.0.113.7, 35.191.0.1".parse().unwrap(),
        );
        assert_eq!(client_address(&headers, Some(peer), 0), peer.ip());
        assert_eq!(
            client_address(&headers, Some(peer), 2).to_string(),
            "203.0.113.7"
        );
        // Fewer entries than hops: fall back to the socket address.
        assert_eq!(client_address(&headers, Some(peer), 5), peer.ip());
    }

    #[test]
    fn rules_outside_their_ranges_are_rejected() {
        let rule = |change: fn(&mut RuleIn)| {
            let mut rule = RuleIn {
                id: "r1".to_owned(),
                lookback_sec: 300,
                metric: "price_quote_per_token".to_owned(),
                direction: "up".to_owned(),
                change_mode: "step".to_owned(),
                threshold_bps: 2_000,
                count: 5,
            };
            change(&mut rule);
            rule.invalid()
        };
        assert_eq!(rule(|_| {}), None);
        assert_eq!(
            rule(|r| r.lookback_sec = 3_601),
            Some("lookback_out_of_range")
        );
        assert_eq!(rule(|r| r.lookback_sec = 0), Some("lookback_out_of_range"));
        assert_eq!(
            rule(|r| r.metric = "volume".to_owned()),
            Some("invalid_metric")
        );
        assert_eq!(
            rule(|r| r.direction = "sideways".to_owned()),
            Some("invalid_direction")
        );
        assert_eq!(
            rule(|r| r.change_mode = "burst".to_owned()),
            Some("invalid_change_mode")
        );
        assert_eq!(
            rule(|r| r.threshold_bps = 0),
            Some("threshold_out_of_range")
        );
        assert_eq!(rule(|r| r.count = 1_001), Some("count_out_of_range"));
        assert_eq!(rule(|r| r.id = "has space".to_owned()), Some("invalid_id"));
    }
}
