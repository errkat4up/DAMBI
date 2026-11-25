/**
 * Window rules evaluated inside the extension — the lookup half.
 *
 * For one token the user is buying and does not hold (the shared gate in
 * `scam-checks.ts` established that), on Ethereum mainnet:
 *
 *   1. token/WETH pool and head block      — {@link lookupPool}, shared with the backdoor check
 *   2. the pool's `Sync` logs, head-300..head  ·  `getReserves()` AT block head-300
 *   3. (only when the logs carry no `blockTimestamp`) the timestamp of each block that had a `Sync`
 *   4. the algorithm, in WASM
 *
 * Step 2's reserves decide the pool's age without a creation lookup: zero at
 * the window's first block means the `Sync` logs inside the window are the
 * pool's whole history; non-zero means the pool already had liquidity an hour
 * ago, and then no rule runs.
 *
 * Read-only (`eth_getLogs`, `eth_call`, `eth_getBlockByNumber`) and advisory.
 * A failed lookup, a rate limit or the deadline ends as "undetermined": no
 * warning, and the reason is kept for the timing record and the /scam page.
 */
import type { WindowDisplay, WindowFiredRule } from "@lib/window-display";
import {
  BACKDOOR_CHAIN_ID,
  RpcRevert,
  WETH,
  hexBlock,
  lookupPool,
  record,
  type PoolLookup,
  type Rpc,
} from "./backdoor-check";
import {
  NEW_POOL_MAX_AGE_SEC,
  WINDOW_BLOCKS,
  buildAnalysisRequest,
  type ChangeCountRule,
  type EngineAnalysis,
  type PoolPoint,
} from "./window-rules";

/** The check's own deadline, counted from the end of the shared gate. */
export const WINDOW_TIMEOUT_MS = 2_500;
const SYNC_TOPIC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1"; // Sync(uint112,uint112)
const GET_RESERVES = "0x0902f1ac"; // getReserves()
/** Parallel header lookups on the fallback path. */
const BLOCK_TIME_CONCURRENCY = 8;

export type WindowResult =
  /** At least one rule fired — the only result that is shown. */
  | "fired"
  | "clear"
  /** Evaluated, but the window was not fully observed or a rule could not run on this data. */
  | "incomplete"
  | "not_evaluable"
  /** A precondition was not met (no pool, or the pool is older than the window). */
  | "skipped"
  /** A lookup failed, was rate-limited or ran out of time. */
  | "undetermined";

export interface WindowCheck {
  readonly result: WindowResult;
  readonly reason: string;
  readonly token: string;
  readonly pool?: string;
  readonly poolAgeSec?: number;
  /** Rules that fired, with the counts that made them fire. */
  readonly fired?: readonly WindowFiredRule[];
}

export type Analyze = (request: Record<string, unknown>) => Promise<EngineAnalysis>;
type Mark = (phase: string) => void;

/** Why a lookup did not produce a value. A rate limit is worth telling apart. */
function failureReason(error: unknown, fallback: string): string {
  const text = String((error as Error)?.message ?? error).toLowerCase();
  if (/rate limit|too many requests|429|-32005|capacity|exceeded/.test(text)) return "rate_limited";
  if (/abort|timeout|timed out/.test(text)) return "rpc_timeout";
  return fallback;
}

const QUANTITY = /^0x[0-9a-fA-F]+$/;
const quantity = (v: unknown): number | null => {
  if (typeof v !== "string" || !QUANTITY.test(v)) return null;
  const n = Number(BigInt(v));
  return Number.isSafeInteger(n) ? n : null;
};

interface SyncEntry { readonly logIndex: number; readonly reserve0: bigint; readonly reserve1: bigint; readonly tMs: number | null }

/** Last `Sync` of each block, ascending by block. `null` when a log is not a well-formed Sync. */
function lastSyncPerBlock(logs: readonly unknown[]): Map<number, SyncEntry> | null {
  const perBlock = new Map<number, SyncEntry>();
  for (const log of logs) {
    if (!record(log) || log.removed === true) return null;
    const block = quantity(log.blockNumber), logIndex = quantity(log.logIndex);
    const data = typeof log.data === "string" ? log.data : "";
    if (block === null || logIndex === null || !/^0x[0-9a-fA-F]{128}$/.test(data)) return null;
    const stamp = log.blockTimestamp === undefined ? null : quantity(log.blockTimestamp);
    if (log.blockTimestamp !== undefined && stamp === null) return null;
    const previous = perBlock.get(block);
    if (previous && previous.logIndex >= logIndex) continue;
    perBlock.set(block, {
      logIndex, reserve0: BigInt("0x" + data.slice(2, 66)), reserve1: BigInt("0x" + data.slice(66, 130)),
      tMs: stamp === null ? null : stamp * 1000,
    });
  }
  return new Map([...perBlock].sort((a, b) => a[0] - b[0]));
}

/** Header timestamps for `blocks`, a few at a time. Throws when any is unavailable. */
async function blockTimes(rpc: Rpc, blocks: readonly number[]): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < blocks.length) {
      const block = blocks[next++];
      const header = await rpc("eth_getBlockByNumber", [hexBlock(block), false]);
      const stamp = record(header) ? quantity(header.timestamp) : null;
      if (stamp === null) throw new Error("block header without a timestamp");
      times.set(block, stamp * 1000);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOCK_TIME_CONCURRENCY, blocks.length) }, worker));
  return times;
}

/**
 * Examine one token. `rules` are the enabled, validated rules to evaluate;
 * with none there is nothing to do and nothing is fetched.
 */
export async function checkWindowRules(
  rpc: Rpc,
  args: { token: string; lookup?: PoolLookup | Promise<PoolLookup> | undefined; rules: readonly ChangeCountRule[] },
  analyze: Analyze,
  mark: Mark = () => {},
): Promise<WindowCheck> {
  const token = args.token.toLowerCase();
  const done = (result: WindowResult, reason: string, extra: Partial<WindowCheck> = {}): WindowCheck => ({ result, reason, token, ...extra });
  if (args.rules.length === 0) return done("skipped", "no_active_rule");

  // 1 ─ pool and head (shared with the backdoor check).
  const found = await (args.lookup ?? lookupPool(rpc, token));
  mark("window_stage1");
  if (found.status === "none") return done("skipped", "no_weth_pair");
  if (found.status === "unavailable") return done("undetermined", found.reason, found.pool ? { pool: found.pool } : {});
  const { pool, head } = found;
  const fromBlock = Math.max(0, head.number - WINDOW_BLOCKS);

  // 2 ─ the window's Sync logs, and the reserves at the window's first block.
  const [logs, startReserves] = await Promise.all([
    rpc("eth_getLogs", [{ address: pool, topics: [SYNC_TOPIC], fromBlock: hexBlock(fromBlock), toBlock: hexBlock(head.number) }])
      .then((value) => ({ value }), (error: unknown) => ({ error })),
    rpc("eth_call", [{ to: pool, data: GET_RESERVES }, hexBlock(fromBlock)])
      .then((value) => ({ value }), (error: unknown) => ({ error })),
  ]);
  mark("window_stage2");
  if ("error" in logs) return done("undetermined", failureReason(logs.error, "logs_unavailable"), { pool });
  if ("error" in startReserves) {
    // A revert here is not "zero liquidity"; it is an answer this check cannot use.
    return done("undetermined", startReserves.error instanceof RpcRevert ? "start_state_unreadable" : failureReason(startReserves.error, "start_state_unavailable"), { pool });
  }
  // No code at that block (the pair did not exist yet) answers with empty data: zero reserves.
  const start = typeof startReserves.value === "string" ? startReserves.value : "";
  if (!/^0x([0-9a-fA-F]{64})*$/.test(start)) return done("undetermined", "start_state_unreadable", { pool });
  const hadLiquidity = start.length >= 2 + 128 && (BigInt("0x" + start.slice(2, 66)) > 0n || BigInt("0x" + start.slice(66, 130)) > 0n);
  if (hadLiquidity) return done("skipped", "pool_older_than_window", { pool });
  if (!Array.isArray(logs.value)) return done("undetermined", "logs_unavailable", { pool });
  const perBlock = lastSyncPerBlock(logs.value);
  if (perBlock === null) return done("undetermined", "logs_malformed", { pool });
  if (perBlock.size === 0) return done("not_evaluable", "no_liquidity_yet", { pool });

  // 3 ─ block times: from the logs when the node provides them, otherwise from the headers.
  const untimed = [...perBlock].filter(([, entry]) => entry.tMs === null).map(([block]) => block);
  let headerTimes = new Map<number, number>();
  if (untimed.length > 0) {
    try { headerTimes = await blockTimes(rpc, untimed); }
    catch (error) { return done("undetermined", failureReason(error, "block_time_unavailable"), { pool }); }
    mark("window_stage3");
  }
  const tokenIs0 = BigInt(token) < BigInt(WETH);
  const points: PoolPoint[] = [];
  for (const [block, entry] of perBlock) {
    const tMs = entry.tMs ?? headerTimes.get(block);
    if (tMs === undefined || tMs > head.timestampMs || (points.length > 0 && tMs <= points[points.length - 1].tMs)) {
      return done("undetermined", "block_time_inconsistent", { pool });
    }
    points.push({ block, tMs,
      reserveQuote: (tokenIs0 ? entry.reserve1 : entry.reserve0).toString(10),
      reserveToken: (tokenIs0 ? entry.reserve0 : entry.reserve1).toString(10) });
  }
  // Age counts from first liquidity. The window is 300 blocks, which can be a little more than an hour.
  const poolAgeSec = Math.floor((head.timestampMs - points[0].tMs) / 1000);
  if (poolAgeSec > NEW_POOL_MAX_AGE_SEC) return done("skipped", "pool_older_than_window", { pool, poolAgeSec });

  // 4 ─ the algorithm.
  let analysis: EngineAnalysis;
  try {
    analysis = await analyze(buildAnalysisRequest({
      chainId: BACKDOOR_CHAIN_ID, pool, token, quote: WETH,
      asOf: { block: head.number, tMs: head.timestampMs }, points, rules: args.rules,
    }));
  } catch {
    return done("undetermined", "algorithm_error", { pool, poolAgeSec });
  }
  mark("window_stage4");
  const byId = new Map(args.rules.map((rule) => [rule.id, rule]));
  const fired: WindowFiredRule[] = [];
  for (const result of analysis.rules) {
    const rule = byId.get(result.ruleId);
    if (result.outcome !== "fired" || !rule) continue;
    fired.push({ id: rule.id, observed: result.observed ?? result.threshold, threshold: result.threshold, lookbackSec: rule.lookbackSec,
      thresholdBps: rule.thresholdBps, direction: rule.direction, changeMode: rule.changeMode, metric: rule.metric });
  }
  if (fired.length > 0) return done("fired", "rule_fired", { pool, poolAgeSec, fired });
  if (analysis.rules.length > 0 && analysis.rules.every((r) => r.outcome === "clear")) return done("clear", "clear", { pool, poolAgeSec });
  const other = analysis.rules.find((r) => r.outcome !== "clear");
  return done(other?.outcome === "not_evaluable" ? "not_evaluable" : "incomplete", other?.reason ?? other?.outcome ?? "no_result", { pool, poolAgeSec });
}

// ── running the check for the gated tokens ──
export interface WindowTokenTiming {
  readonly token: string;
  readonly result: string;
  readonly reason: string;
  readonly totalMs: number;
  readonly stagesMs: Record<string, number>;
}
export interface WindowRun {
  /** Present only when a rule fired. */
  readonly display?: WindowDisplay;
  readonly timings: readonly WindowTokenTiming[];
}

/**
 * Check the given tokens within the check's own deadline, counted from this
 * call. Resolves at the deadline at the latest; a result that arrives later is
 * discarded, fired or not. Never rejects.
 */
export function runWindowChecks(
  rpc: Rpc,
  tokens: readonly string[],
  options: {
    presetId: string;
    rules: readonly ChangeCountRule[];
    analyze: Analyze;
    timeoutMs?: number;
    onStage?: (phase: string, token: string) => void;
    lookups?: ReadonlyMap<string, Promise<PoolLookup>>;
  },
): { promise: Promise<WindowRun>; cancel(): void } {
  const startedAt = Date.now();
  const stageMarks = new Map<string, [string, number][]>(tokens.map((token) => [token, []]));
  let settled = false;
  let resolve!: (run: WindowRun) => void;
  const promise = new Promise<WindowRun>((done) => { resolve = done; });
  const timing = (token: string, result: string, reason: string): WindowTokenTiming => {
    const stagesMs: Record<string, number> = {};
    let previous = 0;
    for (const [stage, atMs] of stageMarks.get(token) ?? []) {
      stagesMs[stage] = atMs - previous;
      previous = atMs;
    }
    return { token, result, reason, totalMs: Date.now() - startedAt, stagesMs };
  };
  const finish = (run: WindowRun): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(run);
  };
  const timer = setTimeout(
    () => finish({ timings: tokens.map((token) => timing(token, "undetermined", "timeout")) }),
    options.timeoutMs ?? WINDOW_TIMEOUT_MS,
  );

  void Promise.all(tokens.map((token) =>
    checkWindowRules(rpc, { token, lookup: options.lookups?.get(token), rules: options.rules }, options.analyze, (phase) => {
      stageMarks.get(token)?.push([phase.replace("window_", ""), Date.now() - startedAt]);
      options.onStage?.(phase, token);
    }))).then((checks) => {
    const hit = checks.find((c) => c.result === "fired" && c.pool && c.fired?.length);
    finish({
      timings: checks.map((c) => timing(c.token, c.result, c.reason)),
      ...(hit ? { display: {
        version: 1 as const, kind: "window_rules" as const, chainId: BACKDOOR_CHAIN_ID, token: hit.token, pool: hit.pool!,
        presetId: options.presetId, poolAgeSec: hit.poolAgeSec ?? 0, rules: hit.fired!,
      } } : {}),
    });
  }).catch(() => finish({ timings: tokens.map((token) => timing(token, "undetermined", "error")) }));

  return { promise, cancel: () => finish({ timings: [] }) };
}
