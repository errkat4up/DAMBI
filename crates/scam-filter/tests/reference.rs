//! Bit-for-bit agreement with the Python reference implementation.
//!
//! `fixtures/reference_cases.json` is produced by `make_golden.py` from `ref_rules.py`
//! (random series with zeros and undefined points). Regenerate both together when the
//! contract changes.
use scam_filter::generators::{
    cumulative_events, drop_events, step_events, zigzag_switches, Sample,
};
use scam_filter::rules::r2_evidence;
use scam_filter::{Direction, SwitchKind};
use serde_json::Value;

fn fixture() -> Value {
    let raw = include_str!("fixtures/reference_cases.json");
    serde_json::from_str(raw).expect("fixture json")
}

fn series(v: &Value) -> Vec<Sample> {
    v.as_array()
        .expect("series")
        .iter()
        .map(|p| (p[0].as_i64().expect("t"), p[1].as_f64()))
        .collect()
}

fn ints(v: &Value) -> Vec<i64> {
    v.as_array()
        .expect("list")
        .iter()
        .map(|x| x.as_i64().expect("int"))
        .collect()
}

fn direction(s: &str) -> Direction {
    match s {
        "both" => Direction::Both,
        "up" => Direction::Up,
        "down" => Direction::Down,
        other => panic!("direction {other}"),
    }
}

fn switch_kind(s: &str) -> SwitchKind {
    match s {
        "both" => SwitchKind::Both,
        "peak" => SwitchKind::Peak,
        "trough" => SwitchKind::Trough,
        other => panic!("kind {other}"),
    }
}

#[test]
fn generators_match_python_reference() {
    let f = fixture();
    let cases = f["generator_cases"].as_array().expect("cases");
    assert!(cases.len() >= 200);
    for (n, c) in cases.iter().enumerate() {
        let s = series(&c["series"]);
        let i = c["bps"].as_u64().expect("bps") as f64 / 10_000.0;
        let got = match c["gen"].as_str().expect("gen") {
            "step" => step_events(&s, i, direction(c["direction"].as_str().expect("dir"))),
            "cumulative" => {
                cumulative_events(&s, i, direction(c["direction"].as_str().expect("dir")))
            }
            "zigzag" => zigzag_switches(&s, i, switch_kind(c["kind"].as_str().expect("kind"))),
            "drop" => drop_events(&s, i, c["window_ms"].as_i64().expect("window")),
            other => panic!("gen {other}"),
        };
        assert_eq!(got, ints(&c["expected"]), "case {n} ({})", c["gen"]);
    }
}

#[test]
fn r2_evidence_matches_python_reference() {
    let f = fixture();
    let cases = f["r2_evidence_cases"].as_array().expect("cases");
    assert!(cases.len() >= 50);
    for (n, c) in cases.iter().enumerate() {
        let got = r2_evidence(
            &ints(&c["switches"]),
            c["window_ms"].as_i64().expect("x2"),
            c["b"].as_i64().expect("b"),
            c["t"].as_i64().expect("t"),
        );
        let want = c["expected"].as_array().map(|e| {
            (
                e[0].as_u64().expect("count"),
                e[1].as_i64().expect("start"),
                e[2].as_i64().expect("end"),
            )
        });
        assert_eq!(got, want, "case {n}");
    }
}
