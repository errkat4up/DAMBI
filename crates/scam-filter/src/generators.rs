//! Event generators. A series is `(t_ms, value)`; `None` is an undefined or missing point.
//!
//! * `0` is a valid observation (a drained pool is a real -100% move).
//! * `None` splits the series: state resets and no event spans the gap.
//! * A move whose base is `0` has no percentage: no event, and the state restarts at the next
//!   positive value.
//!
//! The arithmetic mirrors the Python reference (`x / p - 1.0`, `lo * (1.0 + i)`, ...) so the
//! fixtures match exactly.
use std::collections::VecDeque;

use crate::types::{Direction, SwitchKind};

pub type Sample = (i64, Option<f64>);

fn wants_up(d: Direction) -> bool {
    matches!(d, Direction::Both | Direction::Up)
}

fn wants_down(d: Direction) -> bool {
    matches!(d, Direction::Both | Direction::Down)
}

/// Compare each point with the previous defined point `p > 0`.
pub fn step_events(series: &[Sample], i: f64, dir: Direction) -> Vec<i64> {
    let mut out = Vec::new();
    let mut prev: Option<f64> = None;
    for &(t, x) in series {
        let Some(x) = x else {
            prev = None;
            continue;
        };
        if let Some(p) = prev.filter(|p| *p > 0.0) {
            let r = x / p - 1.0;
            if (r >= i && wants_up(dir)) || (r <= -i && wants_down(dir)) {
                out.push(t);
            }
        }
        prev = Some(x);
    }
    out
}

/// Change from the running hi/lo since the last event (or segment start).
pub fn cumulative_events(series: &[Sample], i: f64, dir: Direction) -> Vec<i64> {
    let mut out = Vec::new();
    let mut hl: Option<(f64, f64)> = None;
    for &(t, x) in series {
        let Some(x) = x else {
            hl = None;
            continue;
        };
        let Some((hi, lo)) = hl else {
            hl = Some((x, x));
            continue;
        };
        if lo > 0.0 && x >= lo * (1.0 + i) {
            if wants_up(dir) {
                out.push(t);
            }
            hl = Some((x, x));
        } else if hi > 0.0 && x <= hi * (1.0 - i) {
            if wants_down(dir) {
                out.push(t);
            }
            hl = Some((x, x));
        } else if lo == 0.0 && x > 0.0 {
            hl = Some((x, x)); // rise from zero is not measurable: restart
        } else {
            hl = Some((hi.max(x), lo.min(x)));
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq)]
enum Trend {
    Unknown { hi: f64, lo: f64 },
    Up { ext: f64 },
    Down { ext: f64 },
}

/// Reversals of at least `theta` from the running extreme; timestamped at confirmation.
pub fn zigzag_switches(series: &[Sample], theta: f64, kind: SwitchKind) -> Vec<i64> {
    let peaks = matches!(kind, SwitchKind::Both | SwitchKind::Peak);
    let troughs = matches!(kind, SwitchKind::Both | SwitchKind::Trough);
    let mut out = Vec::new();
    let mut st: Option<Trend> = None;
    for &(t, x) in series {
        let Some(x) = x else {
            st = None;
            continue;
        };
        st = Some(match st {
            None => Trend::Unknown { hi: x, lo: x },
            Some(Trend::Unknown { hi, lo }) => {
                if lo > 0.0 && x >= lo * (1.0 + theta) {
                    Trend::Up { ext: x }
                } else if hi > 0.0 && x <= hi * (1.0 - theta) {
                    Trend::Down { ext: x }
                } else if lo == 0.0 && x > 0.0 {
                    Trend::Unknown { hi: x, lo: x }
                } else {
                    Trend::Unknown {
                        hi: hi.max(x),
                        lo: lo.min(x),
                    }
                }
            }
            Some(Trend::Up { ext }) => {
                if x > ext {
                    Trend::Up { ext: x }
                } else if x <= ext * (1.0 - theta) {
                    if peaks {
                        out.push(t);
                    }
                    Trend::Down { ext: x }
                } else {
                    Trend::Up { ext }
                }
            }
            Some(Trend::Down { ext }) => {
                if ext == 0.0 {
                    if x > 0.0 {
                        Trend::Unknown { hi: x, lo: x } // rise from zero: restart, no switch
                    } else {
                        Trend::Down { ext }
                    }
                } else if x < ext {
                    Trend::Down { ext: x }
                } else if x >= ext * (1.0 + theta) {
                    if troughs {
                        out.push(t);
                    }
                    Trend::Up { ext: x }
                } else {
                    Trend::Down { ext }
                }
            }
        });
    }
    out
}

/// `x <= (1 - i) * max(values in effect during [t - window_ms, t])`, within a segment.
pub fn drop_events(series: &[Sample], i: f64, window_ms: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut dq: VecDeque<(i64, f64)> = VecDeque::new();
    for &(t, x) in series {
        let Some(x) = x else {
            dq.clear();
            continue;
        };
        while dq.back().is_some_and(|&(_, v)| v <= x) {
            dq.pop_back();
        }
        dq.push_back((t, x));
        // Keep the value in effect at t - window: drop the front only once the next one is
        // itself at or before the left edge.
        while dq.len() > 1
            && dq
                .get(1)
                .is_some_and(|&(tn, _)| tn <= t.saturating_sub(window_ms))
        {
            dq.pop_front();
        }
        if let Some(&(_, mx)) = dq.front() {
            if mx > 0.0 && x <= (1.0 - i) * mx {
                out.push(t);
            }
        }
    }
    out
}
