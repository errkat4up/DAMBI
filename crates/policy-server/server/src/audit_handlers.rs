//! `POST /v1/audit` — a host reports the verdict it computed locally.
//!
//! The server never re-runs Cedar; this is the client's own record. The body
//! is parsed with `deny_unknown_fields` so no field the contract doesn't name
//! (a wallet address, raw calldata, a signature) can be smuggled in. Same
//! `(key, event_id)` twice is a 202 with `recorded: false`, not an error.
//! Contract: registry-api/openapi.yaml `AuditEvent` (documented there for the
//! cross-service view; served here on Policy Hub per ADR 0001).

use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use policy_db::audit::{insert_audit_event, NewAuditEvent};

use crate::app::AppState;
use crate::auth::api_key::ApiKeyIdentity;

const MAX_ID_LEN: usize = 128;
const MAX_VERSION_LEN: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditEventReq {
    pub event_id: String,
    pub request_digest: String,
    pub verdict: String,
    pub policy_version: String,
    pub engine_version: String,
    #[serde(default)]
    pub submitted_at: Option<i64>,
}

/// Pure validation, kept separate so it is unit-testable without a DB.
pub fn validate(req: &AuditEventReq) -> Result<(), &'static str> {
    if req.event_id.is_empty() || req.event_id.len() > MAX_ID_LEN {
        return Err("event_id must be 1..=128 characters");
    }
    if !req
        .event_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err("event_id may contain only [A-Za-z0-9-_:.]");
    }
    let d = &req.request_digest;
    if d.len() != 66
        || !d.starts_with("0x")
        || !d[2..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        return Err("request_digest must be 0x + 64 lowercase hex characters");
    }
    if !matches!(req.verdict.as_str(), "allow" | "warn" | "deny") {
        return Err("verdict must be one of allow|warn|deny");
    }
    for (name, v) in [
        ("policy_version", &req.policy_version),
        ("engine_version", &req.engine_version),
    ] {
        if v.is_empty() || v.len() > MAX_VERSION_LEN || v.chars().any(char::is_whitespace) {
            return Err(match name {
                "policy_version" => "policy_version must be 1..=64 non-whitespace characters",
                _ => "engine_version must be 1..=64 non-whitespace characters",
            });
        }
    }
    if matches!(req.submitted_at, Some(t) if t < 0) {
        return Err("submitted_at must be a non-negative unix timestamp");
    }
    Ok(())
}

pub async fn record_audit_event(
    State(state): State<AppState>,
    Extension(key): Extension<ApiKeyIdentity>,
    body: Result<Json<AuditEventReq>, JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(b) => b,
        Err(rej) => return bad_request(&rej.body_text()),
    };
    if let Err(reason) = validate(&req) {
        return bad_request(reason);
    }
    let ev = NewAuditEvent {
        api_key_id: key.key_id,
        event_id: &req.event_id,
        request_digest: &req.request_digest,
        verdict: &req.verdict,
        policy_version: &req.policy_version,
        engine_version: &req.engine_version,
        submitted_at: req.submitted_at,
        received_at: unix_now(),
    };
    match insert_audit_event(state.global_db.pool(), &ev).await {
        Ok(recorded) => (
            StatusCode::ACCEPTED,
            Json(json!({ "ok": true, "event_id": req.event_id, "recorded": recorded })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, key = %key.label, "audit event insert failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "unavailable", "reason": "audit store unavailable" })),
            )
                .into_response()
        }
    }
}

fn bad_request(reason: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "bad_request", "reason": reason })),
    )
        .into_response()
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_req() -> AuditEventReq {
        AuditEventReq {
            event_id: "evt-1".into(),
            request_digest: format!("0x{}", "ab".repeat(32)),
            verdict: "warn".into(),
            policy_version: "1".into(),
            engine_version: "0.0.1".into(),
            submitted_at: Some(1_757_203_200),
        }
    }

    #[test]
    fn accepts_a_well_formed_event() {
        assert_eq!(validate(&ok_req()), Ok(()));
    }

    #[test]
    fn rejects_bad_digest_verdict_and_ids() {
        let mut r = ok_req();
        r.request_digest = "0xABCD".into();
        assert!(validate(&r).is_err());
        let mut r = ok_req();
        r.request_digest = format!("0x{}", "AB".repeat(32));
        assert!(validate(&r).is_err(), "uppercase hex rejected");
        let mut r = ok_req();
        r.verdict = "block".into();
        assert!(validate(&r).is_err());
        let mut r = ok_req();
        r.event_id = "has space".into();
        assert!(validate(&r).is_err());
        let mut r = ok_req();
        r.event_id = "x".repeat(129);
        assert!(validate(&r).is_err());
        let mut r = ok_req();
        r.submitted_at = Some(-1);
        assert!(validate(&r).is_err());
    }

    #[test]
    fn unknown_fields_are_rejected_at_parse_time() {
        let raw = json!({
            "event_id": "e", "request_digest": format!("0x{}", "00".repeat(32)),
            "verdict": "allow", "policy_version": "1", "engine_version": "1",
            "wallet_address": "0x0000000000000000000000000000000000000001"
        });
        assert!(serde_json::from_value::<AuditEventReq>(raw).is_err());
    }
}
