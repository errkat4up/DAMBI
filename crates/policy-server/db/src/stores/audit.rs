//! Policy Hub API keys and client-reported audit events (`POST /v1/audit`).
//!
//! Keys are stored hashed (SHA-256 hex, computed by the server crate); this
//! module never sees plaintext. Audit rows are an append-only event log keyed
//! by `(api_key_id, event_id)` — a replay of the same event id from the same
//! key is not an error, it is simply not recorded twice.

use sqlx_core::query::query;
use sqlx_core::row::Row;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::error::{DbError, DbResult};

/// One issued API key (never the plaintext).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiKeyRow {
    /// Stable key id (what `issue_api_key --revoke` takes).
    pub id: Uuid,
    /// Operator-chosen label, e.g. `browser-extension`.
    pub label: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds once revoked; `None` while active.
    pub revoked_at: Option<i64>,
}

/// Insert a new key record. `key_hash` is the SHA-256 hex of the plaintext.
///
/// # Errors
///
/// Returns [`DbError`] if the label is blank or the insert fails (including a
/// duplicate hash).
pub async fn create_api_key(
    pool: &PgPool,
    key_hash: &str,
    label: &str,
    now: i64,
) -> DbResult<Uuid> {
    let label = label.trim();
    if label.is_empty() {
        return Err(DbError::Invariant("api key label is required".to_owned()));
    }
    let id = Uuid::new_v4();
    query(
        "INSERT INTO api_keys (id, key_hash, label, created_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(key_hash)
    .bind(label)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| DbError::Invariant(e.to_string()))?;
    Ok(id)
}

/// Look up a non-revoked key by hash. `None` covers unknown and revoked alike
/// so the caller cannot distinguish them (and neither can an attacker).
///
/// # Errors
///
/// Returns [`DbError`] if the query fails.
pub async fn find_active_api_key(pool: &PgPool, key_hash: &str) -> DbResult<Option<ApiKeyRow>> {
    let row = query(
        "SELECT id, label, created_at, revoked_at
         FROM api_keys
         WHERE key_hash = $1 AND revoked_at IS NULL",
    )
    .bind(key_hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::Invariant(e.to_string()))?;
    Ok(row.map(|r| ApiKeyRow {
        id: r.get("id"),
        label: r.get("label"),
        created_at: r.get("created_at"),
        revoked_at: r.get("revoked_at"),
    }))
}

/// Mark a key revoked. Returns `false` when it was unknown or already revoked.
///
/// # Errors
///
/// Returns [`DbError`] if the update fails.
pub async fn revoke_api_key(pool: &PgPool, id: Uuid, now: i64) -> DbResult<bool> {
    let res = query("UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL")
        .bind(id)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| DbError::Invariant(e.to_string()))?;
    Ok(res.rows_affected() > 0)
}

/// One audit event as reported by a host. Field semantics: registry-api/openapi.yaml `AuditEvent`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewAuditEvent<'a> {
    /// Key the host authenticated with; half of the dedup key.
    pub api_key_id: Uuid,
    /// Client-generated id; other half of the dedup key.
    pub event_id: &'a str,
    /// `0x` + 64 lowercase hex — a hash of the request, never its content.
    pub request_digest: &'a str,
    /// `allow` | `warn` | `deny` (validated by the handler; CHECK-enforced).
    pub verdict: &'a str,
    /// Bundle `sequence` the verdict was computed against.
    pub policy_version: &'a str,
    /// dambi-core / engine version string.
    pub engine_version: &'a str,
    /// Client clock, unix seconds, optional.
    pub submitted_at: Option<i64>,
    /// Server clock, unix seconds.
    pub received_at: i64,
}

/// Append one event. Returns `true` if it was newly recorded, `false` if the
/// same `(api_key_id, event_id)` already existed (idempotent replay).
///
/// # Errors
///
/// Returns [`DbError`] if the insert fails (e.g. the key row is gone or the
/// verdict violates the table CHECK).
pub async fn insert_audit_event(pool: &PgPool, ev: &NewAuditEvent<'_>) -> DbResult<bool> {
    let res = query(
        "INSERT INTO audit_events
           (api_key_id, event_id, request_digest, verdict, policy_version, engine_version,
            submitted_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (api_key_id, event_id) DO NOTHING",
    )
    .bind(ev.api_key_id)
    .bind(ev.event_id)
    .bind(ev.request_digest)
    .bind(ev.verdict)
    .bind(ev.policy_version)
    .bind(ev.engine_version)
    .bind(ev.submitted_at)
    .bind(ev.received_at)
    .execute(pool)
    .await
    .map_err(|e| DbError::Invariant(e.to_string()))?;
    Ok(res.rows_affected() > 0)
}
