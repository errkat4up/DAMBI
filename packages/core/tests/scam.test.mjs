import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { CoreError } from "@dambi/core";
import { initializeCoreForScamTest } from "../dist/runtime/core-runtime.js";

// Explicit, separately built feature artifact. This suite never builds, fetches
// RPC, falls back to an engine mock, or installs its stub in the product WASM.
const featureUrl = new URL("../../../crates/dambi-core-wasm/pkg-scam-test/dambi_core.js", import.meta.url);
const featureBytes = new URL("../../../crates/dambi-core-wasm/pkg-scam-test/dambi_core_bg.wasm", import.meta.url);
const fixtureRoot = new URL("../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const giwaRoot = new URL("../../../fixtures/sdk/giwa-sf0/", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const [decoder, approveDecoder, evidence, envelope, keys] = await Promise.all([
  readJson(new URL("decoders/swap-exact-eth-for-tokens.json", giwaRoot)),
  readJson(new URL("snapshot-approve.json", fixtureRoot)),
  readJson(new URL("rpc-evidence.json", giwaRoot)),
  readJson(new URL("policy-bundle/day1.envelope.json", fixtureRoot)),
  readJson(new URL("policy-bundle/test-only-keys.json", fixtureRoot)),
]);
assert.equal(keys.test_only, true);
const NOW = 1_800_000_000_000;
const T = NOW - 2_000;
const CHAIN = 91342;
const FACTORY = "0xd51d7c2a3b9b0f6876336c165adda94468500c47";
const POOL = "0xcaafb95fc292c10a526f03fa480407bb438dac67";
const TOKEN = "0x0274c57358c3a6b8a08b7297ba51665c303a471f";
const WETH = "0x4200000000000000000000000000000000000006";
const OTHER = "0x0000000000000000000000000000000000000001";
const HASH = `0x${"11".repeat(32)}`;
const BUILDER = "sf3-fixture/1";
const IDENTITY = { id: "sf3-fixed-results", version: "1", contractVersion: 1 };
const initialPolicy = { payload: envelope.payload, signature: envelope.signature, keyId: envelope.key_id };
const transaction = evidence.queries.find(({ request }) => request.method === "eth_getTransactionByHash" &&
  request.params[0] === "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9").response.result;
const observedEthSwap = {
  kind: "transaction", chainId: `eip155:${CHAIN}`, from: transaction.from,
  to: transaction.to, data: transaction.input, value: BigInt(transaction.value).toString(),
};
// A NEW unsigned synthetic request, not the observed ETH transaction relabeled
// as ERC20. Its correct V2 ABI carries amountIn and a WETH -> HYANGNO path.
// This proves the Core integration, not deployed-router support/execution.
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value) => value.slice(2).padStart(64, "0");
const swap = {
  kind: "transaction", chainId: `eip155:${CHAIN}`, from: transaction.from,
  to: transaction.to, value: "0",
  data: "0x38ed1739" + word(1_000_000_000_000_000_000n) + word(0) + word(160) +
    addressWord(transaction.from) + word(1_800_000_100) + word(2) + addressWord(WETH) + addressWord(TOKEN),
};
const syntheticDecoder = structuredClone(decoder);
syntheticDecoder.id = "dambi/sf3-fixture/unsigned-weth-swap@1.0.0";
syntheticDecoder._note = "SF3 unsigned synthetic swapExactTokensForTokens ABI fixture only; not a recorded transaction, packaged decoder, or proof of deployed GIWA router support.";
syntheticDecoder.match.selector = "0x38ed1739";
syntheticDecoder.abi_fragment.function_name = "swapExactTokensForTokens";
syntheticDecoder.abi_fragment.abi.name = "swapExactTokensForTokens";
syntheticDecoder.abi_fragment.abi.stateMutability = "nonpayable";
syntheticDecoder.abi_fragment.abi.inputs.unshift({ name: "amountIn", type: "uint256" });
const syntheticParams = syntheticDecoder.emit.body.$cases["2"].$cases[WETH].$cases[TOKEN].amm.swap.params;
syntheticParams.token_in = { key: { standard: "erc20", chain: "$chain", address: "$args.path[0]" } };
syntheticParams.direction.amount_in = "$args.amountIn";
const rules = [
  { id: "r1", enabled: true, kind: "change_count", metric: "quote_reserve", lookbackSec: 10,
    direction: "either", changeMode: "step", thresholdBps: 500, count: 2 },
  { id: "r2", enabled: true, kind: "switch_density", metric: "price_quote_per_token", lookbackSec: 10,
    windowSec: 6, reversalBps: 500, switchKind: "direction_reversal", count: 2 },
];
let wasm;

before(async () => {
  wasm = await import(featureUrl.href);
  assert.equal(typeof wasm.initSync, "function", "Build the explicit scam-test-fixtures Web WASM artifact first");
  wasm.initSync({ module: await readFile(featureBytes) });
  assert.equal(typeof wasm.WasmCore, "function");
});

function settings(enabled = true) {
  return { enabled, presetId: "sf3-demo", overrides: [], additionalRules: [], locale: "ko" };
}

function fixedResults(outcome = "fired") {
  return rules.map((rule) => ({
    ruleId: rule.id, outcome, observed: outcome === "fired" ? 2 : 0, threshold: 2,
    coverageBps: 10_000, warmupComplete: true,
    ...(outcome === "fired" ? {
      events: [{ tMs: T - 4_000, kind: rule.id === "r1" ? "up" : "peak" },
        { tMs: T - 2_000, kind: rule.id === "r1" ? "down" : "trough" }],
      ...(rule.id === "r2" ? { window: { startMs: T - 8_000, endMs: T - 2_000 } } : {}),
    } : {}),
  }));
}

function fixture(outcome = "fired") {
  const preset = { id: "sf3-base", rules: structuredClone(rules), bucketMs: 1_000,
    gridOriginMs: 0, warmupSec: 1, maxDataAgeSec: 30 };
  return {
    builderVersion: BUILDER,
    bundle: {
      kind: "scam_bundle", schema: "0.1", sequence: "1", issuedAtMs: NOW - 60_000,
      expiresAtMs: NOW + 60_000, env: "staging", profile: "default",
      compatibility: { engineRange: "*", builderRange: "*", contractVersion: "0.1", algorithm: IDENTITY },
      support: [{ chainId: CHAIN, venue: "uniswap_v2", factories: [FACTORY], quoteTokens: [WETH],
        exemptTokens: [WETH], allowedBucketMs: [1_000, 2_000], confirmDepth: 2 }],
      presets: [{ id: "sf3-demo", purpose: "demo",
        selection: { ageThresholdSec: 60, unknownAge: "new_provisional_insufficient" },
        newMarket: { ...structuredClone(preset), id: "new" },
        established: { ...structuredClone(preset), id: "established" } }],
      templates: {}, model: null,
    },
    algorithm: { identity: IDENTITY,
      requirements: { minimumWarmupMs: 1_000, requiresInitialState: true },
      results: fixedResults(outcome) },
  };
}

function signedPolicy({ extra = [], expiresAtMs, sequence = 42 } = {}) {
  const value = { ...JSON.parse(initialPolicy.payload), sequence };
  value.policies.push(...extra);
  if (expiresAtMs !== undefined) value.expires_at = expiresAtMs / 1_000;
  const payload = JSON.stringify(value);
  return { payload, signature: sign("sha256", Buffer.from(payload), {
    key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
  }).toString("base64") };
}

function policyWithFact() {
  const id = "sf3-policy-fact";
  return signedPolicy({ extra: [{ id,
    policy: `@id("${id}") @severity("deny") forbid(principal, action == Amm::Action::"Swap", resource)
      when { context has custom && context.custom has marker && context.custom.marker == "deny" };`,
    manifest: { id, schema_version: 2, trigger: { where: { "action.tag": { eq: "swap" } } },
      policy_rpc: [{ id: "marker", method: "sf3.policy-marker", params: { owner: "$.root.from" }, optional: false,
        outputs: [{ kind: "context", field: "marker", type: "String", from: "$.result.marker", required: true }] }],
      custom_context: { fields: { marker: "String" } } },
  }] });
}

function exactAge(ageSec = 1_000) {
  return { kind: "exact", ageSec, evidence: { kind: "factory_pair_created", factory: FACTORY,
    createdAt: { number: "1", hash: HASH, timestampMs: T - ageSec * 1_000 },
    transactionHash: HASH, logIndex: 0 } };
}

function methodValue(call, age = exactAge()) {
  const p = call.params;
  const fromMs = T - ((p.lookbackSec ?? p.eventLookbackSec ?? 0) + (p.warmupSec ?? 0)) * 1_000;
  const coverage = { fromBlock: "1", fromMs, toMs: T, missing: [], unavailable: [] };
  const reference = { block: { number: "1000", hash: HASH, timestampMs: T },
    checkedHead: { number: "1002", hash: `0x${"22".repeat(32)}`, timestampMs: NOW },
    requiredConfirmDepth: p.confirmDepth, observedConfirmDepth: 2 };
  const meta = { method: call.method, schema: p.dataSchema, builderVersion: p.builderVersion,
    subject: structuredClone(p.subject), referenceGroupId: p.referenceGroupId, reference, coverage };
  if (call.method === "scam.token_profile") return { ...meta, age, searchedRanges: [], events: [] };
  assert.equal(call.method, "scam.pool_history");
  return { ...meta, histories: p.candidateResolutions.map(({ bucketMs, gridOriginMs }) => {
    const points = [];
    const first = gridOriginMs + Math.ceil((fromMs - gridOriginMs) / bucketMs) * bucketMs;
    for (let tMs = first; tMs <= T; tMs += bucketMs) {
      points.push({ tMs, reserveQuote: "1000", reserveToken: "1000", decimalsQuote: 18, decimalsToken: 18 });
    }
    return { gridOriginMs, history: { schema: "scam.pool_history/1", builderVersion: BUILDER,
      fromMs, bucketMs, points, missing: [], warmup: { fromMs, complete: true } } };
  }) };
}

function scamBatch(calls, { planId }, age) {
  return { planId, results: Object.fromEntries(calls.map((call) => [call.callId, {
    value: methodValue(call, age), source: "fixture:giwa-recorded-identity-synthetic-history",
    observedAt: NOW, blockNumber: "1000",
  }])) };
}

function policyBatch(calls, { planId }, observedAt = NOW) {
  return { planId, results: Object.fromEntries(calls.map((call) => [call.callId, {
    value: { marker: "allow" }, source: "fixture:policy-marker", observedAt, blockNumber: "1000",
  }])) };
}

function harness({ configured = true, enabled = true, policy = initialPolicy, scamLimits = {}, limits = {} } = {}) {
  let now = NOW;
  let age = exactAge();
  const fetches = [];
  let fetchScam = async (calls, context) => scamBatch(calls, context, age);
  let fetchPolicyFacts = async (calls, context) => policyBatch(calls, context);
  const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder, syntheticDecoder, approveDecoder] });
  const config = {
    decoderSnapshot: { artifact, expectedDigest: `0x${createHash("sha256").update(artifact).digest("hex")}` },
    trust: { env: "staging", profile: "default", keys: [{ keyId: keys.policy.key_id,
      role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64 }] },
    enforcement: "advisory", clock: { now: () => now },
    limits: { allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32, planTtlMs: 60_000,
      maxPendingPlans: 8, maxFactAgeMs: 30_000, factTimeoutMs: 1_000, policyTimeoutMs: 1_000, ...limits },
    ports: {
      policy: { fetch: async () => policy },
      fact: { fetch(calls, context) {
        const scam = calls.every((call) => call.method.startsWith("scam."));
        assert.equal(calls.some((call) => call.method.startsWith("scam.")), scam, "policy/scam batches must not mix");
        fetches.push({ calls, context, scam });
        return scam ? fetchScam(calls, context) : fetchPolicyFacts(calls, context);
      } },
    },
  };
  if (configured) config.scam = { settings: settings(enabled),
    trust: { env: "staging", profile: "default", keys: [{ keyId: "sf3-only-scam",
      role: "scam", publicKeySpkiBase64: keys.policy.public_key_spki_b64 }] },
    limits: { scamTimeoutMs: 500, scamEvalReserveMs: 20, maxBundleBytes: 100_000,
      maxResultBytes: 100_000, maxCalls: 16, maxTargets: 8, maxRules: 16,
      maxLogs: 1_000, maxPoints: 1_000, maxAlgorithmWorkUnits: 100_000, ...scamLimits } };
  return { config, fetches, setNow(value) { now = value; }, setAge(value) { age = value; },
    setScamFetch(value) { fetchScam = value; }, setPolicyFetch(value) { fetchPolicyFacts = value; } };
}

async function open(t, setup, selectedFixture = fixture()) {
  const opened = await initializeCoreForScamTest(setup.config, selectedFixture, wasm);
  t.after(() => opened.core.dispose());
  return opened;
}

function comparable(report) {
  const copy = structuredClone(report);
  for (const target of copy.targets) if (target.binding) delete target.binding.planId;
  return copy;
}

function redirectedSwap() {
  // swapExactTokensForTokens: amountIn, amountOutMin, path offset, recipient.
  const start = 2 + 8 + 64 * 3;
  return { ...swap, data: swap.data.slice(0, start) + OTHER.slice(2).padStart(64, "0") + swap.data.slice(start + 64) };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const reasons = (verdict) => [...verdict.scam.reasons, ...verdict.scam.targets.flatMap((target) => target.reasons)];
const options = { timeout: 10_000 };

test("unconfigured, disabled and missing-module paths never silently install the fixed algorithm", options, async (t) => {
  for (const [configured, enabled, expected] of [[false, true, undefined], [true, false, "disabled"]]) {
    const setup = harness({ configured, enabled });
    const { core } = await open(t, setup);
    const verdict = await core.check(swap);
    assert.equal(verdict.decision, "allow");
    assert.equal(verdict.source, "evaluated");
    if (expected === undefined) assert.equal(verdict.scam, undefined);
    else assert.equal(verdict.scam.status, expected);
    assert.equal(setup.fetches.length, 0);
  }
  const unavailable = fixture();
  unavailable.algorithm = null;
  const { core } = await open(t, harness(), unavailable);
  const verdict = await core.check(swap);
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.scam.status, "insufficient");
  assert.ok(reasons(verdict).includes("algorithm_unavailable"));

  // SF0's actual ETH request remains unchanged. Its decoded route currently
  // omits the pool-side wrapped input, so SF3 must not guess WETH or schedule
  // analysis against an invented subject. Decoder handoff is a separate task.
  const ethSetup = harness();
  const { core: ethCore } = await open(t, ethSetup);
  const ethPlan = await ethCore.plan(observedEthSwap);
  assert.deepEqual(ethPlan.scamCalls, []);
  const ethVerdict = ethCore.evaluate(ethPlan, policyBatch(ethPlan.calls, ethPlan));
  assert.equal(ethVerdict.decision, "allow");
  assert.equal(ethVerdict.scam.status, "insufficient");
  assert.ok(reasons(ethVerdict).includes("subject_unresolved"));
  assert.equal(ethSetup.fetches.length, 0);
});

test("synthetic unsigned WETH swap crosses real Decoder/Core/WASM and keeps manual/check R1/R2 evidence equal", options, async (t) => {
  const setup = harness({ policy: policyWithFact() });
  const { core } = await open(t, setup);
  const plan = await core.plan(swap);
  assert.equal(plan.calls.length, 1);
  assert.deepEqual(plan.scamCalls.map(({ method }) => method), ["scam.pool_history", "scam.token_profile"]);
  assert.ok(plan.scamCalls.every(({ optional, outputs }) => optional && outputs.length === 0));
  const subject = plan.scamCalls[0].params.subject;
  assert.equal(subject.chainId, CHAIN);
  assert.equal(subject.pool, POOL);
  assert.equal(subject.token, TOKEN);
  assert.equal(subject.factory, FACTORY);
  assert.equal(subject.quoteToken, WETH);
  assert.ok(subject.actionPaths.length > 0);
  const manual = core.evaluate(plan, policyBatch(plan.calls, plan), scamBatch(plan.scamCalls, plan));
  const checked = await core.check(swap);
  assert.equal(manual.decision, "warn");
  assert.equal(manual.source, "evaluated");
  assert.equal(manual.scam.status, "warn");
  assert.equal(manual.scam.scopeNotice, "patterns_only_no_sellability_guarantee");
  assert.equal(manual.scam.targets[0].analysisMode, "stub");
  assert.deepEqual(manual.scam.targets[0].rules.map(({ ruleId, state }) => [ruleId, state]), [["r1", "fired"], ["r2", "fired"]]);
  assert.deepEqual(manual.scam.targets[0].rules[1].evidence.events, fixedResults()[1].events);
  assert.deepEqual(comparable(checked.scam), comparable(manual.scam));
  assert.equal(setup.fetches.filter(({ scam }) => scam).length, 1);
  assert.equal(setup.fetches.filter(({ scam }) => !scam).length, 1);
  assert.throws(() => core.evaluate(plan, policyBatch(plan.calls, plan)), code("PLAN_CONSUMED"));
});

test("scam results preserve actual Cedar deny/warn and policy source while only escalating allow", options, async (t) => {
  const warnId = "sf3-swap-warning";
  const warningPolicy = signedPolicy({ extra: [{ id: warnId,
    policy: `@id("${warnId}") @severity("warn") forbid(principal, action == Amm::Action::"Swap", resource);`,
    manifest: { id: warnId, schema_version: 2, trigger: { where: { "action.tag": { eq: "swap" } } } } }] });
  for (const [policy, request, expected, policyId] of [
    [initialPolicy, swap, "warn", undefined],
    [warningPolicy, swap, "warn", warnId],
    [initialPolicy, redirectedSwap(), "deny", "swap-recipient-not-self-deny"],
  ]) {
    const { core } = await open(t, harness({ policy }));
    const verdict = await core.check(request);
    assert.equal(verdict.decision, expected);
    assert.equal(verdict.source, "evaluated");
    assert.equal(verdict.scam.status, "warn");
    if (policyId) assert.ok(verdict.reasons.some((reason) => reason.policyId === policyId));
  }
  const { core } = await open(t, harness(), fixture("clear"));
  const quiet = await core.check(swap);
  assert.equal(quiet.decision, "allow");
  assert.equal(quiet.scam.status, "quiet");
  assert.equal(quiet.scam.scopeNotice, "patterns_only_no_sellability_guarantee");
});

test("malformed, mismatched and missing scam batches stay isolated from the policy verdict", options, async (t) => {
  const setup = harness();
  const { core } = await open(t, setup);
  const mutations = [
    () => undefined,
    (batch) => ({ ...batch, planId: "foreign-plan" }),
    (batch) => ({ ...batch, results: { unexpected: Object.values(batch.results)[0] } }),
    (batch) => { Object.values(batch.results)[0].value.subject.pool = OTHER; return batch; },
    (batch) => { Object.values(batch.results)[0].value.reference.block.hash = `0x${"33".repeat(32)}`; return batch; },
    (batch) => { Object.values(batch.results)[0].value = { invalid: true }; return batch; },
    (batch) => { Object.values(batch.results)[0].value = "x".repeat(100_001); return batch; },
  ];
  for (const mutate of mutations) {
    const plan = await core.plan(redirectedSwap());
    const verdict = core.evaluate(plan, policyBatch(plan.calls, plan), mutate(scamBatch(plan.scamCalls, plan)));
    assert.equal(verdict.decision, "deny");
    assert.equal(verdict.source, "evaluated");
    assert.ok(verdict.reasons.some(({ policyId }) => policyId === "swap-recipient-not-self-deny"));
    assert.equal(verdict.scam.status, "insufficient");
    assert.ok(reasons(verdict).length > 0);
    assert.throws(() => core.evaluate(plan, policyBatch(plan.calls, plan)), code("PLAN_CONSUMED"));
  }
  setup.setScamFetch(async () => { throw new Error("test-only provider outage"); });
  const verdict = await core.check(swap);
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.source, "evaluated");
  assert.equal(verdict.scam.status, "insufficient");
});

test("an issued plan pins settings, bundle and algorithm despite later fixture/settings replacement", options, async (t) => {
  const { core, installFixture } = await open(t, harness());
  const oldPlan = await core.plan(swap);
  const next = fixture("clear");
  next.bundle.sequence = "2";
  next.algorithm.identity = { ...IDENTITY, version: "2" };
  next.bundle.compatibility.algorithm = next.algorithm.identity;
  installFixture(next);
  core.setScamSettings(settings(false));
  const old = core.evaluate(oldPlan, policyBatch(oldPlan.calls, oldPlan), scamBatch(oldPlan.scamCalls, oldPlan));
  assert.equal(old.scam.status, "warn");
  assert.equal(old.scam.targets[0].binding.bundleSequence, "1");
  assert.equal(old.scam.targets[0].binding.algorithm.version, "1");
  assert.equal((await core.check(swap)).scam.status, "disabled");
  core.setScamSettings(settings());
  const latest = await core.check(swap);
  assert.equal(latest.scam.status, "quiet");
  assert.equal(latest.scam.targets[0].binding.bundleSequence, "2");
  assert.equal(latest.scam.targets[0].binding.algorithm.version, "2");
});

test("one frozen plan supports both candidate grids and young or unknown age cannot claim quiet", options, async (t) => {
  const selectedFixture = fixture("clear");
  const established = selectedFixture.bundle.presets[0].established;
  established.bucketMs = 2_000;
  established.warmupSec = 2;
  for (const rule of established.rules) rule.lookbackSec = 20;
  const setup = harness();
  const { core } = await open(t, setup, selectedFixture);
  const scenarios = [
    [exactAge(59), "newMarket", "exact_young", 1_000, "insufficient", "market_too_young"],
    [exactAge(60), "established", "exact_mature", 2_000, "quiet", undefined],
    [{ kind: "lower_bound", ageLowerBoundSec: 60, evidence: { kind: "historical_code_presence",
      checkedAt: { number: "940", hash: HASH, timestampMs: T - 60_000 },
      identityVerified: true, nonRecreationSupportId: "sf3-known-v2-fixture" } },
    "established", "lower_bound_mature", 2_000, "quiet", undefined],
    [{ kind: "unknown", reasons: ["fixture-no-creation-evidence"] }, "newMarket", "age_unknown", 1_000, "insufficient", "age_unknown"],
  ];
  for (const [age, selectedPreset, selectionReason, bucketMs, status, expectedReason] of scenarios) {
    setup.setAge(age);
    const plan = await core.plan(swap);
    const history = plan.scamCalls.find(({ method }) => method === "scam.pool_history");
    assert.equal(history.params.lookbackSec, 20);
    assert.equal(history.params.warmupSec, 2);
    assert.deepEqual(history.params.candidateResolutions.map(({ bucketMs }) => bucketMs).sort((a, b) => a - b), [1_000, 2_000]);
    const verdict = core.evaluate(plan, policyBatch(plan.calls, plan), scamBatch(plan.scamCalls, plan, age));
    assert.equal(verdict.scam.status, status);
    assert.equal(verdict.decision, "allow");
    assert.equal(verdict.source, "evaluated");
    assert.deepEqual(verdict.scam.reasons, expectedReason ? [expectedReason] : []);
    assert.deepEqual(verdict.scam.targets[0].reasons, expectedReason ? [expectedReason] : []);
    const binding = verdict.scam.targets[0].binding;
    assert.equal(binding.selectedPreset, selectedPreset);
    assert.equal(binding.selectionReason, selectionReason);
    assert.equal(binding.bucketMs, bucketMs);
    if (selectionReason === "exact_young") {
      const checked = await core.check(swap);
      assert.equal(checked.decision, "allow");
      assert.deepEqual(comparable(checked.scam), comparable(verdict.scam));
    }
  }

  // Age limits quiet, not an observed warning from the same young market.
  const warningSetup = harness();
  warningSetup.setAge(exactAge(59));
  const { core: warningCore } = await open(t, warningSetup, fixture("fired"));
  const warning = await warningCore.check(swap);
  assert.equal(warning.decision, "warn");
  assert.equal(warning.scam.status, "warn");
  assert.equal(warning.scam.targets[0].binding.selectionReason, "exact_young");
  assert.deepEqual(warning.scam.targets[0].reasons, ["market_too_young"]);
  assert.ok(warning.scam.targets[0].rules.every((rule) => rule.state === "fired"));
});

test("policy Fact and snapshot expiry tighten scam waiting without converting policy success to deny", options, async (t) => {
  for (const kind of ["fact", "snapshot"]) {
    const setup = harness({
      policy: kind === "fact" ? policyWithFact() : signedPolicy({ expiresAtMs: NOW + 1_000 }),
      limits: { maxFactAgeMs: 1_000 }, scamLimits: { scamEvalReserveMs: 100, scamTimeoutMs: 500 },
    });
    if (kind === "snapshot") setup.setNow(NOW + 950);
    else setup.setPolicyFetch(async (calls, context) => policyBatch(calls, context, NOW - 950));
    const pending = deferred();
    setup.setScamFetch(() => pending.promise);
    const { core } = await open(t, setup);
    const verdict = await core.check(swap);
    assert.equal(verdict.decision, "allow", kind);
    assert.equal(verdict.source, "evaluated", kind);
    assert.equal(verdict.scam.status, "insufficient", kind);
    assert.ok(reasons(verdict).some((reason) => ["no_time_budget", "timeout"].includes(reason)), kind);
    const fetch = setup.fetches.find(({ scam }) => scam);
    if (fetch) {
      assert.equal(fetch.context.signal.aborted, true);
      pending.resolve(scamBatch(fetch.calls, fetch.context));
    } else pending.resolve({ planId: "not-started", results: {} });
    await tick();
  }
});

test("scam timeout ignores late results and a subsequent check fetches independently", options, async (t) => {
  const setup = harness({ scamLimits: { scamTimeoutMs: 20, scamEvalReserveMs: 5 } });
  const pending = deferred();
  setup.setScamFetch(() => pending.promise);
  const { core } = await open(t, setup);
  const verdict = await core.check(swap);
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.source, "evaluated");
  assert.equal(verdict.scam.status, "insufficient");
  assert.ok(reasons(verdict).includes("timeout"));
  const fetch = setup.fetches.find(({ scam }) => scam);
  assert.equal(fetch.context.signal.aborted, true);
  pending.resolve(scamBatch(fetch.calls, fetch.context));
  await tick();
  setup.setScamFetch(async (calls, context) => scamBatch(calls, context));
  assert.equal((await core.check(swap)).scam.status, "warn");
  assert.equal(setup.fetches.filter(({ scam }) => scam).length, 2);
});

test("caller abort and disposal retain existing lifecycle semantics during scam I/O", options, async (t) => {
  for (const mode of ["abort", "dispose"]) {
    const setup = harness();
    const started = deferred();
    const response = deferred();
    let fetch;
    setup.setScamFetch((calls, context) => { fetch = { calls, context }; started.resolve(); return response.promise; });
    const { core } = await open(t, setup);
    const controller = new AbortController();
    const pending = core.check(swap, { signal: controller.signal });
    const disposed = mode === "dispose" ? assert.rejects(pending, code("DISPOSED")) : undefined;
    await started.promise;
    if (mode === "abort") {
      controller.abort();
      const verdict = await pending;
      assert.equal(verdict.decision, "deny");
      assert.equal(verdict.source, "fail_closed");
      assert.ok(verdict.diagnostics.some(({ code }) => code === "aborted"));
    } else { core.dispose(); await disposed; }
    assert.equal(fetch.context.signal.aborted, true);
    response.resolve(scamBatch(fetch.calls, fetch.context));
    await tick();
    if (mode === "dispose") await assert.rejects(core.check(swap), code("DISPOSED"));
  }

  // Instrument entry only: every call still goes to the real WASM method.
  // This avoids a fragile clock-call count and tests abort from the synchronous
  // Native clock callback, after async provider waiting has already completed.
  const prototype = wasm.WasmCore.prototype;
  const original = prototype.evaluate_check_scam;
  let inNative = false;
  const controller = new AbortController();
  prototype.evaluate_check_scam = function (...args) {
    inNative = true;
    try { return original.apply(this, args); }
    finally { inNative = false; }
  };
  try {
    const setup = harness();
    setup.config.clock = { now() { if (inNative) controller.abort(); return NOW; } };
    const { core } = await open(t, setup);
    const verdict = await core.check(swap, { signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    assert.equal(verdict.decision, "deny");
    assert.equal(verdict.source, "fail_closed");
    assert.equal(verdict.metadata.status, "available");
    assert.ok(verdict.diagnostics.some(({ code }) => code === "aborted"));
  } finally { prototype.evaluate_check_scam = original; }
});
