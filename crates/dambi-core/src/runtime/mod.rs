//! Native ActionBody policy planning and evaluation. JSON adapters live in [`json`].
//!
//! Built on the v3 `ActionBody` model (the legacy flat action
//! route/plan/evaluate exports were removed in the Phase 1 action restructure).
//! The two phases are:
//!
//! 1. [`plan_action`] — lower the action, plan the v2 policy-RPC
//!    calls, return `{ planned: [...] }` for the host to dispatch.
//! 2. [`evaluate_action`] — lower the action again, replay the host's
//!    raw results into each matching bundle's own `context.custom`, then
//!    evaluate every matching bundle's Cedar policy against its per-policy
//!    schema and aggregate the verdict.
//!
//! The input JSON reuses the trigger export's `{ manifests, action, tx }`
//! shape, extended with `meta: ActionMeta` (the lowering needs it) and — for
//! the evaluate phase — `bundles: [{ policy, manifest }]` and a raw
//! `results: { call_id: Value }` map.
//!
//! Fail-closed translation of [`policy_engine::policy_rpc::PolicyRpcError::SystemFail`] into a synthetic
//! `Verdict::Fail` happens in this runtime (via
//! [`system_fail_verdict`]),
//! mirroring v1's `d9_branch` in `evaluate_policy_rpc_json`.
//!
//! # Boundary invariant — the planned set is derived from the bundles
//!
//! v1 tied PLAN + materialize + the installed engine to ONE manifest set via
//! `manifest_set_hash` / `schema_hash`, so a required RPC call could never be
//! evaluated by a policy that the plan phase did not enrich. v2 has no
//! installed engine to hash against — the policies arrive inline as `bundles`.
//! The equivalent invariant is therefore restored structurally:
//! [`evaluate_action`] PLANS from the **bundles' own valid matching
//! manifests**, never from a host-supplied side list, then MATERIALIZES per
//! bundle so custom-context fields are isolated by policy schema. Every valid
//! bundle that is evaluated thus has its required (`optional == false`) calls in
//! the planned set; a missing result for any of them surfaces as
//! [`policy_engine::policy_rpc::PolicyRpcError::SystemFail`] → a fail-closed `__system__` verdict. The
//! boundary cannot fail-open by the host passing inconsistent manifest lists,
//! because there is only one list.
//!
//! [`ActionBody`]: policy_transition::action::ActionBody

pub mod dto;
pub mod json;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::too_many_lines)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use policy_engine::lowering_v2::{
    lower_action_enriched, AccountLeverage, LoweredAction, OrderEnrichment, TokenDecimals, TxMeta,
};
use policy_engine::policy::{MatchedPolicy, PolicyEngine, Severity, Verdict};
use policy_engine::policy_rpc::{
    plan_policy_rpc_v2, scope_matches_position as trigger_scope_matches_position,
    system_fail_verdict, ManifestV2, PlannedCallV2, TxView, MAX_POLICY_RPC_V2_MANIFESTS,
};
use policy_engine::schema::compose_per_policy;
use policy_transition::action::{ActionBody, ActionMeta};

use self::dto::{
    BundleInput, EvaluateActionInput, PlanActionInput, PlanActionOutput, PlannedCallDto, TxInput,
};
use crate::json::EngineErrorDto;

fn check_manifest_count(count: usize, entry: &str) -> Result<(), EngineErrorDto> {
    if count > MAX_POLICY_RPC_V2_MANIFESTS {
        return Err(EngineErrorDto::new(
            "input_too_large",
            format!(
                "{entry} manifest/bundle count {count} exceeds {MAX_POLICY_RPC_V2_MANIFESTS} item limit"
            ),
        ));
    }
    Ok(())
}

// ── exports ──────────────────────────────────────────────────────────────

/// PLAN phase: lower the action and plan its v2 policy-RPC calls.
///
/// Lowers [`PlanActionInput`] via [`lower_action_enriched`], builds the
/// [`ActionView`](policy_transition::action::ActionView) + [`TxView`], calls
/// [`plan_policy_rpc_v2`], and returns the planned calls. The host dispatches each call and returns the raw
/// results keyed by `call_id` to [`evaluate_action`].
///
/// The host **should** plan over the same manifest set it later submits as
/// `bundles[].manifest` to [`evaluate_action`], so every required call
/// is dispatched. This is advisory only: the plan phase does not gate the
/// verdict. [`evaluate_action`] re-plans from the bundles themselves and
/// fail-closes (`__system__`) on any required call whose result is missing, so a
/// plan/evaluate manifest mismatch can never silently fail-open — it can only
/// surface as a fail-closed verdict.
pub fn plan_action(input: &PlanActionInput) -> Result<PlanActionOutput, EngineErrorDto> {
    check_manifest_count(input.manifests.len(), "plan_action_rpc_v2_json")?;
    let decimals = TokenDecimals::new(input.token_decimals.clone());
    let leverage = AccountLeverage::new(input.account_leverage.clone());
    let lowered = lower(
        &input.action,
        &input.meta,
        &input.tx,
        &decimals,
        &leverage,
        &input.order_enrichment,
    )?;
    let manifests = matching_valid_manifests(input.manifests.iter(), &input.action, &input.tx)?;
    let planned = plan(&manifests, &input.action, &lowered, &input.tx)?;
    Ok(PlanActionOutput {
        planned: planned.iter().map(planned_to_dto).collect(),
    })
}

/// EVALUATE phase: replay the host's raw results into a bundle-local
/// `context.custom`, then evaluate every matching bundle and aggregate the
/// verdict.
///
/// Consumes [`EvaluateActionInput`], re-lowers the action (to recover the
/// principal/action/resource uids + base context), plans the calls **from the
/// bundles' own valid matching manifests** (see the module-level boundary
/// invariant), then — for each matching bundle — replays that bundle's host
/// `results` into its own `context.custom.*`, composes its per-policy schema,
/// builds a single per-policy engine, and evaluates. The per-bundle verdicts
/// are aggregated by deny-overrides ([`Verdict::aggregate`]).
///
/// A [`policy_engine::policy_rpc::PolicyRpcError::SystemFail`] during materialization is translated here
/// into the synthetic `__system__` `Verdict::Fail` (mirroring v1's `d9_branch`);
/// bundle-local faults are quarantined to warnings. Global errors are returned
/// to the caller; the legacy JSON adapter maps them to `__engine::*` Fail DTOs.
pub fn evaluate_action(input: &EvaluateActionInput) -> Result<Verdict, EngineErrorDto> {
    check_manifest_count(input.bundles.len(), "evaluate_action_v2_json")?;

    let decimals = TokenDecimals::new(input.token_decimals.clone());
    let leverage = AccountLeverage::new(input.account_leverage.clone());
    let lowered = lower(
        &input.action,
        &input.meta,
        &input.tx,
        &decimals,
        &leverage,
        &input.order_enrichment,
    )?;

    // Boundary invariant: PLAN over the bundles' own valid matching
    // manifests, never a host-supplied side list, and apply the same
    // scope-position + trigger gate that evaluation uses. Invalid matching
    // manifests are deliberately excluded from materialization so the
    // per-bundle quarantine path below can isolate them to a visible warn
    // instead of letting one broken bundle blanket-fail global planning.
    let manifests = matching_valid_manifests(
        input.bundles.iter().map(|bundle| &bundle.manifest),
        &input.action,
        &input.tx,
    )?;
    let planned = plan(&manifests, &input.action, &lowered, &input.tx)?;

    evaluate_matching_bundles(
        &input.bundles,
        &input.action,
        &input.tx,
        &lowered,
        &planned,
        &input.results,
    )
}

/// DEBUG (diagnostic-only): lower the action and return Cedar entity uids plus a
/// best-effort materialized context — base lowering plus the host `results`
/// replayed into `context.custom.*`.
///
/// Reuses the [`evaluate_action`] input shape, so the host can pass the
/// same `{ action, meta, tx, bundles, results }` and see the camelCase,
/// cedarschema-shaped context (e.g. `direction.amountIn`, `slippageBp`,
/// `tokenIn`) that Cedar policies read. For multiple bundles, the verdict path
/// materializes custom fields per bundle; this debug export returns a single
/// merged best-effort context only. A plan/materialize fault is swallowed so the
/// base lowered context is still returned. Has NO effect on the verdict path.
pub fn debug_lowered_context(input: &EvaluateActionInput) -> Result<Value, EngineErrorDto> {
    check_manifest_count(input.bundles.len(), "debug_lowered_context_v2_json")?;
    let decimals = TokenDecimals::new(input.token_decimals.clone());
    let leverage = AccountLeverage::new(input.account_leverage.clone());
    let lowered = lower(
        &input.action,
        &input.meta,
        &input.tx,
        &decimals,
        &leverage,
        &input.order_enrichment,
    )?;
    let manifests = matching_valid_manifests(
        input.bundles.iter().map(|bundle| &bundle.manifest),
        &input.action,
        &input.tx,
    )?;
    let mut context = lowered.context.clone();
    // Best-effort replay so `context.custom.*` shows when enrichment is wired;
    // ignore a plan/materialize fault and surface the base lowered context.
    if let Ok(planned) = plan(&manifests, &input.action, &lowered, &input.tx) {
        let _ = policy_engine::policy_rpc::materialize_v2(&mut context, &planned, &input.results);
    }
    Ok(serde_json::json!({
        "principal": lowered.principal,
        "actionUid": lowered.action_uid,
        "resource": lowered.resource,
        "context": context,
    }))
}

// ── shared helpers ───────────────────────────────────────────────────────

/// Lower an [`ActionBody`] + [`ActionMeta`] + tx into a [`LoweredAction`], with
/// all host-injected venue state: `decimals` (for `amountNano` siblings),
/// `leverage` (the HL order `leverage` field), and `enrichment` (the remaining
/// order-time enrichment — see [`OrderEnrichment`]).
fn lower(
    action: &ActionBody,
    meta: &ActionMeta,
    tx: &TxInput,
    decimals: &TokenDecimals,
    leverage: &AccountLeverage,
    enrichment: &OrderEnrichment,
) -> Result<LoweredAction, EngineErrorDto> {
    let tx_meta = TxMeta {
        from: &tx.from,
        to: &tx.to,
    };
    lower_action_enriched(action, meta, &tx_meta, decimals, leverage, enrichment)
        .map_err(|error| EngineErrorDto::new("unsupported_action", error.to_string()))
}

/// Plan the v2 policy-RPC calls for one lowered action.
fn plan(
    manifests: &[ManifestV2],
    action: &ActionBody,
    lowered: &LoweredAction,
    tx: &TxInput,
) -> Result<Vec<PlannedCallV2>, EngineErrorDto> {
    let view = action.view();
    let tx_view = tx_view(tx);
    plan_policy_rpc_v2(manifests, &view, &lowered.context, &tx_view)
        .map_err(|error| EngineErrorDto::new("plan_failed", error.to_string()))
}

/// Runtime materialization only uses matching manifests that are structurally
/// valid. Matching invalid manifests are still evaluated later and quarantined
/// per bundle; filtering them here prevents one broken policy bundle from
/// turning the whole action into a global `__engine::plan_failed` verdict before
/// the quarantine boundary runs.
fn matching_valid_manifests<'a, I>(
    manifests: I,
    action: &ActionBody,
    tx: &TxInput,
) -> Result<Vec<ManifestV2>, EngineErrorDto>
where
    I: IntoIterator<Item = &'a ManifestV2>,
{
    let view = action.view();
    let tx_view = tx_view(tx);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for manifest in manifests {
        if !trigger_scope_matches_position(manifest.trigger.scope, &view)
            || !policy_engine::policy_rpc::evaluate_trigger(&manifest.trigger, &view, &tx_view)
            || manifest.validate().is_err()
        {
            continue;
        }
        if !seen.insert(manifest.id.as_str()) {
            return Err(EngineErrorDto::new(
                "duplicate_manifest_id",
                format!(
                    "matching policy-rpc manifest id `{}` appears more than once",
                    manifest.id
                ),
            ));
        }
        out.push(manifest.clone());
    }
    Ok(out)
}

/// Rebuild a diagnostic materialized context: lower the action, plan from the
/// bundles' valid matching manifests, replay `results` into `context.custom.*`.
/// This mirrors the verdict path for single-bundle probes; for multi-bundle
/// inputs, verdict evaluation materializes custom fields per bundle while this
/// helper returns one merged best-effort context.
#[allow(clippy::too_many_arguments)]
pub fn materialized_context(
    action: &ActionBody,
    meta: &ActionMeta,
    tx: &TxInput,
    bundles: &[BundleInput],
    results: &BTreeMap<String, Value>,
    decimals: &TokenDecimals,
    leverage: &AccountLeverage,
    enrichment: &OrderEnrichment,
) -> Result<(LoweredAction, Value), EngineErrorDto> {
    let lowered = lower(action, meta, tx, decimals, leverage, enrichment)?;
    let manifests = matching_valid_manifests(bundles.iter().map(|b| &b.manifest), action, tx)?;
    let planned = plan(&manifests, action, &lowered, tx)?;
    let mut context = lowered.context.clone();
    if let Err(error) = policy_engine::policy_rpc::materialize_v2(&mut context, &planned, results) {
        if system_fail_verdict(&error).is_some() {
            return Err(EngineErrorDto::new("system_fail", error.to_string()));
        }
        return Err(EngineErrorDto::new("projection_failed", error.to_string()));
    }
    Ok((lowered, context))
}

/// Entity slice for Cedar's `Entities::from_json_value` (engine.rs:227).
///
/// Cedar evaluates `principal.<attr>` accesses by looking the principal up in
/// this slice and reading its attrs object. We synthesize the same two entities
/// everywhere the ActionBody v2 path runs Cedar:
/// - `Wallet::"<tx.from>"` with `attrs.address = tx.from`
/// - `Protocol::"<tx.to>"` attribute-less (`Core::Protocol` declares none)
///
/// The lowering layer formats `lowered.principal` as `Wallet::"<from>"` and
/// `lowered.resource` as `Protocol::"<to>"`, so the request uids resolve cleanly
/// against this slice in both verdict evaluation and denial diagnosis.
pub fn entities_for_tx(tx: &TxInput) -> Value {
    serde_json::json!([
        {
            "uid": { "type": "Wallet", "id": tx.from.as_str() },
            "attrs": { "address": tx.from.as_str() },
            "parents": [],
        },
        {
            "uid": { "type": "Protocol", "id": tx.to.as_str() },
            "attrs": {},
            "parents": [],
        }
    ])
}

/// Evaluate every bundle whose trigger matches the action and aggregate the
/// per-bundle verdicts (deny-overrides via [`Verdict::aggregate`]).
///
/// A bundle whose [`Trigger`](policy_engine::policy_rpc::Trigger) does not match
/// the action is skipped (it neither contributes a verdict nor an error). With
/// no matching bundles the aggregate of an empty list is `Pass` — the
/// no-manifest baseline.
fn evaluate_matching_bundles(
    bundles: &[BundleInput],
    action: &ActionBody,
    tx: &TxInput,
    lowered: &LoweredAction,
    planned: &[PlannedCallV2],
    results: &BTreeMap<String, Value>,
) -> Result<Verdict, EngineErrorDto> {
    let view = action.view();
    let tx_view = tx_view(tx);

    let entities = entities_for_tx(tx);

    // Scope×position gate (mirrors `trigger_exports::manifest_matches`). The SW
    // dispatches the outer multicall AND each inner child as its own evaluate
    // envelope (see `orchestrator.ts::evaluateBodyTree`), so a bundle must fire
    // at exactly one position:
    //   - `Outer`-scoped policy → applies to a BATCH only; skip on a leaf.
    //   - `Inner`-scoped policy (default) → applies PER-CHILD; skip on the
    //     multicall itself (it fires when the SW re-enters with each child).
    // This closes the per-child-detail gap (an Inner slippage/recipient policy
    // never seeing a UR-wrapped swap) without double-firing the same policy on
    // both the batch and its children.
    let mut verdicts: Vec<Verdict> = Vec::new();
    for bundle in bundles {
        // Per-bundle install-quarantine. A single broken bundle — invalid
        // manifest, un-composable schema, un-installable / un-evaluable Cedar
        // policy — must NOT blanket-deny the whole action tag. Pre-fix, the first
        // `?` short-circuited the ENTIRE function to one `__engine::<kind>` Fail,
        // discarding every already-collected healthy verdict AND skipping every
        // later bundle (this is the F-SCHEMA-1 / F-REQRPC amplification: one
        // policy typo → tag-wide outage / false denials). Now each bundle is
        // evaluated in isolation: a bundle-local fault becomes a warn-closed
        // `__engine::quarantine::<kind>` verdict (auditable, surfaced, but not a
        // hard block), and the healthy bundles still evaluate and drive the
        // aggregate — deny-overrides is preserved, so a healthy deny still Fails
        // the action. Global lower/plan faults are handled ABOVE this loop and
        // remain fail-closed via `?`; missing required bundle RPC results still
        // become `__system__` Fail verdicts below.
        let outcome: Result<Option<Verdict>, EngineErrorDto> = (|| {
            if !trigger_scope_matches_position(bundle.manifest.trigger.scope, &view) {
                return Ok(None);
            }
            if !policy_engine::policy_rpc::evaluate_trigger(
                &bundle.manifest.trigger,
                &view,
                &tx_view,
            ) {
                return Ok(None);
            }
            bundle
                .manifest
                .validate()
                .map_err(|error| EngineErrorDto::new("invalid_manifest", error.to_string()))?;

            // Materialize `context.custom` per bundle. The schema is per-policy,
            // so two healthy bundles may reuse the same custom field name without
            // colliding; required RPC misses still fail closed as `__system__`.
            let bundle_planned: Vec<PlannedCallV2> = planned
                .iter()
                .filter(|call| call.manifest_id == bundle.manifest.id)
                .cloned()
                .collect();
            let mut context = lowered.context.clone();
            if let Err(error) =
                policy_engine::policy_rpc::materialize_v2(&mut context, &bundle_planned, results)
            {
                if let Some(verdict) = system_fail_verdict(&error) {
                    return Ok(Some(verdict));
                }
                return Err(EngineErrorDto::new("projection_failed", error.to_string()));
            }

            let schema = compose_per_policy(&bundle.manifest)
                .map_err(|error| EngineErrorDto::new("schema_failed", error.to_string()))?;
            let engine = PolicyEngine::build_from_per_policy(&[(bundle.policy.clone(), schema)])
                .map_err(|error| EngineErrorDto::new("install_failed", error.to_string()))?;
            let verdict = engine
                .evaluate(
                    &lowered.principal,
                    &lowered.action_uid,
                    &lowered.resource,
                    &entities,
                    &context,
                )
                .map_err(|error| EngineErrorDto::new("policy", error.to_string()))?;
            Ok(Some(verdict))
        })();

        match outcome {
            Ok(Some(verdict)) => verdicts.push(verdict),
            // Scope / trigger non-match: not an error, contributes no verdict.
            Ok(None) => {}
            // Broken bundle: quarantine to a warn-closed verdict, keep going.
            Err(error) => verdicts.push(quarantine_verdict(&error)),
        }
    }

    Ok(Verdict::aggregate(verdicts))
}

/// Isolate a single broken bundle's fault to a warn-closed [`Verdict`] so it
/// cannot blanket-deny the whole action tag (install-quarantine). Carries a
/// `__engine::quarantine::<kind>` matched policy at `Warn` severity, so the
/// fault is auditable and surfaced to the user without hard-blocking every
/// action that matched the broken policy; the healthy bundles still drive the
/// aggregate (deny-overrides). This is deliberately DISTINCT from
/// `json::engine_error_verdict` (whole-engine fault → `Fail`): that path is for
/// lower / plan / materialize faults, which genuinely cannot produce ANY verdict
/// for the action, whereas a broken individual bundle is one policy among many
/// that did evaluate. (A broken policy cannot enforce its intent regardless of
/// severity; warn-closing it trades an availability DoS for a visible warning.
/// Preventing broken policies from being installed is the separate publish-time
/// gate — F1.2.)
fn quarantine_verdict(error: &EngineErrorDto) -> Verdict {
    let policy_id = format!("__engine::quarantine::{}", error.kind);
    let reason = if error.message.is_empty() {
        policy_id.clone()
    } else {
        error.message.clone()
    };
    Verdict::Warn(vec![MatchedPolicy {
        policy_id,
        reason: Some(reason),
        severity: Severity::Warn,
        origin: policy_engine::PolicyRequestOrigin::Action,
    }])
}

/// Build a borrowed [`TxView`] from the parsed `tx` input.
fn tx_view(tx: &TxInput) -> TxView<'_> {
    TxView {
        chain_id: &tx.chain_id,
        from: &tx.from,
        to: &tx.to,
    }
}

fn planned_to_dto(call: &PlannedCallV2) -> PlannedCallDto {
    PlannedCallDto {
        manifest_id: call.manifest_id.clone(),
        call_id: call.call_id.clone(),
        method: call.method.clone(),
        params: call.params.clone(),
        outputs: call
            .outputs
            .iter()
            .map(|output| serde_json::to_value(output).unwrap_or(Value::Null))
            .collect(),
        optional: call.optional,
    }
}
