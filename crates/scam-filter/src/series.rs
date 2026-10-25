//! Metric series from normalized pool snapshots.
//!
//! * `liquidity` = quote reserve (decimals applied). `0` is a valid observation.
//! * `price` = quote reserve / token reserve (decimals applied). A token reserve of `0` makes the
//!   point undefined (`None`), which splits the series like missing data.
//! * A missing range between two points inserts a `None` break so no event spans it.
use crate::generators::Sample;
use crate::types::{AlgorithmError, Metric, PoolHistory, TimeRange};

fn parse_amount(s: &str, decimals: u8) -> Result<f64, AlgorithmError> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AlgorithmError::InvalidInput(format!(
            "reserve is not a decimal integer: {s:?}"
        )));
    }
    let v: f64 = s
        .parse()
        .map_err(|_| AlgorithmError::InvalidInput(format!("reserve out of range: {s:?}")))?;
    Ok(v / 10f64.powi(i32::from(decimals)))
}

fn overlaps(r: &TimeRange, from_exclusive: i64, to_exclusive: i64) -> bool {
    r.from_ms < to_exclusive && r.to_ms > from_exclusive
}

/// Validated metric series (ascending time, `None` = undefined point or missing break).
pub fn metric_series(
    h: &PoolHistory,
    metric: Metric,
    as_of_ms: i64,
) -> Result<Vec<Sample>, AlgorithmError> {
    let mut out: Vec<Sample> = Vec::with_capacity(h.points.len());
    let mut last_t: Option<i64> = None;
    for p in &h.points {
        if let Some(prev) = last_t {
            if p.t_ms <= prev {
                return Err(AlgorithmError::InvalidInput(
                    "pool points must have strictly increasing tMs".into(),
                ));
            }
            if let Some(gap) = h.missing.iter().find(|r| overlaps(r, prev, p.t_ms)) {
                out.push((gap.from_ms.max(prev), None));
            }
        }
        if p.t_ms > as_of_ms {
            return Err(AlgorithmError::InvalidInput(
                "pool point after the as-of time".into(),
            ));
        }
        let quote = parse_amount(&p.reserve_quote, p.decimals_quote)?;
        let value = match metric {
            Metric::Liquidity => Some(quote),
            Metric::Price => {
                let token = parse_amount(&p.reserve_token, p.decimals_token)?;
                if token > 0.0 {
                    Some(quote / token)
                } else {
                    None
                }
            }
        };
        out.push((p.t_ms, value));
        last_t = Some(p.t_ms);
    }
    Ok(out)
}

/// Share of `(start, end]` that is observed, in bps, given the first observation time and the
/// missing ranges. Time before the first point counts as unobserved.
pub fn coverage_bps(start: i64, end: i64, first_obs: Option<i64>, missing: &[TimeRange]) -> u32 {
    let len = end.saturating_sub(start);
    if len <= 0 {
        return 10_000;
    }
    let mut gaps: Vec<(i64, i64)> = Vec::new();
    match first_obs {
        None => return 0,
        Some(f) if f > start => gaps.push((start, f.min(end))),
        Some(_) => {}
    }
    for r in missing {
        let a = r.from_ms.max(start);
        let b = r.to_ms.min(end);
        if b > a {
            gaps.push((a, b));
        }
    }
    gaps.sort_unstable();
    let mut uncovered: i64 = 0;
    let mut cur: Option<(i64, i64)> = None;
    for (a, b) in gaps {
        cur = match cur {
            Some((ca, cb)) if a <= cb => Some((ca, cb.max(b))),
            Some((ca, cb)) => {
                uncovered = uncovered.saturating_add(cb.saturating_sub(ca));
                Some((a, b))
            }
            None => Some((a, b)),
        };
    }
    if let Some((ca, cb)) = cur {
        uncovered = uncovered.saturating_add(cb.saturating_sub(ca));
    }
    let covered = len.saturating_sub(uncovered).max(0);
    // floor(covered / len * 10000) without overflow for realistic ms ranges.
    let bps = (i128::from(covered) * 10_000) / i128::from(len);
    u32::try_from(bps.clamp(0, 10_000)).unwrap_or(0)
}
