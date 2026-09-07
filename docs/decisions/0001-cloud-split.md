# 0001 — dambi Cloud splits into Policy Hub and Registry Sync; fact computation is host-owned

Date: 2026-09-07
Status: decided

## Context

The current `policy-server` (Rust/axum) does four unrelated things in one
binary: policy/package distribution (`market_*`), wallet auth, evaluate-time
fact enrichment (`evaluate_handler`, `lending_hf.rs` — allowance, health
factor, price, sanctions screening via host-configured RPC envs), and wallet
portfolio sync (`policy_sync::{Orchestrator, RpcRouter}` — holdings,
approvals, positions). Its own `Cargo.toml` description already says
"Cedar evaluation... live[s] in the browser extension" — server-side judgment
was already understood to be going away.

`registry-api` + `registryV2` are a second, already-separate service that
signs and serves decoder/selector data to the extension.

## Decision

1. **dambi-core (SDK) judges locally.** `plan()` and `evaluate()` run
   client-side against the WASM Cedar engine. No server round-trip for a
   verdict.
2. **The cloud surface splits in two, both under "dambi Cloud":**
   - **Policy Hub** — evolves from `policy-server`'s `market_*` subsystem
     (listings, versions, installs, publishers, DB, auth). This is also
     where `POST /v1/audit` and API-key issuance live — it already has the
     DB and auth `policy-server`'s other pieces don't.
   - **Registry Sync** — `registryV2` + `registry-api` (unchanged
     ownership). Serves `GET /v1/bundle` and
     `GET /v1/registry/selectors`. Will ingest GIWA on-chain EAS
     attestations (not built yet — 0 lines as of 2026-09-07).
3. **Chain RPC is host-provided in production; dambi runs a default for the
   demo.** Each integrator configures their own RPC/provider key for the
   `FactProvider` port in a real deployment — `policy-server`'s
   `evaluate_handler` / `lending_hf.rs` / wallet-sync code is **not** a
   dambi Cloud service, it ships as a documented reference `FactProvider`
   implementation an integrator adapts and points at their own RPC. **But**
   the initial demo ships on testnet by default, and a demo that requires
   the visitor to bring their own RPC key first has no visitor — so dambi
   runs one small testnet-only default instance (a testnet Alchemy/Infura
   key, negligible cost) purely to make the out-of-the-box demo path work.
   This default is explicitly not the production contract: it's scoped to
   testnet, is not what an integrating host is expected to depend on, and
   doesn't reopen a shared mainnet facts service. (2026-09-07, same day as
   the original decision — noted here rather than as a separate ADR since
   nothing shipped against the prior wording yet.)
4. **WASM ships inside `@dambi/core`**, not a separate package. The
   `core-v*` tag/publish workflow publishes the engine with the SDK.

## Consequences

- `policy-server`'s v0.1 deploy scope is Policy Hub (market/auth/DB) **plus**
  a minimal testnet-only FactProvider-reference deploy carrying one default
  testnet RPC key, for the demo. It is not a production-grade shared facts
  service — no mainnet key, no capacity planning, no SLA.
- The integration guide must document the reference `FactProvider`
  implementation and its RPC env-var contract
  (`POLICY_LENDING_RPC_URL`, `POLICY_PRICE_RPC_URL_*`,
  `POLICY_SANCTIONS_RPC_URL`, …) so an integrator can stand it up themselves.
- **Risk carried forward, not resolved here:** the current WASM artifact is
  2,495,488 bytes gzip against a stated 1.5 MB budget (66% over,
  `docs/sdk-migration/FINDINGS.md` F-003). Since WASM now ships inside
  `@dambi/core`, this must be revisited — either the budget is revised or the
  artifact needs to shrink — before the real (non-scaffold) `@dambi/core`
  publishes. Not blocking for 0.0.1.
- **Open, not decided here:** the formal Policy-Hub-owns-audit-and-keys
  sign-off with Track A.

## Addendum (2026-09-07) — bundle payload schema

Decided (see `registry-api/openapi.yaml` `BundlePayload` for the normative
shape). Note this does **not** touch `packages/core`'s types: the port's
`SignedPolicyBundle.payload` and `PolicySet` are both intentionally `unknown`
already, precisely so a decision like this can be made without reopening the
D1-D2 interface freeze.

```json
{
  "policies": [{ "id": "...", "policy": "// cedar source", "manifest": {} }],
  "sequence": 1,
  "issued_at": 1757203200,
  "expires_at": null,
  "env": "production",
  "profile": "default",
  "registry_ref": null
}
```

- `policies[].{id,policy,manifest}` — unchanged from `policy-set-v2.json` /
  `ResolvedBundle` / `seed.ts`'s existing shape. `manifest` stays opaque, the
  same deferral `PolicySet` already makes to the future `policy-ir` package.
- `sequence` (not a semver string) is the single source of truth for
  ordering/pinning/rollback — a rollback republishes prior content under a
  new, higher `sequence`, content is never mutated in place.
- `expires_at`, `profile`, `registry_ref` are reserved fields, always
  `null`/`"default"` in v0.1 (no expiry policy, no multi-profile/tenant
  scoping, `registryV2` doesn't emit a root index version yet) — present so
  v0.2 filling them in isn't a breaking change.
- Signing is unchanged: `canonicalize(payload)` (RFC 8785 JCS) then detached
  ECDSA P-256 over SHA-256, same as `registryV2/scripts/sign-bundles.ts`
  already does for decoder bundles.

## Addendum (2026-09-07) — GET /v1/bundle parameter contract

Decided (see `registry-api/openapi.yaml`). No live DB lookup — `GET
/v1/bundle` rewrites into the same object-proxy pattern already used for
`/v1/registry/selectors`:

- `?profile=&version=` → `policy-bundles/<profile>/<version>.json` (content
  is fixed by `sequence`, so this path is immutable — cache forever, same as
  `bundles/<sha>.json` today).
- `?profile=` (no `version`) → `policy-bundles/<profile>/latest.json` (a
  mutable pointer — short cache, same as `index/*`).
- A publish writes the identical signed bytes to both paths at once — no
  ref-materialization step to build.
- `profile` defaults to `"default"`; anything else is a real 404 in v0.1
  (no silent fallback). `version` must be a positive integer; a malformed
  value and a never-issued `sequence` are both 404 — matches the rest of
  registry-api never distinguishing malformed-request from not-found.
- No chain-scoping parameter — a policy's Cedar source matches its own
  chain(s), it isn't selected by an external dimension the way decoders are.
- v0.1 keeps every `sequence` ever issued (no retention/GC policy) so any
  previously valid `version` always resolves.

## Addendum (2026-09-07) — signature transport location + payload strictness

Track A's Core-side review of the bundle payload (proposed `PolicyBundlePayloadV1`
internal type + validation rules) confirmed everything already decided here
(P-256/SHA-256, JCS, base64 P1363, key trust is client-configured not
response-supplied, `registry_ref` null-only in v0.1, no signed tenant
binding) and flagged one genuinely open item plus one real schema bug:

- **Transport location — decided: single JSON response body, `payload` as
  a JCS string.** `GET /v1/bundle` returns `{payload, signature, key_id}`
  as one object (not a header, not a detached `.sig` sidecar the way decoder
  bundles work). `payload` is **a string** holding the RFC 8785 canonical
  JSON text of the `BundlePayload` — the exact signed bytes — not an
  embedded object. Chosen over an embedded object (confirmed by the user
  after Track A's 5.2 proposed `SignedPayload{payloadBytes, signatureBytes,
  keyId}`): the adapter becomes a byte pass-through (`utf8(payload)`), and
  the SDK verifies those bytes first and only then parses them with its own
  strict parser. With an embedded object the signed bytes would instead
  depend on the adapter's JSON.parse + re-canonicalization, which loses
  duplicate-key rejection and couples verification to adapter behaviour.
  Server side, the signer emits exactly `canonicalize(bundlePayload)` into
  the field. This leaves decoder bundles (sidecar `.sig`, object body) and
  policy bundles (inline signature, string payload) on two conventions —
  accepted for v0.1, unifying is a v0.2 item.
- **Schema bug fixed:** `expires_at` and `registry_ref` were listed as
  optional in `BundlePayload`; they must be **required-but-nullable** — a
  missing key is an invalid bundle, `null` is the valid v0.1 value. Also
  added: `sequence` bounded to the JS safe-integer range (1..2^53-1,
  matching Core's Rust-side check), `policies` rejects an empty array and
  duplicate `id`s, `policies[].id` must equal `manifest.id`, an empty `{}`
  manifest is invalid. See `registry-api/openapi.yaml` `BundlePayload`.
- **`registry_ref` non-null is a distinct error**, not a generic validation
  failure: Core will surface it as `UNSUPPORTED_REGISTRY_REF`, separate from
  "malformed bundle."
- **Policy bundles are signed with their own KMS key, separate from the
  decoder-bundle key** — decided 2026-09-07. Same algorithm and pipeline
  (`sign-bundles.ts`: JCS → SHA-256 → ECDSA P-256, P1363, base64), different
  key. Reasons: a compromise or rotation of one does not touch the other,
  and the two keys have different owners in practice (policy authors vs the
  registry build). Cost: one more Cloud KMS key, and the SDK's `trustedKeys`
  config pins two keys instead of one. Separating later would mean a
  coordinated rotation across every installed SDK; doing it before the first
  real bundle ships is nearly free. Action items: provision the key (GCP,
  alongside the existing registry key), add a `BUNDLE_SIGNING_MODE=kms`
  path for policy bundles in the publish script, and document both public
  keys in the integration guide.
- **`maxBundleAgeSec` = 72 hours (259200 seconds)** — decided 2026-09-07.
  Client-side config, not part of the API contract: effective validity =
  `min(expires_at, issued_at + maxBundleAgeSec)`, so `expires_at: null`
  never means "valid forever." Explicitly a v0.1 starting value, not tuned
  against real publish-cadence data (none exists yet) — revisit once Policy
  Hub/Registry Sync has an actual `sequence` cut frequency to check it
  against.

## Addendum (2026-09-07) — security audit commissioning timing

A separate, since-superseded 12-day sprint doc placed audit commissioning at
its D5 (immediately). Confirmed with the user: **commission at the 12-week
plan's D13**, after Track A's core extraction has stabilized the judgment
path — the audit's actual subject (plan/evaluate split, port boundaries,
3-state Verdict, zero network symbols in core) doesn't exist yet at D5.
Commissioning early would mean re-scoping once it does.
