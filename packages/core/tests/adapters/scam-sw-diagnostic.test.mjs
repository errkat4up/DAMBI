import test from "node:test";
import assert from "node:assert/strict";
import { installScamSwProbe } from "../../../../scripts/sdk/scam-sw-diagnostic.mjs";
import { createProbeSession, readProbeConfig } from "../../../../scripts/sdk/scam-data-probe-session.mjs";

function worker(id) {
  class ServiceWorkerGlobalScope {}
  const scope = new ServiceWorkerGlobalScope();
  Object.assign(scope, { ServiceWorkerGlobalScope,
    chrome: { runtime: { id: "dambi-test", getManifest: () => ({ name: "Dambi", version: "0.2.3" }) } },
    location: { href: "chrome-extension://dambi-test/js/background.js" },
    crypto: { randomUUID: () => id },
  });
  return scope;
}

function providerFactory(trace) {
  return (options) => {
    trace.push("provider");
    let prepared = false;
    return {
      async prepare() {
        trace.push("prepare"); prepared = true;
        options.onMetrics({ outcome: "partial", durationMs: 1 });
      },
      async fetch(calls, context) {
        trace.push("fetch");
        options.onMetrics({ outcome: "partial", durationMs: 1 });
        const call = calls[0];
        return { planId: context.planId, results: { [call.callId]: { value: {
          method: call.method, subject: call.params.subject, referenceGroupId: call.params.referenceGroupId,
          reference: { block: { number: "42", hash: `0x${"ab".repeat(32)}`, timestampMs: 42000 } },
          coverage: { missing: [], unavailable: [] }, histories: [{ history: { points: [] } }],
          verification: { history: "rpc_anchor", stateBinding: "number_recheck", reuse: prepared ? "interval_cache" : "none" },
        } } } };
      },
    };
  };
}

test("SW diagnostic guards the host, makes no I/O on install and keeps one provider across console calls", async () => {
  const trace = [], factory = providerFactory(trace), scope = worker("worker-a");
  assert.throws(() => installScamSwProbe({}, factory), /Service Worker/);
  const wrongHost = worker("wrong"); wrongHost.location.href = "https://example.test/";
  assert.throws(() => installScamSwProbe(wrongHost, factory), /Service Worker/);
  const wrongExtension = worker("wrong");
  wrongExtension.chrome.runtime.getManifest = () => ({ name: "Another extension" });
  assert.throws(() => installScamSwProbe(wrongExtension, factory), /Service Worker/);
  const api = installScamSwProbe(scope, factory);
  assert.deepEqual(trace, []);
  assert.equal(api.report().started, false);
  assert.throws(() => api.fetch(), /start/);
  assert.throws(() => installScamSwProbe(scope, factory), /Already installed/);
  assert.equal(scope.dambiScamProbe, api);
  const initial = api.start();
  assert.equal(initial.data.settings.timeoutMs, 2500);
  assert.equal(initial.data.settings.prepareTimeoutMs, 60000);
  assert.deepEqual(trace, ["provider"]);
  assert.throws(() => api.start(), /already started/);
  await api.prepare();
  const first = await api.fetch(), second = await api.fetch();
  assert.deepEqual(trace, ["provider", "prepare", "fetch", "fetch"]);
  assert.equal(first.facts[0].verification.reuse, "interval_cache");
  assert.equal(first.facts[0].referenceRelation, "unknown");
  assert.equal(second.facts[0].referenceRelation, "same");
  assert.equal(api.report().data.summary.partial, 2);
  // This verifies separate host objects, not a real browser worker restart.
  const newScope = worker("worker-b"), restarted = installScamSwProbe(newScope, factory);
  assert.equal(restarted.report().workerSessionId, "worker-b");
  assert.notEqual(restarted.report().workerSessionId, api.report().workerSessionId);
  restarted.start({ SCAM_TIMEOUT_MS: "60000", SCAM_REPEATS: "1" });
  const cold = await restarted.fetch();
  assert.equal(cold.facts[0].verification.reuse, "none");
  assert.equal(cold.facts[0].referenceRelation, "unknown");
  assert.equal(restarted.report().data.settings.timeoutMs, 60000);
  assert.equal(restarted.report().data.summary.targetBudget.limitMs, 2500);
});

test("probe session isolates overlapping console calls, returned reports and failed-fetch baselines", async () => {
  let release, preparedEntered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { preparedEntered = resolve; });
  const trace = [];
  const config = readProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000", SCAM_REPEATS: "3" });
  const session = createProbeSession(config, (options) => {
    const provider = providerFactory(trace)(options);
    let fetches = 0;
    return {
      async prepare(...args) { preparedEntered(); await gate; return provider.prepare(...args); },
      async fetch(...args) {
        if (++fetches === 2) {
          options.onMetrics({ outcome: "failed", reason: "timeout", durationMs: 2500 });
          throw new Error("SECRET_RPC_PAYLOAD");
        }
        return provider.fetch(...args);
      },
    };
  });
  config.timeoutMs = 60000;
  assert.equal(session.report().settings.timeoutMs, 2500, "The running session owns its configuration");
  const pending = session.prepare();
  await entered;
  await assert.rejects(async () => session.fetch(), /busy/i);
  await assert.rejects(async () => session.prepare(), /busy/i);
  release();
  const prepared = await pending;
  prepared.outcome = "success";
  assert.equal(session.report().preparation.outcome, "partial");
  const first = await session.fetch();
  first.facts[0].reference.hash = `0x${"cd".repeat(32)}`;
  const report = session.report(); report.trials.length = 0;
  assert.equal(session.report().trials.length, 1);
  assert.equal(session.report().trials[0].facts[0].reference.hash, `0x${"ab".repeat(32)}`);
  const failed = await session.fetch();
  assert.equal(failed.outcome, "failed");
  const recovered = await session.fetch();
  assert.equal(recovered.facts[0].referenceRelation, "unknown", "Do not compare across a failed predecessor");
  assert.equal(session.report().summary.failed, 1);
  assert.equal(session.report().summary.partial, 2);
  assert.doesNotMatch(JSON.stringify(session.report()), /SECRET_RPC_PAYLOAD/);
  await assert.rejects(async () => session.fetch());
  await assert.rejects(async () => session.prepare());
  assert.deepEqual(trace, ["provider", "prepare", "fetch", "fetch"]);
});

test("a failed preparation stays explicit and cannot be reported as a warm fetch", async () => {
  let fetches = 0;
  const session = createProbeSession(readProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000" }), (options) => ({
    async prepare() {
      options.onMetrics({ outcome: "failed", reason: "timeout", durationMs: 60000 });
      throw new Error("SECRET_RPC_PAYLOAD");
    },
    async fetch() { fetches++; },
  }));
  assert.equal((await session.prepare()).outcome, "failed");
  await assert.rejects(async () => session.fetch());
  assert.equal(fetches, 0);
  assert.equal(session.report().fetchSkipped, "preparation_failed");
  assert.equal(session.report().trials.length, 0);
  assert.doesNotMatch(JSON.stringify(session.report()), /SECRET_RPC_PAYLOAD/);
});
