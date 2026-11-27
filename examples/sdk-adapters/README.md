# Installed adapter consumer

`client.mjs` combines the public `@dambi/core`, `@dambi/core/decoders` and
`@dambi/core/adapters` exports. Node and the browser use the same function:
`await createAdapterCore(settings, { signal })`; the caller disposes the returned
Core. Requests are evaluated only; no wallet transaction is signed or submitted.

Copy this directory **outside the repository**, install an actual Core tarball
there, then run the Node entry with files you prepared locally:

```sh
npm install --ignore-scripts --no-audit --no-fund /absolute/path/dambi-core-0.1.0.tgz
node node.mjs --config /private/path/consumer.json --request /private/path/request.json
```

Settings have exactly these sections: `policy: { baseUrl, maxResponseBytes,
headers? }`, `fact: { chains: { "eip155:1": { rpcUrl, headers? } },
maxResponseBytes }`, `trust`, `limits`, and `enforcement`. The last three follow
the public `CoreConfig` types. Pin policy-role **public** keys from a trusted
publisher; they are never selected from a server response. Use explicit limits,
including `maxDecoderBytes >= decoderSnapshotInfo.bytes`. Requests follow
`CheckRequest` (for example a raw `transaction` with `chainId`, `from`, `to`,
`data`, and `value`). `consumer-types.ts` checks these installed public types.

For the browser, serve the copied directory over loopback HTTP or HTTPS, open
`index.html`, and fill its settings and request before selecting **Check**.
For example, Python's standard server can serve a local copy:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

The import map points only to the installed package under `node_modules`; keep
its `dist` layout and WASM assets intact. The browser form starts without endpoint
URLs or trust keys and sends no policy/RPC request until Check. Cancel aborts the
operation; all paths dispose Core. No settings are persisted by the example.

Use endpoints approved for public browser access or a host proxy. The example
rejects custom headers, URL userinfo and query strings; this conservative sample
guard cannot detect every credential embedded in a URL path. Verify that paths
contain no secrets. These are example restrictions, not adapter API restrictions.
Keep credentials on a host proxy and configure its CORS for the consumer origin.
Allow RPC `Content-Type` preflight; expose policy `ETag` and allow
`If-None-Match` when enabling revalidation. Without an exposed ETag, regular 200
policy responses still work. A Node credential file must never be copied into the
served directory or pasted into the browser. The example limits are demonstration
values, not operational recommendations.

Automated consumption checks use local policy/RPC servers and a temporary
tarball installation. Test signing keys stay in the Node fixture process; the
browser receives only the signed envelope and public verification key. They do
not validate a production deployment's CORS or RPC authenticity. A verdict with
`source: "fail_closed"` represents a failed evaluation even if the command/UI
returned successfully; inspect `decision`, `source`, and `diagnostics` together.
For the repository's verification command and tool setup, see
[Standalone Node and browser consumers](../../packages/core/README.md#standalone-node-and-browser-consumers).

## Interpretation and signing review

Both consumers now use `describeCheck()` from `client.mjs`. Node keeps the original
verdict on stdout and writes the interpretation summary to stderr. The browser
shows the summary alongside the unchanged verdict. Neither consumer signs.

An `allow` without a forbid reason is not evidence that a policy matched. The
summary uses diagnostics, not an empty `reasons` array, to distinguish policy
non-matches. `partial_decode` remains distinct from `unsupported_request` and
`source: "fail_closed"`. An independent policy deny is retained in the original
verdict and summary even when interpretation is partial. Enforcement is displayed,
not overridden by the example.

`reviewEligible` requires an evaluated allow without diagnostics. It is only an
example host review gate, not a new Core blocking rule. Signing also requires the
host to validate the exact request, active policy/trust state, enforcement and
user authorization. `signingAuthorized` is always false in this evaluation-only
example. A Fact-related timeout is reported as `fact_evaluation_failed`; this
label does not assert that every timeout originated in a required RPC call.

### F2 candidate / QA handoff — not acceptance evidence

This candidate changes swap quote-relative slippage and swap live observations:

| Input | Expected behavior | Regression | Actual result |
| --- | --- | --- | --- |
| Missing derived slippage | Absent, not zero | `swap_missing_slippage_is_not_an_explicit_zero` | Not run |
| Explicit slippage zero | Preserve zero | Same test; lowering observation test | Not run |
| Live source without value/time | No observed value or generated observation time | `swap_observations_require_values_and_original_times_for_each_field` | Not run |
| Dormant swap source with unresolved placeholder or unevaluable function, external and inline layouts | Preserve signed intent and zero output floor; do not evaluate the source recipe | `swap_dormant_sources_do_not_invalidate_signed_intent` | Not run |
| Explicit swap observation with unresolved source | Retain validation error; do not silently discard the observation | Same builder regression | Not run |
| Explicit live zero with original time, including epoch | Preserve zero and supplied time | Same test | Not run |
| Positive output floor, no quote | Omit quote-relative slippage | `missing_swap_observations_are_omitted_but_real_zero_is_preserved` | Not run |
| Explicit zero output floor, no quote | Keep `minAmountOut=0`; expose unbounded slippage | `explicit_zero_floor_is_unbounded_even_without_a_quote` | Not run |
| Complete approve evaluation | Evaluated summary; no signing authorization | Packaged `check.test.mjs` | Not run |
| Partial tree with independent deny | Partial summary retains deny | Packaged sibling-deny regression, both child orders | Not run |
| No matching policy | Policy-unmatched summary; no new Core deny | Packaged unmatched-policy regression | Not run |
| Missing required Fact | Failed Fact evaluation, not a successful interpretation | Packaged required-Fact regression | Not run |

**F2 is not complete.** Remaining integration work includes non-slippage
`$resolved`/`$derived` fallback identities, non-swap LiveField skeletons,
transaction-meta gas observations, static route descriptions without simulation
provenance, all Rust construction/consumption sites for the changed swap fields,
and schema/evaluation handling of absent swap context attributes. In particular,
this candidate must not be described as proving that every supported raw path
avoids `INVALID_REQUEST` or preserves independent denies with missing swap data.
Those require the native/session and packaged WASM regressions against the same
candidate, including the real selected decoder fixtures. No generated decoder
snapshot or metadata bytes are included.

### Review blocker and required scope handoff

The supplied review reports native/WASM compilation failures at parent
`945e1dbd54cb5dea9826365f25167566ec666610` (CI `45836838677`):

- `crates/asset-model/transition/src/effect/amm/swap.rs:36`: E0609,
  direct `route.value` access after the route became optional.
- The same file at line 86: E0277, `FixedBytes` versus `Address` comparison.

That transition file is outside this card's allowed edit paths and its contents
were not supplied. This revision therefore does **not** claim to repair either
compilation failure. Restoring a mandatory route using a fabricated empty route
or observation timestamp would violate F2 and is not an acceptable compatibility
fix. A wrapper that merely makes unchecked `.value` access compile would also
hide the missing-observation condition from the reducer.

Required next scope: supply and authorize
`crates/asset-model/transition/src/effect/amm/swap.rs` and its reducer regression
callers. The reducer must explicitly handle an absent route without calculating
successful swap effects from invented observations, preserve the observed-route
behavior, and compare the actual address types at the reported comparison site.
Tests must cover absent-route behavior and observed-route effects. Inspect the
actual reducer error/result interface before choosing that implementation; no
unseen error variant or caller contract is assumed here. Schema/session handling
of absent attributes remains a separate integration gate, not a reason to fill
missing attributes with zero.

Within the supplied paths, this revision prevents dormant swap source recipes
from being evaluated before observation detection. It adds a typed builder
regression for external and inline source layouts, original epoch provenance,
explicit zero, and validation of supplied observations. It also reformats the
identified F2 mapper/lowering additions without removing assertions. This is an
incremental candidate, not a buildable-completion or acceptance claim.

Regression execution, the complete `cargo fmt --all --check`, native/WASM builds,
QA actual-result entries, and independent `dambi-review` approval remain pending.
The CI failures above are supplied review feedback, not locally reproduced
results. No build, test, review, commit, push, or live operation is claimed by this
handoff.

### Follow-up at `b1528c5d0fd4f5f5ae692b30dcc091e67ad68a11`

Status: **incremental consumer correction; F2 implementation and CI repair remain
blocked**, not an implementation-complete submission.

The supplied feedback reports failure of CI run `45938135660`, but supplies no
job log or compiler diagnostics for that run. Its failure cannot be attributed
to a particular check from the URL alone. The earlier reducer failures documented
above remain unresolved by this patch; no newer failure details are inferred.

The consumer's factory JSDoc was separated from `createAdapterCore` by the added
`describeCheck` function. This patch reattaches the settings/options/return
contract to the factory and types the presentation helper directly from the
public `DambiCore.check` return type. It does not change Core decisions or
substitute a compatibility wrapper for absent swap observations.

The packaged real-WASM regressions additionally check presentation of unsupported
requests, malformed requests, and an independent policy deny alongside a sibling
Fact-fetch failure in both child orders. Expected results are respectively
`unsupported_request`, `evaluation_failed`, and `fact_evaluation_failed`; none is
eligible for signing review, and the independent deny remains visible. Actual
results: **not run**.

To repair the known Rust integration blocker, supply and authorize
`crates/asset-model/transition/src/effect/amm/swap.rs`, its error/result interface,
and affected reducer construction/tests. Supply the failing job excerpts from
run `45938135660` as well. The currently supplied action model makes `route` an
`Option<LiveField<SwapRoute>>`; changing it back to a fabricated observed route
would violate the acceptance criteria. Completing missing-attribute evaluation
also requires the actual swap Cedar schema and evaluation/session consumers,
with edit authorization for any required changes outside the current paths.

No CI log inspection, build, test execution, independent approval, commit, push,
or live operation has been performed. QA execution and `dambi-review` approval
must cover the eventual same integrated candidate, not this blocked partial
patch.

## Measuring a complete SDK check

`check-timing.mjs` measures one `core.check()` call with `performance.now()`. It
includes planning, policy/scam Fact work, evaluation and synchronous notifications
through the returned verdict or rejection. Initialization, any earlier
`provider.prepare()`, asynchronous notification work, reporting and UI rendering
are outside this interval. Node prints the measurement separately to stderr and
keeps the verdict on stdout; the browser displays timing beside the result.

```js
import { checkWithTiming } from "./check-timing.mjs";

// Use the same already-configured Core/provider that prepared the history.
const verdict = await checkWithTiming(core, request, { signal }, (measurement) => {
  console.info(measurement);
});
```

The helper returns the original verdict or throws the original error. It reports
each invocation once; observer failures cannot replace the result. The 2,500ms
`targetBudgetMs` and `withinBudget` fields compare elapsed time only. They neither
change SDK deadlines nor certify a successful or complete risk analysis. Inspect
`outcome`, `source`, `scamStatus` and `analysisModes` together: `stub`, incomplete
data or a failed evaluation cannot establish actual-algorithm performance.

The default `createAdapterCore()` example configures ordinary policy adapters;
it does not install a Scam Filter bundle or algorithm. The same timing helper
works with a separately configured Scam Filter Core. AH5 integration tests use
the explicit test WASM/stub and synthetic RPC, so their durations demonstrate the
measurement boundary, not live signing performance. The existing
`scam-data-probe.mjs` still measures only provider work.
