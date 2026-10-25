/** Internal V2 reserve builder, not an anomaly detector or a public provider.
 * Run inside ScamRpcSource.withBatch: publication requires its final hash check.
 */
import type { MissingInterval, PoolHistoryParams, PoolHistoryValue, PoolSnapshot, Subject } from "../types/scam.js";
import { AdapterError } from "./errors.js";
import { createBlockTimeIndex } from "./scam-block-time.js";
import { address, type RpcLog } from "./scam-rpc-codec.js";
import { ScamRpcError, type ScamRpcBatch, type VerifiedPool } from "./scam-rpc.js";

export const SCAM_DATA_BUILDER_VERSION = "dambi-v2/1";
export const V2_SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";
const SCHEMA = "scam.pool_history/1";

export interface PoolHistoryBuildLimits {
  /** Total candidate grid positions, including missing positions, before work. */
  readonly maxPoints: number;
  readonly maxLogs: number;
  readonly maxBlockLookups: number;
  /** Search hint only; never used as an observed timestamp. */
  readonly blockTimeHintMs: number;
}
type Reserves = { readonly reserve0: string; readonly reserve1: string };
type State = Reserves & { readonly tMs: number };
type Marker = { readonly block: bigint; readonly tMs: number } & (
  | { readonly kind: "state"; readonly reserves: Reserves }
  | { readonly kind: "gap"; readonly through: bigint; readonly reason: MissingInterval["reason"] }
);
const fail = (reason: "invalid_request" | "invalid_config" | "invalid_response" | "resource_limit" | "reorg"): never => {
  throw new ScamRpcError(reason);
};
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

function sameSubject(a: Subject, b: Subject): boolean {
  return a && a.chainId === b.chainId && a.venue === b.venue
    && (["pool", "factory", "token", "quoteToken"] as const).every((key) => address(a[key]) && a[key].toLowerCase() === b[key])
    && Array.isArray(a.actionPaths) && a.actionPaths.length === b.actionPaths.length
    && a.actionPaths.every((path, i) => path === b.actionPaths[i]);
}

/** No decimals/zero substitutes: only recoverable data failures become gaps. */
function missingReason(error: unknown): MissingInterval["reason"] {
  if (error instanceof ScamRpcError) {
    if (error.reason === "rpc_error") return "rpc_error";
    if (error.reason === "invalid_response") return "unavailable_history";
  }
  if (error instanceof AdapterError) {
    if (error.code === "INVALID_RESPONSE") return "unavailable_history";
    if (error.code === "HTTP_ERROR" || error.code === "NETWORK_ERROR") return "rpc_error";
  }
  throw error; // abort, deadline, reorg and resource limits remain batch failures.
}

function syncReserves(log: RpcLog): Reserves | undefined {
  if (log.topics.length !== 1 || log.topics[0] !== V2_SYNC_TOPIC
      || !/^0x[0-9a-fA-F]{128}(?![\s\S])/.test(log.data)) return undefined;
  const a = BigInt(`0x${log.data.slice(2, 66)}`), b = BigInt(`0x${log.data.slice(66)}`);
  if (a >= (1n << 112n) || b >= (1n << 112n)) return undefined;
  return { reserve0: a.toString(), reserve1: b.toString() };
}

function firstGrid(from: number, origin: number, bucket: number): bigint {
  const start = BigInt(from), step = BigInt(bucket), phase = BigInt(origin) % step;
  return start + (phase - start % step + step) % step;
}

/** Uses getReserves at the start boundary plus forward Sync updates. No
 * Swap/Mint/Burn inversion is attempted when historical state is unavailable.
 * Missing log ranges invalidate carried state until a later confirmed Sync.
 */
export async function buildPoolHistory(
  batch: ScamRpcBatch, pool: VerifiedPool, supplied: PoolHistoryParams, suppliedLimits: PoolHistoryBuildLimits,
): Promise<PoolHistoryValue> {
  // Own configuration before the first await; never adjust the pinned grids.
  const limits = { ...suppliedLimits };
  if (![limits.maxPoints, limits.maxLogs, limits.maxBlockLookups, limits.blockTimeHintMs].every((v) => integer(v, 1))) return fail("invalid_config");
  if (!supplied || supplied.dataSchema !== SCHEMA || supplied.builderVersion !== SCAM_DATA_BUILDER_VERSION
      || supplied.referenceGroupId !== batch.referenceGroupId || supplied.confirmDepth !== batch.reference.requiredConfirmDepth
      || !sameSubject(supplied.subject, pool.subject)
      || !integer(supplied.lookbackSec) || supplied.lookbackSec > 86_400 || !integer(supplied.warmupSec)
      || !Array.isArray(supplied.metrics) || supplied.metrics.length > 2
      || !supplied.metrics.every((m) => m === "quote_reserve" || m === "price_quote_per_token")
      || !Array.isArray(supplied.candidateResolutions) || !supplied.candidateResolutions.length
      || supplied.candidateResolutions.length > 2) return fail("invalid_request");
  const { lookbackSec, warmupSec } = supplied;
  const grids: { bucketMs: number; gridOriginMs: number; first: bigint }[] = [];
  const end = batch.reference.block.timestampMs;
  const span = (BigInt(lookbackSec) + BigInt(warmupSec)) * 1000n;
  if (span > BigInt(Number.MAX_SAFE_INTEGER)) return fail("invalid_request");
  const from = Number(BigInt(end) > span ? BigInt(end) - span : 0n);
  let positions = 0n;
  for (const grid of supplied.candidateResolutions) {
    if (!grid || !integer(grid.bucketMs, 1) || !integer(grid.gridOriginMs)) return fail("invalid_request");
    if (grids.some((g) => g.bucketMs === grid.bucketMs && g.gridOriginMs === grid.gridOriginMs)) continue;
    const first = firstGrid(from, grid.gridOriginMs, grid.bucketMs);
    if (first <= BigInt(end)) positions += (BigInt(end) - first) / BigInt(grid.bucketMs) + 1n;
    if (positions > BigInt(limits.maxPoints)) return fail("resource_limit");
    grids.push({ bucketMs: grid.bucketMs, gridOriginMs: grid.gridOriginMs, first });
  }
  const times = createBlockTimeIndex(batch, { maxBlocks: limits.maxBlockLookups, blockTimeHintMs: limits.blockTimeHintMs });
  const boundary = await times.atOrBefore(from);
  const startBlock = boundary.before ?? boundary.after!; // Genesis if the requested window predates this chain.
  let seed: Reserves | undefined;
  let seedFailure: MissingInterval["reason"] = "unavailable_history";
  if (boundary.before) {
    try { seed = await batch.reserves(pool, boundary.before.number); }
    catch (error) { seedFailure = missingReason(error); }
  }
  const unavailable: { field: string; reason: string }[] = [];
  // Await all tasks even when one fails, preserving the batch's no-detached-I/O contract.
  const decimals = await Promise.allSettled([batch.decimals(pool, "token0"), batch.decimals(pool, "token1")]);
  for (let side = 0; side < decimals.length; side++) {
    const item = decimals[side];
    if (item.status === "rejected") {
      missingReason(item.reason);
      unavailable.push({ field: `token${side}.decimals`, reason: "unavailable_history" });
    }
  }
  const missing: MissingInterval[] = [];
  const states: State[] = seed ? [{ ...seed, tMs: boundary.before!.timestampMs }] : [];
  let completeWarmup = !!seed;
  if (unavailable.length) {
    // Cannot construct the wire snapshot's required decimals. Do not emit
    // fabricated values, and do not spend the remaining budget fetching logs.
    if (from < end) missing.push({ fromMs: from, toMs: end, reason: "unavailable_history" });
    completeWarmup = false;
  } else {
    const queryFrom = BigInt(startBlock.number) + (boundary.before ? 1n : 0n);
    const markers: Marker[] = [];
    if (queryFrom <= BigInt(batch.reference.block.number)) {
      const scan = await batch.logs(pool, { scope: "pair", fromBlock: queryFrom.toString(),
        toBlock: batch.reference.block.number, topics: [V2_SYNC_TOPIC] });
      if (scan.logs.length > limits.maxLogs || scan.missing.length > limits.maxLogs) return fail("resource_limit");
      // SF4-2 has already scoped, sorted and deduplicated logs. Each block's
      // final Sync is its observed end state; any malformed Sync poisons it.
      const perBlock = new Map<string, { log: RpcLog; reserves?: Reserves }>();
      for (const log of scan.logs) {
        const previous = perBlock.get(log.blockNumber);
        perBlock.set(log.blockNumber, { log,
          reserves: previous && !previous.reserves ? undefined : syncReserves(log) });
      }
      const headerNumbers = [...new Set([
        ...scan.missing.map((gap) => gap.fromBlock),
        ...[...perBlock].filter(([, last]) => last.log.timestampMs === undefined).map(([number]) => number),
      ])];
      // Include the raw batch's final evidence checks in its lower-bound cost
      // before spending requests on individual Sync headers. The local budget
      // separately bounds only actual time-index lookups, including boundaries.
      batch.preflightHeaders(headerNumbers);
      times.preflight(headerNumbers);
      for (const gap of scan.missing) {
        const first = await times.block(gap.fromBlock);
        // The missing interval will remain open past the failed chunk, until
        // another complete state is known; the last block guards recovery.
        markers.push({ kind: "gap", block: BigInt(gap.fromBlock), through: BigInt(gap.toBlock),
          tMs: first.timestampMs, reason: gap.reason === "rpc_error" ? "rpc_error" : "unavailable_history" });
      }
      for (const [number, last] of perBlock) {
        let tMs: number;
        if (last.log.timestampMs !== undefined) {
          // This value is usable only inside the unpublished draft. The raw
          // batch still checks its hash AND time against an actual final header.
          tMs = times.logTime(last.log);
        } else {
          const block = await times.block(number);
          if (block.hash !== last.log.blockHash) return fail("reorg");
          tMs = block.timestampMs;
        }
        if (last.reserves) markers.push({ kind: "state", block: BigInt(number), tMs, reserves: last.reserves });
        else markers.push({ kind: "gap", block: BigInt(number), through: BigInt(number), tMs, reason: "unavailable_history" });
      }
    }
    markers.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.kind === b.kind ? 0 : a.kind === "gap" ? -1 : 1);
    let blockedThrough = -1n;
    let open: { fromMs: number; reason: MissingInterval["reason"] } | undefined = seed ? undefined : { fromMs: from, reason: seedFailure };
    for (const marker of markers) {
      if (marker.kind === "gap") {
        blockedThrough = marker.through > blockedThrough ? marker.through : blockedThrough;
        // Times are integer milliseconds: (t-1, ...] includes the bad block
        // at t, while a later recovered Sync at r closes the gap at r-1.
        open ??= { fromMs: Math.max(from, marker.tMs - 1), reason: marker.reason };
      } else if (marker.block > blockedThrough) {
        if (open) {
          const toMs = marker.tMs - 1;
          if (open.fromMs < toMs) missing.push({ ...open, toMs });
          open = undefined;
        }
        states.push({ ...marker.reserves, tMs: marker.tMs });
      }
    }
    if (open && open.fromMs < end) missing.push({ ...open, toMs: end });
    // Availability only, not a claim that direction/high-low algorithm state is initialized.
    const countingStart = Math.max(0, end - lookbackSec * 1000);
    completeWarmup = states.some((state) => state.tMs <= from)
      && !missing.some((gap) => gap.fromMs < countingStart && gap.toMs > from);
  }
  const tokenIs0 = pool.token0 === pool.subject.token;
  const d0 = decimals[0].status === "fulfilled" ? decimals[0].value : undefined;
  const d1 = decimals[1].status === "fulfilled" ? decimals[1].value : undefined;
  const histories = grids.map(({ bucketMs, gridOriginMs, first }): PoolHistoryValue["histories"][number] => {
    const points: PoolSnapshot[] = [];
    let stateIndex = 0, missingIndex = 0;
    let latest: State | undefined;
    if (d0 !== undefined && d1 !== undefined) {
      for (let at = first; at <= BigInt(end); at += BigInt(bucketMs)) {
        const tMs = Number(at);
        while (stateIndex < states.length && states[stateIndex].tMs <= tMs) latest = states[stateIndex++];
        while (missingIndex < missing.length && missing[missingIndex].toMs < tMs) missingIndex++;
        const gap = missing[missingIndex];
        if (!latest || gap && gap.fromMs < tMs && tMs <= gap.toMs) continue;
        points.push({ tMs, reserveToken: tokenIs0 ? latest.reserve0 : latest.reserve1,
          reserveQuote: tokenIs0 ? latest.reserve1 : latest.reserve0,
          decimalsToken: tokenIs0 ? d0 : d1, decimalsQuote: tokenIs0 ? d1 : d0 });
      }
    }
    return { gridOriginMs, history: { schema: SCHEMA, builderVersion: SCAM_DATA_BUILDER_VERSION,
      fromMs: from, bucketMs, points, missing: missing.map(({ fromMs, toMs }) => ({ fromMs, toMs })),
      warmup: { fromMs: from, complete: completeWarmup } } };
  });
  return { method: "scam.pool_history", schema: SCHEMA, builderVersion: SCAM_DATA_BUILDER_VERSION,
    subject: pool.subject, referenceGroupId: batch.referenceGroupId, reference: batch.reference,
    coverage: { fromBlock: startBlock.number, fromMs: from, toMs: end, missing, unavailable }, histories };
}
