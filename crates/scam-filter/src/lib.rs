//! Scam Filter window rules (algorithm contract v0.2).
//!
//! Pure, synchronous analysis over normalized pool snapshots: no I/O, no clock, no panics.
//! The Dambi host builds the snapshots (RPC, as-of block, missing ranges), calls
//! [`AlgorithmPort::analyze`], validates the result and composes it with the policy verdict.
//!
//! * [`generators`] turns a metric series into events (step, cumulative, zigzag, drop).
//! * [`rules`] evaluates `change_count` (R1), `switch_density` (R2), `window_drop` and
//!   `event_count` on the window `(B, T]` and reports `fired / clear / incomplete / not_evaluable`.
//!
//! The Python reference implementation (`ref_rules.py`) defines the expected outputs; the
//! fixtures under `tests/fixtures/` are produced by it and must match bit for bit.
#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod generators;
pub mod rules;
pub mod series;
pub mod types;

pub use rules::WindowRules;
pub use types::*;

/// Contract version this crate implements.
pub const CONTRACT_VERSION: u32 = 2;

/// Port the Dambi host calls. Implementations must be pure and must keep within [`Limits`].
pub trait AlgorithmPort {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn contract_version(&self) -> u32;
    /// Whether the rule kind and parameters are supported, before any data is fetched.
    fn supports(&self, rule: &RuleSpec) -> Support;
    fn analyze(
        &self,
        req: &AnalysisRequest,
        limits: &Limits,
    ) -> Result<ScamAnalysis, AlgorithmError>;
}
