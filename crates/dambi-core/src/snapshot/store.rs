//! Instance-owned snapshots with staged, latest-begun-wins policy refreshes.
//!
//! Network I/O belongs to the caller. Only this Store's fixed trust settings can
//! prepare a candidate, and preparation never changes the active snapshot.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crate::bundle::{
    parse_policy_bundle, validate_policy_bundle, PolicyUpdate, PolicyValidationConfig, TrustedKeys,
    ValidatedPolicyBundle, VerificationKey,
};

use super::{
    prepare_decoder, DecoderInput, SignedPolicyInput, SnapshotError, SnapshotErrorKind,
    VerifiedDecoderSnapshot,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Local configuration, owned and fixed for the lifetime of one Store.
#[derive(Debug, Clone)]
pub struct SnapshotStoreConfig {
    pub keys: Vec<VerificationKey>,
    pub policy: PolicyValidationConfig,
    pub max_policy_bytes: usize,
    pub max_decoder_bytes: usize,
}

#[derive(Debug)]
struct Lifecycle {
    disposed: AtomicBool,
}

impl Lifecycle {
    fn ensure_live(&self) -> Result<(), SnapshotError> {
        if self.disposed.load(Ordering::Acquire) {
            Err(disposed())
        } else {
            Ok(())
        }
    }
}

/// Immutable policy/Decoder pairing. Retained snapshots do not change on refresh.
/// Store disposal or drop invalidates their use even while their data is retained.
#[derive(Debug)]
pub struct Snapshot {
    policy: ValidatedPolicyBundle,
    decoder: Arc<VerifiedDecoderSnapshot>,
    lifecycle: Arc<Lifecycle>,
}

impl Snapshot {
    /// Read-only authenticated contents; call ensure_usable before using them.
    pub fn policy(&self) -> &ValidatedPolicyBundle {
        &self.policy
    }

    pub fn decoder(&self) -> &VerifiedDecoderSnapshot {
        self.decoder.as_ref()
    }

    /// Lifecycle and freshness are checked at use time, not just activation.
    pub fn ensure_usable(&self, now_ms: u64) -> Result<(), SnapshotError> {
        self.lifecycle.ensure_live()?;
        self.policy.ensure_fresh(now_ms).map_err(Into::into)
    }
}

/// Store-issued capability for one refresh attempt. It cannot be reconstructed
/// from an integer, serialized, or moved to another Store to gain its trust.
#[derive(Debug)]
pub struct RefreshTicket {
    owner: Arc<Lifecycle>,
    generation: u64,
}

/// A candidate authenticated under its issuing Store's fixed configuration.
/// It grants no authority to activate itself or bypass the latest-state check.
#[derive(Debug)]
pub struct PreparedRefresh {
    owner: Arc<Lifecycle>,
    generation: u64,
    policy: ValidatedPolicyBundle,
}

#[derive(Debug)]
struct StoreState {
    keys: TrustedKeys,
    policy_config: PolicyValidationConfig,
    max_policy_bytes: usize,
    active: Arc<Snapshot>,
}

/// Synchronous state boundary for a fixed Decoder and replaceable policies.
///
/// Starting another refresh supersedes the prior attempt. A failed refresh
/// preserves the active snapshot and its sequence floor, even after expiration.
#[derive(Debug)]
pub struct SnapshotStore {
    lifecycle: Arc<Lifecycle>,
    generation: u64,
    pending: Option<u64>,
    state: Option<StoreState>,
}

impl SnapshotStore {
    /// Return only a fully initialized Store. Decoder installation and policy
    /// validation occur in local temporaries; any failure drops them together.
    pub fn new(
        config: SnapshotStoreConfig,
        decoder_input: DecoderInput<'_>,
        initial: SignedPolicyInput<'_>,
        now_ms: u64,
    ) -> Result<Self, SnapshotError> {
        check_byte_limit(config.max_policy_bytes, "maxPolicyBytes")?;
        check_byte_limit(config.max_decoder_bytes, "maxDecoderBytes")?;
        let keys = TrustedKeys::new(&config.keys)?;
        let decoder = prepare_decoder(decoder_input, &keys, config.max_decoder_bytes)?;
        // C3 validates policy configuration and the supplied clock before any
        // initialized Store or snapshot is returned to the caller.
        let policy = validate_input(
            &keys,
            &config.policy,
            config.max_policy_bytes,
            initial,
            now_ms,
        )?;
        let lifecycle = Arc::new(Lifecycle {
            disposed: AtomicBool::new(false),
        });
        let active = Arc::new(Snapshot {
            policy,
            decoder: Arc::new(decoder),
            lifecycle: Arc::clone(&lifecycle),
        });
        Ok(Self {
            lifecycle,
            generation: 0,
            pending: None,
            state: Some(StoreState {
                keys,
                policy_config: config.policy,
                max_policy_bytes: config.max_policy_bytes,
                active,
            }),
        })
    }

    /// Capture the active immutable snapshot only while it is usable.
    pub fn current(&self, now_ms: u64) -> Result<Arc<Snapshot>, SnapshotError> {
        let state = self.live_state()?;
        state.active.ensure_usable(now_ms)?;
        Ok(Arc::clone(&state.active))
    }

    /// Begin before asynchronous fetch. The new ticket invalidates every older
    /// attempt, including an already prepared candidate waiting to commit.
    pub fn begin_refresh(&mut self) -> Result<RefreshTicket, SnapshotError> {
        self.live_state()?;
        let generation = self.generation.checked_add(1).ok_or_else(|| {
            SnapshotError::new(
                SnapshotErrorKind::InvalidConfig,
                "refresh generation exhausted",
            )
        })?;
        self.generation = generation;
        self.pending = Some(generation);
        Ok(RefreshTicket {
            owner: Arc::clone(&self.lifecycle),
            generation,
        })
    }

    /// Authenticate raw input using only this Store's local keys and limits.
    /// Preparation is read-only; time and sequence are rechecked at commit.
    pub fn prepare_refresh(
        &self,
        ticket: &RefreshTicket,
        policy: SignedPolicyInput<'_>,
        now_ms: u64,
    ) -> Result<PreparedRefresh, SnapshotError> {
        self.check_attempt(&ticket.owner, ticket.generation)?;
        let state = self.live_state()?;
        let policy = validate_input(
            &state.keys,
            &state.policy_config,
            state.max_policy_bytes,
            policy,
            now_ms,
        )?;
        Ok(PreparedRefresh {
            owner: Arc::clone(&self.lifecycle),
            generation: ticket.generation,
            policy,
        })
    }

    /// Consume the current attempt and compare with the latest active state.
    /// A valid attempt is finished even if freshness or sequence checks fail.
    /// Foreign or superseded attempts cannot consume a different current one.
    pub fn commit_refresh(
        &mut self,
        prepared: PreparedRefresh,
        now_ms: u64,
    ) -> Result<PolicyUpdate, SnapshotError> {
        self.check_attempt(&prepared.owner, prepared.generation)?;
        self.pending = None;
        let state = self.state.as_mut().expect("live attempt has Store state");
        let update = prepared
            .policy
            .check_update(Some(state.active.policy()), now_ms)?;
        if update == PolicyUpdate::Replace {
            state.active = Arc::new(Snapshot {
                policy: prepared.policy,
                decoder: Arc::clone(&state.active.decoder),
                lifecycle: Arc::clone(&self.lifecycle),
            });
        }
        // Unchanged retains the exact Arc, original issue/expiry, and metadata.
        Ok(update)
    }

    /// Invalidate the matching attempt after cancellation, timeout, or fetch
    /// failure. An older cancellation cannot cancel a later refresh.
    pub fn cancel_refresh(&mut self, ticket: &RefreshTicket) -> Result<(), SnapshotError> {
        self.check_attempt(&ticket.owner, ticket.generation)?;
        self.pending = None;
        Ok(())
    }

    /// Idempotently invalidate all tickets and snapshots, then release the
    /// Store's owned state. Retained snapshot Arcs own their data until dropped.
    pub fn dispose(&mut self) {
        self.lifecycle.disposed.store(true, Ordering::Release);
        self.pending = None;
        drop(self.state.take());
    }

    pub fn is_disposed(&self) -> bool {
        self.lifecycle.disposed.load(Ordering::Acquire)
    }

    fn live_state(&self) -> Result<&StoreState, SnapshotError> {
        self.lifecycle.ensure_live()?;
        self.state.as_ref().ok_or_else(disposed)
    }

    fn check_attempt(&self, owner: &Arc<Lifecycle>, generation: u64) -> Result<(), SnapshotError> {
        self.live_state()?;
        if !Arc::ptr_eq(owner, &self.lifecycle) || self.pending != Some(generation) {
            return Err(SnapshotError::new(
                SnapshotErrorKind::Aborted,
                "refresh attempt is foreign, superseded, cancelled, or already finished",
            ));
        }
        Ok(())
    }
}

impl Drop for SnapshotStore {
    fn drop(&mut self) {
        self.dispose();
    }
}

fn validate_input(
    keys: &TrustedKeys,
    config: &PolicyValidationConfig,
    max_policy_bytes: usize,
    input: SignedPolicyInput<'_>,
    now_ms: u64,
) -> Result<ValidatedPolicyBundle, SnapshotError> {
    let parsed = parse_policy_bundle(
        input.payload,
        input.signature,
        input.key_id,
        max_policy_bytes,
    )?;
    let verified = keys.verify_policy_bundle(parsed)?;
    Ok(validate_policy_bundle(verified, config, now_ms)?)
}

fn check_byte_limit(limit: usize, name: &str) -> Result<(), SnapshotError> {
    if limit == 0 || limit as u128 > u128::from(MAX_SAFE_INTEGER) {
        return Err(SnapshotError::new(
            SnapshotErrorKind::InvalidConfig,
            format!("{name} must be a positive JS-safe integer"),
        ));
    }
    Ok(())
}

fn disposed() -> SnapshotError {
    SnapshotError::new(
        SnapshotErrorKind::Disposed,
        "snapshot Store has been disposed",
    )
}
