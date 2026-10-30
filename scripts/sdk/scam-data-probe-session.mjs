// Explicit, manual, read-only data-path probe. No signing, transaction sending,
// algorithm loading or Core verdict. Importing this module never runs it.
const DEFAULT = {
  factory: "0xd51d7c2a3b9b0f6876336c165adda94468500c47",
  pool: "0xcaafb95fc292c10a526f03fa480407bb438dac67",
  token: "0x0274c57358c3a6b8a08b7297ba51665c303a471f",
  quoteToken: "0x4200000000000000000000000000000000000006",
};
const EVENT_KINDS = ["owner_changed", "proxy_upgraded", "admin_changed", "paused", "unpaused"];
const HISTORY_VERIFICATIONS = ["all_event_headers", "rpc_anchor"];
const TARGET_BUDGET_MS = 2500;
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

export function readProbeConfig(env = {}) {
  const chainId = integer(env, "SCAM_CHAIN_ID", 91342, 1, Number.MAX_SAFE_INTEGER);
  const historyVerification = env.SCAM_HISTORY_VERIFICATION ?? "all_event_headers";
  requireConfig(HISTORY_VERIFICATIONS.includes(historyVerification));
  const cacheEnabled = integer(env, "SCAM_HISTORY_CACHE", 0, 0, 1) === 1;
  const cacheMaxBlockSpan = integer(env, "SCAM_CACHE_MAX_BLOCK_SPAN", 100_000, 1, 1_000_000);
  const prepareTimeoutMs = integer(env, "SCAM_PREPARE_TIMEOUT_MS", undefined, 1, 60_000);
  requireConfig(prepareTimeoutMs === undefined || cacheEnabled);
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
    warmupSec: integer(env, "SCAM_WARMUP_SEC", 3600, 0, 86_400),
    confirmDepth: integer(env, "SCAM_CONFIRM_DEPTH", 2, 0, 1000),
    ageThresholdSec: integer(env, "SCAM_AGE_THRESHOLD_SEC", 86_400, 1, 31_536_000),
    minRequestIntervalMs, retryDelayMs, maxRetryDelayMs,
    verification: Object.freeze({ history: historyVerification, stateBinding: "number_recheck" }),
    historyCache: cacheEnabled ? Object.freeze({ maxEntries: 8, maxBytes: 16_000_000,
      ttlMs: 120_000, maxBlockSpan: cacheMaxBlockSpan }) : undefined,
    prepareTimeoutMs,
    factorySupport, adminSupport,
  };
}

export function probeCalls(config, iteration) {
  return config.subjects.flatMap((subject, index) => {
    const shared = { subject, referenceGroupId: `probe:${iteration}:target:${index}`,
      confirmDepth: config.confirmDepth, builderVersion: "dambi-v2/2" };
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
  const within = (trial) => trial.durationMs <= TARGET_BUDGET_MS;
  return { attempts: trials.length, success: success.length, partial, failed, timeouts,
    partialRatio: ratio(partial), failureRatio: ratio(failed), timeoutRatio: ratio(timeouts),
    successOnlyLatencyMs: latency(success), completedLatencyMs: latency(completed),
    targetBudget: { limitMs: TARGET_BUDGET_MS,
      successWithinBudget: count((trial) => trial.outcome === "success" && within(trial)),
      partialWithinBudget: count((trial) => trial.outcome === "partial" && within(trial)),
      completedOverBudget: count((trial) => ["success", "partial"].includes(trial.outcome) && !within(trial)),
      failedAttempts: failed,
      allAttemptsCompleteWithinBudget: trials.length > 0 && trials.every((trial) => trial.outcome === "success" && within(trial)) },
    latencyCaution: "Completed latency includes partial coverage, not a successful analysis. Both latency series exclude failures; inspect all-attempt ratios. Small samples are not stable production percentiles." };
}

function verificationSummary(value) {
  // Report the performed method metadata, never infer it from requested settings.
  // The provider validates the full contract; this is only a safe output projection.
  try {
    if (!record(value) || !HISTORY_VERIFICATIONS.includes(value.history)
        || !["number_recheck", "block_hash_canonical"].includes(value.stateBinding)) return undefined;
    const result = { history: value.history, stateBinding: value.stateBinding };
    if (["none", "interval_cache"].includes(value.reuse)) result.reuse = value.reuse;
    const raw = value.rawObservedAt;
    if (record(raw) && [raw.fromMs, raw.toMs].every((n) => Number.isSafeInteger(n) && n >= 0)
        && raw.fromMs <= raw.toMs) result.rawObservedAt = { fromMs: raw.fromMs, toMs: raw.toMs };
    if (Number.isSafeInteger(value.verifiedAt) && value.verifiedAt >= 0) result.verifiedAt = value.verifiedAt;
    return result;
  } catch { return undefined; }
}

const blockNumber = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(value);
function referenceSummary(value) {
  if (!record(value) || !blockNumber(value.number)
      || typeof value.hash !== "string" || !/^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value.hash)
      || !Number.isSafeInteger(value.timestampMs) || value.timestampMs < 0) return undefined;
  return { number: value.number, hash: value.hash.toLowerCase(), timestampMs: value.timestampMs };
}

function sameSubject(actual, expected) {
  return record(actual) && actual.chainId === expected.chainId && actual.venue === expected.venue
    && Object.keys(DEFAULT).every((key) => address(actual[key]) && actual[key].toLowerCase() === expected[key]);
}

function referenceRelation(current, previous) {
  if (!current || !previous) return "unknown";
  if (current.number === previous.number) {
    return current.hash === previous.hash && current.timestampMs === previous.timestampMs ? "same" : "changed";
  }
  return BigInt(current.number) > BigInt(previous.number) && current.timestampMs >= previous.timestampMs
    && current.hash !== previous.hash ? "advanced" : "changed";
}

export function factSummary(batch, request, previousFacts) {
  if (!record(batch.results)) return [];
  return Object.entries(batch.results).flatMap(([callId, fact]) => {
    const value = fact?.value;
    if (!record(value) || !["scam.pool_history", "scam.token_profile"].includes(value.method)) return [];
    const planned = request.calls.get(callId);
    const targetIndex = batch.planId === request.planId && planned?.method === value.method
      && planned.referenceGroupId === value.referenceGroupId && sameSubject(value.subject, planned.subject)
      ? planned.targetIndex : undefined;
    const reference = referenceSummary(value.reference?.block);
    const previous = targetIndex === undefined ? undefined
      : previousFacts?.find((item) => item.targetIndex === targetIndex && item.method === value.method);
    const verification = verificationSummary(value.verification);
    return [{ method: value.method,
      ...(blockNumber(value.reference?.block?.number) ? { referenceBlock: value.reference.block.number } : {}),
      ...(targetIndex === undefined ? {} : { targetIndex }),
      ...(reference === undefined ? {} : { reference }),
      referenceRelation: referenceRelation(reference, previous?.reference),
      ...(verification === undefined ? {} : { verification }),
      coverage: { missingIntervals: value.coverage.missing.length, unavailableFields: value.coverage.unavailable.length },
      ...(value.method === "scam.pool_history" ? { snapshots: value.histories.map(({ history }) => history.points.length) }
        : { age: value.age.kind, adminEvents: value.events.length }) }];
  });
}

export function failureSummary(value) {
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

export function preflightSummary(value) {
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

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Shared manual-probe budgets and RPC telemetry; not product defaults. */
export function probeProviderOptions(config, onMetrics) {
  return {
    policy: { async fetch(calls, options) {
      if (calls.length) throw new Error("This probe does not fetch policy facts.");
      return { planId: options.planId, results: {} };
    } },
    rpc: { chainId: config.chainId, endpoint: config.endpoint, verification: config.verification,
      ...(config.historyCache === undefined ? {} : { historyCache: config.historyCache }),
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
    onMetrics,
  };
}

/** One explicitly owned provider for Node or an extension Service Worker.
 * Report values are copies, so console edits cannot alter later comparisons.
 * Installing a session does not prepare or fetch any remote data.
 */
export function createProbeSession(input, createProvider) {
  let config;
  try { config = copy(input); }
  catch { throw new ProbeConfigError(); }
  const trials = [];
  let busy = false, preparationAttempted = false;
  async function exclusive(work) {
    if (busy) throw new Error("The probe session is busy; an operation is already in progress.");
    busy = true;
    try { return await work(); }
    finally { busy = false; }
  }
  let observed;
  const provider = createProvider(probeProviderOptions(config, (metrics) => { observed = metrics; }));
  async function measure(work, request, previousTrial) {
    observed = undefined;
    let batch, threw = false;
    const started = performance.now();
    try { batch = await work(); }
    catch { threw = true; } // Do not print RPC/provider messages or credential-bearing URLs.
    const durationMs = Math.max(0, performance.now() - started);
    const metrics = observed;
    const failure = metrics?.outcome === "failed" ? failureSummary(metrics.failure) : undefined;
    const preflight = preflightSummary(metrics?.preflight);
    const preflightGroup = metrics?.preflightGroup;
    const outcome = threw ? "failed" : metrics?.outcome ?? "failed";
    // Only the immediately preceding completed fetch is a comparison baseline.
    // Preparation returns no reference, and a failed/missing trial is not skipped.
    const previousFacts = ["success", "partial"].includes(outcome)
      && ["success", "partial"].includes(previousTrial?.outcome) ? previousTrial.facts : undefined;
    return { outcome,
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
      threw, ...(request ? { facts: batch ? factSummary(batch, request, previousFacts) : [] } : {}),
    };
  }
  let preparation;
  const prepare = () => exclusive(async () => {
    if (preparationAttempted || trials.length || config.prepareTimeoutMs === undefined) {
      throw new Error("Preparation is unavailable or has already been attempted in this session.");
    }
    preparationAttempted = true;
    preparation = { timeoutMs: config.prepareTimeoutMs,
      ...(typeof provider.prepare !== "function"
        ? { outcome: "failed", diagnostic: "preparation_unavailable", durationMs: 0, threw: false }
        : await measure(() => provider.prepare(probeCalls(copy(config), "prepare"), {
          planId: "manual-probe:prepare", timeoutMs: config.prepareTimeoutMs,
        }), false)) };
    return copy(preparation);
  });
  const fetch = () => exclusive(async () => {
    // A failed preparation never becomes an implicitly cold signing trial.
    // An explicitly unprepared session may fetch to measure the cold path.
    if (preparation?.outcome === "failed") throw new Error("Preparation failed; start a new probe session.");
    if (trials.length >= config.repeats) throw new Error("The configured probe attempt limit has been reached.");
    const i = trials.length, calls = probeCalls(copy(config), i), planId = `manual-probe:${i}`;
    const request = { planId, calls: new Map(calls.map((call, index) => [call.callId, {
      method: call.method, referenceGroupId: call.params.referenceGroupId,
      subject: { ...call.params.subject }, targetIndex: Math.floor(index / 2),
    }])) };
    const trial = { attempt: i + 1, ...await measure(() => provider.fetch(calls, { planId }), request, trials.at(-1)) };
    trials.push(trial);
    return copy(trial);
  });
  const report = () => copy({ scope: "Read-only Scam Filter provider data path; NOT algorithm or full analysis performance.",
    cache: config.historyCache === undefined ? "disabled; every attempt starts a fresh batch"
      : "enabled; the same provider retains bounded raw log intervals; every fetch obtains a new reference and result",
    settings: { chainId: config.chainId, targets: config.subjects.length, repeats: config.repeats,
      verification: { ...config.verification },
      historyCache: config.historyCache === undefined ? null : { ...config.historyCache },
      ...(config.prepareTimeoutMs === undefined ? {} : { prepareTimeoutMs: config.prepareTimeoutMs }),
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
      "Preflight is the last reference group's known-work lower bound at that checkpoint, not a completion forecast. The history checkpoint excludes later profile/target work; the final checkpoint includes all collected evidence. Both exclude retries and network latency.",
      "Preflight finalRecheckRequests is the selected final-header count at that checkpoint. additionalHeaderRequests is pending work, not total timestamp fallback requests; it becomes zero at the final checkpoint even if earlier headers were needed.",
      "rpc_anchor skips final headers only for log-only blocks. Missing log timestamps still require headers, so request cost is not guaranteed constant. Actual method verification is shown only when returned, separately from requested settings.",
      "Both modes rely on the configured RPC. rpc_anchor does not cross-check every event block, and neither mode independently proves log completeness or chain consensus. number_recheck does not bind state reads by block hash.",
      "Pacing and cooldown are shared only within this provider, not globally or across processes; waiting can exhaust the unchanged timeout.",
      "Preparation has its own budget and is excluded from fetch latency and its 2,500 ms target. Failed preparation skips fetch trials; partial preparation may seed complete raw intervals but does not establish full coverage.",
      "Reference relations compare adjacent completed fetches for the same requested chain, target and method within this run. The first fetch has no baseline, including after preparation. Failed or missing predecessors are not skipped. targetIndex is zero-based and requires a matching requested identity.",
      "same requires equal block number, hash and timestamp; advanced requires a higher block number, a different hash and a nondecreasing timestamp. changed reports other reference differences, not a confirmed reorg. Reference relation and actual verification reuse are independent; neither reveals exact reused/new block ranges or source execution time.",
      "Cache-enabled does not imply a cache hit. Inspect returned verification reuse and original rawObservedAt; new references may need incremental RPC work. A partial result within 2,500 ms is not a complete risk analysis."],
    ...(preparation === undefined ? {} : { preparation,
      ...(preparation.outcome === "failed" ? { fetchSkipped: "preparation_failed" } : {}) }),
    trials, summary: summarizeTrials(trials) });
  return Object.freeze({ prepare, fetch, report });
}

export async function runProbe(config, createProvider) {
  const session = createProbeSession(config, createProvider);
  const settings = session.report().settings;
  const preparation = settings.prepareTimeoutMs === undefined ? undefined : await session.prepare();
  if (preparation?.outcome !== "failed") {
    for (let i = 0; i < settings.repeats; i++) await session.fetch();
  }
  return session.report();
}

