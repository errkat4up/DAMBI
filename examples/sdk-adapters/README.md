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
verdict and summary even when interpretation is partial. A keyed `engine_error` on a child action is displayed as `evaluation_failed` even if its parent had no matching policy.
The summary preserves the original enforcement.

`reviewEligible` requires an evaluated allow without diagnostics. It is only an
example host review gate, not a new Core blocking rule. Signing also requires the
host to validate the exact request, active policy/trust state, enforcement and
user authorization. `signingAuthorized` is always false in this evaluation-only
example. A Fact-related timeout is reported as `fact_evaluation_failed`; this
label does not assert that every timeout originated in a required RPC call.

### F2 review #72 follow-up

The follow-up starts from `456c75d2` on `sdk/t_ea7de51d`. The focused
verification covers both Universal Router manifests through the native session
(4/4 tests), the built SDK's WASM check suite (10/10), and the reducer's
missing/declared/observed route case (1/1). The table identifies each assertion.

The earlier scope/compilation blockers recorded for `945e1dbd`, `b1528c5d` and
`30ffbd4c` are historical, not the current scope. The supplied transition source
now handles `route: None` with `ReducerError::MissingField("route")`, and uses the
address comparison `*hooks != Address::ZERO`. Its constructors use optional live
inputs. The transition file is authorized in this revision. Restoring fabricated
routes or timestamps is neither needed nor acceptable.

#### Supplied baseline results, not new-candidate evidence

The recorded checks for **456c75d2** are:

- [Actions 45941664465](https://github.com/errkat4up/DAMBI/actions/runs/45941664465):
  9/9 jobs successful.
- [Rust job 140317272800](https://github.com/errkat4up/DAMBI/actions/runs/45941664465/job/140317272800):
  the four named regressions in the table below reported `ok`; Native Core
  fixtures also succeeded.
- [Core job 140317272747](https://github.com/errkat4up/DAMBI/actions/runs/45941664465/job/140317272747):
  isolated SDK Native, WASM and runtime/check succeeded.
- Node/types/Chromium tarball consumer job `140319002777` succeeded.
- VM QA #72: two TypeScript checks, decoder regeneration and Node 52/52;
  zero failures/skips, artifact `15172658106`.

These reports supersede the old blanket “Not run” table for the baseline only.
They do not establish the missing combinations requested by #72 or approve this
revision. Do not attach these results to a future SHA as if it were tested.

#### Field semantics and QA matrix

The raw integration boundary exercised here is the pinned Universal Router
`execute-v2@1.0.0` and `execute-v2-no-deadline@1.0.0` manifests on Ethereum,
V3 exact-input command `0x00`. Existing nested V4 command tests exercise both
accepted tuple layouts; they do not prove market-data completeness or final
TAKE/SETTLE recipient semantics.

| Input / field | Expected interpretation and decision | Regression / actual evidence |
| --- | --- | --- |
| V3 raw amount 1000, positive output floor 900 | Preserve both signed amounts and recipient; floor is not a reference quote | Existing `both_execute_selectors_preserve_v3_swap_intent_and_day1_recipient_decisions`; baseline Native fixtures reported successful |
| V3 raw `minAmountOut=0`, quote absent | Preserve literal zero; no minimum-output protection, not an observed zero quote; retain independent recipient deny | `zero_output_floor_without_observations_preserves_independent_recipient_deny`; baseline Rust log reported `ok` |
| Missing derived slippage versus supplied zero | Missing is absent; explicit zero remains zero | `swap_missing_slippage_is_not_an_explicit_zero`; baseline Rust log reported `ok` |
| Positive floor without quote; missing route, quote, price impact and gas | Omit unavailable context attributes, not observed zero values | `missing_swap_observations_are_omitted_but_real_zero_is_preserved`; baseline Rust log reported `ok` |
| Zero floor without quote | Expose unbounded slippage without inventing a quote | `explicit_zero_floor_is_unbounded_even_without_a_quote`; baseline Rust log reported `ok` |
| Source recipe without a value/original observation time | No fabricated observation or submission-time timestamp; dormant recipes are not executed as observations | Existing builder regressions `swap_observations_require_values_and_original_times_for_each_field` and `swap_dormant_sources_do_not_invalidate_signed_intent`; individual execution details not supplied here |
| Positive-floor V3 raw Swap, each missing field read by a policy, recipient deny installed simultaneously | Evaluated deny retains the recipient reason and reports `engine_error` at the child Swap. The enclosing Batch has its own `no_matching_policy` diagnostic | New native `positive_floor_missing_observation_policy_preserves_recipient_deny` and packaged WASM `raw positive-floor Swap reports missing policy inputs together with recipient deny, unlike supplied zero`; passed |
| Same ABI/request with explicit zero observations in a local control decoder | Dependent policy also matches; recipient deny remains; missing-field diagnostic disappears | Same new tests; both passed. Control observations are deliberately supplied test data, not measurements extracted from calldata |
| Reducer route absent; declared route absent, empty, direct or other | Explicit `MissingField("route")`, no successful balance effects | New `missing_and_declared_only_routes_require_an_observed_route`; passed |
| Restore observed route while unrelated estimates remain absent | Existing V2 reserve calculation still debits 1000 and credits 906 | Same new reducer test; passed with the existing observed-route assertions |
| Complete approve / partial Unknown tree / policy unmatched / required Fact failure | Distinct consumer statuses; no signing authorization; independent denies retained | Existing packaged `check.test.mjs` cases; baseline runtime/check reported successful. Unknown-child coverage is not a substitute for the new missing-Swap-field case |

The new native and packaged tests install one field-dependent policy at a time
alongside the real Day1 recipient policy. This prevents a missing first field or
boolean short-circuit from hiding coverage of the other fields. The supplied-zero
controls require that dependent policy to produce a reason, so a policy trigger
miss cannot masquerade as correct handling of absence. The native control also
checks the decoded zero values. An explicitly observed empty route has a zero
estimate sum; a declared empty route has no observed estimate.

#### Support limits and next gate

The Swap observation contract is not a blanket migration of every mapper field.
Non-slippage `$resolved`/`$derived` fallback identities remain a limitation: a
placeholder pool/factory identity is not evidence of a resolved on-chain venue.
Do not use successful intent decoding as proof that venue-dependent checks or
simulation have complete inputs. Transaction-meta gas is also separate from the
Swap's optional `gas_estimate`.

Non-Swap LiveField models remain outside this correction: liquidity pool state,
current prices, collected/withdrawn fees, intent fill estimates, lending rates
and Pendle market-derived instruments are not certified by the Swap tests.
Existing defaults in those paths must not be described as verified observations.
A protocol-defined default (for example no separate executor), an explicit
zero-valued bound and unavailable enrichment are different contracts; this work
does not globally convert mandatory fields to optional or approve all defaults.

Neither a positive output floor nor a zero price-impact estimate means unlimited
approval. Unlimited token approval remains its separate explicit amount-based
policy. A zero output floor removes that output protection, whereas missing
quote-relative slippage means the relative tolerance cannot be determined.

Run the relevant mapper/lowering/reducer/native tests, formatting checks, WASM
build and packaged consumer regressions against the same new candidate. Retain
field-labelled failures and verdicts as QA output. In particular, if the new
missing-field tests expose a schema/evaluation or presentation failure, preserve
the assertions and hand off that boundary for a scoped product fix; do not
replace missing fields with zero or weaken signature verification. Those boundary
sources are not supplied as editable files in this four-file revision.

F2 acceptance still requires new-SHA CI, independent QA and `dambi-review`
approval compared with #72. No generated decoder snapshot or metadata bytes are
included in this handoff.

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
