//! Input and output types for native action planning and evaluation.

use std::collections::BTreeMap;

use policy_engine::lowering_v2::OrderEnrichment;
use policy_engine::policy_rpc::ManifestV2;
use policy_transition::action::{ActionBody, ActionMeta};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Transaction-level routing fields shared by plan, evaluate, and debug.
/// `chain_id` is the CAIP-2 string (e.g. `"eip155:1"`).
///
/// Addresses are lowercased at construction and deserialization because Cedar
/// compares them byte-for-byte with the lowercased addresses in the context.
/// Fields stay private to the runtime so native callers cannot bypass this
/// normalization; use [`TxInput::new`] for typed inputs.
#[derive(Debug, Clone, Deserialize)]
pub struct TxInput {
    pub(super) chain_id: String,
    #[serde(deserialize_with = "de_lower_addr")]
    pub(super) from: String,
    #[serde(deserialize_with = "de_lower_addr")]
    pub(super) to: String,
}

impl TxInput {
    /// Construct routing fields with the same address normalization as JSON inputs.
    #[must_use]
    pub fn new(chain_id: String, from: String, to: String) -> Self {
        Self {
            chain_id,
            from: from.to_ascii_lowercase(),
            to: to.to_ascii_lowercase(),
        }
    }
}

/// Deserialize a hex address, normalizing to ASCII lowercase so it compares
/// byte-equal against `addr()`-lowercased addresses elsewhere in the context.
fn de_lower_addr<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    Ok(s.to_ascii_lowercase())
}

/// Input to [`plan_action`](crate::runtime::plan_action).
///
/// Carries the decoded action, its metadata, the installed v2 manifests, and
/// the transaction routing fields used by lowering and trigger matching.
#[derive(Debug, Deserialize)]
pub struct PlanActionInput {
    pub manifests: Vec<ManifestV2>,
    pub action: ActionBody,
    pub meta: ActionMeta,
    pub tx: TxInput,
    /// Host-injected per-token decimals (lowercase `0x` address → decimals),
    /// used to fill each fungible amount's `amountNano` `Long` sibling. Absent
    /// ⇒ no nano fields are emitted (the lowering omits the optional sibling).
    #[serde(default)]
    pub token_decimals: BTreeMap<String, u8>,
    /// Host-injected per-asset venue leverage (decimal-string `asset_index` →
    /// leverage), used to fill the HL order `leverage` `Long` field. Absent ⇒
    /// the field is omitted.
    #[serde(default)]
    pub account_leverage: BTreeMap<String, i64>,
    /// Host-injected order-time enrichment beyond bare leverage. Absent ⇒
    /// every enriched field is omitted. See [`OrderEnrichment`].
    #[serde(default)]
    pub order_enrichment: OrderEnrichment,
}

/// One installed bundle: the user's Cedar policy text paired with the manifest
/// that synthesizes its per-policy schema and custom context.
#[derive(Debug, Deserialize)]
pub struct BundleInput {
    pub policy: String,
    pub manifest: ManifestV2,
}

/// Input to [`evaluate_action`](crate::runtime::evaluate_action).
///
/// The planned set used for materialization is derived from `bundles[].manifest`,
/// the same manifests that produce the evaluated schemas. There is no separate
/// host-supplied manifest list that could bypass required Fact checks.
#[derive(Debug, Deserialize)]
pub struct EvaluateActionInput {
    pub action: ActionBody,
    pub meta: ActionMeta,
    pub tx: TxInput,
    pub bundles: Vec<BundleInput>,
    /// Raw host results keyed by `call_id` (the unwrapped `$.result` payload).
    #[serde(default)]
    pub results: BTreeMap<String, Value>,
    /// Host-injected per-token decimals (see [`PlanActionInput::token_decimals`]).
    #[serde(default)]
    pub token_decimals: BTreeMap<String, u8>,
    /// Host-injected per-asset venue leverage (see
    /// [`PlanActionInput::account_leverage`]).
    #[serde(default)]
    pub account_leverage: BTreeMap<String, i64>,
    /// Host-injected order-time enrichment (see
    /// [`PlanActionInput::order_enrichment`]).
    #[serde(default)]
    pub order_enrichment: OrderEnrichment,
}

/// Serializable mirror of [`PlannedCallV2`](policy_engine::policy_rpc::PlannedCallV2).
#[derive(Debug, Clone, Serialize)]
pub struct PlannedCallDto {
    pub manifest_id: String,
    pub call_id: String,
    pub method: String,
    pub params: Value,
    /// Output projection rules, rooted at `$.result`, as opaque JSON.
    pub outputs: Vec<Value>,
    pub optional: bool,
}

/// Success payload of [`plan_action`](crate::runtime::plan_action).
#[derive(Debug, Clone, Serialize)]
pub struct PlanActionOutput {
    pub planned: Vec<PlannedCallDto>,
}

/// Verdict payload of [`evaluate_action_v2`](crate::runtime::json::evaluate_action_v2).
#[derive(Debug, Clone, Serialize)]
pub struct EvaluateActionOutput {
    pub verdict: VerdictDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerdictDto {
    Pass,
    Warn { matched: Vec<MatchedPolicyDto> },
    Fail { matched: Vec<MatchedPolicyDto> },
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchedPolicyDto {
    pub policy_id: String,
    pub reason: Option<String>,
    pub severity: String,
    pub origin: String,
}
