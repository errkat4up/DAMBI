/** Internal raw RPC boundary. No Fact projection, normalization or algorithm.
 * A future scam provider shares one batch across history/profile and publishes
 * its result only after the reference and every evidence block are rechecked.
 */
import type { Clock } from "../ports/clock.js";
import type { Address, FixedReference, Subject } from "../types/scam.js";
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
  readonly retryDelayMs: number;
}
export interface ScamRpcOptions {
  readonly chainId: number;
  readonly endpoint: EvmRpcEndpoint;
  readonly factories: readonly Address[];
  readonly quoteTokens: readonly Address[];
  readonly limits: ScamRpcLimits;
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
  readonly reference: FixedReference;
  /** Index in the request's copied subjects. Nothing is inferred from symbols. */
  pool(index: number): Promise<VerifiedPool>;
  block(number: string): Promise<RpcBlock>;
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
export interface ScamRpcMetrics {
  readonly requests: number;
  readonly retries: number;
  readonly receivedBytes: number;
  readonly logChunks: number;
  readonly failedChunks: number;
  readonly durationMs: number;
}

const fail = (reason: ScamRpcFailure): never => { throw new ScamRpcError(reason); };
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

function ownOptions(supplied: ScamRpcOptions) {
  try {
    const { chainId, endpoint, factories, quoteTokens, fetch: injected, clock } = supplied;
    const limits = { ...supplied.limits };
    if (!integer(chainId, 1) || !endpoint || !Array.isArray(factories) || !factories.length
        || !Array.isArray(quoteTokens) || !quoteTokens.length
        || !factories.every(address) || !quoteTokens.every(address)) throw new Error();
    for (const key of ["maxRequests", "maxResponseBytes", "maxTotalResponseBytes", "maxLogs", "maxBlocksPerQuery", "concurrency"] as const) {
      if (!integer(limits[key], 1)) throw new Error();
    }
    if (!integer(limits.maxRetries) || !integer(limits.retryDelayMs) || limits.concurrency > 16
        || limits.maxRequests > 10_000 || limits.maxRetries > 10 || limits.retryDelayMs > 60_000) throw new Error();
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
    return { chainId, url: url.href, headers, fetcher, now, limits,
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
  return Object.freeze({
    async withBatch<T>(input: ScamRpcRequest, collect: (batch: ScamRpcBatch) => Promise<T>): Promise<{
      readonly value: T; readonly reference: FixedReference; readonly observedAt: number; readonly metrics: ScamRpcMetrics;
    }> {
      const request = ownRequest(input, config);
      if (typeof collect !== "function") return fail("invalid_request");
      const now = (): number => {
        try { const value = config.now(); if (integer(value)) return value; } catch { /* sanitized below */ }
        return fail("invalid_config");
      };
      const observedAt = now();
      const controller = new AbortController();
      let timedOut = false;
      let closed = false;
      let terminalFailure: ScamRpcError | undefined;
      const stop = (reason: "resource_limit" | "reorg"): never => {
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
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
      const metrics = { requests: 0, retries: 0, receivedBytes: 0, logChunks: 0, failedChunks: 0 };
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
      const delay = async (): Promise<void> => {
        let id: ReturnType<typeof setTimeout> | undefined;
        try { await abortable(new Promise<void>((resolve) => { id = setTimeout(resolve, config.limits.retryDelayMs); })); }
        finally { clearTimeout(id); }
        check();
      };
      const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
        pending++;
        let admitted = false;
        let wake: (() => void) | undefined;
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
            metrics.requests++;
            const id = `scam:${++sequence}`;
            try {
              const response = await fetchText(config.fetcher, config.url, {
                method: "POST", headers: new Headers(config.headers),
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                redirect: "error", credentials: "omit", cache: "no-store",
              }, config.limits.maxResponseBytes, controller.signal);
              check();
              if (response.status !== 200) return fail("rpc_error");
              metrics.receivedBytes += new TextEncoder().encode(response.text).byteLength;
              if (metrics.receivedBytes > config.limits.maxTotalResponseBytes) return stop("resource_limit");
              return readRpcResult(response.text, id);
            } catch (error) {
              check();
              const retry = error instanceof AdapterError && (error.code === "NETWORK_ERROR"
                || (error.code === "HTTP_ERROR" && [429, 502, 503, 504].includes(error.status ?? 0)))
                || error instanceof RpcResponseError && error.rpcCode === -32005;
              if (!retry || attempt >= config.limits.maxRetries) {
                const failure = errorOf(error);
                if (failure.reason === "resource_limit") return stop("resource_limit");
                throw failure;
              }
              metrics.retries++;
              await delay();
            }
          }
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
      const evidence = new Map<string, string>();
      const blocks = new Map<string, RpcBlock>();
      const remember = (number: string, blockHash: string): void => {
        if (evidence.has(number) && evidence.get(number) !== blockHash) return stop("reorg");
        evidence.set(number, blockHash);
      };
      const readBlock = async (number: bigint): Promise<RpcBlock> =>
        decodeBlock(await rpc("eth_getBlockByNumber", [quantity(number), false]), number);
      try {
        if (decodeQuantity(await rpc("eth_chainId", [])) !== BigInt(config.chainId)) return fail("chain_mismatch");
        const head = decodeBlock(await rpc("eth_getBlockByNumber", ["latest", false]));
        const baseHeight = BigInt(head.number) - BigInt(request.confirmDepth);
        if (baseHeight < 0n) return fail("invalid_response");
        const base = request.confirmDepth === 0 ? head : await readBlock(baseHeight);
        if (base.timestampMs > head.timestampMs) return fail("invalid_response");
        blocks.set(base.number, base);
        remember(head.number, head.hash);
        remember(base.number, base.hash);
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
          if (cached) return cached;
          const block = await readBlock(n);
          if (block.timestampMs > base.timestampMs) return fail("invalid_response");
          remember(number, block.hash);
          blocks.set(number, block);
          return block;
        };
        const ethCall = (to: Address, data: string, number = base.number): Promise<unknown> =>
          rpc("eth_call", [{ to, data }, quantity(height(number))]);
        const verified = new Set<VerifiedPool>();
        const pools = new Map<number, Promise<VerifiedPool>>();
        const requirePool = (pool: VerifiedPool): void => {
          check();
          if (!verified.has(pool)) return fail("invalid_request");
        };
        const batch: ScamRpcBatch = Object.freeze({
          planId: request.planId, referenceGroupId: request.referenceGroupId, reference,
          pool(index: number) {
            check();
            if (!integer(index) || index >= request.subjects.length) return Promise.reject(new ScamRpcError("invalid_request"));
            let task = pools.get(index);
            if (!task) {
              task = (async () => {
                const subject = request.subjects[index];
                const [token0, token1, factory] = await Promise.all([
                  ethCall(subject.pool, "0x0dfe1681").then(decodeAddressWord),
                  ethCall(subject.pool, "0xd21220a7").then(decodeAddressWord),
                  ethCall(subject.pool, "0xc45a0155").then(decodeAddressWord),
                ]);
                if (factory !== subject.factory || token0 === token1
                    || ![token0, token1].includes(subject.token) || ![token0, token1].includes(subject.quoteToken)) return fail("subject_mismatch");
                const pair = decodeAddressWord(await ethCall(subject.factory,
                  `0xe6a43905${token0.slice(2).padStart(64, "0")}${token1.slice(2).padStart(64, "0")}`));
                if (pair !== subject.pool) return fail("subject_mismatch");
                const pool = Object.freeze({ subject, token0, token1 });
                verified.add(pool);
                return pool;
              })();
              pools.set(index, task);
            }
            return task;
          },
          block: historicalBlock,
          async reserves(pool: VerifiedPool, number = base.number) {
            requirePool(pool);
            await historicalBlock(number);
            return decodeReserves(await ethCall(pool.subject.pool, "0x0902f1ac", number));
          },
          async decimals(pool: VerifiedPool, side: "token0" | "token1") {
            requirePool(pool);
            if (side !== "token0" && side !== "token1") return fail("invalid_request");
            return decodeDecimals(await ethCall(pool[side], "0x313ce567"));
          },
          async code(pool: VerifiedPool, number: string) {
            requirePool(pool);
            await historicalBlock(number);
            return decodeCode(await rpc("eth_getCode", [pool.subject.pool, quantity(height(number))]));
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
                  const raw = await rpc("eth_getLogs", [{ address: target,
                    fromBlock: quantity(chunk.from), toBlock: quantity(chunk.to), topics: [topics] }]);
                  const decoded = decodeLogs(raw, target, chunk.from, chunk.to, topics, config.limits.maxLogs - logCount);
                  logCount += (raw as unknown[]).length;
                  for (const log of decoded) remember(log.blockNumber, log.blockHash);
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
          planId: batch.planId, referenceGroupId: batch.referenceGroupId, reference,
          pool: (index: number) => track(() => batch.pool(index)),
          block: (number: string) => track(() => batch.block(number)),
          reserves: (pool: VerifiedPool, number?: string) => track(() => batch.reserves(pool, number)),
          decimals: (pool: VerifiedPool, side: "token0" | "token1") => track(() => batch.decimals(pool, side)),
          code: (pool: VerifiedPool, number: string) => track(() => batch.code(pool, number)),
          logs: (pool: VerifiedPool, query: Parameters<ScamRpcBatch["logs"]>[1]) => track(() => batch.logs(pool, query)),
        });
        const value = await abortable(Promise.resolve().then(() => collect(scoped)));
        collecting = false;
        check();
        if (operations !== 0 || pending !== 0) return fail("invalid_request");
        // Recheck exact heights: a reorg discards the whole draft, never mixes
        // replacement logs with the old reference or returns a stale success.
        const finalEvidence = [...evidence].filter(([number]) => number !== base.number);
        finalEvidence.push([base.number, base.hash]);
        for (const [number, blockHash] of finalEvidence) {
          if ((await readBlock(BigInt(number))).hash !== blockHash) return stop("reorg");
        }
        check();
        return { value, reference, observedAt, metrics: { ...metrics, durationMs: Math.max(0, now() - observedAt) } };
      } catch (error) {
        check();
        throw errorOf(error);
      } finally {
        closed = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
}
