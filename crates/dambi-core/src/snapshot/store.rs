//! Instance-owned snapshots with staged, latest-begun-wins policy refreshes.
//!
//! Network I/O belongs to the caller. Only this Store's fixed trust settings can
//! prepare a candidate, and preparation never changes the active snapshot.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use crate::bundle::{
    parse_policy_bundle, validate_policy_bundle_with_registry, PolicyUpdate, PolicyValidationConfig,
    RegistryRef, TrustedKeys, ValidatedPolicyBundle, VerificationKey,
};

use super::{
    prepare_decoder, DecoderInput, RegistryConfig, RegistryObservation, SignedPolicyInput,
    SnapshotError, SnapshotErrorKind, VerifiedDecoderSnapshot,
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
    // Shared by retained snapshots: Registry replacement/revocation invalidates
    // plans without mutating their pinned policy/Decoder audit contents.
    registry: Option<Mutex<RegistryGate>>,
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
        if let Some(gate) = &self.lifecycle.registry {
            gate.lock()
                .map_err(|_| registry_lock_error())?
                .ensure_usable(self.policy.sequence(), now_ms)?;
        }
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
    observation: Option<RegistryObservation>,
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
        Self::new_inner(config, decoder_input, initial, None, now_ms)
    }

    pub fn new_with_registry(
        config: SnapshotStoreConfig,
        decoder_input: DecoderInput<'_>,
        initial: SignedPolicyInput<'_>,
        registry: RegistryConfig,
        observation: RegistryObservation,
        now_ms: u64,
    ) -> Result<Self, SnapshotError> {
        Self::new_inner(
            config,
            decoder_input,
            initial,
            Some((registry, observation)),
            now_ms,
        )
    }

    fn new_inner(
        config: SnapshotStoreConfig,
        decoder_input: DecoderInput<'_>,
        initial: SignedPolicyInput<'_>,
        registry: Option<(RegistryConfig, RegistryObservation)>,
        now_ms: u64,
    ) -> Result<Self, SnapshotError> {
        let gate = registry
            .map(|(registry, observation)| {
                RegistryGate::new(registry, &config.policy, observation, now_ms)
            })
            .transpose()?;
        let reference = gate.as_ref().map(|gate| gate.config.reference());
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
            reference.as_ref(),
            now_ms,
        )?;
        if let Some(gate) = &gate {
            bind_policy(&gate.last, &policy)?;
            gate.ensure_usable(policy.sequence(), now_ms)?;
        }
        let lifecycle = Arc::new(Lifecycle {
            disposed: AtomicBool::new(false),
            registry: gate.map(Mutex::new),
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
        self.prepare_inner(ticket, policy, None, now_ms)
    }

    pub fn prepare_registry_refresh(
        &self,
        ticket: &RefreshTicket,
        policy: SignedPolicyInput<'_>,
        observation: RegistryObservation,
        now_ms: u64,
    ) -> Result<PreparedRefresh, SnapshotError> {
        self.prepare_inner(ticket, policy, Some(observation), now_ms)
    }

    fn prepare_inner(
        &self,
        ticket: &RefreshTicket,
        policy: SignedPolicyInput<'_>,
        observation: Option<RegistryObservation>,
        now_ms: u64,
    ) -> Result<PreparedRefresh, SnapshotError> {
        self.check_attempt(&ticket.owner, ticket.generation)?;
        let reference = match (&self.lifecycle.registry, &observation) {
            (Some(gate), Some(observation)) => {
                let gate = gate.lock().map_err(|_| registry_lock_error())?;
                gate.validate_next(observation, now_ms)?;
                Some(gate.config.reference())
            }
            (None, None) => None,
            _ => return Err(scope_error("Registry state and local mode must agree")),
        };
        let state = self.live_state()?;
        let policy = validate_input(
            &state.keys,
            &state.policy_config,
            state.max_policy_bytes,
            policy,
            reference.as_ref(),
            now_ms,
        )?;
        if let Some(observation) = &observation {
            bind_policy(observation, &policy)?;
        }
        Ok(PreparedRefresh {
            owner: Arc::clone(&self.lifecycle),
            generation: ticket.generation,
            policy,
            observation,
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
        let mut registry = self
            .lifecycle
            .registry
            .as_ref()
            .map(|gate| gate.lock().map_err(|_| registry_lock_error()))
            .transpose()?;
        let deadline = match (&registry, &prepared.observation) {
            (Some(gate), Some(observation)) => {
                bind_policy(observation, &prepared.policy)?;
                Some(gate.validate_next(observation, now_ms)?)
            }
            (None, None) => None,
            _ => return Err(scope_error("Registry state and local mode must agree")),
        };
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
        if let (Some(gate), Some(observation), Some(deadline)) =
            (&mut registry, prepared.observation, deadline)
        {
            gate.last = observation;
            gate.deadline = deadline;
        }
        // Unchanged retains the exact Arc and signed expiry. Only a newer block
        // can advance its Registry lease; a repeated block cannot extend it.
        Ok(update)
    }

    /// Revocation needs no policy body/signature: it is an observation from the
    /// locally trusted RPC channel. Invalid/unavailable observations do not revoke.
    pub fn commit_registry_revocation(
        &mut self,
        ticket: &RefreshTicket,
        observation: RegistryObservation,
        now_ms: u64,
    ) -> Result<(), SnapshotError> {
        self.check_attempt(&ticket.owner, ticket.generation)?;
        let gate = self
            .lifecycle
            .registry
            .as_ref()
            .ok_or_else(|| scope_error("Registry state supplied in HTTP mode"))?;
        let mut gate = gate.lock().map_err(|_| registry_lock_error())?;
        if observation.status != "revoked" {
            return Err(scope_error("expected an explicit revoked observation"));
        }
        let deadline = gate.validate_next(&observation, now_ms)?;
        gate.last = observation;
        gate.deadline = deadline;
        self.pending = None;
        Ok(())
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
    registry: Option<&RegistryRef>,
    now_ms: u64,
) -> Result<ValidatedPolicyBundle, SnapshotError> {
    let parsed = parse_policy_bundle(
        input.payload,
        input.signature,
        input.key_id,
        max_policy_bytes,
    )?;
    let verified = keys.verify_policy_bundle(parsed)?;
    Ok(validate_policy_bundle_with_registry(
        verified, config, registry, now_ms,
    )?)
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

fn scope_error(message: &str) -> SnapshotError {
    SnapshotError::new(SnapshotErrorKind::PolicyScopeMismatch, message)
}

fn registry_lock_error() -> SnapshotError {
    SnapshotError::new(
        SnapshotErrorKind::InvalidConfig,
        "Registry state lock poisoned",
    )
}

fn rejected_state(message: &str) -> SnapshotError {
    SnapshotError::new(SnapshotErrorKind::PolicySequenceRejected, message)
}

fn hex32(value: &str) -> bool {
    value.len() == 66
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn bind_policy(
    observation: &RegistryObservation,
    policy: &ValidatedPolicyBundle,
) -> Result<(), SnapshotError> {
    use sha2::{Digest, Sha256};
    if observation.status != "active" {
        return Err(SnapshotError::new(
            SnapshotErrorKind::PolicyExpired,
            "Registry policy is revoked",
        ));
    }
    let digest = format!(
        "0x{}",
        hex::encode(Sha256::digest(
            policy.signature_verified().parsed().payload_bytes(),
        ))
    );
    if observation.version != policy.sequence() || observation.payload_digest != digest {
        return Err(rejected_state(
            "Registry version/digest does not bind the signed body",
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct RegistryGate {
    config: RegistryConfig,
    env: String,
    profile: String,
    last: RegistryObservation,
    deadline: u64,
}

impl RegistryGate {
    fn new(
        config: RegistryConfig,
        policy: &PolicyValidationConfig,
        last: RegistryObservation,
        now: u64,
    ) -> Result<Self, SnapshotError> {
        if !config.reference().is_valid()
            || !matches!(config.finality.as_str(), "safe" | "finalized")
            || !(1..=MAX_SAFE_INTEGER).contains(&config.max_state_age_ms)
        {
            return Err(SnapshotError::new(
                SnapshotErrorKind::InvalidConfig,
                "invalid local Registry configuration",
            ));
        }
        let mut gate = Self {
            config,
            env: policy.env.clone(),
            profile: policy.profile.clone(),
            last,
            deadline: 0,
        };
        gate.deadline = gate.validate_observation(&gate.last, now)?;
        Ok(gate)
    }

    fn validate_observation(
        &self,
        next: &RegistryObservation,
        now: u64,
    ) -> Result<u64, SnapshotError> {
        if next.chain_id != self.config.chain_id
            || next.registry_address != self.config.registry_address
            || next.env != self.env
            || next.profile != self.profile
            || next.finality != self.config.finality
        {
            return Err(scope_error(
                "Registry scope/finality does not match local trust",
            ));
        }
        if now > MAX_SAFE_INTEGER
            || next.observed_at_ms > now
            || next.block_number > MAX_SAFE_INTEGER
            || next.block_timestamp > MAX_SAFE_INTEGER
            || !(1..=MAX_SAFE_INTEGER).contains(&next.version)
            || !matches!(next.status.as_str(), "active" | "revoked")
            || !hex32(&next.block_hash)
            || !hex32(&next.payload_digest)
        {
            return Err(SnapshotError::new(
                SnapshotErrorKind::InvalidPolicyBundle,
                "invalid Registry observation",
            ));
        }
        let block_ms = next.block_timestamp * 1000;
        if block_ms > next.observed_at_ms {
            return Err(SnapshotError::new(
                SnapshotErrorKind::InvalidPolicyBundle,
                "Registry block timestamp is in the future",
            ));
        }
        let deadline = block_ms
            .checked_add(self.config.max_state_age_ms)
            .filter(|deadline| *deadline <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                SnapshotError::new(
                    SnapshotErrorKind::InvalidPolicyBundle,
                    "Registry deadline exceeds safe time",
                )
            })?;
        if now >= deadline {
            return Err(SnapshotError::new(
                SnapshotErrorKind::PolicyExpired,
                "last acknowledged Registry block lease expired",
            ));
        }
        Ok(deadline)
    }

    fn validate_next(&self, next: &RegistryObservation, now: u64) -> Result<u64, SnapshotError> {
        let deadline = self.validate_observation(next, now)?;
        let old = &self.last;
        if next.block_number < old.block_number
            || next.block_timestamp < old.block_timestamp
            || next.observed_at_ms < old.observed_at_ms
            || next.version < old.version
        {
            return Err(rejected_state("Registry observation moved backwards"));
        }
        // A block hash identifies one header, including its height and time.
        // Relabelling the last acknowledged hash as a higher block must not
        // turn a repeated RPC response into a new lease. Same-height changes
        // (including timestamp changes) are checked by the exact comparison below.
        if next.block_hash == old.block_hash && next.block_number != old.block_number {
            return Err(rejected_state(
                "Registry block hash was reused at a different height",
            ));
        }
        if next.block_number == old.block_number {
            let mut repeated = next.clone();
            repeated.observed_at_ms = old.observed_at_ms;
            if &repeated != old {
                return Err(rejected_state(
                    "conflicting Registry state at the same block height",
                ));
            }
        }
        if next.version == old.version
            && (next.payload_digest != old.payload_digest
                || (old.status == "revoked" && next.status != "revoked"))
        {
            return Err(rejected_state(
                "Registry version content changed or revoked version reactivated",
            ));
        }
        Ok(deadline)
    }

    fn ensure_usable(&self, version: u64, now: u64) -> Result<(), SnapshotError> {
        if self.last.status == "revoked" {
            return Err(SnapshotError::new(
                SnapshotErrorKind::PolicyExpired,
                "Registry policy is revoked; replan after a new active version",
            ));
        }
        if version != self.last.version {
            return Err(SnapshotError::new(
                SnapshotErrorKind::PolicyExpired,
                "Registry policy was superseded; replan required",
            ));
        }
        if now > MAX_SAFE_INTEGER || now < self.last.observed_at_ms || now >= self.deadline {
            return Err(SnapshotError::new(
                SnapshotErrorKind::PolicyExpired,
                "last acknowledged Registry block lease expired or clock regressed",
            ));
        }
        Ok(())
    }
}

fn disposed() -> SnapshotError {
    SnapshotError::new(
        SnapshotErrorKind::Disposed,
        "snapshot Store has been disposed",
    )
}
