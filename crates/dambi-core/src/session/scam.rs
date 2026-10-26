//! SF3 native plan-owned scam channel. This module never supplies policy facts
//! and never turns an analysis failure into policy fail-closed.

use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use alloy_primitives::U256;
use base64::{engine::general_purpose::STANDARD, Engine};
use policy_state::token::TokenKey;
use policy_transition::action::{
    amm::{AmmAction, AmmVenue},
    ActionBody,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{parse_json, Node, SessionError, MAX_SAFE_INTEGER};
use crate::bundle::{KeyRole, TrustedKeys, VerificationKey};
use crate::scam::*;

const NOTICE: &str = "patterns_only_no_sellability_guarantee";
const BUILDER_VERSION: &str = "dambi-v2/1";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    settings: Settings,
    trust: Trust,
    limits: Limits,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trust {
    env: String,
    profile: String,
    keys: Vec<Key>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Key {
    key_id: String,
    role: String,
    public_key_spki_base64: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    enabled: bool,
    preset_id: String,
    overrides: Vec<Value>,
    additional_rules: Vec<RuleSpec>,
    locale: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    scam_timeout_ms: u64,
    scam_eval_reserve_ms: u64,
    max_bundle_bytes: u64,
    max_result_bytes: u64,
    max_calls: u64,
    max_targets: u64,
    max_rules: u64,
    max_logs: u64,
    max_points: u64,
    max_algorithm_work_units: u64,
}

impl Config {
    pub(super) fn validate(&self) -> Result<(), SessionError> {
        let l = &self.limits;
        if [
            l.scam_timeout_ms,
            l.scam_eval_reserve_ms,
            l.max_bundle_bytes,
            l.max_result_bytes,
            l.max_calls,
            l.max_targets,
            l.max_rules,
            l.max_logs,
            l.max_points,
            l.max_algorithm_work_units,
        ]
        .iter()
        .any(|v| *v == 0 || *v > MAX_SAFE_INTEGER)
            || !matches!(self.trust.env.as_str(), "staging" | "production")
            || self.trust.profile.trim().is_empty()
            || self.trust.keys.is_empty()
        {
            return Err(config_error("invalid scam limits or trust scope"));
        }
        let mut keys = BTreeSet::new();
        for key in &self.trust.keys {
            if key.key_id.is_empty()
                || key.role != "scam"
                || key.public_key_spki_base64.is_empty()
                || !keys.insert(&key.key_id)
            {
                return Err(config_error("invalid scam role key"));
            }
        }
        self.trusted_keys()?;
        validate_settings(&self.settings, l)
    }

    fn trusted_keys(&self) -> Result<TrustedKeys, SessionError> {
        let keys: Vec<_> = self
            .trust
            .keys
            .iter()
            .map(|key| VerificationKey {
                key_id: key.key_id.clone(),
                role: KeyRole::Scam,
                public_key_spki_base64: key.public_key_spki_base64.clone(),
            })
            .collect();
        TrustedKeys::for_role(&keys, KeyRole::Scam)
            .map_err(|error| SessionError::new(error.code(), error.message))
    }

    pub(super) fn validate_separate_keys(
        &self,
        policy_keys: &[VerificationKey],
    ) -> Result<(), SessionError> {
        let policy = TrustedKeys::new(policy_keys)
            .map_err(|error| SessionError::new(error.code(), error.message))?;
        if self.trusted_keys()?.shares_key_with(&policy) {
            return Err(config_error(
                "scam keys must be distinct from policy and Decoder keys",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preset {
    id: String,
    rules: Vec<RuleSpec>,
    bucket_ms: u64,
    grid_origin_ms: u64,
    warmup_sec: u64,
    max_data_age_sec: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    age_threshold_sec: u64,
    unknown_age: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresetPair {
    id: String,
    purpose: String,
    selection: Selection,
    new_market: Preset,
    established: Preset,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Support {
    chain_id: u64,
    venue: String,
    factories: Vec<String>,
    quote_tokens: Vec<String>,
    exempt_tokens: Vec<String>,
    allowed_bucket_ms: Vec<u64>,
    confirm_depth: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compatibility {
    engine_range: String,
    builder_range: String,
    contract_version: String,
    algorithm: Option<AlgorithmIdentity>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    kind: String,
    schema: String,
    sequence: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
    env: String,
    profile: String,
    compatibility: Compatibility,
    support: Vec<Support>,
    presets: Vec<PresetPair>,
    templates: BTreeMap<String, String>,
    model: Option<Value>,
}

// Immutable snapshots are shared within one session. The algorithm port does
// not require Send + Sync, so this ownership does not imply thread safety.
struct Installed {
    bundle: Bundle,
    digest: String,
    builder_version: String,
    module: Option<Rc<dyn AlgorithmModule>>,
}

pub(super) struct State {
    config: Config,
    trusted: TrustedKeys,
    installed: Option<Rc<Installed>>,
}

impl State {
    pub(super) fn new(config: Config) -> Result<Self, SessionError> {
        let trusted = config.trusted_keys()?;
        Ok(Self {
            config,
            trusted,
            installed: None,
        })
    }

    /// Authenticate original bytes, then validate completely before replacing
    /// the installed snapshot. Response keyId is telemetry and never selects trust.
    pub(super) fn install_signed(&mut self, input: &str, now: u64) -> Result<(), SessionError> {
        let limit = self.config.limits.max_bundle_bytes;
        if input.len() as u64 > limit.saturating_mul(6).saturating_add(4096) {
            return Err(SessionError::new(
                "LIMIT_EXCEEDED",
                "scam bundle wrapper is too large",
            ));
        }
        let value = parse_json(input, "INVALID_SCAM_BUNDLE")?;
        if value.get("keyId").is_some_and(|key| !key.is_string()) {
            return Err(SessionError::new(
                "INVALID_SCAM_BUNDLE",
                "keyId must be a string when present",
            ));
        }
        let envelope: SignedBundle = serde_json::from_value(value).map_err(|_| {
            SessionError::new("INVALID_SCAM_BUNDLE", "invalid scam bundle envelope")
        })?;
        if envelope.payload.is_empty() {
            return Err(SessionError::new(
                "INVALID_SCAM_BUNDLE",
                "scam payload must not be empty",
            ));
        }
        if envelope.payload.len() as u64 > limit {
            return Err(SessionError::new(
                "LIMIT_EXCEEDED",
                "scam payload exceeds maxBundleBytes",
            ));
        }
        // An exact padded Base64 P1363 encoding is required, never DER.
        if envelope.signature.len() != 88 {
            return Err(SessionError::new(
                "INVALID_SIGNATURE",
                "scam signature must be padded Base64 P1363",
            ));
        }
        let signature = STANDARD.decode(&envelope.signature).map_err(|_| {
            SessionError::new("INVALID_SIGNATURE", "invalid scam signature encoding")
        })?;
        if STANDARD.encode(&signature) != envelope.signature {
            return Err(SessionError::new(
                "INVALID_SIGNATURE",
                "invalid scam signature encoding",
            ));
        }
        let signature: [u8; 64] = signature
            .try_into()
            .map_err(|_| SessionError::new("INVALID_SIGNATURE", "scam signature must be P1363"))?;
        self.trusted
            .verify_bytes(KeyRole::Scam, envelope.payload.as_bytes(), &signature)
            .map_err(|error| SessionError::new(error.code(), error.message))?;
        let value = parse_json(&envelope.payload, "INVALID_SCAM_BUNDLE")?;
        if value.get("model").is_none() || value.pointer("/compatibility/algorithm").is_none() {
            return Err(SessionError::new(
                "INVALID_SCAM_BUNDLE",
                "missing explicit model or algorithm field",
            ));
        }
        let bundle: Bundle = serde_json::from_value(value).map_err(|_| {
            SessionError::new("INVALID_SCAM_BUNDLE", "invalid scam payload structure")
        })?;
        if bundle.env != self.config.trust.env || bundle.profile != self.config.trust.profile {
            return Err(SessionError::new(
                "SCAM_SCOPE_MISMATCH",
                "scam bundle scope does not match local trust",
            ));
        }
        if bundle.issued_at_ms > MAX_SAFE_INTEGER
            || bundle.expires_at_ms > MAX_SAFE_INTEGER
            || bundle.issued_at_ms >= bundle.expires_at_ms
        {
            return Err(SessionError::new(
                "INVALID_SCAM_BUNDLE",
                "invalid scam bundle lifetime",
            ));
        }
        if bundle.issued_at_ms > now || now >= bundle.expires_at_ms {
            return Err(SessionError::new(
                "SCAM_EXPIRED",
                "scam bundle is not currently valid",
            ));
        }
        let invalid_bundle =
            |error: SessionError| SessionError::new("INVALID_SCAM_BUNDLE", error.message);
        validate_bundle(&bundle, &self.config, BUILDER_VERSION, now).map_err(invalid_bundle)?;
        for pair in &bundle.presets {
            if pair.purpose == "default"
                && [&pair.new_market, &pair.established]
                    .iter()
                    .flat_map(|preset| &preset.rules)
                    .any(|rule| {
                        rule.enabled()
                            && matches!(
                                rule,
                                RuleSpec::ChangeCount { .. } | RuleSpec::SwitchDensity { .. }
                            )
                    })
            {
                return Err(SessionError::new(
                    "INVALID_SCAM_BUNDLE",
                    "default R1/R2 require explicit demo opt-in in this MVP",
                ));
            }
        }
        effective_pair(&bundle, &self.config.settings, &self.config.limits)
            .map_err(invalid_bundle)?;
        let digest = format!(
            "0x{}",
            hex::encode(Sha256::digest(envelope.payload.as_bytes()))
        );
        if let Some(installed) = &self.installed {
            let incoming = decimal(&bundle.sequence)
                .ok_or_else(|| SessionError::new("INVALID_SCAM_BUNDLE", "invalid scam sequence"))?;
            let previous = decimal(&installed.bundle.sequence).ok_or_else(|| {
                SessionError::new("INVALID_SCAM_BUNDLE", "invalid installed sequence")
            })?;
            if incoming < previous || incoming == previous && digest != installed.digest {
                return Err(SessionError::new(
                    "SCAM_SEQUENCE_REJECTED",
                    "scam bundle sequence rollback or equivocation",
                ));
            }
            if incoming == previous {
                return Ok(());
            }
        }
        // Module linking is a separate integration step. Never copy a test
        // fixture module into an authenticated production bundle installation.
        self.installed = Some(Rc::new(Installed {
            bundle,
            digest,
            builder_version: BUILDER_VERSION.into(),
            module: None,
        }));
        Ok(())
    }

    pub(super) fn set_settings(&mut self, input: &str) -> Result<(), SessionError> {
        if input.len() as u64 > self.config.limits.max_bundle_bytes {
            return Err(config_error("scam settings exceed maxBundleBytes"));
        }
        let settings: Settings = serde_json::from_value(parse_json(input, "INVALID_CONFIG")?)
            .map_err(|e| config_error(e.to_string()))?;
        validate_settings(&settings, &self.config.limits)?;
        if let Some(installed) = &self.installed {
            effective_pair(&installed.bundle, &settings, &self.config.limits)?;
        }
        self.config.settings = settings;
        Ok(())
    }

    #[cfg(feature = "scam-test-fixtures")]
    pub(super) fn install_fixture(&mut self, input: &str, now: u64) -> Result<(), SessionError> {
        if input.len() as u64 > self.config.limits.max_bundle_bytes {
            return Err(config_error("scam fixture exceeds maxBundleBytes"));
        }
        let fixture: Fixture = serde_json::from_value(parse_json(input, "INVALID_CONFIG")?)
            .map_err(|e| config_error(e.to_string()))?;
        validate_bundle(&fixture.bundle, &self.config, &fixture.builder_version, now)?;
        effective_pair(&fixture.bundle, &self.config.settings, &self.config.limits)?;
        if fixture
            .algorithm
            .as_ref()
            .is_some_and(|a| Some(&a.identity) != fixture.bundle.compatibility.algorithm.as_ref())
        {
            return Err(config_error(
                "fixture algorithm identity disagrees with bundle",
            ));
        }
        if fixture.algorithm.as_ref().is_some_and(|a| {
            a.requirements.minimum_warmup_ms > MAX_SAFE_INTEGER
                || a.results.len() as u64 > self.config.limits.max_rules
        }) {
            return Err(config_error("fixture algorithm exceeds configured bounds"));
        }
        let module = fixture.algorithm.map(|a| {
            Rc::new(FixedModule {
                identity: a.identity,
                requirements: a.requirements,
                results: a.results,
                limits: algorithm_limits(&self.config.limits),
            }) as Rc<dyn AlgorithmModule>
        });
        let digest = hash("dambi.scam.fixture-bundle/1", &fixture.bundle)?;
        self.installed = Some(Rc::new(Installed {
            bundle: fixture.bundle,
            digest,
            builder_version: fixture.builder_version,
            module,
        }));
        Ok(())
    }

    pub(super) fn pin(&self, nodes: &[Node], plan_id: &str, now: u64) -> Plan {
        let mut plan = Plan {
            config: self.config.clone(),
            installed: self.installed.clone(),
            pair: None,
            context: None,
            targets: Vec::new(),
            reason: None,
            inactive: None,
            calls: Vec::new(),
            unresolved: false,
            started_at: now,
        };
        if !self.config.settings.enabled {
            plan.inactive = Some("user_disabled");
            return plan;
        }
        let Some(installed) = &self.installed else {
            plan.reason = Some(FailureReason::BundleUnavailable);
            return plan;
        };
        if now < installed.bundle.issued_at_ms || now >= installed.bundle.expires_at_ms {
            plan.reason = Some(FailureReason::BundleInvalid);
            return plan;
        }
        let pair = match effective_pair(
            &installed.bundle,
            &self.config.settings,
            &self.config.limits,
        ) {
            Ok(pair) => pair,
            Err(_) => {
                plan.reason = Some(FailureReason::BundleInvalid);
                return plan;
            }
        };
        let settings_hash = match hash(
            "dambi.scam.settings/1",
            &json!({
                "candidates": {"newMarket": pair.new_market, "established": pair.established},
                "selection": pair.selection,
            }),
        ) {
            Ok(hash) => hash,
            Err(_) => {
                plan.reason = Some(FailureReason::BundleInvalid);
                return plan;
            }
        };
        plan.context = Some(json!({
            "contractVersion":"0.1", "candidates":{"newMarket":pair.new_market,"established":pair.established},
            "selection":pair.selection, "settingsHash":settings_hash,
            "settingsHashScheme":"sha256-jcs-scam-v1",
            "customized":!self.config.settings.overrides.is_empty() || !self.config.settings.additional_rules.is_empty(),
            "bundleSequence":installed.bundle.sequence,"bundleDigest":installed.digest,
            "algorithm":match &installed.module {
                Some(module) => json!({"state":"connected","identity":module.identity()}),
                None => json!({"state":"unavailable"}),
            }
        }));
        if pair.new_market.rules.is_empty() && pair.established.rules.is_empty() {
            plan.inactive = Some("no_active_rules");
            plan.pair = Some(pair);
            return plan;
        }
        let mut subjects: Vec<(Subject, Support)> = Vec::new();
        for node in nodes {
            match subject(node, &installed.bundle.support) {
                Target::Ignore => {}
                Target::Unresolved => plan.unresolved = true,
                Target::Subject(s, support) => {
                    let s = *s;
                    if let Some((existing, _)) = subjects.iter_mut().find(|(a, _)| {
                        a.chain_id == s.chain_id && a.pool == s.pool && a.token == s.token
                    }) {
                        existing.action_paths.extend(s.action_paths);
                    } else {
                        subjects.push((s, support));
                    }
                }
            }
        }
        if subjects.len() as u64 > self.config.limits.max_targets
            || (subjects.len() as u64).saturating_mul(2) > self.config.limits.max_calls
        {
            plan.reason = Some(FailureReason::ResourceLimit);
            plan.pair = Some(pair);
            return plan;
        }
        for (index, (subject, support)) in subjects.into_iter().enumerate() {
            let group = format!("{plan_id}-sg{index}");
            let history_id = format!("{plan_id}-s{index}-history");
            let profile_id = format!("{plan_id}-s{index}-profile");
            let target = PinnedTarget {
                subject,
                support,
                group,
                history_id,
                profile_id,
            };
            // A missing module has no useful I/O. Its absence is still pinned and reported.
            if installed.module.is_some() {
                plan.calls.extend(target.calls(
                    &pair,
                    &installed.builder_version,
                    self.config.limits.max_calls,
                ));
            }
            plan.targets.push(target);
        }
        plan.pair = Some(pair);
        plan
    }
}

pub(super) struct Plan {
    config: Config,
    installed: Option<Rc<Installed>>,
    pair: Option<PresetPair>,
    context: Option<Value>,
    targets: Vec<PinnedTarget>,
    reason: Option<FailureReason>,
    inactive: Option<&'static str>,
    pub(super) calls: Vec<Value>,
    unresolved: bool,
    started_at: u64,
}

struct PinnedTarget {
    subject: Subject,
    support: Support,
    group: String,
    history_id: String,
    profile_id: String,
}

impl PinnedTarget {
    fn calls(&self, pair: &PresetPair, builder: &str, search_call_limit: u64) -> Vec<Value> {
        let rules = pair
            .new_market
            .rules
            .iter()
            .chain(&pair.established.rules)
            .collect::<Vec<_>>();
        let lookback = rules.iter().map(|r| r.lookback_sec()).max().unwrap_or(0);
        let warmup = pair.new_market.warmup_sec.max(pair.established.warmup_sec);
        let mut metrics = Vec::new();
        let mut kinds = Vec::new();
        for rule in &rules {
            if let Some(metric) = rule.metric() {
                if !metrics.contains(&metric) {
                    metrics.push(metric);
                }
            }
            if let RuleSpec::EventCount { event_kinds, .. } = rule {
                for kind in event_kinds {
                    if !kinds.contains(kind) {
                        kinds.push(*kind);
                    }
                }
            }
        }
        let event_lookback = rules
            .iter()
            .filter(|r| matches!(r, RuleSpec::EventCount { .. }))
            .map(|r| r.lookback_sec())
            .max()
            .unwrap_or(0);
        let mut resolutions = vec![
            json!({"bucketMs":pair.new_market.bucket_ms,"gridOriginMs":pair.new_market.grid_origin_ms}),
        ];
        let other = json!({"bucketMs":pair.established.bucket_ms,"gridOriginMs":pair.established.grid_origin_ms});
        if !resolutions.contains(&other) {
            resolutions.push(other);
        }
        let common = json!({"subject":self.subject,"referenceGroupId":self.group,
            "confirmDepth":self.support.confirm_depth,"builderVersion":builder});
        let mut history = common.clone();
        history["dataSchema"] = json!("scam.pool_history/1");
        history["lookbackSec"] = json!(lookback);
        history["warmupSec"] = json!(warmup);
        history["metrics"] = json!(metrics);
        history["candidateResolutions"] = json!(resolutions);
        let mut profile = common;
        profile["dataSchema"] = json!("scam.token_profile/1");
        profile["ageThresholdSec"] = json!(pair.selection.age_threshold_sec);
        // Conditional age search remains bounded; it never requests a second plan.
        profile["ageSearchMaxLookbackSec"] = json!(lookback);
        profile["maxAgeSearchCalls"] = json!(search_call_limit);
        profile["eventLookbackSec"] = json!(event_lookback);
        profile["eventKinds"] = json!(kinds);
        vec![
            json!({"manifestId":"__scam","callId":self.history_id,"method":"scam.pool_history","params":history,"outputs":[],"optional":true}),
            json!({"manifestId":"__scam","callId":self.profile_id,"method":"scam.token_profile","params":profile,"outputs":[],"optional":true}),
        ]
    }
}

enum Target {
    Ignore,
    Unresolved,
    Subject(Box<Subject>, Support),
}

fn subject(node: &Node, support: &[Support]) -> Target {
    let ActionBody::Amm(action) = &node.action else {
        return if matches!(node.action, ActionBody::Unknown { .. }) {
            Target::Unresolved
        } else {
            Target::Ignore
        };
    };
    let AmmAction::Swap(swap) = action else {
        return Target::Unresolved;
    };
    let AmmVenue::UniswapV2 {
        chain,
        pool,
        factory,
    } = &swap.venue
    else {
        return Target::Unresolved;
    };
    let Some(chain_number) = chain.0.strip_prefix("eip155:") else {
        return Target::Unresolved;
    };
    let Ok(chain_id) = chain_number.parse::<u64>() else {
        return Target::Unresolved;
    };
    let pool = format!("{pool:#x}");
    let factory = format!("{factory:#x}");
    let Some(support) = support.iter().find(|s| {
        s.chain_id == chain_id
            && s.venue == "uniswap_v2"
            && s.factories.iter().any(|f| same_hex(f, &factory))
    }) else {
        return Target::Unresolved;
    };
    let Some(output) = &swap.params.token_out else {
        return Target::Unresolved;
    };
    let address = |key: &TokenKey| match key {
        TokenKey::Erc20 { chain: c, address } if c == chain => Some(format!("{address:#x}")),
        _ => None,
    };
    let Some(token) = address(&output.key) else {
        return Target::Unresolved;
    };
    if support
        .exempt_tokens
        .iter()
        .chain(&support.quote_tokens)
        .any(|t| same_hex(t, &token))
    {
        return Target::Ignore;
    }
    let route = &swap.live_inputs.route.value;
    let quote = if matches!(&swap.params.token_in.key, TokenKey::Native { chain: c } if c == chain)
    {
        // Only the trusted Decoder may supply the pool-side wrapped token.
        // Do not infer it from the first quote token or re-decode calldata here.
        if route.aggregator.is_some()
            || route.paths.len() != 1
            || route.paths[0].share_bp != 10_000
            || route.paths[0].hops.len() != 1
        {
            return Target::Unresolved;
        }
        let hop = &route.paths[0].hops[0];
        if hop.venue != swap.venue || &hop.token_out != output {
            return Target::Unresolved;
        }
        let Some(quote) = address(&hop.token_in.key) else {
            return Target::Unresolved;
        };
        quote
    } else {
        if route.aggregator.is_some()
            || route.paths.len() > 1
            || route.paths.first().is_some_and(|p| {
                p.share_bp != 10_000
                    || p.hops.len() != 1
                    || p.hops[0].venue != swap.venue
                    || p.hops[0].token_in != swap.params.token_in
                    || &p.hops[0].token_out != output
            })
        {
            return Target::Unresolved;
        }
        let Some(quote) = address(&swap.params.token_in.key) else {
            return Target::Unresolved;
        };
        quote
    };
    if !support.quote_tokens.iter().any(|t| same_hex(t, &quote)) || token == quote {
        return Target::Unresolved;
    }
    Target::Subject(
        Box::new(Subject {
            chain_id,
            token,
            pool,
            factory,
            quote_token: quote,
            venue: "uniswap_v2".into(),
            action_paths: vec![if node.path.is_empty() {
                "/".into()
            } else {
                format!(
                    "/{}",
                    node.path
                        .iter()
                        .map(usize::to_string)
                        .collect::<Vec<_>>()
                        .join("/")
                )
            }],
        }),
        support.clone(),
    )
}

fn config_error(message: impl Into<String>) -> SessionError {
    SessionError::new("INVALID_CONFIG", message)
}
fn same_hex(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}
fn is_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2 + 2
        && value.starts_with("0x")
        && value[2..].bytes().all(|c| c.is_ascii_hexdigit())
}
fn decimal(value: &str) -> Option<U256> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    U256::from_str_radix(value, 10).ok()
}
fn hash<T: Serialize>(domain: &str, value: &T) -> Result<String, SessionError> {
    let mut input = serde_json::to_value(value).map_err(|e| config_error(e.to_string()))?;
    input
        .as_object_mut()
        .ok_or_else(|| config_error("hash input must be an object"))?
        .insert("domain".into(), json!(domain));
    let encoded =
        serde_json_canonicalizer::to_vec(&input).map_err(|e| config_error(e.to_string()))?;
    Ok(format!("0x{}", hex::encode(Sha256::digest(encoded))))
}

fn validate_settings(settings: &Settings, limits: &Limits) -> Result<(), SessionError> {
    if settings.preset_id.is_empty()
        || settings.locale.is_empty()
        || settings.overrides.len() as u64 > limits.max_rules
        || settings.additional_rules.len() as u64 > limits.max_rules
    {
        return Err(config_error("invalid scam settings"));
    }
    let mut ids = BTreeSet::new();
    for override_ in &settings.overrides {
        let Some(object) = override_.as_object() else {
            return Err(config_error("rule override must be an object"));
        };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| config_error("rule override needs id"))?;
        if !ids.insert(id)
            || !matches!(
                object.get("kind").and_then(Value::as_str),
                Some("change_count" | "switch_density" | "window_drop" | "event_count")
            )
        {
            return Err(config_error("duplicate or invalid rule override"));
        }
        let kind = object["kind"].as_str().unwrap_or("");
        for (key, value) in object {
            let common = matches!(key.as_str(), "id" | "kind" | "enabled" | "lookbackSec");
            let specific = match kind {
                "change_count" => matches!(
                    key.as_str(),
                    "metric" | "direction" | "changeMode" | "thresholdBps" | "count"
                ),
                "switch_density" => matches!(
                    key.as_str(),
                    "metric" | "windowSec" | "reversalBps" | "switchKind" | "count"
                ),
                "window_drop" => matches!(key.as_str(), "metric" | "windowSec" | "dropBps"),
                "event_count" => matches!(key.as_str(), "eventKinds" | "count"),
                _ => false,
            };
            let valid = match key.as_str() {
                "id" | "kind" => value.as_str().is_some_and(|s| !s.is_empty()),
                "enabled" => value.is_boolean(),
                "lookbackSec" | "windowSec" => value.as_u64().is_some_and(|v| v > 0 && v <= 86_400),
                "thresholdBps" | "reversalBps" | "count" => value
                    .as_u64()
                    .is_some_and(|v| v > 0 && v <= MAX_SAFE_INTEGER),
                "dropBps" => value.as_u64().is_some_and(|v| v > 0 && v <= 10_000),
                "metric" => serde_json::from_value::<Metric>(value.clone()).is_ok(),
                "direction" => serde_json::from_value::<Direction>(value.clone()).is_ok(),
                "changeMode" => serde_json::from_value::<ChangeMode>(value.clone()).is_ok(),
                "switchKind" => serde_json::from_value::<SwitchKind>(value.clone()).is_ok(),
                "eventKinds" => serde_json::from_value::<Vec<AdminEventKind>>(value.clone())
                    .is_ok_and(|k| {
                        !k.is_empty()
                            && k.len() <= 5
                            && !k.iter().enumerate().any(|(i, v)| k[..i].contains(v))
                    }),
                _ => false,
            };
            if !(common || specific) || !valid {
                return Err(config_error("invalid rule override field"));
            }
        }
    }
    let mut additional_ids = BTreeSet::new();
    for rule in &settings.additional_rules {
        validate_rule(rule)?;
        if !additional_ids.insert(rule.id()) {
            return Err(config_error("duplicate additional rule id"));
        }
    }
    Ok(())
}

fn validate_rule(rule: &RuleSpec) -> Result<(), SessionError> {
    let positive = |v: u64| v > 0 && v <= MAX_SAFE_INTEGER;
    let invalid = match rule {
        RuleSpec::ChangeCount {
            threshold_bps,
            direction,
            count,
            ..
        } => {
            !positive(*threshold_bps)
                || !positive(*count)
                || (*direction == Direction::Down && *threshold_bps > 10_000)
        }
        RuleSpec::SwitchDensity {
            window_sec,
            reversal_bps,
            count,
            ..
        } => {
            !positive(*window_sec)
                || *window_sec > rule.lookback_sec()
                || !positive(*reversal_bps)
                || !positive(*count)
        }
        RuleSpec::WindowDrop {
            window_sec,
            metric,
            drop_bps,
            ..
        } => {
            !positive(*window_sec)
                || *window_sec > rule.lookback_sec()
                || *metric != Metric::QuoteReserve
                || *drop_bps == 0
                || *drop_bps > 10_000
        }
        RuleSpec::EventCount {
            count, event_kinds, ..
        } => {
            !positive(*count)
                || event_kinds.is_empty()
                || event_kinds.len() > 5
                || event_kinds
                    .iter()
                    .enumerate()
                    .any(|(i, k)| event_kinds[..i].contains(k))
        }
    };
    if invalid || rule.id().is_empty() || rule.lookback_sec() == 0 || rule.lookback_sec() > 86_400 {
        Err(config_error("invalid scam rule parameters"))
    } else {
        Ok(())
    }
}

fn effective_pair(
    bundle: &Bundle,
    settings: &Settings,
    limits: &Limits,
) -> Result<PresetPair, SessionError> {
    let mut pair = bundle
        .presets
        .iter()
        .find(|p| p.id == settings.preset_id)
        .cloned()
        .ok_or_else(|| config_error("unknown scam preset"))?;
    for preset in [&mut pair.new_market, &mut pair.established] {
        for override_ in &settings.overrides {
            let id = override_["id"]
                .as_str()
                .ok_or_else(|| config_error("invalid override id"))?;
            let rule = preset
                .rules
                .iter_mut()
                .find(|r| r.id() == id)
                .ok_or_else(|| config_error("override refers to absent rule"))?;
            let mut value =
                serde_json::to_value(&*rule).map_err(|e| config_error(e.to_string()))?;
            if value["kind"] != override_["kind"] {
                return Err(config_error("override changes rule kind"));
            }
            let object = value
                .as_object_mut()
                .ok_or_else(|| config_error("invalid rule shape"))?;
            for (key, value) in override_
                .as_object()
                .ok_or_else(|| config_error("invalid override"))?
            {
                object.insert(key.clone(), value.clone());
            }
            *rule = serde_json::from_value(value).map_err(|e| config_error(e.to_string()))?;
        }
        preset.rules.extend(settings.additional_rules.clone());
        validate_preset(preset, limits)?;
        preset.rules.retain(RuleSpec::enabled);
    }
    let span = pair
        .new_market
        .rules
        .iter()
        .chain(&pair.established.rules)
        .map(RuleSpec::lookback_sec)
        .max()
        .unwrap_or(0)
        .saturating_add(pair.new_market.warmup_sec.max(pair.established.warmup_sec))
        .saturating_mul(1000);
    for preset in [&pair.new_market, &pair.established] {
        if span / preset.bucket_ms + 2 > limits.max_points {
            return Err(config_error("candidate union exceeds maxPoints"));
        }
        if bundle
            .support
            .iter()
            .any(|support| !support.allowed_bucket_ms.contains(&preset.bucket_ms))
        {
            return Err(config_error("candidate resolution is not supported"));
        }
    }
    Ok(pair)
}

fn validate_preset(preset: &Preset, limits: &Limits) -> Result<(), SessionError> {
    if preset.id.is_empty()
        || preset.bucket_ms == 0
        || preset.bucket_ms > MAX_SAFE_INTEGER
        || preset.grid_origin_ms > MAX_SAFE_INTEGER
        || preset.warmup_sec > MAX_SAFE_INTEGER / 1000
        || preset.max_data_age_sec == 0
        || preset.max_data_age_sec > MAX_SAFE_INTEGER / 1000
        || preset.rules.len() as u64 > limits.max_rules
    {
        return Err(config_error("invalid effective preset"));
    }
    let mut ids = BTreeSet::new();
    for rule in &preset.rules {
        validate_rule(rule)?;
        if !ids.insert(rule.id()) {
            return Err(config_error("duplicate preset rule id"));
        }
    }
    Ok(())
}

fn algorithm_limits(limits: &Limits) -> AlgorithmLimits {
    AlgorithmLimits {
        max_input_bytes: limits.max_result_bytes,
        max_output_bytes: limits.max_result_bytes,
        max_points: limits.max_points,
        max_rules: limits.max_rules,
        max_evidence_events_per_rule: 64,
        max_work_units: limits.max_algorithm_work_units,
    }
}

fn validate_bundle(
    bundle: &Bundle,
    config: &Config,
    builder: &str,
    now: u64,
) -> Result<(), SessionError> {
    let compat = &bundle.compatibility;
    if bundle.kind != "scam_bundle"
        || bundle.schema != "0.1"
        || decimal(&bundle.sequence).is_none()
        || bundle.issued_at_ms > now
        || now >= bundle.expires_at_ms
        || bundle.expires_at_ms > MAX_SAFE_INTEGER
        || bundle.env != config.trust.env
        || bundle.profile != config.trust.profile
        || compat.contract_version != "0.1"
        || builder.is_empty()
        || bundle.model.is_some()
        || !matches!(
            compat.engine_range.as_str(),
            "*" | env!("CARGO_PKG_VERSION")
        )
        || !(compat.builder_range == "*" || compat.builder_range == builder)
        || compat
            .algorithm
            .as_ref()
            .is_some_and(|a| a.id.is_empty() || a.version.is_empty() || a.contract_version != 1)
        || bundle.presets.is_empty()
        || bundle.support.is_empty()
    {
        return Err(config_error("invalid scam bundle"));
    }
    let mut presets = BTreeSet::new();
    for preset in &bundle.presets {
        if preset.id.is_empty()
            || !presets.insert(&preset.id)
            || !matches!(preset.purpose.as_str(), "default" | "demo")
            || preset.selection.age_threshold_sec == 0
            || preset.selection.age_threshold_sec > MAX_SAFE_INTEGER / 1000
            || preset.selection.unknown_age != "new_provisional_insufficient"
        {
            return Err(config_error("invalid scam preset selection"));
        }
        validate_preset(&preset.new_market, &config.limits)?;
        validate_preset(&preset.established, &config.limits)?;
    }
    let mut chains = BTreeSet::new();
    for support in &bundle.support {
        if support.chain_id == 0
            || support.chain_id > MAX_SAFE_INTEGER
            || !chains.insert(support.chain_id)
            || support.venue != "uniswap_v2"
            || support.factories.is_empty()
            || support.quote_tokens.is_empty()
            || support.allowed_bucket_ms.is_empty()
            || support.confirm_depth > MAX_SAFE_INTEGER
            || support
                .factories
                .iter()
                .chain(&support.quote_tokens)
                .chain(&support.exempt_tokens)
                .any(|a| !is_hex(a, 20))
            || support
                .allowed_bucket_ms
                .iter()
                .any(|v| *v == 0 || *v > MAX_SAFE_INTEGER)
        {
            return Err(config_error("invalid scam support scope"));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedBundle {
    payload: String,
    signature: String,
    #[serde(rename = "keyId")]
    _key_id: Option<String>,
}

#[cfg(feature = "scam-test-fixtures")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    bundle: Bundle,
    builder_version: String,
    algorithm: Option<FixtureAlgorithm>,
}

#[cfg(feature = "scam-test-fixtures")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureAlgorithm {
    identity: AlgorithmIdentity,
    requirements: AlgorithmRuleRequirements,
    results: Vec<AlgorithmRuleResult>,
}

#[cfg(feature = "scam-test-fixtures")]
struct FixedModule {
    identity: AlgorithmIdentity,
    requirements: AlgorithmRuleRequirements,
    results: Vec<AlgorithmRuleResult>,
    limits: AlgorithmLimits,
}

#[cfg(feature = "scam-test-fixtures")]
impl AlgorithmModule for FixedModule {
    fn identity(&self) -> AlgorithmIdentity {
        self.identity.clone()
    }
    fn supported_limits(&self) -> AlgorithmLimits {
        self.limits.clone()
    }
    fn work_unit(&self) -> &str {
        "sf3-fixed-result/v1"
    }
    fn analysis_mode(&self) -> AnalysisMode {
        AnalysisMode::Stub
    }
    fn supports(&self, _: &RuleSpec) -> AlgorithmSupport {
        AlgorithmSupport::Supported {
            requirements: self.requirements.clone(),
        }
    }
    fn analyze(
        &self,
        request: &AnalysisRequest,
        _: &AlgorithmLimits,
    ) -> Result<ScamAnalysis, AlgorithmError> {
        Ok(ScamAnalysis {
            algorithm_id: self.identity.id.clone(),
            algorithm_version: self.identity.version.clone(),
            contract_version: self.identity.contract_version,
            analysis_mode: AnalysisMode::Stub,
            binding: AlgorithmBinding {
                chain_id: request.subject.chain_id,
                pool: request.subject.pool.clone(),
                as_of_block: request.as_of.block.clone(),
                as_of_block_hash: request.as_of.block_hash.clone(),
                rules_hash: crate::scam::rules_hash(&request.rules)
                    .map_err(|_| AlgorithmError::InvalidInput)?,
            },
            rules: self.results.clone(),
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    NotConfigured,
    Data { batch: Batch },
    Unavailable { reason: FailureReason },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    plan_id: String,
    results: BTreeMap<String, Fact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fact {
    value: Value,
    source: String,
    observed_at: u64,
    #[serde(default)]
    block_number: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryValue {
    method: String,
    schema: String,
    builder_version: String,
    subject: Subject,
    reference_group_id: String,
    reference: FixedReference,
    #[serde(default, deserialize_with = "deserialize_present_verification")]
    verification: Option<MethodVerification>,
    coverage: DataCoverage,
    histories: Vec<HistoryGrid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryGrid {
    grid_origin_ms: u64,
    history: PoolHistory,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileValue {
    method: String,
    schema: String,
    builder_version: String,
    subject: Subject,
    reference_group_id: String,
    reference: FixedReference,
    #[serde(default, deserialize_with = "deserialize_present_verification")]
    verification: Option<MethodVerification>,
    coverage: DataCoverage,
    age: PoolAge,
    searched_ranges: Vec<DataCoverage>,
    events: Vec<AdminEvent>,
    #[serde(default)]
    activity_start: Option<ActivityStart>,
}

// Omission is the legacy contract; an explicit null is malformed metadata.
fn deserialize_present_verification<'de, D>(
    deserializer: D,
) -> Result<Option<MethodVerification>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    MethodVerification::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PoolAge {
    Exact {
        age_sec: u64,
        evidence: CreatedEvidence,
    },
    LowerBound {
        age_lower_bound_sec: u64,
        evidence: CodeEvidence,
    },
    Unknown {
        reasons: Vec<String>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedEvidence {
    kind: String,
    factory: String,
    created_at: BlockReference,
    transaction_hash: String,
    log_index: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeEvidence {
    kind: String,
    checked_at: BlockReference,
    identity_verified: bool,
    non_recreation_support_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityStart {
    kind: String,
    block: BlockReference,
}

impl Plan {
    pub(super) fn failed(&self, reason: FailureReason) -> Value {
        if let Some(reason) = self.inactive {
            return self.report("disabled", vec![json!(reason)], Vec::new());
        }
        let report = self.report(
            "insufficient",
            vec![json!(reason)],
            self.targets
                .iter()
                .map(|target| target_failure(target, reason))
                .collect(),
        );
        // Do not recursively return the same oversized pinned context when
        // reporting an output budget failure. This compact failure is explicit.
        if serde_json::to_vec(&report).map_or(true, |bytes| {
            bytes.len() as u64 > self.config.limits.max_result_bytes
        }) {
            return json!({"status":"insufficient","reasons":[reason,"resource_limit"],"targets":[],"scopeNotice":NOTICE});
        }
        report
    }

    pub(super) fn evaluate(
        &self,
        plan_id: &str,
        input: Option<&str>,
        now: u64,
        policy_deadline: Option<u64>,
        allowed_skew: u64,
        clock: &mut dyn FnMut() -> u64,
    ) -> Value {
        if let Some(reason) = self.inactive {
            return self.report("disabled", vec![json!(reason)], Vec::new());
        }
        if let Some(reason) = self.reason {
            return self.failed(reason);
        }
        let Some(installed) = &self.installed else {
            return self.failed(FailureReason::BundleUnavailable);
        };
        if now < installed.bundle.issued_at_ms || now >= installed.bundle.expires_at_ms {
            return self.failed(FailureReason::BundleInvalid);
        }
        let Some(pair) = &self.pair else {
            return self.failed(FailureReason::BundleInvalid);
        };
        if self.targets.is_empty() {
            return if self.unresolved {
                self.failed(FailureReason::SubjectUnresolved)
            } else {
                self.report("not_applicable", Vec::new(), Vec::new())
            };
        }
        let Some(module) = installed.module.as_deref() else {
            return self.failed(FailureReason::AlgorithmUnavailable);
        };
        let Some(hard_deadline) = policy_deadline else {
            return self.failed(FailureReason::NoTimeBudget);
        };
        let latest = hard_deadline.saturating_sub(self.config.limits.scam_eval_reserve_ms);
        if now >= latest {
            return self.failed(FailureReason::NoTimeBudget);
        }
        // Conservative whole-plan anchor prevents the native call from resetting
        // the host's already-spent fetch budget. A manually delayed evaluate has
        // only the original plan's remaining allowance, never a fresh timeout.
        let timeout_at = self
            .started_at
            .saturating_add(self.config.limits.scam_timeout_ms)
            .min(MAX_SAFE_INTEGER);
        if now >= timeout_at {
            return self.failed(FailureReason::Timeout);
        }
        let deadline = latest.min(timeout_at).min(installed.bundle.expires_at_ms);
        let batch = match self.parse_input(input, plan_id) {
            Ok(batch) => batch,
            Err(reason) => return self.failed(reason),
        };
        let mut results = Vec::new();
        for target in &self.targets {
            let result = self.analyze_target(
                plan_id,
                target,
                pair,
                installed,
                module,
                &batch,
                now,
                allowed_skew,
                deadline,
                clock,
            );
            results.push(match result {
                Ok(report) => report,
                Err(reason) => target_failure(target, reason),
            });
        }
        let warn = results.iter().any(|r| r["status"] == "warn");
        let incomplete = self.unresolved || results.iter().any(|r| r["status"] == "insufficient");
        let quiet = results.iter().any(|r| r["status"] == "quiet");
        let status = if warn {
            "warn"
        } else if incomplete {
            "insufficient"
        } else if quiet {
            "quiet"
        } else {
            "not_applicable"
        };
        let mut reasons = Vec::new();
        if self.unresolved {
            reasons.push(json!(FailureReason::SubjectUnresolved));
        }
        for report in &results {
            if let Some(items) = report["reasons"].as_array() {
                for reason in items {
                    if !reasons.contains(reason) {
                        reasons.push(reason.clone());
                    }
                }
            }
        }
        let result = self.report(status, reasons, results);
        if serde_json::to_vec(&result).map_or(true, |bytes| {
            bytes.len() as u64 > self.config.limits.max_result_bytes
        }) {
            return self.failed(FailureReason::ResourceLimit);
        }
        result
    }

    fn report(&self, status: &str, reasons: Vec<Value>, targets: Vec<Value>) -> Value {
        let mut report =
            json!({"status":status,"reasons":reasons,"targets":targets,"scopeNotice":NOTICE});
        if let Some(context) = &self.context {
            report["pinned"] = context.clone();
        }
        report
    }

    fn parse_input(&self, input: Option<&str>, plan_id: &str) -> Result<Batch, FailureReason> {
        let input = input.ok_or(FailureReason::ScamResultsMissing)?;
        if input.len() as u64 > self.config.limits.max_result_bytes.saturating_add(512) {
            return Err(FailureReason::ResourceLimit);
        }
        let value = crate::bundle::strict_json::parse(input)
            .map_err(|_| FailureReason::InvalidScamInput)?;
        // Option fields must not convert explicit null into an absent observation.
        if value
            .pointer("/batch/results")
            .and_then(Value::as_object)
            .is_some_and(|results| {
                results
                    .values()
                    .any(|f| f.get("blockNumber").is_some_and(Value::is_null))
            })
        {
            return Err(FailureReason::InvalidScamInput);
        }
        let input: Input =
            serde_json::from_value(value).map_err(|_| FailureReason::InvalidScamInput)?;
        let batch = match input {
            Input::Data { batch } => batch,
            Input::NotConfigured => return Err(FailureReason::ScamResultsMissing),
            Input::Unavailable { reason } => return Err(reason),
        };
        if batch.plan_id != plan_id {
            return Err(FailureReason::InvalidScamInput);
        }
        let known: BTreeSet<_> = self
            .targets
            .iter()
            .flat_map(|t| [t.history_id.as_str(), t.profile_id.as_str()])
            .collect();
        if batch
            .results
            .keys()
            .any(|key| !known.contains(key.as_str()))
        {
            return Err(FailureReason::InvalidScamInput);
        }
        Ok(batch)
    }

    #[allow(clippy::too_many_arguments)]
    fn analyze_target(
        &self,
        plan_id: &str,
        target: &PinnedTarget,
        pair: &PresetPair,
        installed: &Installed,
        module: &dyn AlgorithmModule,
        batch: &Batch,
        now: u64,
        skew: u64,
        deadline: u64,
        clock: &mut dyn FnMut() -> u64,
    ) -> Result<Value, FailureReason> {
        let history_fact = batch
            .results
            .get(&target.history_id)
            .ok_or(FailureReason::ScamResultsMissing)?;
        let profile_fact = batch
            .results
            .get(&target.profile_id)
            .ok_or(FailureReason::ScamResultsMissing)?;
        let h: HistoryValue = serde_json::from_value(history_fact.value.clone())
            .map_err(|_| FailureReason::InvalidScamInput)?;
        let p: ProfileValue = serde_json::from_value(profile_fact.value.clone())
            .map_err(|_| FailureReason::InvalidScamInput)?;
        if h.method != "scam.pool_history"
            || h.schema != "scam.pool_history/1"
            || p.method != "scam.token_profile"
            || p.schema != "scam.token_profile/1"
            || h.builder_version != installed.builder_version
            || p.builder_version != installed.builder_version
        {
            return Err(FailureReason::InvalidScamInput);
        }
        if !same_subject(&h.subject, &target.subject) || !same_subject(&p.subject, &target.subject)
        {
            return Err(FailureReason::SubjectMismatch);
        }
        if h.reference_group_id != target.group
            || p.reference_group_id != target.group
            || h.reference != p.reference
        {
            return Err(FailureReason::ReferenceMismatch);
        }
        validate_reference(&h.reference, target.support.confirm_depth, now, skew)?;
        let verification = bind_verification(
            &h.verification,
            &p.verification,
            history_fact.observed_at,
            profile_fact.observed_at,
            now,
            skew,
        )?;
        let AgeSelection {
            preset: selected,
            reason: selection_reason,
            created_at_ms: created,
            age_lower_bound_ms: lower_bound,
        } = select_age(&p.age, pair, target, &h.reference)?;
        let preset = if selected == "established" {
            &pair.established
        } else {
            &pair.new_market
        };
        if preset.rules.is_empty() {
            return Ok(
                json!({"subject":target.subject,"status":"not_applicable","reasons":["no_active_rules"],"age":p.age,"rules":[]}),
            );
        }
        let max_age = preset.max_data_age_sec * 1000;
        validate_fact(history_fact, &h.reference, now, skew, max_age)?;
        validate_fact(profile_fact, &p.reference, now, skew, max_age)?;
        if now.saturating_sub(h.reference.block.timestamp_ms) > max_age {
            return Err(FailureReason::StaleData);
        }
        let end = h.reference.block.timestamp_ms;
        let union_lookback = pair
            .new_market
            .rules
            .iter()
            .chain(&pair.established.rules)
            .map(RuleSpec::lookback_sec)
            .max()
            .unwrap_or(0);
        let union_warmup = pair.new_market.warmup_sec.max(pair.established.warmup_sec);
        let union_start = end.saturating_sub(
            union_lookback
                .saturating_add(union_warmup)
                .saturating_mul(1000),
        );
        validate_coverage(
            &h.coverage,
            &h.reference,
            union_start,
            self.config.limits.max_points,
        )?;
        let union_events = pair
            .new_market
            .rules
            .iter()
            .chain(&pair.established.rules)
            .filter(|r| matches!(r, RuleSpec::EventCount { .. }))
            .map(RuleSpec::lookback_sec)
            .max()
            .unwrap_or(0);
        validate_coverage(
            &p.coverage,
            &p.reference,
            end.saturating_sub(union_events * 1000),
            self.config.limits.max_points,
        )?;
        if p.events.len() as u64 > self.config.limits.max_points
            || p.searched_ranges.len() as u64 > self.config.limits.max_calls
        {
            return Err(FailureReason::ResourceLimit);
        }
        for range in &p.searched_ranges {
            if range.to_ms > end {
                return Err(FailureReason::InvalidScamInput);
            }
            let mut bounded = p.reference.clone();
            bounded.block.timestamp_ms = range.to_ms;
            validate_coverage(
                range,
                &bounded,
                range.from_ms,
                self.config.limits.max_points,
            )?;
        }
        if let Some(activity) = &p.activity_start {
            if activity.kind != "verified_first_mint"
                || !valid_block(&activity.block)
                || decimal(&activity.block.number) > decimal(&p.reference.block.number)
                || activity.block.timestamp_ms > end
            {
                return Err(FailureReason::InvalidScamInput);
            }
        }
        let mut grids = BTreeSet::new();
        if h.histories.len() > 2 {
            return Err(FailureReason::InvalidScamInput);
        }
        for grid in &h.histories {
            let history = &grid.history;
            if !grids.insert((history.bucket_ms, grid.grid_origin_ms))
                || ![&pair.new_market, &pair.established].iter().any(|c| {
                    c.bucket_ms == history.bucket_ms && c.grid_origin_ms == grid.grid_origin_ms
                })
                || history.from_ms != union_start
                || history.warmup.from_ms != union_start
                || history.schema != "scam.pool_history/1"
                || history.builder_version != installed.builder_version
                || history.points.len() as u64 > self.config.limits.max_points
                || history.missing.len() as u64 > self.config.limits.max_points
                || history
                    .points
                    .iter()
                    .any(|point| point.t_ms < union_start || point.t_ms > end)
                || history.missing.iter().any(|gap| {
                    gap.from_ms < union_start || gap.from_ms >= gap.to_ms || gap.to_ms > end
                })
            {
                return Err(FailureReason::InvalidScamInput);
            }
        }
        if [&pair.new_market, &pair.established]
            .iter()
            .any(|c| !grids.contains(&(c.bucket_ms, c.grid_origin_ms)))
        {
            return Err(FailureReason::DataMissing);
        }
        let grid = h
            .histories
            .iter()
            .find(|g| {
                g.history.bucket_ms == preset.bucket_ms && g.grid_origin_ms == preset.grid_origin_ms
            })
            .ok_or(FailureReason::DataMissing)?;
        let from = end.saturating_sub(
            preset
                .rules
                .iter()
                .map(RuleSpec::lookback_sec)
                .max()
                .unwrap_or(0)
                .saturating_add(preset.warmup_sec)
                .saturating_mul(1000),
        );
        let mut history = grid.history.clone();
        history.from_ms = from;
        history.warmup.from_ms = from;
        // This is a data-availability flag, not a cached direction/zigzag state.
        // Never promote false to true. SF2 checks selected warm-up gaps/invalid
        // points and requires the module's freshly computed warmupComplete too.
        history.points.retain(|point| point.t_ms >= from);
        history.missing = clip_intervals(&history.missing, from, end);
        let profile_from = end.saturating_sub(
            preset
                .rules
                .iter()
                .filter(|r| matches!(r, RuleSpec::EventCount { .. }))
                .map(RuleSpec::lookback_sec)
                .max()
                .unwrap_or(0)
                * 1000,
        );
        let events = p
            .events
            .iter()
            .filter(|e| e.t_ms > profile_from && e.t_ms <= end)
            .cloned()
            .collect();
        // Events outside source coverage are malformed, not silently filtered.
        if p.events
            .iter()
            .any(|e| e.t_ms <= p.coverage.from_ms || e.t_ms > end)
            || p.events.windows(2).any(|w| w[0].t_ms > w[1].t_ms)
        {
            return Err(FailureReason::InvalidScamInput);
        }
        let profile_missing = clip_intervals(
            &p.coverage
                .missing
                .iter()
                .map(|gap| SnapshotInterval {
                    from_ms: gap.from_ms,
                    to_ms: gap.to_ms,
                })
                .collect::<Vec<_>>(),
            profile_from,
            end,
        );
        let request = AnalysisRequest {
            subject: AlgorithmSubject {
                chain_id: target.subject.chain_id,
                pool: target.subject.pool.clone(),
                token: target.subject.token.clone(),
                quote: target.subject.quote_token.clone(),
                venue: "uniswap_v2".into(),
            },
            as_of: AlgorithmReference {
                block: h.reference.block.number.clone(),
                block_hash: h.reference.block.hash.clone(),
                t_ms: end,
            },
            rules: preset.rules.clone(),
            pool_history: history,
            token_profile: TokenProfile {
                schema: "scam.token_profile/1".into(),
                pool_created_ms: created,
                age_lower_bound_ms: lower_bound,
                admin_events: events,
                missing: profile_missing,
            },
        };
        let context = self.context.as_ref().ok_or(FailureReason::BundleInvalid)?;
        let binding = AnalysisBinding {
            plan_id: plan_id.into(),
            subject: target.subject.clone(),
            reference: h.reference,
            verification,
            settings_hash: context["settingsHash"]
                .as_str()
                .ok_or(FailureReason::BundleInvalid)?
                .into(),
            settings_hash_scheme: "sha256-jcs-scam-v1".into(),
            bundle_sequence: installed.bundle.sequence.clone(),
            selected_preset: selected.into(),
            selection_reason: selection_reason.into(),
            effective_settings_hash: hash("dambi.scam.preset/1", &json!({"preset":preset}))
                .map_err(|_| FailureReason::BundleInvalid)?,
            algorithm: module.identity(),
            builder_version: installed.builder_version.clone(),
            from_ms: from,
            to_ms: end,
            bucket_ms: preset.bucket_ms,
            grid_origin_ms: preset.grid_origin_ms,
            warmup_sec: preset.warmup_sec,
        };
        let invocation = PinnedInvocation {
            binding,
            rules: preset.rules.clone(),
            history_coverage: h.coverage,
            profile_coverage: p.coverage,
        };
        let encoded =
            serde_json::to_string(&request).map_err(|_| FailureReason::InvalidScamInput)?;
        #[cfg(feature = "scam-test-fixtures")]
        let adapter = AlgorithmAdapter::with_test_stub(module);
        #[cfg(not(feature = "scam-test-fixtures"))]
        let adapter = AlgorithmAdapter::new(Some(module));
        let analysis = adapter.evaluate(
            &invocation,
            Some(&encoded),
            &algorithm_limits(&self.config.limits),
            deadline,
            clock,
        )?;
        let fired = analysis.rules.iter().any(|r| r.state == RuleState::Fired);
        let age_unknown = selection_reason == "age_unknown";
        // Clear rules do not establish sufficient market age. Only a verified
        // mature selection can claim quiet; observed warnings still take priority.
        let complete =
            selected == "established" && analysis.rules.iter().all(|r| r.state == RuleState::Clear);
        let mut reasons = Vec::new();
        if age_unknown {
            reasons.push(json!(FailureReason::AgeUnknown));
        }
        if selection_reason == "exact_young" {
            reasons.push(json!(FailureReason::MarketTooYoung));
        }
        for rule in &analysis.rules {
            for reason in &rule.reasons {
                let value = json!(reason);
                if !reasons.contains(&value) {
                    reasons.push(value);
                }
            }
        }
        Ok(
            json!({"subject":target.subject,"status":if fired {"warn"} else if complete {"quiet"} else {"insufficient"},
            "reasons":reasons,"age":p.age,"rules":analysis.rules,"binding":analysis.binding,"analysisMode":analysis.analysis.analysis_mode}),
        )
    }
}

fn target_failure(target: &PinnedTarget, reason: FailureReason) -> Value {
    json!({"subject":target.subject,"status":"insufficient","reasons":[reason],"rules":[]})
}

pub(super) fn compose(mut policy: Value, scam: Option<Value>) -> Value {
    if let Some(scam) = scam {
        if scam["status"] == "warn" {
            if policy["decision"] == "allow" {
                policy["decision"] = json!("warn");
            }
            if let Some(reasons) = policy["reasons"].as_array_mut() {
                reasons.push(
                    json!({"policyId":"__scam::risk","reason":"scam risk pattern observed",
                    "severity":"warn","origin":"scam"}),
                );
            }
        }
        policy["scam"] = scam;
    }
    policy
}

fn same_subject(a: &Subject, b: &Subject) -> bool {
    a.chain_id == b.chain_id
        && a.venue == b.venue
        && a.action_paths == b.action_paths
        && same_hex(&a.token, &b.token)
        && same_hex(&a.pool, &b.pool)
        && same_hex(&a.factory, &b.factory)
        && same_hex(&a.quote_token, &b.quote_token)
}

fn valid_block(block: &BlockReference) -> bool {
    decimal(&block.number).is_some()
        && is_hex(&block.hash, 32)
        && block.timestamp_ms <= MAX_SAFE_INTEGER
}

fn validate_reference(
    reference: &FixedReference,
    depth: u64,
    now: u64,
    skew: u64,
) -> Result<(), FailureReason> {
    let block = &reference.block;
    let head = &reference.checked_head;
    if !valid_block(block)
        || !valid_block(head)
        || reference.required_confirm_depth != depth
        || reference.observed_confirm_depth > MAX_SAFE_INTEGER
        || reference.observed_confirm_depth < depth
        || head.timestamp_ms < block.timestamp_ms
        || head.timestamp_ms > now.saturating_add(skew)
        || (head.number == block.number
            && (!same_hex(&head.hash, &block.hash) || head.timestamp_ms != block.timestamp_ms))
        || decimal(&head.number).and_then(|h| decimal(&block.number).and_then(|b| h.checked_sub(b)))
            != Some(U256::from(reference.observed_confirm_depth))
    {
        return Err(FailureReason::ReferenceMismatch);
    }
    Ok(())
}

fn validate_fact(
    fact: &Fact,
    reference: &FixedReference,
    now: u64,
    skew: u64,
    max_age: u64,
) -> Result<(), FailureReason> {
    if fact.source.trim().is_empty()
        || fact.observed_at > MAX_SAFE_INTEGER
        || fact.observed_at > now.saturating_add(skew)
        || fact.observed_at < reference.block.timestamp_ms
        || fact
            .block_number
            .as_ref()
            .is_some_and(|block| block != &reference.block.number)
    {
        return Err(FailureReason::InvalidScamInput);
    }
    if now.saturating_sub(fact.observed_at) > max_age {
        return Err(FailureReason::StaleData);
    }
    Ok(())
}

fn bind_verification(
    history: &Option<MethodVerification>,
    profile: &Option<MethodVerification>,
    history_observed_at: u64,
    profile_observed_at: u64,
    now: u64,
    skew: u64,
) -> Result<AnalysisVerification, FailureReason> {
    let result = match (history, profile) {
        (None, None) => AnalysisVerification::LegacyUnspecified,
        (Some(history), Some(profile)) => {
            for (verification, observed_at) in [
                (history, history_observed_at),
                (profile, profile_observed_at),
            ] {
                if observed_at > MAX_SAFE_INTEGER
                    || verification.verified_at < observed_at
                    || verification.verified_at > now.saturating_add(skew)
                    || (verification.reuse == VerificationReuse::None
                        && verification.raw_observed_at.from_ms < observed_at)
                {
                    return Err(FailureReason::InvalidScamInput);
                }
            }
            AnalysisVerification::Declared {
                pool_history: history.clone(),
                token_profile: profile.clone(),
            }
        }
        _ => return Err(FailureReason::InvalidScamInput),
    };
    result.validate()?;
    Ok(result)
}

fn validate_coverage(
    coverage: &DataCoverage,
    reference: &FixedReference,
    required_from: u64,
    max: u64,
) -> Result<(), FailureReason> {
    if coverage.from_ms > required_from
        || coverage.to_ms != reference.block.timestamp_ms
        || coverage.from_ms > coverage.to_ms
        || decimal(&coverage.from_block).is_none()
        || decimal(&coverage.from_block) > decimal(&reference.block.number)
        || coverage.missing.len() as u64 > max
        || coverage.unavailable.len() as u64 > max
    {
        return Err(FailureReason::InvalidScamInput);
    }
    let mut previous = coverage.from_ms;
    for gap in &coverage.missing {
        if gap.from_ms < previous
            || gap.from_ms >= gap.to_ms
            || gap.to_ms > coverage.to_ms
            || !matches!(
                gap.reason.as_str(),
                "rpc_error" | "timeout" | "reorg" | "unavailable_history"
            )
        {
            return Err(FailureReason::InvalidScamInput);
        }
        previous = gap.to_ms;
    }
    if coverage
        .unavailable
        .iter()
        .any(|f| f.field.trim().is_empty() || f.reason.trim().is_empty())
    {
        return Err(FailureReason::InvalidScamInput);
    }
    Ok(())
}

struct AgeSelection {
    preset: &'static str,
    reason: &'static str,
    created_at_ms: Option<u64>,
    age_lower_bound_ms: Option<u64>,
}

fn select_age(
    age: &PoolAge,
    pair: &PresetPair,
    target: &PinnedTarget,
    reference: &FixedReference,
) -> Result<AgeSelection, FailureReason> {
    let end = reference.block.timestamp_ms;
    let threshold = pair.selection.age_threshold_sec;
    match age {
        PoolAge::Exact { age_sec, evidence } => {
            let created = &evidence.created_at;
            if evidence.kind != "factory_pair_created"
                || !same_hex(&evidence.factory, &target.subject.factory)
                || !valid_block(created)
                || created.timestamp_ms > end
                || decimal(&created.number) > decimal(&reference.block.number)
                || !is_hex(&evidence.transaction_hash, 32)
                || evidence.log_index > MAX_SAFE_INTEGER
                || *age_sec != (end - created.timestamp_ms) / 1000
            {
                return Err(FailureReason::InvalidScamInput);
            }
            if *age_sec >= threshold {
                Ok(AgeSelection {
                    preset: "established",
                    reason: "exact_mature",
                    created_at_ms: Some(created.timestamp_ms),
                    age_lower_bound_ms: None,
                })
            } else {
                Ok(AgeSelection {
                    preset: "newMarket",
                    reason: "exact_young",
                    created_at_ms: Some(created.timestamp_ms),
                    age_lower_bound_ms: None,
                })
            }
        }
        PoolAge::LowerBound {
            age_lower_bound_sec,
            evidence,
        } => {
            let checked = &evidence.checked_at;
            if evidence.kind != "historical_code_presence"
                || !evidence.identity_verified
                || evidence.non_recreation_support_id.trim().is_empty()
                || !valid_block(checked)
                || checked.timestamp_ms > end
                || decimal(&checked.number) > decimal(&reference.block.number)
                || *age_lower_bound_sec != (end - checked.timestamp_ms) / 1000
            {
                return Err(FailureReason::InvalidScamInput);
            }
            let lower = Some(end - checked.timestamp_ms);
            if *age_lower_bound_sec >= threshold {
                Ok(AgeSelection {
                    preset: "established",
                    reason: "lower_bound_mature",
                    created_at_ms: None,
                    age_lower_bound_ms: lower,
                })
            } else {
                Ok(AgeSelection {
                    preset: "newMarket",
                    reason: "age_unknown",
                    created_at_ms: None,
                    age_lower_bound_ms: lower,
                })
            }
        }
        PoolAge::Unknown { reasons } => {
            if reasons.is_empty() || reasons.iter().any(|r| r.trim().is_empty()) {
                return Err(FailureReason::InvalidScamInput);
            }
            Ok(AgeSelection {
                preset: "newMarket",
                reason: "age_unknown",
                created_at_ms: None,
                age_lower_bound_ms: None,
            })
        }
    }
}

fn clip_intervals(gaps: &[SnapshotInterval], from: u64, to: u64) -> Vec<SnapshotInterval> {
    gaps.iter()
        .filter_map(|g| {
            let start = g.from_ms.max(from);
            let end = g.to_ms.min(to);
            (start < end).then_some(SnapshotInterval {
                from_ms: start,
                to_ms: end,
            })
        })
        .collect()
}

/// Hints can only shorten the wait. Actual policy validation still occurs once,
/// after the algorithm, using the new clock reading in the original validator.
pub(super) fn policy_fact_deadline(input: &str, max_bytes: u64, max_age: u64) -> Option<u64> {
    if input.len() as u64 > max_bytes {
        return None;
    }
    let value = crate::bundle::strict_json::parse(input).ok()?;
    let results = value.get("results")?.as_object()?;
    let mut deadline = MAX_SAFE_INTEGER;
    for result in results.values() {
        let observed = result
            .get("observedAt")?
            .as_u64()
            .filter(|v| *v <= MAX_SAFE_INTEGER)?;
        deadline = deadline.min(observed.saturating_add(max_age).min(MAX_SAFE_INTEGER));
    }
    Some(deadline)
}

#[cfg(test)]
mod verification_tests {
    use super::*;

    fn metadata() -> MethodVerification {
        MethodVerification {
            version: 1,
            history: HistoryVerification::AllEventHeaders,
            state_binding: StateBinding::NumberRecheck,
            time_sources: vec![VerificationTimeSource::Header],
            reuse: VerificationReuse::None,
            raw_observed_at: RawObservedAt {
                from_ms: 100,
                to_ms: 110,
            },
            verified_at: 140,
        }
    }

    fn values() -> (Value, Value) {
        let common = json!({
            "builderVersion":"test/1", "referenceGroupId":"group", "subject":{
                "chainId":1,"token":"token","pool":"pool","factory":"factory",
                "quoteToken":"quote","venue":"uniswap_v2","actionPaths":[]
            },
            "reference":{
                "block":{"number":"1","hash":"hash","timestampMs":90},
                "checkedHead":{"number":"3","hash":"head","timestampMs":92},
                "requiredConfirmDepth":2,"observedConfirmDepth":2
            },
            "coverage":{"fromBlock":"0","fromMs":0,"toMs":90,"missing":[],"unavailable":[]}
        });
        let mut history = common.clone();
        history["method"] = json!("scam.pool_history");
        history["schema"] = json!("scam.pool_history/1");
        history["histories"] = json!([]);
        let mut profile = common;
        profile["method"] = json!("scam.token_profile");
        profile["schema"] = json!("scam.token_profile/1");
        profile["age"] = json!({"kind":"unknown","reasons":["fixture"]});
        profile["searchedRanges"] = json!([]);
        profile["events"] = json!([]);
        (history, profile)
    }

    #[test]
    fn verification_wrappers_accept_omission_but_reject_null_and_malformed_metadata() {
        let (history, profile) = values();
        assert!(serde_json::from_value::<HistoryValue>(history.clone())
            .unwrap()
            .verification
            .is_none());
        assert!(serde_json::from_value::<ProfileValue>(profile.clone())
            .unwrap()
            .verification
            .is_none());
        let valid = serde_json::to_value(metadata()).unwrap();
        let mut unknown = valid.clone();
        unknown["trustMe"] = json!(true);
        let mut unknown_nested = valid.clone();
        unknown_nested["rawObservedAt"]["extra"] = json!(0);
        let mut wrong_version = valid.clone();
        wrong_version["version"] = json!(2);
        let mut wrong_mode = valid.clone();
        wrong_mode["history"] = json!("unverified");
        for malformed in [
            Value::Null,
            json!({"version":1}),
            unknown,
            unknown_nested,
            wrong_version,
            wrong_mode,
        ] {
            let mut h = history.clone();
            h["verification"] = malformed.clone();
            let mut p = profile.clone();
            p["verification"] = malformed;
            assert!(serde_json::from_value::<HistoryValue>(h).is_err());
            assert!(serde_json::from_value::<ProfileValue>(p).is_err());
        }
        let mut h = history;
        h["verification"] = valid.clone();
        let mut p = profile;
        p["verification"] = valid;
        assert_eq!(
            serde_json::from_value::<HistoryValue>(h)
                .unwrap()
                .verification,
            Some(metadata())
        );
        assert_eq!(
            serde_json::from_value::<ProfileValue>(p)
                .unwrap()
                .verification,
            Some(metadata())
        );
    }

    #[test]
    fn verification_binding_checks_presence_shared_modes_and_observation_times() {
        assert_eq!(
            bind_verification(&None, &None, 100, 100, 150, 0),
            Ok(AnalysisVerification::LegacyUnspecified)
        );
        let declared = Some(metadata());
        assert_eq!(
            bind_verification(&declared, &None, 100, 100, 150, 0),
            Err(FailureReason::InvalidScamInput)
        );
        assert_eq!(
            bind_verification(&None, &declared, 100, 100, 150, 0),
            Err(FailureReason::InvalidScamInput)
        );
        let mut cached = metadata();
        cached.reuse = VerificationReuse::IntervalCache;
        cached.raw_observed_at.from_ms = 80;
        cached.time_sources.push(VerificationTimeSource::RpcLog);
        cached.verified_at = 145;
        assert!(
            bind_verification(&declared, &Some(cached), 100, 100, 150, 0).is_ok(),
            "Method-specific reuse, source and observation times need not match"
        );
        type VerificationMutation = (&'static str, fn(&mut MethodVerification));
        let cases: [VerificationMutation; 5] = [
            ("mode mismatch", |v| {
                v.history = HistoryVerification::RpcAnchor
            }),
            ("binding mismatch", |v| {
                v.state_binding = StateBinding::BlockHashCanonical
            }),
            ("future verification", |v| v.verified_at = 153),
            ("verification before fact", |v| {
                v.raw_observed_at.from_ms = 80;
                v.raw_observed_at.to_ms = 90;
                v.verified_at = 99;
            }),
            ("fresh data predates fetch", |v| {
                v.raw_observed_at.from_ms = 99
            }),
        ];
        for (label, mutate) in cases {
            let mut other = metadata();
            mutate(&mut other);
            assert_eq!(
                bind_verification(&declared, &Some(other), 100, 100, 150, 2),
                Err(FailureReason::InvalidScamInput),
                "{label}"
            );
        }
    }
}
