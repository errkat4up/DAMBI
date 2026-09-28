# @dambi/core

Pre-sign policy core for Web3 wallets. Hosts provide signed policies and method
responses; Core will decode requests, plan Fact calls and return allow/warn/deny.

## Status: C1 public contract, runtime pending

The working tree refines the 0.0.1 scaffold; it is not a new published release.
`createCore()` returns a Promise that always rejects with `CoreError` code
`NOT_IMPLEMENTED`. No decoding, trust verification or evaluation runs yet.
C2–C6 implement the behavior described below. Type checks do not prove runtime
handle integrity, signature validation, expiry or cancellation.

ESM only, Node >= 20, no runtime dependencies. `@dambi/core/internal` is reserved
and empty. Do not integrate this scaffold as a working policy engine.

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

This example describes the future runtime and type-checks against C1:

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
    // For a separate request, check(request, { signal }) coordinates these steps.
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
Hook exceptions do not alter the verdict.

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
remain distinct. Container generation and runtime validation are later work.

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
coercing them. Unsupported kinds have unavailable metadata. C5 implements hashing.

`policyVersion` is the decimal string of the **pinned snapshot's integer
sequence**; `engineVersion` identifies the engine used for that verdict. Missing
metadata stays local rather than being sent to the current audit API. The host
supplies event IDs, authentication and HTTP delivery; delivery failure does not
change a decision.

## Development checks

From the repository root, run after changing this contract:

```sh
npm run core:typecheck
npm run core:build
npm run core:test:types
npm run core:test:scaffold
```

Consumer checks import the built package declarations (no source aliases) and
also compile the policy wire types. Build first to avoid stale declarations.
The scaffold check only verifies asynchronous failure and ESM entry resolution.
`npm run core:pack` separately inspects package contents without publishing.

## Coverage and license

No runtime coverage in this scaffold. Apache-2.0; see [LICENSE](./LICENSE) and
[NOTICE](./NOTICE).
