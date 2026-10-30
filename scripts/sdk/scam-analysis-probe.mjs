// Manual SF6-2 diagnostic: recorded/local request + live RPC + production Core.
// Bundles use repository TEST-ONLY keys in memory. No wallet signing, broadcast,
// service deployment, key generation, storage writes or implicit execution.
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readProbeConfig, probeProviderOptions, factSummary, failureSummary,
  preflightSummary, summarizeTrials } from "./scam-data-probe-session.mjs";

const IDENTITY = Object.freeze({ id: "dambi.scam.window-rules", version: "0.2.0", contractVersion: 2 });
const PRESET = "sf6-readonly-demo";
const reasons = new Set(["algorithm_unavailable", "algorithm_incompatible", "invalid_algorithm_output",
  "scam_results_missing", "invalid_scam_input", "subject_unresolved", "subject_mismatch", "reference_mismatch",
  "reorg", "bundle_unavailable", "bundle_invalid", "data_missing", "field_unavailable", "initial_state_unknown",
  "history_unverified", "age_unknown", "market_too_young", "stale_data", "unsupported_resolution",
  "resource_limit", "no_time_budget", "timeout"]);
const safeReasons = (values = []) => [...new Set(values.map((value) => reasons.has(value) ? value : "other"))];
const subjectKey = (s) => [s.chainId, s.venue, s.factory, s.pool, s.token, s.quoteToken].join(":").toLowerCase();
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const valid = (condition) => { if (!condition) throw new Error("Invalid local analysis probe configuration; values omitted."); };

export function readAnalysisProbeConfig(env = {}) {
  // Cumulative/R2 can request 48 hours: ~172800 blocks at a one-second cadence.
  // The old data-only probe's 100000-block cache cannot retain that scan.
  const config = readProbeConfig({ ...env, SCAM_CACHE_MAX_BLOCK_SPAN: env.SCAM_CACHE_MAX_BLOCK_SPAN ?? "200000" });
  let rules;
  try {
    rules = env.SCAM_RULES_JSON === undefined ? [
      { id: "r1", enabled: true, kind: "change_count", metric: "price_quote_per_token",
        lookbackSec: config.lookbackSec, direction: "either", changeMode: "cumulative", thresholdBps: 500, count: 3 },
      { id: "r2", enabled: true, kind: "switch_density", metric: "price_quote_per_token",
        lookbackSec: config.lookbackSec, windowSec: Math.min(3600, config.lookbackSec),
        reversalBps: 500, switchKind: "direction_reversal", count: 3 },
    ] : JSON.parse(env.SCAM_RULES_JSON);
  } catch { valid(false); }
  valid(Array.isArray(rules) && rules.length > 0 && rules.length <= 16
    && rules.every((rule) => rule?.enabled === true) && config.timeoutMs > 200);
  return { ...config, rules, caseFile: env.SCAM_CASE_FILE };
}

/** Fresh test-signed local configuration. The recorded transaction is decoded
 * without execution; current reference blocks and reserves come only from RPC. */
async function localFixture(config, now) {
  const root = new URL("../../", import.meta.url);
  const [keys, envelope] = await Promise.all([
    json(new URL("crates/dambi-core/tests/fixtures/policy-bundle/test-only-keys.json", root)),
    json(new URL("crates/dambi-core/tests/fixtures/policy-bundle/day1.envelope.json", root)),
  ]);
  valid(keys.test_only === true);
  let request, decoders;
  if (config.caseFile) {
    ({ request, decoders } = await json(resolve(config.caseFile)));
    valid(request && decoders?.schema_version === 1 && Array.isArray(decoders.bundles));
  } else {
    const [evidence, decoder] = await Promise.all([
      json(new URL("fixtures/sdk/giwa-sf0/rpc-evidence.json", root)),
      json(new URL("fixtures/sdk/giwa-sf0/decoders/swap-exact-eth-for-tokens.json", root)),
    ]);
    const tx = evidence.queries.find(({ request }) => request.method === "eth_getTransactionByHash"
      && request.params[0] === "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9").response.result;
    request = { kind: "transaction", chainId: "eip155:91342", from: tx.from,
      to: tx.to, data: tx.input, value: BigInt(tx.value).toString() };
    decoders = { schema_version: 1, bundles: [decoder] };
  }
  const artifact = JSON.stringify(decoders);
  valid(Buffer.byteLength(artifact) <= 1_000_000);
  const signed = (payload, key) => {
    const raw = JSON.stringify(payload);
    return { payload: raw, signature: sign("sha256", Buffer.from(raw), {
      key: key.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
    }).toString("base64") };
  };
  const policy = signed({ ...JSON.parse(envelope.payload), issued_at: Math.floor(now / 1000) - 1,
    expires_at: Math.floor(now / 1000) + 7200 }, keys.policy);
  const candidate = { rules: config.rules, bucketMs: 1000, gridOriginMs: 0,
    warmupSec: config.warmupSec, maxDataAgeSec: 30 };
  const scam = signed({ kind: "scam_bundle", schema: "0.1", sequence: "1",
    issuedAtMs: now - 1000, expiresAtMs: now + 7_200_000, env: "staging", profile: "default",
    compatibility: { engineRange: "*", builderRange: "dambi-v2/2", contractVersion: "0.1", algorithm: IDENTITY },
    support: [{ chainId: config.chainId, venue: "uniswap_v2",
      factories: [...new Set(config.subjects.map((s) => s.factory))],
      quoteTokens: [...new Set(config.subjects.map((s) => s.quoteToken))],
      exemptTokens: [...new Set(config.subjects.map((s) => s.quoteToken))], allowedBucketMs: [1000], confirmDepth: config.confirmDepth }],
    presets: [{ id: PRESET, purpose: "demo",
      selection: { ageThresholdSec: config.ageThresholdSec, unknownAge: "new_provisional_insufficient" },
      newMarket: { ...candidate, id: "new" }, established: { ...candidate, id: "established" } }],
    templates: {}, model: null }, keys.decoder);
  const trust = (key, role) => ({ env: "staging", profile: "default", keys: [{ keyId: `sf6-test-only-${role}`,
    role, publicKeySpkiBase64: key.public_key_spki_b64 }] });
  return { request, policy, scam, trust: trust(keys.policy, "policy"), scamTrust: trust(keys.decoder, "scam"),
    decoderSnapshot: { artifact, expectedDigest: `0x${createHash("sha256").update(artifact).digest("hex")}` } };
}

/** Warnings with incomplete inputs are partial, never successful latency samples. */
export function classifyAnalysis(verdict, subjects) {
  const report = verdict?.scam;
  const targets = report?.targets ?? [];
  const allReasons = safeReasons([...(report?.reasons ?? []), ...targets.flatMap((t) => [
    ...t.reasons, ...t.rules.flatMap((r) => r.reasons),
  ])]);
  const reason = allReasons.includes("timeout") ? "timeout"
    : allReasons.includes("no_time_budget") ? "no_time_budget" : allReasons[0];
  if (verdict?.source !== "evaluated") return { outcome: "failed", reason: "policy_failed" };
  if (!["warn", "quiet", "insufficient"].includes(report?.status)) return { outcome: "failed", reason: "not_evaluated" };
  if (targets.some((t) => t.analysisMode === "stub")) return { outcome: "failed", reason: "algorithm_not_real" };
  const expected = new Set(subjects.map(subjectKey));
  const actual = targets.map((t) => subjectKey(t.subject));
  const matches = targets.length === expected.size && new Set(actual).size === expected.size
    && actual.every((key) => expected.has(key));
  const real = (t) => t.analysisMode === "real" && Object.entries(IDENTITY)
    .every(([key, value]) => t.binding?.algorithm?.[key] === value);
  const complete = (t) => real(t) && ["warn", "quiet"].includes(t.status) && t.reasons.length === 0
    && t.rules.length > 0 && t.rules.every((r) => ["clear", "fired"].includes(r.state)
      && r.initialState !== "unsatisfied" && r.reasons.length === 0
      && r.coverage.missing.length === 0 && r.coverage.unavailable.length === 0
      && r.evidence?.coverageBps === 10000 && r.evidence?.warmupComplete === true);
  return { outcome: matches && ["warn", "quiet"].includes(report.status)
      && allReasons.length === 0 && targets.every(complete) ? "success" : "partial",
    ...(reason ? { reason } : {}), reasons: allReasons, scamStatus: report.status,
    decision: verdict.decision, targetCount: targets.length, realAnalysisTargets: targets.filter(real).length,
    targetCountMatches: matches,
    targets: targets.map((t) => ({ pool: t.subject.pool, status: t.status, analysisMode: t.analysisMode ?? null,
      reasons: safeReasons(t.reasons),
      ...(t.binding ? { algorithm: t.binding.algorithm, builderVersion: t.binding.builderVersion,
        fromMs: t.binding.fromMs, toMs: t.binding.toMs, warmupSec: t.binding.warmupSec,
        reference: t.binding.reference.block, selectionReason: t.binding.selectionReason } : {}),
      rules: t.rules.map((r) => ({ ruleId: r.ruleId, state: r.state, initialState: r.initialState,
        reasons: safeReasons(r.reasons), missingIntervals: r.coverage.missing.length,
        unavailableFields: r.coverage.unavailable.length,
        observed: r.evidence?.observed ?? null, threshold: r.evidence?.threshold ?? null,
        coverageBps: r.evidence?.coverageBps ?? null, warmupComplete: r.evidence?.warmupComplete ?? null })) })) };
}

function metricsSummary(metrics) {
  if (!metrics) return { diagnostic: "terminal_metrics_missing" };
  const result = { outcome: metrics.outcome, ...(reasons.has(metrics.reason) ? { reason: metrics.reason } : {}) };
  for (const key of ["durationMs", "requests", "retries", "receivedBytes", "logChunks", "failedChunks", "resultBytes"]) {
    if (Number.isFinite(metrics[key]) && metrics[key] >= 0) result[key] = metrics[key];
  }
  const failure = failureSummary(metrics.failure), preflight = preflightSummary(metrics.preflight);
  return { ...result, ...(failure && { failure }), ...(preflight && { preflight }) };
}

function plannedRequest(calls, planId, config) {
  valid(calls.length === config.subjects.length * 2);
  const seen = new Set();
  const entries = calls.map((call) => {
    const targetIndex = config.subjects.findIndex((s) => subjectKey(s) === subjectKey(call.params.subject));
    valid(targetIndex >= 0 && ["scam.pool_history", "scam.token_profile"].includes(call.method));
    const key = `${targetIndex}:${call.method}`;
    valid(!seen.has(key)); seen.add(key);
    return [call.callId, { method: call.method, subject: call.params.subject,
      referenceGroupId: call.params.referenceGroupId, targetIndex }];
  });
  return { planId, calls: new Map(entries) };
}

export async function runAnalysisProbe(input, { createCore, createProvider, now = Date.now }) {
  const config = structuredClone(input);
  const trials = [];
  const report = { scope: "SDK check: live RPC + real algorithm, local test-signed bundles; excludes bundle HTTP and extension UI",
    policySource: "local-test-only-fixture", requestedAlgorithm: IDENTITY,
    settings: { chainId: config.chainId, targets: config.subjects.length, repeats: config.repeats,
      timeoutMs: config.timeoutMs, requestedWarmupSec: config.warmupSec, rules: config.rules,
      verification: config.verification, historyCache: config.historyCache ?? null,
      factoryCapabilityEntries: config.factorySupport.length, adminCapabilityEntries: config.adminSupport.length },
    limitations: ["Diagnostic rule thresholds are uncalibrated. Quiet is not safety or sellability assurance.",
      "No factory/admin capability is inferred. Unknown age, incomplete warm-up and fired-with-gaps remain partial.",
      "Initialization and explicit preparation are reported separately from SDK check latency; host startup and UI are not measured.",
      "A 60000ms diagnostic run does not relax the 2500ms comparison target. No hidden history or rule reductions.",
      "The same provider is reused within the run. Cache-enabled is not cache-hit; inspect each fact's verification.",
      "Small-sample percentiles are descriptive only. This report alone cannot establish MVP performance acceptance."], trials };
  let core, metrics, facts = [], planned = [], guardFailed = false;
  const start = performance.now();
  try {
    const local = await localFixture(config, now());
    const provider = createProvider(probeProviderOptions(config, (value) => { metrics = value; }));
    core = await createCore({ decoderSnapshot: local.decoderSnapshot, enforcement: "advisory", trust: local.trust,
      clock: { now }, limits: { allowedClockSkewMs: 5000, maxPolicyBytes: 1_000_000,
        maxDecoderBytes: 1_000_000, maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
        planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
        factTimeoutMs: config.timeoutMs, policyTimeoutMs: config.timeoutMs },
      scam: { settings: { enabled: true, presetId: PRESET, overrides: [], additionalRules: [], locale: "ko" },
        trust: local.scamTrust, limits: { scamTimeoutMs: config.timeoutMs, scamEvalReserveMs: 200,
          maxBundleBytes: 1_000_000, maxResultBytes: 16_000_000, maxCalls: 16, maxTargets: config.subjects.length,
          maxRules: 16, maxLogs: 100_000, maxPoints: 20_000, maxAlgorithmWorkUnits: 100_000_000 } },
      ports: { policy: { fetch: async () => local.policy, fetchScam: async () => local.scam },
        fact: { async fetch(calls, context) {
          const scam = calls.some((call) => call.method.startsWith("scam."));
          let request;
          if (scam) {
            try { request = plannedRequest(calls, context.planId, config); }
            catch { guardFailed = true; throw new Error("Probe target mismatch"); }
            planned = calls.filter((c) => c.method === "scam.pool_history").map((c) => ({
              lookbackSec: c.params.lookbackSec, warmupSec: c.params.warmupSec,
              candidateResolutions: c.params.candidateResolutions }));
          }
          const batch = await provider.fetch(calls, context);
          if (scam) facts = factSummary(batch, request, trials.at(-1)?.outcome === "failed" ? undefined : trials.at(-1)?.facts);
          return batch;
        } } } });
    report.initialization = { outcome: "success", durationMs: performance.now() - start };
    if (config.prepareTimeoutMs !== undefined) {
      const begin = performance.now(); metrics = undefined;
      let failed = false;
      try {
        const plan = await core.plan(local.request);
        const calls = plan.scamCalls ?? [];
        // Release the handle before long preparation; its verdict is discarded.
        core.evaluate(plan, { planId: plan.planId, results: {} });
        plannedRequest(calls, plan.planId, config);
        await provider.prepare(calls, { planId: plan.planId, timeoutMs: config.prepareTimeoutMs });
      } catch { failed = true; }
      report.preparation = { outcome: failed ? "failed" : metrics?.outcome ?? "failed",
        timeoutMs: config.prepareTimeoutMs, durationMs: performance.now() - begin, provider: metricsSummary(metrics) };
      if (report.preparation.outcome === "failed") report.checkSkipped = "preparation_failed";
    }
    if (!report.checkSkipped) for (let i = 0; i < config.repeats; i++) {
      metrics = undefined; facts = []; planned = []; guardFailed = false;
      const begin = performance.now();
      let result;
      try { result = classifyAnalysis(await core.check(local.request), config.subjects); }
      catch { result = { outcome: "failed", reason: metrics?.reason === "timeout" ? "timeout" : "check_failed" }; }
      if (guardFailed) result = { outcome: "failed", reason: "target_mismatch" };
      trials.push({ attempt: i + 1, ...result, durationMs: performance.now() - begin,
        provider: metricsSummary(metrics), plannedHistories: planned, facts });
    }
  } catch {
    report.initialization = { outcome: "failed", durationMs: performance.now() - start, reason: "probe_setup_failed" };
  } finally { core?.dispose(); }
  const insufficient = trials.filter((t) => t.scamStatus === "insufficient").length;
  report.summary = { ...summarizeTrials(trials), insufficient,
    insufficientRatio: trials.length ? insufficient / trials.length : null,
    noTimeBudget: trials.filter((t) => t.reason === "no_time_budget").length,
    partialWarnings: trials.filter((t) => t.scamStatus === "warn" && t.outcome === "partial").length };
  report.summary.latencyCaution = "SDK check latency includes RPC, normalization, real algorithm and policy composition. Success-only excludes incomplete warnings and insufficient; inspect all-attempt failure/partial/timeout ratios. Small samples are not production percentiles.";
  return report;
}

async function main() {
  try {
    const config = readAnalysisProbeConfig(process.env);
    const [{ createCore }, { createScamFactProvider }] = await Promise.all([import("@dambi/core"), import("@dambi/core/adapters")]);
    const result = await runAnalysisProbe(config, { createCore, createProvider: createScamFactProvider });
    console.log(JSON.stringify(result, null, 2));
    if (result.initialization.outcome === "failed" || result.checkSkipped || !result.summary.attempts
        || result.summary.failed || result.summary.partial) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "probe_setup_failed",
      hint: "Check local configuration and current Core build. Endpoint, headers, keys and remote errors are omitted." }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
