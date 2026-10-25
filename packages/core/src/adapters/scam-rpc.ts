/** Internal raw RPC boundary. No Fact projection, normalization or algorithm.
 * A future scam provider shares one batch across history/profile and publishes
 * its result only after the reference and every evidence block are rechecked.
 */
import type { Clock } from "../ports/clock.js";
import type { Address, FixedReference, HistoryVerification, StateBinding, Subject } from "../types/scam.js";
import type { EvmRpcEndpoint } from "./fact-provider.js";
import { AdapterError } from "./errors.js";
import { decodeQuantity, readRpcResult, RpcResponseError } from "./evm-rpc.js";
import { callSignal, fetchText } from "./http.js";
import {
  address, hash, quantity, decodeAddressWord, decodeBlock, decodeCode,
  decodeDecimals, decodeLogs, decodeReserves, type RpcBlock, type RpcLog,
} from "./scam-rpc-codec.js";

export type ScamRpcFailure = "invalid_config" | "invalid_request" | "chain_mismatch"
  | "subject_mismatch" | "invalid_response" | "rpc_error" | "resource_limit"
  | "timeout" | "aborted" | "reorg";

export class ScamRpcError extends Error {
  constructor(readonly reason: ScamRpcFailure) {
    super(`Scam RPC operation failed: ${reason}.`);
    this.name = "ScamRpcError";
  }
}

export interface ScamRpcLimits {
  readonly maxRequests: number; // JSON-RPC attempts, NOT ScamLimits.maxCalls.
  readonly maxResponseBytes: number;
  readonly maxTotalResponseBytes: number;
  readonly maxLogs: number;
  readonly maxBlocksPerQuery: number;
  readonly concurrency: number;
  readonly maxRetries: number;
  /** Base of exponential retry backoff. All waiting consumes the batch deadline. */
  readonly retryDelayMs: number;
  /** Minimum launch spacing shared by this source, including all batches/retries. Default 0. */
  readonly minRequestIntervalMs?: number;
  /** Caps exponential backoff only, not a server's longer Retry-After. */
  readonly maxRetryDelayMs?: number;
}
export interface ScamVerificationOptions {
  /** AH1 supports all_event_headers only. Other declared modes fail configuration. */
  readonly history?: HistoryVerification;
  /** AH1 supports number_recheck only; unsupported choices never silently fall back. */
  readonly stateBinding?: StateBinding;
}
export interface ScamRpcOptions {
  readonly chainId: number;
  readonly endpoint: EvmRpcEndpoint;
  readonly factories: readonly Address[];
  readonly quoteTokens: readonly Address[];
  readonly limits: ScamRpcLimits;
  readonly verification?: ScamVerificationOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: Clock;
}
export interface ScamRpcRequest {
  readonly planId: string;
  readonly referenceGroupId: string;
  readonly confirmDepth: number;
  readonly subjects: readonly Subject[];
  /** Internal absolute budget; the caller's signal can end it earlier. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** One terminal, immutable snapshot. Observer exceptions never affect data. */
  readonly onMetrics?: (metrics: ScamRpcTerminalMetrics) => void;
}
export interface VerifiedPool {
  readonly subject: Subject;
  readonly token0: Address;
  readonly token1: Address;
}
export interface RawLogRange {
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly reason: "rpc_error" | "invalid_response";
}
export interface RawLogScan {
  readonly logs: readonly RpcLog[];
  readonly missing: readonly RawLogRange[];
}
export interface ScamRpcBatch {
  readonly planId: string;
  readonly referenceGroupId: string;
  readonly observedAt: number;
  readonly reference: FixedReference;
  /** Index in the request's copied subjects. Nothing is inferred from symbols. */
  pool(index: number): Promise<VerifiedPool>;
  block(number: string): Promise<RpcBlock>;
  /** Check the known header work plus final canonical checks before dispatch.
   * A lower bound only: later profile work, latency and retries are not included.
   */
  preflightHeaders(numbers: readonly string[]): void;
  reserves(pool: VerifiedPool, number?: string): Promise<ReturnType<typeof decodeReserves>>;
  decimals(pool: VerifiedPool, side: "token0" | "token1"): Promise<number>;
  code(pool: VerifiedPool, number: string): Promise<`0x${string}`>;
  logs(pool: VerifiedPool, query: {
    readonly scope: "pair" | "factory" | "token";
    readonly fromBlock: string;
    readonly toBlock: string;
    readonly topics: readonly string[];
  }): Promise<RawLogScan>;
}
export interface ScamRpcPreflight {
  readonly uniqueLogBlocks: number;
  readonly timestampedLogBlocks: number;
  readonly additionalHeaderRequests: number;
  readonly finalRecheckRequests: number;
  readonly minimumRemainingRequests: number;
  readonly remainingRequestBudget: number;
  readonly minimumPacingMs: number;
  readonly remainingTimeMs: number;
}
export interface ScamRpcMetrics {
  readonly requests: number;
  readonly retries: number;
  readonly receivedBytes: number;
  readonly logChunks: number;
  readonly failedChunks: number;
  readonly durationMs: number;
  /** Last preflight snapshot in this reference group, refreshed before final
   * verification with its frozen targets; not a completion-time estimate.
   */
  readonly preflight?: ScamRpcPreflight;
}
/** Terminal diagnostics only. Never contains URLs, arguments or remote text. */
export interface ScamRpcDiagnostic {
  readonly stage: "request" | "reference" | "pool_identity" | "block_header"
    | "reserves" | "decimals" | "code" | "logs" | "preflight" | "final_recheck" | "collect" | "provider";
  readonly kind: "http" | "json_rpc" | "network" | "validation" | "lifecycle" | "resource_limit" | "internal";
  readonly method?: "eth_chainId" | "eth_getBlockByNumber" | "eth_call" | "eth_getCode" | "eth_getLogs";
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  /** One-based attempt of this RPC, not the batch request count. */
  readonly attempt?: number;
}
export type ScamRpcTerminalMetrics = ScamRpcMetrics & {
  readonly outcome: "success" | "failed";
  readonly reason?: ScamRpcFailure;
  readonly failure?: ScamRpcDiagnostic;
};

// Bind context to the escaping error, not to a mutable "last RPC error".
// Recovered retries and missing log chunks must not become terminal causes.
const diagnostics = new WeakMap<ScamRpcError, ScamRpcDiagnostic>();

const fail = (reason: ScamRpcFailure): never => { throw new ScamRpcError(reason); };
type EvidenceRole = "checked_head" | "reference" | "queried_header" | "state_read" | "log" | "cache_boundary";
interface BlockEvidence {
  readonly hash: string;
  timestampMs?: number;
  readonly roles: Set<EvidenceRole>;
}
interface FinalCheck {
  readonly number: string;
  /** Absent only in a preflight projection for a header not collected yet. */
  readonly hash?: string;
  readonly timestampMs?: number;
  readonly roles: readonly EvidenceRole[];
}

/** One selection policy for budget projections and actual final verification.
 * AH1 keeps every observed block. No weaker mode is implemented by this step.
 * Pending headers project future work without inventing hash/time evidence.
 */
function selectFinalChecks(evidence: ReadonlyMap<string, BlockEvidence>, mode: HistoryVerification,
  referenceNumber: string, pendingHeaders: Iterable<string> = []): readonly FinalCheck[] {
  if (mode !== "all_event_headers") return fail("invalid_config");
  const selected = new Map<string, FinalCheck>();
  for (const [number, entry] of evidence) {
    selected.set(number, { number, hash: entry.hash, timestampMs: entry.timestampMs, roles: [...entry.roles] });
  }
  for (const number of pendingHeaders) {
    const existing = selected.get(number);
    const roles = new Set<EvidenceRole>(existing?.roles);
    roles.add("queried_header");
    selected.set(number, { ...existing, number, roles: [...roles] });
  }
  const reference = selected.get(referenceNumber);
  if (!reference || !reference.roles.includes("reference")) return fail("invalid_request");
  // Preserve collection order except for the reference, checked once and last.
  selected.delete(referenceNumber);
  selected.set(referenceNumber, reference);
  return Object.freeze([...selected.values()].map((entry) => Object.freeze({
    ...entry, roles: Object.freeze([...entry.roles]),
  })));
}
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
function height(v: unknown): bigint {
  if (typeof v !== "string" || !/^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(v)) return fail("invalid_request");
  return BigInt(v);
}
function errorOf(error: unknown): ScamRpcError {
  if (error instanceof ScamRpcError) return error;
  if (error instanceof AdapterError) {
    if (error.code === "ABORTED") return new ScamRpcError("aborted");
    if (error.code === "RESPONSE_TOO_LARGE") return new ScamRpcError("resource_limit");
    if (error.code === "INVALID_RESPONSE") return new ScamRpcError("invalid_response");
  }
  return new ScamRpcError("rpc_error");
}

function diagnosticError(error: unknown, stage: ScamRpcDiagnostic["stage"],
  method?: ScamRpcDiagnostic["method"], attempt?: number): ScamRpcError {
  const failure = errorOf(error);
  if (diagnostics.has(failure)) return failure;
  const kind: ScamRpcDiagnostic["kind"] = failure.reason === "aborted" || failure.reason === "timeout" ? "lifecycle"
    : failure.reason === "resource_limit" ? "resource_limit"
    : error instanceof AdapterError && error.code === "HTTP_ERROR" ? "http"
    : error instanceof RpcResponseError ? "json_rpc"
    : error instanceof AdapterError && error.code === "NETWORK_ERROR" ? "network"
    : failure.reason !== "rpc_error" ? "validation" : "internal";
  const httpStatus = kind === "http" && error instanceof AdapterError ? error.status : undefined;
  const rpcCode = kind === "json_rpc" && error instanceof RpcResponseError ? error.rpcCode : undefined;
  diagnostics.set(failure, Object.freeze({ stage, kind, ...(method === undefined ? {} : { method }),
    ...(integer(httpStatus, 100) && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof rpcCode === "number" && Number.isSafeInteger(rpcCode) ? { rpcCode } : {}),
    ...(integer(attempt, 1) && attempt <= 11 ? { attempt } : {}) }));
  return failure;
}

/** Parse only a bounded 429 Retry-After header; never retain remote text. */
function retryAfterDelay(value: string | null, wallNow: number): number | undefined {
  if (value === null || value.length > 128) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    // Very large valid delays still prohibit an early retry; the batch's own
    // deadline ends its wait. No unbounded timer is created for this value.
    return Math.min(Number(trimmed) * 1000, Number.MAX_SAFE_INTEGER);
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - wallNow) : undefined;
}

function ownOptions(supplied: ScamRpcOptions) {
  try {
    const { chainId, endpoint, factories, quoteTokens, fetch: injected, clock } = supplied;
    const requested = supplied.verification;
    if (requested !== undefined && (!requested || typeof requested !== "object" || Array.isArray(requested)
        || Reflect.ownKeys(requested).some((key) => key !== "history" && key !== "stateBinding"))) throw new Error();
    const verification = Object.freeze({
      history: requested?.history === undefined ? "all_event_headers" : requested.history,
      stateBinding: requested?.stateBinding === undefined ? "number_recheck" : requested.stateBinding,
    } satisfies Required<ScamVerificationOptions>);
    // Keep the existing implementation truthful until the later modes exist.
    if (verification.history !== "all_event_headers" || verification.stateBinding !== "number_recheck") throw new Error();
    const limits = { ...supplied.limits,
      minRequestIntervalMs: supplied.limits.minRequestIntervalMs === undefined ? 0 : supplied.limits.minRequestIntervalMs,
      maxRetryDelayMs: supplied.limits.maxRetryDelayMs === undefined ? Math.max(30_000, supplied.limits.retryDelayMs) : supplied.limits.maxRetryDelayMs };
    if (!integer(chainId, 1) || !endpoint || !Array.isArray(factories) || !factories.length
        || !Array.isArray(quoteTokens) || !quoteTokens.length
        || !factories.every(address) || !quoteTokens.every(address)) throw new Error();
    for (const key of ["maxRequests", "maxResponseBytes", "maxTotalResponseBytes", "maxLogs", "maxBlocksPerQuery", "concurrency"] as const) {
      if (!integer(limits[key], 1)) throw new Error();
    }
    if (!integer(limits.maxRetries) || !integer(limits.retryDelayMs) || limits.concurrency > 16
        || limits.maxRequests > 10_000 || limits.maxRetries > 10 || limits.retryDelayMs > 60_000
        || !integer(limits.minRequestIntervalMs) || limits.minRequestIntervalMs > 60_000
        || !integer(limits.maxRetryDelayMs) || limits.maxRetryDelayMs > 60_000
        || limits.maxRetryDelayMs < limits.retryDelayMs) throw new Error();
    const rpcUrl = endpoint.rpcUrl;
    if (typeof rpcUrl !== "string" || !/^https?:\/\/[^/?#\s@\\]+(?:[/?][^\s\\#]*)?$/i.test(rpcUrl)
        || /[\s\\#]/.test(rpcUrl)) throw new Error();
    const url = new URL(rpcUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
        || url.username || url.password || url.hash) throw new Error();
    const headers = new Headers();
    if (endpoint.headers !== undefined) {
      if (!endpoint.headers || typeof endpoint.headers !== "object" || Array.isArray(endpoint.headers)) throw new Error();
      for (const [name, value] of Object.entries(endpoint.headers)) {
        if (typeof value !== "string") throw new Error();
        headers.set(name, value);
      }
    }
    for (const name of ["host", "content-length", "transfer-encoding", "connection", "cookie", "if-none-match", "if-modified-since"]) {
      if (headers.has(name)) throw new Error();
    }
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const fetcher = injected ?? globalThis.fetch.bind(globalThis);
    const now = clock === undefined ? Date.now : clock.now.bind(clock);
    if (typeof fetcher !== "function") throw new Error();
    return { chainId, url: url.href, headers, fetcher, now, limits, verification,
      factories: new Set(factories.map((v) => v.toLowerCase())),
      quotes: new Set(quoteTokens.map((v) => v.toLowerCase())) };
  } catch { return fail("invalid_config"); }
}

function ownRequest(input: ScamRpcRequest, config: ReturnType<typeof ownOptions>) {
  try {
    const { planId, referenceGroupId, confirmDepth, deadlineMs } = input;
    const signal = callSignal(input);
    if (!text(planId) || !text(referenceGroupId) || !integer(confirmDepth)
        || !integer(deadlineMs) || !Array.isArray(input.subjects) || !input.subjects.length
        || (input.onMetrics !== undefined && typeof input.onMetrics !== "function")
        || input.subjects.length > config.limits.maxRequests) throw new Error();
    const subjects = input.subjects.map((s): Subject => {
      if (s.chainId !== config.chainId || s.venue !== "uniswap_v2"
          || ![s.pool, s.factory, s.token, s.quoteToken].every(address)
          || !config.factories.has(s.factory.toLowerCase()) || !config.quotes.has(s.quoteToken.toLowerCase())
          || s.token.toLowerCase() === s.quoteToken.toLowerCase()
          || !Array.isArray(s.actionPaths) || !s.actionPaths.every(text)) throw new Error();
      return Object.freeze({ chainId: s.chainId, venue: s.venue,
        pool: s.pool.toLowerCase() as Address, factory: s.factory.toLowerCase() as Address,
        token: s.token.toLowerCase() as Address, quoteToken: s.quoteToken.toLowerCase() as Address,
        actionPaths: Object.freeze([...s.actionPaths]) });
    });
    return { planId, referenceGroupId, confirmDepth, deadlineMs, signal, subjects };
  } catch { return fail("invalid_request"); }
}

/** Internal until the SF4 builders/provider are assembled; not a public adapter. */
export function createScamRpcSource(options: ScamRpcOptions) {
  const config = ownOptions(options);
  let sequence = 0n;
  // One endpoint per source. Keep actual dispatch spacing/cooldown across
  // groups and fetches, but do not reserve future slots for waiting callers.
  // Monotonic scheduling is separate from the plan's wall-clock deadline.
  let nextLaunchAt = 0, cooldownUntil = 0;
  return Object.freeze({
    async withBatch<T>(input: ScamRpcRequest, collect: (batch: ScamRpcBatch) => Promise<T>): Promise<{
      readonly value: T; readonly reference: FixedReference; readonly observedAt: number; readonly metrics: ScamRpcMetrics;
      readonly verification: Readonly<Required<ScamVerificationOptions>>;
      /** Recorded only after the batch's final header checks have completed. */
      readonly verifiedAt: number;
    }> {
      const metrics: { requests: number; retries: number; receivedBytes: number;
        logChunks: number; failedChunks: number; preflight?: ScamRpcPreflight } = {
        requests: 0, retries: 0, receivedBytes: 0, logChunks: 0, failedChunks: 0 };
      let startedAt: number | undefined;
      let notify: ScamRpcRequest["onMetrics"];
      // Only the sequential outer phase is shared. RPC context is call-local.
      let stage: ScamRpcDiagnostic["stage"] = "request";
      const duration = (): number => {
        // Metrics must not change a valid result when a diagnostic clock fails.
        try { const end = config.now(); if (startedAt !== undefined && integer(end)) return Math.max(0, end - startedAt); } catch { /* diagnostic only */ }
        return 0;
      };
      const publish = (outcome: ScamRpcTerminalMetrics["outcome"], failure?: ScamRpcError, completed?: ScamRpcMetrics): void => {
        const snapshot: ScamRpcTerminalMetrics = Object.freeze({ ...(completed ?? { ...metrics, durationMs: duration() }), outcome,
          ...(failure === undefined ? {} : { reason: failure.reason, failure: diagnostics.get(failure) }) });
        try { void Promise.resolve(notify?.(snapshot)).catch(() => {}); } catch { /* Observer is not part of the RPC verdict. */ }
      };
      const run = async () => {
      const request = ownRequest(input, config);
      if (typeof collect !== "function") return fail("invalid_request");
      const now = (): number => {
        try { const value = config.now(); if (integer(value)) return value; } catch { /* sanitized below */ }
        return fail("invalid_config");
      };
      const observedAt = now();
      startedAt = observedAt;
      const controller = new AbortController();
      let timedOut = false;
      let closed = false;
      let terminalFailure: ScamRpcError | undefined;
      const stop = (reason: "resource_limit" | "reorg" | "invalid_response"): never => {
        terminalFailure ??= new ScamRpcError(reason);
        controller.abort();
        throw terminalFailure;
      };
      const abort = (): void => controller.abort();
      const check = (): void => {
        if (request.signal?.aborted) return fail("aborted");
        if (timedOut || now() >= request.deadlineMs) return fail("timeout");
        if (terminalFailure) throw terminalFailure;
        if (closed || controller.signal.aborted) return fail("aborted");
      };
      check();
      const remaining = request.deadlineMs - observedAt;
      if (remaining > 2_147_483_647) return fail("invalid_request");
      const expiresAt = performance.now() + remaining;
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
      let active = 0;
      let pending = 0;
      let logCount = 0;
      const waiters: (() => void)[] = [];
      const abortable = <R>(work: Promise<R>): Promise<R> => new Promise((resolve, reject) => {
        const onAbort = (): void => {
          reject(request.signal?.aborted ? new ScamRpcError("aborted")
            : terminalFailure ?? new ScamRpcError(timedOut ? "timeout" : "aborted"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        void work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
      const delay = async (ms: number): Promise<void> => {
        let id: ReturnType<typeof setTimeout> | undefined;
        try { await abortable(new Promise<void>((resolve) => { id = setTimeout(resolve, Math.min(2_147_483_647, Math.ceil(ms))); })); }
        finally { clearTimeout(id); }
        check();
      };
      const rpc = async <R = unknown>(rpcStage: ScamRpcDiagnostic["stage"], method: NonNullable<ScamRpcDiagnostic["method"]>,
        params: readonly unknown[], decode?: (value: unknown) => R): Promise<R> => {
        pending++;
        let admitted = false;
        let wake: (() => void) | undefined;
        let attempted: number | undefined;
        try {
          check();
          if (active >= config.limits.concurrency) {
            await abortable(new Promise<void>((resolve) => { wake = resolve; waiters.push(resolve); }));
            // The previous worker transfers its slot to this waiter.
            admitted = true;
          } else { active++; admitted = true; }
          check();
          for (let attempt = 0; ; attempt++) {
            check();
            if (metrics.requests >= config.limits.maxRequests) return stop("resource_limit");
            // The check and reservation below are synchronous: concurrent
            // callers cannot launch into the same slot. Recheck shared cooldown
            // after every wait, since another request may have received 429.
            for (;;) {
              check();
              const waitMs = Math.max(nextLaunchAt, cooldownUntil) - performance.now();
              if (waitMs <= 0) break;
              await delay(waitMs);
            }
            check();
            if (metrics.requests >= config.limits.maxRequests) return stop("resource_limit");
            nextLaunchAt = performance.now() + config.limits.minRequestIntervalMs;
            metrics.requests++;
            attempted = attempt + 1;
            const id = `scam:${++sequence}`;
            let retryAfterMs: number | undefined;
            try {
              const response = await fetchText(async (url, init) => {
                const reply = await config.fetcher(url, init);
                // Only capture a numeric hint here. Late replies cannot alter
                // the source cooldown; that happens after check() in the catch.
                if (reply.status === 429) {
                  try { retryAfterMs = retryAfterDelay(reply.headers.get("retry-after"), Date.now()); }
                  catch { /* An unreadable hint does not replace the HTTP error. */ }
                }
                return reply;
              }, config.url, {
                method: "POST", headers: new Headers(config.headers),
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                redirect: "error", credentials: "omit", cache: "no-store",
              }, config.limits.maxResponseBytes, controller.signal);
              check();
              if (response.status !== 200) return fail("rpc_error");
              metrics.receivedBytes += new TextEncoder().encode(response.text).byteLength;
              if (metrics.receivedBytes > config.limits.maxTotalResponseBytes) return stop("resource_limit");
              const value = readRpcResult(response.text, id);
              return decode ? decode(value) : value as R;
            } catch (error) {
              check();
              const backoffMs = Math.min(config.limits.maxRetryDelayMs, config.limits.retryDelayMs * 2 ** attempt);
              const rateLimited = error instanceof AdapterError && error.code === "HTTP_ERROR" && error.status === 429
                || error instanceof RpcResponseError && error.rpcCode === -32005;
              if (rateLimited) {
                // Honor cooldown even when this call cannot retry. A sibling
                // batch must not immediately repeat the same rate-limit burst.
                cooldownUntil = Math.max(cooldownUntil, performance.now() + Math.max(backoffMs, retryAfterMs ?? 0));
              }
              const retry = error instanceof AdapterError && (error.code === "NETWORK_ERROR"
                || (error.code === "HTTP_ERROR" && [429, 502, 503, 504].includes(error.status ?? 0)))
                || error instanceof RpcResponseError && error.rpcCode === -32005;
              if (!retry || attempt >= config.limits.maxRetries) {
                const failure = diagnosticError(error, rpcStage, method, attempted);
                if (failure.reason === "resource_limit") return stop("resource_limit");
                throw failure;
              }
              metrics.retries++;
              if (!rateLimited) await delay(backoffMs);
            }
          }
        } catch (error) {
          throw diagnosticError(error, rpcStage, method, attempted);
        } finally {
          pending--;
          if (admitted) {
            const next = waiters.shift();
            if (next) next(); else active--;
          } else if (wake) {
            const index = waiters.indexOf(wake);
            if (index >= 0) waiters.splice(index, 1);
          }
        }
      };
      const evidence = new Map<string, BlockEvidence>();
      const logBlocks = new Set<string>(), timestampedLogBlocks = new Set<string>();
      const blocks = new Map<string, RpcBlock>();
      const remember = (number: string, blockHash: string, role: EvidenceRole, timestampMs?: number): void => {
        const existing = evidence.get(number);
        if (existing && existing.hash !== blockHash) return stop("reorg");
        if (timestampMs !== undefined && existing?.timestampMs !== undefined
            && existing.timestampMs !== timestampMs) return stop("invalid_response");
        if (existing) {
          if (timestampMs !== undefined) existing.timestampMs = timestampMs;
          existing.roles.add(role);
        } else {
          evidence.set(number, { hash: blockHash, timestampMs, roles: new Set([role]) });
        }
      };
      const validateTimes = (times: readonly (readonly [string, number])[]): void => {
        const ordered = [...times].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
        for (let i = 1; i < ordered.length; i++) {
          if (ordered[i - 1][1] > ordered[i][1]) return stop("invalid_response");
        }
      };
      const collectedTimes = (): [string, number][] => [...evidence].flatMap(([number, entry]) =>
        entry.timestampMs === undefined ? [] : [[number, entry.timestampMs] as [string, number]]);
      const readBlock = (number: bigint, rpcStage: ScamRpcDiagnostic["stage"] = "block_header"): Promise<RpcBlock> =>
        rpc(rpcStage, "eth_getBlockByNumber", [quantity(number), false], (value) => decodeBlock(value, number));
      const enforcePreflight = (checks: readonly FinalCheck[], additionalHeaders: number): void => {
        try {
          check();
          if (pending !== 0) return fail("invalid_request");
          const minimumRequests = additionalHeaders + checks.length;
          const monoNow = performance.now();
          // Round the zero-network-latency lower bound down and available time up.
          const minimumPacingMs = minimumRequests === 0 ? 0 : Math.floor(
            Math.max(0, Math.max(nextLaunchAt, cooldownUntil) - monoNow)
            + (minimumRequests - 1) * config.limits.minRequestIntervalMs);
          const remainingTimeMs = Math.max(0, Math.ceil(Math.min(request.deadlineMs - now(), expiresAt - monoNow)));
          metrics.preflight = Object.freeze({ uniqueLogBlocks: logBlocks.size,
            timestampedLogBlocks: timestampedLogBlocks.size, additionalHeaderRequests: additionalHeaders,
            finalRecheckRequests: checks.length, minimumRemainingRequests: minimumRequests,
            remainingRequestBudget: Math.max(0, config.limits.maxRequests - metrics.requests),
            minimumPacingMs, remainingTimeMs });
          if (minimumRequests > metrics.preflight.remainingRequestBudget
              || minimumRequests > 0 && minimumPacingMs >= remainingTimeMs) return stop("resource_limit");
        } catch (error) { throw diagnosticError(error, "preflight"); }
      };
      const verifyFinalChecks = async (checks: readonly FinalCheck[]): Promise<void> => {
        const verifiedTimes: [string, number][] = [];
        for (const target of checks) {
          if (target.hash === undefined) return fail("invalid_request");
          const current = await readBlock(BigInt(target.number), "final_recheck");
          if (current.hash !== target.hash) return stop("reorg");
          if (target.timestampMs !== undefined && current.timestampMs !== target.timestampMs) return stop("invalid_response");
          // Header times complete the private verification set only. Do not
          // collect new roles/blocks or change the already selected targets.
          verifiedTimes.push([target.number, current.timestampMs]);
        }
        validateTimes(verifiedTimes);
      };
      try {
        stage = "reference";
        if (await rpc("reference", "eth_chainId", [], decodeQuantity) !== BigInt(config.chainId)) return fail("chain_mismatch");
        const head = await rpc("reference", "eth_getBlockByNumber", ["latest", false], decodeBlock);
        const baseHeight = BigInt(head.number) - BigInt(request.confirmDepth);
        if (baseHeight < 0n) return fail("invalid_response");
        const base = request.confirmDepth === 0 ? head : await readBlock(baseHeight, "reference");
        if (base.timestampMs > head.timestampMs) return fail("invalid_response");
        blocks.set(base.number, base);
        remember(head.number, head.hash, "checked_head", head.timestampMs);
        remember(base.number, base.hash, "reference", base.timestampMs);
        const reference: FixedReference = Object.freeze({
          block: Object.freeze({ number: base.number, hash: base.hash, timestampMs: base.timestampMs }),
          checkedHead: Object.freeze({ number: head.number, hash: head.hash, timestampMs: head.timestampMs }),
          requiredConfirmDepth: request.confirmDepth, observedConfirmDepth: request.confirmDepth,
        });
        const historicalBlock = async (number: string): Promise<RpcBlock> => {
          check();
          const n = height(number);
          if (n > baseHeight) return fail("invalid_request");
          const cached = blocks.get(number);
          if (cached) {
            remember(number, cached.hash, "queried_header", cached.timestampMs);
            return cached;
          }
          const block = await readBlock(n);
          if (block.timestampMs > base.timestampMs) return fail("invalid_response");
          remember(number, block.hash, "queried_header", block.timestampMs);
          blocks.set(number, block);
          return block;
        };
        const markStateRead = (number: string): void => {
          const block = blocks.get(number);
          if (!block) return fail("invalid_request");
          remember(number, block.hash, "state_read", block.timestampMs);
        };
        const ethCall = <R>(rpcStage: ScamRpcDiagnostic["stage"], to: Address, data: string,
          decode: (value: unknown) => R, number = base.number): Promise<R> => {
          markStateRead(number);
          return rpc(rpcStage, "eth_call", [{ to, data }, quantity(height(number))], decode);
        };
        const verified = new Set<VerifiedPool>();
        const pools = new Map<number, Promise<VerifiedPool>>();
        const requirePool = (pool: VerifiedPool): void => {
          check();
          if (!verified.has(pool)) return fail("invalid_request");
        };
        const batch: ScamRpcBatch = Object.freeze({
          planId: request.planId, referenceGroupId: request.referenceGroupId, observedAt, reference,
          pool(index: number) {
            check();
            if (!integer(index) || index >= request.subjects.length) return Promise.reject(new ScamRpcError("invalid_request"));
            let task = pools.get(index);
            if (!task) {
              task = (async () => {
                const subject = request.subjects[index];
                const [token0, token1, factory] = await Promise.all([
                  ethCall("pool_identity", subject.pool, "0x0dfe1681", decodeAddressWord),
                  ethCall("pool_identity", subject.pool, "0xd21220a7", decodeAddressWord),
                  ethCall("pool_identity", subject.pool, "0xc45a0155", decodeAddressWord),
                ]);
                if (factory !== subject.factory || token0 === token1
                    || ![token0, token1].includes(subject.token) || ![token0, token1].includes(subject.quoteToken)) return fail("subject_mismatch");
                const pair = await ethCall("pool_identity", subject.factory,
                  `0xe6a43905${token0.slice(2).padStart(64, "0")}${token1.slice(2).padStart(64, "0")}`, decodeAddressWord);
                if (pair !== subject.pool) return fail("subject_mismatch");
                const pool = Object.freeze({ subject, token0, token1 });
                verified.add(pool);
                return pool;
              })().catch((error: unknown) => { throw diagnosticError(error, "pool_identity"); });
              pools.set(index, task);
            }
            return task;
          },
          block: historicalBlock,
          preflightHeaders(numbers: readonly string[]) {
            try {
              check();
              if (!Array.isArray(numbers) || numbers.length > config.limits.maxLogs + config.limits.maxRequests
                  || pending !== 0) return fail("invalid_request");
              const required = new Set<string>();
              for (const number of numbers) {
                if (height(number) > baseHeight) return fail("invalid_request");
                required.add(number);
              }
              const additional = [...required].filter((number) => !blocks.has(number)).length;
              enforcePreflight(selectFinalChecks(evidence, config.verification.history, base.number, required), additional);
            } catch (error) { throw diagnosticError(error, "preflight"); }
          },
          async reserves(pool: VerifiedPool, number = base.number) {
            requirePool(pool);
            await historicalBlock(number);
            return ethCall("reserves", pool.subject.pool, "0x0902f1ac", decodeReserves, number);
          },
          async decimals(pool: VerifiedPool, side: "token0" | "token1") {
            requirePool(pool);
            if (side !== "token0" && side !== "token1") return fail("invalid_request");
            return ethCall("decimals", pool[side], "0x313ce567", decodeDecimals);
          },
          async code(pool: VerifiedPool, number: string) {
            requirePool(pool);
            await historicalBlock(number);
            markStateRead(number);
            return rpc("code", "eth_getCode", [pool.subject.pool, quantity(height(number))], decodeCode);
          },
          async logs(pool: VerifiedPool, query: Parameters<ScamRpcBatch["logs"]>[1]) {
            requirePool(pool);
            if (!query || typeof query !== "object" || Array.isArray(query)
                || !Array.isArray(query.topics)) return fail("invalid_request");
            const { scope, fromBlock, toBlock } = query;
            const topics = [...query.topics];
            const from = height(fromBlock), to = height(toBlock);
            if (!["pair", "factory", "token"].includes(scope) || from > to || to > baseHeight
                || !topics.length || topics.length > 16 || !topics.every(hash)) return fail("invalid_request");
            const target = scope === "pair" ? pool.subject.pool : scope === "factory" ? pool.subject.factory : pool.subject.token;
            const step = BigInt(config.limits.maxBlocksPerQuery);
            const count = (to - from) / step + 1n;
            if (count > BigInt(config.limits.maxRequests)) return stop("resource_limit");
            const chunks: { from: bigint; to: bigint }[] = [];
            for (let start = from; start <= to; start += step) chunks.push({ from: start, to: start + step - 1n < to ? start + step - 1n : to });
            const logs: RpcLog[] = [], missing: RawLogRange[] = [];
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(config.limits.concurrency, chunks.length) }, async () => {
              while (next < chunks.length) {
                check();
                const chunk = chunks[next++];
                metrics.logChunks++;
                try {
                  const raw = await rpc("logs", "eth_getLogs", [{ address: target,
                    fromBlock: quantity(chunk.from), toBlock: quantity(chunk.to), topics: [topics] }]);
                  const decoded = decodeLogs(raw, target, chunk.from, chunk.to, topics, config.limits.maxLogs - logCount);
                  logCount += (raw as unknown[]).length;
                  for (const log of decoded) {
                    if (log.timestampMs !== undefined && log.timestampMs > base.timestampMs) return stop("invalid_response");
                    remember(log.blockNumber, log.blockHash, "log", log.timestampMs);
                    logBlocks.add(log.blockNumber);
                    if (log.timestampMs !== undefined) timestampedLogBlocks.add(log.blockNumber);
                  }
                  logs.push(...decoded);
                } catch (error) {
                  check();
                  const failure = errorOf(error);
                  if (failure.reason === "resource_limit") return stop("resource_limit");
                  if (failure.reason !== "rpc_error" && failure.reason !== "invalid_response") throw failure;
                  metrics.failedChunks++;
                  missing.push({ fromBlock: chunk.from.toString(), toBlock: chunk.to.toString(), reason: failure.reason });
                }
              }
            }));
            logs.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1
              : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
            missing.sort((a, b) => BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : 1);
            validateTimes(collectedTimes());
            return { logs, missing };
          },
        });
        let collecting = true;
        let operations = 0;
        const track = <R>(work: () => Promise<R>): Promise<R> => {
          try {
            check();
            if (!collecting) return fail("invalid_request");
            // Invoke synchronously so method arguments are owned before I/O.
            operations++;
            let result: Promise<R>;
            try { result = work(); } catch (error) { operations--; throw error; }
            return result.finally(() => { operations--; });
          } catch (error) { return Promise.reject(errorOf(error)); }
        };
        const scoped: ScamRpcBatch = Object.freeze({
          planId: batch.planId, referenceGroupId: batch.referenceGroupId, observedAt, reference,
          pool: (index: number) => track(() => batch.pool(index)),
          block: (number: string) => track(() => batch.block(number)),
          preflightHeaders: (numbers: readonly string[]) => {
            check();
            if (!collecting || operations !== 0) return fail("invalid_request");
            batch.preflightHeaders(numbers);
          },
          reserves: (pool: VerifiedPool, number?: string) => track(() => batch.reserves(pool, number)),
          decimals: (pool: VerifiedPool, side: "token0" | "token1") => track(() => batch.decimals(pool, side)),
          code: (pool: VerifiedPool, number: string) => track(() => batch.code(pool, number)),
          logs: (pool: VerifiedPool, query: Parameters<ScamRpcBatch["logs"]>[1]) => track(() => batch.logs(pool, query)),
        });
        stage = "collect";
        const value = await abortable(Promise.resolve().then(() => collect(scoped)));
        collecting = false;
        check();
        if (operations !== 0 || pending !== 0) return fail("invalid_request");
        // Recompute after every method/target has collected its evidence. The
        // immutable list used for this last budget check is executed unchanged.
        const finalChecks = selectFinalChecks(evidence, config.verification.history, base.number);
        stage = "preflight";
        enforcePreflight(finalChecks, 0);
        stage = "final_recheck";
        await verifyFinalChecks(finalChecks);
        check();
        const verifiedAt = now();
        if (verifiedAt < observedAt || verifiedAt >= request.deadlineMs) return fail("timeout");
        check();
        return { value, reference, observedAt, verification: config.verification, verifiedAt,
          metrics: Object.freeze({ ...metrics, durationMs: verifiedAt - observedAt }) };
      } catch (error) {
        try { check(); } catch (current) {
          // A deadline/cancel/global stop still wins. Preserve context only
          // when it is the same failure, never attach a prior HTTP error.
          if (current !== error && !(current instanceof ScamRpcError && error instanceof ScamRpcError
              && (current.reason === "timeout" || current.reason === "aborted") && current.reason === error.reason)) throw current;
        }
        throw diagnosticError(error, stage);
      } finally {
        closed = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        controller.abort();
      }
      };
      try {
        if (typeof input?.onMetrics === "function") notify = input.onMetrics;
        const result = await run();
        publish("success", undefined, result.metrics);
        return result;
      } catch (error) {
        const failure = diagnosticError(error, stage);
        publish("failed", failure);
        throw failure;
      }
    },
  });
}
