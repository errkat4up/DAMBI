import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "@dambi/core";
import { createScamFactProvider } from "@dambi/core/adapters";
import { createScamHistoryStore } from "../../dist/adapters/scam-history-store.js";
import { classifyAnalysis, readAnalysisProbeConfig, runAnalysisProbe } from "../../../../scripts/sdk/scam-analysis-probe.mjs";
import { scamProviderRpcFixture } from "./helpers/scam-provider-fixture.mjs";

const NOW = 1_800_000_000_000;
const rule = { id: "r1", enabled: true, kind: "change_count", metric: "quote_reserve",
  lookbackSec: 10, direction: "either", changeMode: "step", thresholdBps: 500, count: 2 };
const env = { SCAM_TIMEOUT_MS: "2500", SCAM_LOOKBACK_SEC: "10", SCAM_WARMUP_SEC: "0",
  SCAM_AGE_THRESHOLD_SEC: "60", SCAM_RPC_MIN_INTERVAL_MS: "0", SCAM_RULES_JSON: JSON.stringify([rule]) };

test("analysis probe declares real rules and accepts a 24-hour prefix without inventing deployment support", () => {
  const config = readAnalysisProbeConfig({ SCAM_WARMUP_SEC: "86400" });
  assert.equal(config.warmupSec, 86400);
  assert.equal(config.rules[0].changeMode, "cumulative");
  assert.equal(config.rules[1].kind, "switch_density");
  assert.deepEqual(config.factorySupport, []);
  const prepared = readAnalysisProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000" });
  assert.equal(prepared.historyCache.maxBlockSpan, 200_000);
  // A complete, empty 48-hour scan must actually be retainable, not just have
  // a truthy cache setting. Synthetic block metadata; no live RPC observations.
  const block = (number) => ({ number: String(number), hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`, timestampMs: number * 1000 });
  const entry = { key: "48-hour-scan", fromBlock: "1", toBlock: "172800",
    start: block(1), end: block(172800), logs: [], storedAt: 1, rawObservedAt: { fromMs: 0, toMs: 1 } };
  const oldCapacity = createScamHistoryStore({ ...prepared.historyCache, maxBlockSpan: 100_000 });
  assert.equal(oldCapacity.put(entry, oldCapacity.generation), false);
  const store = createScamHistoryStore(prepared.historyCache);
  assert.equal(store.put(entry, store.generation), true);
  assert.deepEqual(store.get(entry.key, "1", "172800", "172800", 2).missing, []);
  assert.equal(readAnalysisProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_CACHE_MAX_BLOCK_SPAN: "300000" })
    .historyCache.maxBlockSpan, 300_000);
  for (const invalid of [{ SCAM_WARMUP_SEC: "86401" }, { SCAM_RULES_JSON: "[]" },
    { SCAM_CACHE_MAX_BLOCK_SPAN: "0" }, { SCAM_CACHE_MAX_BLOCK_SPAN: "1000001" },
    { SCAM_RULES_JSON: "SECRET" }, { SCAM_RULES_JSON: JSON.stringify([{ ...rule, enabled: false }]) }]) {
    assert.throws(() => readAnalysisProbeConfig(invalid), (error) => !error.message.includes("SECRET"));
  }
});

function verdict() {
  const subject = readAnalysisProbeConfig(env).subjects[0];
  return { decision: "warn", source: "evaluated", scam: { status: "warn", reasons: [], targets: [{
    subject, status: "warn", reasons: [], analysisMode: "real",
    binding: { algorithm: { id: "dambi.scam.window-rules", version: "0.2.0", contractVersion: 2 },
      reference: { block: { number: "1000", hash: `0x${"11".repeat(32)}`, timestampMs: NOW } } },
    rules: [{ ruleId: "r1", state: "fired", initialState: "satisfied", reasons: [],
      coverage: { missing: [], unavailable: [] }, evidence: { observed: 2, threshold: 2, coverageBps: 10000, warmupComplete: true } }],
  }] } };
}

test("analysis statistics never count stub, incomplete warnings, unknown age or policy failure as complete", () => {
  const subjects = readAnalysisProbeConfig(env).subjects;
  assert.equal(classifyAnalysis(verdict(), subjects).outcome, "success");
  for (const mutate of [
    (v) => { v.scam.targets[0].rules[0].evidence.warmupComplete = false; },
    (v) => { v.scam.targets[0].rules[0].coverage.missing = [{}]; },
    (v) => { v.scam.targets[0].rules[0].initialState = "unsatisfied"; },
    (v) => { v.scam.targets[0].reasons = ["age_unknown"]; },
    (v) => { v.scam.targets[0].binding.algorithm.version = "9.9.9"; },
    (v) => { v.scam.targets.push(structuredClone(v.scam.targets[0])); },
  ]) {
    const v = verdict(); mutate(v);
    assert.equal(classifyAnalysis(v, subjects).outcome, "partial");
  }
  const stub = verdict(); stub.scam.targets[0].analysisMode = "stub";
  assert.equal(classifyAnalysis(stub, subjects).reason, "algorithm_not_real");
  const policy = verdict(); policy.source = "fail_closed";
  assert.equal(classifyAnalysis(policy, subjects).reason, "policy_failed");
  const absent = verdict(); absent.scam.status = "not_applicable";
  assert.equal(classifyAnalysis(absent, subjects).reason, "not_evaluated");
  const timeout = verdict(); timeout.scam.status = "insufficient"; timeout.scam.reasons = ["timeout", "SECRET_REMOTE"];
  const result = classifyAnalysis(timeout, subjects);
  assert.equal(result.reason, "timeout");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  timeout.scam.reasons = ["no_time_budget"];
  assert.equal(classifyAnalysis(timeout, subjects).reason, "no_time_budget", "No remaining budget is not an observed execution timeout");
});

function localRun(overrides = {}, failure) {
  const base = readAnalysisProbeConfig(env);
  const subject = base.subjects[0];
  const raw = scamProviderRpcFixture({ now: NOW, ...subject, failure });
  const config = readAnalysisProbeConfig({ ...env, SCAM_REPEATS: "2",
    SCAM_FACTORY_SUPPORT_JSON: JSON.stringify(raw.factorySupport),
    SCAM_RPC_URL: "https://SECRET_HOST.invalid/SECRET_PATH",
    SCAM_RPC_HEADERS_JSON: '{"authorization":"SECRET_HEADER"}', ...overrides });
  let prepared = 0, checked = 0;
  return { raw, config, get prepared() { return prepared; }, get checked() { return checked; },
    run: () => runAnalysisProbe(config, { now: () => NOW, createCore,
      createProvider(options) {
        const provider = createScamFactProvider({ ...options, rpc: { ...options.rpc,
          fetch: raw.rpc.fetch, clock: raw.rpc.clock } });
        return { fetch(...args) { checked++; return provider.fetch(...args); },
          prepare(...args) { prepared++; return provider.prepare(...args); } };
      } }) };
}

test("analysis probe reaches production WASM through signed local bundles and real builders", async () => {
  const f = localRun();
  const result = await f.run();
  assert.equal(result.initialization.outcome, "success");
  assert.equal(result.summary.attempts, 2);
  assert.equal(result.summary.success, 2);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.partial, 0);
  assert.equal(f.prepared, 0);
  for (const trial of result.trials) {
    assert.equal(trial.realAnalysisTargets, 1);
    assert.equal(trial.scamStatus, "warn");
    assert.equal(trial.targets[0].rules[0].observed, 2);
    assert.equal(trial.targets[0].algorithm.contractVersion, 2);
    assert.equal(trial.plannedHistories[0].lookbackSec, 10);
    assert.ok(trial.provider.requests > 0);
    assert.ok(trial.facts.length === 2);
  }
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE KEY/);
  assert.equal(f.raw.calls.some((c) => c.method.includes("send") || c.method.includes("sign")), false);
});

test("analysis probe keeps failed RPC and target mismatches out of success statistics", async () => {
  const missing = localRun({ SCAM_REPEATS: "1" }, "missing_history");
  const result = await missing.run();
  assert.equal(result.summary.success, 0);
  assert.equal(result.summary.insufficient, 1);
  assert.equal(result.summary.partialRatio, 1);
  assert.equal(result.summary.targetBudget.allAttemptsCompleteWithinBudget, false);
  const wrong = localRun({ SCAM_REPEATS: "1", SCAM_POOL: `0x${"55".repeat(20)}` });
  const mismatch = await wrong.run();
  assert.equal(mismatch.trials[0].reason, "target_mismatch");
  assert.equal(wrong.raw.calls.length, 0, "A mismatched planned target is rejected before RPC");
});

test("analysis probe measures preparation separately and reuses raw history without skipping real checks", async () => {
  const f = localRun({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000" });
  const result = await f.run();
  assert.equal(f.prepared, 1);
  assert.notEqual(result.preparation.outcome, "failed");
  assert.equal(result.summary.attempts, 2);
  assert.equal(result.summary.success, 2);
  assert.ok(result.trials.every((t) => t.realAnalysisTargets === 1
    && t.facts.find((f) => f.method === "scam.pool_history").verification.reuse === "interval_cache"));
  assert.equal(result.summary.completedLatencyMs.samples, 2, "Preparation is not a check sample");
  const failed = await runAnalysisProbe(f.config, { now: () => NOW, createCore, createProvider: () => ({
    async prepare() { throw new Error("SECRET_PREPARATION"); },
    async fetch() { assert.fail("Failed preparation must not silently become a cold check"); },
  }) });
  assert.equal(failed.checkSkipped, "preparation_failed");
  assert.equal(failed.summary.attempts, 0);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
