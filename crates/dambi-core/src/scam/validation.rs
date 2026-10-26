//! Validation at the algorithm boundary, not a second detector implementation.
//!
//! Snapshot provenance/RPC canonicality belongs to the provider boundary. This
//! module rejects malformed or contradictory inputs/results without deriving
//! price changes, zigzag states, or a replacement verdict.

use std::collections::BTreeSet;

use alloy_primitives::U256;

use super::types::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_LOOKBACK_SEC: u64 = 86_400;
const MAX_EVIDENCE_EVENTS: u64 = 64;

pub(super) fn validate_request(
    req: &AnalysisRequest,
    binding: &AnalysisBinding,
    rules: &[RuleSpec],
    limits: &AlgorithmLimits,
) -> Result<(), FailureReason> {
    binding.verification.validate()?;
    if req.rules != rules || req.rules.is_empty() {
        return Err(FailureReason::InvalidScamInput);
    }
    if req.rules.len() as u64 > limits.max_rules {
        return Err(FailureReason::ResourceLimit);
    }
    let mut ids = BTreeSet::new();
    for rule in rules {
        validate_rule(rule)?;
        if !ids.insert(rule.id()) {
            return Err(FailureReason::InvalidScamInput);
        }
    }
    if !positive_safe(req.subject.chain_id)
        || req.subject.venue != "uniswap_v2"
        || !address(&req.subject.pool)
        || !address(&req.subject.token)
        || !address(&req.subject.quote)
    {
        return Err(FailureReason::InvalidScamInput);
    }
    if req.subject.chain_id != binding.subject.chain_id
        || req.subject.venue != binding.subject.venue
        || !same_hex(&req.subject.pool, &binding.subject.pool)
        || !same_hex(&req.subject.token, &binding.subject.token)
        || !same_hex(&req.subject.quote, &binding.subject.quote_token)
    {
        return Err(FailureReason::SubjectMismatch);
    }
    if !decimal_u256(&req.as_of.block) || !digest(&req.as_of.block_hash) || !safe(req.as_of.t_ms) {
        return Err(FailureReason::InvalidScamInput);
    }
    if req.as_of.block != binding.reference.block.number
        || !same_hex(&req.as_of.block_hash, &binding.reference.block.hash)
        || req.as_of.t_ms != binding.reference.block.timestamp_ms
        || req.as_of.t_ms != binding.to_ms
    {
        return Err(FailureReason::ReferenceMismatch);
    }

    let h = &req.pool_history;
    let p = &req.token_profile;
    let max_lookback_ms = rules
        .iter()
        .map(|r| r.lookback_sec() * 1000)
        .max()
        .unwrap_or(0);
    let warmup_ms = binding
        .warmup_sec
        .checked_mul(1000)
        .filter(|v| safe(*v))
        .ok_or(FailureReason::InvalidScamInput)?;
    let span = max_lookback_ms
        .checked_add(warmup_ms)
        .filter(|v| safe(*v))
        .ok_or(FailureReason::InvalidScamInput)?;
    if h.schema != "scam.pool_history/1"
        || p.schema != "scam.token_profile/1"
        || h.builder_version.is_empty()
        || h.builder_version != binding.builder_version
        || h.from_ms != binding.from_ms
        || h.from_ms != req.as_of.t_ms.saturating_sub(span)
        || h.warmup.from_ms != h.from_ms
        || h.bucket_ms != binding.bucket_ms
        || !positive_safe(h.bucket_ms)
        || !safe(binding.grid_origin_ms)
        || !safe(h.from_ms)
        || h.from_ms > req.as_of.t_ms
    {
        return Err(FailureReason::InvalidScamInput);
    }
    if h.points.len() as u64 > limits.max_points
        || h.missing.len() as u64 > limits.max_points
        || p.admin_events.len() as u64 > limits.max_points
        || p.missing.len() as u64 > limits.max_points
    {
        return Err(FailureReason::ResourceLimit);
    }
    if p.pool_created_ms
        .is_some_and(|t| !safe(t) || t > req.as_of.t_ms)
        || p.age_lower_bound_ms
            .is_some_and(|a| !safe(a) || a > req.as_of.t_ms)
        || (p.pool_created_ms.is_some() && p.age_lower_bound_ms.is_some())
    {
        return Err(FailureReason::InvalidScamInput);
    }
    validate_intervals(&h.missing, h.from_ms, req.as_of.t_ms)?;
    validate_intervals(&p.missing, h.from_ms, req.as_of.t_ms)?;

    let mut previous_time = None;
    let mut decimals = None;
    let mut missing_index = 0;
    for point in &h.points {
        if !safe(point.t_ms)
            || point.t_ms < h.from_ms
            || point.t_ms > req.as_of.t_ms
            || p.pool_created_ms.is_some_and(|c| point.t_ms < c)
            || previous_time.is_some_and(|t| point.t_ms <= t)
            || !on_grid(point.t_ms, binding.grid_origin_ms, h.bucket_ms)
            || !decimal_u256(&point.reserve_quote)
            || !decimal_u256(&point.reserve_token)
        {
            return Err(FailureReason::InvalidScamInput);
        }
        let current_decimals = (point.decimals_quote, point.decimals_token);
        if decimals.is_some_and(|d| d != current_decimals) {
            return Err(FailureReason::InvalidScamInput);
        }
        while missing_index < h.missing.len() && h.missing[missing_index].to_ms < point.t_ms {
            missing_index += 1;
        }
        if h.missing
            .get(missing_index)
            .is_some_and(|gap| contains(gap, point.t_ms))
        {
            return Err(FailureReason::InvalidScamInput);
        }
        previous_time = Some(point.t_ms);
        decimals = Some(current_decimals);
    }
    validate_grid_coverage(req, binding.grid_origin_ms)?;

    let mut previous_event = None;
    let mut missing_index = 0;
    for event in &p.admin_events {
        if !safe(event.t_ms)
            || event.t_ms < h.from_ms
            || event.t_ms > req.as_of.t_ms
            || p.pool_created_ms.is_some_and(|c| event.t_ms < c)
            || previous_event.is_some_and(|t| event.t_ms < t)
        {
            return Err(FailureReason::InvalidScamInput);
        }
        while missing_index < p.missing.len() && p.missing[missing_index].to_ms < event.t_ms {
            missing_index += 1;
        }
        if p.missing
            .get(missing_index)
            .is_some_and(|gap| contains(gap, event.t_ms))
        {
            return Err(FailureReason::InvalidScamInput);
        }
        previous_event = Some(event.t_ms);
    }
    Ok(())
}

pub(super) fn validate_output(
    out: &ScamAnalysis,
    req: &AnalysisRequest,
    expected_identity: &AlgorithmIdentity,
    expected_mode: AnalysisMode,
    rules_hash: &str,
    limits: &AlgorithmLimits,
    requirements: &[AlgorithmRuleRequirements],
) -> Result<(), FailureReason> {
    let invalid = FailureReason::InvalidAlgorithmOutput;
    if out.algorithm_id != expected_identity.id
        || out.algorithm_version != expected_identity.version
        || out.contract_version != 1
        || out.contract_version != expected_identity.contract_version
        || out.analysis_mode != expected_mode
        || out.binding.chain_id != req.subject.chain_id
        || !same_hex(&out.binding.pool, &req.subject.pool)
        || out.binding.as_of_block != req.as_of.block
        || !same_hex(&out.binding.as_of_block_hash, &req.as_of.block_hash)
        || out.binding.rules_hash != rules_hash
        || out.rules.len() != req.rules.len()
        || requirements.len() != req.rules.len()
    {
        return Err(invalid);
    }
    if out.rules.len() as u64 > limits.max_rules {
        return Err(FailureReason::ResourceLimit);
    }
    let mut ids = BTreeSet::new();
    for result in &out.rules {
        if !ids.insert(result.rule_id.as_str()) {
            return Err(invalid);
        }
        let index = req
            .rules
            .iter()
            .position(|r| r.id() == result.rule_id)
            .ok_or(invalid)?;
        let rule = &req.rules[index];
        let requirement = &requirements[index];
        if !finite_safe(result.threshold)
            || result.threshold != rule.threshold() as f64
            || result.coverage_bps > 10_000
            || result.observed.is_some_and(|v| !finite_safe(v))
        {
            return Err(invalid);
        }
        let coarse = resolution_too_coarse(rule, req.pool_history.bucket_ms);
        if coarse
            && (result.outcome != RuleState::NotEvaluable
                || result.reason != Some(AlgorithmRuleReason::ResolutionTooCoarse))
        {
            return Err(invalid);
        }
        if !coarse && result.reason == Some(AlgorithmRuleReason::ResolutionTooCoarse) {
            return Err(invalid);
        }
        match result.outcome {
            RuleState::Clear if result.reason.is_some() => return Err(invalid),
            RuleState::Incomplete | RuleState::NotEvaluable if result.reason.is_none() => {
                return Err(invalid);
            }
            _ => {}
        }

        let is_count = !matches!(rule, RuleSpec::WindowDrop { .. });
        if is_count {
            if result.observed.is_some_and(|n| n.fract() != 0.0)
                || (matches!(result.outcome, RuleState::Clear | RuleState::Fired)
                    && result.observed.is_none())
            {
                return Err(invalid);
            }
            // This is only a physical upper bound (one confirmation per grid
            // point), not an attempt to reproduce the detector's event count.
            let start = horizon_start(req, rule);
            let maximum = if matches!(rule, RuleSpec::EventCount { .. }) {
                req.token_profile
                    .admin_events
                    .iter()
                    .filter(|e| e.t_ms > start)
                    .count()
            } else {
                req.pool_history
                    .points
                    .iter()
                    .filter(|p| {
                        p.t_ms > start
                            && (rule.metric() != Some(Metric::PriceQuotePerToken)
                                || p.reserve_token != "0")
                    })
                    .count()
            };
            if result.observed.is_some_and(|n| n > maximum as f64) {
                return Err(invalid);
            }
        } else if result.observed.is_some_and(|n| n > 10_000.0) {
            return Err(invalid);
        }
        if let Some(observed) = result.observed {
            if (result.outcome == RuleState::Fired && observed < result.threshold)
                || (result.outcome == RuleState::Clear && observed >= result.threshold)
            {
                return Err(invalid);
            }
        }
        if result.outcome == RuleState::Clear
            && !clear_has_complete_data(req, rule, result, requirement)
        {
            return Err(invalid);
        }
        validate_evidence(req, rule, result, limits)?;
    }
    Ok(())
}

fn validate_rule(rule: &RuleSpec) -> Result<(), FailureReason> {
    let invalid = FailureReason::InvalidScamInput;
    if rule.id().is_empty()
        || !rule.enabled()
        || rule.lookback_sec() == 0
        || rule.lookback_sec() > MAX_LOOKBACK_SEC
    {
        return Err(invalid);
    }
    match rule {
        RuleSpec::ChangeCount {
            threshold_bps,
            direction,
            count,
            ..
        } => {
            if !positive_safe(*threshold_bps)
                || !positive_safe(*count)
                || (*direction == Direction::Down && *threshold_bps > 10_000)
            {
                return Err(invalid);
            }
        }
        RuleSpec::SwitchDensity {
            window_sec,
            reversal_bps,
            count,
            ..
        } => {
            if *window_sec == 0
                || *window_sec > rule.lookback_sec()
                || !positive_safe(*reversal_bps)
                || !positive_safe(*count)
            {
                return Err(invalid);
            }
        }
        RuleSpec::WindowDrop {
            metric,
            window_sec,
            drop_bps,
            ..
        } => {
            if *metric != Metric::QuoteReserve
                || *window_sec == 0
                || *window_sec > rule.lookback_sec()
                || *drop_bps == 0
                || *drop_bps > 10_000
            {
                return Err(invalid);
            }
        }
        RuleSpec::EventCount {
            event_kinds, count, ..
        } => {
            if !positive_safe(*count)
                || event_kinds.is_empty()
                || event_kinds.len() > 5
                || event_kinds
                    .iter()
                    .enumerate()
                    .any(|(i, k)| event_kinds[..i].contains(k))
            {
                return Err(invalid);
            }
        }
    }
    Ok(())
}

fn validate_intervals(
    intervals: &[SnapshotInterval],
    from: u64,
    to: u64,
) -> Result<(), FailureReason> {
    let mut previous_end = None;
    for interval in intervals {
        if !safe(interval.from_ms)
            || !safe(interval.to_ms)
            || interval.from_ms < from
            || interval.to_ms > to
            || interval.from_ms >= interval.to_ms
            || previous_end.is_some_and(|end| interval.from_ms < end)
        {
            return Err(FailureReason::InvalidScamInput);
        }
        previous_end = Some(interval.to_ms);
    }
    Ok(())
}

/// Linear in points + missing intervals, never in the number of empty buckets.
/// Coverage is (fromMs, T]; a point at fromMs is an optional boundary seed.
fn validate_grid_coverage(req: &AnalysisRequest, origin: u64) -> Result<(), FailureReason> {
    let h = &req.pool_history;
    let start = h
        .from_ms
        .saturating_add(1)
        .max(req.token_profile.pool_created_ms.unwrap_or(0));
    let mut cursor = grid_at_or_after(start, origin, h.bucket_ms);
    let mut point_index = 0;
    let mut missing_index = 0;
    while let Some(t) = cursor.filter(|t| *t <= req.as_of.t_ms) {
        while point_index < h.points.len() && h.points[point_index].t_ms < t {
            point_index += 1;
        }
        while missing_index < h.missing.len() && h.missing[missing_index].to_ms < t {
            missing_index += 1;
        }
        if h.points
            .get(point_index)
            .is_some_and(|point| point.t_ms == t)
        {
            point_index += 1;
            cursor = t.checked_add(h.bucket_ms);
        } else if let Some(gap) = h.missing.get(missing_index).filter(|gap| contains(gap, t)) {
            cursor = gap
                .to_ms
                .checked_add(1)
                .and_then(|next| grid_at_or_after(next, origin, h.bucket_ms));
            missing_index += 1;
        } else {
            return Err(FailureReason::InvalidScamInput);
        }
    }
    Ok(())
}

pub(super) fn resolution_too_coarse(rule: &RuleSpec, bucket_ms: u64) -> bool {
    match rule {
        RuleSpec::ChangeCount {
            lookback_sec,
            count,
            ..
        } => {
            u128::from(*lookback_sec) * 1000
                <= u128::from(count.saturating_sub(1)) * u128::from(bucket_ms)
        }
        RuleSpec::SwitchDensity {
            window_sec, count, ..
        } => {
            u128::from(*window_sec) * 1000
                <= u128::from(count.saturating_sub(1)) * u128::from(bucket_ms)
        }
        RuleSpec::WindowDrop { window_sec, .. } => {
            u128::from(*window_sec) * 1000 < u128::from(bucket_ms)
        }
        RuleSpec::EventCount { .. } => false,
    }
}

fn clear_has_complete_data(
    req: &AnalysisRequest,
    rule: &RuleSpec,
    result: &AlgorithmRuleResult,
    requirement: &AlgorithmRuleRequirements,
) -> bool {
    if result.coverage_bps != 10_000 {
        return false;
    }
    let end = req.as_of.t_ms;
    let start = horizon_start(req, rule);
    if matches!(rule, RuleSpec::EventCount { .. }) {
        // History/warm-up gaps do not invalidate an independently complete
        // administrator-event query, nor vice versa.
        return !overlaps(&req.token_profile.missing, start, end);
    }
    let h = &req.pool_history;
    if overlaps(&h.missing, start, end)
        || invalid_price_in_range(req, rule, start, end)
        || !h.points.iter().any(|p| {
            p.t_ms > start
                && p.t_ms <= end
                && (rule.metric() != Some(Metric::PriceQuotePerToken) || p.reserve_token != "0")
        })
    {
        return false;
    }
    initial_state_satisfied(req, rule, result, requirement)
}

/// Source availability and the module's actual state claim are both required.
/// This does not infer a zigzag direction or replay initial-state computation.
pub(super) fn initial_state_satisfied(
    req: &AnalysisRequest,
    rule: &RuleSpec,
    result: &AlgorithmRuleResult,
    requirement: &AlgorithmRuleRequirements,
) -> bool {
    if matches!(rule, RuleSpec::EventCount { .. }) || !requirement.requires_initial_state {
        return true;
    }
    let h = &req.pool_history;
    if !h.warmup.complete || !result.warmup_complete {
        return false;
    }
    let start = horizon_start(req, rule);
    let warmup_start = start
        .saturating_sub(requirement.minimum_warmup_ms)
        .max(req.token_profile.pool_created_ms.unwrap_or(0));
    if warmup_start < h.from_ms
        || overlaps(&h.missing, warmup_start, start)
        || h.missing.iter().any(|gap| contains(gap, warmup_start))
    {
        return false;
    }
    // A boundary seed can be required for initial state even though it is
    // outside the open-left event-counting window.
    if rule.metric() == Some(Metric::PriceQuotePerToken)
        && h.points
            .iter()
            .any(|p| p.t_ms >= warmup_start && p.t_ms <= start && p.reserve_token == "0")
    {
        return false;
    }
    true
}

fn validate_evidence(
    req: &AnalysisRequest,
    rule: &RuleSpec,
    result: &AlgorithmRuleResult,
    limits: &AlgorithmLimits,
) -> Result<(), FailureReason> {
    let invalid = FailureReason::InvalidAlgorithmOutput;
    let start = horizon_start(req, rule);
    let end = req.as_of.t_ms;
    if let Some(window) = &result.window {
        if !safe(window.start_ms)
            || !safe(window.end_ms)
            || window.start_ms < start
            || window.end_ms > end
            || window.start_ms >= window.end_ms
        {
            return Err(invalid);
        }
        if let RuleSpec::SwitchDensity { window_sec, .. } = rule {
            if window.start_ms != start.max(window.end_ms.saturating_sub(window_sec * 1000)) {
                return Err(invalid);
            }
        }
    }
    if matches!(rule, RuleSpec::SwitchDensity { .. }) {
        match result.observed {
            Some(n) if n > 0.0 && result.window.is_none() => return Err(invalid),
            Some(n) if n == 0.0 && result.window.is_some() => return Err(invalid),
            _ => {}
        }
    }
    let Some(events) = &result.events else {
        return Ok(());
    };
    if events.len() as u64 > limits.max_evidence_events_per_rule.min(MAX_EVIDENCE_EVENTS) {
        return Err(FailureReason::ResourceLimit);
    }
    let is_admin = matches!(rule, RuleSpec::EventCount { .. });
    let is_count = !matches!(rule, RuleSpec::WindowDrop { .. });
    if is_count && result.observed.is_some_and(|n| events.len() as f64 > n) {
        return Err(invalid);
    }
    let gaps = if is_admin {
        &req.token_profile.missing
    } else {
        &req.pool_history.missing
    };
    let mut previous_time = None;
    for (index, event) in events.iter().enumerate() {
        if !safe(event.t_ms)
            || event.t_ms <= start
            || event.t_ms > end
            || previous_time.is_some_and(|t| {
                if is_admin {
                    event.t_ms < t
                } else {
                    event.t_ms <= t
                }
            })
            || gaps.iter().any(|gap| contains(gap, event.t_ms))
            || !event_kind_valid(rule, &event.kind)
        {
            return Err(invalid);
        }
        if !is_admin {
            let point = req
                .pool_history
                .points
                .binary_search_by_key(&event.t_ms, |p| p.t_ms)
                .ok()
                .map(|i| &req.pool_history.points[i])
                .ok_or(invalid)?;
            if rule.metric() == Some(Metric::PriceQuotePerToken) && point.reserve_token == "0" {
                return Err(invalid);
            }
        } else {
            // Distinct administrator events may legitimately share a timestamp.
            // Preserve their multiplicity without allowing fabricated duplicates.
            let provided = events[..=index]
                .iter()
                .filter(|previous| previous.t_ms == event.t_ms && previous.kind == event.kind)
                .count();
            let available = req
                .token_profile
                .admin_events
                .iter()
                .filter(|actual| actual.t_ms == event.t_ms && admin_name(actual.kind) == event.kind)
                .count();
            if provided > available {
                return Err(invalid);
            }
        }
        if let Some(window) = &result.window {
            if event.t_ms <= window.start_ms || event.t_ms > window.end_ms {
                return Err(invalid);
            }
        }
        previous_time = Some(event.t_ms);
    }
    if matches!(rule, RuleSpec::SwitchDensity { .. })
        && result.observed == Some(events.len() as f64)
        && !events.is_empty()
        && result
            .window
            .as_ref()
            .is_some_and(|window| Some(window.end_ms) != previous_time)
    {
        return Err(invalid);
    }
    Ok(())
}

fn event_kind_valid(rule: &RuleSpec, kind: &str) -> bool {
    match rule {
        RuleSpec::ChangeCount { direction, .. } => match direction {
            Direction::Up => kind == "up",
            Direction::Down => kind == "down",
            Direction::Either => matches!(kind, "up" | "down"),
        },
        RuleSpec::SwitchDensity { .. } => matches!(kind, "peak" | "trough"),
        RuleSpec::WindowDrop { .. } => kind == "drop",
        RuleSpec::EventCount { event_kinds, .. } => {
            event_kinds.iter().any(|k| admin_name(*k) == kind)
        }
    }
}

fn admin_name(kind: AdminEventKind) -> &'static str {
    match kind {
        AdminEventKind::OwnerChanged => "owner_changed",
        AdminEventKind::ProxyUpgraded => "proxy_upgraded",
        AdminEventKind::AdminChanged => "admin_changed",
        AdminEventKind::Paused => "paused",
        AdminEventKind::Unpaused => "unpaused",
    }
}

fn horizon_start(req: &AnalysisRequest, rule: &RuleSpec) -> u64 {
    req.as_of
        .t_ms
        .saturating_sub(rule.lookback_sec() * 1000)
        .max(req.token_profile.pool_created_ms.unwrap_or(0))
}

fn invalid_price_in_range(req: &AnalysisRequest, rule: &RuleSpec, from: u64, to: u64) -> bool {
    rule.metric() == Some(Metric::PriceQuotePerToken)
        && req
            .pool_history
            .points
            .iter()
            .any(|p| p.t_ms > from && p.t_ms <= to && p.reserve_token == "0")
}

fn overlaps(intervals: &[SnapshotInterval], from: u64, to: u64) -> bool {
    intervals
        .iter()
        .any(|gap| gap.to_ms > from && gap.from_ms < to)
}

fn contains(interval: &SnapshotInterval, time: u64) -> bool {
    time > interval.from_ms && time <= interval.to_ms
}

fn on_grid(time: u64, origin: u64, bucket: u64) -> bool {
    time % bucket == origin % bucket
}

fn grid_at_or_after(time: u64, origin: u64, bucket: u64) -> Option<u64> {
    let remainder = time % bucket;
    let target = origin % bucket;
    let offset = if remainder <= target {
        target - remainder
    } else {
        bucket - (remainder - target)
    };
    time.checked_add(offset)
}

fn safe(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER
}
fn positive_safe(value: u64) -> bool {
    value > 0 && safe(value)
}
fn finite_safe(value: f64) -> bool {
    value.is_finite() && value >= 0.0 && value <= MAX_SAFE_INTEGER as f64
}
fn address(value: &str) -> bool {
    hex_string(value, 40)
}
fn digest(value: &str) -> bool {
    hex_string(value, 64)
}
fn same_hex(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn hex_string(value: &str, digits: usize) -> bool {
    value.len() == digits + 2
        && value.starts_with("0x")
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

fn decimal_u256(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 78
        && (value == "0" || !value.starts_with('0'))
        && value.as_bytes().iter().all(u8::is_ascii_digit)
        && U256::from_str_radix(value, 10).is_ok()
}
