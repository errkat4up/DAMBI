# @dambi/core

Pre-sign policy core for Web3 wallets. Hosts provide signed policies and method
responses; Core decodes requests, plans Fact calls and returns allow/warn/deny.

## Status: 0.1.0

First runtime release. `createCore`, `check`, `plan`, `evaluate`,
`refreshPolicies`, `refreshScam` and `dispose` run on this package's Rust/WASM runtime.
`check()` coordinates planning, Fact fetching, bounded in-memory cache and
evaluation. A Registry decoder snapshot ships as `@dambi/core/decoders`, and
policies are served signed by the Dambi API (see
[Connecting to the Dambi API](#connecting-to-the-dambi-api)). Verification
records are under Development checks below.

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

// The publisher must issue fresh bundles within maxBundleAgeSec (72 hours).
// Refreshing alone does not extend a previously signed bundle's lifetime.
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

## Optional policy HTTP adapter (development)

The checkout provides `createPolicyApiSource` through the separate
`@dambi/core/adapters` entry point. This addition has not been published yet.

```ts
import { createPolicyApiSource } from "@dambi/core/adapters";

const policy = createPolicyApiSource({
  baseUrl: "https://policies.example", // API origin from host configuration
  maxResponseBytes: 2_000_000, // Example HTTP wrapper limit, in bytes
});
// Pass policy as CoreConfig.ports.policy; retain local trust and decoder settings.
```

The source requests `/v1/bundle?profile=default`, maps `key_id` to `keyId`, and
preserves the signed payload string. Core still verifies the signature and
bundle validity. The wrapper limit is separate from Core's `maxPolicyBytes`.
Use an HTTPS origin; loopback HTTP is allowed for local development. Optional
`headers` and `fetch` are captured at construction. Redirects are rejected.

The source keeps an ETag and envelope together and reuses that exact envelope
on a matching conditional request's 304 response. Each call captures its own
cache pair; late responses cannot overwrite a newer request's cache state.
ETags do not authenticate policies or extend their lifetime: Core rechecks the
returned bundle. Missing, inaccessible or malformed ETags disable conditional
reuse. The source bypasses the browser HTTP cache and does not retry requests.
Direct callers can pass `policy.fetch({ signal })` for cancellation/deadlines
and inspect `AdapterError`; Core normalizes a rejected policy source to
`POLICY_FETCH_FAILED`.

### Manual staging connection check

From the repository root, use the existing built workspace package:

```sh
npm run core:verify:policy-api -- --config fixtures/sdk/policy-api.staging.json
```

The explicit staging config contains this README's public API address and pinned
policy key. The command initializes Core, evaluates a no-Fact USDC unlimited
approve against `unlimited-approval-deny`, refreshes, and evaluates again. It
makes two GET requests and performs no build, signing, publishing or chain RPC.
It is opt-in and is not part of routine CI or the published package.

The JSON result reports `status: "passed"` only after both phases succeed, with
HTTP status and verified policy sequence/issuance/expiry (Unix seconds). Refresh
may return 200 or 304. The system clock and Core's default 72-hour maximum age
remain in effect. `POLICY_EXPIRED` requires checking publication freshness with
the API owner; it is not bypassed by this command. Its `policyTimeDiagnostic`
shows the candidate's dates and local clock for diagnosis, not a passed check.
CORS headers are observed from
Node; the standalone consumer gate below checks browser behavior with local
fixtures. Check deployed CORS for your browser origin. The deployment's republishing
schedule needs separate operational confirmation.

## Optional ERC-20 Fact adapter (development)

`createEvmFactProvider` implements `FactProvider` for `portfolio.balance` calls
whose resolved params contain an ERC-20 TokenRef. A2 includes Core/HTTP integration
tests and the opt-in RPC check below. Browser consumption uses the standalone consumer gate below.

```ts
import { createEvmFactProvider } from "@dambi/core/adapters";

const fact = createEvmFactProvider({
  chains: { "eip155:1": { rpcUrl: "https://rpc.example/v1/host-configured" } },
  maxResponseBytes: 16_384, // Example response limit, not an operational default
});
// Pass fact as CoreConfig.ports.fact. Direct callers supply planId and signal:
// const batch = await fact.fetch(plan.calls, { planId: plan.planId, signal });
```

Each fetch checks `eth_chainId`, obtains a block height per chain, and uses that
explicit height for `balanceOf` calls, with at most four HTTP requests in flight.
Facts contain `{ balance: "0x64" }`, a decimal `blockNumber`, a fixed chain/method
source label and the request-start `observedAt`. Core applies the projection.
The provider has no Fact cache, retry or failover. Unsupported calls, explicit
block selectors and individual RPC errors are omitted. A successful sibling
survives; Core decides required/optional behavior. If all supported calls are
unavailable due to chain preparation or network/HTTP failures, fetch rejects.
Bad plan/call IDs reject with `AdapterError` code `INVALID_REQUEST`; cancellation
rejects the whole fetch with `ABORTED` and stops queued work.

Use HTTPS, or loopback HTTP for local development. Endpoint paths and queries are
preserved. Per-chain `headers` and optional `fetch` are copied/captured at
construction. Redirects and cookie authentication are disabled. If supplying
`clock: { now() }`, use the same Unix-millisecond clock as Core. Direct consumers
provide their deadline with an AbortSignal; Core already supplies its own.

### Manual EVM RPC connection check

Use the existing built Core package (including its packaged WASM/decoders):

```sh
npm run core:verify:evm-fact -- --config fixtures/sdk/evm-fact.mainnet.example.json
```

This explicit example uses the [PublicNode Ethereum endpoint](https://ethereum.publicnode.com/),
[Circle's mainnet USDC contract](https://developers.circle.com/stablecoins/usdc-contract-addresses)
and the fixed `0x000000000000000000000000000000000000dead` owner. It requires no
API key or personal wallet address. The RPC provider receives the queried address
and network connection as with any direct RPC read.

The command signs a fresh **local test policy bundle** with the existing test-only
fixture key, then evaluates an unsigned transfer request for 100 raw token units.
It does not publish a policy, sign a wallet transaction or submit a transaction.
The original catalog policy remains optional and Day-1 is unchanged.

The adapter makes three reads: chain ID, block height and `balanceOf`. Two further
direct reads check the chain and balance at that same block using separate parsing.
Success requires one real Fact, matching provenance and the expected Core decision:
`warn` when the observed balance is exactly 100 raw units, otherwise `allow`.
An optional-policy `allow` with no Fact is a failed probe. The configured 15-second
deadline covers Core initialization and RPC work; responses are bounded to 16 KiB.

`status: "passed"` with `connection: "remote-rpc"` records a completed external
connection check. Loopback regression tests report `connection: "loopback-fixture"`
and do not establish live success. Same-block agreement checks consistency within
one RPC service, not data authenticity or finality. Browser consumption uses the standalone consumer gate below.

For a private endpoint, put its URL and optional `headers` in
`fixtures/sdk/evm-fact.local.json` (Git-ignored), and pass that path explicitly.
The report omits endpoint URLs, headers, raw responses, owner/token addresses and
key material. The live command is never run automatically by CI; CI uses only
loopback fixtures. Missing configuration or package artifacts fail with a nonzero exit.

## Optional Scam Filter data adapter (development)

`createScamFactProvider` from `@dambi/core/adapters` wraps an existing
`FactProvider` through its `policy` option. Assign the wrapper to `ports.fact`;
ordinary policy batches are delegated unchanged and `scam.*` batches use the
dedicated data path. Do not combine the two channels into one batch. Manual
evaluation fetches `plan.calls` and `plan.scamCalls` separately and passes the
second batch as the third argument of `core.evaluate()`.

Configure one chain through `rpc`, explicit `history`/`profile` builder limits,
and whole-fetch `limits` (`timeoutMs`, `maxCalls`, `maxTargets`, `maxRequestBytes`,
`maxResultBytes`). Share Core's clock if overriding it. RPC request/byte/log caps
apply per reference group; the deadline and output-size cap cover all groups.
Each history/profile pair shares a fixed reference and is withheld until the
final block-hash checks pass. Cross-fetch raw-log reuse is opt-in through
`rpc.historyCache: { maxEntries, maxBytes, ttlMs, maxBlockSpan }`; all four limits
must be positive integers. The cache belongs to this provider instance and stores
complete log scans, including empty scans, rather than Facts, state values or grids.
`maxBytes` bounds serialized entry bytes, not JavaScript heap usage.

With the cache enabled, `await provider.prepare(scamCalls, { planId, timeoutMs,
signal })` prepares history using a separate 1–60,000ms budget. Supply complete
history/profile call pairs from a preparation plan. The call returns no analysis
or Facts. Before signing, create a **new plan** and fetch through the same provider;
the ordinary fetch still uses its configured deadline (e.g. 2,500ms). Preparation
is an explicit host action, not an automatic background task or a deadline extension.
Preparation and fetch use the same verification mode and resource caps.

A later fetch downloads only missing log ranges, rereads current reference/state,
rebuilds snapshots and rechecks the original cache boundaries. Complete hits do
not extend the entry's TTL. Reorgs invalidate the cache; cancelled or failed raw
batches cannot publish drafts. An independently verified raw scan can survive a
later provider-level result-size failure. Expiry, capacity eviction or an absent
overlap requires cold work and can still exhaust the signing deadline.

`rpc.verification` is copied at provider creation. Its defaults are
`{ history: "all_event_headers", stateBinding: "number_recheck" }`.
Opt into `history: "rpc_anchor"` to omit final header reads for blocks known only
from logs. Checked head, reference, queried headers and state-read blocks still
receive final hash/time checks. Pending timestamp-header lookups count toward
both their initial reads and final checks. Log scope, identity, conflicts and
overall timestamp ordering remain checked in both modes.

`rpc_anchor` trusts the endpoint's log-only hashes and timestamps without comparing
each against a header. It can miss an internally consistent log from a different
branch; neither mode independently proves log completeness or authenticates log
contents. Missing timestamps, boundary searches and profile events can still
require many actual header reads. There is no automatic mode switch on error or
budget exhaustion. `block_hash_canonical` remains unsupported and is rejected as
invalid configuration. This is a provider execution contract, not a new Core policy.

Successful built-in method values include version-1 `verification` metadata:
the modes, raw timestamp source kinds (`header` / `rpc_log`), reuse status,
original collection time range and final verification time. `timeSources`
describes raw evidence supplied to each method, not the source of every output
grid point; a final header check does not erase an original log timestamp source.
Current fresh batches use `reuse: "none"` and their original `observedAt` for
both collection-range endpoints. A method reusing logs declares
`reuse: "interval_cache"`, preserving the original raw collection range while its
Fact and final verification are fresh. Reuse is recorded independently for history
and profile. Metadata is included in the output-size limit.

Core retains the declarations in `binding.verification` with status `declared`.
Legacy inputs omitting metadata on both methods produce `legacy_unspecified`;
explicit null, partial/unknown metadata or incompatible method declarations are
invalid scam input. Collection times must be ordered and no later than the final
check; that check cannot predate `Fact.observedAt` or exceed allowed clock skew.
Fresh (`reuse: "none"`) observations cannot predate that Fact's collection start.
These are checked provider declarations, not cryptographic proof of source data.
Rebuild the matching Rust/WASM with TypeScript: older Core artifacts reject the
new wrapper fields. The pure algorithm's wire contract remains version 1.

`rpc.limits.minRequestIntervalMs` sets minimum request-start spacing (default 0
for compatibility). Spacing and rate-limit cooldown are shared across batches
and retries of the same provider/source, not across separate instances or
processes. `retryDelayMs` is the exponential backoff base; optional
`maxRetryDelayMs` defaults to the greater of 30,000ms and the base. HTTP 429 and
RPC -32005 also pause sibling requests, including when retries are exhausted.
A valid 429 `Retry-After` (seconds or IMF-fixdate) is honored even if longer than
the backoff cap. All waits consume the existing deadline and are cancellable;
late replies cannot extend cooldown. Request counts include actual starts only.

Factory and administrator capabilities are optional trusted configuration,
not assumptions inferred from a matching topic. Missing configuration leaves
age unknown and requested administrator events unavailable. `ScamDataError`
preserves sanitized advisory failure reasons without changing policy failure
semantics. `onMetrics` reports data-path success/partial/failure, requests,
retries, completed response-body bytes, latency and result size. It excludes
algorithm execution and Core evaluation; observer failures do not affect results.
Failed runs also include an immutable `failure` diagnostic: provider operation,
RPC stage/method, error kind and available numeric HTTP status/RPC code/attempt.
No endpoint, headers, arguments or remote error text are exposed. Recovered
errors are not terminal causes, and success/partial runs omit this field.

Pool history can use optional RPC log timestamps to form an unpublished draft.
Missing timestamps retain the original header lookup; malformed or inconsistent
times are not substituted. Before publication, `all_event_headers` compares every
evidence block against an actual header with the matching hash and any recorded
timestamp. `rpc_anchor` omits that comparison for log-only blocks, retaining
comparisons for actual header/state reads and the reference points. All collected
timestamps still participate in the final ordering check. Neither mode guarantees
cold-history completion within the configured budget.

`onMetrics.preflight` records the last known-work budget check in `preflightGroup`
(one-based reference group). It counts unique log blocks, timestamped blocks,
uncached header reads and final rechecks, plus remaining request/time budgets
and the minimum pacing delay. The history checkpoint excludes later profile/target
work. After collection finishes, the check is refreshed with the frozen final
target list, including evidence added by those later operations. The same selector
supplies both budget checks and final verification; shared heights are checked
once and the reference block is checked last. Neither checkpoint predicts network
latency or retries. Impossible request or pacing budgets fail with `resource_limit`
at stage `preflight`, before the corresponding header reads. The separate builder
header-lookup cap and all existing deadlines still apply.

This data adapter neither installs a scam bundle nor provides an algorithm.
Bundle installation uses the separate signed source described below; actual
algorithm linking remains separate. For manual read-only RPC measurement,
after building TypeScript from the repository root:

```sh
node scripts/sdk/scam-data-probe.mjs
```

The probe keeps `all_event_headers` as its default. To explicitly diagnose the
`rpc_anchor` cold path with the same history window and resource caps:

```sh
SCAM_HISTORY_VERIFICATION=rpc_anchor SCAM_TIMEOUT_MS=60000 SCAM_REPEATS=1 \
  node scripts/sdk/scam-data-probe.mjs
```

The 60-second budget is diagnostic, not the product's 2,500 ms acceptance budget.
Reports distinguish requested verification settings from each returned method's
performed modes. The last preflight's `finalRecheckRequests` is its selected
target count; `additionalHeaderRequests` is pending work, not cumulative timestamp
fallback requests. It is zero at the final checkpoint after collection completes.

To measure preparation separately from a subsequent 2,500ms data fetch:

```sh
SCAM_HISTORY_VERIFICATION=rpc_anchor SCAM_HISTORY_CACHE=1 \
SCAM_PREPARE_TIMEOUT_MS=60000 SCAM_TIMEOUT_MS=2500 SCAM_REPEATS=1 \
  node scripts/sdk/scam-data-probe.mjs
```

The probe uses bounded in-memory storage (8 entries, 16,000,000 serialized bytes,
120-second TTL, 100,000-block maximum span). `preparation` is excluded from the
fetch trials and `summary.targetBudget`; a preparation failure skips fetch trials.
Read each returned method's `verification.reuse` to confirm an actual hit. A
`partial` fetch within budget is still incomplete coverage. These measurements
exclude the algorithm and Core evaluation and cannot establish the full signing SLA.

For a short consecutive-fetch check, use the same command with `SCAM_REPEATS=3`.
Each returned Fact keeps `referenceBlock` and adds a validated
`reference: { number, hash, timestampMs }`. A zero-based `targetIndex` is included
only when the result matches the requested identity. `referenceRelation` compares
that method/target with the immediately preceding completed fetch: `same`,
`advanced`, `changed` or `unknown`. The first fetch, including after preparation,
has no reference baseline. A failed or missing predecessor is not skipped.
`same` requires matching height, hash and timestamp; `advanced` requires a higher
height, different hash and nondecreasing timestamp. `changed` is not a confirmed
reorg. Check `verification.reuse` separately: reference advancement alone does not
prove reuse or ancestry. Exact reused/downloaded block ranges and cumulative
timestamp-fallback request counts are not reported.

For the **AH5-2 extension Service Worker diagnostic**, build the manual console
bundle from the repository root after the two probe test files pass:

```sh
node --test packages/core/tests/adapters/scam-data-probe.test.mjs \
  packages/core/tests/adapters/scam-sw-diagnostic.test.mjs &&
node browser-extension/scripts/build-scam-sw-probe.cjs &&
pbcopy < browser-extension/dist/diagnostics/scam-sw-probe.js
```

This uses the existing Core adapter build; it does not rebuild WASM or the full
extension. Open Dambi's **Service Worker → Inspect** from `chrome://extensions`,
paste the copied bundle into that worker's console, then run:

```js
dambiScamProbe.start();
await dambiScamProbe.prepare();
await dambiScamProbe.fetch();
await dambiScamProbe.fetch();
await dambiScamProbe.fetch();
console.log(JSON.stringify(dambiScamProbe.report(), null, 2));
```

Copy and save the printed JSON report. Use `console.log` rather than the
DevTools-only `copy()` helper, which may be unavailable in this execution context.
If only the output command fails, run the `console.log` line separately; do not
restart preparation or repeat the fetches. The same provider serves each call, with a separate
60-second preparation budget and 2,500ms fetch budget. Installation and `start()`
make no RPC calls. A failed preparation prevents fetches; failed fetches remain
in the report. Re-pasting or calling `start()` again cannot reset the session.
The cache TTL is 120 seconds, so run the prepared fetches promptly; a miss after
TTL expiry is not a worker-restart failure. Inspect actual history `reuse`,
reference identity, coverage, latency and failures independently.

To check worker recreation, wait for calls to finish, close its DevTools, reload
**Dambi** on `chrome://extensions`, and open its new Service Worker console. Before
pasting the bundle again, record the result of:

```js
typeof globalThis.dambiScamProbe // expected: "undefined"
```

Repeat the `pbcopy < ...` command above and paste the same bundle again, then
measure one explicitly cold fetch:

```js
dambiScamProbe.start({ SCAM_TIMEOUT_MS: "60000", SCAM_REPEATS: "1" });
await dambiScamProbe.fetch(); // intentionally do not call prepare()
console.log(JSON.stringify(dambiScamProbe.report(), null, 2));
```

Compare `workerSessionId` between reports and require the returned cold history
to say `reuse: "none"` before claiming a cold fetch was observed. If that fetch
fails, retain the failure; a new worker ID alone does not prove data retrieval.
The cold 60-second diagnostic is excluded from the prepared 2.5-second target.
Reload verifies worker recreation, not natural idle suspension (DevTools may
affect lifetime). This diagnostic is not installed in the production manifest or
transaction path and does not establish full signing-check performance.

The probe defaults to GIWA Sepolia, one known pool, a 24-hour window plus one-hour
warm-up, a 2,500 ms budget and one uncached attempt. Defaults are diagnostic inputs,
not calibrated risk policy. Probe request spacing is explicitly 100ms, with
1,000ms retry base, 8,000ms backoff cap and one retry. Override these diagnostic
settings using `SCAM_RPC_MIN_INTERVAL_MS`, `SCAM_RPC_RETRY_BASE_MS` and
`SCAM_RPC_RETRY_MAX_MS` (0–60,000, cap >= base). Pacing may exhaust the unchanged
budget; it does not guarantee completion of a cold 24-hour scan.
Unknown age/unsupported admin coverage is expected
without deployment capabilities. Use `SCAM_RPC_URL`, `SCAM_REPEATS` (1–20),
`SCAM_TIMEOUT_MS`, or `SCAM_TARGETS_JSON` (up to four explicit
`{pool, token, quoteToken, factory}` objects) when needed. Never add private
endpoint credentials to tracked files. Reports omit endpoints and headers;
failures remain in the denominator and small-sample percentiles are not production
performance claims. Node reachability does not establish extension reachability.

## Signed Scam Filter bundles (SF5-1, development)

The signed configuration channel is separate from policy snapshots and market
data. Compose it with the existing policy source and retain local `scam.settings`,
`scam.limits` and `scam.trust` configuration:

```ts
import { createPolicyApiSource, createScamBundleApiSource } from "@dambi/core/adapters";

const policySource = {
  ...createPolicyApiSource({ baseUrl: hostApiOrigin, maxResponseBytes: 2_000_000 }),
  ...createScamBundleApiSource({ baseUrl: hostApiOrigin, maxResponseBytes: 2_000_000,
    env: "staging", profile: "default" }),
};
// CoreConfig.ports.policy = policySource; CoreConfig.scam = localScamConfig.
// createCore attempts an initial scam fetch only when both are configured.
await core.refreshScam(); // Subsequent refresh; separately cancellable from refreshPolicies.
```

`GET /v1/scam-bundle?env=staging&profile=default` selects latest; optional
`sequence` is a canonical decimal string. The HTTP wrapper is
`{payload, signature, key_id?}`; the SDK retains the original payload string and
maps `key_id` to telemetry-only `keyId`. HTTP ETags are independent per source.
The new endpoint must be deployed before using it remotely; this change does not
publish a service, register a production key or issue an onchain attestation.

Core verifies original UTF-8 bytes using P-256/SHA-256 and padded Base64 P1363
signatures against locally configured `scam` role keys, distinct from policy and
Decoder trust keys. It checks scope, validity, compatibility, rules, resource
bounds and sequence before replacing the snapshot. Compatibility accepts `*` or
the exact version; the current builder is `dambi-v2/1`. Lower sequences and changed
payload bytes at the same sequence are rejected. Identical payload bytes at the
same sequence are idempotent. New plans receive the replacement; existing plans
retain their snapshot and still enforce its expiry. Sequence memory is scoped to
the current Core instance.

`refreshScam()` uses `policyTimeoutMs` for bundle retrieval, not `scamTimeoutMs`
for market analysis. A failed refresh leaves policy and the previous scam
snapshot unchanged; expiry still makes scam evaluation `insufficient`. Initial
scam-source failures emit `scam_bundle_unavailable` and preserve policy service.
Caller cancellation still rejects initialization. Missing scam configuration
performs no scam fetch. Bundle installation does not supply an algorithm:
active supported rules with no module report `algorithm_unavailable`, never
`quiet`. Uncalibrated R1/R2 remain disabled in default-purpose presets; explicit
demo-purpose presets may enable them.

Local issuance uses `registryV2/scripts/publish-scam-bundle.ts` with an explicit
scam-only key path/ID and a complete payload draft:

```sh
SCAM_SIGNING_KEY_PATH=/explicit/scam.hex SCAM_SIGNING_KEY_ID=scam-staging-1 \
  npm --prefix registryV2 run publish:scam-bundle -- \
  --input /absolute/draft.json --env staging --profile default --out /absolute/output
```

This writes immutable `scam-bundles/<env>/<profile>/<sequence>.json` plus an
atomically replaced `latest.json`; it does not upload files or generate keys.
The publisher checks basic draft structure; the consuming Core remains the
authority for full rule/compatibility validation. The Registry API serves those
paths verbatim with independent cache keys. Production deployment and key
provisioning require their own configured environment.

## Standalone Node and browser consumers

The [adapter example](../../examples/sdk-adapters/README.md) combines the policy
HTTP and EVM Fact adapters using the public package exports. The consumer gate
installs an actual tarball outside the repository and exercises Node, standalone
TypeScript declarations and Chromium with local cross-origin HTTP/RPC services.
It does not contact the staging API or PublicNode and does not rebuild Core.

Install the pinned test tooling and its Chromium binary once:

```sh
npm ci --prefix scripts/sdk/consumer-tools --ignore-scripts --no-audit --no-fund
node scripts/sdk/consumer-tools/node_modules/playwright/cli.js install chromium
```

Then use the existing built package, or pass an explicit release candidate:

```sh
npm run core:test:consumers
# npm run core:test:consumers -- --tarball /absolute/path/dambi-core-0.1.0.tgz
```

After Node/types have passed, `npm run core:test:consumers -- --browser-only`
reruns only the five Chromium groups. The default still runs all ten groups.
The browser fixture uses CSP to restrict connections to local origins without
intercepting requests, so actual CORS preflights reach the HTTP servers.

CI's `core-consumers` job reuses the tarball from the isolated `core` build.
The release workflow checks and publishes the same tarball. These checks cover
local browser CORS behavior; a deployment's API/RPC CORS and access policy still
need verification for its chosen origin.

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
remain distinct. The packaged `@dambi/core/decoders` snapshot is generated
from the Registry (`npm run build:decoder-snapshot` in `registryV2/`) and contains
only bundles Core installs. Its `snapshot.meta.json` records source-context
exclusions and rejected bundles. The generator also supports checked incremental
additions with `--add-manifest`; this preserves the saved baseline and requires
the whole candidate to install. It does not regenerate that baseline from source.
The [bundle plan](../../docs/sdk-migration/bundle-development-plan.md) tracks
remaining materialization work and the raw request paths actually verified.

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

For changes confined to the adapter transport, rebuild TypeScript and run the
adapter suite below. Its Core integration cases reuse the existing packaged
WASM; run `core:build` first only if that artifact is absent or Rust has changed.

```sh
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.build.json
npm run core:test:adapters
```

`core:test:runtime` first prepares the selected decoder fixtures with the shared
SDK generator. It requires the Native runner (including its `--canonicalize`
mode) and built Core, and does not build either automatically.

`npm run sdk:verify:isolated` performs these checks in a temporary copy of the
listed SDK sources, without extension/server/Registry/legacy WASM sources or
existing build output. It installs dependencies and builds the Native runner
and SDK WASM there. The decoder check preserves the committed 799-bundle
baseline, rebuilds the selected UR/Aave additions from five pinned originals,
checks exact equality with the 804-bundle product and packages that result.
It also generates three separate pool regression bundles for Native/WASM raw
policy checks. This is selected-input reconstruction, not regeneration of the
entire Registry corpus. It emits an actual tarball; the separate
`core:test:consumers` gate checks its Node and browser consumers.

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
The packaged snapshot covers the Registry decoders Core installs today; a
request outside it gets `UNSUPPORTED_REQUEST` from `plan` and a warning from
`check`.

Apache-2.0; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
