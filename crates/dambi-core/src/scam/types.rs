//! SF1 wire DTOs for the isolated scam-analysis module.
//!
//! These types describe data, not a scam detection implementation. Deserialization
//! rejects unknown fields; value ranges, identities, coverage and binding are
//! checked separately before data or results are trusted.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Metric {
    PriceQuotePerToken,
    QuoteReserve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeMode {
    Step,
    Cumulative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchKind {
    DirectionReversal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdminEventKind {
    OwnerChanged,
    ProxyUpgraded,
    AdminChanged,
    Paused,
    Unpaused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuleSpec {
    ChangeCount {
        id: String,
        enabled: bool,
        lookback_sec: u64,
        metric: Metric,
        direction: Direction,
        change_mode: ChangeMode,
        threshold_bps: u64,
        count: u64,
    },
    SwitchDensity {
        id: String,
        enabled: bool,
        lookback_sec: u64,
        metric: Metric,
        window_sec: u64,
        reversal_bps: u64,
        switch_kind: SwitchKind,
        count: u64,
    },
    WindowDrop {
        id: String,
        enabled: bool,
        lookback_sec: u64,
        metric: Metric,
        window_sec: u64,
        drop_bps: u64,
    },
    EventCount {
        id: String,
        enabled: bool,
        lookback_sec: u64,
        event_kinds: Vec<AdminEventKind>,
        count: u64,
    },
}

impl RuleSpec {
    pub fn id(&self) -> &str {
        match self {
            Self::ChangeCount { id, .. }
            | Self::SwitchDensity { id, .. }
            | Self::WindowDrop { id, .. }
            | Self::EventCount { id, .. } => id,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            Self::ChangeCount { enabled, .. }
            | Self::SwitchDensity { enabled, .. }
            | Self::WindowDrop { enabled, .. }
            | Self::EventCount { enabled, .. } => *enabled,
        }
    }

    pub fn lookback_sec(&self) -> u64 {
        match self {
            Self::ChangeCount { lookback_sec, .. }
            | Self::SwitchDensity { lookback_sec, .. }
            | Self::WindowDrop { lookback_sec, .. }
            | Self::EventCount { lookback_sec, .. } => *lookback_sec,
        }
    }

    pub fn metric(&self) -> Option<Metric> {
        match self {
            Self::ChangeCount { metric, .. }
            | Self::SwitchDensity { metric, .. }
            | Self::WindowDrop { metric, .. } => Some(*metric),
            Self::EventCount { .. } => None,
        }
    }

    /// Threshold for the rule result: event count, or drop basis points.
    pub fn threshold(&self) -> u64 {
        match self {
            Self::ChangeCount { count, .. }
            | Self::SwitchDensity { count, .. }
            | Self::EventCount { count, .. } => *count,
            Self::WindowDrop { drop_bps, .. } => *drop_bps,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmSubject {
    pub chain_id: u64,
    pub pool: String,
    pub token: String,
    pub quote: String,
    pub venue: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmReference {
    pub block: String,
    pub block_hash: String,
    pub t_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotInterval {
    pub from_ms: u64,
    pub to_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolSnapshot {
    pub t_ms: u64,
    pub reserve_quote: String,
    pub reserve_token: String,
    pub decimals_quote: u8,
    pub decimals_token: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarmupState {
    pub from_ms: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolHistory {
    pub schema: String,
    pub builder_version: String,
    pub from_ms: u64,
    pub bucket_ms: u64,
    pub points: Vec<PoolSnapshot>,
    pub missing: Vec<SnapshotInterval>,
    pub warmup: WarmupState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdminEvent {
    pub t_ms: u64,
    pub kind: AdminEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenProfile {
    pub schema: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_created_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_lower_bound_ms: Option<u64>,
    pub admin_events: Vec<AdminEvent>,
    pub missing: Vec<SnapshotInterval>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisRequest {
    pub subject: AlgorithmSubject,
    pub as_of: AlgorithmReference,
    pub rules: Vec<RuleSpec>,
    pub pool_history: PoolHistory,
    pub token_profile: TokenProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmIdentity {
    pub id: String,
    pub version: String,
    /// Numeric algorithm wire version, separate from the SDK's "0.1" schema.
    /// Non-1 values can be retained for incompatible-module diagnostics.
    pub contract_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmLimits {
    pub max_input_bytes: u64,
    pub max_output_bytes: u64,
    pub max_points: u64,
    pub max_rules: u64,
    pub max_evidence_events_per_rule: u64,
    pub max_work_units: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmRuleRequirements {
    pub minimum_warmup_ms: u64,
    pub requires_initial_state: bool,
}

/// The in-process Rust port result; not a JSON wire tagged union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlgorithmSupport {
    Supported {
        requirements: AlgorithmRuleRequirements,
    },
    Unsupported {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlgorithmError {
    InvalidInput,
    UnsupportedRule,
    ResourceLimit,
    WorkBudgetExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleState {
    Fired,
    Clear,
    Incomplete,
    NotEvaluable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisMode {
    Real,
    Stub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlgorithmRuleReason {
    PartialCoverage,
    WarmupIncomplete,
    NoUsableSegment,
    ResolutionTooCoarse,
    MetricUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceWindow {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceEvent {
    pub t_ms: u64,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmRuleResult {
    pub rule_id: String,
    pub outcome: RuleState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<AlgorithmRuleReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<f64>,
    pub threshold: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<EvidenceWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<EvidenceEvent>>,
    pub coverage_bps: u64,
    pub warmup_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmBinding {
    pub chain_id: u64,
    pub pool: String,
    pub as_of_block: String,
    pub as_of_block_hash: String,
    pub rules_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScamAnalysis {
    pub algorithm_id: String,
    pub algorithm_version: String,
    pub contract_version: u32,
    pub analysis_mode: AnalysisMode,
    pub binding: AlgorithmBinding,
    pub rules: Vec<AlgorithmRuleResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subject {
    pub chain_id: u64,
    pub token: String,
    pub pool: String,
    pub factory: String,
    pub quote_token: String,
    pub venue: String,
    pub action_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockReference {
    pub number: String,
    pub hash: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedReference {
    pub block: BlockReference,
    pub required_confirm_depth: u64,
    pub checked_head: BlockReference,
    pub observed_confirm_depth: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryVerification {
    AllEventHeaders,
    RpcAnchor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateBinding {
    NumberRecheck,
    BlockHashCanonical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationTimeSource {
    Header,
    RpcLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationReuse {
    None,
    IntervalCache,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawObservedAt {
    pub from_ms: u64,
    pub to_ms: u64,
}

/// SDK-owned provider declarations. Shape validation does not authenticate RPC
/// data or prove that the provider performed the declared verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MethodVerification {
    #[serde(deserialize_with = "deserialize_verification_version")]
    pub version: u32,
    pub history: HistoryVerification,
    pub state_binding: StateBinding,
    pub time_sources: Vec<VerificationTimeSource>,
    pub reuse: VerificationReuse,
    pub raw_observed_at: RawObservedAt,
    pub verified_at: u64,
}

fn deserialize_verification_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where D: serde::Deserializer<'de> {
    let version = u32::deserialize(deserializer)?;
    if version != 1 {
        return Err(serde::de::Error::custom("unsupported verification version"));
    }
    Ok(version)
}

impl MethodVerification {
    pub(crate) fn validate(&self) -> Result<(), FailureReason> {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        if self.version != 1 || self.time_sources.is_empty() || self.time_sources.len() > 2
            || self.time_sources.iter().enumerate().any(|(i, source)| self.time_sources[..i].contains(source))
            || self.raw_observed_at.from_ms > self.raw_observed_at.to_ms
            || self.raw_observed_at.to_ms > self.verified_at
            || self.verified_at > MAX_SAFE_INTEGER {
            return Err(FailureReason::InvalidScamInput);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum AnalysisVerification {
    #[default]
    LegacyUnspecified,
    Declared {
        pool_history: MethodVerification,
        token_profile: MethodVerification,
    },
}

impl AnalysisVerification {
    pub(crate) fn validate(&self) -> Result<(), FailureReason> {
        if let Self::Declared { pool_history, token_profile } = self {
            pool_history.validate()?;
            token_profile.validate()?;
            if pool_history.history != token_profile.history
                || pool_history.state_binding != token_profile.state_binding
                || pool_history.version != token_profile.version {
                return Err(FailureReason::InvalidScamInput);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisBinding {
    pub plan_id: String,
    pub subject: Subject,
    pub reference: FixedReference,
    #[serde(default)]
    pub verification: AnalysisVerification,
    pub settings_hash: String,
    pub settings_hash_scheme: String,
    pub bundle_sequence: String,
    pub selected_preset: String,
    pub selection_reason: String,
    pub effective_settings_hash: String,
    pub algorithm: AlgorithmIdentity,
    pub builder_version: String,
    pub from_ms: u64,
    pub to_ms: u64,
    pub bucket_ms: u64,
    pub grid_origin_ms: u64,
    pub warmup_sec: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    AlgorithmUnavailable,
    AlgorithmIncompatible,
    InvalidAlgorithmOutput,
    ScamResultsMissing,
    InvalidScamInput,
    SubjectUnresolved,
    SubjectMismatch,
    ReferenceMismatch,
    Reorg,
    BundleUnavailable,
    BundleInvalid,
    DataMissing,
    FieldUnavailable,
    InitialStateUnknown,
    AgeUnknown,
    MarketTooYoung,
    StaleData,
    UnsupportedResolution,
    ResourceLimit,
    NoTimeBudget,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissingInterval {
    pub from_ms: u64,
    pub to_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnavailableField {
    pub field: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataCoverage {
    pub from_block: String,
    pub from_ms: u64,
    pub to_ms: u64,
    pub missing: Vec<MissingInterval>,
    pub unavailable: Vec<UnavailableField>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleResult {
    pub rule_id: String,
    pub state: RuleState,
    pub coverage: DataCoverage,
    pub initial_state: String,
    pub reasons: Vec<FailureReason>,
    pub evidence: Value,
}
