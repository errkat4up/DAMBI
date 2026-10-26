import test from "node:test";
import assert from "node:assert/strict";
import { readProbeConfig, probeCalls, runProbe, summarizeTrials } from "../../../../scripts/sdk/scam-data-probe.mjs";

test("data probe keeps explicit bounded inputs and never assumes deployment capabilities", () => {
  const config = readProbeConfig({});
  assert.equal(config.chainId, 91342);
  assert.equal(config.timeoutMs, 2500);
  assert.equal(config.repeats, 1);
  assert.equal(config.lookbackSec, 86400);
  assert.equal(config.warmupSec, 3600);
  assert.equal(config.minRequestIntervalMs, 100);
  assert.equal(config.retryDelayMs, 1000);
  assert.equal(config.maxRetryDelayMs, 8000);
  assert.deepEqual(config.verification, { history: "all_event_headers", stateBinding: "number_recheck" });
  assert.equal(Object.isFrozen(config.verification), true);
  assert.equal(config.historyCache, undefined);
  assert.equal(config.prepareTimeoutMs, undefined);
  assert.deepEqual(config.factorySupport, []);
  assert.deepEqual(config.adminSupport, []);
  assert.equal(config.subjects.length, 1);
  const unpaced = readProbeConfig({ SCAM_RPC_MIN_INTERVAL_MS: "0", SCAM_RPC_RETRY_BASE_MS: "0", SCAM_RPC_RETRY_MAX_MS: "0" });
  assert.equal(unpaced.minRequestIntervalMs, 0);
  assert.equal(unpaced.retryDelayMs, 0);
  assert.equal(unpaced.maxRetryDelayMs, 0);
  const prepared = readProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000" });
  assert.deepEqual(prepared.historyCache, { maxEntries: 8, maxBytes: 16_000_000, ttlMs: 120_000, maxBlockSpan: 100_000 });
  assert.equal(Object.isFrozen(prepared.historyCache), true);
  assert.equal(prepared.prepareTimeoutMs, 60_000);
  assert.equal(prepared.timeoutMs, 2500, "Preparation must not expand the fetch budget");
  for (const env of [
    { SCAM_REPEATS: "0" }, { SCAM_REPEATS: "21" }, { SCAM_REPEATS: "2e0" }, { SCAM_TIMEOUT_MS: "60001" },
    { SCAM_LOOKBACK_SEC: "86401" }, { SCAM_TARGETS_JSON: "[]" }, { SCAM_TARGETS_JSON: "SECRET_INVALID_JSON" },
    { SCAM_TOKEN: "0xshort" }, { SCAM_FACTORY_SUPPORT_JSON: "{}" }, { SCAM_RPC_HEADERS_JSON: '{"authorization":123}' },
    { SCAM_RPC_MIN_INTERVAL_MS: "60001" }, { SCAM_RPC_RETRY_BASE_MS: "-1" }, { SCAM_RPC_RETRY_MAX_MS: "60001" },
    { SCAM_RPC_RETRY_BASE_MS: "2000", SCAM_RPC_RETRY_MAX_MS: "1000" },
    { SCAM_HISTORY_VERIFICATION: "SECRET_INVALID_MODE" }, { SCAM_HISTORY_VERIFICATION: "" },
    { SCAM_HISTORY_VERIFICATION: "rpc_anchor " },
    { SCAM_HISTORY_CACHE: "2" }, { SCAM_HISTORY_CACHE: "true" },
    { SCAM_PREPARE_TIMEOUT_MS: "60000" },
    { SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "0" },
    { SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60001" },
  ]) assert.throws(() => readProbeConfig(env), (error) => {
    assert.doesNotMatch(error.message, /SECRET|authorization|0xshort/);
    return true;
  });
});

test("data probe creates one history/profile pair per explicit target and preserves both grids", () => {
  const base = readProbeConfig({}).subjects[0];
  const target = ({ pool, token, quoteToken, factory }) => ({ pool, token, quoteToken, factory });
  const config = readProbeConfig({ SCAM_TARGETS_JSON: JSON.stringify([
    target(base), target({ ...base, pool: `0x${"11".repeat(20)}`, token: `0x${"22".repeat(20)}` }),
  ]) });
  const calls = probeCalls(config, 3);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map((call) => call.callId)).size, 4);
  assert.equal(calls[0].params.referenceGroupId, calls[1].params.referenceGroupId);
  assert.notEqual(calls[0].params.referenceGroupId, calls[2].params.referenceGroupId);
  assert.equal(calls[2].params.referenceGroupId, calls[3].params.referenceGroupId);
  assert.ok(calls.every((call) => call.optional === true && call.outputs.length === 0));
  assert.deepEqual(calls[0].params.candidateResolutions, [
    { bucketMs: 10000, gridOriginMs: 0 }, { bucketMs: 60000, gridOriginMs: 0 },
  ]);
  assert.equal(calls[1].params.eventKinds.length, 5);
  assert.equal(calls[3].params.subject.token, config.subjects[1].token);
});

test("data probe percentiles separate partial coverage and keep failures in the denominator", () => {
  const result = summarizeTrials([
    { outcome: "success", durationMs: 10 }, { outcome: "partial", durationMs: 100 },
    { outcome: "success", durationMs: 30 }, { outcome: "failed", reason: "timeout", durationMs: 2500 },
    { outcome: "failed", reason: "resource_limit", durationMs: 5 },
  ]);
  assert.deepEqual(result.successOnlyLatencyMs, { samples: 2, p50: 10, p95: 30 });
  assert.deepEqual(result.completedLatencyMs, { samples: 3, p50: 30, p95: 100 });
  assert.equal(result.attempts, 5);
  assert.equal(result.failureRatio, 2 / 5);
  assert.equal(result.timeoutRatio, 1 / 5);
  assert.equal(result.partialRatio, 1 / 5);
  assert.deepEqual(summarizeTrials([{ outcome: "failed", reason: "timeout", durationMs: 2500 }]).successOnlyLatencyMs,
    { samples: 0, p50: null, p95: null });
  assert.deepEqual(result.targetBudget, { limitMs: 2500, successWithinBudget: 2, partialWithinBudget: 1,
    completedOverBudget: 0, failedAttempts: 2, allAttemptsCompleteWithinBudget: false });
  assert.deepEqual(summarizeTrials([
    { outcome: "success", durationMs: 2501 }, { outcome: "partial", durationMs: 2500 },
    { outcome: "success", durationMs: 2500 },
  ]).targetBudget, { limitMs: 2500, successWithinBudget: 1, partialWithinBudget: 1,
    completedOverBudget: 1, failedAttempts: 0, allAttemptsCompleteWithinBudget: false });
  assert.equal(summarizeTrials([]).targetBudget.allAttemptsCompleteWithinBudget, false);
});

test("data probe prepares raw history once and measures independent fetch budgets without mixing preparation into results", async () => {
  const config = readProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000",
    SCAM_HISTORY_VERIFICATION: "rpc_anchor", SCAM_REPEATS: "2" });
  const operations = [];
  let providers = 0, prepared = false, fetches = 0;
  const result = await runProbe(config, (options) => {
    providers++;
    assert.deepEqual(options.rpc.historyCache, config.historyCache);
    assert.equal(options.limits.timeoutMs, 2500);
    const report = (requests, durationMs) => options.onMetrics({ outcome: "partial", durationMs,
      requests, retries: 0, receivedBytes: 1000, logChunks: 1, failedChunks: 0, resultBytes: 500 });
    return {
      async prepare(calls, context) {
        operations.push("prepare");
        assert.equal(context.planId, "manual-probe:prepare");
        assert.equal(context.timeoutMs, 60_000);
        assert.equal(calls.length, 2);
        assert.match(calls[0].params.referenceGroupId, /probe:prepare:/);
        prepared = true;
        report(29, 6000);
      },
      async fetch(calls, context) {
        assert.equal(prepared, true);
        operations.push("fetch");
        assert.equal(context.planId, `manual-probe:${fetches++}`);
        assert.equal(Object.hasOwn(context, "timeoutMs"), false);
        assert.doesNotMatch(calls[0].params.referenceGroupId, /prepare/);
        report(8, 1000);
        return { planId: context.planId, results: { [calls[0].callId]: { value: {
          method: "scam.pool_history", reference: { block: { number: String(42 + fetches) } },
          coverage: { missing: [], unavailable: [] }, histories: [{ history: { points: [1] } }],
          verification: { history: "rpc_anchor", stateBinding: "number_recheck", reuse: "interval_cache",
            rawObservedAt: { fromMs: 1000, toMs: 2000, secret: "SECRET" }, verifiedAt: 3000 + fetches },
        } } } };
      },
    };
  });
  assert.equal(providers, 1);
  assert.deepEqual(operations, ["prepare", "fetch", "fetch"]);
  assert.equal(result.preparation.outcome, "partial");
  assert.equal(result.preparation.providerDurationMs, 6000);
  assert.equal(result.preparation.timeoutMs, 60000);
  assert.equal(result.preparation.requests, 29);
  assert.equal(Object.hasOwn(result.preparation, "facts"), false, "prepare publishes no analysis FactBatch");
  assert.equal(result.summary.attempts, 2);
  assert.equal(result.summary.partial, 2);
  assert.equal(result.summary.completedLatencyMs.samples, 2);
  assert.equal(result.summary.targetBudget.allAttemptsCompleteWithinBudget, false);
  assert.ok(result.trials.every((trial) => trial.requests === 8 && trial.providerDurationMs === 1000));
  assert.deepEqual(result.trials[0].facts[0].verification, { history: "rpc_anchor", stateBinding: "number_recheck",
    reuse: "interval_cache", rawObservedAt: { fromMs: 1000, toMs: 2000 }, verifiedAt: 3001 });
  assert.match(result.cache, /enabled/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(Object.hasOwn(result, "fetchSkipped"), false);
});

test("data probe reports preparation failure separately and skips fetch when preparation cannot complete", async () => {
  for (const mode of ["timeout", "unavailable", "no_metrics"]) {
    const config = readProbeConfig({ SCAM_HISTORY_CACHE: "1", SCAM_PREPARE_TIMEOUT_MS: "60000" });
    let fetches = 0;
    const result = await runProbe(config, (options) => ({
      ...(mode === "unavailable" ? {} : { async prepare() {
        if (mode === "timeout") options.onMetrics({ outcome: "failed", reason: "timeout", durationMs: 60000,
          requests: 3, retries: 0, receivedBytes: 0, logChunks: 0, failedChunks: 0, resultBytes: 0,
          failure: { stage: "reference", kind: "lifecycle", operation: "reference", secret: "SECRET" } });
        throw new Error("SECRET");
      } }),
      async fetch() { fetches++; throw new Error("must not fetch"); },
    }));
    assert.equal(fetches, 0);
    assert.equal(result.preparation.outcome, "failed");
    assert.equal(result.fetchSkipped, "preparation_failed");
    assert.equal(result.summary.attempts, 0);
    assert.equal(result.summary.timeouts, 0, "Preparation timeout is outside the fetch summary");
    assert.equal(result.summary.targetBudget.allAttemptsCompleteWithinBudget, false);
    assert.deepEqual(result.trials, []);
    if (mode === "timeout") {
      assert.equal(result.preparation.reason, "timeout");
      assert.deepEqual(result.preparation.failure, { stage: "reference", kind: "lifecycle", operation: "reference" });
    } else assert.equal(result.preparation.diagnostic,
      mode === "unavailable" ? "preparation_unavailable" : "terminal_metrics_missing");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test("data probe reports provider terminal metrics without leaking endpoints or upgrading partial results", async () => {
  const config = readProbeConfig({ SCAM_REPEATS: "2", SCAM_RPC_URL: "https://secret.invalid/?key=PRIVATE",
    SCAM_RPC_HEADERS_JSON: '{"authorization":"Bearer PRIVATE"}', SCAM_RPC_MIN_INTERVAL_MS: "250",
    SCAM_RPC_RETRY_BASE_MS: "2000", SCAM_RPC_RETRY_MAX_MS: "7000", SCAM_HISTORY_VERIFICATION: "rpc_anchor" });
  let options, runs = 0;
  const result = await runProbe(config, (input) => {
    options = input;
    return { async fetch(calls, context) {
      assert.equal(calls.length, 2);
      assert.equal(context.planId, `manual-probe:${runs}`);
      assert.deepEqual(input.rpc.verification, { history: "rpc_anchor", stateBinding: "number_recheck" });
      const failed = runs++ > 0;
      input.onMetrics({ outcome: failed ? "failed" : "partial", ...(failed && { reason: "timeout" }),
        durationMs: failed ? 2500 : 100, requests: failed ? 20 : 10, retries: failed ? 1 : 0,
        receivedBytes: 1000, logChunks: 2, failedChunks: 0, resultBytes: failed ? 0 : 500, targets: 1, calls: 2 });
      if (failed) throw new Error("PRIVATE https://secret.invalid/");
      return { planId: context.planId, results: {
        [calls[0].callId]: { value: { method: "scam.pool_history", reference: { block: { number: "42" } },
          verification: { history: "rpc_anchor", stateBinding: "number_recheck", endpoint: "https://PRIVATE.invalid/", secret: "PRIVATE" },
          coverage: { missing: [], unavailable: [] }, histories: [{ history: { points: [1, 2] } }] } },
        [calls[1].callId]: { value: { method: "scam.token_profile", reference: { block: { number: "42" } },
          coverage: { missing: [1], unavailable: [1] }, age: { kind: "unknown" }, events: [] } },
      } };
    } };
  });
  assert.equal(runs, 2);
  assert.deepEqual(options.factorySupport, []);
  assert.deepEqual(options.adminSupport, []);
  assert.equal(options.history.maxPoints, 20000);
  assert.equal(options.history.maxBlockLookups, 512);
  assert.equal(options.profile.maxBlockLookups, 512);
  assert.equal(options.rpc.limits.maxRequests, 512);
  assert.equal(options.rpc.limits.minRequestIntervalMs, 250);
  assert.equal(options.rpc.limits.retryDelayMs, 2000);
  assert.equal(options.rpc.limits.maxRetryDelayMs, 7000);
  assert.equal(options.rpc.limits.maxRetries, 1);
  assert.deepEqual(options.rpc.verification, { history: "rpc_anchor", stateBinding: "number_recheck" });
  assert.deepEqual(result.settings.verification, options.rpc.verification);
  assert.equal(result.settings.minRequestIntervalMs, 250);
  assert.equal(result.settings.retryDelayMs, 2000);
  assert.equal(result.settings.maxRetryDelayMs, 7000);
  assert.equal(result.settings.maxRetries, 1);
  assert.equal(result.settings.timeoutMs, 2500);
  assert.equal(result.settings.maxRpcRequests, 512);
  assert.equal(result.settings.builderMaxBlockLookups, 512);
  assert.equal(result.summary.partial, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.timeoutRatio, 0.5);
  assert.equal(result.trials[1].requests, 20);
  assert.equal(result.trials[1].retries, 1);
  assert.equal(result.trials[0].facts[1].age, "unknown");
  assert.deepEqual(result.trials[0].facts[0].snapshots, [2]);
  assert.deepEqual(result.trials[0].facts[0].verification, { history: "rpc_anchor", stateBinding: "number_recheck" });
  assert.equal(Object.hasOwn(result.trials[0].facts[1], "verification"), false,
    "Requested settings do not fabricate missing performed metadata");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret\.invalid|Bearer|authorization/);
  assert.match(result.scope, /NOT algorithm or full analysis/);
  assert.match(result.cache, /disabled/);
  assert.match(result.limitations.join(" "), /not globally or across processes/);
  assert.match(result.limitations.join(" "), /known-work lower bound.*not a completion forecast/);
  assert.match(result.limitations.join(" "), /pending work, not total timestamp fallback requests/);
  assert.match(result.limitations.join(" "), /neither mode independently proves log completeness or chain consensus/);
});

test("data probe allowlists failed-only diagnostics and never reuses them across attempts", async () => {
  const safeHttp = { stage: "logs", kind: "http", method: "eth_getLogs", httpStatus: 429, attempt: 2, operation: "pool_history" };
  const remote = { ...safeHttp, url: "https://SECRET.invalid/?key=SECRET", headers: { authorization: "SECRET" },
    message: "SECRET", body: "SECRET", params: ["SECRET"] };
  const safeRpc = { stage: "reference", kind: "json_rpc", method: "eth_chainId", rpcCode: -32005, attempt: 11, operation: "reference" };
  const reports = [
    { outcome: "failed", reason: "data_missing", failure: remote },
    { outcome: "partial", failure: remote },
    { outcome: "success", failure: remote },
    { outcome: "failed", reason: "data_missing", failure: { ...safeRpc, message: "SECRET" } },
    { outcome: "failed", reason: "timeout" },
    { outcome: "failed", reason: "data_missing", failure: { stage: "provider", kind: "validation",
      method: "SECRET", operation: "SECRET", httpStatus: 600, rpcCode: Number.MAX_SAFE_INTEGER + 1, attempt: 0 } },
    { outcome: "failed", reason: "data_missing", failure: { stage: "SECRET", kind: "network" } },
    undefined,
  ];
  const config = readProbeConfig({ SCAM_REPEATS: String(reports.length) });
  let run = 0;
  const result = await runProbe(config, (options) => ({ async fetch(_calls, context) {
    const report = reports[run++];
    if (report) options.onMetrics({ durationMs: 10, requests: 2, retries: 0, receivedBytes: 0,
      logChunks: 0, failedChunks: 0, resultBytes: 0, ...report });
    if (!report || report.outcome === "failed") throw new Error("SECRET");
    return { planId: context.planId, results: {} };
  } }));
  assert.deepEqual(result.trials[0].failure, safeHttp);
  assert.ok(!Object.hasOwn(result.trials[1], "failure"));
  assert.ok(!Object.hasOwn(result.trials[2], "failure"));
  assert.deepEqual(result.trials[3].failure, safeRpc);
  assert.ok(!Object.hasOwn(result.trials[4], "failure"));
  assert.equal(result.trials[4].reason, "timeout");
  assert.deepEqual(result.trials[5].failure, { stage: "provider", kind: "validation" });
  assert.ok(!Object.hasOwn(result.trials[6], "failure"));
  assert.ok(!Object.hasOwn(result.trials[7], "failure"));
  assert.equal(result.trials[7].diagnostic, "terminal_metrics_missing");
  assert.equal(result.settings.timeoutMs, 2500);
  assert.equal(result.summary.timeouts, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SECRET/);
  // Reject raw diagnostic fields, not valid values such as all_event_headers
  // or explanatory prose about block headers.
  assert.doesNotMatch(serialized, /"(?:url|headers|authorization|message|body|params)"\s*:/);
});

test("data probe reports only bounded numeric preflight data and keeps it scoped to one reference group", async () => {
  const preflight = { uniqueLogBlocks: 600, timestampedLogBlocks: 600, additionalHeaderRequests: 0,
    finalRecheckRequests: 604, minimumRemainingRequests: 604, remainingRequestBudget: 499,
    minimumPacingMs: 60300, remainingTimeMs: 58000 };
  const failure = { stage: "preflight", kind: "resource_limit", operation: "pool_history" };
  const reports = [
    { preflight: { ...preflight, remote: "SECRET", endpoint: "https://SECRET.invalid/" }, preflightGroup: 1 },
    { preflight: { ...preflight, uniqueLogBlocks: -1 }, preflightGroup: 1 },
    { preflight: { ...preflight, minimumPacingMs: Infinity }, preflightGroup: 1 },
    { preflight, preflightGroup: "SECRET" },
    {},
  ];
  let run = 0;
  const result = await runProbe(readProbeConfig({ SCAM_REPEATS: String(reports.length) }), (options) => ({
    async fetch() {
      options.onMetrics({ outcome: "failed", reason: "resource_limit", failure,
        durationMs: 1000, requests: 13, retries: 0, receivedBytes: 1000, logChunks: 9,
        failedChunks: 0, resultBytes: 0, ...reports[run++] });
      throw new Error("SECRET");
    },
  }));
  assert.deepEqual(result.trials[0].preflight, preflight);
  assert.deepEqual(result.trials[0].failure, failure);
  assert.equal(result.trials[0].preflightGroup, 1);
  for (const i of [1, 2, 4]) {
    assert.equal(result.trials[i].preflight, undefined);
    assert.equal(result.trials[i].preflightGroup, undefined);
  }
  assert.deepEqual(result.trials[3].preflight, preflight);
  assert.equal(result.trials[3].preflightGroup, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|endpoint/);
});
