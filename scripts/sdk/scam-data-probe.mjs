import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Explicit, manual, read-only data-path probe. No signing, transaction sending,
// algorithm loading, Core verdict or cache. Importing this module never runs it.
const DEFAULT = {
  factory: "0xd51d7c2a3b9b0f6876336c165adda94468500c47",
  pool: "0xcaafb95fc292c10a526f03fa480407bb438dac67",
  token: "0x0274c57358c3a6b8a08b7297ba51665c303a471f",
  quoteToken: "0x4200000000000000000000000000000000000006",
};
const EVENT_KINDS = ["owner_changed", "proxy_upgraded", "admin_changed", "paused", "unpaused"];
const address = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
class ProbeConfigError extends Error { constructor() { super("Invalid probe configuration; endpoint and values omitted."); } }
const requireConfig = (condition) => { if (!condition) throw new ProbeConfigError(); };
function integer(env, name, fallback, min, max) {
  if (env[name] === undefined) return fallback;
  requireConfig(/^(?:0|[1-9][0-9]*)$/.test(env[name]));
  const value = Number(env[name]);
  requireConfig(Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
function json(env, name, fallback) {
  try { return env[name] === undefined ? fallback : JSON.parse(env[name]); }
  catch { throw new ProbeConfigError(); }
}

export function readProbeConfig(env = process.env) {
  const chainId = integer(env, "SCAM_CHAIN_ID", 91342, 1, Number.MAX_SAFE_INTEGER);
  const targets = json(env, "SCAM_TARGETS_JSON", [{
    factory: env.SCAM_FACTORY ?? DEFAULT.factory, pool: env.SCAM_POOL ?? DEFAULT.pool,
    token: env.SCAM_TOKEN ?? DEFAULT.token, quoteToken: env.SCAM_QUOTE_TOKEN ?? DEFAULT.quoteToken,
  }]);
  requireConfig(Array.isArray(targets) && targets.length >= 1 && targets.length <= 4);
  const subjects = targets.map((target) => {
    requireConfig(record(target) && Object.keys(target).every((key) => Object.hasOwn(DEFAULT, key))
      && Object.keys(DEFAULT).every((key) => address(target[key]))
      && target.token.toLowerCase() !== target.quoteToken.toLowerCase());
    return { chainId, venue: "uniswap_v2", ...Object.fromEntries(Object.keys(DEFAULT).map((key) => [key, target[key].toLowerCase()])),
      actionPaths: [] };
  });
  requireConfig(new Set(subjects.map((subject) => `${subject.pool}:${subject.token}`)).size === subjects.length);
  const factorySupport = json(env, "SCAM_FACTORY_SUPPORT_JSON", []);
  const adminSupport = json(env, "SCAM_ADMIN_SUPPORT_JSON", []);
  const headers = json(env, "SCAM_RPC_HEADERS_JSON", undefined);
  requireConfig(Array.isArray(factorySupport) && Array.isArray(adminSupport)
    && (headers === undefined || record(headers) && Object.values(headers).every((value) => typeof value === "string")));
  const minRequestIntervalMs = integer(env, "SCAM_RPC_MIN_INTERVAL_MS", 100, 0, 60_000);
  const retryDelayMs = integer(env, "SCAM_RPC_RETRY_BASE_MS", 1000, 0, 60_000);
  const maxRetryDelayMs = integer(env, "SCAM_RPC_RETRY_MAX_MS", 8000, 0, 60_000);
  requireConfig(maxRetryDelayMs >= retryDelayMs);
  return {
    chainId, subjects, endpoint: { rpcUrl: env.SCAM_RPC_URL ?? "https://sepolia-rpc.giwa.io/", ...(headers && { headers }) },
    repeats: integer(env, "SCAM_REPEATS", 1, 1, 20),
    timeoutMs: integer(env, "SCAM_TIMEOUT_MS", 2500, 1, 60_000),
    lookbackSec: integer(env, "SCAM_LOOKBACK_SEC", 86_400, 1, 86_400),
    warmupSec: integer(env, "SCAM_WARMUP_SEC", 3600, 0, 3600),
    confirmDepth: integer(env, "SCAM_CONFIRM_DEPTH", 2, 0, 1000),
    ageThresholdSec: integer(env, "SCAM_AGE_THRESHOLD_SEC", 86_400, 1, 31_536_000),
    minRequestIntervalMs, retryDelayMs, maxRetryDelayMs,
    factorySupport, adminSupport,
  };
}

export function probeCalls(config, iteration) {
  return config.subjects.flatMap((subject, index) => {
    const shared = { subject, referenceGroupId: `probe:${iteration}:target:${index}`,
      confirmDepth: config.confirmDepth, builderVersion: "dambi-v2/1" };
    const call = (method, params) => ({ manifestId: "manual-scam-data-probe", callId: `${shared.referenceGroupId}:${method}`,
      method, params: { ...shared, ...params }, outputs: [], optional: true });
    return [
      call("scam.pool_history", { dataSchema: "scam.pool_history/1", lookbackSec: config.lookbackSec,
        warmupSec: config.warmupSec, metrics: ["price_quote_per_token", "quote_reserve"],
        candidateResolutions: [{ bucketMs: 10_000, gridOriginMs: 0 }, { bucketMs: 60_000, gridOriginMs: 0 }] }),
      call("scam.token_profile", { dataSchema: "scam.token_profile/1", ageThresholdSec: config.ageThresholdSec,
        ageSearchMaxLookbackSec: config.lookbackSec, maxAgeSearchCalls: 40,
        eventLookbackSec: config.lookbackSec, eventKinds: [...EVENT_KINDS] }),
    ];
  });
}

/** Nearest-rank percentiles; incomplete responses never count as clean success. */
export function summarizeTrials(trials) {
  const success = trials.filter((trial) => trial.outcome === "success").map((trial) => trial.durationMs).sort((a, b) => a - b);
  const completed = trials.filter((trial) => trial.outcome === "success" || trial.outcome === "partial")
    .map((trial) => trial.durationMs).sort((a, b) => a - b);
  const count = (predicate) => trials.filter(predicate).length;
  const ratio = (value) => trials.length ? value / trials.length : null;
  const latency = (samples) => ({ samples: samples.length,
    p50: samples.length ? samples[Math.ceil(samples.length * 0.5) - 1] : null,
    p95: samples.length ? samples[Math.ceil(samples.length * 0.95) - 1] : null });
  const failed = count((trial) => trial.outcome === "failed");
  const partial = count((trial) => trial.outcome === "partial");
  const timeouts = count((trial) => trial.reason === "timeout");
  return { attempts: trials.length, success: success.length, partial, failed, timeouts,
    partialRatio: ratio(partial), failureRatio: ratio(failed), timeoutRatio: ratio(timeouts),
    successOnlyLatencyMs: latency(success), completedLatencyMs: latency(completed),
    latencyCaution: "Completed latency includes partial coverage, not a successful analysis. Both latency series exclude failures; inspect all-attempt ratios. Small samples are not stable production percentiles." };
}

function factSummary(batch) {
  return Object.values(batch.results).flatMap((fact) => {
    const value = fact.value;
    if (!record(value) || !["scam.pool_history", "scam.token_profile"].includes(value.method)) return [];
    return [{ method: value.method, referenceBlock: value.reference.block.number,
      coverage: { missingIntervals: value.coverage.missing.length, unavailableFields: value.coverage.unavailable.length },
      ...(value.method === "scam.pool_history" ? { snapshots: value.histories.map(({ history }) => history.points.length) }
        : { age: value.age.kind, adminEvents: value.events.length }) }];
  });
}

function failureSummary(value) {
  // Diagnostics are an allowlisted projection, never a remote error payload.
  try {
    if (!record(value)) return undefined;
    const { stage, kind, method, httpStatus, rpcCode, attempt, operation } = value;
    if (!["request", "reference", "pool_identity", "block_header", "reserves", "decimals", "code", "logs", "preflight", "final_recheck", "collect", "provider"].includes(stage)
        || !["http", "json_rpc", "network", "validation", "lifecycle", "resource_limit", "internal"].includes(kind)) return undefined;
    const result = { stage, kind };
    if (["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getLogs"].includes(method)) result.method = method;
    if (Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
    if (Number.isSafeInteger(rpcCode)) result.rpcCode = rpcCode;
    if (Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 11) result.attempt = attempt;
    if (["request", "reference", "pool_identity", "pool_history", "token_profile", "result", "final_recheck"].includes(operation)) result.operation = operation;
    return result;
  } catch { return undefined; } // A malformed diagnostic cannot replace the outcome.
}

function preflightSummary(value) {
  try {
    if (!record(value)) return undefined;
    const counts = ["uniqueLogBlocks", "timestampedLogBlocks", "additionalHeaderRequests", "finalRecheckRequests",
      "minimumRemainingRequests", "remainingRequestBudget"];
    const times = ["minimumPacingMs", "remainingTimeMs"];
    if (!counts.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
        || !times.every((key) => typeof value[key] === "number" && Number.isFinite(value[key])
          && value[key] >= 0 && value[key] <= Number.MAX_SAFE_INTEGER)) return undefined;
    return Object.fromEntries([...counts, ...times].map((key) => [key, value[key]]));
  } catch { return undefined; }
}

export async function runProbe(config, createProvider) {
  const trials = [];
  let observed;
  const provider = createProvider({
    policy: { async fetch(calls, options) {
      if (calls.length) throw new Error("This probe does not fetch policy facts.");
      return { planId: options.planId, results: {} };
    } },
    rpc: { chainId: config.chainId, endpoint: config.endpoint,
      factories: [...new Set(config.subjects.map((subject) => subject.factory))],
      quoteTokens: [...new Set(config.subjects.map((subject) => subject.quoteToken))],
      limits: { maxRequests: 512, maxResponseBytes: 8_000_000, maxTotalResponseBytes: 32_000_000,
        maxLogs: 100_000, maxBlocksPerQuery: 10_000, concurrency: 2, maxRetries: 1,
        minRequestIntervalMs: config.minRequestIntervalMs, retryDelayMs: config.retryDelayMs, maxRetryDelayMs: config.maxRetryDelayMs } },
    history: { maxPoints: 20_000, maxLogs: 100_000, maxBlockLookups: 512, blockTimeHintMs: 1000 },
    profile: { maxEvents: 20_000, maxLogs: 100_000, maxBlockLookups: 512, blockTimeHintMs: 1000 },
    factorySupport: config.factorySupport, adminSupport: config.adminSupport,
    limits: { timeoutMs: config.timeoutMs, maxCalls: config.subjects.length * 2, maxTargets: config.subjects.length,
      maxRequestBytes: 100_000, maxResultBytes: 16_000_000 },
    onMetrics(metrics) { observed = metrics; },
  });
  for (let i = 0; i < config.repeats; i++) {
    observed = undefined;
    let batch, threw = false;
    const started = performance.now();
    try { batch = await provider.fetch(probeCalls(config, i), { planId: `manual-probe:${i}` }); }
    catch { threw = true; } // Do not print RPC/provider messages or credential-bearing URLs.
    const durationMs = Math.max(0, performance.now() - started);
    const metrics = observed;
    const failure = metrics?.outcome === "failed" ? failureSummary(metrics.failure) : undefined;
    const preflight = preflightSummary(metrics?.preflight);
    const preflightGroup = metrics?.preflightGroup;
    trials.push({ attempt: i + 1, outcome: metrics?.outcome ?? "failed",
      ...(metrics?.reason === undefined ? {} : { reason: metrics.reason }),
      ...(failure === undefined ? {} : { failure }),
      ...(preflight === undefined ? {} : { preflight,
        ...(Number.isSafeInteger(preflightGroup) && preflightGroup >= 1 && preflightGroup <= config.subjects.length
          ? { preflightGroup } : {}) }),
      durationMs, providerDurationMs: metrics?.durationMs ?? null,
      requests: metrics?.requests ?? null, retries: metrics?.retries ?? null,
      receivedBytes: metrics?.receivedBytes ?? null, logChunks: metrics?.logChunks ?? null,
      failedChunks: metrics?.failedChunks ?? null, resultBytes: metrics?.resultBytes ?? null,
      targets: config.subjects.length, calls: config.subjects.length * 2,
      ...(metrics ? {} : { diagnostic: "terminal_metrics_missing" }),
      threw, facts: batch ? factSummary(batch) : [],
    });
  }
  return { scope: "Read-only Scam Filter provider data path; NOT algorithm or full analysis performance.",
    cache: "disabled; every attempt starts a fresh batch",
    settings: { chainId: config.chainId, targets: config.subjects.length, repeats: config.repeats,
      timeoutMs: config.timeoutMs, lookbackSec: config.lookbackSec, warmupSec: config.warmupSec,
      candidateBucketMs: [10_000, 60_000], builderMaxPoints: 20_000, maxRpcRequests: 512,
      builderMaxBlockLookups: 512, confirmDepth: config.confirmDepth,
      ageThresholdSec: config.ageThresholdSec,
      minRequestIntervalMs: config.minRequestIntervalMs, retryDelayMs: config.retryDelayMs,
      maxRetryDelayMs: config.maxRetryDelayMs, maxRetries: 1,
      factoryCapabilityEntries: config.factorySupport.length, adminCapabilityEntries: config.adminSupport.length },
    limitations: ["Node RPC reachability does not establish browser-extension RPC reachability.",
      "No factory/admin capability is assumed by default; unknown age and unsupported events are not cleared.",
      "The age threshold is a probe input, not a calibrated policy default.",
      "Builder resource limits are probe configuration, not an algorithm's declared capacity; resource_limit is not RPC latency.",
      "Provider timeout covers all targets; raw RPC request/byte limits are per reference group.",
      "Preflight is the last reference group's known-work lower bound at that checkpoint, not a completion forecast; it excludes retries, network latency and later profile/target work.",
      "Pacing and cooldown are shared only within this provider, not globally or across processes; waiting can exhaust the unchanged timeout."],
    trials, summary: summarizeTrials(trials) };
}

async function main() {
  try {
    const config = readProbeConfig();
    const { createScamFactProvider } = await import("@dambi/core/adapters");
    const result = await runProbe(config, createScamFactProvider);
    console.log(JSON.stringify(result, null, 2));
    if (result.summary.failed) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "probe_setup_failed",
      hint: "Check environment settings and build the current Core adapter. Endpoint, headers and remote errors are omitted." }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
