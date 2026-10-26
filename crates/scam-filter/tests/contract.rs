//! Contract examples (algorithm contract v0.2 §9) and end-to-end `analyze` behaviour.
use scam_filter::generators::{
    cumulative_events, drop_events, step_events, zigzag_switches, Sample,
};
use scam_filter::rules::r2_evidence;
use scam_filter::*;

fn s(points: &[(i64, Option<f64>)]) -> Vec<Sample> {
    points.to_vec()
}

#[test]
fn generator_examples() {
    let up = s(&[
        (0, Some(100.0)),
        (10, Some(110.0)),
        (20, Some(121.0)),
        (30, Some(133.1)),
        (40, Some(146.41)),
    ]);
    assert_eq!(
        step_events(&up, 0.05, Direction::Both),
        vec![10, 20, 30, 40]
    );
    assert!(zigzag_switches(&up, 0.05, SwitchKind::Both).is_empty());
    let c = s(&[
        (0, Some(100.0)),
        (1, Some(103.0)),
        (2, Some(105.1)),
        (3, Some(99.0)),
    ]);
    assert_eq!(cumulative_events(&c, 0.05, Direction::Both), vec![2, 3]);
}

#[test]
fn drop_uses_the_value_in_effect_at_the_window_start() {
    // 100 is replaced by 50 at 10 s, so during [15 s, 75 s] the values in effect are 50, 80, 45:
    // 45 is not a 50 % drop from 80 (the old 100 no longer counts).
    let d = s(&[
        (0, Some(100.0)),
        (10_000, Some(50.0)),
        (70_000, Some(80.0)),
        (75_000, Some(45.0)),
    ]);
    assert_eq!(drop_events(&d, 0.5, 60_000), vec![10_000]);
}

#[test]
fn zero_and_undefined_values() {
    let liq = s(&[
        (0, Some(10.0)),
        (10, Some(0.0)),
        (20, Some(5.0)),
        (30, Some(5.5)),
    ]);
    assert_eq!(step_events(&liq, 0.05, Direction::Both), vec![10, 30]);
    assert_eq!(cumulative_events(&liq, 0.05, Direction::Both), vec![10, 30]);
    let gap = s(&[(0, Some(100.0)), (10, None), (20, Some(106.0))]);
    assert!(step_events(&gap, 0.05, Direction::Both).is_empty());
    let z0 = s(&[
        (0, Some(100.0)),
        (10, Some(106.0)),
        (20, Some(0.0)),
        (30, Some(50.0)),
        (40, Some(60.0)),
    ]);
    assert_eq!(zigzag_switches(&z0, 0.05, SwitchKind::Both), vec![20]);
    assert_eq!(
        drop_events(&s(&[(0, Some(10.0)), (60, Some(0.0))]), 0.4, 300),
        vec![60]
    );
}

#[test]
fn r2_switches_and_evidence() {
    let z = s(&[
        (0, Some(100.0)),
        (10, Some(106.0)),
        (20, Some(100.0)),
        (30, Some(106.0)),
        (40, Some(100.0)),
    ]);
    assert_eq!(
        zigzag_switches(&z, 0.05, SwitchKind::Both),
        vec![20, 30, 40]
    );
    assert_eq!(zigzag_switches(&z, 0.05, SwitchKind::Peak), vec![20, 40]);
    assert_eq!(
        r2_evidence(&[20, 30, 40], 21, -1_000_000, 40),
        Some((3, 19, 40))
    );
    // ties -> latest end
    assert_eq!(
        r2_evidence(&[0, 5, 100, 105], 10, -1_000_000, 200),
        Some((2, 95, 105))
    );
    assert_eq!(
        r2_evidence(&[0, 5, 100, 105], 10, 50, 200),
        Some((2, 95, 105))
    );
}

// ---------------------------------------------------------------- analyze()

const T: i64 = 1_000_000_000;

fn point(t_ms: i64, quote: &str, token: &str) -> PoolPoint {
    PoolPoint {
        t_ms,
        reserve_quote: quote.into(),
        reserve_token: token.into(),
        decimals_quote: 0,
        decimals_token: 0,
    }
}

/// Liquidity/price series on a 10 s grid ending at T; `quotes[i]` at T - (n-1-i)*10 s.
fn request(
    quotes: &[&str],
    rules: Vec<RuleSpec>,
    missing: Vec<TimeRange>,
    warmup_complete: bool,
) -> AnalysisRequest {
    let n = quotes.len() as i64;
    let points = quotes
        .iter()
        .enumerate()
        .map(|(i, q)| point(T - (n - 1 - i as i64) * 10_000, q, "1000"))
        .collect();
    AnalysisRequest {
        subject: Subject {
            chain_id: 91342,
            pool: "0xpool".into(),
            token: "0xtoken".into(),
            quote: "0xweth".into(),
            venue: "uniswap_v2".into(),
        },
        as_of: AsOf {
            block: "100".into(),
            block_hash: "0xhash".into(),
            t_ms: T,
        },
        rules,
        rules_hash: "h1".into(),
        pool_history: PoolHistory {
            schema: "scam.pool_history/1".into(),
            builder_version: "test".into(),
            from_ms: T - (n - 1) * 10_000,
            bucket_ms: 10_000,
            points,
            missing,
            warmup: Warmup {
                from_ms: T - (n - 1) * 10_000,
                complete: warmup_complete,
            },
        },
        token_profile: TokenProfile {
            schema: "scam.token_profile/1".into(),
            pool_created_ms: None,
            age_lower_bound_ms: None,
            admin_events: vec![],
            missing: vec![],
        },
    }
}

/// The history starts at pool creation (a young pool): every warm-up requirement is met.
fn young(mut req: AnalysisRequest) -> AnalysisRequest {
    req.token_profile.pool_created_ms = Some(req.pool_history.from_ms);
    req
}

fn r2(window_sec: u64) -> RuleSpec {
    RuleSpec::SwitchDensity {
        id: "r2".into(),
        metric: Metric::Price,
        lookback_sec: 40,
        window_sec,
        reversal_bps: 500,
        switch_kind: SwitchKind::Both,
        min_count: 3,
    }
}

fn run(req: &AnalysisRequest) -> ScamAnalysis {
    WindowRules
        .analyze(req, &Limits::default())
        .expect("analyze")
}

#[test]
fn r2_resolution_and_evidence_end_to_end() {
    // price 100,106,100,106,100 on a 10 s grid ending at T -> switches at T-20s, T-10s, T
    let quotes = ["100000", "106000", "100000", "106000", "100000"];
    let out = run(&request(&quotes, vec![r2(21), r2(20)], vec![], true));
    let fired = &out.rules[0];
    assert_eq!(fired.outcome, Outcome::Fired);
    assert_eq!(fired.observed, Some(3));
    assert_eq!(
        fired.window,
        Some(EvidenceWindow {
            start_ms: T - 21_000,
            end_ms: T
        })
    );
    let coarse = &out.rules[1];
    assert_eq!(coarse.outcome, Outcome::NotEvaluable);
    assert_eq!(coarse.reason, Some(Reason::ResolutionTooCoarse));
    assert_eq!(out.binding.rules_hash, "h1");
    assert_eq!(out.contract_version, CONTRACT_VERSION);
}

fn drop_rule(window_sec: u64) -> RuleSpec {
    RuleSpec::WindowDrop {
        id: "drain".into(),
        lookback_sec: 40,
        window_sec,
        min_drop_bps: 4_000,
    }
}

#[test]
fn drain_to_zero_fires_and_clear_needs_full_coverage() {
    let drained = run(&request(
        &["10", "10", "10", "10", "0"],
        vec![drop_rule(30)],
        vec![],
        true,
    ));
    assert_eq!(drained.rules[0].outcome, Outcome::Fired);

    let flat = ["10", "10", "10", "10", "10"];
    let clear = run(&young(request(&flat, vec![drop_rule(30)], vec![], true)));
    assert_eq!(clear.rules[0].outcome, Outcome::Clear);
    assert_eq!(clear.rules[0].coverage_bps, 10_000);

    // history starts at B but the pool is older: the 30 s before B are unobserved
    let cold = run(&request(&flat, vec![drop_rule(30)], vec![], true));
    assert_eq!(cold.rules[0].outcome, Outcome::Incomplete);
    assert_eq!(cold.rules[0].reason, Some(Reason::WarmupIncomplete));

    let gap = vec![TimeRange {
        from_ms: T - 25_000,
        to_ms: T - 15_000,
    }];
    let partial = run(&young(request(&flat, vec![drop_rule(30)], gap, true)));
    assert_eq!(partial.rules[0].outcome, Outcome::Incomplete);
    assert_eq!(partial.rules[0].reason, Some(Reason::PartialCoverage));
    assert_eq!(partial.rules[0].coverage_bps, 7_500);

    // window_drop minimum supported window is one bucket
    let short = run(&request(&flat, vec![drop_rule(9)], vec![], true));
    assert_eq!(short.rules[0].outcome, Outcome::NotEvaluable);
}

fn r1(mode: ChangeMode) -> RuleSpec {
    RuleSpec::ChangeCount {
        id: "r1".into(),
        metric: Metric::Price,
        lookback_sec: 40,
        min_change_bps: 500,
        direction: Direction::Both,
        mode,
        min_count: 2,
    }
}

#[test]
fn quiet_r1_needs_warmup() {
    let flat = ["100", "100", "100", "100", "100"];
    // step compares neighbouring points only: no warm-up beyond the window
    let step = run(&request(&flat, vec![r1(ChangeMode::Step)], vec![], false));
    assert_eq!(step.rules[0].outcome, Outcome::Clear);

    // cumulative needs 24 h of observed history before B, or history from pool creation
    let cum = vec![r1(ChangeMode::Cumulative)];
    let ok = run(&young(request(&flat, cum.clone(), vec![], true)));
    assert_eq!(ok.rules[0].outcome, Outcome::Clear);
    assert!(ok.rules[0].warmup_complete);
    let short = run(&request(&flat, cum.clone(), vec![], true));
    assert_eq!(short.rules[0].outcome, Outcome::Incomplete);
    assert_eq!(short.rules[0].reason, Some(Reason::WarmupIncomplete));
    assert!(!short.rules[0].warmup_complete);
    let host_says_no = run(&young(request(&flat, cum, vec![], false)));
    assert_eq!(host_says_no.rules[0].outcome, Outcome::Incomplete);
    assert_eq!(host_says_no.rules[0].reason, Some(Reason::WarmupIncomplete));
}

#[test]
fn cumulative_warmup_is_24h_of_observed_history() {
    // one point per hour from B - 24 h to B, then every 10 s to T; the pool is older than that
    let b = T - 40_000;
    let mut req = request(&[], vec![r1(ChangeMode::Cumulative)], vec![], true);
    req.pool_history.points = (0..=24)
        .map(|h| b - (24 - h) * 3_600_000)
        .chain((1..=4).map(|k| b + k * 10_000))
        .map(|t| point(t, "100", "1000"))
        .collect();
    req.pool_history.from_ms = req.pool_history.points[0].t_ms;
    let first = req.pool_history.points[0].t_ms;
    assert!(first <= T - 40_000 - 86_400_000);
    assert_eq!(run(&req).rules[0].outcome, Outcome::Clear);

    // a gap inside the 24 h before B breaks the warm-up
    req.pool_history.missing = vec![TimeRange {
        from_ms: T - 40_000 - 7_200_000,
        to_ms: T - 40_000 - 3_600_000,
    }];
    let out = run(&req);
    assert_eq!(out.rules[0].outcome, Outcome::Incomplete);
    assert_eq!(out.rules[0].reason, Some(Reason::WarmupIncomplete));
}

#[test]
fn undefined_price_point_blocks_clear() {
    // token reserve 0 at one point -> price undefined inside the window
    let mut req = request(
        &["100", "100", "100", "100", "100"],
        vec![r2(21)],
        vec![],
        true,
    );
    if let Some(p) = req.pool_history.points.get_mut(2) {
        p.reserve_token = "0".into();
    }
    let out = run(&req);
    assert_eq!(out.rules[0].outcome, Outcome::Incomplete);
}

#[test]
fn event_count_over_lookback() {
    let rule = RuleSpec::EventCount {
        id: "admin".into(),
        kinds: vec![AdminEventKind::OwnerChanged, AdminEventKind::ProxyUpgraded],
        lookback_sec: 40,
        min_count: 1,
    };
    let mut req = request(&["1", "1"], vec![rule], vec![], true);
    req.token_profile.admin_events = vec![
        AdminEvent {
            t_ms: T - 50_000,
            kind: AdminEventKind::OwnerChanged,
        }, // outside (T-40s, T]
        AdminEvent {
            t_ms: T - 5_000,
            kind: AdminEventKind::Paused,
        }, // not selected
    ];
    assert_eq!(run(&req).rules[0].outcome, Outcome::Clear);
    req.token_profile.admin_events.push(AdminEvent {
        t_ms: T - 40_000 + 1,
        kind: AdminEventKind::ProxyUpgraded,
    });
    assert_eq!(run(&req).rules[0].outcome, Outcome::Fired);
}

#[test]
fn invalid_rules_and_limits_are_errors() {
    let bad = RuleSpec::SwitchDensity {
        id: "bad".into(),
        metric: Metric::Price,
        lookback_sec: 40,
        window_sec: 60, // > lookback
        reversal_bps: 500,
        switch_kind: SwitchKind::Both,
        min_count: 2,
    };
    assert!(matches!(
        WindowRules.supports(&bad),
        Support::Unsupported(_)
    ));
    let req = request(&["1", "1"], vec![bad], vec![], true);
    assert!(matches!(
        WindowRules.analyze(&req, &Limits::default()),
        Err(AlgorithmError::Unsupported { .. })
    ));

    let req = request(&["1", "1"], vec![drop_rule(30)], vec![], true);
    let tight = Limits {
        max_points: 1,
        ..Limits::default()
    };
    assert_eq!(
        WindowRules.analyze(&req, &tight),
        Err(AlgorithmError::LimitExceeded("points"))
    );

    let mut req = request(&["1", "1"], vec![drop_rule(30)], vec![], true);
    if let Some(p) = req.pool_history.points.get_mut(0) {
        p.reserve_quote = "-5".into();
    }
    assert!(matches!(
        WindowRules.analyze(&req, &Limits::default()),
        Err(AlgorithmError::InvalidInput(_))
    ));
}

#[test]
fn wire_format_is_camel_case() {
    let rule: RuleSpec = serde_json::from_str(
        r#"{"kind":"switch_density","id":"price-switch-60s","metric":"price","lookbackSec":3600,
            "windowSec":60,"reversalBps":500,"switchKind":"both","minCount":2}"#,
    )
    .expect("rule json");
    assert_eq!(rule.id(), "price-switch-60s");
    let out = run(&request(&["1", "1"], vec![drop_rule(30)], vec![], true));
    let json = serde_json::to_string(&out).expect("json");
    assert!(json.contains("\"coverageBps\"") && json.contains("\"analysisMode\":\"real\""));
}

fn cumulative_liquidity_up(id: &str) -> RuleSpec {
    RuleSpec::ChangeCount {
        id: id.into(),
        metric: Metric::Liquidity,
        lookback_sec: 40,
        min_change_bps: 5_000,
        direction: Direction::Up,
        mode: ChangeMode::Cumulative,
        min_count: 1,
    }
}

#[test]
fn fired_and_incomplete_are_kept_side_by_side() {
    // a gap in the window: the drain still fires, the rule that saw nothing stays incomplete
    let gap = vec![TimeRange {
        from_ms: T - 25_000,
        to_ms: T - 15_000,
    }];
    let out = run(&young(request(
        &["10", "10", "10", "10", "0"],
        vec![drop_rule(30), cumulative_liquidity_up("rise")],
        gap,
        true,
    )));
    assert_eq!(out.rules.len(), 2);
    assert_eq!(out.rules[0].rule_id, "drain");
    assert_eq!(out.rules[0].outcome, Outcome::Fired);
    assert_eq!(out.rules[1].rule_id, "rise");
    assert_eq!(out.rules[1].outcome, Outcome::Incomplete);
    assert_eq!(out.rules[1].reason, Some(Reason::PartialCoverage));
    assert_eq!(out.rules[1].coverage_bps, 7_500);
}

#[test]
fn evidence_cap_keeps_observed_and_outcome() {
    let rule = RuleSpec::EventCount {
        id: "admin".into(),
        kinds: vec![AdminEventKind::OwnerChanged],
        lookback_sec: 40,
        min_count: 3,
    };
    let mut req = request(&["1", "1"], vec![rule], vec![], true);
    req.token_profile.admin_events = (1..=5)
        .map(|k| AdminEvent {
            t_ms: T - 35_000 + k * 5_000,
            kind: AdminEventKind::OwnerChanged,
        })
        .collect();
    let full = run(&req);
    let capped = WindowRules
        .analyze(
            &req,
            &Limits {
                max_evidence_events: 2,
                ..Limits::default()
            },
        )
        .expect("analyze");
    for r in [&full.rules[0], &capped.rules[0]] {
        assert_eq!(r.outcome, Outcome::Fired);
        assert_eq!(r.observed, Some(5));
    }
    assert_eq!(full.rules[0].events.len(), 5);
    let kept: Vec<i64> = capped.rules[0].events.iter().map(|e| e.t_ms).collect();
    assert_eq!(kept, vec![T - 15_000, T - 10_000]); // the latest two
}

#[test]
fn rule_and_admin_event_limits_fail_the_request() {
    let req = request(
        &["1", "1"],
        vec![drop_rule(30), cumulative_liquidity_up("rise")],
        vec![],
        true,
    );
    let one_rule = Limits {
        max_rules: 1,
        ..Limits::default()
    };
    assert_eq!(
        WindowRules.analyze(&req, &one_rule),
        Err(AlgorithmError::LimitExceeded("rules"))
    );

    let mut req = request(&["1", "1"], vec![drop_rule(30)], vec![], true);
    req.token_profile.admin_events = vec![
        AdminEvent {
            t_ms: T - 2_000,
            kind: AdminEventKind::Paused,
        },
        AdminEvent {
            t_ms: T - 1_000,
            kind: AdminEventKind::Unpaused,
        },
    ];
    let one_event = Limits {
        max_admin_events: 1,
        ..Limits::default()
    };
    assert_eq!(
        WindowRules.analyze(&req, &one_event),
        Err(AlgorithmError::LimitExceeded("adminEvents"))
    );
}
