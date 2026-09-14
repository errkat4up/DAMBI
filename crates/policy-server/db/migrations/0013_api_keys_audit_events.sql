-- Policy Hub: host API keys + client-reported audit events (POST /v1/audit).
--
-- v0.1 has no tenant/organization above a key (ADR 0001, 2026-09-12): one
-- key = one integrating host app. Adding a tenant later is an additive column
-- on api_keys, not a contract change.
--
-- api_keys stores only the SHA-256 of the presented key; the plaintext is
-- printed once by the `issue_api_key` binary and never persisted.
--
-- audit_events is an event log of what the CLIENT decided — the server never
-- re-runs Cedar. There is deliberately no wallet-address column (and the
-- handler rejects unknown fields), so a raw address cannot reach this table.
-- Dedup key is (api_key_id, event_id): event ids are client-generated, so two
-- hosts may legitimately collide on the same id.

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  revoked_at   BIGINT
);

CREATE TABLE IF NOT EXISTS audit_events (
  api_key_id     UUID NOT NULL REFERENCES api_keys(id),
  event_id       TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  submitted_at   BIGINT,
  received_at    BIGINT NOT NULL,
  PRIMARY KEY (api_key_id, event_id),
  CHECK (verdict IN ('allow', 'warn', 'deny'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_received_at
  ON audit_events(received_at);
