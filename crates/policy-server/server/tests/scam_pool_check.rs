//! `POST /v1/scam/pool-check` over HTTP, against a scripted chain.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use policy_server::scam::{router, ChainRpc, RpcFailure, ScamConfig, ScamService, CONTROL_ADDRESS};
use serde_json::{json, Value};

const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const DEPLOYER: &str = "0x00000000000000000000000000000000000000d0";
const TX_HASH: &str = "0x00000000000000000000000000000000000000000000000000000000000000aa";

/// Real mainnet pool history recorded on 2026-11-25: nine `Sync` logs in the
/// pool's first five minutes, on which the "sensitive" rule counts 8 of 5.
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/window-fired-mainnet.json")).unwrap()
}

fn word(hex: &str) -> String {
    format!("{:0>64}", hex.trim_start_matches("0x"))
}

type CallAnswer = Result<Value, RpcFailure>;

/// One token/WETH pool as the chain would answer about it.
#[derive(Clone)]
struct Pool {
    pool: String,
    head: u64,
    head_secs: u64,
    created_recently: bool,
    pool_balance: u64,
    deployer_call: CallAnswer,
    control_call: CallAnswer,
    sync_logs: Vec<Value>,
    start_reserves: String,
    delay: Duration,
}

impl Pool {
    fn from_fixture() -> Self {
        let fx = fixture();
        Self {
            pool: fx["pool"].as_str().unwrap().to_owned(),
            head: fx["head"]["number"].as_u64().unwrap(),
            head_secs: fx["head"]["timestampMs"].as_u64().unwrap() / 1000,
            created_recently: true,
            pool_balance: 1_000,
            deployer_call: Ok(json!("0x")),
            control_call: Err(RpcFailure::Revert),
            sync_logs: fx["logs"].as_array().unwrap().clone(),
            start_reserves: fx["startReserves"].as_str().unwrap().to_owned(),
            delay: Duration::ZERO,
        }
    }
}

struct FakeChain {
    pool: Mutex<Pool>,
    calls: Mutex<Vec<String>>,
}

impl FakeChain {
    fn new(pool: Pool) -> Arc<Self> {
        Arc::new(Self {
            pool: Mutex::new(pool),
            calls: Mutex::new(Vec::new()),
        })
    }
    fn count(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.as_str() == method)
            .count()
    }
    fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl ChainRpc for FakeChain {
    async fn request(&self, method: &str, params: Value) -> CallAnswer {
        self.calls.lock().unwrap().push(method.to_owned());
        let p = self.pool.lock().unwrap().clone();
        if !p.delay.is_zero() {
            tokio::time::sleep(p.delay).await;
        }
        match method {
            "eth_getBlockByNumber" => Ok(
                json!({ "number": format!("{:#x}", p.head), "timestamp": format!("{:#x}", p.head_secs) }),
            ),
            "eth_getTransactionByHash" => Ok(json!({ "hash": TX_HASH, "from": DEPLOYER })),
            "eth_getLogs" => {
                if params[0]["address"] == FACTORY {
                    return Ok(if p.created_recently {
                        json!([{ "transactionHash": TX_HASH, "data": format!("0x{}{}", word(&p.pool), word("1")) }])
                    } else {
                        json!([])
                    });
                }
                let from = u64::from_str_radix(
                    params[0]["fromBlock"]
                        .as_str()
                        .unwrap()
                        .trim_start_matches("0x"),
                    16,
                )
                .unwrap();
                let to = u64::from_str_radix(
                    params[0]["toBlock"]
                        .as_str()
                        .unwrap()
                        .trim_start_matches("0x"),
                    16,
                )
                .unwrap();
                Ok(Value::Array(
                    p.sync_logs
                        .iter()
                        .filter(|log| {
                            let block = u64::from_str_radix(
                                log["blockNumber"]
                                    .as_str()
                                    .unwrap()
                                    .trim_start_matches("0x"),
                                16,
                            )
                            .unwrap();
                            (from..=to).contains(&block)
                        })
                        .cloned()
                        .collect(),
                ))
            }
            "eth_call" => {
                let tx = &params[0];
                let data = tx["data"].as_str().unwrap();
                if tx["to"] == FACTORY {
                    Ok(json!(format!("0x{}", word(&p.pool))))
                } else if data.starts_with("0x70a08231") {
                    Ok(json!(format!("0x{:064x}", p.pool_balance)))
                } else if data.starts_with("0x23b872dd") {
                    // Exactly transferFrom(pool, caller, 1), sent from the caller.
                    let from = tx["from"].as_str().unwrap();
                    assert_eq!(
                        data,
                        format!("0x23b872dd{}{}{}", word(&p.pool), word(from), word("1"))
                    );
                    assert_eq!(params[1], "latest");
                    if from == DEPLOYER {
                        p.deployer_call
                    } else {
                        assert_eq!(from, CONTROL_ADDRESS);
                        p.control_call
                    }
                } else if data == "0x0902f1ac" {
                    assert_ne!(
                        params[1], "latest",
                        "start reserves are read at the window's first block"
                    );
                    Ok(json!(p.start_reserves))
                } else {
                    panic!("unexpected eth_call {data}")
                }
            }
            other => panic!("unexpected method {other}"),
        }
    }
}

async fn serve(rpc: Option<Arc<FakeChain>>, config: ScamConfig) -> String {
    let service = Arc::new(ScamService::new(
        rpc.map(|chain| chain as Arc<dyn ChainRpc>),
        config,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(service).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    format!("http://{addr}/v1/scam/pool-check")
}

fn rule(id: &str, mode: &str, count: u64) -> Value {
    json!({ "id": id, "lookbackSec": 300, "metric": "price_quote_per_token",
            "direction": "up", "changeMode": mode, "thresholdBps": 2000, "count": count })
}

fn token() -> String {
    fixture()["token"].as_str().unwrap().to_owned()
}

async fn post(url: &str, body: Value) -> (u16, Value, reqwest::header::HeaderMap) {
    let response = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .unwrap();
    let (status, headers) = (response.status().as_u16(), response.headers().clone());
    (
        status,
        response.json().await.unwrap_or(Value::Null),
        headers,
    )
}

#[tokio::test]
async fn a_flagged_pool_with_a_fired_rule_answers_both() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (status, body, headers) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "rules": [rule("sensitive", "step", 5)] }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(headers["cache-control"], "no-store");
    let fx = fixture();
    assert_eq!(body["pool"], fx["pool"]);
    assert_eq!(
        body["backdoor"],
        json!({ "result": "flagged", "reason": "fired", "deployer": DEPLOYER })
    );
    assert_eq!(body["window"]["result"], "fired");
    assert_eq!(body["window"]["poolAgeSec"], fx["expected"]["poolAgeSec"]);
    assert_eq!(
        body["window"]["rules"],
        json!([{ "id": "sensitive", "outcome": "fired",
        "observed": fx["expected"]["sensitive"]["observed"], "threshold": fx["expected"]["sensitive"]["threshold"] }])
    );
}

#[tokio::test]
async fn the_three_presets_agree_with_the_recorded_mainnet_result() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(Some(chain), ScamConfig::default()).await;
    let rules = json!([
        rule("sensitive", "step", 5),
        rule("balanced", "cumulative", 8),
        rule("strict", "step", 8)
    ]);
    let (_, body, _) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "backdoor": false, "rules": rules }),
    )
    .await;
    let fired: Vec<&str> = body["window"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["outcome"] == "fired")
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(fired, ["sensitive", "balanced", "strict"]);
    assert_eq!(body["backdoor"]["result"], "off");
}

#[tokio::test]
async fn an_ordinary_token_in_an_old_pool_is_clear_and_skipped() {
    let mut pool = Pool::from_fixture();
    pool.deployer_call = Err(RpcFailure::Revert);
    pool.start_reserves = format!("0x{:064x}{:064x}{:064x}", 5, 7, 0);
    let chain = FakeChain::new(pool);
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (status, body, _) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "rules": [rule("r1", "step", 5)] }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        body["backdoor"],
        json!({ "result": "clear", "reason": "clear" })
    );
    assert_eq!(
        body["window"],
        json!({ "result": "skipped", "reason": "pool_older_than_window", "rules": [] })
    );
}

#[tokio::test]
async fn the_backdoor_is_undetermined_when_everyone_can_move_the_tokens_or_the_pool_is_old() {
    let mut pool = Pool::from_fixture();
    pool.control_call = Ok(json!("0x"));
    let url = serve(Some(FakeChain::new(pool)), ScamConfig::default()).await;
    let (_, body, _) = post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert_eq!(
        body["backdoor"],
        json!({ "result": "undetermined", "reason": "control_also_succeeds" })
    );

    let mut pool = Pool::from_fixture();
    pool.created_recently = false;
    let chain = FakeChain::new(pool);
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (_, body, _) = post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert_eq!(
        body["backdoor"],
        json!({ "result": "undetermined", "reason": "no_creation_evidence" })
    );
    assert_eq!(chain.count("eth_getTransactionByHash"), 0);
    assert_eq!(body["window"]["result"], "off");
}

#[tokio::test]
async fn a_check_that_is_off_fetches_nothing() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (status, body, _) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "backdoor": false, "rules": [] }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["backdoor"]["result"], "off");
    assert_eq!(body["window"]["result"], "off");
    assert_eq!(chain.total(), 0);

    // Backdoor only: no Sync logs, no start reserves.
    post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert_eq!(chain.count("eth_getLogs"), 1);
}

#[tokio::test]
async fn a_token_is_looked_up_once_and_the_rules_are_evaluated_per_request() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (_, first, _) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "rules": [rule("r", "step", 5)] }),
    )
    .await;
    let lookups = chain.total();
    assert!(lookups > 0);
    // Same token, a stricter rule, another spelling of the address: no new lookup.
    let (_, second, _) = post(&url, json!({ "chainId": 1, "token": token().to_uppercase().replace("0X", "0x"), "rules": [rule("r", "step", 9)] })).await;
    assert_eq!(chain.total(), lookups);
    assert_eq!(first["window"]["result"], "fired");
    assert_eq!(second["window"]["result"], "clear");
    assert_eq!(second["window"]["rules"][0]["observed"], 8);
    assert_eq!(second["backdoor"], first["backdoor"]);
    assert_eq!(second["pool"], first["pool"]);
}

#[tokio::test]
async fn a_lookup_that_failed_is_not_reused() {
    let mut pool = Pool::from_fixture();
    pool.control_call = Err(RpcFailure::Transport("rate limit exceeded".to_owned()));
    let chain = FakeChain::new(pool);
    let url = serve(Some(chain.clone()), ScamConfig::default()).await;
    let (_, body, _) = post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert_eq!(
        body["backdoor"],
        json!({ "result": "undetermined", "reason": "call_unavailable" })
    );
    let after_first = chain.total();
    chain.pool.lock().unwrap().control_call = Err(RpcFailure::Revert);
    let (_, body, _) = post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert!(chain.total() > after_first);
    assert_eq!(body["backdoor"]["result"], "flagged");
}

#[tokio::test]
async fn the_log_query_can_be_split_for_providers_that_cap_its_range() {
    let chain = FakeChain::new(Pool::from_fixture());
    let config = ScamConfig {
        logs_max_range: Some(11),
        ..ScamConfig::default()
    };
    let url = serve(Some(chain.clone()), config).await;
    let (_, body, _) = post(&url, json!({ "chainId": 1, "token": token(), "backdoor": false, "rules": [rule("r", "step", 5)] })).await;
    // 301 blocks in ranges of 11.
    assert_eq!(chain.count("eth_getLogs"), 28);
    assert_eq!(body["window"]["result"], "fired");
    assert_eq!(body["window"]["rules"][0]["observed"], 8);
}

#[tokio::test]
async fn a_slow_chain_ends_as_undetermined_at_the_deadline() {
    let mut pool = Pool::from_fixture();
    pool.delay = Duration::from_millis(400);
    let config = ScamConfig {
        check_timeout: Duration::from_millis(100),
        ..ScamConfig::default()
    };
    let url = serve(Some(FakeChain::new(pool)), config).await;
    let started = std::time::Instant::now();
    let (status, body, _) = post(
        &url,
        json!({ "chainId": 1, "token": token(), "rules": [rule("r", "step", 5)] }),
    )
    .await;
    assert_eq!(status, 200);
    assert!(started.elapsed() < Duration::from_millis(390));
    assert_eq!(body["backdoor"]["result"], "undetermined");
    assert_eq!(body["window"]["result"], "undetermined");
    assert_eq!(body["window"]["reason"], "timeout");
}

#[tokio::test]
async fn malformed_requests_are_refused_before_any_lookup() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(
        Some(chain.clone()),
        ScamConfig {
            per_client_burst: 100,
            ..ScamConfig::default()
        },
    )
    .await;
    let weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    let mut bad_rule = rule("r", "step", 5);
    bad_rule["lookbackSec"] = json!(7200);
    let many: Vec<Value> = (0..17).map(|i| rule(&format!("r{i}"), "step", 5)).collect();
    for (body, reason) in [
        (
            json!({ "chainId": 8453, "token": token() }),
            "unsupported_chain",
        ),
        (json!({ "chainId": 1, "token": "0x1234" }), "invalid_token"),
        (json!({ "chainId": 1, "token": weth }), "invalid_token"),
        (
            json!({ "chainId": 1, "token": token(), "rules": [bad_rule] }),
            "lookback_out_of_range",
        ),
        (
            json!({ "chainId": 1, "token": token(), "rules": many }),
            "too_many_rules",
        ),
        (
            json!({ "chainId": 1, "token": token(), "rules": [rule("a", "step", 5), rule("a", "step", 6)] }),
            "duplicate_id",
        ),
    ] {
        let (status, answer, _) = post(&url, body).await;
        assert_eq!((status, answer["reason"].as_str()), (400, Some(reason)));
    }
    assert_eq!(chain.total(), 0);
}

#[tokio::test]
async fn one_client_is_limited_and_told_when_to_retry() {
    let chain = FakeChain::new(Pool::from_fixture());
    let config = ScamConfig {
        per_client_burst: 2,
        per_client_per_min: 6,
        ..ScamConfig::default()
    };
    let url = serve(Some(chain), config).await;
    let body = json!({ "chainId": 1, "token": token() });
    assert_eq!(post(&url, body.clone()).await.0, 200);
    assert_eq!(post(&url, body.clone()).await.0, 200);
    let (status, answer, headers) = post(&url, body).await;
    assert_eq!(status, 429);
    assert_eq!(answer["error"], "rate_limited");
    let wait: u64 = headers["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=10).contains(&wait));
}

#[tokio::test]
async fn without_an_rpc_endpoint_the_route_says_so() {
    let url = serve(None, ScamConfig::default()).await;
    let (status, answer, _) = post(&url, json!({ "chainId": 1, "token": token() })).await;
    assert_eq!(status, 503);
    assert_eq!(answer["reason"], "scam_rpc_not_configured");
}

#[tokio::test]
async fn nothing_but_a_token_and_rule_values_is_accepted() {
    let chain = FakeChain::new(Pool::from_fixture());
    let url = serve(
        Some(chain.clone()),
        ScamConfig {
            per_client_burst: 100,
            ..ScamConfig::default()
        },
    )
    .await;
    let mut tagged_rule = rule("r", "step", 5);
    tagged_rule["from"] = json!(DEPLOYER);
    for body in [
        json!({ "chainId": 1, "token": token(), "from": DEPLOYER }),
        json!({ "chainId": 1, "token": token(), "value": "0xde0b6b3a7640000" }),
        json!({ "chainId": 1, "token": token(), "transaction": { "data": "0x7ff36ab5" } }),
        json!({ "chainId": 1, "token": token(), "rules": [tagged_rule] }),
    ] {
        let (status, _, _) = post(&url, body.clone()).await;
        assert_eq!(status, 422, "{body}");
    }
    assert_eq!(chain.total(), 0);
}
