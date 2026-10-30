import assert from "node:assert/strict";
import test from "node:test";
import { createScamFactProvider } from "../../dist/adapters/index.js";
import { scamProviderRpcFixture } from "./helpers/scam-provider-fixture.mjs";

const NOW = 1_800_000_000_000;
const CHAIN = 91342;
const POOL = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;
const QUOTE = `0x${"44".repeat(20)}`;
const historyCache = () => ({ maxEntries: 8, maxBytes: 1_000_000, ttlMs: 60_000, maxBlockSpan: 10_000 });
const context = () => ({ planId: "opaque-plan:sf4-5", signal: new AbortController().signal });
const failure = (reason) => ({ name: "ScamDataError", reason });
const subject = (actionPaths = ["actions[0]"]) => ({ chainId: CHAIN, venue: "uniswap_v2",
  pool: POOL, factory: FACTORY, token: TOKEN, quoteToken: QUOTE, actionPaths });

function calls({ group = "opaque-group:a", prefix = "a", confirmDepth = 2, actionPaths, admin = false } = {}) {
  const common = { subject: subject(actionPaths), referenceGroupId: group, confirmDepth, builderVersion: "dambi-v2/2" };
  return [
    { callId: `${prefix}:history`, manifestId: "__scam::history", method: "scam.pool_history", optional: true, outputs: [],
      params: { ...structuredClone(common), dataSchema: "scam.pool_history/1", lookbackSec: 10, warmupSec: 1,
        metrics: ["quote_reserve", "price_quote_per_token"], candidateResolutions: [{ bucketMs: 1_000, gridOriginMs: 0 }] } },
    { callId: `${prefix}:profile`, manifestId: "__scam::profile", method: "scam.token_profile", optional: true, outputs: [],
      params: { ...structuredClone(common), dataSchema: "scam.token_profile/1", ageThresholdSec: 60,
        ageSearchMaxLookbackSec: 10, maxAgeSearchCalls: 16, eventLookbackSec: admin ? 10 : 0, eventKinds: admin ? ["paused"] : [] } },
  ];
}

function setup({ rawFailure, providerOptions = {}, onMetrics } = {}) {
  const raw = scamProviderRpcFixture({ now: NOW, chainId: CHAIN, factory: FACTORY,
    pool: POOL, token: TOKEN, quoteToken: QUOTE, failure: rawFailure });
  const config = { rpc: raw.rpc, history: raw.history, profile: raw.profile, factorySupport: raw.factorySupport,
    policy: { async fetch(_calls, ctx) { return { planId: ctx.planId, results: {} }; } },
    limits: { timeoutMs: 500, maxCalls: 16, maxTargets: 8, maxRequestBytes: 100_000, maxResultBytes: 100_000 },
    ...(onMetrics ? { onMetrics } : {}), ...providerOptions };
  return { raw, config, create: () => createScamFactProvider(config) };
}

test("scam provider delegates ordinary batches unchanged and rejects mixed channels without raw work", async () => {
  const delegated = [];
  const sentinel = new Error("original policy failure");
  const result = { planId: "policy-result", results: {} };
  const policy = { fetch(input, ctx) {
    assert.equal(this, policy);
    delegated.push({ input, ctx });
    return input.length ? Promise.resolve(result) : Promise.reject(sentinel);
  } };
  const f = setup({ providerOptions: { policy } });
  const provider = f.create(), ctx = context();
  const ordinary = [{ callId: "plain", manifestId: "plain", method: "eth.balance", params: {}, optional: false, outputs: [] }];
  assert.equal(await provider.fetch(ordinary, ctx), result);
  assert.equal(delegated[0].input, ordinary);
  assert.equal(delegated[0].ctx, ctx);
  await assert.rejects(provider.fetch([], ctx), (error) => error === sentinel);
  await assert.rejects(provider.fetch([...calls(), ...ordinary], ctx), failure("invalid_scam_input"));
  assert.equal(delegated.length, 2);
  assert.equal(f.raw.calls.length, 0);
});

test("scam preparation requires a bounded cache budget and never delegates policy or incomplete calls", async () => {
  const unavailable = setup();
  await assert.rejects(unavailable.create().prepare(calls(), { ...context(), timeoutMs: 1_000 }),
    { name: "AdapterError", code: "INVALID_CONFIG" });
  assert.equal(unavailable.raw.calls.length, 0);

  let delegated = 0;
  const f = setup({ providerOptions: { policy: { async fetch() { delegated++; throw new Error("must not delegate"); } } } });
  f.config.rpc = { ...f.raw.rpc, historyCache: historyCache() };
  const provider = f.create();
  for (const timeoutMs of [undefined, 0, -1, 1.5, 60_001]) {
    await assert.rejects(provider.prepare(calls(), { ...context(), timeoutMs }), { name: "AdapterError", code: "INVALID_CONFIG" });
  }
  const ordinary = [{ callId: "policy", manifestId: "policy", method: "eth.balance", params: {}, optional: false, outputs: [] }];
  for (const input of [[], ordinary, [...ordinary, ...calls()], calls().slice(0, 1)]) {
    await assert.rejects(provider.prepare(input, { ...context(), timeoutMs: 1_000 }), failure("invalid_scam_input"));
  }
  assert.equal(delegated, 0);
  assert.equal(f.raw.calls.length, 0, "Preparation validates complete scam-only pairs before RPC work");
});

test("scam preparation reuses raw history while a new plan rebuilds state and preserves original observation times", async () => {
  const metrics = [];
  const f = setup({ onMetrics: (metric) => metrics.push(metric) });
  let now = NOW, prepared = false;
  const originalFetch = f.raw.rpc.fetch;
  f.config.rpc = { ...f.raw.rpc, historyCache: historyCache(), verification: { history: "rpc_anchor" },
    clock: { now: () => now }, fetch: async (...args) => {
      const rpc = JSON.parse(args[1].body);
      const response = await originalFetch(...args);
      if (prepared && rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac") {
        const body = await response.json();
        body.result = `0x${1000n.toString(16).padStart(64, "0")}${2000n.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
        return new Response(JSON.stringify(body));
      }
      return response;
    } };
  const provider = f.create();
  assert.equal(await provider.prepare(calls({ prefix: "prepared", group: "prepare-group" }),
    { ...context(), planId: "preparation", timeoutMs: 1_000 }), undefined);
  const before = f.raw.calls.length;
  assert.ok(f.raw.calls.some((rpc) => rpc.method === "eth_getLogs"));
  prepared = true;
  now += 20;
  const batch = await provider.fetch(calls({ prefix: "sign", group: "sign-group" }), { ...context(), planId: "fresh-sign-plan" });
  assert.equal(batch.planId, "fresh-sign-plan");
  assert.deepEqual(Object.keys(batch.results), ["sign:history", "sign:profile"]);
  const history = batch.results["sign:history"], profile = batch.results["sign:profile"];
  assert.equal(history.observedAt, NOW + 20);
  assert.equal(profile.observedAt, NOW + 20);
  assert.equal(history.value.referenceGroupId, "sign-group");
  assert.equal(history.value.histories[0].history.points[0].reserveQuote, "2000",
    "The signing fetch rebuilds snapshots from fresh state instead of returning prepared Facts");
  assert.deepEqual(history.value.verification.rawObservedAt, { fromMs: NOW, toMs: NOW + 20 });
  assert.equal(history.value.verification.reuse, "interval_cache");
  assert.equal(history.value.verification.verifiedAt, NOW + 20);
  assert.equal(profile.value.verification.reuse, "none", "A history cache hit does not mark the unrelated profile as reused");
  assert.deepEqual(profile.value.verification.rawObservedAt, { fromMs: NOW + 20, toMs: NOW + 20 });
  const after = f.raw.calls.slice(before);
  assert.equal(after.filter((rpc) => rpc.method === "eth_getLogs").length, 0);
  assert.ok(after.some((rpc) => rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac"));
  assert.ok(after.some((rpc) => rpc.method === "eth_getBlockByNumber"), "Cached boundaries still receive current checks");
  assert.equal(metrics[1].resultBytes, Buffer.byteLength(JSON.stringify(batch), "utf8"));
});

test("scam preparation keeps its separate deadline and never returns or caches a failed draft", async () => {
  const f = setup();
  let now = NOW;
  const originalFetch = f.raw.rpc.fetch;
  f.config.limits.timeoutMs = 50;
  f.config.rpc = { ...f.raw.rpc, historyCache: historyCache(), clock: { now: () => now }, fetch: (...args) => {
    if (JSON.parse(args[1].body).method === "eth_chainId") now += 100;
    return originalFetch(...args);
  } };
  const provider = f.create();
  assert.equal(await provider.prepare(calls(), { ...context(), timeoutMs: 1_000 }), undefined);
  await assert.rejects(provider.fetch(calls(), context()), failure("timeout"), "Preparation must not enlarge the signing-fetch budget");

  const metrics = [];
  const failing = setup({ rawFailure: "reorg", onMetrics: (metric) => metrics.push(metric) });
  failing.config.rpc = { ...failing.raw.rpc, historyCache: historyCache() };
  const checked = failing.create();
  await assert.rejects(checked.prepare(calls(), { ...context(), timeoutMs: 1_000 }), failure("reorg"));
  assert.equal(metrics[0].resultBytes, 0);
  const before = failing.raw.calls.length;
  const batch = await checked.fetch(calls(), { ...context(), planId: "after-failed-preparation" });
  assert.equal(batch.results["a:history"].value.verification.reuse, "none");
  assert.ok(failing.raw.calls.slice(before).some((rpc) => rpc.method === "eth_getLogs"), "An unverified preparation cannot seed the cache");
});

test("scam provider owns caller inputs and retains exact opaque IDs while requiring bound method pairs", async () => {
  const metrics = [];
  const f = setup({ onMetrics: (metric) => metrics.push(metric) });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const originalFetch = f.raw.rpc.fetch;
  f.config.rpc = { ...f.raw.rpc, fetch: async (...args) => {
    entered(); await gate; return originalFetch(...args);
  } };
  const provider = f.create(), input = calls(), ctx = context();
  input[0].callId = "__proto__";
  input[1].callId = "constructor";
  const pending = provider.fetch(input, ctx);
  await started;
  input[0].params.subject.pool = TOKEN;
  input[0].params.candidateResolutions[0].bucketMs = 0;
  input[1].params.eventKinds.push("paused");
  input[1].callId = "mutated";
  input.push(...calls({ prefix: "ignored-late-addition" }));
  ctx.planId = "mutated-plan";
  release();
  const batch = await pending;
  assert.equal(batch.planId, "opaque-plan:sf4-5");
  assert.deepEqual(Object.keys(batch.results), ["__proto__", "constructor"]);
  assert.equal(batch.results.__proto__.value.subject.pool, POOL);
  assert.equal(batch.results.__proto__.value.histories[0].history.bucketMs, 1_000);
  assert.deepEqual(batch.results.constructor.value.events, []);
  assert.equal(metrics[0].calls, 2, "Metrics use the owned call count, not a mutated caller array");
  const before = f.raw.calls.length;
  const mutations = [
    (pair) => { pair[1].callId = pair[0].callId; },
    (pair) => { pair[1].params.referenceGroupId = "foreign-group"; },
    (pair) => { pair[1].params.confirmDepth = 1; },
    (pair) => { pair[1].params.subject.actionPaths = ["actions[1]"]; },
    (pair) => { pair[0].outputs.push({ kind: "context" }); },
    (pair) => { pair.pop(); },
  ];
  for (const mutate of mutations) {
    const invalid = calls(); mutate(invalid);
    await assert.rejects(provider.fetch(invalid, context()), failure("invalid_scam_input"));
  }
  assert.equal(f.raw.calls.length, before, "Malformed pairs fail before acquiring a reference");
});

test("scam provider shares references within groups but owns one deadline across groups and disables cross-fetch cache by default", async () => {
  const metrics = [];
  const f = setup({ onMetrics: (metric) => metrics.push(metric) }), provider = f.create();
  const first = calls();
  const sameGroup = calls({ prefix: "sibling", actionPaths: ["actions[1]"] });
  const second = calls({ group: "opaque-group:b", prefix: "b", confirmDepth: 1, actionPaths: ["actions[2]"] });
  const batch = await provider.fetch([...first, ...sameGroup, ...second], context());
  assert.equal(batch.results["a:history"].blockNumber, "1000");
  assert.deepEqual(batch.results["a:history"].value.reference, batch.results["sibling:profile"].value.reference);
  assert.equal(batch.results["b:history"].blockNumber, "1001");
  assert.deepEqual(batch.results["b:history"].value.reference, batch.results["b:profile"].value.reference);
  assert.equal(f.raw.calls.filter((rpc) => rpc.method === "eth_chainId").length, 2);
  assert.equal(metrics[0].preflightGroup, 2, "The lower bound describes the last raw reference group, not all targets");
  assert.ok(metrics[0].preflight);
  await provider.fetch(first, context());
  assert.equal(f.raw.calls.filter((rpc) => rpc.method === "eth_chainId").length, 3,
    "Even reusing an opaque plan ID cannot reuse unqualified old results");
  assert.equal(metrics[1].preflightGroup, 1);

  const timeoutMetrics = [];
  const timeout = setup({ onMetrics: (metric) => timeoutMetrics.push(metric) });
  let now = NOW, groups = 0, referenceReads = 0;
  const originalFetch = timeout.raw.rpc.fetch;
  timeout.config.rpc = { ...timeout.raw.rpc, clock: { now: () => now }, fetch: async (...args) => {
    const rpc = JSON.parse(args[1].body);
    if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "0x3e8" && ++referenceReads === 2) now = NOW + 400;
    if (rpc.method === "eth_chainId" && ++groups === 2) now = NOW + 501;
    return originalFetch(...args);
  } };
  await assert.rejects(timeout.create().fetch([...first, ...second], context()), failure("timeout"));
  assert.equal(groups, 2, "The second reference group gets only the remaining complete-fetch budget");
  assert.equal(timeoutMetrics[0].preflight, undefined, "Do not attach an earlier group's preflight to a later reference failure");
  assert.equal(timeoutMetrics[0].preflightGroup, undefined);
});

test("scam provider reports per-method raw time sources only after final verification and counts metadata in its result budget", async () => {
  for (const mode of ["all_event_headers", "rpc_anchor"]) {
    const f = setup();
    const originalFetch = f.raw.rpc.fetch;
    let now = NOW, referenceReads = 0;
    const verification = { history: mode, stateBinding: "number_recheck" };
    f.config.rpc = { ...f.raw.rpc, verification, clock: { now: () => now }, fetch: async (...args) => {
      const rpc = JSON.parse(args[1].body);
      const response = await originalFetch(...args);
      if (rpc.method === "eth_getLogs") {
        const body = await response.json();
        const originSec = BigInt(NOW / 1_000) - 1_002n;
        for (const log of body.result) log.blockTimestamp = `0x${(originSec + BigInt(log.blockNumber)).toString(16)}`;
        return new Response(JSON.stringify(body));
      }
      if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "0x3e8" && ++referenceReads === 2) now = NOW + 25;
      return response;
    } };
    const provider = f.create();
    verification.history = mode === "rpc_anchor" ? "all_event_headers" : "rpc_anchor";
    verification.stateBinding = "block_hash_canonical";
    const batch = await provider.fetch(calls(), context());
    const history = batch.results["a:history"].value.verification;
    const profile = batch.results["a:profile"].value.verification;
    const expected = { version: 1, history: mode, stateBinding: "number_recheck",
      reuse: "none", rawObservedAt: { fromMs: NOW, toMs: NOW }, verifiedAt: NOW + 25 };
    assert.deepEqual(history, { ...expected, timeSources: ["header", "rpc_log"] });
    assert.deepEqual(profile, { ...expected, timeSources: ["header"] });
    assert.equal(referenceReads, 2, "Metadata is emitted after the reference's final read");
    assert.ok(Object.isFrozen(history) && Object.isFrozen(history.timeSources) && Object.isFrozen(history.rawObservedAt));
  }

  // A response that would fit without verification must still be rejected
  // when the complete SDK wrapper exceeds the caller's byte budget.
  const baseline = setup();
  const complete = await baseline.create().fetch(calls(), context());
  const withoutVerification = structuredClone(complete);
  for (const fact of Object.values(withoutVerification.results)) delete fact.value.verification;
  const limit = new TextEncoder().encode(JSON.stringify(withoutVerification)).byteLength;
  const metrics = [];
  const bounded = setup({ onMetrics: (metric) => metrics.push(metric) });
  bounded.config.limits.maxResultBytes = limit;
  await assert.rejects(bounded.create().fetch(calls(), context()), failure("resource_limit"));
  assert.equal(metrics[0].failure.operation, "result");
  assert.equal(metrics[0].resultBytes, 0, "Oversized provenance is never truncated or reported as returned data");
});

test("scam provider preserves the bounded preflight cause before spending an impossible header budget", async () => {
  const metrics = [];
  const f = setup({ onMetrics: (metric) => metrics.push(metric) });
  f.config.rpc.limits.maxRequests = 16;
  await assert.rejects(f.create().fetch(calls(), context()), failure("resource_limit"));
  assert.equal(metrics.length, 1);
  const metric = metrics[0];
  assert.equal(metric.failure.stage, "preflight");
  assert.equal(metric.failure.kind, "resource_limit");
  assert.equal(metric.failure.operation, "pool_history");
  assert.equal(metric.preflightGroup, 1);
  assert.equal(metric.preflight.uniqueLogBlocks, 2);
  assert.equal(metric.preflight.timestampedLogBlocks, 0);
  assert.ok(metric.preflight.minimumRemainingRequests > metric.preflight.remainingRequestBudget);
  assert.ok(metric.requests < 16);
  assert.equal(Object.isFrozen(metric.preflight), true);
  assert.equal(metric.resultBytes, 0);
});

test("scam provider snapshots explicit capabilities and never infers age or administrator support from a configured RPC", async () => {
  const f = setup();
  f.config.adminSupport = [{ id: "synthetic-admin-abi", chainId: CHAIN, token: TOKEN, abi: "openzeppelin_standard",
    kinds: ["paused"], validFromBlock: "0", validThroughBlock: "1002" }];
  const provider = f.create();
  f.config.factorySupport[0].nonRecreationSupportId = undefined;
  f.config.factorySupport.length = 0;
  f.config.adminSupport[0].kinds.length = 0;
  f.config.adminSupport[0].validThroughBlock = "0";
  f.config.history.maxPoints = 0;
  f.config.profile.maxEvents = 0;
  const retained = await provider.fetch(calls({ admin: true }), context());
  const retainedProfile = retained.results["a:profile"].value;
  assert.equal(retainedProfile.age.kind, "lower_bound");
  assert.deepEqual(retainedProfile.coverage.missing, []);
  assert.deepEqual(retainedProfile.coverage.unavailable, []);
  assert.deepEqual(retainedProfile.events, []);

  const unsupported = setup({ providerOptions: { factorySupport: undefined } });
  const batch = await unsupported.create().fetch(calls({ admin: true }), context());
  const profile = batch.results["a:profile"].value;
  assert.equal(profile.age.kind, "unknown");
  assert.ok(profile.coverage.unavailable.some(({ field }) => field === "adminEvents"));
  assert.ok(profile.coverage.missing.length > 0);
  assert.equal(unsupported.raw.calls.some((rpc) => rpc.method === "eth_getCode"), false);
  assert.equal(unsupported.raw.calls.some((rpc) => rpc.method === "eth_getLogs" && rpc.params[0].address === TOKEN), false);
  const duplicates = setup();
  duplicates.config.factorySupport.push({ ...duplicates.config.factorySupport[0] });
  assert.throws(() => duplicates.create(), { name: "AdapterError", code: "INVALID_CONFIG" });
});

test("scam provider enforces complete-fetch input, target and output limits without publishing a truncated batch", async () => {
  for (const kind of ["input", "calls", "targets", "output"]) {
    const metrics = [];
    const f = setup({ onMetrics: (metric) => metrics.push(metric) });
    const input = calls();
    if (kind === "input") f.config.limits.maxRequestBytes = 100;
    if (kind === "calls") { f.config.limits.maxCalls = 1; f.config.limits.maxTargets = 1; }
    if (kind === "output") f.config.limits.maxResultBytes = 100;
    if (kind === "targets") {
      f.config.limits.maxTargets = 1;
      input.push(...calls({ prefix: "extra", actionPaths: ["actions[1]"] }));
    }
    await assert.rejects(f.create().fetch(input, context()), failure("resource_limit"), kind);
    assert.equal(metrics.length, 1, kind);
    assert.equal(metrics[0].outcome, "failed", kind);
    assert.equal(metrics[0].reason, "resource_limit", kind);
    assert.equal(metrics[0].failure.kind, "resource_limit", kind);
    assert.equal(metrics[0].failure.operation, kind === "output" ? "result" : "request", kind);
    assert.equal(metrics[0].resultBytes, 0, "No truncated result was returned");
    assert.equal(f.raw.calls.length > 0, kind === "output", kind);
  }
});

test("scam provider emits bounded success, partial and failure metrics without allowing observers to change results", async () => {
  for (const [rawFailure, expected] of [[undefined, "success"], ["missing_history", "partial"], ["reorg", "failed"]]) {
    const metrics = [];
    const f = setup({ rawFailure, onMetrics: (metric) => { metrics.push(metric); throw new Error("observer-only failure"); } });
    const pending = f.create().fetch(calls(), context());
    if (rawFailure === "reorg") await assert.rejects(pending, failure("reorg"));
    else assert.equal((await pending).planId, context().planId);
    assert.equal(metrics.length, 1);
    const metric = metrics[0];
    assert.equal(metric.outcome, expected);
    assert.equal(metric.reason, rawFailure === "reorg" ? "reorg" : undefined);
    assert.equal(metric.calls, 2);
    assert.equal(metric.targets, 1);
    assert.ok(metric.requests > 0 && metric.receivedBytes > 0);
    assert.ok(metric.logChunks > 0);
    assert.equal(metric.failedChunks > 0, rawFailure === "missing_history");
    assert.equal(metric.resultBytes > 0, expected !== "failed");
    if (expected !== "failed") assert.equal(metric.failure, undefined);
    assert.equal(Object.isFrozen(metric), true);
  }
  const rejectedObserver = setup({ onMetrics: async () => { throw new Error("async observer-only failure"); } });
  assert.equal((await rejectedObserver.create().fetch(calls(), context())).planId, context().planId);
  await new Promise((resolve) => setImmediate(resolve));
});

test("scam provider retains sanitized raw header diagnostics without changing data_missing or leaking them into a later success", async () => {
  const metrics = [];
  const f = setup({ onMetrics: (metric) => metrics.push(metric) });
  const originalFetch = f.raw.rpc.fetch;
  let failHeader = true;
  f.config.rpc = { ...f.raw.rpc,
    endpoint: { rpcUrl: "https://rpc.invalid/sf4-5?apiKey=provider-secret", headers: { authorization: "Bearer provider-secret" } },
    fetch: async (...args) => {
      const rpc = JSON.parse(args[1].body);
      if (failHeader && rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "0x3dd") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
          error: { code: -32000, message: "provider-secret https://rpc.invalid/private", data: { authorization: "provider-secret" } } }));
      }
      return originalFetch(...args);
    } };
  const provider = f.create();
  await assert.rejects(provider.fetch(calls(), context()), failure("data_missing"));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].reason, "data_missing");
  const diagnostic = metrics[0].failure;
  assert.equal(diagnostic.stage, "block_header");
  assert.equal(diagnostic.operation, "pool_history");
  assert.equal(diagnostic.kind, "json_rpc");
  assert.equal(diagnostic.method, "eth_getBlockByNumber");
  assert.equal(diagnostic.rpcCode, -32000);
  assert.equal(diagnostic.attempt, 1);
  assert.equal(Object.isFrozen(diagnostic), true);
  assert.throws(() => { diagnostic.rpcCode = 0; }, TypeError);
  assert.ok(Object.keys(diagnostic).every((key) => ["stage", "operation", "kind", "method", "httpStatus", "rpcCode", "attempt"].includes(key)));
  assert.equal(JSON.stringify(metrics[0]).includes("provider-secret"), false);
  assert.equal(JSON.stringify(metrics[0]).includes("https://"), false);
  failHeader = false;
  assert.equal((await provider.fetch(calls(), context())).planId, context().planId);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[1].outcome, "success");
  assert.equal(metrics[1].reason, undefined);
  assert.equal(metrics[1].failure, undefined);
});
