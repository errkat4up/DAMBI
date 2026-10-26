//! Rule evaluation on the window `(B, T]`, `B = max(T - X1, pool creation)`.
//!
//! Outcomes: `fired` when the observed events alone meet the threshold; `clear` only when the
//! whole window is observed and the rule's warm-up is met; `incomplete` otherwise;
//! `not_evaluable` when the rule cannot run at this resolution or has no data.
//!
//! Warm-up (observed history before `B`, cut at pool creation, plus the host's
//! `warmup.complete`): cumulative R1 and R2 need [`WARMUP_SEC`], window_drop needs `windowSec`,
//! step R1 and event_count need none.
use crate::generators::{cumulative_events, drop_events, step_events, zigzag_switches, Sample};
use crate::series::{coverage_bps, metric_series};
use crate::types::*;
use crate::{AlgorithmPort, CONTRACT_VERSION};

/// Longest lookback the MVP supports (24 h).
pub const MAX_LOOKBACK_SEC: u64 = 86_400;

/// Observed history required before the window start for the stateful generators (cumulative
/// R1, R2), unless the history reaches pool creation.
pub const WARMUP_SEC: u64 = 86_400;

/// The MVP window-rule algorithm.
#[derive(Clone, Copy, Debug, Default)]
pub struct WindowRules;

fn frac(bps: u32) -> f64 {
    f64::from(bps) / 10_000.0
}

fn secs_to_ms(s: u64) -> Result<i64, AlgorithmError> {
    i64::try_from(s)
        .ok()
        .and_then(|v| v.checked_mul(1_000))
        .ok_or_else(|| AlgorithmError::InvalidInput("duration out of range".into()))
}

/// Events in `(lo, hi]`.
fn in_window(events: &[i64], lo: i64, hi: i64) -> Vec<i64> {
    events
        .iter()
        .copied()
        .filter(|&e| e > lo && e <= hi)
        .collect()
}

/// R2 evidence: the window `(max(B, end - X2), end]` with the most switches, ties -> latest end.
pub fn r2_evidence(switches: &[i64], window_ms: i64, b: i64, t: i64) -> Option<(u64, i64, i64)> {
    let s = in_window(switches, b, t);
    let mut best: Option<(u64, i64, i64)> = None;
    for &end in &s {
        let lo = b.max(end.saturating_sub(window_ms));
        let c = s.iter().filter(|&&x| x > lo && x <= end).count() as u64;
        if best.is_none_or(|(bc, _, _)| c >= bc) {
            best = Some((c, lo, end));
        }
    }
    best
}

/// `(k - 1) * dt < len` for the event-count rules; `window >= dt` for window_drop (MVP minimum).
fn resolution_ok(rule: &RuleSpec, dt_ms: i64) -> Result<bool, AlgorithmError> {
    let need = |k: u32, len_ms: i64| -> bool {
        let steps = i64::from(k.saturating_sub(1));
        steps.saturating_mul(dt_ms) < len_ms
    };
    Ok(match rule {
        RuleSpec::ChangeCount {
            lookback_sec,
            min_count,
            ..
        } => need(*min_count, secs_to_ms(*lookback_sec)?),
        RuleSpec::SwitchDensity {
            window_sec,
            min_count,
            ..
        } => need(*min_count, secs_to_ms(*window_sec)?),
        RuleSpec::WindowDrop { window_sec, .. } => secs_to_ms(*window_sec)? >= dt_ms,
        RuleSpec::EventCount { .. } => true,
    })
}

fn evidence(events: &[i64], kind: &str, cap: usize) -> Vec<EvidenceEvent> {
    let skip = events.len().saturating_sub(cap);
    events
        .iter()
        .skip(skip)
        .map(|&t_ms| EvidenceEvent {
            t_ms,
            kind: kind.to_string(),
        })
        .collect()
}

/// What a rule found before the outcome is decided.
struct Finding {
    fired: bool,
    observed: u64,
    threshold: u64,
    window: Option<EvidenceWindow>,
    events: Vec<EvidenceEvent>,
    /// (coverage bps of the window, undefined point inside the window)
    coverage: (u32, bool),
    /// Whether the history before the window start meets the rule's warm-up requirement.
    warm: bool,
}

struct Ctx<'a> {
    req: &'a AnalysisRequest,
    limits: &'a Limits,
    t: i64,
}

impl Ctx<'_> {
    fn window_start(&self, lookback_ms: i64) -> i64 {
        self.window_floor(self.t.saturating_sub(lookback_ms))
    }

    /// `t` raised to the pool creation time when it is known.
    fn window_floor(&self, t: i64) -> i64 {
        match self.req.token_profile.pool_created_ms {
            Some(c) => t.max(c),
            None => t,
        }
    }

    fn series(&self, metric: Metric) -> Result<Vec<Sample>, AlgorithmError> {
        metric_series(&self.req.pool_history, metric, self.t)
    }

    /// Coverage of `(b, t]` for a metric series: missing ranges and data start, plus whether an
    /// undefined point lies inside the window.
    fn pool_coverage(&self, series: &[Sample], b: i64) -> (u32, bool) {
        let first = series.first().map(|s| s.0);
        let cov = coverage_bps(b, self.t, first, &self.req.pool_history.missing);
        let undefined_inside = series
            .iter()
            .any(|&(ts, v)| v.is_none() && ts > b && ts <= self.t);
        (cov, undefined_inside)
    }

    /// Warm-up of `need_ms` before `b`: the host vouches for the history (`warmup.complete`) and
    /// `(max(b - need_ms, pool creation), b]` is observed. No requirement when `need_ms` is 0.
    fn warm(&self, series: &[Sample], b: i64, need_ms: i64) -> bool {
        if need_ms == 0 {
            return true;
        }
        let start = self.window_floor(b.saturating_sub(need_ms));
        let first = series.first().map(|s| s.0);
        self.req.pool_history.warmup.complete
            && coverage_bps(start, b, first, &self.req.pool_history.missing) == 10_000
    }

    fn result(&self, rule: &RuleSpec, f: Finding) -> RuleResult {
        let Finding {
            fired,
            observed,
            threshold,
            window,
            events,
            coverage,
            warm,
        } = f;
        let (cov, undefined_inside) = coverage;
        let full = cov == 10_000 && !undefined_inside;
        let (outcome, reason) = if fired {
            (Outcome::Fired, None)
        } else if full && warm {
            (Outcome::Clear, None)
        } else if !full {
            (Outcome::Incomplete, Some(Reason::PartialCoverage))
        } else {
            (Outcome::Incomplete, Some(Reason::WarmupIncomplete))
        };
        RuleResult {
            rule_id: rule.id().to_string(),
            outcome,
            reason,
            observed: Some(observed),
            threshold,
            window,
            events,
            coverage_bps: cov,
            warmup_complete: warm,
        }
    }

    fn not_evaluable(&self, rule: &RuleSpec, threshold: u64, reason: Reason) -> RuleResult {
        RuleResult {
            rule_id: rule.id().to_string(),
            outcome: Outcome::NotEvaluable,
            reason: Some(reason),
            observed: None,
            threshold,
            window: None,
            events: Vec::new(),
            coverage_bps: 0,
            warmup_complete: self.req.pool_history.warmup.complete,
        }
    }

    fn eval(&self, rule: &RuleSpec) -> Result<RuleResult, AlgorithmError> {
        let cap = self.limits.max_evidence_events;
        let threshold = match rule {
            RuleSpec::ChangeCount { min_count, .. }
            | RuleSpec::SwitchDensity { min_count, .. }
            | RuleSpec::EventCount { min_count, .. } => u64::from(*min_count),
            RuleSpec::WindowDrop { .. } => 1,
        };
        if !resolution_ok(rule, self.req.pool_history.bucket_ms)? {
            return Ok(self.not_evaluable(rule, threshold, Reason::ResolutionTooCoarse));
        }
        let b = self.window_start(secs_to_ms(rule.lookback_sec())?);
        let window = Some(EvidenceWindow {
            start_ms: b,
            end_ms: self.t,
        });

        if let RuleSpec::EventCount { kinds, .. } = rule {
            let ev: Vec<i64> = self
                .req
                .token_profile
                .admin_events
                .iter()
                .filter(|e| kinds.contains(&e.kind) && e.t_ms > b && e.t_ms <= self.t)
                .map(|e| e.t_ms)
                .collect();
            let n = ev.len() as u64;
            let cov = coverage_bps(b, self.t, Some(b), &self.req.token_profile.missing);
            let ev_out = evidence(&ev, "admin_event", cap);
            return Ok(self.result(
                rule,
                Finding {
                    fired: n >= threshold,
                    observed: n,
                    threshold,
                    window,
                    events: ev_out,
                    coverage: (cov, false),
                    warm: true,
                },
            ));
        }

        let metric = match rule {
            RuleSpec::ChangeCount { metric, .. } | RuleSpec::SwitchDensity { metric, .. } => {
                *metric
            }
            _ => Metric::Liquidity,
        };
        let series = self.series(metric)?;
        if !series.iter().any(|&(ts, v)| v.is_some() && ts <= self.t) {
            return Ok(self.not_evaluable(rule, threshold, Reason::NoUsableSegment));
        }
        let cov = self.pool_coverage(&series, b);

        Ok(match rule {
            RuleSpec::ChangeCount {
                min_change_bps,
                direction,
                mode,
                ..
            } => {
                let need = match mode {
                    ChangeMode::Step => 0,
                    ChangeMode::Cumulative => secs_to_ms(WARMUP_SEC)?,
                };
                let warm = self.warm(&series, b, need);
                let i = frac(*min_change_bps);
                let all = match mode {
                    ChangeMode::Step => step_events(&series, i, *direction),
                    ChangeMode::Cumulative => cumulative_events(&series, i, *direction),
                };
                let ev = in_window(&all, b, self.t);
                let n = ev.len() as u64;
                self.result(
                    rule,
                    Finding {
                        fired: n >= threshold,
                        observed: n,
                        threshold,
                        window,
                        events: evidence(&ev, "change", cap),
                        coverage: cov,
                        warm,
                    },
                )
            }
            RuleSpec::SwitchDensity {
                window_sec,
                reversal_bps,
                switch_kind,
                ..
            } => {
                let all = zigzag_switches(&series, frac(*reversal_bps), *switch_kind);
                let x2 = secs_to_ms(*window_sec)?;
                let warm = self.warm(&series, b, secs_to_ms(WARMUP_SEC)?);
                match r2_evidence(&all, x2, b, self.t) {
                    Some((n, lo, end)) => {
                        let ev = in_window(&all, lo, end);
                        let w = Some(EvidenceWindow {
                            start_ms: lo,
                            end_ms: end,
                        });
                        self.result(
                            rule,
                            Finding {
                                fired: n >= threshold,
                                observed: n,
                                threshold,
                                window: w,
                                events: evidence(&ev, "switch", cap),
                                coverage: cov,
                                warm,
                            },
                        )
                    }
                    None => self.result(
                        rule,
                        Finding {
                            fired: false,
                            observed: 0,
                            threshold,
                            window,
                            events: Vec::new(),
                            coverage: cov,
                            warm,
                        },
                    ),
                }
            }
            RuleSpec::WindowDrop {
                window_sec,
                min_drop_bps,
                ..
            } => {
                let x2 = secs_to_ms(*window_sec)?;
                let ev = in_window(&drop_events(&series, frac(*min_drop_bps), x2), b, self.t);
                let n = ev.len() as u64;
                let w = ev.last().map(|&e| EvidenceWindow {
                    start_ms: e.saturating_sub(x2),
                    end_ms: e,
                });
                self.result(
                    rule,
                    Finding {
                        fired: n >= 1,
                        observed: n,
                        threshold,
                        window: w.or(window),
                        events: evidence(&ev, "drop", cap),
                        coverage: cov,
                        warm: self.warm(&series, b, x2),
                    },
                )
            }
            RuleSpec::EventCount { .. } => {
                self.not_evaluable(rule, threshold, Reason::MetricUnavailable)
            }
        })
    }
}

fn check_bps(v: u32, max: Option<u32>, what: &str) -> Result<(), String> {
    if v == 0 {
        return Err(format!("{what} must be > 0"));
    }
    if let Some(m) = max {
        if v > m {
            return Err(format!("{what} must be <= {m}"));
        }
    }
    Ok(())
}

fn check_rule(rule: &RuleSpec) -> Result<(), String> {
    let lb = rule.lookback_sec();
    if lb == 0 || lb > MAX_LOOKBACK_SEC {
        return Err(format!("lookbackSec must be in 1..={MAX_LOOKBACK_SEC}"));
    }
    match rule {
        RuleSpec::ChangeCount {
            min_change_bps,
            direction,
            min_count,
            ..
        } => {
            // A fall can be at most 100%; a rise is unbounded.
            let max = (*direction != Direction::Up).then_some(10_000);
            check_bps(*min_change_bps, max, "minChangeBps")?;
            if *min_count == 0 {
                return Err("minCount must be > 0".into());
            }
        }
        RuleSpec::SwitchDensity {
            lookback_sec,
            window_sec,
            reversal_bps,
            switch_kind,
            min_count,
            ..
        } => {
            if *window_sec == 0 || window_sec > lookback_sec {
                return Err("windowSec must satisfy 0 < windowSec <= lookbackSec".into());
            }
            // A peak needs a fall of theta; a fall can be at most 100%.
            let max = (*switch_kind != SwitchKind::Trough).then_some(10_000);
            check_bps(*reversal_bps, max, "reversalBps")?;
            if *min_count == 0 {
                return Err("minCount must be > 0".into());
            }
        }
        RuleSpec::WindowDrop {
            lookback_sec,
            window_sec,
            min_drop_bps,
            ..
        } => {
            if *window_sec == 0 || window_sec > lookback_sec {
                return Err("windowSec must satisfy 0 < windowSec <= lookbackSec".into());
            }
            check_bps(*min_drop_bps, Some(10_000), "minDropBps")?;
        }
        RuleSpec::EventCount {
            kinds, min_count, ..
        } => {
            if kinds.is_empty() {
                return Err("kinds must not be empty".into());
            }
            if *min_count == 0 {
                return Err("minCount must be > 0".into());
            }
        }
    }
    Ok(())
}

impl AlgorithmPort for WindowRules {
    fn id(&self) -> &'static str {
        "dambi.scam.window-rules"
    }

    fn version(&self) -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    fn contract_version(&self) -> u32 {
        CONTRACT_VERSION
    }

    fn supports(&self, rule: &RuleSpec) -> Support {
        match check_rule(rule) {
            Ok(()) => Support::Supported,
            Err(e) => Support::Unsupported(e),
        }
    }

    fn analyze(
        &self,
        req: &AnalysisRequest,
        limits: &Limits,
    ) -> Result<ScamAnalysis, AlgorithmError> {
        if req.rules.len() > limits.max_rules {
            return Err(AlgorithmError::LimitExceeded("rules"));
        }
        if req.pool_history.points.len() > limits.max_points {
            return Err(AlgorithmError::LimitExceeded("points"));
        }
        if req.token_profile.admin_events.len() > limits.max_admin_events {
            return Err(AlgorithmError::LimitExceeded("adminEvents"));
        }
        if req.pool_history.bucket_ms <= 0 {
            return Err(AlgorithmError::InvalidInput("bucketMs must be > 0".into()));
        }
        for rule in &req.rules {
            if let Err(reason) = check_rule(rule) {
                return Err(AlgorithmError::Unsupported {
                    rule: rule.id().to_string(),
                    reason,
                });
            }
        }
        let ctx = Ctx {
            req,
            limits,
            t: req.as_of.t_ms,
        };
        let rules = req
            .rules
            .iter()
            .map(|r| ctx.eval(r))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ScamAnalysis {
            algorithm_id: self.id().to_string(),
            algorithm_version: self.version().to_string(),
            contract_version: CONTRACT_VERSION,
            analysis_mode: AnalysisMode::Real,
            binding: Binding {
                chain_id: req.subject.chain_id,
                pool: req.subject.pool.clone(),
                as_of_block: req.as_of.block.clone(),
                as_of_block_hash: req.as_of.block_hash.clone(),
                rules_hash: req.rules_hash.clone(),
            },
            rules,
        })
    }
}
