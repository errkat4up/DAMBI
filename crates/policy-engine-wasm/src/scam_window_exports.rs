//! `#[wasm_bindgen]` exports for the Scam Filter window rules.
//!
//! The extension evaluates window rules itself (no SDK host, no signed bundle):
//! the service worker fetches a pool's recent `Sync` history, builds the
//! algorithm's own `AnalysisRequest` and calls [`scam_window_analyze_json`].
//! The algorithm is the unmodified `scam-filter` crate — this file only moves
//! JSON across the WASM boundary.
//!
//! Both exports are JSON-string in / JSON-string out and answer with the
//! `{ "ok": true, "data": … }` / `{ "ok": false, "error": { kind, message } }`
//! envelope the service worker's `unwrap` helper expects. They are pure: no
//! I/O, no clock.

use scam_filter::generators::{cumulative_events, step_events, Sample};
use scam_filter::{AlgorithmPort, AnalysisRequest, ChangeMode, Direction, Limits, WindowRules};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::exports::check_input_size;

#[derive(Serialize)]
struct Envelope<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Serialize)]
struct ErrorBody {
    kind: &'static str,
    message: String,
}

fn respond<T: Serialize>(result: Result<T, (&'static str, String)>) -> String {
    let envelope = match result {
        Ok(data) => Envelope {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err((kind, message)) => Envelope {
            ok: false,
            data: None,
            error: Some(ErrorBody { kind, message }),
        },
    };
    serde_json::to_string(&envelope).unwrap_or_else(|_| {
        r#"{"ok":false,"error":{"kind":"serialize_failed","message":"could not serialize the result"}}"#.to_owned()
    })
}

/// Evaluate window rules over one pool's history.
///
/// Input: the `scam-filter` crate's `AnalysisRequest` (camelCase wire format).
/// Output data: its `ScamAnalysis`. Invalid input and exceeded limits come back
/// as an error envelope, never as a panic.
#[wasm_bindgen]
#[must_use]
pub fn scam_window_analyze_json(input_json: String) -> String {
    respond((|| {
        check_input_size(&input_json, "scam_window_analyze_json")
            .map_err(|e| ("input_too_large", e.message))?;
        let request: AnalysisRequest = serde_json::from_str(&input_json)
            .map_err(|e| ("invalid_input", format!("invalid analysis request: {e}")))?;
        WindowRules
            .analyze(&request, &Limits::default())
            .map_err(|e| ("algorithm_error", e.to_string()))
    })())
}

/// One `change_count` event generator run over a metric series.
#[derive(Deserialize)]
struct EventsInput {
    mode: ChangeMode,
    bps: u32,
    direction: Direction,
    /// `[tMs, value | null]`; `null` is an undefined or missing point.
    series: Vec<(i64, Option<f64>)>,
}

/// The `change_count` event generators (`step`, `cumulative`) on their own.
///
/// Exists so the extension's tests can run the algorithm's reference vectors
/// (`crates/scam-filter/tests/fixtures/reference_cases.json`) through this
/// exact WASM build and pin bit-for-bit agreement. Output data: event times.
#[wasm_bindgen]
#[must_use]
pub fn scam_window_events_json(input_json: String) -> String {
    respond((|| {
        check_input_size(&input_json, "scam_window_events_json")
            .map_err(|e| ("input_too_large", e.message))?;
        let input: EventsInput = serde_json::from_str(&input_json)
            .map_err(|e| ("invalid_input", format!("invalid events input: {e}")))?;
        let series: Vec<Sample> = input.series;
        let threshold = f64::from(input.bps) / 10_000.0;
        Ok::<Vec<i64>, (&'static str, String)>(match input.mode {
            ChangeMode::Step => step_events(&series, threshold, input.direction),
            ChangeMode::Cumulative => cumulative_events(&series, threshold, input.direction),
        })
    })())
}
