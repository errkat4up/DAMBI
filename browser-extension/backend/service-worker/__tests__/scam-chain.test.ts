// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  RpcRevert,
  RpcTransportError,
  UNISWAP_V2_FACTORY,
  WETH,
  boughtTokens,
  makeHttpRpc,
  isRevertError,
} from "../scam-chain";

const A = (n: number): string => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = A(0xb0), PAIR = A(0xa0), DEPLOYER = A(0xd0);

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
