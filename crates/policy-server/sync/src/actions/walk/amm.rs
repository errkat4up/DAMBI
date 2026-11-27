//! Wired: Swap (4), `AddLiquidity` (2), `RemoveLiquidity` (2), `CollectFees` (1),
//!        `SignIntentOrder` (2). 총 11 slots.
//! `SettleIntentOrder` / `CancelIntentOrder` 는 `live_inputs` 없음.

use serde_json::Value;

use policy_state::Time;
use policy_transition::action::amm::{
    AddLiquidityAction, CollectFeesAction, RemoveLiquidityAction, SignIntentOrderAction,
    SwapLiveInputs,
};
use policy_transition::action::AmmAction;

use crate::walker::{ActionSlot, StaleField, WalkStats};

use super::{push_if_stale, set_field, value_to_decimal, value_to_u256};

pub(super) fn walk(
    aa: &AmmAction,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    match aa {
        AmmAction::Swap(s) => walk_swap(&s.live_inputs, ix, now, st, sx),
        AmmAction::AddLiquidity(a) => walk_add(a, ix, now, st, sx),
        AmmAction::RemoveLiquidity(r) => walk_remove(r, ix, now, st, sx),
        AmmAction::CollectFees(c) => walk_collect(c, ix, now, st, sx),
        AmmAction::SignIntentOrder(s) => walk_sign_intent(s, ix, now, st, sx),
        AmmAction::SettleIntentOrder(_) => {}
        AmmAction::CancelIntentOrder(_) => {}
        AmmAction::PreSignIntentOrder(_) => {}
        // GSM swap carries no live inputs (faithful static decode).
        AmmAction::GsmSwap(_) => {}
    }
}

fn walk_swap(
    li: &SwapLiveInputs,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    if let Some(field) = &li.route {
        push_if_stale(st, sx, field, now, ix, ActionSlot::AmmSwapRoute);
    }
    if let Some(field) = &li.expected_amount_out {
        push_if_stale(st, sx, field, now, ix, ActionSlot::AmmSwapExpectedAmountOut);
    }
    if let Some(field) = &li.price_impact_bp {
        push_if_stale(st, sx, field, now, ix, ActionSlot::AmmSwapPriceImpactBp);
    }
    if let Some(field) = &li.gas_estimate {
        push_if_stale(st, sx, field, now, ix, ActionSlot::AmmSwapGasEstimate);
    }
}

fn walk_add(
    a: &AddLiquidityAction,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    let li = &a.live_inputs;
    push_if_stale(
        st,
        sx,
        &li.pool_state,
        now,
        ix,
        ActionSlot::AmmAddLiquidityPoolState,
    );
    push_if_stale(
        st,
        sx,
        &li.current_price,
        now,
        ix,
        ActionSlot::AmmAddLiquidityCurrentPrice,
    );
}

fn walk_remove(
    r: &RemoveLiquidityAction,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    let li = &r.live_inputs;
    push_if_stale(
        st,
        sx,
        &li.pool_state,
        now,
        ix,
        ActionSlot::AmmRemoveLiquidityPoolState,
    );
    push_if_stale(
        st,
        sx,
        &li.fees_owed,
        now,
        ix,
        ActionSlot::AmmRemoveLiquidityFeesOwed,
    );
}

fn walk_collect(
    c: &CollectFeesAction,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    let li = &c.live_inputs;
    push_if_stale(
        st,
        sx,
        &li.fees_owed,
        now,
        ix,
        ActionSlot::AmmCollectFeesOwed,
    );
}

fn walk_sign_intent(
    s: &SignIntentOrderAction,
    ix: usize,
    now: Time,
    st: &mut Vec<StaleField>,
    sx: &mut WalkStats,
) {
    let li = &s.live_inputs;
    push_if_stale(
        st,
        sx,
        &li.expected_fill_price,
        now,
        ix,
        ActionSlot::AmmSignIntentExpectedFillPrice,
    );
    push_if_stale(
        st,
        sx,
        &li.competing_orders,
        now,
        ix,
        ActionSlot::AmmSignIntentCompetingOrders,
    );
}

pub(super) fn apply(aa: &mut AmmAction, slot: &ActionSlot, value: Value, now: Time) {
    match aa {
        AmmAction::Swap(s) => apply_swap(&mut s.live_inputs, slot, value, now),
        AmmAction::AddLiquidity(a) => apply_add(a, slot, value, now),
        AmmAction::RemoveLiquidity(r) => apply_remove(r, slot, value, now),
        AmmAction::CollectFees(c) => apply_collect(c, slot, value, now),
        AmmAction::SignIntentOrder(s) => apply_sign_intent(s, slot, value, now),
        AmmAction::SettleIntentOrder(_) => {}
        AmmAction::CancelIntentOrder(_) => {}
        AmmAction::PreSignIntentOrder(_) => {}
        AmmAction::GsmSwap(_) => {}
    }
}

fn apply_swap(li: &mut SwapLiveInputs, slot: &ActionSlot, value: Value, now: Time) {
    match slot {
        ActionSlot::AmmSwapRoute => {
            if let (Some(field), Some(value)) = (&mut li.route, serde_json::from_value(value).ok())
            {
                set_field(field, value, now);
            }
        }
        ActionSlot::AmmSwapExpectedAmountOut => {
            if let (Some(field), Some(value)) = (&mut li.expected_amount_out, value_to_u256(&value))
            {
                set_field(field, value, now);
            }
        }
        ActionSlot::AmmSwapPriceImpactBp => {
            if let (Some(field), Some(value)) = (
                &mut li.price_impact_bp,
                value.as_u64().and_then(|v| u32::try_from(v).ok()),
            ) {
                set_field(field, value, now);
            }
        }
        ActionSlot::AmmSwapGasEstimate => {
            if let (Some(field), Some(value)) = (&mut li.gas_estimate, value_to_u256(&value)) {
                set_field(field, value, now);
            }
        }
        _ => {}
    }
}

fn apply_add(a: &mut AddLiquidityAction, slot: &ActionSlot, value: Value, now: Time) {
    let li = &mut a.live_inputs;
    match slot {
        ActionSlot::AmmAddLiquidityPoolState => {
            if let Ok(v) = serde_json::from_value(value) {
                set_field(&mut li.pool_state, v, now);
            }
        }
        ActionSlot::AmmAddLiquidityCurrentPrice => {
            if let Some(d) = value_to_decimal(&value) {
                set_field(&mut li.current_price, d, now);
            }
        }
        _ => {}
    }
}

fn apply_remove(r: &mut RemoveLiquidityAction, slot: &ActionSlot, value: Value, now: Time) {
    let li = &mut r.live_inputs;
    match slot {
        ActionSlot::AmmRemoveLiquidityPoolState => {
            if let Ok(v) = serde_json::from_value(value) {
                set_field(&mut li.pool_state, v, now);
            }
        }
        ActionSlot::AmmRemoveLiquidityFeesOwed => {
            if let Ok(v) = serde_json::from_value(value) {
                set_field(&mut li.fees_owed, v, now);
            }
        }
        _ => {}
    }
}

fn apply_collect(c: &mut CollectFeesAction, slot: &ActionSlot, value: Value, now: Time) {
    let li = &mut c.live_inputs;
    if matches!(slot, ActionSlot::AmmCollectFeesOwed) {
        if let Ok(v) = serde_json::from_value(value) {
            set_field(&mut li.fees_owed, v, now);
        }
    }
}

fn apply_sign_intent(s: &mut SignIntentOrderAction, slot: &ActionSlot, value: Value, now: Time) {
    let li = &mut s.live_inputs;
    match slot {
        ActionSlot::AmmSignIntentExpectedFillPrice => {
            if let Some(d) = value_to_decimal(&value) {
                set_field(&mut li.expected_fill_price, d, now);
            }
        }
        ActionSlot::AmmSignIntentCompetingOrders => {
            if let Some(n) = value.as_u64() {
                set_field(&mut li.competing_orders, n as u32, now);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use policy_state::{DataSource, Duration, LiveField};

    #[test]
    fn swap_refresh_tracks_only_observed_fields_and_preserves_real_zero() {
        let now = Time::from_unix(100);
        let mut inputs = SwapLiveInputs {
            price_impact_bp: Some(
                LiveField::new(0, DataSource::UserSupplied, Time::from_unix(1))
                    .with_ttl(Duration::from_secs(10)),
            ),
            ..SwapLiveInputs::default()
        };
        let mut stale = Vec::new();
        let mut stats = WalkStats::default();
        walk_swap(&inputs, 0, now, &mut stale, &mut stats);
        assert_eq!(
            (stats.total_live_fields, stats.stale_count, stale.len()),
            (1, 1, 1)
        );

        apply_swap(
            &mut inputs,
            &ActionSlot::AmmSwapPriceImpactBp,
            Value::from(0),
            now,
        );
        apply_swap(
            &mut inputs,
            &ActionSlot::AmmSwapGasEstimate,
            Value::from(0),
            now,
        );
        let observation = inputs
            .price_impact_bp
            .as_ref()
            .expect("observed price impact");
        assert_eq!((observation.value, observation.synced_at), (0, now));
        assert!(inputs.gas_estimate.is_none());
    }
}
