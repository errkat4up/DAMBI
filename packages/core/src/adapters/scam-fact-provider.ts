import type { FactProvider, FactResult } from "../ports/fact.js";
import type { CallOptions } from "../types/options.js";
import type { FactBatch, PlannedCall } from "../types/plan.js";
import type { Address, MethodVerification, PlannedScamCall, PoolHistoryValue, Subject, TokenProfileValue, VerificationTimeSource } from "../types/scam.js";
import { CoreError } from "../types/errors.js";
import { ScamDataError, type ScamDataFailure } from "../types/scam-error.js";
import { copyJson, measureJson } from "../runtime/json.js";
import { AdapterError } from "./errors.js";
import { callSignal } from "./http.js";
import { address } from "./scam-rpc-codec.js";
import { buildPoolHistory, SCAM_DATA_BUILDER_VERSION, type PoolHistoryBuildLimits } from "./scam-pool-history.js";
import { buildTokenProfile, type FactoryHistorySupport, type TokenAdminSupport, type TokenProfileBuildOptions } from "./scam-token-profile.js";
import { createScamRpcSource, ScamRpcError, type ScamRpcBatch, type ScamRpcDiagnostic, type ScamRpcMetrics, type ScamRpcOptions } from "./scam-rpc.js";

export interface ScamProviderLimits {
  /** One deadline for the complete fetch, including all reference groups. */
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly maxTargets: number;
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
}
export type ScamProviderOperation = "request" | "reference" | "pool_identity" | "pool_history"
  | "token_profile" | "result" | "final_recheck";
export interface ScamProviderDiagnostic extends ScamRpcDiagnostic {
  /** Sequential provider work, distinct from the raw RPC boundary's stage. */
  readonly operation?: ScamProviderOperation;
}
export interface ScamProviderMetrics extends ScamRpcMetrics {
  readonly outcome: "success" | "partial" | "failed";
  readonly reason?: ScamDataFailure;
  /** Sanitized diagnostic only; never changes the returned advisory reason. */
  readonly failure?: ScamProviderDiagnostic;
  /** One-based reference group of preflight; this is not an aggregate budget. */
  readonly preflightGroup?: number;
  readonly calls: number;
  readonly targets: number;
  readonly resultBytes: number;
}
export interface ScamFactProviderOptions {
  /** Non-scam batches are delegated unchanged; mixed channels are rejected. */
  readonly policy: FactProvider;
  /** MVP: one explicitly configured chain. RPC limits apply per reference group. */
  readonly rpc: ScamRpcOptions;
  readonly history: PoolHistoryBuildLimits;
  readonly profile: Omit<TokenProfileBuildOptions, "factorySupport" | "adminSupport">;
  /** Trusted deployment capabilities, never discovered from matching topics. */
  readonly factorySupport?: readonly FactoryHistorySupport[];
  readonly adminSupport?: readonly TokenAdminSupport[];
  readonly limits: ScamProviderLimits;
  /** Data-path metrics only: excludes the algorithm and Core evaluation. */
  readonly onMetrics?: (metrics: ScamProviderMetrics) => void;
}
export interface ScamPreparationOptions extends CallOptions {
  readonly planId: string;
  /** Independent preparation budget; never replaces the fetch deadline. */
  readonly timeoutMs: number;
}
export interface ScamFactProvider extends FactProvider {
  /** Fill this provider's bounded raw-history cache before signing. No Fact or
   * analysis result is returned; fetch still builds and checks a fresh result.
   */
  prepare(calls: readonly PlannedCall[], options: ScamPreparationOptions): Promise<void>;
}

type HistoryCall = Extract<PlannedScamCall, { method: "scam.pool_history" }>;
type ProfileCall = Extract<PlannedScamCall, { method: "scam.token_profile" }>;
interface Target { subject: Subject; history?: HistoryCall; profile?: ProfileCall }
interface Group { id: string; confirmDepth: number; targets: Map<string, Target> }
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 512;
const height = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(v);
const eventKinds = new Set(["owner_changed", "proxy_upgraded", "admin_changed", "paused", "unpaused"]);
const invalid = (): never => { throw new ScamDataError("invalid_scam_input"); };

const diagnosticStages = new Set<ScamRpcDiagnostic["stage"]>(["request", "reference", "pool_identity", "block_header",
  "reserves", "decimals", "code", "logs", "preflight", "final_recheck", "collect", "provider"]);
const diagnosticKinds = new Set<ScamRpcDiagnostic["kind"]>(["http", "json_rpc", "network", "validation", "lifecycle", "resource_limit", "internal"]);
const diagnosticMethods = new Set<NonNullable<ScamRpcDiagnostic["method"]>>(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getLogs"]);

/** Copy only documented primitive fields, never a remote error or RPC input. */
function ownDiagnostic(value: ScamRpcDiagnostic | undefined, operation: ScamProviderOperation): ScamProviderDiagnostic | undefined {
  if (!value || !diagnosticStages.has(value.stage) || !diagnosticKinds.has(value.kind)) return undefined;
  return Object.freeze({ stage: value.stage, kind: value.kind, operation,
    ...(value.method !== undefined && diagnosticMethods.has(value.method) ? { method: value.method } : {}),
    ...(integer(value.httpStatus, 100) && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
    ...(typeof value.rpcCode === "number" && Number.isSafeInteger(value.rpcCode) ? { rpcCode: value.rpcCode } : {}),
    ...(integer(value.attempt, 1) && value.attempt <= 11 ? { attempt: value.attempt } : {}),
  });
}

/** Preserve only the last raw group's known-work lower bound, not remote data. */
function ownPreflight(value: ScamRpcMetrics["preflight"]): ScamRpcMetrics["preflight"] {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![value.uniqueLogBlocks, value.timestampedLogBlocks, value.additionalHeaderRequests,
        value.finalRecheckRequests, value.minimumRemainingRequests, value.remainingRequestBudget].every((v) => integer(v))
      || ![value.minimumPacingMs, value.remainingTimeMs].every((v) => typeof v === "number"
        && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER)) return undefined;
  return Object.freeze({ uniqueLogBlocks: value.uniqueLogBlocks, timestampedLogBlocks: value.timestampedLogBlocks,
    additionalHeaderRequests: value.additionalHeaderRequests, finalRecheckRequests: value.finalRecheckRequests,
    minimumRemainingRequests: value.minimumRemainingRequests, remainingRequestBudget: value.remainingRequestBudget,
    minimumPacingMs: value.minimumPacingMs, remainingTimeMs: value.remainingTimeMs });
}

function providerDiagnostic(error: unknown, reason: ScamDataFailure, operation: ScamProviderOperation): ScamProviderDiagnostic {
  const kind: ScamRpcDiagnostic["kind"] = reason === "resource_limit" ? "resource_limit"
    : reason === "timeout" || reason === "reorg" || error instanceof ScamRpcError && error.reason === "aborted"
      || error instanceof AdapterError && error.code === "ABORTED" ? "lifecycle"
    : reason === "invalid_scam_input" || reason === "subject_mismatch"
      || error instanceof CoreError || error instanceof AdapterError && ["INVALID_CONFIG", "INVALID_REQUEST", "INVALID_RESPONSE"].includes(error.code)
      ? "validation" : "internal";
  return Object.freeze({ stage: "provider", kind, operation });
}

function dataError(error: unknown): ScamDataError {
  if (error instanceof ScamDataError) return error;
  if (error instanceof CoreError && error.code === "LIMIT_EXCEEDED") return new ScamDataError("resource_limit");
  if (error instanceof ScamRpcError) {
    if (error.reason === "reorg" || error.reason === "timeout" || error.reason === "resource_limit" || error.reason === "subject_mismatch") {
      return new ScamDataError(error.reason);
    }
    if (error.reason === "chain_mismatch") return new ScamDataError("subject_mismatch");
    if (error.reason === "invalid_request" || error.reason === "invalid_response" || error.reason === "invalid_config") return new ScamDataError("invalid_scam_input");
  }
  return new ScamDataError("data_missing");
}

function ownConfig(input: ScamFactProviderOptions) {
  try {
    const limits = { ...input.limits }, history = { ...input.history }, profile = { ...input.profile };
    if (!input.policy || typeof input.policy.fetch !== "function"
        || ![limits.timeoutMs, limits.maxCalls, limits.maxTargets, limits.maxRequestBytes, limits.maxResultBytes,
          history.maxPoints, history.maxLogs, history.maxBlockLookups, history.blockTimeHintMs,
          profile.maxEvents, profile.maxLogs, profile.maxBlockLookups, profile.blockTimeHintMs].every((v) => integer(v, 1))
        || limits.timeoutMs > 2_147_483_647 || limits.maxCalls > 10_000 || limits.maxTargets > limits.maxCalls
        || input.onMetrics !== undefined && typeof input.onMetrics !== "function") throw new Error();
    const factories = new Map<string, FactoryHistorySupport>(), admins = new Map<string, TokenAdminSupport>();
    const suppliedFactories = input.factorySupport ?? [], suppliedAdmins = input.adminSupport ?? [];
    if (!Array.isArray(suppliedFactories) || !Array.isArray(suppliedAdmins)) throw new Error();
    for (const item of suppliedFactories) {
      if (!item || !text(item.id) || item.chainId !== input.rpc.chainId || !address(item.factory) || item.abi !== "uniswap_v2"
          || item.nonRecreationSupportId !== undefined && !text(item.nonRecreationSupportId)) throw new Error();
      const factory = item.factory.toLowerCase() as Address;
      if (factories.has(factory)) throw new Error();
      factories.set(factory, { id: item.id, chainId: item.chainId, factory, abi: item.abi,
        ...(item.nonRecreationSupportId === undefined ? {} : { nonRecreationSupportId: item.nonRecreationSupportId }) });
    }
    for (const item of suppliedAdmins) {
      if (!item || !text(item.id) || item.chainId !== input.rpc.chainId || !address(item.token) || item.abi !== "openzeppelin_standard"
          || !height(item.validFromBlock) || !height(item.validThroughBlock) || BigInt(item.validFromBlock) > BigInt(item.validThroughBlock)
          || !Array.isArray(item.kinds) || !item.kinds.length || item.kinds.length > eventKinds.size
          || !item.kinds.every((v: unknown) => typeof v === "string" && eventKinds.has(v))
          || new Set(item.kinds).size !== item.kinds.length) throw new Error();
      const token = item.token.toLowerCase() as Address;
      if (admins.has(token)) throw new Error();
      admins.set(token, { id: item.id, chainId: item.chainId, token, abi: item.abi, kinds: [...item.kinds],
        validFromBlock: item.validFromBlock, validThroughBlock: item.validThroughBlock });
    }
    const source = createScamRpcSource(input.rpc); // Owns endpoint, headers, fetch and raw limits now.
    const now = input.rpc.clock === undefined ? Date.now : input.rpc.clock.now.bind(input.rpc.clock);
    return { limits, history, profile, factories, admins, source, now, chainId: input.rpc.chainId,
      preparationEnabled: input.rpc.historyCache !== undefined,
      policyFetch: input.policy.fetch.bind(input.policy), onMetrics: input.onMetrics };
  } catch { throw new AdapterError("INVALID_CONFIG", "Scam Fact provider configuration is invalid."); }
}

function ownGroups(input: readonly PlannedCall[], planId: string, config: ReturnType<typeof ownConfig>): Group[] {
  if (!text(planId)) return invalid();
  if (input.length > config.limits.maxCalls) throw new ScamDataError("resource_limit");
  let calls: PlannedScamCall[];
  try {
    // Rehydrate the safe JSON copy's null-prototype arrays for builder array methods.
    calls = JSON.parse(JSON.stringify(copyJson(input, "INVALID_REQUEST", config.limits.maxRequestBytes))) as PlannedScamCall[];
  } catch (error) {
    if (error instanceof CoreError && error.code === "LIMIT_EXCEEDED") throw new ScamDataError("resource_limit");
    return invalid();
  }
  const groups = new Map<string, Group>(), ids = new Set<string>();
  let count = 0;
  for (const call of calls) {
    if (!call || !text(call.callId) || !text(call.manifestId) || ids.has(call.callId)
        || call.optional !== true || !Array.isArray(call.outputs) || call.outputs.length
        || !["scam.pool_history", "scam.token_profile"].includes(call.method)) return invalid();
    ids.add(call.callId);
    const p = call.params, s = p?.subject;
    if (!p || !text(p.referenceGroupId) || !integer(p.confirmDepth)
        || p.builderVersion !== SCAM_DATA_BUILDER_VERSION || p.dataSchema !== `${call.method}/1`
        || !s || s.chainId !== config.chainId || s.venue !== "uniswap_v2"
        || ![s.pool, s.factory, s.token, s.quoteToken].every(address)
        || !Array.isArray(s.actionPaths) || !s.actionPaths.every(text)) return invalid();
    const key = JSON.stringify([s.chainId, s.venue, s.pool.toLowerCase(), s.factory.toLowerCase(),
      s.token.toLowerCase(), s.quoteToken.toLowerCase(), s.actionPaths]);
    let group = groups.get(p.referenceGroupId);
    if (!group) { group = { id: p.referenceGroupId, confirmDepth: p.confirmDepth, targets: new Map() }; groups.set(group.id, group); }
    if (group.confirmDepth !== p.confirmDepth) return invalid();
    let target = group.targets.get(key);
    if (!target) {
      if (++count > config.limits.maxTargets) throw new ScamDataError("resource_limit");
      target = { subject: s }; group.targets.set(key, target);
    }
    if (call.method === "scam.pool_history") { if (target.history) return invalid(); target.history = call; }
    else { if (target.profile) return invalid(); target.profile = call; }
  }
  for (const group of groups.values()) for (const target of group.targets.values()) {
    if (!target.history || !target.profile) return invalid();
  }
  return [...groups.values()];
}

/** Track the raw time sources supplied to one builder, without changing I/O or
 * counting a log timestamp as an independently verified header. Both methods
 * already receive their shared reference from an actual header.
 */
type MethodRawProvenance = Pick<MethodVerification, "timeSources" | "reuse" | "rawObservedAt">;

function methodTimeSources(batch: ScamRpcBatch) {
  const sources = new Set<VerificationTimeSource>(["header"]);
  let reuse: MethodVerification["reuse"] = "none";
  let fromMs = batch.observedAt, toMs = batch.observedAt;
  return {
    batch: Object.freeze({ ...batch,
      async logs(pool: Parameters<ScamRpcBatch["logs"]>[0], query: Parameters<ScamRpcBatch["logs"]>[1]) {
        const scan = await batch.logs(pool, query);
        if (scan.logs.some((log) => log.timestampMs !== undefined)) sources.add("rpc_log");
        if (scan.provenance) {
          reuse = "interval_cache";
          fromMs = Math.min(fromMs, scan.provenance.rawObservedAt.fromMs);
          toMs = Math.max(toMs, scan.provenance.rawObservedAt.toMs);
        }
        return scan;
      },
    } satisfies ScamRpcBatch),
    snapshot: (): MethodRawProvenance => Object.freeze({ timeSources: Object.freeze([...sources]),
      reuse, rawObservedAt: Object.freeze({ fromMs, toMs }) }),
  };
}

function boundResult(planId: string, results: Record<string, FactResult>, maxBytes: number): number {
  try { return measureJson({ planId, results }, "INVALID_REQUEST", maxBytes); }
  catch (error) {
    if (error instanceof CoreError && error.code === "LIMIT_EXCEEDED") throw new ScamRpcError("resource_limit");
    throw error;
  }
}

/** Optional raw-history reuse, no default capabilities, algorithm or policy projection.
 * The same provider handles manual fetch/evaluate and Core.check(). Each group
 * is published only after its final canonical checks, and no partial batch is
 * returned if another group fails. RPC budgets are per group; the deadline and
 * request/result sizes bound the complete fetch.
 */
export function createScamFactProvider(options: ScamFactProviderOptions): ScamFactProvider {
  const config = ownConfig(options);
  const execute = async (calls: readonly PlannedCall[], context: CallOptions & { readonly planId: string },
    timeoutMs: number): Promise<FactBatch> => {
      if (!Array.isArray(calls)) return invalid();
      const callCount = calls.length;
      const totals = { requests: 0, retries: 0, receivedBytes: 0, logChunks: 0, failedChunks: 0 };
      let started: number | undefined, targets = 0, resultBytes = 0;
      let outcome: ScamProviderMetrics["outcome"] = "failed", reason: ScamDataFailure | undefined;
      let operation: ScamProviderOperation = "request", diagnostic: ScamProviderDiagnostic | undefined;
      let rawGroups = 0, preflightGroup: number | undefined, preflight: ScamRpcMetrics["preflight"];
      const now = (): number => { const time = config.now(); if (!integer(time)) throw new ScamRpcError("invalid_config"); return time; };
      try {
        started = now();
        const planId = context?.planId, signal = callSignal(context);
        const groups = ownGroups(calls, planId, config);
        targets = groups.reduce((sum, group) => sum + group.targets.size, 0);
        const deadlineMs = started + timeoutMs;
        if (!Number.isSafeInteger(deadlineMs)) return invalid();
        let results: Record<string, FactResult> = Object.create(null) as Record<string, FactResult>;
        let encodedBytes: number | undefined;
        let partial = false;
        for (const group of groups) {
          const members = [...group.targets.values()];
          operation = "reference";
          const response = await config.source.withBatch({ planId, referenceGroupId: group.id, confirmDepth: group.confirmDepth,
            subjects: members.map((target) => target.subject), deadlineMs, signal,
            onMetrics(metric) {
              for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += metric[key];
              rawGroups++;
              // A later group's failure before preflight must not expose an
              // earlier group's lower bound as the cause of that failure.
              preflight = ownPreflight(metric.preflight);
              preflightGroup = preflight === undefined ? undefined : rawGroups;
              if (metric.outcome === "failed") diagnostic = ownDiagnostic(metric.failure, operation);
            },
          }, async (batch) => {
            const draft: Record<string, FactResult> = Object.assign(Object.create(null), results);
            const provenance = new Map<string, MethodRawProvenance>();
            // Sequential targets bound peak normalized memory and avoid detached
            // I/O after a failing target. The raw source bounds HTTP concurrency.
            for (let i = 0; i < members.length; i++) {
              operation = "pool_identity";
              const target = members[i], pool = await batch.pool(i);
              operation = "pool_history";
              const historyTimes = methodTimeSources(batch);
              const history = await buildPoolHistory(historyTimes.batch, pool, target.history!.params, config.history);
              provenance.set(target.history!.callId, historyTimes.snapshot());
              operation = "token_profile";
              const profileTimes = methodTimeSources(batch);
              const profile = await buildTokenProfile(profileTimes.batch, pool, target.profile!.params, { ...config.profile,
                factorySupport: config.factories.get(pool.subject.factory), adminSupport: config.admins.get(pool.subject.token) });
              provenance.set(target.profile!.callId, profileTimes.snapshot());
              operation = "result";
              for (const [callId, value] of [[target.history!.callId, history], [target.profile!.callId, profile]] as const) {
                draft[callId] = { value, source: `scam-rpc:eip155:${config.chainId}`, observedAt: batch.observedAt,
                  blockNumber: batch.reference.block.number };
                partial ||= value.coverage.missing.length > 0 || value.coverage.unavailable.length > 0
                  || (value.method === "scam.token_profile" ? value.age.kind === "unknown"
                    : value.histories.some(({ history }) => !history.warmup.complete || history.missing.length > 0));
              }
              // Bound the actual envelope before collecting the next target.
              // Nothing in this draft is published before final hash checks.
              boundResult(planId, draft, config.limits.maxResultBytes);
            }
            operation = "final_recheck";
            return { draft, provenance };
          });
          operation = "result";
          results = response.value.draft;
          for (const [callId, provenance] of response.value.provenance) {
            const fact = results[callId];
            const value = fact.value as PoolHistoryValue | TokenProfileValue;
            const verification: MethodVerification = Object.freeze({ version: 1, ...response.verification, ...provenance,
              verifiedAt: response.verifiedAt });
            results[callId] = { ...fact, value: { ...value, verification } };
          }
          // The completed verification metadata belongs to the same result budget.
          encodedBytes = boundResult(planId, results, config.limits.maxResultBytes);
        }
        operation = "result";
        const batch = { planId, results };
        // The private envelope has not changed since its last metadata-inclusive
        // measurement. Avoid serializing and allocating a UTF-8 copy just to count it.
        const finalBytes = encodedBytes ?? boundResult(planId, results, config.limits.maxResultBytes);
        if (signal?.aborted) throw new ScamRpcError("aborted");
        if (now() < started || now() >= deadlineMs) throw new ScamRpcError("timeout");
        resultBytes = finalBytes;
        outcome = partial ? "partial" : "success";
        return batch;
      } catch (error) {
        const failure = dataError(error); reason = failure.reason;
        diagnostic ??= providerDiagnostic(error, reason, operation);
        throw failure;
      } finally {
        let durationMs = 0;
        try { if (started !== undefined) durationMs = Math.max(0, now() - started); } catch { /* Measurement cannot alter a verdict. */ }
        const metric: ScamProviderMetrics = Object.freeze({ ...totals, outcome, ...(reason && { reason }),
          ...(outcome === "failed" && diagnostic ? { failure: diagnostic } : {}),
          ...(preflight === undefined || preflightGroup === undefined ? {} : { preflight, preflightGroup }),
          calls: callCount, targets, resultBytes, durationMs });
        try { void Promise.resolve(config.onMetrics?.(metric)).catch(() => {}); } catch { /* Observer isolation. */ }
      }
  };
  return Object.freeze({
    async fetch(calls: readonly PlannedCall[], context: CallOptions & { readonly planId: string }): Promise<FactBatch> {
      if (!Array.isArray(calls)) return invalid();
      // Existing policy calls stay on their original provider and error channel.
      if (!calls.some((call) => typeof call?.method === "string" && call.method.startsWith("scam."))) return config.policyFetch(calls, context);
      return execute(calls, context, config.limits.timeoutMs);
    },
    async prepare(calls: readonly PlannedCall[], context: ScamPreparationOptions): Promise<void> {
      const timeoutMs = context?.timeoutMs;
      if (!config.preparationEnabled || !integer(timeoutMs, 1) || timeoutMs > 60_000) {
        throw new AdapterError("INVALID_CONFIG", "Scam history preparation requires a cache and a bounded timeout.");
      }
      if (!Array.isArray(calls) || calls.length === 0) return invalid();
      // execute validates complete scam-only pairs before acquiring a reference.
      // Discard computed Facts; only the source's verified raw cache survives.
      await execute(calls, context, timeoutMs);
    },
  });
}
