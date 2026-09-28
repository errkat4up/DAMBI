//! Legacy diagnosis fixtures only. Runtime regression tests live in dambi-core.
//!
//! Keep this typed builder local rather than expose an SDK test API or replace
//! nested Action/LiveField values with an unverified handwritten JSON mirror.

use std::str::FromStr;

use policy_state::live_field::{DataSource, OracleProvider};
use policy_state::primitives::{Address, ChainId, Duration, Time, U128, U256};
use policy_state::token::{TokenKey, TokenRef};
use policy_state::LiveField;
use policy_transition::action::amm::{
    AmmAction, AmmVenue, PoolState, RouteHop, RoutePath, SwapAction, SwapDirection, SwapLiveInputs,
    SwapParams, SwapRoute,
};
use policy_transition::action::{ActionBody, ActionMeta, ActionNature};
use serde_json::{json, Value};

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

/// The SHIPPED default `high-slippage-warning` bundle (verbatim from
/// `browser-extension/public/default-policies/policy-set-v2.json`): an
/// Inner-scoped (no `trigger.scope` → default Inner) `forbid` on
/// `Amm::Action::"Swap"` when `slippageBp > 100`.
pub(crate) fn shipped_high_slippage_bundle() -> Value {
    json!({
        "policy": "@id(\"high-slippage-warning\")\n@severity(\"warn\")\nforbid(principal, action == Amm::Action::\"Swap\", resource)\nwhen { context.slippageBp > 100 };\n",
        "manifest": { "id": "high-slippage-warning", "schema_version": 2,
            "trigger": { "where": { "action.tag": { "eq": "swap" } } } }
    })
}

/// `swap_sample` but with a caller-chosen `slippage_bp` so the shipped
/// `slippageBp > 100` guard can be made to trip (150) or not (50).
pub(crate) fn swap_sample_with_slippage(bp: u32) -> (ActionBody, ActionMeta) {
    let (body, meta) = swap_sample();
    let ActionBody::Amm(AmmAction::Swap(mut swap)) = body else {
        unreachable!("swap_sample yields an amm swap")
    };
    swap.params.slippage_bp = bp;
    (ActionBody::Amm(AmmAction::Swap(swap)), meta)
}
