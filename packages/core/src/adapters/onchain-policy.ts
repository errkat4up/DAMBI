import type { PolicySource, SignedPolicyBundle } from "../ports/policy.js";
import type { CallOptions } from "../types/options.js";
import { AdapterError, type AdapterErrorCode } from "./errors.js";
import { decodeQuantity, parseEip155ChainId, readRpcResult, RpcResponseError } from "./evm-rpc.js";
import { assertNotAborted, callSignal, fetchText } from "./http.js";

export interface OnchainPolicySourceOptions {
  readonly rpcUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Registry chain, not the transaction/Fact chain. */
  readonly chainId: string;
  readonly registryAddress: string;
  /** Exact deployed runtime bytes, pinned independently of the RPC response. */
  readonly expectedRuntimeCode: string;
  readonly env: "staging" | "production";
  readonly profile: "default";
  /** No implicit default and no latest fallback. */
  readonly finality: "safe" | "finalized";
  readonly maxResponseBytes: number;
  /** Whole refresh budget, including all headers and state reads. No retries. */
  readonly timeoutMs: number;
  readonly maxBlockAgeMs: number;
  readonly maxStateAgeMs: number;
  readonly refreshIntervalMs: number;
  readonly allowedClockSkewMs: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: { now(): number };
}

export interface OnchainPolicySource extends PolicySource {
  /** Scheduling hint only. It neither installs nor authorizes cached policies. */
  refreshDue(): boolean;
}

const fail = (code: AdapterErrorCode): never => {
  throw new AdapterError(code, `Onchain policy source: ${code}.`);
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value);
const lowercaseHex = (value: string): `0x${string}` => `0x${value.slice(2).toLowerCase()}`;
const word = (value: number | bigint): string => BigInt(value).toString(16).padStart(64, "0");
const bytesHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = new TextEncoder();

// Keccak-256, not FIPS SHA3-256. Internal export permits independent codec vectors;
// it is deliberately not exported from the public adapters entry point.
const MASK = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
export function keccak256(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / 136) * 136);
  padded.set(input);
  padded[input.length] = 1;
  padded[padded.length - 1] |= 128;
  const state = Array<bigint>(25).fill(0n);
  const rotate = (value: bigint, shift: number): bigint => shift === 0 ? value
    : ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK;
  for (let offset = 0; offset < padded.length; offset += 136) {
    for (let i = 0; i < 136; i++) state[Math.floor(i / 8)] ^= BigInt(padded[offset + i]) << BigInt(8 * (i % 8));
    for (const constant of RC) {
      const columns = Array<bigint>(5).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) columns[x] ^= state[x + 5 * y];
      for (let x = 0; x < 5; x++) {
        const delta = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1);
        for (let y = 0; y < 5; y++) state[x + 5 * y] ^= delta;
      }
      const moved = Array<bigint>(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], ROT[x + 5 * y]);
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = moved[x + 5 * y]
          ^ ((~moved[(x + 1) % 5 + 5 * y]) & moved[(x + 2) % 5 + 5 * y]);
      }
      state[0] ^= constant;
    }
  }
  return `0x${bytesHex(Uint8Array.from({ length: 32 }, (_, i) => Number((state[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 255n)))}`;
}
const selector = (signature: string): string => keccak256(utf8.encode(signature)).slice(2, 10);
const SCOPE_SELECTOR = selector("scopeId(string,string)");
const READ_SELECTOR = selector("read(bytes32,uint256)");
function dynamic(bytes: Uint8Array): string {
  return word(bytes.length) + bytesHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, "0");
}
function scopeCall(env: string, profile: string): string {
  const first = dynamic(utf8.encode(env));
  return `0x${SCOPE_SELECTOR}${word(64)}${word(64 + first.length / 2)}${first}${dynamic(utf8.encode(profile))}`;
}

interface RegistryRead {
  readonly sequence: number;
  readonly status: "active" | "revoked";
  readonly digest: `0x${string}`;
  readonly payload: string;
  readonly signature: string;
  readonly keyId: string;
}
function decodeRead(value: unknown): RegistryRead {
  if (!hex(value) || value.length < 2 + 6 * 64 || (value.length - 2) % 64 !== 0) return fail("INVALID_RESPONSE");
  const data = value.slice(2);
  function uint(offset: number): bigint {
    if (offset < 0 || offset + 32 > data.length / 2) return fail("INVALID_RESPONSE");
    return BigInt(`0x${data.slice(offset * 2, (offset + 32) * 2)}`);
  }
  function safe(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail("INVALID_RESPONSE");
    return Number(value);
  }
  const sequence = safe(uint(0));
  const status = safe(uint(32));
  // Require canonical contiguous ABI tails. Reject aliasing, gaps, overlapping
  // offsets, nonzero padding, truncation and trailing bytes.
  let cursor = 192;
  function tail(index: number): Uint8Array {
    if (uint(index * 32) !== BigInt(cursor)) return fail("INVALID_RESPONSE");
    const length = safe(uint(cursor));
    const start = cursor + 32;
    if (length > data.length / 2 - start) return fail("INVALID_RESPONSE");
    const end = start + length;
    cursor = start + Math.ceil(length / 32) * 32;
    if (cursor > data.length / 2 || /[^0]/.test(data.slice(end * 2, cursor * 2))) return fail("INVALID_RESPONSE");
    const encoded = data.slice(start * 2, end * 2);
    return Uint8Array.from({ length }, (_, i) => parseInt(encoded.slice(i * 2, i * 2 + 2), 16));
  }
  const payloadBytes = tail(3);
  const signatureBytes = tail(4);
  const keyBytes = tail(5);
  if (cursor !== data.length / 2 || status > 3) return fail("INVALID_RESPONSE");
  if (status === 0) return fail("POLICY_MISSING");
  // read(scope, 0) must describe the current head, never a superseded entry.
  if (status === 2 || sequence === 0) return fail("INVALID_RESPONSE");
  let payload: string;
  let keyId: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    payload = decoder.decode(payloadBytes);
    keyId = decoder.decode(keyBytes);
  } catch { return fail("INVALID_RESPONSE"); }
  // P-256/P1363 is the Core wire signature. Do not parse/re-serialize payload.
  if (signatureBytes.length !== 64 || payloadBytes.length === 0) return fail("INVALID_RESPONSE");
  let binary = "";
  for (const byte of signatureBytes) binary += String.fromCharCode(byte);
  return {
    sequence, status: status === 1 ? "active" : "revoked",
    digest: `0x${data.slice(128, 192).toLowerCase()}`,
    payload, signature: btoa(binary), keyId,
  };
}

interface Block {
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly timestamp: number;
}
function block(value: unknown): Block {
  if (!record(value) || !hash(value.hash)) return fail("INVALID_RESPONSE");
  const number = decodeQuantity(value.number);
  const timestamp = decodeQuantity(value.timestamp);
  if (number > BigInt(Number.MAX_SAFE_INTEGER)
      || timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return fail("INVALID_RESPONSE");
  return { number, hash: lowercaseHex(value.hash), timestamp: Number(timestamp) };
}
function sameBlock(a: Block, b: Block): boolean {
  return a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;
}
function configure(input: OnchainPolicySourceOptions) {
  try {
    if (!record(input)) throw new Error();
    const options = { ...input };
    const chainNumber = parseEip155ChainId(options.chainId);
    if (chainNumber === undefined || chainNumber < 1n || chainNumber > BigInt(Number.MAX_SAFE_INTEGER)
        || typeof options.registryAddress !== "string" || !/^0x[0-9a-fA-F]{40}(?![\s\S])/.test(options.registryAddress)
        || /^0x0{40}$/.test(options.registryAddress) || !hex(options.expectedRuntimeCode)
        || options.expectedRuntimeCode === "0x"
        || !["staging", "production"].includes(options.env) || options.profile !== "default"
        || !["safe", "finalized"].includes(options.finality)) throw new Error();
    for (const value of [options.maxResponseBytes, options.timeoutMs, options.maxBlockAgeMs,
      options.maxStateAgeMs, options.refreshIntervalMs]) if (!integer(value, 1)) throw new Error();
    if (!integer(options.allowedClockSkewMs) || options.timeoutMs > 60_000
        || options.refreshIntervalMs > options.maxStateAgeMs
        || options.refreshIntervalMs > options.maxBlockAgeMs) throw new Error();
    if (typeof options.rpcUrl !== "string"
        || !/^https?:\/\/[^/?#\s@\\]+(?:[/?][^\s\\#]*)?$/i.test(options.rpcUrl)
        || /[\s\\#]/.test(options.rpcUrl)) throw new Error();
    const url = new URL(options.rpcUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
        || url.username || url.password || url.hash) throw new Error();
    const headers = new Headers();
    if (options.headers !== undefined) {
      if (!record(options.headers)) throw new Error();
      for (const [name, value] of Object.entries(options.headers)) {
        if (typeof value !== "string") throw new Error();
        headers.set(name, value);
      }
    }
    for (const name of ["host", "content-length", "transfer-encoding", "connection", "cookie",
      "if-none-match", "if-modified-since"]) if (headers.has(name)) throw new Error();
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const nowMethod = options.clock === undefined ? Date.now : options.clock.now;
    if (typeof fetcher !== "function" || typeof nowMethod !== "function") throw new Error();
    return {
      ...options, rpcUrl: url.href, chainNumber, headers, fetcher,
      registryAddress: lowercaseHex(options.registryAddress),
      expectedRuntimeCode: options.expectedRuntimeCode.toLowerCase(),
      now: nowMethod.bind(options.clock),
    };
  } catch { return fail("INVALID_CONFIG"); }
}

/**
 * F4 transport: scopeId(string,string), then read(bytes32,0), at one canonical
 * EIP-1898 block hash. The tuple contains both state and body; there is no second
 * unpinned body lookup. RPC finality is trusted, not independently proven.
 *
 * Every fetch performs I/O. The one-entry memory cache only retains immutable
 * same-block identity/first-observation time; it is never an outage fallback.
 * Core remains responsible for P-256, signed scope, expiry, versions and plans.
 */
export function createOnchainPolicySource(options: OnchainPolicySourceOptions): OnchainPolicySource {
  const config = configure(options);
  let generation = 0n;
  let accepted: { block: Block; read: RegistryRead; observedAtMs: number; expiresAtMs: number; checkedAtMs: number } | undefined;
  function now(): number {
    let value: unknown;
    try { value = config.now(); } catch { return fail("INVALID_CONFIG"); }
    return integer(value) ? value : fail("INVALID_CONFIG");
  }
  return Object.freeze({
    refreshDue(): boolean {
      const time = now();
      return !accepted || time < accepted.checkedAtMs || time >= accepted.expiresAtMs
        || time - accepted.checkedAtMs >= config.refreshIntervalMs;
    },
    async fetch(options?: CallOptions): Promise<SignedPolicyBundle> {
      // Even a subsequently cancelled request is a cache-publication barrier.
      const requestGeneration = ++generation;
      const previous = accepted;
      const external = callSignal(options);
      assertNotAborted(external);
      const started = now();
      const controller = new AbortController();
      let timedOut = false;
      const abort = (): void => controller.abort();
      external?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
      let requestId = 0;
      async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
        assertNotAborted(external);
        assertNotAborted(controller.signal);
        const id = `${requestGeneration}:${++requestId}`;
        const response = await fetchText(config.fetcher, config.rpcUrl, {
          method: "POST", headers: new Headers(config.headers),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          redirect: "error", credentials: "omit", cache: "no-store",
        }, config.maxResponseBytes, controller.signal);
        assertNotAborted(controller.signal);
        if (response.status !== 200) return fail("HTTP_ERROR");
        try { return readRpcResult(response.text, id); }
        catch (error) {
          if (error instanceof RpcResponseError) {
            return fail(error.rpcCode === -32601 || error.rpcCode === -32602 ? "RPC_UNSUPPORTED" : "RPC_ERROR");
          }
          throw error;
        }
      }
      async function checkChain(): Promise<void> {
        if (decodeQuantity(await rpc("eth_chainId", [])) !== config.chainNumber) return fail("CHAIN_MISMATCH");
      }
      try {
        await checkChain();
        const reference = block(await rpc("eth_getBlockByNumber", [config.finality, false]));
        const blockDeadline = reference.timestamp * 1000 + config.maxBlockAgeMs;
        if (!Number.isSafeInteger(blockDeadline)) return fail("INVALID_RESPONSE");
        if (reference.timestamp * 1000 - started > config.allowedClockSkewMs || started >= blockDeadline) return fail("STATE_EXPIRED");
        if (previous && (reference.number < previous.block.number
            || reference.number === previous.block.number && !sameBlock(reference, previous.block)
            || reference.number > previous.block.number && reference.timestamp < previous.block.timestamp)) return fail("REORG");
        const selector = { blockHash: reference.hash, requireCanonical: true };
        const code = await rpc("eth_getCode", [config.registryAddress, selector]);
        if (!hex(code) || code.toLowerCase() !== config.expectedRuntimeCode) return fail("REGISTRY_MISMATCH");
        const call = (data: string): Promise<unknown> => rpc("eth_call", [{ to: config.registryAddress, data }, selector]);
        const scope = await call(scopeCall(config.env, config.profile));
        if (!hash(scope)) return fail("INVALID_RESPONSE");
        const read = decodeRead(await call(`0x${READ_SELECTOR}${scope.slice(2)}${word(0)}`));
        const rechecked = block(await rpc("eth_getBlockByNumber", [`0x${reference.number.toString(16)}`, false]));
        if (!sameBlock(reference, rechecked)) return fail("REORG");
        await checkChain();
        const finished = now();
        if (finished < started) return fail("STATE_EXPIRED");
        const repeated = previous && sameBlock(previous.block, reference);
        if (repeated && JSON.stringify(previous.read) !== JSON.stringify(read)) return fail("REORG");
        const observedAtMs = repeated ? previous.observedAtMs : started;
        const observationDeadline = observedAtMs + config.maxStateAgeMs;
        if (!Number.isSafeInteger(observationDeadline)) return fail("INVALID_CONFIG");
        const expiresAtMs = Math.min(blockDeadline, observationDeadline);
        if (finished >= expiresAtMs) return fail("STATE_EXPIRED");
        assertNotAborted(external);
        assertNotAborted(controller.signal);
        // F1 RegistryObservation wire shape. BigInt values have been range
        // checked before conversion. Forward the same read tuple's SHA-256
        // digest with its original UTF-8 payload; Core verifies their binding.
        // Keep seconds for blockTimestamp and Unix milliseconds for observedAtMs;
        // neither clock is replaced with the latest refresh time.
        const registryState = {
          chainId: Number(config.chainNumber), registryAddress: config.registryAddress,
          env: config.env, profile: config.profile, version: read.sequence, status: read.status,
          payloadDigest: read.digest, finality: config.finality,
          blockNumber: Number(reference.number), blockHash: reference.hash,
          blockTimestamp: reference.timestamp, observedAtMs,
        };
        const result = { payload: read.payload, signature: read.signature, keyId: read.keyId, registryState };
        if (requestGeneration === generation) {
          accepted = { block: reference, read, observedAtMs, expiresAtMs, checkedAtMs: finished };
        }
        return result;
      } catch (error) {
        if (external?.aborted) return fail("ABORTED");
        if (timedOut) return fail("TIMEOUT");
        throw error instanceof AdapterError ? error : new AdapterError("INVALID_RESPONSE", "Onchain policy response is invalid.");
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
}
