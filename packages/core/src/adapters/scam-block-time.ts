import { hash, type RpcBlock, type RpcLog } from "./scam-rpc-codec.js";
import { ScamRpcError, type ScamRpcBatch, type ScamRpcFailure } from "./scam-rpc.js";

export interface BlockTimeOptions {
  /** Unique requested headers, including the reference header when requested. */
  readonly maxBlocks: number;
  /** Search hint only; never supplies timestamp evidence. */
  readonly blockTimeHintMs: number;
}
export interface BlockTimeBoundary {
  readonly before: RpcBlock | null;
  readonly after: RpcBlock | null;
}

const fail = (reason: ScamRpcFailure): never => { throw new ScamRpcError(reason); };
const integer = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function height(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(value)) return fail("invalid_request");
  return BigInt(value);
}

/** Bounded timestamp lookup shared by one fixed-reference RPC batch. */
export function createBlockTimeIndex(batch: ScamRpcBatch, options: BlockTimeOptions) {
  if (!options || !integer(options.maxBlocks, 1) || !integer(options.blockTimeHintMs, 1)) return fail("invalid_config");
  const { maxBlocks, blockTimeHintMs } = options;
  const reference = batch.reference.block;
  const baseHeight = height(reference.number);
  const baseNumber = reference.number;
  const baseHash = reference.hash;
  const baseTime = reference.timestampMs;
  if (!integer(baseTime) || !hash(baseHash)) return fail("invalid_request");
  const pending = new Map<string, Promise<RpcBlock>>();
  // Log timestamps are draft evidence, not fabricated headers or cached block
  // lookups. The raw batch must compare them with actual headers before publish.
  const observed: Pick<RpcBlock, "number" | "hash" | "timestampMs">[] = [];
  let terminal: ScamRpcError | undefined;
  const reject = (reason: "invalid_response" | "reorg" | "resource_limit"): never => {
    terminal ??= new ScamRpcError(reason);
    throw terminal;
  };

  function observeTime(value: Pick<RpcBlock, "number" | "hash" | "timestampMs">): void {
    const n = height(value.number);
    if (n > baseHeight || !hash(value.hash) || !integer(value.timestampMs)
        || value.timestampMs > baseTime) return reject("invalid_response");
    if (n === baseHeight) {
      if (value.hash.toLowerCase() !== baseHash.toLowerCase()) return reject("reorg");
      if (value.timestampMs !== baseTime) return reject("invalid_response");
    }
    let low = 0;
    let high = observed.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (BigInt(observed[middle].number) < n) low = middle + 1;
      else high = middle;
    }
    const previous = observed[low - 1];
    const next = observed[low];
    if (next?.number === value.number) {
      if (next.hash !== value.hash.toLowerCase()) return reject("reorg");
      if (next.timestampMs !== value.timestampMs) return reject("invalid_response");
      return;
    }
    if ((previous && previous.timestampMs > value.timestampMs)
        || (next && next.timestampMs < value.timestampMs)) return reject("invalid_response");
    observed.splice(low, 0, { number: value.number, hash: value.hash.toLowerCase() as RpcBlock["hash"], timestampMs: value.timestampMs });
  }

  /** Known remaining header work only; does not reserve capacity or start I/O. */
  function preflight(numbers: readonly string[]): void {
    if (terminal) throw terminal;
    const required = new Set(pending.keys());
    for (const number of numbers) {
      if (height(number) > baseHeight) return fail("invalid_request");
      required.add(number);
    }
    if (required.size > maxBlocks) return reject("resource_limit");
  }

  function logTime(log: RpcLog): number {
    if (terminal) throw terminal;
    if (log.timestampMs === undefined) return fail("invalid_request");
    observeTime({ number: log.blockNumber, hash: log.blockHash, timestampMs: log.timestampMs });
    return log.timestampMs;
  }

  function block(number: string): Promise<RpcBlock> {
    if (terminal) throw terminal;
    const n = height(number);
    if (n > baseHeight) return fail("invalid_request");
    const existing = pending.get(number);
    if (existing) return existing;
    if (pending.size >= maxBlocks) return reject("resource_limit");
    const task = (async (): Promise<RpcBlock> => {
      const value = await batch.block(number);
      if (terminal) throw terminal;
      if (!value || value.number !== number || !hash(value.hash) || !hash(value.parentHash)
          || !integer(value.timestampMs) || value.timestampMs > baseTime) return reject("invalid_response");
      if (n === baseHeight) {
        if (value.hash.toLowerCase() !== baseHash.toLowerCase()) return reject("reorg");
        if (value.timestampMs !== baseTime) return reject("invalid_response");
      }
      const result: RpcBlock = Object.freeze({
        number, hash: value.hash.toLowerCase() as RpcBlock["hash"],
        timestampMs: value.timestampMs, parentHash: value.parentHash.toLowerCase() as RpcBlock["parentHash"],
      });
      observeTime(result);
      return result;
    })();
    // Keep failures as well: one unavailable height must not cause unbounded retries.
    pending.set(number, task);
    return task;
  }

  async function atOrBefore(tMs: number): Promise<BlockTimeBoundary> {
    if (terminal) throw terminal;
    if (!integer(tMs) || tMs > baseTime) return fail("invalid_request");
    const base = await block(baseNumber);
    if (tMs === baseTime) return Object.freeze({ before: base, after: null });

    const elapsed = BigInt(baseTime - tMs);
    const hint = BigInt(blockTimeHintMs);
    const distance = (elapsed + hint - 1n) / hint;
    const candidateHeight = distance >= baseHeight ? 0n : baseHeight - distance;
    const candidate = await block(candidateHeight.toString());
    let lower: RpcBlock;
    let upper: RpcBlock;
    if (candidate.timestampMs <= tMs) {
      const next = await block((candidateHeight + 1n).toString());
      if (next.timestampMs > tMs) return Object.freeze({ before: candidate, after: next });
      lower = next;
      upper = base;
    } else {
      if (candidateHeight === 0n) return Object.freeze({ before: null, after: candidate });
      const previous = await block((candidateHeight - 1n).toString());
      if (previous.timestampMs <= tMs) return Object.freeze({ before: previous, after: candidate });
      upper = previous;
      const genesis = await block("0");
      if (genesis.timestampMs > tMs) return Object.freeze({ before: null, after: genesis });
      lower = genesis;
    }

    // Only adjacent actual headers establish the boundary. The block-time hint
    // neither establishes coverage nor turns an unqueried timestamp into evidence.
    while (BigInt(upper.number) - BigInt(lower.number) > 1n) {
      const middle = (BigInt(lower.number) + BigInt(upper.number)) / 2n;
      const current = await block(middle.toString());
      if (current.timestampMs <= tMs) lower = current;
      else upper = current;
    }
    return Object.freeze({ before: lower, after: upper });
  }

  return Object.freeze({ block, atOrBefore, preflight, logTime });
}
