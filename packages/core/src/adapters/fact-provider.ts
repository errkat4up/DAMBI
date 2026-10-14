import type { Clock } from "../ports/clock.js";
import type { FactProvider, FactResult } from "../ports/fact.js";
import type { CallOptions } from "../types/options.js";
import type { PlannedCall } from "../types/plan.js";
import { AdapterError } from "./errors.js";
import {
  balanceOfRequest, blockNumberRequest, chainIdRequest, decodeBalance,
  decodeQuantity, parseEip155ChainId, readRpcResult, resolveBalanceCall,
  type BalanceCall, type RpcRequest,
} from "./evm-rpc.js";
import { assertNotAborted, callSignal, fetchText } from "./http.js";

export interface EvmRpcEndpoint {
  /** HTTPS endpoint (path/query allowed), or loopback HTTP for development. */
  readonly rpcUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EvmFactProviderOptions {
  /** Only explicitly registered, canonical EIP-155 chains can be queried. */
  readonly chains: Readonly<Record<string, EvmRpcEndpoint>>;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Use the same Unix-millisecond clock as Core when overriding it. */
  readonly clock?: Clock;
}

interface Endpoint {
  readonly url: string;
  readonly chainNumber: bigint;
  readonly headers: Headers;
}

interface Config {
  readonly endpoints: ReadonlyMap<string, Endpoint>;
  readonly supportedChains: ReadonlySet<string>;
  readonly maxBytes: number;
  readonly fetcher: typeof globalThis.fetch;
  readonly now: () => number;
}

interface ResolvedCall {
  readonly callId: string;
  readonly balance: BalanceCall;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownConfig(options: EvmFactProviderOptions): Config {
  try {
    if (!record(options)) throw new Error();
    const { chains, maxResponseBytes, fetch: injected, clock } = options;
    if (!record(chains) || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error();
    const endpoints = new Map<string, Endpoint>();
    for (const [chain, supplied] of Object.entries(chains)) {
      const chainNumber = parseEip155ChainId(chain);
      if (chainNumber === undefined || !record(supplied)) throw new Error();
      const { rpcUrl, headers: suppliedHeaders } = supplied;
      // Do not let URL normalization hide whitespace, backslashes or userinfo.
      if (typeof rpcUrl !== "string" || !/^https?:\/\/[^/?#\s@\\]+(?:[/?][^\s\\#]*)?$/i.test(rpcUrl)
          || /[\s\\#]/.test(rpcUrl)) throw new Error();
      const url = new URL(rpcUrl);
      const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
        || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
          || url.username || url.password || url.hash) throw new Error();
      const headers = new Headers();
      if (suppliedHeaders !== undefined) {
        if (!record(suppliedHeaders)) throw new Error();
        for (const [name, value] of Object.entries(suppliedHeaders)) {
          if (typeof value !== "string") throw new Error();
          headers.set(name, value);
        }
      }
      for (const name of ["host", "content-length", "transfer-encoding", "connection", "cookie",
        "if-none-match", "if-modified-since"]) {
        if (headers.has(name)) throw new Error();
      }
      headers.set("accept", "application/json");
      headers.set("content-type", "application/json");
      endpoints.set(chain, { url: url.href, chainNumber, headers });
    }
    if (endpoints.size === 0) throw new Error();
    const fetcher = injected === undefined ? globalThis.fetch.bind(globalThis) : injected;
    if (typeof fetcher !== "function") throw new Error();
    if (clock !== undefined && !record(clock)) throw new Error();
    const nowMethod = clock === undefined ? Date.now : clock.now;
    if (typeof nowMethod !== "function") throw new Error();
    const now = nowMethod.bind(clock);
    return { endpoints, supportedChains: new Set(endpoints.keys()), maxBytes: maxResponseBytes, fetcher, now };
  } catch {
    throw new AdapterError("INVALID_CONFIG", "EVM Fact provider configuration is invalid.");
  }
}

function ownBatch(calls: readonly PlannedCall[], options: CallOptions & { readonly planId: string }, config: Config): {
  planId: string;
  calls: ResolvedCall[];
} {
  try {
    if (!Array.isArray(calls) || !record(options)) throw new Error();
    const { planId } = options;
    if (typeof planId !== "string" || planId.length === 0) throw new Error();
    const ids = new Set<string>();
    const resolved: ResolvedCall[] = [];
    for (const call of calls) {
      if (!record(call)) throw new Error();
      const callId = call.callId;
      if (typeof callId !== "string" || callId.length === 0 || ids.has(callId)) throw new Error();
      ids.add(callId);
      // Params are method-specific. Invalid/unsupported individual requests do
      // not invalidate siblings, but even those calls must have unique IDs.
      let balance: BalanceCall | undefined;
      try { balance = resolveBalanceCall(call.method, call.params, config.supportedChains); }
      catch { continue; }
      if (balance) resolved.push({ callId, balance });
    }
    return { planId, calls: resolved };
  } catch {
    throw new AdapterError("INVALID_REQUEST", "Fact calls require a plan ID and unique nonempty call IDs.");
  }
}

function observationTime(config: Config): number {
  try {
    const value = config.now();
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } catch { /* Host clock errors must not expose arbitrary exception contents. */ }
  throw new AdapterError("INVALID_CONFIG", "The Fact clock must return nonnegative safe-integer Unix milliseconds.");
}

async function rpc(config: Config, endpoint: Endpoint, request: RpcRequest, signal: AbortSignal): Promise<unknown> {
  const response = await fetchText(config.fetcher, endpoint.url, {
    method: "POST",
    headers: new Headers(endpoint.headers),
    body: JSON.stringify(request),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  }, config.maxBytes, signal);
  assertNotAborted(signal);
  if (response.status !== 200) throw new AdapterError("HTTP_ERROR", "The RPC endpoint returned an unsuccessful HTTP status.", response.status);
  return readRpcResult(response.text, request.id);
}

/** Each worker owns at most one HTTP operation, including its body reader. */
async function bounded<T>(items: readonly T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    for (;;) {
      assertNotAborted(signal);
      if (next === items.length) return;
      const item = items[next++];
      await work(item);
    }
  }));
}

function unavailableError(error: unknown): AdapterError {
  return error instanceof AdapterError ? error
    : new AdapterError("INVALID_RESPONSE", "The RPC endpoint could not prepare the requested chain.");
}

/** ERC-20 balances only. Core owns projections, optionality and Fact caching. */
export function createEvmFactProvider(options: EvmFactProviderOptions): FactProvider {
  const config = ownConfig(options);
  let fetchSequence = 0n;
  return Object.freeze({
    async fetch(calls: readonly PlannedCall[], options: CallOptions & { readonly planId: string }) {
      // Copy all binding and method inputs synchronously, before any I/O.
      const batch = ownBatch(calls, options, config);
      const externalSignal = callSignal(options);
      assertNotAborted(externalSignal);
      const controller = new AbortController();
      const signal = controller.signal;
      const abort = (): void => controller.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      const fetchId = (++fetchSequence).toString(36);
      let requestSequence = 0n;
      const requestId = (): string => `${fetchId}:${++requestSequence}`;
      const results: Record<string, FactResult> = Object.create(null) as Record<string, FactResult>;
      let unavailable = 0;
      let firstFailure: AdapterError | undefined;
      const fail = (error: unknown, count: number): void => {
        unavailable += count;
        firstFailure ??= unavailableError(error);
      };
      try {
        assertNotAborted(externalSignal);
        const groups = new Map<string, ResolvedCall[]>();
        for (const call of batch.calls) {
          const group = groups.get(call.balance.chainId) ?? [];
          group.push(call);
          groups.set(call.balance.chainId, group);
        }
        const blocks = new Map<string, bigint>();
        // Preparation and calls use consecutive pools, so the limit of four
        // includes chain checks/block reads even when many chains are configured.
        await bounded([...groups], signal, async ([chain, group]) => {
          const endpoint = config.endpoints.get(chain)!;
          try {
            const actualChain = decodeQuantity(await rpc(config, endpoint, chainIdRequest(requestId()), signal));
            if (actualChain !== endpoint.chainNumber) {
              throw new AdapterError("INVALID_RESPONSE", "The RPC endpoint returned a different chain ID.");
            }
            const block = decodeQuantity(await rpc(config, endpoint, blockNumberRequest(requestId()), signal));
            assertNotAborted(signal);
            blocks.set(chain, block);
          } catch (error) {
            assertNotAborted(signal);
            fail(error, group.length);
          }
        });
        await bounded(batch.calls.filter((call) => blocks.has(call.balance.chainId)), signal, async (call) => {
          const { chainId } = call.balance;
          const block = blocks.get(chainId)!;
          // Capture after queue admission, before eth_call starts. A bad host
          // clock fails the whole fetch, rather than masquerading as missing data.
          const observedAt = observationTime(config);
          try {
            const value = decodeBalance(await rpc(config, config.endpoints.get(chainId)!,
              balanceOfRequest(requestId(), call.balance, block), signal));
            assertNotAborted(signal);
            results[call.callId] = { value, observedAt, blockNumber: block.toString(10), source: `onchain:${chainId}:eth_call` };
          } catch (error) {
            assertNotAborted(signal);
            if (error instanceof AdapterError && (error.code === "NETWORK_ERROR" || error.code === "HTTP_ERROR")) fail(error, 1);
            // Reverts or malformed individual results remain absent; never zero.
          }
        });
        assertNotAborted(signal);
        if (batch.calls.length > 0 && unavailable === batch.calls.length) throw firstFailure!;
        return { planId: batch.planId, results };
      } finally {
        externalSignal?.removeEventListener("abort", abort);
        // On a global error, also stop sibling workers and in-flight I/O. This
        // controller belongs to this fetch alone, never another Core's request.
        controller.abort();
      }
    },
  });
}
