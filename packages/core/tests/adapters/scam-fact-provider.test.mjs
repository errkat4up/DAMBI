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
const context = () => ({ planId: "opaque-plan:sf4-5", signal: new AbortController().signal });
const failure = (reason) => ({ name: "ScamDataError", reason });
const subject = (actionPaths = ["actions[0]"]) => ({ chainId: CHAIN, venue: "uniswap_v2",
  pool: POOL, factory: FACTORY, token: TOKEN, quoteToken: QUOTE, actionPaths });

function calls({ group = "opaque-group:a", prefix = "a", confirmDepth = 2, actionPaths, admin = false } = {}) {
  const common = { subject: subject(actionPaths), referenceGroupId: group, confirmDepth, builderVersion: "dambi-v2/1" };
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

test("scam provider shares references within groups but owns one deadline across groups and has no cross-fetch cache", async () => {
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
