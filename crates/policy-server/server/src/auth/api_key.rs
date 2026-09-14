//! API-key auth for host-facing routes (`POST /v1/audit`).
//!
//! Separate from the JWT middleware on purpose: JWTs identify a dashboard
//! *user*, API keys identify an integrating *host app* (the extension, a Snap,
//! a wallet vendor's backend). Keys travel in `X-Api-Key`, never in the URL.
//! The middleware hashes the presented key and looks it up; it never logs or
//! stores the plaintext.
//!
//! v0.1: one key = one host, no tenant grouping (ADR 0001, 2026-09-12).

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::app::AppState;

/// Request header carrying the key.
pub const API_KEY_HEADER: &str = "x-api-key";
/// Fixed prefix so a leaked key is recognisable by secret scanners.
pub const API_KEY_PREFIX: &str = "dambi_ak_";
/// Prefix + two 128-bit UUIDs as hex.
const API_KEY_LEN: usize = API_KEY_PREFIX.len() + 64;

/// Identity attached to the request once a key is accepted.
#[derive(Clone, Debug)]
pub struct ApiKeyIdentity {
    pub key_id: Uuid,
    pub label: String,
}

/// SHA-256 hex of the plaintext key — the only form that is ever stored.
#[must_use]
pub fn hash_api_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// Mint a fresh 256-bit key with the recognisable prefix.
#[must_use]
pub fn generate_api_key() -> String {
    format!(
        "{API_KEY_PREFIX}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

/// `axum::middleware::from_fn_with_state(state, require_api_key)`.
pub async fn require_api_key(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(raw) = req.headers().get(API_KEY_HEADER) else {
        return reject("missing X-Api-Key header");
    };
    let key = match raw.to_str() {
        Ok(s) if s.len() == API_KEY_LEN && s.starts_with(API_KEY_PREFIX) => s.to_owned(),
        _ => return reject("malformed API key"),
    };
    let hash = hash_api_key(&key);
    match policy_db::audit::find_active_api_key(state.global_db.pool(), &hash).await {
        Ok(Some(row)) => {
            req.extensions_mut().insert(ApiKeyIdentity {
                key_id: row.id,
                label: row.label,
            });
            next.run(req).await
        }
        Ok(None) => reject("unknown or revoked API key"),
        Err(e) => {
            tracing::error!(error = %e, "api key lookup failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "unavailable", "reason": "api key store unavailable" })),
            )
                .into_response()
        }
    }
}

fn reject(reason: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized", "reason": reason })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_have_fixed_shape_and_are_unique() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert_eq!(a.len(), API_KEY_LEN);
        assert!(a.starts_with(API_KEY_PREFIX));
        assert!(a[API_KEY_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_stable_hex_sha256() {
        let h = hash_api_key("dambi_ak_test");
        assert_eq!(h.len(), 64);
        assert_eq!(h, hash_api_key("dambi_ak_test"));
        assert_ne!(h, hash_api_key("dambi_ak_tesT"));
    }
}
