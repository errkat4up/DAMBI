// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluatePoolBackdoor,
  backdoorResult,
  type CallObservation,
  type PoolBackdoorObservation,
} from "../backdoor-decision";
import {
  BACKDOOR_TIMEOUT_MS,
  CONTROL_ADDRESS,
  MAX_POOL_AGE_BLOCKS,
  RpcRevert,
  RpcTransportError,
  UNISWAP_V2_FACTORY,
  WETH,
  boughtTokens,
  checkPoolBackdoor,
  runBackdoorChecks,
  makeHttpRpc,
  isRevertError,
  type Rpc,
} from "../backdoor-check";

const A = (n: number): string => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = A(0xb0), PAIR = A(0xa0), DEPLOYER = A(0xd0), USER = A(0x51);
const pad = (a: string): string => a.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");

interface Chain {
  userBalance?: bigint;
  poolBalance?: bigint;
  deployerOk?: boolean;
  controlOk?: boolean;
  returnsFalse?: boolean;
  pair?: string;
  createdBlock?: number;
  head?: number;
  fail?: (method: string, params: unknown[]) => boolean;
}

/** Mock chain with one token and one token/WETH pair. */
function mockRpc(c: Chain = {}): Rpc & { calls: [string, unknown[]][] } {
  const head = c.head ?? 1_000_000, createdBlock = c.createdBlock ?? head - 100, pair = c.pair ?? PAIR;
  const calls: [string, unknown[]][] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push([method, params]);
    if (c.fail?.(method, params)) throw new RpcTransportError("boom");
    if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6b000000" };
    if (method === "eth_getTransactionByHash") return { from: DEPLOYER, hash: params[0] };
    if (method === "eth_getLogs") {
      const f = params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
      const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock));
      return f.address === UNISWAP_V2_FACTORY && lo <= createdBlock && createdBlock <= hi
        ? [{ blockNumber: "0x" + createdBlock.toString(16), transactionHash: "0xabc", data: "0x" + pad(PAIR) + word(1n) }]
        : [];
    }
    if (method === "eth_call") {
      const tx = params[0] as { from?: string; to: string; data: string };
      const sel = tx.data.slice(0, 10);
      if (sel === "0xe6a43905") return "0x" + pad(pair);
      if (sel === "0x70a08231") {
        return "0x" + word(tx.data.endsWith(pad(USER)) ? c.userBalance ?? 0n : c.poolBalance ?? 5n);
      }
      if (sel === "0x23b872dd") {
        const ok = tx.from === DEPLOYER ? c.deployerOk : c.controlOk;
        if (!ok) throw new RpcRevert("execution reverted: ERC20: transfer amount exceeds allowance");
        return "0x" + word(c.returnsFalse ? 0n : 1n);
      }
    }
    throw new RpcTransportError("unexpected " + method);
  }) as Rpc & { calls: [string, unknown[]][] };
  rpc.calls = calls;
  return rpc;
}
const check = (c: Chain = {}) => checkPoolBackdoor(mockRpc(c), { token: TOKEN });

describe("evaluatePoolBackdoor (pure decision)", () => {
  const obs = (dep: CallObservation, ctl: CallObservation, over: Partial<PoolBackdoorObservation> = {}): PoolBackdoorObservation =>
    ({ deployer: DEPLOYER, control: CONTROL_ADDRESS, poolTokenBalance: "5", deployerCall: dep, controlCall: ctl, ...over });

  it("follows the decision table of the Rust draft", () => {
    expect(evaluatePoolBackdoor(obs("succeeded", "refused"))).toEqual({ outcome: "fired" });
    expect(evaluatePoolBackdoor(obs("refused", "refused"))).toEqual({ outcome: "clear" });
    expect(evaluatePoolBackdoor(obs("refused", "succeeded"))).toEqual({ outcome: "clear" });
    expect(evaluatePoolBackdoor(obs("succeeded", "succeeded"))).toEqual({ outcome: "incomplete", reason: "control_also_succeeds" });
    for (const [dep, ctl] of [["unavailable", "refused"], ["succeeded", "unavailable"], ["refused", "unavailable"], ["unavailable", "unavailable"]] as const) {
      expect(evaluatePoolBackdoor(obs(dep, ctl))).toEqual({ outcome: "incomplete", reason: "call_unavailable" });
    }
  });

  it("never fires without a deployer, a readable positive pool balance, and a distinct control", () => {
    const fired = ["succeeded", "refused"] as const;
    expect(evaluatePoolBackdoor(obs(...fired, { deployer: null }))).toEqual({ outcome: "not_evaluable", reason: "no_creation_evidence" });
    expect(evaluatePoolBackdoor(obs(...fired, { deployer: CONTROL_ADDRESS.toUpperCase().replace("0X", "0x") })).reason).toBe("deployer_is_control");
    expect(evaluatePoolBackdoor(obs(...fired, { poolTokenBalance: null })).reason).toBe("balance_unavailable");
    expect(evaluatePoolBackdoor(obs(...fired, { poolTokenBalance: "0x5" })).reason).toBe("balance_unavailable");
    expect(evaluatePoolBackdoor(obs(...fired, { poolTokenBalance: "000" })).reason).toBe("pool_empty");
  });

  it("maps outcomes onto flagged / clear / undetermined", () => {
    expect(backdoorResult({ outcome: "fired" })).toBe("flagged");
    expect(backdoorResult({ outcome: "clear" })).toBe("clear");
    expect(backdoorResult({ outcome: "incomplete" })).toBe("undetermined");
    expect(backdoorResult({ outcome: "not_evaluable" })).toBe("undetermined");
  });
});

describe("revert vs node failure", () => {
  it("classifies JSON-RPC errors", () => {
    expect(isRevertError({ code: 3, message: "execution reverted: Trading not open, try again later" })).toBe(true);
    expect(isRevertError({ code: 3, message: "execution reverted: timeout" })).toBe(true);
    expect(isRevertError({ code: -32000, message: "execution reverted" })).toBe(true);
    expect(isRevertError({ code: -32000, message: "execution aborted (timeout = 5s)" })).toBe(false);
    expect(isRevertError({ code: -32005, message: "rate limit exceeded" })).toBe(false);
    expect(isRevertError({ code: -32000, message: "header not found" })).toBe(false);
  });

  it("reads a revert only from a JSON-RPC error object, never from HTTP or transport failures", async () => {
    const respond = (body: unknown, status = 200) => makeHttpRpc("https://rpc.example", {
      fetchImpl: (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch });
    expect(await respond({ jsonrpc: "2.0", id: 1, result: "0x01" })("eth_call", [])).toBe("0x01");
    await expect(respond({ error: { code: 3, message: "execution reverted: ERC20: insufficient allowance" } })("eth_call", [])).rejects.toBeInstanceOf(RpcRevert);
    await expect(respond({ error: { code: -32000, message: "execution reverted" } })("eth_call", [])).rejects.toBeInstanceOf(RpcRevert);
    await expect(respond({ error: { code: -32000, message: "execution aborted (timeout = 5s)" } })("eth_call", [])).rejects.toBeInstanceOf(RpcTransportError);
    await expect(respond({ error: { code: 429, message: "Your app has exceeded its compute units per second capacity" } })("eth_call", [])).rejects.toBeInstanceOf(RpcTransportError);
    await expect(respond("<html>525 execution reverted</html>", 525)("eth_call", [])).rejects.toBeInstanceOf(RpcTransportError);
    const down = makeHttpRpc("https://rpc.example", { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(down("eth_call", [])).rejects.toBeInstanceOf(RpcTransportError);
  });

  it("sends plain JSON-RPC to the given endpoint and keeps the sender", async () => {
    const seen: { url: string; body: { method: string; params: unknown[] } }[] = [];
    const rpc = makeHttpRpc("https://rpc.example", { fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ result: "0x" }));
    }) as typeof fetch });
    await rpc("eth_call", [{ from: DEPLOYER, to: TOKEN, data: "0x" }, "latest"]);
    expect(seen).toEqual([{ url: "https://rpc.example", body: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: DEPLOYER, to: TOKEN, data: "0x" }, "latest"] } }]);
  });
});

describe("boughtTokens (reuses the decoded Action[])", () => {
  const swap = (tokenOut: unknown, venue: unknown = { name: "uniswap_v2", chain: "eip155:1", pool: PAIR, factory: UNISWAP_V2_FACTORY }) =>
    ({ meta: {}, body: { domain: "amm", action: "swap", venue, params: { token_in: { key: { standard: "native", chain: "eip155:1" } }, token_out: tokenOut } } });
  const erc20 = (address: string) => ({ key: { standard: "erc20", chain: "eip155:1", address } });

  it("returns the bought token of a Uniswap V2 swap, lowercased", () => {
    expect(boughtTokens([swap(erc20(TOKEN.toUpperCase().replace("0X", "0x")))], 1)).toEqual([TOKEN]);
  });
  it("ignores WETH, native output, unknown output, other venues and V2 forks", () => {
    expect(boughtTokens([swap(erc20(WETH))], 1)).toEqual([]);
    expect(boughtTokens([swap({ key: { standard: "native", chain: "eip155:1" } })], 1)).toEqual([]);
    expect(boughtTokens([swap(undefined)], 1)).toEqual([]);
    expect(boughtTokens([swap(erc20(TOKEN), { name: "uniswap_v3", chain: "eip155:1", pool: PAIR, fee_tier_bp: 3000 })], 1)).toEqual([]);
    expect(boughtTokens([swap(erc20(TOKEN), { name: "uniswap_v2", chain: "eip155:1", pool: PAIR, factory: A(0xf0) })], 1)).toEqual([]);
    expect(boughtTokens(undefined, 1)).toEqual([]);
  });
  it("keeps WETH and other factories in scope off mainnet, where those constants do not apply", () => {
    expect(boughtTokens([swap(erc20(WETH))], 91342)).toEqual([WETH]);
    expect(boughtTokens([swap(erc20(TOKEN), { name: "uniswap_v2", chain: "eip155:91342", pool: PAIR, factory: A(0xf0) })], 91342)).toEqual([TOKEN]);
  });
  it("walks multicall children and de-duplicates", () => {
    const batch = { meta: {}, body: { domain: "multicall", actions: [swap(erc20(TOKEN)), swap(erc20(TOKEN)).body] } };
    expect(boughtTokens([batch], 1)).toEqual([TOKEN]);
  });
});

describe("checkPoolBackdoor (lookup)", () => {
  it("flags only when the deployer succeeds and the control is refused", async () => {
    expect(await check({ deployerOk: true })).toMatchObject({ result: "flagged", pool: PAIR, deployer: DEPLOYER });
    expect((await check({})).result).toBe("clear");
    expect(await check({ deployerOk: true, controlOk: true })).toMatchObject({ result: "undetermined", reason: "control_also_succeeds" });
    expect((await check({ deployerOk: true, returnsFalse: true })).result).toBe("clear");
  });

  it("is undetermined for an empty pool, a pool older than 30 days, and any failed lookup", async () => {
    expect(await check({ deployerOk: true, poolBalance: 0n })).toMatchObject({ result: "undetermined", reason: "pool_empty" });
    expect(await check({ deployerOk: true, head: 1_000_000, createdBlock: 1_000_000 - MAX_POOL_AGE_BLOCKS - 1 }))
      .toMatchObject({ result: "undetermined", reason: "no_creation_evidence" });
    expect((await check({ deployerOk: true, head: 1_000_000, createdBlock: 1_000_000 - MAX_POOL_AGE_BLOCKS })).result).toBe("flagged");
    expect(await check({ pair: A(0) })).toMatchObject({ result: "skipped", reason: "no_weth_pair" });
    expect(await check({ pair: A(0xa1), deployerOk: true })).toMatchObject({ result: "undetermined", reason: "pair_mismatch" });
    for (const method of ["eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionByHash"]) {
      expect((await check({ deployerOk: true, fail: (m) => m === method })).result, method).toBe("undetermined");
    }
    // A node failure on the control call must never read as "the control was refused".
    const controlFails = (m: string, p: unknown[]) => m === "eth_call" && (p[0] as { from?: string }).from === CONTROL_ADDRESS;
    expect(await check({ deployerOk: true, fail: controlFails })).toMatchObject({ result: "undetermined", reason: "call_unavailable" });
    expect((await check({ deployerOk: true, fail: () => true })).result).toBe("undetermined");
  });

  it("sends exactly transferFrom(pool, caller, 1) from the caller, and only read methods", async () => {
    const rpc = mockRpc({ deployerOk: true });
    await checkPoolBackdoor(rpc, { token: TOKEN });
    const sims = rpc.calls.filter((c) => c[0] === "eth_call").map((c) => c[1][0] as { from?: string; to: string; data: string })
      .filter((tx) => tx.data.startsWith("0x23b872dd"));
    expect(sims.map((tx) => tx.from).sort()).toEqual([CONTROL_ADDRESS, DEPLOYER].sort());
    for (const tx of sims) {
      expect(tx.to).toBe(TOKEN);
      expect(tx.data).toBe("0x23b872dd" + pad(PAIR) + pad(tx.from!) + word(1n));
    }
    expect(new Set(rpc.calls.map((c) => c[0]))).toEqual(new Set(["eth_call", "eth_getLogs", "eth_getTransactionByHash", "eth_getBlockByNumber"]));
    const logs = rpc.calls.find((c) => c[0] === "eth_getLogs")![1][0] as { topics: string[]; fromBlock: string };
    expect(logs.topics.slice(1)).toEqual(["0x" + pad(TOKEN), "0x" + pad(WETH)]); // token0 < token1
    expect(Number(BigInt(logs.fromBlock))).toBe(1_000_000 - MAX_POOL_AGE_BLOCKS);
    // Whether the user holds the token is the shared gate's question, not this module's.
    expect(rpc.calls.some((c) => c[0] === "eth_call" && (c[1][0] as { data: string }).data.endsWith(pad(USER)))).toBe(false);
  });
});

describe("runBackdoorChecks (deadline and timings)", () => {
  afterEach(() => vi.useRealTimers());
  const paced = (ms: number, chain: Chain = { deployerOk: true }): Rpc => {
    const inner = mockRpc(chain);
    return async (method, params) => {
      await new Promise((r) => setTimeout(r, ms));
      return inner(method, params);
    };
  };

  it("yields a display only for a flagged pool", async () => {
    expect((await runBackdoorChecks(mockRpc({ deployerOk: true }), [TOKEN]).promise).display)
      .toEqual({ version: 1, kind: "pool_backdoor", chainId: 1, token: TOKEN, pool: PAIR, deployer: DEPLOYER });
    for (const chain of [{}, { deployerOk: true, controlOk: true }, { deployerOk: true, fail: () => true }] as Chain[]) {
      expect((await runBackdoorChecks(mockRpc(chain), [TOKEN]).promise).display).toBeUndefined();
    }
  });

  it("records how long each round trip took", async () => {
    vi.useFakeTimers();
    const run = runBackdoorChecks(paced(100), [TOKEN]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await run.promise).timings).toEqual([{ token: TOKEN, result: "flagged", reason: "fired", totalMs: 400,
      stagesMs: { stage1: 100, stage2: 100, stage3: 100, stage4: 100 } }]);
  });

  it("gives up at its own deadline, records how far it got, and discards a late flagged result", async () => {
    vi.useFakeTimers();
    const run = runBackdoorChecks(paced(1_000), [TOKEN]); // four round trips = 4 s
    let settled: unknown = "pending";
    void run.promise.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(BACKDOOR_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ timings: [{ token: TOKEN, result: "undetermined", reason: "timeout", totalMs: BACKDOOR_TIMEOUT_MS,
      stagesMs: { stage1: 1_000, stage2: 1_000 } }] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await run.promise).display).toBeUndefined();
  });

  it("settles without a display on cancel", async () => {
    const run = runBackdoorChecks(mockRpc({ deployerOk: true }), [TOKEN]);
    run.cancel();
    expect(await run.promise).toEqual({ timings: [] });
  });
});
