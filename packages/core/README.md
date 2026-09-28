# @dambi/core

Pre-sign policy core for Web3 wallets. Hosts provide signed policies and method
responses; Core decodes requests, plans Fact calls and returns allow/warn/deny.

## Status: C5 runtime

The working tree implements `createCore`, `plan`, `evaluate`, `refreshPolicies`
and `dispose` using this package's Rust/WASM runtime. This is not a new published
release. Confirmed verification is recorded under Development checks below.
`check()` still rejects with `NOT_IMPLEMENTED`: automatic Fact fetching, cache
and hooks belong to C6. Use the explicit plan/provider/evaluate flow meanwhile.

ESM only, Node >= 20, no external JS runtime dependencies. The build includes its
own JS/WASM pair under `dist/runtime/wasm`; serve those assets with the package
when using browser modules. `@dambi/core/internal` remains reserved and empty.

## Public contract and migration

- Use `await createCore(config, options?)`. The instance exposes `plan`, `evaluate`,
  `check`, `refreshPolicies` and idempotent `dispose`.
- `CoreConfig.ports` contains `policy` and `fact` only. `clock` moves to config.
  `DecoderSource` is removed; use a fixed `decoderSnapshot` plus local `trust`.
- `plan(request)` issues a read-only `CorePlan`. `evaluate(plan, batch)` consumes it
  once, even if Fact validation fails. Copied/serialized or foreign handles are
  invalid. Core retains authoritative inputs; TypeScript branding is not security.
- `PolicySet` and `FactMap` are removed. `FactBatch` carries `planId` and results
  keyed by exact, plan-issued `callId` values. IDs are unique across all children
  of a multicall; do not construct them from manifest/spec names.
- `SignedPolicyBundle.payload` is the original signed string B. Verify its UTF-8
  bytes with fixed ECDSA P-256/SHA-256 and 64-byte P1363 Base64 signatures. An HTTP
  adapter maps `key_id` to `keyId` without changing B; this field is telemetry and
  never selects trusted keys. Only locally configured policy-role keys apply.
- `FactResult.value` is the JSON-compatible method response **before projection**,
  such as `{ balance: "0x64" }`. `source` and `observedAt` (Unix ms) are required;
  `blockNumber` is an optional decimal string. Core applies projection. Providers
  validate method-specific encoding and omit unavailable calls instead of
  inventing zero values. The pinned manifest decides whether absence is optional.
- `enforcement` remains required (`advisory` or `enforcing`), alongside existing
  `decision`, `source`, policy severity and reasons. It describes host deployment;
  Core does not submit or block transactions.

The explicit C5 flow follows the C1 public contract:

```ts
import { createCore } from "@dambi/core";
import type { CheckRequest, CoreConfig, Verdict } from "@dambi/core";

export async function evaluateRequest(
  config: CoreConfig,
  request: CheckRequest,
  signal?: AbortSignal,
): Promise<Verdict> {
  const core = await createCore(config, { signal });
  try {
    const plan = await core.plan(request, { signal });
    const batch = await config.ports.fact.fetch(plan.calls, {
      planId: plan.planId,
      signal,
    });
    return core.evaluate(plan, batch);
    // C6 will coordinate these steps through check(request, { signal }).
  } finally {
    core.dispose();
  }
}
```

`refreshPolicies` validates before atomic replacement; failed refresh preserves
current state. Existing plans keep their snapshots while valid. Direct API
lifecycle/handle errors throw or reject `CoreError`. With a valid handle, Fact or
trust failures return `deny + fail_closed`. `check` also maps known malformed
requests, cancellation and timeout to fail-closed; unsupported kinds warn.
`CoreDiagnostic.code` distinguishes partial decoding, no policy match and errors.
The `check` error mapping and hook behavior described here are C6 contracts.

`CorePlan.expiresAt` is the plan TTL deadline. Handle validation runs first; if it
passes, snapshot validity is checked separately. Thus expired handles throw,
while expired trust within a still-live handle produces a fail-closed verdict.

## Local configuration

`CoreTrust` fixes `env` (`staging`/`production`), `profile: "default"` and local
`VerificationKey` entries (`keyId`, `role`, `publicKeySpkiBase64`). At least one
policy-role key is required. Decoder-role keys cannot authorize policies.

`DecoderSnapshot.artifact` is a new SDK container JSON string:
`{ "schema_version": 1, "bundles": [/* full resolved V3 bundles */] }`.
It is not the DEC-07 handoff index or unresolved source manifests. The container's
`expectedDigest` is `0x` plus lowercase SHA-256 of its exact UTF-8 bytes, pinned
independently in trusted local config. Existing per-bundle `bundle_sha256` rules
remain distinct. Runtime validation is implemented; product container selection
and reproducible generation remain D4 follow-up work.

`CoreLimits` requires explicit UTF-8 size limits (`maxPolicyBytes` for B,
`maxDecoderBytes`, `maxRequestBytes` for canonical digest input, `maxFactBytes`
for JSON FactBatch), `maxPlanCalls` and `maxPendingPlans`. Durations
`allowedClockSkewMs`, `planTtlMs`, `maxFactAgeMs`, `factTimeoutMs` and
`policyTimeoutMs` use milliseconds. Values are positive safe integers except
skew, which may be zero. Only `maxBundleAgeSec` has a default: 259200 seconds
(72 hours), even if policy `expires_at` is null. Expiry is never extended by skew,
cache hits, policy re-fetch or plan TTL. Test configuration values are not
recommended deployment defaults.

## Audit metadata

Both the returned Verdict and `onVerdict` expose the same `metadata` union:

- `status: "available"`: `requestDigest`, `policyVersion`, `engineVersion`.
- `status: "unavailable"`: a typed reason, with no invented digest or versions.
  The verdict also carries `audit_metadata_unavailable` in diagnostics.

The C1 request digest contract is
`SHA-256(UTF-8(JCS({ domain: "dambi.core.request.v1", request })))`, rendered as
`0x` plus 64 lowercase hex digits. Core copies the declared fields of the known
request variant, including the entire `typedData`, `order` or `message`, and pins
that same copy for planning/evaluation. Absent optional fields (including explicit
`undefined`) are omitted. It inserts no defaults and performs no address casing,
hex or numeric-string conversions; JCS alone defines key ordering and JSON number
formatting. Unknown top-level transport fields are excluded. Nested data must be
JSON data: reject cycles, undefined, bigint, functions, symbols, non-finite values,
unsafe integers, invalid Unicode and non-plain objects instead of silently
coercing them. Native Core calculates and pins the digest before issuing a plan.
Unsupported requests reject `plan`; their future `check` verdicts will have
unavailable metadata.

`policyVersion` is the decimal string of the **pinned snapshot's integer
sequence**; `engineVersion` identifies the engine used for that verdict. Missing
metadata stays local rather than being sent to the current audit API. The host
supplies event IDs, authentication and HTTP delivery; delivery failure does not
change a decision.

## Development checks

From the repository root (Rust, the wasm32 target and wasm-pack are required):

```sh
cargo update --workspace --offline
cargo test --locked -p dambi-core --test session
cargo build --locked -p dambi-core --example session_runner
npm run core:build
npm run core:test:types
npm run core:test:runtime
```

Consumer checks import the built package declarations (no source aliases) and
also compile the policy wire types. Build first to avoid stale declarations.
The runtime checks load actual packaged WASM and compare plan/evaluate output
against the Native session runner. They fail if artifacts are absent and never
build them implicitly. No legacy extension WASM package is loaded.
`npm run core:pack` separately inspects package contents without publishing.

User verification (2026-09-28, C5 changes): consumer type checks completed without
errors; runtime checks passed 5/5 (0 failures), including actual Native/WASM
parity. The separate Native session test output has not been shared.

## Coverage and license

C5 routes transactions through the supplied resolved Decoder snapshot, including
multicall trees, and uses the existing strict ERC-20 Permit typed-data path.
Other typed contracts, untyped signatures, venue orders and contract creation
reject `plan` with `UNSUPPORTED_REQUEST`; no permissive typed-data fallback is
used. Installation of a bundle does not certify every request path it describes.
Method-specific Fact value validation remains the provider's responsibility;
Core validates plan binding, provenance shape, age and required projections.
Product scope and release verification remain separate from these fixed tests.

Apache-2.0; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
