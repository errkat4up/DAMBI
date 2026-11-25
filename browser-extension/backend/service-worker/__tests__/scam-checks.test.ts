// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestType, type Message } from "@lib/types";
import type { ScamDisplay } from "@lib/scam-display";
import { BACKDOOR_TIMEOUT_MS, RpcRevert, RpcTransportError, UNISWAP_V2_FACTORY, type Rpc } from "../backdoor-check";
import { GATE_TIMEOUT_MS, beginScamChecks, notHeldTokens, type ScamChecksDeps, type ScamChecksTiming } from "../scam-checks";
import { WINDOW_TIMEOUT_MS } from "../window-check";
import { DEFAULT_WINDOW_SETTINGS, type EngineAnalysis, type WindowRuleSettings, type WindowStatus } from "../window-rules";
import { realWindowAnalyze } from "./helpers/real-wasm";

// Every dependency is injected; the real SDK host and extension storage must never load.
vi.mock("../scam-filter", () => ({
  beginScamCheck: () => { throw new Error("tests inject beginSdk"); },
  scamHostConfigured: async () => { throw new Error("tests inject sdkConfigured"); },
}));
vi.mock("webextension-polyfill", () => ({
  default: { storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } },
}));
// The real WASM is loaded from disk by the test helper; the bridge's browser loader must not run.
vi.mock("../wasm-bridge", () => ({ scamWindowAnalyze: async () => { throw new Error("tests inject analyze"); } }));

const A = (n: number): string => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = A(0xb0), TOKEN2 = A(0xb1), PAIR = A(0xa0), DEPLOYER = A(0xd0), USER = A(0x51);
const pad = (a: string): string => a.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** Mock mainnet: balances per token for USER, and a flagged pool for every token. */
function chain(o: { held?: Record<string, bigint>; delayMs?: number; balanceFails?: boolean; deployerOk?: boolean } = {}) {
  const calls: [string, unknown[]][] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push([method, params]);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (method === "eth_getBlockByNumber") return { number: "0xf4240", timestamp: "0x6b000000" };
    if (method === "eth_getTransactionByHash") return { from: DEPLOYER };
    if (method === "eth_getLogs") return [{ blockNumber: "0xf4000", transactionHash: "0xabc", data: "0x" + pad(PAIR) + word(1n) }];
    const tx = params[0] as { from?: string; to: string; data: string };
    const sel = tx.data.slice(0, 10);
    if (sel === "0xe6a43905") return "0x" + pad(PAIR);
    if (sel === "0x70a08231") {
      if (!tx.data.endsWith(pad(USER))) return "0x" + word(5n); // pool balance
      if (o.balanceFails) throw new RpcTransportError("boom");
      return "0x" + word(o.held?.[tx.to] ?? 0n);
    }
    if (sel === "0x23b872dd") {
      if (tx.from === DEPLOYER && (o.deployerOk ?? true)) return "0x" + word(1n);
      throw new RpcRevert("execution reverted");
    }
    throw new RpcTransportError("unexpected " + method);
  };
  const userBalanceCalls = () => calls.filter((c) => c[0] === "eth_call" && (c[1][0] as { data: string }).data === "0x70a08231" + pad(USER));
  return { rpc, calls, userBalanceCalls };
}

const swap = (token: string) => ({ meta: {}, body: { domain: "amm", action: "swap",
  venue: { name: "uniswap_v2", chain: "eip155:1", pool: A(0), factory: A(0) },
  params: { token_out: { key: { standard: "erc20", chain: "eip155:1", address: token } } } } });
const message = (chainId = 1): Message => ({ requestId: "request-id-with-fingerprint", data: { type: RequestType.TRANSACTION, chainId, hostname: "dapp.example",
  transaction: { from: USER, to: A(0x7a), data: "0x7ff36ab5", value: "0x1" } } } as Message);
const report = (status: string): ScamDisplay => ({ version: 1, kind: "report", holding: "unknown",
  report: { status, reasons: [], targets: [], scopeNotice: "patterns_only_no_sellability_guarantee" } } as ScamDisplay);

function setup(o: { rpc: Rpc; backdoor?: boolean; sdk?: ScamDisplay | "off"; sdkDelayMs?: number; gateRpc?: Rpc | null; window?: Partial<WindowRuleSettings> }) {
  const timings: ScamChecksTiming[] = [];
  const windowStatuses: WindowStatus[] = [];
  const sdkStarts: number[] = [];
  const cancelSdk = vi.fn();
  const startedAt = Date.now();
  const deps: ScamChecksDeps = {
    backdoorEnabled: async () => o.backdoor ?? true,
    sdkConfigured: async () => o.sdk !== undefined && o.sdk !== "off",
    gateRpc: (chainId) => (o.gateRpc === null ? undefined : chainId === 1 ? o.gateRpc ?? o.rpc : undefined),
    backdoorRpc: () => o.rpc,
    beginSdk: () => {
      sdkStarts.push(Date.now() - startedAt);
      return { cancel: cancelSdk, promise: new Promise((done) => {
        const value = o.sdk === "off" ? undefined : o.sdk;
        if (o.sdkDelayMs) setTimeout(() => done(value), o.sdkDelayMs); else done(value);
      }) };
    },
    windowSettings: async () => ({ ...DEFAULT_WINDOW_SETTINGS, ...o.window }),
    analyze: async (request) => realWindowAnalyze<EngineAnalysis>(request),
    gateTimeoutMs: GATE_TIMEOUT_MS,
    backdoorTimeoutMs: BACKDOOR_TIMEOUT_MS,
    windowTimeoutMs: WINDOW_TIMEOUT_MS,
    recordTiming: (entry) => timings.push(entry),
    recordWindowStatus: (status) => windowStatuses.push(status),
  };
  return { deps, timings, sdkStarts, cancelSdk, windowStatuses };
}
async function run(msg: Message, actions: unknown[], deps: ScamChecksDeps) {
  const handle = beginScamChecks(msg, deps);
  handle.offer(actions);
  return handle.promise;
}

describe("gate: when nothing may start", () => {
  it("sends no request and starts no check without a bought token", async () => {
    const c = chain();
    const s = setup({ rpc: c.rpc, sdk: report("warn") });
    expect(await run(message(), [], s.deps)).toEqual({});
    const sell = { meta: {}, body: { domain: "amm", action: "swap", venue: { name: "uniswap_v2" }, params: { token_out: { key: { standard: "native", chain: "eip155:1" } } } } };
    expect(await run(message(), [sell], s.deps)).toEqual({});
    const typed = { requestId: "r", data: { type: RequestType.TYPED_SIGNATURE, chainId: 1, hostname: "x", address: USER, typedData: {} } } as unknown as Message;
    expect(await run(typed, [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toEqual([]);
    expect(s.sdkStarts).toEqual([]);
    expect(s.timings).toEqual([]);
  });

  it("sends not even the holding lookup when both checks are off", async () => {
    const c = chain();
    const s = setup({ rpc: c.rpc, backdoor: false, sdk: "off" });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toEqual([]);
  });

  it("starts neither check and shows nothing when the user already holds the token", async () => {
    const c = chain({ held: { [TOKEN]: 1n } });
    const s = setup({ rpc: c.rpc, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toHaveLength(1); // the holding lookup only
    expect(s.sdkStarts).toEqual([]);
    expect(s.timings).toMatchObject([{ gate: { lookup: "ok", tokens: [TOKEN], eligible: [] } }]);
    expect(s.timings[0].backdoor).toBeUndefined();
    expect(s.timings[0].sdk).toBeUndefined();
  });

  it("settles with nothing when the lifecycle decoded nothing, and on cancel", async () => {
    const s = setup({ rpc: chain().rpc, sdk: report("warn") });
    const idle = beginScamChecks(message(), s.deps);
    idle.close();
    expect(await idle.promise).toEqual({});
    const cancelled = beginScamChecks(message(), s.deps);
    cancelled.offer([swap(TOKEN)]);
    cancelled.cancel();
    expect(await cancelled.promise).toEqual({});
  });
});

describe("gate passed: both checks start", () => {
  it("returns the backdoor warning and the SDK warning", async () => {
    const c = chain();
    const s = setup({ rpc: c.rpc, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({
      scam: report("warn"),
      backdoor: { version: 1, kind: "pool_backdoor", chainId: 1, token: TOKEN, pool: PAIR, deployer: DEPLOYER },
    });
    expect(c.userBalanceCalls()).toHaveLength(1); // asked once, by the gate — not again by the backdoor check
    expect(s.sdkStarts).toHaveLength(1);
  });

  it("shows only warnings: a quiet, insufficient or unavailable SDK result opens nothing", async () => {
    const others: (ScamDisplay | "off")[] = [report("quiet"), report("insufficient"), report("not_applicable"), report("disabled"),
      { version: 1, kind: "unavailable", reason: "timeout", holding: "unknown" }];
    for (const sdk of others) {
      const s = setup({ rpc: chain({ deployerOk: false }).rpc, sdk });
      expect(await run(message(), [swap(TOKEN)], s.deps), JSON.stringify(sdk)).toEqual({});
      expect(s.sdkStarts).toHaveLength(1);
    }
  });

  it("runs only the check that is on", async () => {
    const onlySdk = setup({ rpc: chain().rpc, backdoor: false, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], onlySdk.deps)).toEqual({ scam: report("warn") });
    expect(onlySdk.timings[0].backdoor).toBeUndefined();
    const onlyBackdoor = setup({ rpc: chain().rpc, sdk: "off" });
    expect(await run(message(), [swap(TOKEN)], onlyBackdoor.deps)).toMatchObject({ backdoor: { token: TOKEN } });
    expect(onlyBackdoor.sdkStarts).toEqual([]);
    expect(onlyBackdoor.timings[0].sdk).toBeUndefined();
  });

  it("checks only the tokens the user does not hold", async () => {
    const c = chain({ held: { [TOKEN]: 7n } });
    const s = setup({ rpc: c.rpc, sdk: "off" });
    expect(await run(message(), [swap(TOKEN), swap(TOKEN2)], s.deps)).toMatchObject({ backdoor: { token: TOKEN2 } });
    expect(s.timings[0].gate).toMatchObject({ tokens: [TOKEN, TOKEN2], eligible: [TOKEN2] });
    expect(s.timings[0].backdoor?.tokens.map((t) => t.token)).toEqual([TOKEN2]);
  });

  it("off mainnet there is no holding lookup and no backdoor check; the SDK check still runs", async () => {
    const c = chain();
    const s = setup({ rpc: c.rpc, sdk: report("warn") });
    expect(await run(message(91342), [swap(TOKEN)], s.deps)).toEqual({ scam: report("warn") });
    expect(c.calls).toEqual([]);
    expect(s.timings[0]).toMatchObject({ chainId: 91342, gate: { lookup: "none", eligible: [TOKEN] } });
  });
});

describe("gate: its own 1 s limit", () => {
  afterEach(() => vi.useRealTimers());

  it("treats a failed lookup as not held and proceeds", async () => {
    const s = setup({ rpc: chain({ balanceFails: true }).rpc, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toMatchObject({ scam: report("warn"), backdoor: { token: TOKEN } });
    expect(s.timings[0].gate).toMatchObject({ lookup: "failed", eligible: [TOKEN] });
  });

  it("stops waiting after 1 s, proceeds, and gives each check its full 2.5 s from that moment", async () => {
    vi.useFakeTimers();
    const slowGate = chain({ delayMs: 60_000, held: { [TOKEN]: 1n } }); // would say "held", far too late
    const checks = chain({ delayMs: 1_000 });                           // four round trips = 4 s > 2.5 s
    const s = setup({ rpc: checks.rpc, gateRpc: slowGate.rpc, sdk: report("warn"), sdkDelayMs: 2_400 });
    const handle = beginScamChecks(message(), s.deps);
    handle.offer([swap(TOKEN)]);
    let settled: unknown = "pending";
    void handle.promise.then((v) => { settled = v; });

    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS - 1);
    expect(s.sdkStarts).toEqual([]);                 // nothing starts while the gate is still waiting
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sdkStarts).toEqual([GATE_TIMEOUT_MS]);  // both start when the gate ends

    await vi.advanceTimersByTimeAsync(2_400);        // SDK answers 2.4 s after ITS start: inside its own budget
    expect(settled).toBe("pending");                 // backdoor check still inside its 2.5 s
    await vi.advanceTimersByTimeAsync(100);          // gate end + 2.5 s
    expect(settled).toEqual({ scam: report("warn") });

    expect(s.timings).toHaveLength(1);
    expect(s.timings[0].gate).toMatchObject({ ms: GATE_TIMEOUT_MS, lookup: "timeout", eligible: [TOKEN] });
    expect(s.timings[0].sdk).toEqual({ ms: 2_400, outcome: "warn" });
    expect(s.timings[0].backdoor).toMatchObject({ ms: BACKDOOR_TIMEOUT_MS,
      tokens: [{ token: TOKEN, result: "undetermined", reason: "timeout", stagesMs: { stage1: 1_000, stage2: 1_000 } }] });
  });

  it("notHeldTokens: answered balances decide, unanswered ones stay eligible", async () => {
    vi.useFakeTimers();
    const rpc: Rpc = async (_method, params) => {
      const to = (params[0] as { to: string }).to;
      if (to === TOKEN2) await new Promise((r) => setTimeout(r, 5_000));
      return "0x" + word(to === TOKEN ? 3n : 9n);
    };
    const pending = notHeldTokens(rpc, USER, [TOKEN, TOKEN2], GATE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);
    expect(await pending).toEqual({ eligible: [TOKEN2], lookup: "partial" });
    expect(await notHeldTokens(undefined, USER, [TOKEN], GATE_TIMEOUT_MS)).toEqual({ eligible: [TOKEN], lookup: "none" });
  });
});

describe("timing record", () => {
  it("keeps the gate and each check apart and holds nothing about the user or the request", async () => {
    const s = setup({ rpc: chain().rpc, sdk: report("quiet") });
    await run(message(), [swap(TOKEN)], s.deps);
    expect(s.timings).toHaveLength(1);
    const [entry] = s.timings;
    expect(Object.keys(entry).sort()).toEqual(["at", "backdoor", "chainId", "gate", "sdk"]);
    expect(Object.keys(entry.gate).sort()).toEqual(["eligible", "lookup", "ms", "tokens"]);
    expect(entry.sdk).toEqual({ ms: expect.any(Number), outcome: "quiet" });
    expect(entry.backdoor).toMatchObject({ ms: expect.any(Number), tokens: [{ token: TOKEN, result: "flagged", stagesMs: expect.any(Object) }] });
    const text = JSON.stringify(s.timings);
    expect(text).not.toContain(USER.slice(2));
    expect(text).not.toContain("request-id-with-fingerprint");
    expect(text).not.toContain(UNISWAP_V2_FACTORY.slice(2)); // no calldata or request payload either
  });
});

describe("in-extension window rules behind the same gate", () => {
  /** The recorded mainnet case where the sensitive preset fires. */
  const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/window-fired-mainnet.json"), "utf8")) as {
    token: string; pool: string; head: { number: number; timestampMs: number }; startReserves: string; logs: unknown[];
    expected: { poolAgeSec: number; sensitive: { observed: number } } };
  function recorded(o: { held?: bigint; logsFail?: Error } = {}) {
    const calls: [string, unknown[]][] = [];
    const rpc: Rpc = async (method, params) => {
      calls.push([method, params]);
      if (method === "eth_getBlockByNumber") return { number: "0x" + fx.head.number.toString(16), timestamp: "0x" + (fx.head.timestampMs / 1000).toString(16) };
      if (method === "eth_getLogs") {
        const filter = params[0] as { address: string };
        if (filter.address === fx.pool) { if (o.logsFail) throw o.logsFail; return fx.logs; }
        return []; // PairCreated lookup of the backdoor check: nothing in range
      }
      const tx = params[0] as { to: string; data: string };
      if (tx.data.startsWith("0xe6a43905")) return "0x" + fx.pool.slice(2).padStart(64, "0");
      if (tx.data === "0x0902f1ac") return fx.startReserves;
      if (tx.data.startsWith("0x70a08231")) return "0x" + word(tx.data.endsWith(pad(USER)) ? o.held ?? 0n : 5n);
      throw new RpcTransportError("unexpected " + method);
    };
    return { rpc, calls };
  }
  const on = { enabled: true, presetId: "window-sensitive" };

  it("is off by default: nothing about window rules is fetched or recorded", async () => {
    const c = recorded();
    const s = setup({ rpc: c.rpc, backdoor: false, sdk: "off" });
    expect(await run(message(), [swap(fx.token)], s.deps)).toEqual({});
    expect(c.calls).toEqual([]);
    expect(s.windowStatuses).toEqual([]);
  });

  it("returns the warning when a rule fires, and records the outcome for the /scam page", async () => {
    const c = recorded();
    const s = setup({ rpc: c.rpc, backdoor: false, sdk: "off", window: on });
    const results = await run(message(), [swap(fx.token)], s.deps);
    expect(results).toEqual({ window: { version: 1, kind: "window_rules", chainId: 1, token: fx.token, pool: fx.pool, presetId: "window-sensitive",
      poolAgeSec: fx.expected.poolAgeSec, rules: [expect.objectContaining({ id: "r1-up-burst-sensitive", observed: fx.expected.sensitive.observed, threshold: 5 })] } });
    expect(s.windowStatuses).toEqual([{ at: expect.any(String), result: "fired", reason: "rule_fired", presetId: "window-sensitive", ms: expect.any(Number) }]);
    expect(s.timings[0].window).toMatchObject({ presetId: "window-sensitive", tokens: [{ token: fx.token, result: "fired", stagesMs: expect.any(Object) }] });
    expect(s.sdkStarts).toEqual([]);
  });

  it("with a host configuration stored, the SDK check runs and the in-extension one does not", async () => {
    const c = recorded();
    const s = setup({ rpc: c.rpc, backdoor: false, sdk: report("quiet"), window: on });
    expect(await run(message(), [swap(fx.token)], s.deps)).toEqual({});
    expect(s.sdkStarts).toHaveLength(1);
    expect(c.calls.filter((call) => call[0] === "eth_getLogs")).toEqual([]);
    expect(s.timings[0].window).toBeUndefined();
    expect(s.windowStatuses).toEqual([]);
  });

  it("shares one pool lookup with the backdoor check", async () => {
    const c = recorded();
    const s = setup({ rpc: c.rpc, sdk: "off", window: on });
    expect(await run(message(), [swap(fx.token)], s.deps)).toMatchObject({ window: { token: fx.token } });
    expect(c.calls.filter((call) => call[0] === "eth_getBlockByNumber")).toHaveLength(1);
    expect(c.calls.filter((call) => call[0] === "eth_call" && (call[1][0] as { data: string }).data.startsWith("0xe6a43905"))).toHaveLength(1);
    expect(s.timings[0].backdoor).toBeDefined();
    expect(s.timings[0].window).toBeDefined();
  });

  it("a held token, another chain, or a disabled setting never starts it", async () => {
    const held = setup({ rpc: recorded({ held: 3n }).rpc, backdoor: false, sdk: "off", window: on });
    expect(await run(message(), [swap(fx.token)], held.deps)).toEqual({});
    expect(held.windowStatuses).toEqual([]);
    const otherChain = recorded();
    expect(await run(message(91342), [swap(fx.token)], setup({ rpc: otherChain.rpc, backdoor: false, sdk: "off", window: on }).deps)).toEqual({});
    expect(otherChain.calls).toEqual([]);
    const ruleOff = setup({ rpc: recorded().rpc, backdoor: false, sdk: "off",
      window: { ...on, overrides: [{ id: "r1-up-burst-sensitive", kind: "change_count", enabled: false }] } });
    expect(await run(message(), [swap(fx.token)], ruleOff.deps)).toEqual({});
  });

  it("a rate limit ends as undetermined: no warning, and the reason reaches the timing record and the page status", async () => {
    const c = recorded({ logsFail: new RpcTransportError('{"code":-32005,"message":"rate limit exceeded"}') });
    const s = setup({ rpc: c.rpc, backdoor: false, sdk: "off", window: on });
    expect(await run(message(), [swap(fx.token)], s.deps)).toEqual({});
    expect(s.timings[0].window?.tokens).toMatchObject([{ result: "undetermined", reason: "rate_limited" }]);
    expect(s.windowStatuses).toMatchObject([{ result: "undetermined", reason: "rate_limited" }]);
    expect(JSON.stringify(s.windowStatuses)).not.toContain(fx.token.slice(2)); // the page status names no token
    expect(JSON.stringify([s.windowStatuses, s.timings])).not.toContain(USER.slice(2));
  });
});
