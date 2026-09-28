//! Authenticate first, then validate policy contents and local acceptance rules.
//! This module does not install policies or advance any stored sequence.

use policy_engine::policy_rpc::ManifestV2;

use super::{policy_content, SignatureVerifiedPolicyBundle};

pub const DEFAULT_MAX_BUNDLE_AGE_SEC: u64 = 259_200;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Local settings. Wire times use seconds; clock and skew use milliseconds.
#[derive(Debug, Clone)]
pub struct PolicyValidationConfig {
    pub env: String,
    pub profile: String,
    /// None selects the v0.1 maximum age of 72 hours.
    pub max_bundle_age_sec: Option<u64>,
    /// Tolerates future issuance only, never extends expiration.
    pub allowed_clock_skew_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicySemanticErrorKind {
    InvalidConfig,
    InvalidPolicyBundle,
    UnsupportedRegistryRef,
    PolicyScopeMismatch,
    PolicyExpired,
    PolicySequenceRejected,
    LimitExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicySemanticError {
    pub kind: PolicySemanticErrorKind,
    pub path: String,
    pub message: String,
}

impl PolicySemanticError {
    pub(super) fn new(
        kind: PolicySemanticErrorKind,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            path: path.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            PolicySemanticErrorKind::InvalidConfig => "INVALID_CONFIG",
            PolicySemanticErrorKind::InvalidPolicyBundle => "INVALID_POLICY_BUNDLE",
            PolicySemanticErrorKind::UnsupportedRegistryRef => "UNSUPPORTED_REGISTRY_REF",
            PolicySemanticErrorKind::PolicyScopeMismatch => "POLICY_SCOPE_MISMATCH",
            PolicySemanticErrorKind::PolicyExpired => "POLICY_EXPIRED",
            PolicySemanticErrorKind::PolicySequenceRejected => "POLICY_SEQUENCE_REJECTED",
            PolicySemanticErrorKind::LimitExceeded => "LIMIT_EXCEEDED",
        }
    }
}

impl std::fmt::Display for PolicySemanticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}: {}", self.code(), self.path, self.message)
    }
}

impl std::error::Error for PolicySemanticError {}

/// A pure comparison result, not evidence that a snapshot has been activated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyUpdate {
    Replace,
    Unchanged,
}

/// Immutable authenticated contents that passed semantics at a supplied time.
/// Freshness must be checked again at activation/use; validation is not a lease.
#[derive(Debug)]
pub struct ValidatedPolicyBundle {
    verified: SignatureVerifiedPolicyBundle,
    manifests: Vec<ManifestV2>,
    sequence: u64,
    issued_at_ms: u64,
    valid_until_ms: u64,
    allowed_clock_skew_ms: u64,
}

impl ValidatedPolicyBundle {
    pub fn signature_verified(&self) -> &SignatureVerifiedPolicyBundle {
        &self.verified
    }

    /// Full manifests in the same order as the original signed policy entries.
    pub fn manifests(&self) -> &[ManifestV2] {
        &self.manifests
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn env(&self) -> &str {
        self.verified.parsed().payload()["env"]
            .as_str()
            .expect("parser checked env")
    }

    pub fn profile(&self) -> &str {
        self.verified.parsed().payload()["profile"]
            .as_str()
            .expect("parser checked profile")
    }

    /// Exclusive expiration, fixed from signed issue/expiry and local maximum age.
    pub fn valid_until_ms(&self) -> u64 {
        self.valid_until_ms
    }

    pub fn ensure_fresh(&self, now_ms: u64) -> Result<(), PolicySemanticError> {
        check_time(
            self.issued_at_ms,
            self.valid_until_ms,
            self.allowed_clock_skew_ms,
            now_ms,
        )
    }

    /// Compare against the latest accepted bundle without mutating it.
    /// C4 must make this check and activation atomic. An expired previous bundle
    /// still supplies its sequence floor; failed refreshes do not reset that floor.
    pub fn check_update(
        &self,
        previous: Option<&Self>,
        now_ms: u64,
    ) -> Result<PolicyUpdate, PolicySemanticError> {
        self.ensure_fresh(now_ms)?;
        let Some(previous) = previous else {
            return Ok(PolicyUpdate::Replace);
        };
        if self.env() != previous.env() || self.profile() != previous.profile() {
            return Err(PolicySemanticError::new(
                PolicySemanticErrorKind::PolicyScopeMismatch,
                "$",
                "sequence comparison requires the same env/profile scope",
            ));
        }
        match self.sequence.cmp(&previous.sequence) {
            std::cmp::Ordering::Greater => Ok(PolicyUpdate::Replace),
            std::cmp::Ordering::Equal
                if self.verified.parsed().payload_bytes()
                    == previous.verified.parsed().payload_bytes() =>
            {
                Ok(PolicyUpdate::Unchanged)
            }
            _ => Err(PolicySemanticError::new(
                PolicySemanticErrorKind::PolicySequenceRejected,
                "$/sequence",
                "sequence must increase, or repeat with the exact same B bytes",
            )),
        }
    }
}

/// Validate the entire authenticated bundle. No invalid entry is filtered out
/// or converted to a runtime quarantine warning.
pub fn validate_policy_bundle(
    verified: SignatureVerifiedPolicyBundle,
    config: &PolicyValidationConfig,
    now_ms: u64,
) -> Result<ValidatedPolicyBundle, PolicySemanticError> {
    let max_age = config
        .max_bundle_age_sec
        .unwrap_or(DEFAULT_MAX_BUNDLE_AGE_SEC);
    if !matches!(config.env.as_str(), "staging" | "production") || config.profile != "default" {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::InvalidConfig,
            "config/trust",
            "env must be staging or production and profile must be default",
        ));
    }
    if !(1..=MAX_SAFE_INTEGER).contains(&max_age) || config.allowed_clock_skew_ms > MAX_SAFE_INTEGER
    {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::InvalidConfig,
            "config/limits",
            "maxBundleAgeSec must be positive and skew non-negative, both safe integers",
        ));
    }
    check_clock(now_ms)?;
    let payload = verified.parsed().payload();
    if payload["env"].as_str() != Some(config.env.as_str())
        || payload["profile"].as_str() != Some(config.profile.as_str())
    {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::PolicyScopeMismatch,
            "$",
            "policy env/profile does not match local trust",
        ));
    }
    if !payload["registry_ref"].is_null() {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::UnsupportedRegistryRef,
            "$/registry_ref",
            "v0.1 supports only a null registry_ref",
        ));
    }

    // The parser has already limited these integers to the JS-safe range.
    // Their sum, followed by conversion to milliseconds, still fits in u64.
    let issued_at = payload["issued_at"]
        .as_u64()
        .expect("parser checked issued_at");
    let expires_at = payload["expires_at"].as_u64();
    if expires_at.is_some_and(|expiry| expiry <= issued_at) {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::InvalidPolicyBundle,
            "$/expires_at",
            "expires_at must be later than issued_at",
        ));
    }
    let age_deadline = issued_at + max_age;
    let valid_until_ms = expires_at.map_or(age_deadline, |expiry| expiry.min(age_deadline)) * 1000;
    let issued_at_ms = issued_at * 1000;
    check_time(
        issued_at_ms,
        valid_until_ms,
        config.allowed_clock_skew_ms,
        now_ms,
    )?;
    let sequence = payload["sequence"]
        .as_u64()
        .expect("parser checked sequence");
    let manifests = policy_content::validate_policies(payload)?;
    Ok(ValidatedPolicyBundle {
        verified,
        manifests,
        sequence,
        issued_at_ms,
        valid_until_ms,
        allowed_clock_skew_ms: config.allowed_clock_skew_ms,
    })
}

fn check_clock(now_ms: u64) -> Result<(), PolicySemanticError> {
    if now_ms > MAX_SAFE_INTEGER {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::InvalidConfig,
            "clock/now",
            "clock must return non-negative safe-integer Unix milliseconds",
        ));
    }
    Ok(())
}

fn check_time(
    issued_at_ms: u64,
    valid_until_ms: u64,
    allowed_clock_skew_ms: u64,
    now_ms: u64,
) -> Result<(), PolicySemanticError> {
    check_clock(now_ms)?;
    if issued_at_ms > now_ms + allowed_clock_skew_ms {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::InvalidPolicyBundle,
            "$/issued_at",
            "policy issuance is beyond the allowed future clock skew",
        ));
    }
    if now_ms >= valid_until_ms {
        return Err(PolicySemanticError::new(
            PolicySemanticErrorKind::PolicyExpired,
            "$/expires_at",
            "policy has reached its explicit expiry or maximum age",
        ));
    }
    Ok(())
}
