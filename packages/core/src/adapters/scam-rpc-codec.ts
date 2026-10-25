import { AdapterError } from "./errors.js";
import { decodeQuantity } from "./evm-rpc.js";

// Raw RPC validation only. These helpers do not fetch data, infer missing
// values, build snapshot grids, or decide whether an asset is risky.
export type RpcBlock = {
  readonly number: string;
  readonly hash: `0x${string}`;
  readonly timestampMs: number;
  readonly parentHash: `0x${string}`;
};

export type RpcLog = {
  readonly address: `0x${string}`;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  /** Optional RPC-provided time; publication still requires a real header check. */
  readonly timestampMs?: number;
  readonly transactionHash: `0x${string}`;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new AdapterError("INVALID_RESPONSE", "The endpoint did not return supported scam-analysis RPC data.");
}

export function address(value: unknown): value is `0x${string}` {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(value)
    && BigInt(value) !== 0n;
}

export function hash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value);
}

function normalized(value: `0x${string}`): `0x${string}` {
  return value.toLowerCase() as `0x${string}`;
}

export function quantity(value: bigint): `0x${string}` {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("RPC quantities must be nonnegative bigint values.");
  }
  return `0x${value.toString(16)}`;
}

function safeQuantity(value: unknown): number {
  const decoded = decodeQuantity(value);
  if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) return invalidResponse();
  return Number(decoded);
}

function timestampMs(value: unknown): number {
  const milliseconds = decodeQuantity(value) * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return invalidResponse();
  return Number(milliseconds);
}

export function decodeBlock(value: unknown, expectedNumber?: bigint): RpcBlock {
  if (!record(value) || !hash(value.hash) || !hash(value.parentHash)) return invalidResponse();
  const number = decodeQuantity(value.number);
  if (expectedNumber !== undefined && number !== expectedNumber) return invalidResponse();
  return Object.freeze({
    number: number.toString(),
    hash: normalized(value.hash),
    timestampMs: timestampMs(value.timestamp),
    parentHash: normalized(value.parentHash),
  });
}

export function decodeLogs(
  value: unknown,
  requestedAddress: string,
  from: bigint,
  to: bigint,
  topics: readonly string[],
  maxLogs: number,
): readonly RpcLog[] {
  if (!Array.isArray(value) || !address(requestedAddress)
      || typeof from !== "bigint" || typeof to !== "bigint" || from < 0n || to < from
      || !Array.isArray(topics) || topics.length === 0 || !topics.every(hash)
      || !Number.isSafeInteger(maxLogs) || maxLogs < 0) return invalidResponse();
  // Cap the received payload, not merely the unique logs after deduplication.
  if (value.length > maxLogs) {
    throw new AdapterError("RESPONSE_TOO_LARGE", "The RPC log response exceeded its configured limit.");
  }
  const expectedAddress = requestedAddress.toLowerCase();
  const acceptedTopics = new Set(topics.map((topic) => topic.toLowerCase()));
  const blocks = new Map<string, string>();
  const times = new Map<string, number>();
  const positions = new Map<string, RpcLog>();
  for (const entry of value) {
    if (!record(entry) || entry.removed !== false || !address(entry.address)
        || entry.address.toLowerCase() !== expectedAddress
        || !hash(entry.blockHash) || !hash(entry.transactionHash)
        || !Array.isArray(entry.topics) || entry.topics.length === 0
        || entry.topics.length > 4 || !entry.topics.every(hash)
        || !acceptedTopics.has(entry.topics[0].toLowerCase())) return invalidResponse();
    const blockNumber = decodeQuantity(entry.blockNumber);
    if (blockNumber < from || blockNumber > to) return invalidResponse();
    // A present but invalid value is not equivalent to an unsupported field.
    const observedTime = "blockTimestamp" in entry ? timestampMs(entry.blockTimestamp) : undefined;
    const decoded: RpcLog = Object.freeze({
      address: normalized(entry.address),
      blockNumber: blockNumber.toString(),
      blockHash: normalized(entry.blockHash),
      ...(observedTime === undefined ? {} : { timestampMs: observedTime }),
      transactionHash: normalized(entry.transactionHash),
      transactionIndex: safeQuantity(entry.transactionIndex),
      logIndex: safeQuantity(entry.logIndex),
      topics: Object.freeze(entry.topics.map((topic) => normalized(topic as `0x${string}`))),
      data: decodeCode(entry.data),
    });
    const knownHash = blocks.get(decoded.blockNumber);
    if (knownHash !== undefined && knownHash !== decoded.blockHash) return invalidResponse();
    blocks.set(decoded.blockNumber, decoded.blockHash);
    if (observedTime !== undefined) {
      const knownTime = times.get(decoded.blockNumber);
      if (knownTime !== undefined && knownTime !== observedTime) return invalidResponse();
      times.set(decoded.blockNumber, observedTime);
    }
    // logIndex is block-global. A different transaction/hash/body at the same
    // position is an inconsistent response, not a duplicate to silently drop.
    const key = `${decoded.blockNumber}:${decoded.logIndex}`;
    const prior = positions.get(key);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(decoded)) return invalidResponse();
    } else {
      positions.set(key, decoded);
    }
  }
  const sorted = [...positions.values()].sort((left, right) => {
    const a = BigInt(left.blockNumber);
    const b = BigInt(right.blockNumber);
    if (a !== b) return a < b ? -1 : 1;
    return left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex;
  });
  let previousTime: number | undefined;
  for (const log of sorted) {
    if (log.timestampMs === undefined) continue;
    if (previousTime !== undefined && previousTime > log.timestampMs) return invalidResponse();
    previousTime = log.timestampMs;
  }
  return Object.freeze(sorted);
}

export function decodeAddressWord(value: unknown): `0x${string}` {
  if (!hash(value) || !/^0x0{24}/.test(value)) return invalidResponse();
  const decoded = `0x${value.slice(26)}`;
  if (!address(decoded)) return invalidResponse();
  return normalized(decoded);
}

export function decodeReserves(value: unknown): {
  readonly reserve0: string;
  readonly reserve1: string;
  readonly blockTimestampLast: number;
} {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{192}(?![\s\S])/.test(value)) return invalidResponse();
  const reserve0 = BigInt(`0x${value.slice(2, 66)}`);
  const reserve1 = BigInt(`0x${value.slice(66, 130)}`);
  const timestamp = BigInt(`0x${value.slice(130, 194)}`);
  if (reserve0 >= (1n << 112n) || reserve1 >= (1n << 112n) || timestamp >= (1n << 32n)) return invalidResponse();
  return Object.freeze({ reserve0: reserve0.toString(), reserve1: reserve1.toString(), blockTimestampLast: Number(timestamp) });
}

export function decodeDecimals(value: unknown): number {
  if (!hash(value)) return invalidResponse();
  const decoded = BigInt(value);
  if (decoded > 255n) return invalidResponse();
  return Number(decoded);
}

export function decodeCode(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(value)) return invalidResponse();
  return value.toLowerCase() as `0x${string}`;
}
