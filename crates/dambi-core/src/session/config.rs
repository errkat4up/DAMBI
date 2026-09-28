use serde::Deserialize;

use crate::bundle::{KeyRole, PolicyValidationConfig, VerificationKey};
use crate::snapshot::{SignedPolicyInput, SnapshotStoreConfig};

use super::{parse_json, SessionError, MAX_SAFE_INTEGER};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    pub decoder_snapshot: Decoder,
    pub trust: Trust,
    pub limits: Limits,
    pub enforcement: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Decoder {
    pub artifact: String,
    pub expected_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Trust {
    env: String,
    profile: String,
    keys: Vec<Key>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    key_id: String,
    role: String,
    public_key_spki_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Limits {
    pub max_bundle_age_sec: Option<u64>,
    pub allowed_clock_skew_ms: u64,
    pub max_policy_bytes: u64,
    pub max_decoder_bytes: u64,
    pub max_request_bytes: u64,
    pub max_fact_bytes: u64,
    pub max_plan_calls: u64,
    pub plan_ttl_ms: u64,
    pub max_pending_plans: u64,
    pub max_fact_age_ms: u64,
    fact_timeout_ms: u64,
    policy_timeout_ms: u64,
}

impl Config {
    pub fn parse(input: &str) -> Result<Self, SessionError> {
        let value = parse_json(input, "INVALID_CONFIG")?;
        if value
            .pointer("/limits/maxBundleAgeSec")
            .is_some_and(serde_json::Value::is_null)
        {
            return Err(SessionError::new(
                "INVALID_CONFIG",
                "maxBundleAgeSec may be omitted but cannot be null",
            ));
        }
        let config: Self = serde_json::from_value(value)
            .map_err(|error| SessionError::new("INVALID_CONFIG", error.to_string()))?;
        if !matches!(config.enforcement.as_str(), "advisory" | "enforcing") {
            return Err(SessionError::new("INVALID_CONFIG", "invalid enforcement"));
        }
        config.limits.validate()?;
        Ok(config)
    }

    pub fn store_config(&self) -> Result<SnapshotStoreConfig, SessionError> {
        let keys = self
            .trust
            .keys
            .iter()
            .map(|key| {
                let role = match key.role.as_str() {
                    "policy" => KeyRole::Policy,
                    "decoder" => KeyRole::Decoder,
                    _ => {
                        return Err(SessionError::new(
                            "INVALID_CONFIG",
                            "unknown verification key role",
                        ))
                    }
                };
                Ok(VerificationKey {
                    key_id: key.key_id.clone(),
                    role,
                    public_key_spki_base64: key.public_key_spki_base64.clone(),
                })
            })
            .collect::<Result<Vec<_>, SessionError>>()?;
        Ok(SnapshotStoreConfig {
            keys,
            policy: PolicyValidationConfig {
                env: self.trust.env.clone(),
                profile: self.trust.profile.clone(),
                max_bundle_age_sec: self.limits.max_bundle_age_sec,
                allowed_clock_skew_ms: self.limits.allowed_clock_skew_ms,
            },
            // A 32-bit host cannot represent an input longer than usize::MAX.
            // Saturating only this internal byte-cap representation preserves
            // the public JS-safe u64 configuration without a platform-specific
            // rejection or a new public maximum.
            max_policy_bytes: usize::try_from(self.limits.max_policy_bytes).unwrap_or(usize::MAX),
            max_decoder_bytes: usize::try_from(self.limits.max_decoder_bytes).unwrap_or(usize::MAX),
        })
    }
}

impl Limits {
    fn validate(&self) -> Result<(), SessionError> {
        let values = [
            ("maxPolicyBytes", self.max_policy_bytes),
            ("maxDecoderBytes", self.max_decoder_bytes),
            ("maxRequestBytes", self.max_request_bytes),
            ("maxFactBytes", self.max_fact_bytes),
            ("maxPlanCalls", self.max_plan_calls),
            ("planTtlMs", self.plan_ttl_ms),
            ("maxPendingPlans", self.max_pending_plans),
            ("maxFactAgeMs", self.max_fact_age_ms),
            ("factTimeoutMs", self.fact_timeout_ms),
            ("policyTimeoutMs", self.policy_timeout_ms),
        ];
        for (name, value) in values {
            if value == 0 || value > MAX_SAFE_INTEGER {
                return Err(SessionError::new(
                    "INVALID_CONFIG",
                    format!("{name} must be a positive safe integer"),
                ));
            }
        }
        if self.allowed_clock_skew_ms > MAX_SAFE_INTEGER
            || self
                .max_bundle_age_sec
                .is_some_and(|age| age == 0 || age > MAX_SAFE_INTEGER)
        {
            return Err(SessionError::new(
                "INVALID_CONFIG",
                "invalid policy age or clock skew",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Policy {
    payload: String,
    signature: String,
    key_id: Option<String>,
}

impl Policy {
    pub fn parse(input: &str, max_bytes: u64) -> Result<Self, SessionError> {
        // B may be JSON-escaped in this in-process wrapper. The actual Store
        // limit still applies to decoded B bytes, before signature verification.
        if input.len() as u64 > max_bytes.saturating_mul(6).saturating_add(4096) {
            return Err(SessionError::new(
                "LIMIT_EXCEEDED",
                "policy wrapper is too large",
            ));
        }
        let value = parse_json(input, "INVALID_POLICY_BUNDLE")?;
        if value.get("keyId").is_some_and(|key| !key.is_string()) {
            return Err(SessionError::new(
                "INVALID_POLICY_BUNDLE",
                "keyId must be a string when present",
            ));
        }
        serde_json::from_value(value)
            .map_err(|error| SessionError::new("INVALID_POLICY_BUNDLE", error.to_string()))
    }

    pub fn input(&self) -> SignedPolicyInput<'_> {
        SignedPolicyInput {
            payload: self.payload.as_bytes(),
            signature: &self.signature,
            key_id: self.key_id.as_deref(),
        }
    }
}
