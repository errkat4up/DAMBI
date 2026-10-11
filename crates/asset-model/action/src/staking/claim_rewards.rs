//! `ClaimRewardsAction` — mint/claim accrued reward tokens (Curve `Minter` or
//! a liquidity gauge), including Aave reward claims.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use policy_state::primitives::Address;
use policy_state::token::TokenRef;

use super::StakeVenue;

/// Claim accrued staking rewards — from the `Minter` (CRV emissions for one or
/// more gauges) or directly from a gauge (`claim_rewards`, the gauge's own
/// reward set). The venue discriminates the source.
///
/// Models Curve `Minter.mint(address gauge)`, `mint_for(address gauge, address _for)`,
/// `mint_many(address[8] gauges)` AND gauge `claim_rewards()` / `claim_rewards(_addr)`
/// / `claim_rewards(_addr, _receiver)`, plus Aave claims with an optional
/// reinvestment request through the Umbrella batch helper.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct ClaimRewardsAction {
    /// Staking venue or reward-claim helper.
    pub venue: StakeVenue,
    /// Reward token (CRV for the Minter). Omitted when the venue pays a set of
    /// configured rewards not known statically (e.g. a gauge's `claim_rewards`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub reward_token: Option<TokenRef>,
    /// Gauge address(es) rewards are minted from (Minter `mint`/`mint_for`/`mint_many`),
    /// or stake-token address(es) whose rewards are claimed (Aave Umbrella).
    /// Empty for a gauge's own `claim_rewards` (the gauge is the venue).
    #[tsify(type = "string[]")]
    pub gauges: Vec<Address>,
    /// Beneficiary whose rewards are claimed (`mint_for._for` / `claim_rewards(_addr)`);
    /// omitted ⇒ submitter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string")]
    pub on_behalf_of: Option<Address>,
    /// Final beneficiary of reward tokens or, when restaking is requested,
    /// resulting stake shares. Omitted ⇒ submitter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional, type = "string")]
    pub recipient: Option<Address>,
    /// Requested reinvestment of eligible rewards (Aave Umbrella batch helper).
    /// This is intent, not proof of execution: rewards without a supported
    /// staking path are paid to the beneficiary instead. Omitted for venues
    /// that do not expose this choice; `false` remains distinct from omission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub restake: Option<bool>,
}
