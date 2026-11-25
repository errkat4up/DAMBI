/**
 * End to end, on recorded mainnet data: a Uniswap V2 buy of a token whose pool
 * shows the pattern → shared gate → pool lookup → Sync history → the real
 * algorithm in WASM → warning payload → the card the confirmation page renders.
 * Runs in the DOM environment because the last step builds real elements.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { RequestType, type Message } from "@lib/types";
import { WINDOW_WARNING_TITLE, readStoredWindowDisplay, windowConfirmKey, type WindowDisplay } from "@lib/window-display";
import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";
import { renderWindowCard } from "../../../frontend/confirm/window-card";
import { BACKDOOR_TIMEOUT_MS, RpcTransportError, type Rpc } from "../backdoor-check";
import { GATE_TIMEOUT_MS, beginScamChecks, type ScamChecksDeps } from "../scam-checks";
import { WINDOW_TIMEOUT_MS } from "../window-check";
import { DEFAULT_WINDOW_SETTINGS, type EngineAnalysis } from "../window-rules";
import { realWindowAnalyze } from "./helpers/real-wasm";

vi.mock("../scam-filter", () => ({ beginScamCheck: () => { throw new Error("not used"); }, scamHostConfigured: async () => false }));
vi.mock("../wasm-bridge", () => ({ scamWindowAnalyze: async () => { throw new Error("tests inject analyze"); } }));
vi.mock("webextension-polyfill", () => ({
  default: { storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } },
}));

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures/window-fired-mainnet.json"), "utf8")) as {
  token: string; pool: string; head: { number: number; timestampMs: number }; startReserves: string; logs: unknown[];
  expected: { poolAgeSec: number; sensitive: { observed: number; threshold: number } } };
const USER = "0x" + "51".padStart(40, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** A node that answers exactly what mainnet answered for this pool at that block. */
const recordedNode: Rpc = async (method, params) => {
  if (method === "eth_getBlockByNumber") return { number: "0x" + fx.head.number.toString(16), timestamp: "0x" + (fx.head.timestampMs / 1000).toString(16) };
  if (method === "eth_getLogs") return (params[0] as { address: string }).address === fx.pool ? fx.logs : [];
  const tx = params[0] as { data: string };
  if (tx.data.startsWith("0xe6a43905")) return "0x" + fx.pool.slice(2).padStart(64, "0"); // factory.getPair
  if (tx.data === "0x0902f1ac") return fx.startReserves;                                  // pair.getReserves at head-300
  if (tx.data.startsWith("0x70a08231")) return "0x" + word(0n);                           // the user holds none of it
  throw new RpcTransportError("unexpected " + method);
};

/** swapExactETHForTokens(0, [WETH, token], user, deadline) as the extension's decoder reports it. */
const decodedBuy = [{ meta: {}, body: { domain: "amm", action: "swap",
  venue: { name: "uniswap_v2", chain: "eip155:1", pool: "0x" + "0".repeat(40), factory: "0x" + "0".repeat(40) },
  params: { token_out: { key: { standard: "erc20", chain: "eip155:1", address: fx.token } } } } }];
const buy: Message = { requestId: "e2e", data: { type: RequestType.TRANSACTION, chainId: 1, hostname: "dapp.example",
  transaction: { from: USER, to: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", data: "0x7ff36ab5", value: "0x1" } } } as Message;

const deps = (presetId: string): ScamChecksDeps => ({
  backdoorEnabled: async () => false,
  sdkConfigured: async () => false,
  gateRpc: () => recordedNode,
  backdoorRpc: () => recordedNode,
  beginSdk: () => { throw new Error("no host configuration"); },
  windowSettings: async () => ({ ...DEFAULT_WINDOW_SETTINGS, enabled: true, presetId }),
  analyze: async (request) => realWindowAnalyze<EngineAnalysis>(request),
  gateTimeoutMs: GATE_TIMEOUT_MS, backdoorTimeoutMs: BACKDOOR_TIMEOUT_MS, windowTimeoutMs: WINDOW_TIMEOUT_MS,
});
async function check(presetId: string): Promise<WindowDisplay | undefined> {
  const handle = beginScamChecks(buy, deps(presetId));
  handle.offer(decodedBuy);
  return (await handle.promise).window;
}

describe("window-rule warning, from recorded mainnet logs to the card on screen", () => {
  it("the sensitive preset warns, and the confirmation page shows why", async () => {
    const display = await check("window-sensitive");
    expect(display).toBeDefined();
    // What the service worker stores is what the page accepts back.
    const stored = JSON.parse(JSON.stringify({ requestId: "e2e", expiresAtMs: Date.now() + 60_000, display }));
    const read = readStoredWindowDisplay(stored, "e2e", Date.now());
    expect(read).toEqual(display);
    expect(windowConfirmKey("e2e")).toBe("window:confirm:e2e");

    const card = renderWindowCard(read);
    const text = [...card.querySelectorAll("p, h2")].map((n) => n.textContent);
    expect(card.classList.contains("scam-warn")).toBe(true);
    expect(text).toContain(WINDOW_WARNING_TITLE);
    expect(text).toContain(`최근 5분 동안 가격이 20% 이상 오른 변동이 ${fx.expected.sensitive.observed}회 있었습니다 (기준 5회).`);
    expect(text).toContain(`첫 유동성 공급 후 ${Math.round(fx.expected.poolAgeSec / 60)}분 된 풀입니다.`);
    expect(text).toContain(SCAM_SCOPE_NOTICE);
    expect(text).toContain(`Pool ${fx.pool}`);
    expect(card.textContent).not.toContain(USER.slice(2));
  });

  it("the card still warns before its details arrive, and rejects a payload meant for another request", () => {
    const bare = renderWindowCard();
    expect(bare.textContent).toContain(WINDOW_WARNING_TITLE);
    const display: WindowDisplay = { version: 1, kind: "window_rules", chainId: 1, token: fx.token, pool: fx.pool, presetId: "window-sensitive", poolAgeSec: 300,
      rules: [{ id: "r", observed: 8, threshold: 5, lookbackSec: 300, thresholdBps: 2000, direction: "up", changeMode: "step", metric: "price_quote_per_token" }] };
    expect(readStoredWindowDisplay({ requestId: "other", expiresAtMs: Date.now() + 1, display }, "e2e", Date.now())).toBeUndefined();
    expect(readStoredWindowDisplay({ requestId: "e2e", expiresAtMs: Date.now() - 1, display }, "e2e", Date.now())).toBeUndefined();
    expect(readStoredWindowDisplay({ requestId: "e2e", expiresAtMs: Date.now() + 1, display: { ...display, rules: [] } }, "e2e", Date.now())).toBeUndefined();
  });
});
