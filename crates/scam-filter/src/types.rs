//! Contract types (wire format is camelCase JSON). Times are Unix ms, durations seconds,
//! thresholds bps, raw on-chain integers decimal strings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    Price,
    Liquidity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Both,
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeMode {
    Step,
    Cumulative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchKind {
    Both,
    Peak,
    Trough,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdminEventKind {
    OwnerChanged,
    ProxyUpgraded,
    AdminChanged,
    Paused,
    Unpaused,
}

/// One rule with its parameters, already merged from preset, threshold set and user overrides.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleSpec {
    #[serde(rename_all = "camelCase")]
    ChangeCount {
        id: String,
        metric: Metric,
        lookback_sec: u64,
        min_change_bps: u32,
        direction: Direction,
        mode: ChangeMode,
        min_count: u32,
    },
    #[serde(rename_all = "camelCase")]
    SwitchDensity {
        id: String,
        metric: Metric,
        lookback_sec: u64,
        window_sec: u64,
        reversal_bps: u32,
        switch_kind: SwitchKind,
        min_count: u32,
    },
    /// Liquidity drop inside any `windowSec` span; the metric is always liquidity.
    #[serde(rename_all = "camelCase")]
    WindowDrop {
        id: String,
        lookback_sec: u64,
        window_sec: u64,
        min_drop_bps: u32,
    },
    /// Admin event count over the whole lookback (an X2 sub-window is not part of the MVP).
    #[serde(rename_all = "camelCase")]
    EventCount {
        id: String,
        kinds: Vec<AdminEventKind>,
        lookback_sec: u64,
        min_count: u32,
    },
}

impl RuleSpec {
    pub fn id(&self) -> &str {
        match self {
            RuleSpec::ChangeCount { id, .. }
            | RuleSpec::SwitchDensity { id, .. }
            | RuleSpec::WindowDrop { id, .. }
            | RuleSpec::EventCount { id, .. } => id,
        }
    }

    pub fn lookback_sec(&self) -> u64 {
        match self {
            RuleSpec::ChangeCount { lookback_sec, .. }
            | RuleSpec::SwitchDensity { lookback_sec, .. }
            | RuleSpec::WindowDrop { lookback_sec, .. }
            | RuleSpec::EventCount { lookback_sec, .. } => *lookback_sec,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub chain_id: u64,
    pub pool: String,
    pub token: String,
    pub quote: String,
    pub venue: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsOf {
    pub block: String,
    pub block_hash: String,
    pub t_ms: i64,
}

/// Half-open time range `[fromMs, toMs)` that could not be observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolPoint {
    pub t_ms: i64,
    pub reserve_quote: String,
    pub reserve_token: String,
    pub decimals_quote: u8,
    pub decimals_token: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Warmup {
    pub from_ms: i64,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolHistory {
    pub schema: String,
    pub builder_version: String,
    pub from_ms: i64,
    pub bucket_ms: i64,
    /// Ascending, unique `tMs`, none after the as-of time.
    pub points: Vec<PoolPoint>,
    pub missing: Vec<TimeRange>,
    pub warmup: Warmup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminEvent {
    pub t_ms: i64,
    pub kind: AdminEventKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenProfile {
    pub schema: String,
    #[serde(default)]
    pub pool_created_ms: Option<i64>,
    #[serde(default)]
    pub age_lower_bound_ms: Option<i64>,
    pub admin_events: Vec<AdminEvent>,
    pub missing: Vec<TimeRange>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRequest {
    pub subject: Subject,
    pub as_of: AsOf,
    pub rules: Vec<RuleSpec>,
    /// Hash of the effective rule set, computed by the host and echoed in [`Binding`].
    pub rules_hash: String,
    pub pool_history: PoolHistory,
    pub token_profile: TokenProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_rules: usize,
    pub max_points: usize,
    pub max_admin_events: usize,
    /// Evidence events kept per rule (most recent first is not implied; the latest are kept).
    pub max_evidence_events: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_rules: 16,
            max_points: 20_000,
            max_admin_events: 1_000,
            max_evidence_events: 64,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisMode {
    Real,
    Stub,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Fired,
    Clear,
    Incomplete,
    NotEvaluable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    PartialCoverage,
    WarmupIncomplete,
    NoUsableSegment,
    ResolutionTooCoarse,
    MetricUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceEvent {
    pub t_ms: i64,
    pub kind: String,
}

/// Window `(startMs, endMs]` that carries the evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceWindow {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleResult {
    pub rule_id: String,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<u64>,
    pub threshold: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<EvidenceWindow>,
    pub events: Vec<EvidenceEvent>,
    pub coverage_bps: u32,
    pub warmup_complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub chain_id: u64,
    pub pool: String,
    pub as_of_block: String,
    pub as_of_block_hash: String,
    pub rules_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScamAnalysis {
    pub algorithm_id: String,
    pub algorithm_version: String,
    pub contract_version: u32,
    pub analysis_mode: AnalysisMode,
    pub binding: Binding,
    pub rules: Vec<RuleResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Support {
    Supported,
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AlgorithmError {
    #[error("input exceeds limit: {0}")]
    LimitExceeded(&'static str),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("unsupported rule {rule}: {reason}")]
    Unsupported { rule: String, reason: String },
}
