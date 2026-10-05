//! Stateful native implementation of the public Core plan/evaluate contract.
//!
//! The session owns immutable decoded plans and their snapshots. The host only
//! returns raw Fact responses; it cannot replace requests, actions or policies.
//! Network orchestration and JavaScript object-identity checks belong to the
//! thin SDK host. All trust, time and Fact checks below are authoritative.

mod config;
mod facts;
mod request;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use policy_engine::policy::{Severity, Verdict};
use policy_engine::policy_rpc::{evaluate_trigger, scope_matches_position, TxView};
use policy_transition::action::{ActionBody, ActionMeta};
use serde::Serialize;
use serde_json::{json, Value};

use crate::runtime::{
    self,
    dto::{BundleInput, EvaluateActionInput, PlanActionInput, PlannedCallDto, TxInput},
};
use crate::snapshot::{DecoderInput, RefreshTicket, Snapshot, SnapshotError, SnapshotStore};

use config::{Config, Limits, Policy};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// Bound action-tree amplification independently of byte and RPC call limits.
const MAX_ACTION_NODES: usize = 256;
static NEXT_SESSION: AtomicUsize = AtomicUsize::new(1);
static NEXT_REFRESH: AtomicUsize = AtomicUsize::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct SessionError {
    pub code: String,
    pub message: String,
}

impl SessionError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SessionError {}

impl From<SnapshotError> for SessionError {
    fn from(error: SnapshotError) -> Self {
        Self::new(error.code(), error.message)
    }
}

pub struct CoreSession {
    store: SnapshotStore,
    limits: Limits,
    enforcement: String,
    owner: usize,
    next_plan: u64,
    refresh: Option<(u64, RefreshTicket)>,
    plans: BTreeMap<String, PendingPlan>,
    // Bounded tombstones retain useful immediate reuse/expiry errors without
    // retaining request/snapshot data or accumulating an unbounded history.
    retired: VecDeque<(String, &'static str)>,
}

struct PendingPlan {
    _request: Value,
    digest: String,
    snapshot: Arc<Snapshot>,
    expires_at: u64,
    nodes: Vec<Node>,
    partial: bool,
}

struct Node {
    path: Vec<usize>,
    action: ActionBody,
    meta: ActionMeta,
    tx: TxInput,
    calls: Vec<Call>,
    planning_error: Option<SessionError>,
    matched: bool,
}

struct Call {
    id: String,
    runtime: PlannedCallDto,
}

impl CoreSession {
    pub fn new(config_json: &str, policy_json: &str, now_ms: u64) -> Result<Self, SessionError> {
        clock(now_ms)?;
        let config = Config::parse(config_json)?;
        let policy = Policy::parse(policy_json, config.limits.max_policy_bytes)?;
        let store = SnapshotStore::new(
            config.store_config()?,
            DecoderInput::Pinned {
                artifact: config.decoder_snapshot.artifact.as_bytes(),
                expected_digest: &config.decoder_snapshot.expected_digest,
            },
            policy.input(),
            now_ms,
        )?;
        let owner = NEXT_SESSION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| {
                SessionError::new("LIMIT_EXCEEDED", "session identifier space exhausted")
            })?;
        Ok(Self {
            store,
            limits: config.limits,
            enforcement: config.enforcement,
            owner,
            next_plan: 0,
            refresh: None,
            plans: BTreeMap::new(),
            retired: VecDeque::new(),
        })
    }

    pub fn plan(&mut self, request_json: &str, now_ms: u64) -> Result<Value, SessionError> {
        self.live()?;
        clock(now_ms)?;
        self.evict_expired(now_ms);
        if self.plans.len() as u64 >= self.limits.max_pending_plans {
            return Err(SessionError::new(
                "LIMIT_EXCEEDED",
                "maxPendingPlans reached; consume a plan or wait for expiry",
            ));
        }
        let snapshot = self.store.current(now_ms)?;
        let request = request::decode(
            request_json,
            &snapshot,
            now_ms,
            self.limits.max_request_bytes,
        )?;
        let expires_at = now_ms
            .checked_add(self.limits.plan_ttl_ms)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                SessionError::new("INVALID_CONFIG", "plan expiry exceeds safe integer time")
            })?;
        let number = self
            .next_plan
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                SessionError::new("LIMIT_EXCEEDED", "plan identifier space exhausted")
            })?;
        let plan_id = format!("p{}-{number}", self.owner);
        let mut nodes = Vec::new();
        let mut calls = Vec::new();
        let roots = request.actions.len();
        for (index, action) in request.actions.iter().enumerate() {
            let path = if roots == 1 { Vec::new() } else { vec![index] };
            append_node(
                &action.body,
                &action.meta,
                path,
                &request,
                &snapshot,
                &plan_id,
                &mut nodes,
                &mut calls,
                self.limits.max_plan_calls,
            )?;
        }
        // A standalone lower/plan failure rejects plan(). In a decoded tree,
        // retain node failures so evaluate can preserve healthy sibling denies.
        if nodes.len() == 1 {
            if let Some(error) = &nodes[0].planning_error {
                return Err(error.clone());
            }
        }
        let metadata = plan_metadata(&request.digest, &snapshot);
        self.plans.insert(
            plan_id.clone(),
            PendingPlan {
                _request: request.original,
                digest: request.digest,
                snapshot,
                expires_at,
                nodes,
                partial: request.partial,
            },
        );
        self.next_plan = number;
        Ok(
            json!({ "planId": plan_id, "calls": calls, "expiresAt": expires_at, "metadata": metadata }),
        )
    }

    pub fn evaluate(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        now_ms: u64,
    ) -> Result<Value, SessionError> {
        self.evaluate_inner(plan_id, facts_json, now_ms, None)
    }

    /// SDK check orchestration can report a failed external operation, but it
    /// cannot weaken evaluation or replace the plan's pinned audit metadata.
    pub fn evaluate_check(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        now_ms: u64,
        failure: &str,
    ) -> Result<Value, SessionError> {
        if !matches!(
            failure,
            "" | "aborted"
                | "timeout"
                | "fact_fetch_failed"
                | "invalid_fact"
                | "limit_exceeded"
                | "engine_error"
        ) {
            return Err(SessionError::new(
                "ENGINE_ERROR",
                "invalid check failure category",
            ));
        }
        self.evaluate_inner(plan_id, facts_json, now_ms, Some(failure))
    }

    fn evaluate_inner(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        now_ms: u64,
        check_failure: Option<&str>,
    ) -> Result<Value, SessionError> {
        self.live()?;
        clock(now_ms)?;
        let Some(plan) = self.plans.remove(plan_id) else {
            let code = self
                .retired
                .iter()
                .rev()
                .find(|(id, _)| id == plan_id)
                .map_or("INVALID_PLAN", |(_, code)| *code);
            return Err(SessionError::new(
                code,
                "plan is foreign, unknown or no longer usable",
            ));
        };
        if now_ms >= plan.expires_at {
            self.retire(plan_id.to_owned(), "PLAN_EXPIRED");
            if check_failure.is_some() {
                let mut report = Report::default();
                report.fail("timeout", "plan expired before check completed", None, None);
                if let Some(code) =
                    check_failure.filter(|code| !code.is_empty() && *code != "timeout")
                {
                    report.fail(code, "check could not complete", None, None);
                }
                return Ok(report.finish(&self.enforcement, &plan));
            }
            return Err(SessionError::new("PLAN_EXPIRED", "plan TTL has expired"));
        }
        // Consume before inspecting any caller Fact or pinned trust state.
        self.retire(plan_id.to_owned(), "PLAN_CONSUMED");
        let mut report = Report::default();
        if let Some(code) = check_failure.filter(|code| !code.is_empty()) {
            let message = match code {
                "aborted" => "check was cancelled",
                "timeout" => "Fact fetch timed out",
                "fact_fetch_failed" => "Fact provider failed",
                "invalid_fact" => "Fact response could not be copied safely",
                "limit_exceeded" => "Fact response exceeds the configured limit",
                _ => "check could not complete",
            };
            report.fail(code, message, None, None);
        }
        if let Err(error) = plan.snapshot.ensure_usable(now_ms) {
            report.fail("trust_expired", error.message, None, None);
            return Ok(report.finish(&self.enforcement, &plan));
        }
        let accepted = facts::validate(
            facts_json,
            plan_id,
            &plan,
            &self.limits,
            now_ms,
            &mut report,
        );
        if plan.partial {
            report.partial("transaction decoder reported partial interpretation", &[]);
        }
        for node in &plan.nodes {
            if matches!(node.action, ActionBody::Unknown { .. }) {
                report.partial("action could not be interpreted", &node.path);
            }
            if let Some(error) = &node.planning_error {
                report.fail("engine_error", &error.message, None, Some(&node.path));
                continue;
            }
            let mut results = BTreeMap::new();
            for call in &node.calls {
                if let Some(value) = accepted.get(&call.id) {
                    results.insert(call.runtime.call_id.clone(), value.clone());
                } else if !call.runtime.optional {
                    report.fail(
                        "required_fact_missing",
                        "required Fact is unavailable",
                        Some(&call.id),
                        Some(&node.path),
                    );
                }
            }
            if !node.matched {
                report.diagnostic(
                    "no_matching_policy",
                    "no policy trigger matches this action",
                    None,
                    Some(&node.path),
                );
            }
            let bundles = match policy_bundles(&plan.snapshot) {
                Ok(bundles) => bundles,
                Err(error) => {
                    report.fail("engine_error", error.message, None, Some(&node.path));
                    continue;
                }
            };
            let input = EvaluateActionInput {
                action: node.action.clone(),
                meta: node.meta.clone(),
                tx: node.tx.clone(),
                bundles,
                results,
                token_decimals: BTreeMap::new(),
                account_leverage: BTreeMap::new(),
                order_enrichment: Default::default(),
            };
            match runtime::evaluate_action(&input) {
                Ok(verdict) => report.engine(verdict, node, &accepted),
                Err(error) => report.fail("engine_error", error.message, None, Some(&node.path)),
            }
        }
        Ok(report.finish(&self.enforcement, &plan))
    }

    pub fn begin_refresh(&mut self) -> Result<u64, SessionError> {
        self.live()?;
        let id = NEXT_REFRESH
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
                id.checked_add(1)
                    .filter(|next| (*next as u64) <= MAX_SAFE_INTEGER)
            })
            .map_err(|_| {
                SessionError::new("LIMIT_EXCEEDED", "refresh identifier space exhausted")
            })?;
        let ticket = self.store.begin_refresh()?;
        self.refresh = Some((id as u64, ticket));
        Ok(id as u64)
    }

    pub fn commit_refresh(
        &mut self,
        ticket: u64,
        policy_json: &str,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        self.live()?;
        clock(now_ms)?;
        if self.refresh.as_ref().map(|(id, _)| *id) != Some(ticket) {
            return Err(SessionError::new(
                "ABORTED",
                "refresh ticket is stale or foreign",
            ));
        }
        let (_, ticket) = self
            .refresh
            .take()
            .ok_or_else(|| SessionError::new("ABORTED", "refresh no longer pending"))?;
        let result = (|| {
            let policy = Policy::parse(policy_json, self.limits.max_policy_bytes)?;
            let prepared = self
                .store
                .prepare_refresh(&ticket, policy.input(), now_ms)?;
            self.store.commit_refresh(prepared, now_ms)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = self.store.cancel_refresh(&ticket);
        }
        result
    }

    pub fn cancel_refresh(&mut self, ticket: u64) -> Result<(), SessionError> {
        self.live()?;
        if self.refresh.as_ref().map(|(id, _)| *id) != Some(ticket) {
            return Err(SessionError::new(
                "ABORTED",
                "refresh ticket is stale or foreign",
            ));
        }
        let (_, ticket) = self
            .refresh
            .take()
            .ok_or_else(|| SessionError::new("ABORTED", "refresh no longer pending"))?;
        self.store.cancel_refresh(&ticket)?;
        Ok(())
    }

    pub fn dispose(&mut self) {
        self.store.dispose();
        self.plans.clear();
        self.retired.clear();
        self.refresh = None;
    }

    fn live(&self) -> Result<(), SessionError> {
        if self.store.is_disposed() {
            return Err(SessionError::new("DISPOSED", "Core session is disposed"));
        }
        Ok(())
    }

    fn retire(&mut self, id: String, code: &'static str) {
        self.retired.push_back((id, code));
        while self.retired.len() as u64 > self.limits.max_pending_plans {
            self.retired.pop_front();
        }
    }

    fn evict_expired(&mut self, now_ms: u64) {
        let expired: Vec<_> = self
            .plans
            .iter()
            .filter(|(_, plan)| now_ms >= plan.expires_at)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            self.plans.remove(&id);
            self.retire(id, "PLAN_EXPIRED");
        }
    }
}

impl Drop for CoreSession {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[allow(clippy::too_many_arguments)]
fn append_node(
    action: &ActionBody,
    meta: &ActionMeta,
    path: Vec<usize>,
    request: &request::Request,
    snapshot: &Snapshot,
    plan_id: &str,
    nodes: &mut Vec<Node>,
    public_calls: &mut Vec<Value>,
    max_calls: u64,
) -> Result<(), SessionError> {
    if nodes.len() >= MAX_ACTION_NODES {
        return Err(SessionError::new(
            "LIMIT_EXCEEDED",
            "decoded action tree exceeds node limit",
        ));
    }
    let tx = TxInput::new(
        request.chain.clone(),
        request.from.clone(),
        request.to.clone(),
    );
    let from = request.from.to_ascii_lowercase();
    let to = request.to.to_ascii_lowercase();
    let tx_view = TxView {
        chain_id: &request.chain,
        from: &from,
        to: &to,
    };
    let view = action.view();
    let matched = snapshot.policy().manifests().iter().any(|manifest| {
        scope_matches_position(manifest.trigger.scope, &view)
            && evaluate_trigger(&manifest.trigger, &view, &tx_view)
    });
    let mut calls = Vec::new();
    let mut planning_error = None;
    {
        let input = PlanActionInput {
            manifests: snapshot.policy().manifests().to_vec(),
            action: action.clone(),
            meta: meta.clone(),
            tx: tx.clone(),
            token_decimals: BTreeMap::new(),
            account_leverage: BTreeMap::new(),
            order_enrichment: Default::default(),
        };
        match runtime::plan_action(&input) {
            Ok(planned) => {
                if public_calls.len().saturating_add(planned.planned.len()) as u64 > max_calls {
                    return Err(SessionError::new(
                        "LIMIT_EXCEEDED",
                        "plan exceeds maxPlanCalls",
                    ));
                }
                for call in planned.planned {
                    let id = format!("{plan_id}-c{}", public_calls.len());
                    public_calls.push(json!({ "manifestId": call.manifest_id, "callId": id,
                        "method": call.method, "params": call.params, "outputs": call.outputs, "optional": call.optional }));
                    calls.push(Call { id, runtime: call });
                }
            }
            Err(error) => planning_error = Some(SessionError::new("ENGINE_ERROR", error.message)),
        }
    }
    nodes.push(Node {
        path: path.clone(),
        action: action.clone(),
        meta: meta.clone(),
        tx,
        calls,
        planning_error,
        matched,
    });
    if let ActionBody::Multicall { actions } = action {
        for (index, child) in actions.iter().enumerate() {
            let mut child_path = path.clone();
            child_path.push(index);
            append_node(
                child,
                meta,
                child_path,
                request,
                snapshot,
                plan_id,
                nodes,
                public_calls,
                max_calls,
            )?;
        }
    }
    Ok(())
}

fn policy_bundles(snapshot: &Snapshot) -> Result<Vec<BundleInput>, SessionError> {
    let policies = snapshot.policy().signature_verified().parsed().payload()["policies"]
        .as_array()
        .ok_or_else(|| SessionError::new("ENGINE_ERROR", "validated policies are unavailable"))?;
    policies
        .iter()
        .zip(snapshot.policy().manifests())
        .map(|(entry, manifest)| {
            let policy = entry["policy"].as_str().ok_or_else(|| {
                SessionError::new("ENGINE_ERROR", "validated Cedar source is unavailable")
            })?;
            Ok(BundleInput {
                policy: policy.to_owned(),
                manifest: manifest.clone(),
            })
        })
        .collect()
}

#[derive(Default)]
struct Report {
    rank: u8,
    failed: bool,
    reasons: Vec<Value>,
    facts: Vec<Value>,
    diagnostics: Vec<Value>,
}

impl Report {
    fn diagnostic(
        &mut self,
        code: &str,
        message: impl Into<String>,
        call: Option<&str>,
        path: Option<&[usize]>,
    ) {
        let mut value = json!({ "code": code, "message": message.into() });
        if let Some(call) = call {
            value["callId"] = json!(call);
        }
        if let Some(path) = path {
            value["nodePath"] = json!(path);
        }
        self.diagnostics.push(value);
    }

    fn fail(
        &mut self,
        code: &str,
        message: impl Into<String>,
        call: Option<&str>,
        path: Option<&[usize]>,
    ) {
        let message = message.into();
        self.rank = 2;
        self.failed = true;
        self.reasons.push(
            json!({ "policyId": format!("__engine::{code}"), "reason": message,
            "severity": "deny", "origin": "engine_error" }),
        );
        self.diagnostic(code, message, call, path);
    }

    fn partial(&mut self, message: &str, path: &[usize]) {
        self.rank = self.rank.max(1);
        self.reasons.push(
            json!({ "policyId": "__engine::partial_decode", "reason": message,
            "severity": "warn", "origin": "engine_error" }),
        );
        self.diagnostic("partial_decode", message, None, Some(path));
    }

    fn engine(&mut self, verdict: Verdict, node: &Node, accepted: &BTreeMap<String, Value>) {
        self.rank = self.rank.max(match verdict {
            Verdict::Pass => 0,
            Verdict::Warn(_) => 1,
            Verdict::Fail(_) => 2,
        });
        for matched in verdict.matched() {
            if matched.policy_id == "__system__" {
                self.failed = true;
                // Runtime intentionally exposes only its stable system marker.
                // Resolve its original call ID back to our plan-issued ID.
                let original = matched
                    .reason
                    .as_deref()
                    .and_then(|reason| reason.strip_prefix("rpc-unavailable: "));
                let call = node
                    .calls
                    .iter()
                    .find(|call| Some(call.runtime.call_id.as_str()) == original);
                if let Some(call) = call {
                    if accepted.contains_key(&call.id) {
                        self.diagnostic(
                            "projection_failed",
                            "required Fact projection failed",
                            Some(&call.id),
                            Some(&node.path),
                        );
                    }
                } else {
                    self.diagnostic(
                        "engine_error",
                        "runtime reported an unbound required Fact failure",
                        None,
                        Some(&node.path),
                    );
                }
            } else if matched.policy_id.starts_with("__engine::quarantine::") {
                self.diagnostic(
                    "bundle_quarantined",
                    matched
                        .reason
                        .as_deref()
                        .unwrap_or("policy bundle quarantined"),
                    None,
                    Some(&node.path),
                );
            }
            self.reasons.push(json!({ "policyId": matched.policy_id, "reason": matched.reason,
                "severity": if matched.severity == Severity::Deny { "deny" } else { "warn" },
                "origin": match matched.origin { policy_engine::PolicyRequestOrigin::Action => "action", policy_engine::PolicyRequestOrigin::Tx => "tx" } }));
        }
    }

    fn finish(self, enforcement: &str, plan: &PendingPlan) -> Value {
        json!({
            "decision": match self.rank { 0 => "allow", 1 => "warn", _ => "deny" },
            "source": if self.failed { "fail_closed" } else { "evaluated" },
            "enforcement": enforcement, "reasons": self.reasons, "facts": self.facts, "diagnostics": self.diagnostics,
            "metadata": plan_metadata(&plan.digest, &plan.snapshot)
        })
    }
}

fn plan_metadata(digest: &str, snapshot: &Snapshot) -> Value {
    json!({ "status": "available", "requestDigest": digest,
        "policyVersion": snapshot.policy().sequence().to_string(),
        "engineVersion": concat!("policy-engine/", env!("CARGO_PKG_VERSION")) })
}

fn parse_json(input: &str, code: &str) -> Result<Value, SessionError> {
    crate::bundle::strict_json::parse(input)
        .map_err(|error| SessionError::new(code, format!("{}: {}", error.path, error.message)))
}

fn clock(now_ms: u64) -> Result<(), SessionError> {
    if now_ms > MAX_SAFE_INTEGER {
        return Err(SessionError::new(
            "INVALID_CONFIG",
            "clock must return a nonnegative safe integer in milliseconds",
        ));
    }
    Ok(())
}
