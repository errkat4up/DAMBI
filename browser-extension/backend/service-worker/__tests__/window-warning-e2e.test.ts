/**
 * End to end on the extension's side: a Uniswap V2 buy → shared gate → the
 * server's answer (in its wire format) → warning payload → the card the
 * confirmation page renders. Runs in the DOM environment because the last step
 * builds real elements. The lookup and the algorithm are the server's and are
 * tested there (`crates/policy-server/server/tests/scam_pool_check.rs`).
 */
import { describe, expect, it, vi } from "vitest";
import { RequestType, type Message } from "@lib/types";
import { WINDOW_WARNING_TITLE, readStoredWindowDisplay, windowConfirmKey, type WindowDisplay } from "@lib/window-display";
import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";
import { renderWindowCard } from "../../../frontend/confirm/window-card";
import { SCAM_API_TIMEOUT_MS, parsePoolCheckAnswer, poolCheckBody, type CheckPool } from "../scam-api";
import type { Rpc } from "../scam-chain";
import { GATE_TIMEOUT_MS, beginScamChecks, type ScamChecksDeps } from "../scam-checks";
import { DEFAULT_WINDOW_SETTINGS } from "../window-rules";

vi.mock("../scam-filter", () => ({ beginScamCheck: () => { throw new Error("not used"); }, scamHostConfigured: async () => false }));
vi.mock("../dambi-auth/client", () => ({ getServerBaseUrl: () => "https://server.invalid" }));
vi.mock("webextension-polyfill", () => ({
  default: { storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } },
}));

/**
 * What the server answered for a real mainnet pool recorded on 2026-11-25
 * (the same recording the server's own tests replay through the algorithm).
 */
const fx = {
  token: "0x0370f261c43a1f67890b415f46df52f8b8576244", pool: "0x845e4f7c5121f67d8d1104a37706250356f1838d",
  expected: { poolAgeSec: 300, sensitive: { observed: 8, threshold: 5 } },
};
const USER = "0x" + "51".padStart(40, "0");

/** The chain, for the one thing the extension asks it: the user holds none of the token. */
const holdsNothing: Rpc = async () => "0x" + "0".repeat(64);

/** The server: checks the body it is sent and answers as the real one did, over the wire format. */
const recordedServer: CheckPool = async (request) => {
  const body = JSON.parse(JSON.stringify(poolCheckBody(request))) as { token: string; rules: { id: string; count: number }[] };
  const wire = { chainId: 1, token: body.token, pool: fx.pool, backdoor: { result: "off", reason: "not_requested" },
    window: { result: "fired", reason: "rule_fired", poolAgeSec: fx.expected.poolAgeSec,
      rules: body.rules.map((rule) => ({ id: rule.id, outcome: "fired", observed: fx.expected.sensitive.observed, threshold: rule.count })) } };
  const answer = parsePoolCheckAnswer(JSON.parse(JSON.stringify(wire)), body.token);
  return answer ? { ok: true, answer } : { ok: false, reason: "bad_response" };
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
  gateRpc: () => holdsNothing,
  checkPool: recordedServer,
  beginSdk: () => { throw new Error("no host configuration"); },
  windowSettings: async () => ({ ...DEFAULT_WINDOW_SETTINGS, enabled: true, presetId }),
  gateTimeoutMs: GATE_TIMEOUT_MS, poolCheckTimeoutMs: SCAM_API_TIMEOUT_MS,
});
async function check(presetId: string): Promise<WindowDisplay | undefined> {
  const handle = beginScamChecks(buy, deps(presetId));
  handle.offer(decodedBuy);
  return (await handle.promise).window;
}

describe("window-rule warning, from the server's answer to the card on screen", () => {
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
