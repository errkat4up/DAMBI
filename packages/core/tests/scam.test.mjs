import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { CoreError } from "@dambi/core";
import { createScamFactProvider } from "@dambi/core/adapters";
import { initializeCoreForScamTest } from "../dist/runtime/core-runtime.js";
import { scamProviderRpcFixture } from "./adapters/helpers/scam-provider-fixture.mjs";
import { checkWithTiming } from "../../../examples/sdk-adapters/check-timing.mjs";

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

function harness({ configured = true, enabled = true, policy = initialPolicy, scamLimits = {}, limits = {}, ethDecoder = decoder } = {}) {
  let now = NOW;
  let age = exactAge();
  const fetches = [];
  let fetchScam = async (calls, context) => scamBatch(calls, context, age);
  let fetchPolicyFacts = async (calls, context) => policyBatch(calls, context);
  const artifact = JSON.stringify({ schema_version: 1, bundles: [ethDecoder, syntheticDecoder, approveDecoder] });
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
const waitForFinalRecheck = (paused, pending) => Promise.race([
  paused.started,
  pending.then(() => assert.fail("The check settled before reaching the expected final recheck")),
]);
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const reasons = (verdict) => [...verdict.scam.reasons, ...verdict.scam.targets.flatMap((target) => target.reasons)];
const options = { timeout: 10_000 };

function sf45Fixture(outcome = "fired", withAdminRule = false) {
  const selected = fixture(outcome);
  selected.builderVersion = "dambi-v2/1";
  if (withAdminRule) {
    const rule = { id: "admin", enabled: true, kind: "event_count", lookbackSec: 10,
      eventKinds: ["paused"], count: 1 };
    for (const candidate of ["newMarket", "established"]) {
      selected.bundle.presets[0][candidate].rules.push(structuredClone(rule));
    }
    selected.algorithm.results.push({ ruleId: "admin", outcome: "clear", observed: 0,
      threshold: 1, coverageBps: 10_000, warmupComplete: true });
  }
  return selected;
}

function sf45Provider(setup, failure) {
  const raw = scamProviderRpcFixture({ now: NOW, chainId: CHAIN, factory: FACTORY,
    pool: POOL, token: TOKEN, quoteToken: WETH, failure });
  const policyCalls = [];
  const provider = createScamFactProvider({ rpc: raw.rpc, history: raw.history, profile: raw.profile,
    factorySupport: raw.factorySupport,
    policy: { fetch(calls, context) { policyCalls.push({ calls, context }); return Promise.resolve(policyBatch(calls, context)); } },
    limits: { timeoutMs: failure === "timeout" ? 20 : 500, maxCalls: 16, maxTargets: 8,
      maxRequestBytes: 100_000, maxResultBytes: 100_000 } });
  setup.setScamFetch((calls, context) => provider.fetch(calls, context));
  setup.setPolicyFetch((calls, context) => provider.fetch(calls, context));
  return { provider, raw, policyCalls };
}

// Keep SF4-5's default-mode fixture unchanged. This wrapper advances its raw
// chain by one block after preparation and controls the final reference read.
// Builders, the provider, Runtime and WASM remain real; the algorithm is a stub.
function ah5Provider(setup) {
  const raw = scamProviderRpcFixture({ now: NOW, chainId: CHAIN, factory: FACTORY,
    pool: POOL, token: TOKEN, quoteToken: WETH });
  let now = NOW, referenceReads = 0, finalRecheck;
  const policyCalls = [];
  const provider = createScamFactProvider({
    rpc: { ...raw.rpc, clock: { now: () => now }, verification: { history: "rpc_anchor" },
      historyCache: { maxEntries: 8, maxBytes: 1_000_000, ttlMs: 60_000, maxBlockSpan: 10_000 },
      async fetch(url, init) {
        const rpc = JSON.parse(init.body);
        if (rpc.method === "eth_chainId") referenceReads = 0;
        const response = await raw.rpc.fetch(url, init);
        if (now === NOW) return response;
        const body = await response.json();
        if (rpc.method === "eth_getBlockByNumber") {
          if (rpc.params[0] === "latest") {
            body.result = { number: "0x3eb", hash: `0x${word(11_003)}`,
              parentHash: `0x${word(11_002)}`, timestamp: `0x${BigInt(now / 1_000).toString(16)}` };
          } else if (BigInt(rpc.params[0]) === 1_001n && ++referenceReads === 2) {
            const action = finalRecheck;
            finalRecheck = undefined;
            if (action) await action(body, init.signal);
          }
        } else if (rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac") {
          // The new window starts at a different block and must read its seed.
          body.result = `0x${word(1_000)}${word(2_000)}${word(0)}`;
        }
        return new Response(JSON.stringify(body));
      } },
    history: raw.history, profile: raw.profile, factorySupport: raw.factorySupport,
    policy: { async fetch(calls, context) {
      policyCalls.push({ calls, context });
      return policyBatch(calls, context, now);
    } },
    limits: { timeoutMs: 2_000, maxCalls: 16, maxTargets: 8,
      maxRequestBytes: 100_000, maxResultBytes: 100_000 },
  });
  setup.setScamFetch((calls, context) => provider.fetch(calls, context));
  setup.setPolicyFetch((calls, context) => provider.fetch(calls, context));
  return {
    provider, raw, policyCalls,
    advance() { now = NOW + 1_000; setup.setNow(now); },
    reorgFinalRecheck() {
      finalRecheck = (body) => { body.result.hash = `0x${"ee".repeat(32)}`; };
    },
    pauseFinalRecheck() {
      const entered = deferred(), reply = deferred();
      const paused = { started: entered.promise, release: reply.resolve, signal: undefined };
      finalRecheck = async (_body, signal) => {
        paused.signal = signal;
        entered.resolve();
        // Deliberately return the late raw reply even if cancellation arrived.
        await reply.promise;
      };
      return paused;
    },
  };
}

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
});

test("observed ETH swap resolves its pool-side WETH and preserves manual/check stub evidence", options, async (t) => {
  // The raw transaction is recorded; the history, age and algorithm remain
  // explicit synthetic fixtures. This is not a real RPC/scam detection test.
  const setup = harness();
  const { core } = await open(t, setup);
  const plan = await core.plan(observedEthSwap);
  assert.deepEqual(plan.scamCalls.map(({ method }) => method), ["scam.pool_history", "scam.token_profile"]);
  const subject = plan.scamCalls[0].params.subject;
  assert.equal(subject.chainId, CHAIN);
  assert.equal(subject.pool, POOL);
  assert.equal(subject.token, TOKEN);
  assert.equal(subject.factory, FACTORY);
  assert.equal(subject.quoteToken, WETH);
  assert.deepEqual(plan.scamCalls[1].params.subject, subject);
  const manual = core.evaluate(plan, policyBatch(plan.calls, plan), scamBatch(plan.scamCalls, plan));
  const checked = await core.check(observedEthSwap);
  assert.equal(manual.decision, "warn");
  assert.equal(manual.source, "evaluated");
  assert.equal(manual.scam.status, "warn");
  assert.equal(manual.scam.targets[0].analysisMode, "stub");
  assert.deepEqual(manual.scam.targets[0].binding.verification, { status: "legacy_unspecified" },
    "Legacy provider inputs do not imply any particular verification mode");
  assert.deepEqual(manual.scam.targets[0].rules.map(({ ruleId, state }) => [ruleId, state]), [["r1", "fired"], ["r2", "fired"]]);
  assert.deepEqual(comparable(checked.scam), comparable(manual.scam));
  assert.equal(setup.fetches.filter(({ scam }) => scam).length, 1);
});

test("missing or inconsistent ETH routes stay unresolved without a quote fallback", options, async (t) => {
  const missing = structuredClone(decoder);
  delete missing.emit.live_inputs.route.value;
  const wrongPool = structuredClone(decoder);
  wrongPool.emit.live_inputs.route.value.paths[0].hops[0].venue.pool = OTHER;
  const wrongQuote = structuredClone(decoder);
  wrongQuote.emit.live_inputs.route.value.paths[0].hops[0].token_in.key.address = OTHER;
  for (const [label, ethDecoder] of [["missing", missing], ["wrong-pool", wrongPool], ["wrong-quote", wrongQuote]]) {
    const setup = harness({ ethDecoder });
    const { core } = await open(t, setup);
    const plan = await core.plan(observedEthSwap);
    assert.deepEqual(plan.scamCalls, [], label);
    const verdict = core.evaluate(plan, policyBatch(plan.calls, plan));
    assert.equal(verdict.decision, "allow", label);
    assert.equal(verdict.source, "evaluated", label);
    assert.equal(verdict.scam.status, "insufficient", label);
    assert.ok(reasons(verdict).includes("subject_unresolved"), label);
    assert.equal(setup.fetches.length, 0, label);
  }
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

test("AH1-1 malformed or mixed verification declarations stay advisory across the WASM boundary", options, async (t) => {
  const { core } = await open(t, harness());
  const valid = () => ({ version: 1, history: "all_event_headers", stateBinding: "number_recheck",
    timeSources: ["header"], reuse: "none", rawObservedAt: { fromMs: NOW, toMs: NOW }, verifiedAt: NOW });
  const mutations = [
    ["explicit null is not legacy", (h, p) => { h.verification = null; p.verification = null; }],
    ["one missing method declaration", (_h, p) => { delete p.verification; }],
    ["different history modes", (_h, p) => { p.verification.history = "rpc_anchor"; }],
    ["unknown metadata version", (h, p) => { h.verification.version = 2; p.verification.version = 2; }],
    ["unknown field is not silently discarded", (h) => { h.verification.claim = "safe"; }],
    ["future final check", (h) => { h.verification.verifiedAt = NOW + 60_000; }],
    ["old observations cannot claim fresh collection", (h) => { h.verification.rawObservedAt.fromMs = NOW - 1; }],
  ];
  for (const [label, mutate] of mutations) {
    const plan = await core.plan(redirectedSwap());
    const batch = scamBatch(plan.scamCalls, plan);
    const byMethod = Object.fromEntries(plan.scamCalls.map((call) => [call.method, batch.results[call.callId].value]));
    const history = byMethod["scam.pool_history"], profile = byMethod["scam.token_profile"];
    history.verification = valid(); profile.verification = valid();
    mutate(history, profile);
    const verdict = core.evaluate(plan, policyBatch(plan.calls, plan), batch);
    assert.equal(verdict.decision, "deny", label);
    assert.equal(verdict.source, "evaluated", label);
    assert.ok(verdict.reasons.some(({ policyId }) => policyId === "swap-recipient-not-self-deny"), label);
    assert.equal(verdict.scam.status, "insufficient", label);
    assert.ok(reasons(verdict).includes("invalid_scam_input"), label);
    assert.equal(verdict.scam.targets[0].binding, undefined, label);
  }
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

test("SF4-5 raw RPC provider reaches manual evaluate and check with identical pinned builder evidence", options, async (t) => {
  const setup = harness({ policy: policyWithFact() });
  const { provider, raw, policyCalls } = sf45Provider(setup);
  const { core } = await open(t, setup, sf45Fixture());
  const plan = await core.plan(observedEthSwap);
  const context = { planId: plan.planId };
  const policyFacts = await provider.fetch(plan.calls, context);
  const scamFacts = await provider.fetch(plan.scamCalls, context);
  const byMethod = Object.fromEntries(plan.scamCalls.map((call) => [call.method, scamFacts.results[call.callId].value]));
  const history = byMethod["scam.pool_history"];
  const profile = byMethod["scam.token_profile"];
  assert.equal(history.builderVersion, "dambi-v2/1");
  assert.deepEqual(history.reference, profile.reference);
  assert.equal(history.reference.block.number, "1000");
  assert.equal(history.reference.block.timestampMs, T);
  assert.equal(profile.age.kind, "lower_bound");
  assert.equal(profile.age.ageLowerBoundSec, 60);
  assert.equal(history.histories[0].history.points.find((point) => point.tMs === T - 4_000).reserveQuote, "1200",
    "The exposed history is constructed from a raw Sync, not the old synthetic FactBatch helper");
  assert.equal(raw.calls.filter((call) => call.method === "eth_chainId").length, 1,
    "A history/profile pair shares a single raw batch");
  const manual = core.evaluate(plan, policyFacts, scamFacts);
  const checked = await core.check(observedEthSwap);
  assert.equal(manual.decision, "warn");
  assert.equal(manual.source, "evaluated");
  assert.equal(manual.scam.status, "warn");
  assert.equal(manual.scam.targets[0].analysisMode, "stub", "The actual algorithm is still an explicit test fixture");
  assert.equal(manual.scam.targets[0].binding.builderVersion, "dambi-v2/1");
  assert.equal(manual.scam.targets[0].binding.selectionReason, "lower_bound_mature");
  assert.deepEqual(manual.scam.targets[0].binding.verification, {
    status: "declared", poolHistory: history.verification, tokenProfile: profile.verification,
  }, "Actual provider verification survives TypeScript, strict Rust parsing and report composition");
  assert.equal(history.verification.version, 1);
  assert.equal(history.verification.history, "all_event_headers");
  assert.equal(history.verification.stateBinding, "number_recheck");
  assert.equal(history.verification.reuse, "none");
  assert.equal(history.verification.verifiedAt, NOW);
  assert.deepEqual(comparable(checked.scam), comparable(manual.scam));
  assert.equal(policyCalls.length, 2);
  assert.ok(policyCalls.every(({ calls }) => calls.length === 1 && calls[0].method === "sf3.policy-marker"));
  assert.equal(raw.calls.filter((call) => call.method === "eth_chainId").length, 2,
    "A later check receives its own reference instead of reusing an unqualified cache");
});

test("SF4-5 raw history gaps and unsupported administrator coverage cannot become quiet from a clear stub", options, async (t) => {
  for (const scenario of ["missing_history", "unsupported_admin"]) {
    const setup = harness();
    const { provider, raw } = sf45Provider(setup, scenario);
    const { core } = await open(t, setup, sf45Fixture("clear", scenario === "unsupported_admin"));
    const plan = await core.plan(swap);
    const batch = await provider.fetch(plan.scamCalls, { planId: plan.planId });
    const values = Object.values(batch.results).map(({ value }) => value);
    const history = values.find((value) => value.method === "scam.pool_history");
    const profile = values.find((value) => value.method === "scam.token_profile");
    assert.equal(profile.age.kind, "lower_bound", "Age evidence is independent of event/history availability");
    if (scenario === "missing_history") {
      assert.equal(raw.failureObserved, true);
      assert.ok(history.coverage.missing.length > 0);
      assert.ok(history.histories[0].history.missing.length > 0);
    } else {
      assert.deepEqual(profile.events, []);
      assert.ok(profile.coverage.missing.length > 0);
      assert.ok(profile.coverage.unavailable.some(({ field }) => field === "adminEvents"));
      assert.equal(raw.calls.some((call) => call.method === "eth_getLogs" && call.params[0].address === TOKEN), false,
        "An unverified event ABI is not made supported by receiving an empty log response");
    }
    // Deliberately inaccurate fixed 'clear' output exercises the Core boundary:
    // unavailable source data cannot be rescued by a module's optimistic claim.
    const manual = core.evaluate(plan, policyBatch(plan.calls, plan), batch);
    const checked = await core.check(swap);
    assert.equal(manual.decision, "allow", scenario);
    assert.equal(manual.source, "evaluated", scenario);
    assert.equal(manual.scam.status, "insufficient", scenario);
    assert.ok(reasons(manual).includes("invalid_algorithm_output"), scenario);
    assert.deepEqual(comparable(checked.scam), comparable(manual.scam), scenario);
  }
});

test("SF4-5 provider reorg and timeout preserve explicit scam failure and the original Cedar deny or warn", options, async (t) => {
  const warnId = "sf4-5-existing-warning";
  const warningPolicy = signedPolicy({ extra: [{ id: warnId,
    policy: `@id("${warnId}") @severity("warn") forbid(principal, action == Amm::Action::"Swap", resource);`,
    manifest: { id: warnId, schema_version: 2, trigger: { where: { "action.tag": { eq: "swap" } } } } }] });
  for (const [failure, policy, request, decision, policyId] of [
    ["reorg", initialPolicy, redirectedSwap(), "deny", "swap-recipient-not-self-deny"],
    ["timeout", warningPolicy, swap, "warn", warnId],
  ]) {
    const setup = harness({ policy });
    const { raw } = sf45Provider(setup, failure);
    const { core } = await open(t, setup, sf45Fixture());
    const verdict = await core.check(request);
    assert.equal(raw.failureObserved, true, failure);
    assert.equal(verdict.decision, decision, failure);
    assert.equal(verdict.source, "evaluated", failure);
    assert.ok(verdict.reasons.some((reason) => reason.policyId === policyId), failure);
    assert.equal(verdict.scam.status, "insufficient", failure);
    assert.ok(reasons(verdict).includes(failure), failure);
    assert.equal(verdict.reasons.some((reason) => reason.policyId === "__scam::risk"), false,
      "A provider failure is not a detected scam or a replacement policy verdict");
  }
});

test("AH5 prepared raw history crosses fresh manual/check plans and preserves cache provenance through WASM", options, async (t) => {
  const setup = harness({ policy: policyWithFact(), limits: { planTtlMs: 500 } });
  const { provider, raw, policyCalls, advance } = ah5Provider(setup);
  const { core } = await open(t, setup, sf45Fixture());
  const preparation = await core.plan(observedEthSwap);
  assert.equal(await provider.prepare(preparation.scamCalls,
    { planId: preparation.planId, timeoutMs: 1_000 }), undefined);
  const afterPreparation = raw.calls.length;
  advance();
  assert.throws(() => core.evaluate(preparation, policyBatch(preparation.calls, preparation)), code("PLAN_EXPIRED"));

  const plan = await core.plan(observedEthSwap);
  assert.notEqual(plan.planId, preparation.planId);
  const context = { planId: plan.planId };
  const policyFacts = await provider.fetch(plan.calls, context);
  const scamFacts = await provider.fetch(plan.scamCalls, context);
  assert.equal(scamFacts.planId, plan.planId);
  const byMethod = Object.fromEntries(plan.scamCalls.map((call) => [call.method, scamFacts.results[call.callId]]));
  const history = byMethod["scam.pool_history"], profile = byMethod["scam.token_profile"];
  assert.equal(history.observedAt, NOW + 1_000);
  assert.equal(profile.observedAt, NOW + 1_000);
  assert.deepEqual(history.value.reference, profile.value.reference);
  assert.equal(history.value.reference.block.number, "1001");
  assert.equal(history.value.reference.block.timestampMs, T + 1_000);
  assert.equal(history.value.reference.checkedHead.number, "1003");
  assert.equal(history.value.referenceGroupId, plan.scamCalls[0].params.referenceGroupId);
  assert.equal(history.value.histories[0].history.points[0].reserveQuote, "2000",
    "A fresh seed rebuilds the new window instead of returning a prepared Fact");
  assert.equal(history.value.verification.history, "rpc_anchor");
  assert.equal(history.value.verification.stateBinding, "number_recheck");
  assert.equal(history.value.verification.reuse, "interval_cache");
  assert.deepEqual(history.value.verification.rawObservedAt, { fromMs: NOW, toMs: NOW + 1_000 });
  assert.equal(history.value.verification.verifiedAt, NOW + 1_000);
  assert.equal(profile.value.verification.reuse, "none");
  assert.deepEqual(profile.value.verification.rawObservedAt, { fromMs: NOW + 1_000, toMs: NOW + 1_000 });
  const extension = raw.calls.slice(afterPreparation).filter((call) =>
    call.method === "eth_getLogs" && call.params[0].address === POOL);
  assert.deepEqual(extension.map(({ params }) => [params[0].fromBlock, params[0].toBlock]), [["0x3e9", "0x3e9"]],
    "The new reference downloads only the block beyond the prepared raw interval");

  const manual = core.evaluate(plan, policyFacts, scamFacts);
  const beforeCheck = raw.calls.length;
  const measurements = [];
  const checked = await checkWithTiming(core, observedEthSwap, undefined, (value) => { measurements.push(value); });
  assert.equal(manual.decision, "warn");
  assert.equal(manual.source, "evaluated");
  assert.equal(manual.scam.status, "warn");
  assert.equal(manual.scam.targets[0].analysisMode, "stub", "This integration uses an explicit fixed algorithm fixture");
  assert.equal(manual.scam.targets[0].binding.planId, plan.planId);
  assert.deepEqual(manual.scam.targets[0].binding.verification, {
    status: "declared", poolHistory: history.value.verification, tokenProfile: profile.value.verification,
  }, "Cache observations survive the real TypeScript/Rust/WASM boundary");
  assert.deepEqual(comparable(checked.scam), comparable(manual.scam));
  assert.notEqual(checked.scam.targets[0].binding.planId, plan.planId);
  assert.equal(checked.scam.targets[0].binding.planId, setup.fetches.find(({ scam }) => scam).context.planId);
  assert.equal(raw.calls.slice(beforeCheck).some((call) =>
    call.method === "eth_getLogs" && call.params[0].address === POOL), false);
  assert.ok(raw.calls.slice(beforeCheck).some((call) =>
    call.method === "eth_call" && call.params[0].data === "0x0902f1ac"), "check still reads the current window's seed");
  assert.equal(policyCalls.length, 2, "Preparation does not fetch policy Facts");
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].outcome, "completed");
  assert.ok(Number.isFinite(measurements[0].checkDurationMs) && measurements[0].checkDurationMs >= 0);
  assert.equal(measurements[0].decision, checked.decision);
  assert.equal(measurements[0].source, checked.source);
  assert.equal(measurements[0].scamStatus, "warn");
  assert.deepEqual(measurements[0].analysisModes, ["stub"]);
  t.diagnostic(`AH5 synthetic RPC / stub: checkDurationMs=${measurements[0].checkDurationMs.toFixed(2)}; performance acceptance is not evaluated`);
});

test("AH5 prepared-cache reorg and Runtime timeout preserve Cedar deny/warn without publishing scam data", options, async (t) => {
  const warnId = "ah5-existing-warning";
  const warningPolicy = signedPolicy({ extra: [{ id: warnId,
    policy: `@id("${warnId}") @severity("warn") forbid(principal, action == Amm::Action::"Swap", resource);`,
    manifest: { id: warnId, schema_version: 2, trigger: { where: { "action.tag": { eq: "swap" } } } } }] });
  for (const [failure, policy, request, decision, policyId] of [
    ["reorg", initialPolicy, redirectedSwap(), "deny", "swap-recipient-not-self-deny"],
    ["timeout", warningPolicy, swap, "warn", warnId],
  ]) {
    const setup = harness({ policy, scamLimits: { scamTimeoutMs: 500 } });
    const f = ah5Provider(setup);
    const { core } = await open(t, setup, sf45Fixture());
    const preparation = await core.plan(request);
    await f.provider.prepare(preparation.scamCalls, { planId: preparation.planId, timeoutMs: 1_000 });
    f.advance();
    const paused = failure === "timeout" ? f.pauseFinalRecheck() : undefined;
    if (failure === "reorg") f.reorgFinalRecheck();
    try {
      const pending = core.check(request);
      if (paused) await waitForFinalRecheck(paused, pending);
      const verdict = await pending;
      assert.equal(verdict.decision, decision, failure);
      assert.equal(verdict.source, "evaluated", failure);
      assert.ok(verdict.reasons.some((reason) => reason.policyId === policyId), failure);
      assert.equal(verdict.scam.status, "insufficient", failure);
      assert.ok(reasons(verdict).includes(failure), failure);
      assert.ok(verdict.scam.targets.every((target) => target.binding === undefined), failure);
      assert.equal(verdict.reasons.some((reason) => reason.policyId === "__scam::risk"), false);
      if (paused) assert.equal(paused.signal.aborted, true, "The Core timeout cancels the actual provider's final RPC");
    } finally { paused?.release(); }
    await tick();
  }
});

test("AH5 abort and disposal during a prepared-cache final recheck retain lifecycle semantics and reject late publication", options, async (t) => {
  for (const mode of ["abort", "dispose"]) {
    const published = [];
    const setup = harness({ scamLimits: { scamTimeoutMs: 1_000 } });
    setup.config.hooks = { onVerdict(value) { published.push(value); } };
    const f = ah5Provider(setup);
    const { core } = await open(t, setup, sf45Fixture());
    const preparation = await core.plan(swap);
    await f.provider.prepare(preparation.scamCalls, { planId: preparation.planId, timeoutMs: 1_000 });
    f.advance();
    const paused = f.pauseFinalRecheck();
    const controller = new AbortController();
    const pending = core.check(swap, { signal: controller.signal });
    const disposed = mode === "dispose" ? assert.rejects(pending, code("DISPOSED")) : undefined;
    try {
      await waitForFinalRecheck(paused, pending);
      assert.equal(published.length, 0, "Prepared data cannot publish before the current final recheck");
      if (mode === "abort") {
        controller.abort();
        const verdict = await pending;
        assert.equal(verdict.decision, "deny");
        assert.equal(verdict.source, "fail_closed");
        assert.ok(verdict.diagnostics.some(({ code }) => code === "aborted"));
      } else { core.dispose(); await disposed; }
      assert.equal(paused.signal.aborted, true, mode);
    } finally { paused.release(); }
    await tick();
    assert.equal(published.length, mode === "abort" ? 1 : 0, "The late raw reply cannot publish another verdict");
    if (mode === "dispose") await assert.rejects(core.check(swap), code("DISPOSED"));
    else {
      const beforeRetry = f.raw.calls.length;
      assert.equal((await core.check(swap)).scam.status, "warn");
      assert.ok(f.raw.calls.slice(beforeRetry).some((call) => call.method === "eth_getLogs"
        && call.params[0].address === POOL && call.params[0].fromBlock === "0x3e9"),
      "The aborted extension was not committed; the previously prepared interval remains reusable");
    }
  }
});
