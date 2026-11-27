// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestType, type Message } from "@lib/types";
import type { ScamDisplay } from "@lib/scam-display";
import { SCAM_API_TIMEOUT_MS, type CheckPool, type PoolCheck, type PoolCheckRequest } from "../scam-api";
import { RpcTransportError, type Rpc } from "../scam-chain";
import { GATE_TIMEOUT_MS, beginScamChecks, notHeldTokens, type ScamChecksDeps, type ScamChecksTiming } from "../scam-checks";
import { DEFAULT_WINDOW_SETTINGS, type WindowRuleSettings, type WindowStatus } from "../window-rules";

// Every dependency is injected; the real SDK host, server client and extension storage must never load.
vi.mock("../scam-filter", () => ({
  beginScamCheck: () => { throw new Error("tests inject beginSdk"); },
  scamHostConfigured: async () => { throw new Error("tests inject sdkConfigured"); },
}));
vi.mock("../scam-api", async (original) => ({
  ...(await original<typeof import("../scam-api")>()),
  makeScamApi: () => () => { throw new Error("tests inject checkPool"); },
}));
vi.mock("../dambi-auth/client", () => ({ getServerBaseUrl: () => "https://server.invalid" }));
vi.mock("webextension-polyfill", () => ({
  default: { storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } },
}));

const A = (n: number): string => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = A(0xb0), TOKEN2 = A(0xb1), PAIR = A(0xa0), DEPLOYER = A(0xd0), USER = A(0x51);
const pad = (a: string): string => a.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** The chain as the gate sees it: `balanceOf(USER)` per token. Nothing else may be asked of it. */
function chain(o: { held?: Record<string, bigint>; delayMs?: number; balanceFails?: boolean } = {}) {
  const calls: [string, unknown[]][] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push([method, params]);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const tx = params[0] as { to: string; data: string };
    if (method !== "eth_call" || tx.data !== "0x70a08231" + pad(USER)) throw new Error("the extension asks the chain only for the user's balance");
    if (o.balanceFails) throw new RpcTransportError("boom");
    return "0x" + word(o.held?.[tx.to] ?? 0n);
  };
  return { rpc, calls };
}

type Answer = Extract<PoolCheck, { ok: true }>["answer"];
const flagged = { result: "flagged", reason: "fired", deployer: DEPLOYER };
const clear = { result: "clear", reason: "clear" };
const windowOff = { result: "off", reason: "no_active_rule", rules: [] };
const windowFired = { result: "fired", reason: "rule_fired", poolAgeSec: 300, rules: [{ id: "r1-up-burst-sensitive", outcome: "fired", observed: 8, threshold: 5 }] };
const answer = (over: Partial<Answer> = {}): PoolCheck => ({ ok: true, answer: { pool: PAIR, backdoor: flagged, window: windowOff, ...over } });

/** The server: answers per token, optionally late. Records exactly what it was sent. */
function server(respond: (request: PoolCheckRequest) => PoolCheck = () => answer(), delayMs = 0) {
  const requests: PoolCheckRequest[] = [];
  const checkPool: CheckPool = async (request) => {
    requests.push(request);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return respond(request);
  };
  return { checkPool, requests };
}

const swap = (token: string) => ({ meta: {}, body: { domain: "amm", action: "swap",
  venue: { name: "uniswap_v2", chain: "eip155:1", pool: A(0), factory: A(0) },
  params: { token_out: { key: { standard: "erc20", chain: "eip155:1", address: token } } } } });
const message = (chainId = 1): Message => ({ requestId: "request-id-with-fingerprint", data: { type: RequestType.TRANSACTION, chainId, hostname: "dapp.example",
  transaction: { from: USER, to: A(0x7a), data: "0x7ff36ab5", value: "0xde0b6b3a7640000" } } } as Message);
const report = (status: string): ScamDisplay => ({ version: 1, kind: "report", holding: "unknown",
  report: { status, reasons: [], targets: [], scopeNotice: "patterns_only_no_sellability_guarantee" } } as ScamDisplay);

function setup(o: { rpc?: Rpc; checkPool?: CheckPool; backdoor?: boolean; sdk?: ScamDisplay | "off"; sdkDelayMs?: number; gateRpc?: Rpc | null; window?: Partial<WindowRuleSettings> } = {}) {
  const timings: ScamChecksTiming[] = [];
  const windowStatuses: WindowStatus[] = [];
  const sdkStarts: number[] = [];
  const cancelSdk = vi.fn();
  const startedAt = Date.now();
  const rpc = o.rpc ?? chain().rpc;
  const deps: ScamChecksDeps = {
    backdoorEnabled: async () => o.backdoor ?? true,
    sdkConfigured: async () => o.sdk !== undefined && o.sdk !== "off",
    gateRpc: (chainId) => (o.gateRpc === null ? undefined : chainId === 1 ? o.gateRpc ?? rpc : undefined),
    checkPool: o.checkPool ?? server().checkPool,
    beginSdk: () => {
      sdkStarts.push(Date.now() - startedAt);
      return { cancel: cancelSdk, promise: new Promise((done) => {
        const value = o.sdk === "off" ? undefined : o.sdk;
        if (o.sdkDelayMs) setTimeout(() => done(value), o.sdkDelayMs); else done(value);
      }) };
    },
    windowSettings: async () => ({ ...DEFAULT_WINDOW_SETTINGS, ...o.window }),
    gateTimeoutMs: GATE_TIMEOUT_MS,
    poolCheckTimeoutMs: SCAM_API_TIMEOUT_MS,
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
    const c = chain(), srv = server();
    const s = setup({ rpc: c.rpc, checkPool: srv.checkPool, sdk: report("warn") });
    expect(await run(message(), [], s.deps)).toEqual({});
    const sell = { meta: {}, body: { domain: "amm", action: "swap", venue: { name: "uniswap_v2" }, params: { token_out: { key: { standard: "native", chain: "eip155:1" } } } } };
    expect(await run(message(), [sell], s.deps)).toEqual({});
    const typed = { requestId: "r", data: { type: RequestType.TYPED_SIGNATURE, chainId: 1, hostname: "x", address: USER, typedData: {} } } as unknown as Message;
    expect(await run(typed, [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toEqual([]);
    expect(srv.requests).toEqual([]);
    expect(s.sdkStarts).toEqual([]);
    expect(s.timings).toEqual([]);
  });

  it("sends not even the holding lookup when every check is off", async () => {
    const c = chain(), srv = server();
    const s = setup({ rpc: c.rpc, checkPool: srv.checkPool, backdoor: false, sdk: "off" });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toEqual([]);
    expect(srv.requests).toEqual([]);
  });

  it("asks the server nothing and shows nothing when the user already holds the token", async () => {
    const c = chain({ held: { [TOKEN]: 1n } }), srv = server();
    const s = setup({ rpc: c.rpc, checkPool: srv.checkPool, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(c.calls).toHaveLength(1); // the holding lookup only
    expect(srv.requests).toEqual([]);
    expect(s.sdkStarts).toEqual([]);
    expect(s.timings).toMatchObject([{ gate: { lookup: "ok", tokens: [TOKEN], eligible: [] } }]);
    expect(s.timings[0].server).toBeUndefined();
    expect(s.timings[0].sdk).toBeUndefined();
  });

  it("settles with nothing when the lifecycle decoded nothing, and on cancel", async () => {
    const s = setup({ sdk: report("warn") });
    const idle = beginScamChecks(message(), s.deps);
    idle.close();
    expect(await idle.promise).toEqual({});
    const cancelled = beginScamChecks(message(), s.deps);
    cancelled.offer([swap(TOKEN)]);
    cancelled.cancel();
    expect(await cancelled.promise).toEqual({});
  });
});

describe("gate passed: the server is asked", () => {
  it("returns the backdoor warning and the SDK warning", async () => {
    const srv = server();
    const s = setup({ checkPool: srv.checkPool, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({
      scam: report("warn"),
      backdoor: { version: 1, kind: "pool_backdoor", chainId: 1, token: TOKEN, pool: PAIR, deployer: DEPLOYER },
    });
    expect(srv.requests).toEqual([{ token: TOKEN, backdoor: true, rules: [] }]);
    expect(s.sdkStarts).toHaveLength(1);
  });

  it("sends the server the token and the rules, and nothing about the user or the transaction", async () => {
    const srv = server();
    const s = setup({ checkPool: srv.checkPool, sdk: "off", window: { enabled: true, presetId: "window-sensitive" } });
    await run(message(), [swap(TOKEN)], s.deps);
    expect(srv.requests).toHaveLength(1);
    expect(Object.keys(srv.requests[0]).sort()).toEqual(["backdoor", "rules", "token"]);
    const sent = JSON.stringify(srv.requests);
    expect(sent).not.toContain(USER.slice(2));
    expect(sent).not.toContain("de0b6b3a7640000");           // the amount
    expect(sent).not.toContain("7ff36ab5");                  // the calldata
    expect(sent).not.toContain("request-id-with-fingerprint");
    expect(sent).not.toContain("dapp.example");
  });

  it("shows only warnings: clear, undetermined, skipped and a failed server open nothing", async () => {
    const quiet: PoolCheck[] = [
      answer({ backdoor: clear }),
      answer({ backdoor: { result: "undetermined", reason: "control_also_succeeds" } }),
      answer({ pool: null, backdoor: { result: "skipped", reason: "no_weth_pair" } }),
      answer({ backdoor: { result: "flagged", reason: "fired" } }),            // flagged without a deployer is not shown
      { ok: false, reason: "server_unavailable" }, { ok: false, reason: "rate_limited" }, { ok: false, reason: "bad_response" },
    ];
    for (const check of quiet) {
      const s = setup({ checkPool: server(() => check).checkPool, sdk: "off" });
      expect(await run(message(), [swap(TOKEN)], s.deps), JSON.stringify(check)).toEqual({});
    }
    const others: ScamDisplay[] = [report("quiet"), report("insufficient"), report("not_applicable"), report("disabled"),
      { version: 1, kind: "unavailable", reason: "timeout", holding: "unknown" }];
    for (const sdk of others) {
      const s = setup({ checkPool: server(() => answer({ backdoor: clear })).checkPool, sdk });
      expect(await run(message(), [swap(TOKEN)], s.deps), JSON.stringify(sdk)).toEqual({});
      expect(s.sdkStarts).toHaveLength(1);
    }
  });

  it("a server that throws is a failed check, not a failed request", async () => {
    const s = setup({ checkPool: async () => { throw new Error("boom"); }, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({ scam: report("warn") });
    expect(s.timings[0].server?.tokens).toMatchObject([{ token: TOKEN, backdoor: { result: "undetermined", reason: "server_unavailable" } }]);
  });

  it("runs only the check that is on", async () => {
    const sdkOnly = server();
    const onlySdk = setup({ checkPool: sdkOnly.checkPool, backdoor: false, sdk: report("warn") });
    expect(await run(message(), [swap(TOKEN)], onlySdk.deps)).toEqual({ scam: report("warn") });
    expect(sdkOnly.requests).toEqual([]);
    expect(onlySdk.timings[0].server).toBeUndefined();
    const onlyBackdoor = setup({ sdk: "off" });
    expect(await run(message(), [swap(TOKEN)], onlyBackdoor.deps)).toMatchObject({ backdoor: { token: TOKEN } });
    expect(onlyBackdoor.sdkStarts).toEqual([]);
    expect(onlyBackdoor.timings[0].sdk).toBeUndefined();
  });

  it("asks only about the tokens the user does not hold", async () => {
    const c = chain({ held: { [TOKEN]: 7n } }), srv = server();
    const s = setup({ rpc: c.rpc, checkPool: srv.checkPool, sdk: "off" });
    expect(await run(message(), [swap(TOKEN), swap(TOKEN2)], s.deps)).toMatchObject({ backdoor: { token: TOKEN2 } });
    expect(srv.requests.map((r) => r.token)).toEqual([TOKEN2]);
    expect(s.timings[0].gate).toMatchObject({ tokens: [TOKEN, TOKEN2], eligible: [TOKEN2] });
    expect(s.timings[0].server?.tokens.map((t) => t.token)).toEqual([TOKEN2]);
  });

  it("off mainnet there is no holding lookup and no server check; the SDK check still runs", async () => {
    const c = chain(), srv = server();
    const s = setup({ rpc: c.rpc, checkPool: srv.checkPool, sdk: report("warn") });
    expect(await run(message(91342), [swap(TOKEN)], s.deps)).toEqual({ scam: report("warn") });
    expect(c.calls).toEqual([]);
    expect(srv.requests).toEqual([]);
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
    const slowServer = server(() => answer(), 4_000);                   // would say "flagged", after the deadline
    const s = setup({ gateRpc: slowGate.rpc, checkPool: slowServer.checkPool, sdk: report("warn"), sdkDelayMs: 2_400 });
    const handle = beginScamChecks(message(), s.deps);
    handle.offer([swap(TOKEN)]);
    let settled: unknown = "pending";
    void handle.promise.then((v) => { settled = v; });

    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS - 1);
    expect(s.sdkStarts).toEqual([]);                 // nothing starts while the gate is still waiting
    expect(slowServer.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sdkStarts).toEqual([GATE_TIMEOUT_MS]);  // both start when the gate ends
    expect(slowServer.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_400);        // SDK answers 2.4 s after ITS start: inside its own budget
    expect(settled).toBe("pending");                 // the server check is still inside its 2.5 s
    await vi.advanceTimersByTimeAsync(100);          // gate end + 2.5 s
    expect(settled).toEqual({ scam: report("warn") }); // the late "flagged" is discarded

    expect(s.timings).toHaveLength(1);
    expect(s.timings[0].gate).toMatchObject({ ms: GATE_TIMEOUT_MS, lookup: "timeout", eligible: [TOKEN] });
    expect(s.timings[0].sdk).toEqual({ ms: 2_400, outcome: "warn" });
    expect(s.timings[0].server).toEqual({ ms: SCAM_API_TIMEOUT_MS,
      tokens: [{ token: TOKEN, ms: SCAM_API_TIMEOUT_MS, backdoor: { result: "undetermined", reason: "timeout" } }] });
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
    const s = setup({ sdk: report("quiet") });
    await run(message(), [swap(TOKEN)], s.deps);
    expect(s.timings).toHaveLength(1);
    const [entry] = s.timings;
    expect(Object.keys(entry).sort()).toEqual(["at", "chainId", "gate", "sdk", "server"]);
    expect(Object.keys(entry.gate).sort()).toEqual(["eligible", "lookup", "ms", "tokens"]);
    expect(entry.sdk).toEqual({ ms: expect.any(Number), outcome: "quiet" });
    expect(entry.server).toEqual({ ms: expect.any(Number), tokens: [{ token: TOKEN, ms: expect.any(Number), backdoor: { result: "flagged", reason: "fired" } }] });
    const text = JSON.stringify(s.timings);
    expect(text).not.toContain(USER.slice(2));
    expect(text).not.toContain("request-id-with-fingerprint");
    expect(text).not.toContain(DEPLOYER.slice(2)); // only results and reasons, not what the server found
  });
});

describe("window rules behind the same gate", () => {
  const on = { enabled: true, presetId: "window-sensitive" };
  const sensitive = { kind: "change_count", id: "r1-up-burst-sensitive", enabled: true, lookbackSec: 300, metric: "price_quote_per_token",
    direction: "up", changeMode: "step", thresholdBps: 2000, count: 5 };

  it("is off by default: no rule is sent and nothing is recorded", async () => {
    const srv = server(() => answer({ backdoor: clear }));
    const s = setup({ checkPool: srv.checkPool, sdk: "off" });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(srv.requests).toEqual([{ token: TOKEN, backdoor: true, rules: [] }]);
    expect(s.windowStatuses).toEqual([]);
    expect(s.timings[0].server?.tokens[0].window).toBeUndefined();
  });

  it("returns the warning when a rule fires, and records the outcome for the /scam page", async () => {
    const srv = server(() => answer({ backdoor: { result: "off", reason: "not_requested" }, window: windowFired }));
    const s = setup({ checkPool: srv.checkPool, backdoor: false, sdk: "off", window: on });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({ window: { version: 1, kind: "window_rules", chainId: 1, token: TOKEN, pool: PAIR,
      presetId: "window-sensitive", poolAgeSec: 300,
      rules: [{ id: "r1-up-burst-sensitive", observed: 8, threshold: 5, lookbackSec: 300, thresholdBps: 2000, direction: "up", changeMode: "step", metric: "price_quote_per_token" }] } });
    expect(srv.requests).toEqual([{ token: TOKEN, backdoor: false, rules: [sensitive] }]);
    expect(s.windowStatuses).toEqual([{ at: expect.any(String), result: "fired", reason: "rule_fired", presetId: "window-sensitive", ms: expect.any(Number) }]);
    expect(s.timings[0].server).toMatchObject({ presetId: "window-sensitive", tokens: [{ token: TOKEN, window: { result: "fired", reason: "rule_fired" } }] });
    expect(s.timings[0].server?.tokens[0].backdoor).toBeUndefined();
    expect(s.sdkStarts).toEqual([]);
  });

  it("both checks travel in one request per token", async () => {
    const srv = server(() => answer({ window: windowFired }));
    const s = setup({ checkPool: srv.checkPool, sdk: "off", window: on });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toMatchObject({ backdoor: { token: TOKEN }, window: { token: TOKEN } });
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]).toMatchObject({ backdoor: true, rules: [{ id: "r1-up-burst-sensitive" }] });
  });

  it("ignores a fired rule the extension did not send, and a fired answer without a pool", async () => {
    const stranger = { ...windowFired, rules: [{ id: "someone-elses-rule", outcome: "fired", observed: 9, threshold: 1 }] };
    for (const check of [answer({ backdoor: clear, window: stranger }), answer({ pool: null, backdoor: clear, window: windowFired })]) {
      const s = setup({ checkPool: server(() => check).checkPool, backdoor: false, sdk: "off", window: on });
      expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    }
  });

  it("with a host configuration stored, the SDK check runs and no rule is sent to the server", async () => {
    const srv = server(() => answer({ backdoor: clear, window: windowFired }));
    const s = setup({ checkPool: srv.checkPool, sdk: report("quiet"), window: on });
    expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
    expect(s.sdkStarts).toHaveLength(1);
    expect(srv.requests).toEqual([{ token: TOKEN, backdoor: true, rules: [] }]);
    expect(s.windowStatuses).toEqual([]);
  });

  it("a held token, another chain, or a disabled setting never starts it", async () => {
    const heldServer = server();
    const held = setup({ rpc: chain({ held: { [TOKEN]: 3n } }).rpc, checkPool: heldServer.checkPool, backdoor: false, sdk: "off", window: on });
    expect(await run(message(), [swap(TOKEN)], held.deps)).toEqual({});
    expect(heldServer.requests).toEqual([]);
    expect(held.windowStatuses).toEqual([]);
    const otherChain = server();
    expect(await run(message(91342), [swap(TOKEN)], setup({ checkPool: otherChain.checkPool, backdoor: false, sdk: "off", window: on }).deps)).toEqual({});
    expect(otherChain.requests).toEqual([]);
    const ruleOffServer = server();
    const ruleOff = setup({ checkPool: ruleOffServer.checkPool, backdoor: false, sdk: "off",
      window: { ...on, overrides: [{ id: "r1-up-burst-sensitive", kind: "change_count", enabled: false }] } });
    expect(await run(message(), [swap(TOKEN)], ruleOff.deps)).toEqual({});
    expect(ruleOffServer.requests).toEqual([]);
  });

  it("an undetermined answer or a failed server shows no warning, and the reason reaches the timing record and the page status", async () => {
    const cases: [PoolCheck, string][] = [
      [answer({ backdoor: clear, window: { result: "undetermined", reason: "rate_limited", rules: [] } }), "rate_limited"],
      [{ ok: false, reason: "server_unavailable" }, "server_unavailable"],
    ];
    for (const [check, reason] of cases) {
      const s = setup({ checkPool: server(() => check).checkPool, backdoor: false, sdk: "off", window: on });
      expect(await run(message(), [swap(TOKEN)], s.deps)).toEqual({});
      expect(s.timings[0].server?.tokens).toMatchObject([{ window: { result: "undetermined", reason } }]);
      expect(s.windowStatuses).toMatchObject([{ result: "undetermined", reason }]);
      expect(JSON.stringify(s.windowStatuses)).not.toContain(TOKEN.slice(2)); // the page status names no token
      expect(JSON.stringify([s.windowStatuses, s.timings])).not.toContain(USER.slice(2));
    }
  });
});
