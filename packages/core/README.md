# @dambi/core

Pre-sign policy core for Web3 wallets. Hosts provide signed policies and method
responses; Core decodes requests, plans Fact calls and returns allow/warn/deny.

## Status: 0.0.1 Core implementation and C6 source checks verified

This source implements `createCore`, `check`, `plan`, `evaluate`, `refreshPolicies`
and `dispose` using this package's Rust/WASM runtime. This is not a new published
release. Confirmed verification is recorded under Development checks below.
`check()` coordinates planning, Fact fetching, bounded in-memory cache and
evaluation. Product and release verification remain separate.

ESM only, Node >= 20, no external JS runtime dependencies. The build includes its
own JS/WASM pair under `dist/runtime/wasm`; serve those assets with the package
when using browser modules. `@dambi/core/internal` remains reserved and empty.

### Bundlers

The loader finds its WASM next to its own module via `import.meta.url`.
Production bundles emit both files as hashed assets with no extra configuration
(verified with a Vite 6 build in headless Chromium). The **Vite dev server**,
however, pre-bundles dependencies into a different directory, so the WASM URL
resolves to a 404 and `createCore` rejects with `ENGINE_ERROR`. Exclude the
package from dependency optimization:

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ["@dambi/core"] },
};
```

## Connecting to the Dambi API

Core needs three inputs: decoders, signed policies, and Facts. Decoders ship in
the package; policies come from the Dambi registry API; Facts come from your
chain RPC.

| Input | Source | Trust |
| --- | --- | --- |
| Decoders | `@dambi/core/decoders` (pinned per package version) | SHA-256 digest |
| Policies | `GET /v1/bundle` | ECDSA P-256 signature, key below |
| Facts | your `FactProvider` | provenance and age checks |

```ts
import { createCore } from "@dambi/core";
import { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";

const DAMBI_API = "https://registry-api-v3-428885534408.asia-northeast1.run.app";

const core = await createCore({
  decoderSnapshot,
  trust: {
    env: "staging",
    profile: "default",
    keys: [{
      keyId: "policy-local-416b1764fb8d",
      role: "policy",
      publicKeySpkiBase64:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbuwI14qQ6EPvaUcFCLBqURMAeBBEkjip+lh313nYz0hkdJIEgwN9bD0sDvDFd0BH/abEGtN0WIsR920rVgiFyQ==",
    }],
  },
  enforcement: "advisory",
  limits: {
    maxPolicyBytes: 1_000_000,
    maxDecoderBytes: decoderSnapshotInfo.bytes,
    maxRequestBytes: 256_000,
    maxFactBytes: 1_000_000,
    maxPlanCalls: 64,
    maxPendingPlans: 16,
    allowedClockSkewMs: 60_000,
    planTtlMs: 60_000,
    maxFactAgeMs: 60_000,
    factTimeoutMs: 5_000,
    policyTimeoutMs: 10_000,
  },
  ports: {
    policy: {
      async fetch(options) {
        const res = await fetch(`${DAMBI_API}/v1/bundle?profile=default`, { signal: options?.signal });
        if (!res.ok) throw new Error(`policy bundle: HTTP ${res.status}`);
        // The HTTP envelope uses key_id; keep payload byte-for-byte as received.
        const { payload, signature, key_id } = await res.json();
        return { payload, signature, keyId: key_id };
      },
    },
    fact: {
      // The current default policies request no Facts. Replace this with an RPC
      // provider before enabling policies that do: required Facts that are
      // missing make the verdict fail closed.
      async fetch(_calls, { planId }) {
        return { planId, results: {} };
      },
    },
  },
});

// Policy bundles are re-signed regularly and are rejected once older than
// maxBundleAgeSec (72 hours). Refresh well inside that window.
setInterval(() => core.refreshPolicies().catch(console.error), 60 * 60 * 1000);

const verdict = await core.check({
  kind: "transaction",
  chainId: "eip155:1",
  from: "0x…",
  to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  data: "0x095ea7b3…",
  value: "0",
});
```

- `/v1/bundle` needs no credentials and allows cross-origin requests, so the
  same code runs in a browser extension or a web page.
- `trust.env` must match the bundle's `env`. The current API serves
  `"staging"` bundles signed by a development key; the key above changes when
  production signing is introduced, and that change ships as a new release.
- `maxDecoderBytes` must be at least `decoderSnapshotInfo.bytes`
  (about 2.5 MB). `@dambi/core/decoders` is a separate entry point, so apps that
  supply their own snapshot do not bundle it.
- The limits above are a starting point for hosts, not values Core enforces as
  defaults.
- `POST /v1/audit` (verdict reporting) requires an API key and is optional.

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

The explicit flow follows the C1 public contract:

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
    // Or use await core.check(request, { signal }) to coordinate these steps.
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
Cancelled or failed checks consume their plans and retain pinned audit metadata
when a plan was issued. A disposed instance rejects ongoing and new checks.

`check` caches raw responses by chain, method and recursively sorted parameters,
including any block selector in those parameters. Cache hits keep the original
`observedAt` and are revalidated by Native Core. Entry count is bounded by
`maxPlanCalls`; keys and values together are bounded by `maxFactBytes`. Successful
policy refresh clears the cache; older in-flight checks cannot repopulate it.
Only non-optional calls with projection outputs seed the cache: an evaluated
verdict does not prove that optional projections succeeded. Optional calls can
reuse a previously validated required response for the same key; otherwise they
are fetched again instead of caching a potentially incomplete response.

Hooks receive immutable copies. `onPending` runs for safely copied check requests;
`onVerdict` runs once for each returned check/evaluate verdict, and
`onAwaitingUser` runs for warnings. Hooks are notifications, not approval gates:
their promises are not awaited. Throws and rejections emit `hook_error` through
`onDiagnostic`; a failing diagnostic hook is contained without recursion.

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
Unsupported requests reject `plan`; their `check` verdicts have
unavailable metadata.

`policyVersion` is the decimal string of the **pinned snapshot's integer
sequence**; `engineVersion` identifies the engine used for that verdict. Missing
metadata stays local rather than being sent to the current audit API. The host
supplies event IDs, authentication and HTTP delivery; delivery failure does not
change a decision.

## Development checks

From the repository root (Rust, the wasm32 target and wasm-pack are required):

```sh
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

`npm run sdk:verify:isolated` performs these C6 checks in a temporary copy of the
listed SDK sources, without extension/server/legacy WASM sources or existing
build output. It installs dependencies and builds the Native runner and SDK
WASM there. Product snapshot generation and final tarball/browser release
verification remain separate.

User verification (2026-09-28, local C6 before the review corrections):
`sdk:verify:isolated` reached its final success marker, including Native session,
WASM/types/runtime/check, package dry-run and source isolation. No failures or
skips; individual test totals were not supplied. Separate C4 Decoder unit-test
output remains unshared; C4 Store and the integrated snapshot path are verified.

Review corrections (2026-10-05): unavailable audit metadata now emits its
diagnostic; cache insertion requires evidence of successful required projection.
User verification after rebuilding: `check.test.mjs` passed 8/8, with zero
failures, cancellations, skips or todo cases. No remaining issue in this change
scope was reported. The isolated check builds its own copy; rebuild local `dist`
with `core:build` when using a checkout with changed sources.

## Coverage and license

Core routes transactions through the supplied resolved Decoder snapshot, including
multicall trees, and uses the existing strict ERC-20 Permit typed-data path.
Other typed contracts, untyped signatures, venue orders and contract creation
reject `plan` with `UNSUPPORTED_REQUEST`; no permissive typed-data fallback is
used. `check` maps unsupported requests to an explicit warning with unavailable
audit metadata. Installation of a bundle does not certify every request path it describes.
Method-specific Fact value validation remains the provider's responsibility;
Core validates plan binding, provenance shape, age and required projections.
Product scope and release verification remain separate from these fixed tests.

Apache-2.0; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
