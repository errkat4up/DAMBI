// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcRevert, RpcTransportError, UNISWAP_V2_FACTORY, type PoolLookup, type Rpc } from "../backdoor-check";
import { WINDOW_TIMEOUT_MS, checkWindowRules, runWindowChecks, type Analyze } from "../window-check";
import {
  DEFAULT_WINDOW_SETTINGS, NEW_POOL_MAX_AGE_SEC, WINDOW_BLOCKS, WINDOW_PRESETS, buildAnalysisRequest, effectiveRules,
  parseChangeCountRule, toEngineRule, type ChangeCountRule, type EngineAnalysis, type WindowRuleSettings,
} from "../window-rules";
import { realWindowAnalyze } from "./helpers/real-wasm";

/** A real pool at a real block where the sensitive preset fires (see the fixture's `_note`). */
interface Fixture {
  token: string; pool: string; head: { number: number; timestampMs: number }; startReserves: string;
  logs: { blockNumber: string; logIndex: string; data: string; blockTimestamp?: string }[];
  expected: { poolAgeSec: number; sensitive: { observed: number; threshold: number }; alsoStrict: boolean; alsoBalanced: boolean };
}
const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures/window-fired-mainnet.json"), "utf8")) as Fixture;
const analyze: Analyze = async (request) => realWindowAnalyze<EngineAnalysis>(request);
const SENSITIVE = WINDOW_PRESETS["window-sensitive"], STRICT = WINDOW_PRESETS["window-strict"], BALANCED = WINDOW_PRESETS["window-balanced"];
const settings = (over: Partial<WindowRuleSettings> = {}): WindowRuleSettings => ({ ...DEFAULT_WINDOW_SETTINGS, enabled: true, ...over });

/** Mock node serving the fixture. `stripTimes` models a node whose logs carry no blockTimestamp. */
function node(o: { stripTimes?: boolean; startReserves?: string; logs?: unknown; fail?: (method: string) => Error | undefined; delayMs?: number } = {}) {
  const calls: [string, unknown[]][] = [];
  const times = new Map(fx.logs.map((l) => [Number(BigInt(l.blockNumber)), l.blockTimestamp!]));
  const rpc: Rpc = async (method, params) => {
    calls.push([method, params]);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const failure = o.fail?.(method);
    if (failure) throw failure;
    if (method === "eth_getLogs") return o.logs ?? fx.logs.map((l) => (o.stripTimes ? { blockNumber: l.blockNumber, logIndex: l.logIndex, data: l.data } : l));
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      if (tag === "latest") return { number: "0x" + fx.head.number.toString(16), timestamp: "0x" + (fx.head.timestampMs / 1000).toString(16) };
      return { number: tag, timestamp: times.get(Number(BigInt(tag))) };
    }
    const tx = params[0] as { to: string; data: string };
    if (tx.data.startsWith("0xe6a43905")) return "0x" + fx.pool.slice(2).padStart(64, "0");
    if (tx.data === "0x0902f1ac") return o.startReserves ?? fx.startReserves;
    throw new RpcTransportError("unexpected " + method);
  };
  return { rpc, calls, methods: () => calls.map((c) => c[0]) };
}
const run = (rpc: Rpc, rules: readonly ChangeCountRule[] = SENSITIVE) => checkWindowRules(rpc, { token: fx.token, rules }, analyze);

describe("presets and user settings (pure)", () => {
  it("ships the three presets of the mainnet draft, new-pool side", () => {
    expect(Object.keys(WINDOW_PRESETS)).toEqual(["window-sensitive", "window-balanced", "window-strict"]);
    expect(SENSITIVE.map(toEngineRule)).toEqual([{ kind: "change_count", id: "r1-up-burst-sensitive", lookbackSec: 300, metric: "price", direction: "up", mode: "step", minChangeBps: 2000, minCount: 5 }]);
    expect(toEngineRule(BALANCED[0])).toMatchObject({ mode: "cumulative", minCount: 8 });
    expect(toEngineRule(STRICT[0])).toMatchObject({ mode: "step", minCount: 8 });
    expect(toEngineRule({ ...SENSITIVE[0], direction: "either", metric: "quote_reserve" })).toMatchObject({ direction: "both", metric: "liquidity" });
  });

  it("is off until the user turns it on, and an unknown preset runs nothing", () => {
    expect(DEFAULT_WINDOW_SETTINGS.enabled).toBe(false);
    expect(effectiveRules(settings({ presetId: "nope" }))).toEqual({ presetId: "nope", rules: [], rejected: [{ id: "nope", reason: "unknown_preset" }] });
  });

  it("merges overrides by rule id, lets a rule be switched off, and adds the user's own rules", () => {
    const merged = effectiveRules(settings({ overrides: [{ id: "r1-up-burst-sensitive", kind: "change_count", count: 3, thresholdBps: 1500 }] }));
    expect(merged.rules).toEqual([{ ...SENSITIVE[0], count: 3, thresholdBps: 1500 }]);
    expect(effectiveRules(settings({ overrides: [{ id: "r1-up-burst-sensitive", kind: "change_count", enabled: false }] })).rules).toEqual([]);
    const mine = { kind: "change_count", id: "mine", enabled: true, lookbackSec: 600, metric: "price_quote_per_token", direction: "down", changeMode: "step", thresholdBps: 3000, count: 2 };
    expect(effectiveRules(settings({ additionalRules: [mine] })).rules.map((r) => r.id)).toEqual(["r1-up-burst-sensitive", "mine"]);
  });

  it("ignores the other three rule kinds and anything out of range — an invalid edit never widens what runs", () => {
    const out = effectiveRules(settings({
      overrides: [
        { id: "r1-up-burst-sensitive", kind: "change_count", lookbackSec: NEW_POOL_MAX_AGE_SEC + 1 }, // longer than the fetched window
        { id: "r1-up-burst-sensitive", kind: "window_drop" },
        { id: "absent", kind: "change_count", count: 1 },
      ],
      additionalRules: [
        { kind: "switch_density", id: "r2", enabled: true, lookbackSec: 300 },
        { kind: "window_drop", id: "drop", enabled: true, lookbackSec: 300 },
        { kind: "event_count", id: "ev", enabled: true, lookbackSec: 300 },
        { ...SENSITIVE[0], id: "r1-up-burst-sensitive" },
        { ...SENSITIVE[0], id: "zero", count: 0 },
      ],
    }));
    expect(out.rules).toEqual(SENSITIVE);
    expect(out.rejected).toEqual([
      { id: "r1-up-burst-sensitive", reason: "lookback_out_of_range" },
      { id: "r1-up-burst-sensitive", reason: "unsupported_kind" },
      { id: "absent", reason: "override_refers_to_absent_rule" },
      { id: "r2", reason: "unsupported_kind" }, { id: "drop", reason: "unsupported_kind" }, { id: "ev", reason: "unsupported_kind" },
      { id: "r1-up-burst-sensitive", reason: "duplicate_id" }, { id: "zero", reason: "count_out_of_range" },
    ]);
    expect(parseChangeCountRule({ ...SENSITIVE[0], lookbackSec: NEW_POOL_MAX_AGE_SEC })).toMatchObject({ lookbackSec: 3600 });
  });

  it("builds the request from the first Sync on: it is the history start, the warm-up start and the pool's creation time", () => {
    const points = [{ block: 10, tMs: 1_000_000, reserveQuote: "5", reserveToken: "7" }, { block: 12, tMs: 1_024_000, reserveQuote: "6", reserveToken: "6" }];
    const request = buildAnalysisRequest({ chainId: 1, pool: fx.pool, token: fx.token, quote: "0xq", asOf: { block: 13, tMs: 1_036_000 }, points, rules: SENSITIVE });
    expect(request).toMatchObject({
      asOf: { block: "13", tMs: 1_036_000 },
      poolHistory: { fromMs: 1_000_000, bucketMs: 12_000, missing: [], warmup: { fromMs: 1_000_000, complete: true },
        points: [{ tMs: 1_000_000, reserveQuote: "5", reserveToken: "7", decimalsQuote: 18, decimalsToken: 18 }, { tMs: 1_024_000, reserveQuote: "6", reserveToken: "6", decimalsQuote: 18, decimalsToken: 18 }] },
      tokenProfile: { poolCreatedMs: 1_000_000, adminEvents: [], missing: [] },
    });
  });
});

describe("checkWindowRules on recorded mainnet data, with the real WASM", () => {
  it("fires the sensitive preset, using the block times carried by the logs", async () => {
    const n = node();
    const result = await run(n.rpc);
    expect(result).toMatchObject({ result: "fired", reason: "rule_fired", pool: fx.pool, poolAgeSec: fx.expected.poolAgeSec });
    expect(result.fired).toEqual([{ id: "r1-up-burst-sensitive", observed: fx.expected.sensitive.observed, threshold: 5,
      lookbackSec: 300, thresholdBps: 2000, direction: "up", changeMode: "step", metric: "price_quote_per_token" }]);
    // pool + head, then the window's logs and the reserves at its first block. Nothing else.
    expect(n.methods().sort()).toEqual(["eth_call", "eth_call", "eth_getBlockByNumber", "eth_getLogs"]);
    const logs = n.calls.find((c) => c[0] === "eth_getLogs")![1][0] as { address: string; fromBlock: string; toBlock: string };
    expect(logs.address).toBe(fx.pool);
    expect([Number(BigInt(logs.fromBlock)), Number(BigInt(logs.toBlock))]).toEqual([fx.head.number - WINDOW_BLOCKS, fx.head.number]);
    const reserves = n.calls.find((c) => c[0] === "eth_call" && (c[1][0] as { data: string }).data === "0x0902f1ac")!;
    expect(reserves[1][1]).toBe("0x" + (fx.head.number - WINDOW_BLOCKS).toString(16)); // AT the window's first block, not latest
  });

  it("gives the same answer when the logs carry no blockTimestamp and the times come from block headers", async () => {
    const n = node({ stripTimes: true });
    const viaHeaders = await run(n.rpc);
    expect(viaHeaders).toEqual(await run(node().rpc));
    const blocks = new Set(fx.logs.map((l) => l.blockNumber));
    const headerLookups = n.calls.filter((c) => c[0] === "eth_getBlockByNumber" && c[1][0] !== "latest").map((c) => c[1][0]);
    expect(headerLookups.sort()).toEqual([...blocks].sort()); // one per block that had a Sync, no more
  });

  it("matches the other presets as recorded", async () => {
    expect((await run(node().rpc, STRICT)).result).toBe(fx.expected.alsoStrict ? "fired" : "clear");
    expect((await run(node().rpc, BALANCED)).result).toBe(fx.expected.alsoBalanced ? "fired" : "clear");
  });

  it("shares a pool lookup instead of making its own", async () => {
    const n = node();
    const lookup: PoolLookup = { status: "ok", pool: fx.pool, head: fx.head };
    expect((await checkWindowRules(n.rpc, { token: fx.token, lookup, rules: SENSITIVE }, analyze)).result).toBe("fired");
    expect(n.methods().sort()).toEqual(["eth_call", "eth_getLogs"]);
  });
});

describe("checkWindowRules: when no rule may run", () => {
  it("fetches nothing without an active rule", async () => {
    const n = node();
    expect(await run(n.rpc, [])).toMatchObject({ result: "skipped", reason: "no_active_rule" });
    expect(n.calls).toEqual([]);
  });

  it("skips a pool that already had liquidity at the window's first block — no setting can switch a rule on there", async () => {
    const withLiquidity = "0x" + "1".padStart(64, "0") + "2".padStart(64, "0") + "0".repeat(64);
    const everyRule = effectiveRules(settings({ additionalRules: [{ ...SENSITIVE[0], id: "loose", count: 1, thresholdBps: 1 }] })).rules;
    const analyzed = vi.fn(analyze);
    const result = await checkWindowRules(node({ startReserves: withLiquidity }).rpc, { token: fx.token, rules: everyRule }, analyzed);
    expect(result).toMatchObject({ result: "skipped", reason: "pool_older_than_window" });
    expect(analyzed).not.toHaveBeenCalled();
  });

  it("skips a pool whose first liquidity is more than an hour before the head (300 blocks can span more)", async () => {
    const early = fx.logs.map((l) => ({ ...l, blockTimestamp: "0x" + (Number(BigInt(l.blockTimestamp!)) - 3400).toString(16) }));
    expect(await run(node({ logs: early }).rpc)).toMatchObject({ result: "skipped", reason: "pool_older_than_window" });
  });

  it("is not evaluable before the first liquidity, and skipped without a WETH pair", async () => {
    expect(await run(node({ logs: [] }).rpc)).toMatchObject({ result: "not_evaluable", reason: "no_liquidity_yet" });
    expect(await checkWindowRules(node().rpc, { token: fx.token, lookup: { status: "none" }, rules: SENSITIVE }, analyze)).toMatchObject({ result: "skipped", reason: "no_weth_pair" });
  });
});

describe("checkWindowRules: failures end undetermined, with a reason, and never warn", () => {
  const rateLimit = new RpcTransportError('{"code":-32005,"message":"rate limit exceeded"}');
  it.each([
    ["a rate limit on the logs", { fail: (m: string) => (m === "eth_getLogs" ? rateLimit : undefined) }, "rate_limited"],
    ["a failed log lookup", { fail: (m: string) => (m === "eth_getLogs" ? new RpcTransportError("HTTP 502") : undefined) }, "logs_unavailable"],
    ["a timed-out log lookup", { fail: (m: string) => (m === "eth_getLogs" ? new RpcTransportError("This operation was aborted") : undefined) }, "rpc_timeout"],
    ["an unreadable start state", { startReserves: "0x1234" }, "start_state_unreadable"],
    ["malformed logs", { logs: [{ blockNumber: "0x1", logIndex: "0x0", data: "0x00" }] }, "logs_malformed"],
    ["a reorged-out log", { logs: [{ ...fx.logs[0], removed: true }] }, "logs_malformed"],
  ] as const)("%s", async (_name, options, reason) => {
    const analyzed = vi.fn(analyze);
    const result = await checkWindowRules(node(options as never).rpc, { token: fx.token, rules: SENSITIVE }, analyzed);
    expect(result).toMatchObject({ result: "undetermined", reason });
    expect(result.fired).toBeUndefined();
    expect(analyzed).not.toHaveBeenCalled();
  });

  it("a revert or failure of the start-state call is never read as zero liquidity", async () => {
    const reverted = node();
    const rpc: Rpc = async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data === "0x0902f1ac") throw new RpcRevert("execution reverted");
      return reverted.rpc(method, params);
    };
    expect(await run(rpc)).toMatchObject({ result: "undetermined", reason: "start_state_unreadable" });
  });

  it("a missing block time on the header path, the head lookup and the algorithm failing are all undetermined", async () => {
    const noHeader = node({ stripTimes: true });
    const rpc: Rpc = async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] !== "latest") throw new RpcTransportError("HTTP 429 too many requests");
      return noHeader.rpc(method, params);
    };
    expect(await run(rpc)).toMatchObject({ result: "undetermined", reason: "rate_limited" });
    expect(await run(node({ fail: (m) => (m === "eth_getBlockByNumber" ? new RpcTransportError("boom") : undefined) }).rpc)).toMatchObject({ result: "undetermined", reason: "head_unavailable" });
    expect(await checkWindowRules(node().rpc, { token: fx.token, rules: SENSITIVE }, async () => { throw new Error("trap"); })).toMatchObject({ result: "undetermined", reason: "algorithm_error" });
  });
});

describe("runWindowChecks (deadline, display, timings)", () => {
  afterEach(() => vi.useRealTimers());
  const options = { presetId: "window-sensitive", rules: SENSITIVE, analyze };

  it("yields a display only when a rule fired", async () => {
    const fired = await runWindowChecks(node().rpc, [fx.token], options).promise;
    expect(fired.display).toMatchObject({ version: 1, kind: "window_rules", chainId: 1, token: fx.token, pool: fx.pool, presetId: "window-sensitive",
      poolAgeSec: fx.expected.poolAgeSec, rules: [{ id: "r1-up-burst-sensitive", observed: fx.expected.sensitive.observed, threshold: 5 }] });
    expect(fired.timings).toMatchObject([{ token: fx.token, result: "fired", reason: "rule_fired" }]);
    const quiet = await runWindowChecks(node({ logs: fx.logs.slice(0, 2) }).rpc, [fx.token], options).promise;
    expect(quiet.display).toBeUndefined();
    expect(quiet.timings[0].result).toBe("clear");
  });

  it("gives up at its own 2.5 s deadline, records how far it got, and discards a late warning", async () => {
    vi.useFakeTimers();
    const handle = runWindowChecks(node({ delayMs: 1_500 }).rpc, [fx.token], options); // two round trips = 3 s
    let settled: unknown = "pending";
    void handle.promise.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(WINDOW_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ timings: [{ token: fx.token, result: "undetermined", reason: "timeout", totalMs: WINDOW_TIMEOUT_MS, stagesMs: { stage1: 1_500 } }] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await handle.promise).display).toBeUndefined();
  });

  it("uses only read methods against the pool, the factory and block headers", async () => {
    const n = node({ stripTimes: true });
    await runWindowChecks(n.rpc, [fx.token], options).promise;
    expect(new Set(n.methods())).toEqual(new Set(["eth_call", "eth_getLogs", "eth_getBlockByNumber"]));
    const targets = n.calls.filter((c) => c[0] === "eth_call").map((c) => (c[1][0] as { to: string; from?: string }));
    expect(targets.map((t) => t.to).sort()).toEqual([fx.pool, UNISWAP_V2_FACTORY].sort());
    expect(targets.every((t) => t.from === undefined)).toBe(true);
  });
});
