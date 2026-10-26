import { AdapterError } from "./errors.js";
import type { RpcBlock, RpcLog } from "./scam-rpc-codec.js";

export interface ScamHistoryStoreOptions {
  readonly maxEntries: number;
  /** UTF-8 bytes of owned entry JSON, not an estimate of JavaScript heap size. */
  readonly maxBytes: number;
  readonly ttlMs: number;
  /** Maximum inclusive scan width and maximum age behind the reference height. */
  readonly maxBlockSpan: number;
}

export interface HistoryBlockRange {
  readonly fromBlock: string;
  readonly toBlock: string;
}

/** Only complete scans may be staged; commit follows the caller's final verification.
 * The opaque key includes the source's chain, mode, pool, scope and topic filter.
 */
export interface ScamHistoryEntry extends HistoryBlockRange {
  readonly key: string;
  readonly start: RpcBlock;
  readonly end: RpcBlock;
  readonly logs: readonly RpcLog[];
  readonly rawObservedAt: Readonly<{ fromMs: number; toMs: number }>;
  readonly storedAt: number;
}

export interface ScamHistoryHit extends HistoryBlockRange {
  /** Original scan boundaries remain evidence even for a clipped intersection. */
  readonly entry: ScamHistoryEntry;
  readonly logs: readonly RpcLog[];
  readonly missing: readonly HistoryBlockRange[];
}

/** An owned candidate, not yet reusable. Only its creating store may commit it. */
export interface PreparedHistoryEntry {
  readonly entry: ScamHistoryEntry;
  readonly bytes: number;
}

const integer = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const decimal = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(value);
const invalid = (configuration = false): never => {
  throw new AdapterError(configuration ? "INVALID_CONFIG" : "INVALID_REQUEST", "History store input is invalid.");
};
const range = (from: bigint, to: bigint): HistoryBlockRange => Object.freeze({ fromBlock: from.toString(), toBlock: to.toString() });
const ownBlock = (block: RpcBlock): RpcBlock => Object.freeze({
  number: block.number, hash: block.hash, parentHash: block.parentHash, timestampMs: block.timestampMs,
});

/** Source-local bounded completed-log storage. It never stores Facts or grids,
 * never refreshes raw observation times on a hit, and never performs RPC work.
 */
export function createScamHistoryStore(input: ScamHistoryStoreOptions) {
  if (!input || ![input.maxEntries, input.maxBytes, input.ttlMs, input.maxBlockSpan].every((v) => integer(v, 1))) return invalid(true);
  const { maxEntries, maxBytes, ttlMs, maxBlockSpan } = input;
  const maxSpan = BigInt(maxBlockSpan);
  const entries = new Map<string, { entry: ScamHistoryEntry; bytes: number }>();
  const prepared = new WeakSet<PreparedHistoryEntry>();
  let bytes = 0;
  let generation = 0;
  const remove = (key: string): void => {
    const old = entries.get(key);
    if (old) { bytes -= old.bytes; entries.delete(key); }
  };
  const prune = (now: number): void => {
    for (const [key, { entry }] of entries) {
      if (now - entry.storedAt >= ttlMs) remove(key);
    }
  };

  const stage = (value: ScamHistoryEntry): PreparedHistoryEntry | undefined => {
    if (!value || typeof value.key !== "string" || !value.key.length
        || !decimal(value.fromBlock) || !decimal(value.toBlock)
        || value.start?.number !== value.fromBlock || value.end?.number !== value.toBlock
        || !integer(value.storedAt) || !integer(value.rawObservedAt?.fromMs) || !integer(value.rawObservedAt?.toMs)
        || value.rawObservedAt.fromMs > value.rawObservedAt.toMs || value.rawObservedAt.toMs > value.storedAt
        || !Array.isArray(value.logs)) return invalid();
    const from = BigInt(value.fromBlock), to = BigInt(value.toBlock);
    if (from > to) return invalid();
    if (to - from + 1n > maxSpan) return undefined;
    const logs = value.logs.map((log): RpcLog => {
      if (!decimal(log.blockNumber) || BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > to) return invalid();
      return Object.freeze({ address: log.address, blockNumber: log.blockNumber, blockHash: log.blockHash,
        ...(log.timestampMs === undefined ? {} : { timestampMs: log.timestampMs }),
        transactionHash: log.transactionHash, transactionIndex: log.transactionIndex, logIndex: log.logIndex,
        topics: Object.freeze([...log.topics]), data: log.data });
    });
    const owned: ScamHistoryEntry = Object.freeze({ key: value.key, fromBlock: value.fromBlock, toBlock: value.toBlock,
      start: ownBlock(value.start), end: ownBlock(value.end), logs: Object.freeze(logs),
      rawObservedAt: Object.freeze({ fromMs: value.rawObservedAt.fromMs, toMs: value.rawObservedAt.toMs }), storedAt: value.storedAt });
    const entryBytes = new TextEncoder().encode(JSON.stringify(owned)).byteLength;
    // Storage capacity cannot turn a successful data query into a failure.
    if (entryBytes > maxBytes) return undefined;
    const result = Object.freeze({ entry: owned, bytes: entryBytes });
    prepared.add(result);
    return result;
  };

  const commit = (candidates: readonly PreparedHistoryEntry[], expectedGeneration: number): boolean => {
    if (expectedGeneration !== generation) return false;
    if (!Array.isArray(candidates) || candidates.some((candidate) => !prepared.has(candidate))) return invalid();
    // Validation, ownership copying and JSON size work happened before the
    // caller's final verification. This synchronous commit only updates indexes.
    for (const candidate of candidates) {
      const { entry, bytes: entryBytes } = candidate;
      prune(entry.storedAt);
      const previous = entries.get(entry.key)?.entry;
      // A late older collection must not displace a scan at a newer reference.
      if (previous && BigInt(previous.toBlock) > BigInt(entry.toBlock)) continue;
      remove(entry.key);
      while (entries.size >= maxEntries || bytes + entryBytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      entries.set(entry.key, candidate);
      bytes += entryBytes;
    }
    return true;
  };

  return Object.freeze({
    get generation(): number { return generation; },
    get size(): number { return entries.size; },
    get bytes(): number { return bytes; },
    invalidateAll(): void { entries.clear(); bytes = 0; generation++; },

    get(key: string, fromBlock: string, toBlock: string, referenceBlock: string, now: number): ScamHistoryHit | undefined {
      if (typeof key !== "string" || !key.length || ![fromBlock, toBlock, referenceBlock].every(decimal)
          || !integer(now)) return invalid();
      const from = BigInt(fromBlock), to = BigInt(toBlock), reference = BigInt(referenceBlock);
      if (from > to || to > reference) return invalid();
      prune(now);
      const stored = entries.get(key);
      if (!stored) return undefined;
      const entry = stored.entry, end = BigInt(entry.toBlock);
      if (now < entry.storedAt) return undefined;
      // A read against an older reference cannot borrow a newer completed scan.
      if (end > reference) return undefined;
      if (reference - end >= maxSpan) { remove(key); return undefined; }
      const left = from > BigInt(entry.fromBlock) ? from : BigInt(entry.fromBlock);
      const right = to < end ? to : end;
      if (left > right) return undefined;
      const missing: HistoryBlockRange[] = [];
      if (from < left) missing.push(range(from, left - 1n));
      if (right < to) missing.push(range(right + 1n, to));
      // Promote recency without extending TTL or changing observation provenance.
      entries.delete(key);
      entries.set(key, stored);
      return Object.freeze({ ...range(left, right), entry,
        logs: Object.freeze(entry.logs.filter((log) => {
          const n = BigInt(log.blockNumber);
          return n >= left && n <= right;
        })), missing: Object.freeze(missing) });
    },

    stage,
    commit,
    put(value: ScamHistoryEntry, expectedGeneration: number): boolean {
      if (expectedGeneration !== generation) return false;
      const candidate = stage(value);
      if (!candidate) return false;
      const previous = entries.get(candidate.entry.key)?.entry;
      if (previous && candidate.entry.storedAt - previous.storedAt < ttlMs
          && BigInt(previous.toBlock) > BigInt(candidate.entry.toBlock)) return false;
      return commit([candidate], expectedGeneration);
    },
  });
}
