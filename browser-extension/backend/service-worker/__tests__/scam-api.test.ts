// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { makeScamApi, parsePoolCheckAnswer, poolCheckBody, type PoolCheckRequest } from "../scam-api";
import { WINDOW_PRESETS } from "../window-rules";

vi.mock("../dambi-auth/client", () => ({ getServerBaseUrl: () => { throw new Error("tests inject baseUrl"); } }));

const TOKEN = "0x" + "b0".repeat(20), POOL = "0x" + "a0".repeat(20), DEPLOYER = "0x" + "d0".repeat(20);
const rules = WINDOW_PRESETS["window-sensitive"];
const request: PoolCheckRequest = { token: TOKEN, backdoor: true, rules };
const answer = (over: Record<string, unknown> = {}) => ({
  chainId: 1, token: TOKEN, pool: POOL,
  backdoor: { result: "flagged", reason: "fired", deployer: DEPLOYER },
  window: { result: "fired", reason: "rule_fired", poolAgeSec: 300, rules: [{ id: rules[0].id, outcome: "fired", observed: 8, threshold: 5 }] },
  ...over,
});

function api(respond: () => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const checkPool = makeScamApi({ baseUrl: () => "https://server.example", fetchImpl: (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond();
  }) as typeof fetch });
  return { checkPool, seen };
}

describe("scam API request", () => {
  it("sends the token and the rule values, and nothing else", async () => {
    const { checkPool, seen } = api(() => new Response(JSON.stringify(answer())));
    await checkPool({ ...request, token: TOKEN.toUpperCase().replace("0X", "0x") });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://server.example/v1/scam/pool-check");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      chainId: 1, token: TOKEN, backdoor: true,
      rules: [{ id: "r1-up-burst-sensitive", lookbackSec: 300, metric: "price_quote_per_token", direction: "up", changeMode: "step", thresholdBps: 2000, count: 5 }],
    });
    // No session: the check is not tied to an account.
    expect(seen[0].init.credentials).toBe("omit");
    expect(seen[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  it("carries the off switches", () => {
    expect(poolCheckBody({ token: TOKEN, backdoor: false, rules: [] })).toEqual({ chainId: 1, token: TOKEN, backdoor: false, rules: [] });
  });
});

describe("scam API answer", () => {
  it("returns the parsed answer", async () => {
    const { checkPool } = api(() => new Response(JSON.stringify(answer())));
    expect(await checkPool(request)).toEqual({ ok: true, answer: {
      pool: POOL, backdoor: { result: "flagged", reason: "fired", deployer: DEPLOYER },
      window: { result: "fired", reason: "rule_fired", poolAgeSec: 300, rules: [{ id: rules[0].id, outcome: "fired", observed: 8, threshold: 5 }] } } });
  });

  it("turns every kind of failure into a reason, never a throw", async () => {
    const status = (code: number) => api(() => new Response(JSON.stringify({ error: "x" }), { status: code })).checkPool(request);
    expect(await status(429)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await status(503)).toEqual({ ok: false, reason: "server_unavailable" });
    expect(await status(400)).toEqual({ ok: false, reason: "server_refused" });
    expect(await api(() => new Response("<html>")).checkPool(request)).toEqual({ ok: false, reason: "bad_response" });
    expect(await api(() => { throw new TypeError("fetch failed"); }).checkPool(request)).toEqual({ ok: false, reason: "server_unavailable" });
    expect(await api(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }).checkPool(request)).toEqual({ ok: false, reason: "timeout" });
  });

  it("rejects an answer that is not about this token or is not well formed", () => {
    expect(parsePoolCheckAnswer(answer(), TOKEN)).not.toBeNull();
    expect(parsePoolCheckAnswer(answer({ pool: null, backdoor: { result: "skipped", reason: "no_weth_pair" } }), TOKEN)).not.toBeNull();
    const bad: unknown[] = [
      null, "flagged", answer({ token: POOL }), answer({ chainId: 8453 }), answer({ pool: "0x1234" }),
      answer({ backdoor: { result: "flagged", reason: "fired", deployer: "<script>" } }),
      answer({ backdoor: { result: "FLAGGED!", reason: "fired" } }),
      answer({ window: { result: "fired", reason: "rule_fired", rules: "many" } }),
      answer({ window: { result: "fired", reason: "rule_fired", rules: [{ id: "r", outcome: "fired", threshold: -1 }] } }),
      answer({ window: { result: "fired", reason: "rule_fired", poolAgeSec: 1.5, rules: [] } }),
    ];
    for (const value of bad) expect(parsePoolCheckAnswer(value, TOKEN), JSON.stringify(value)).toBeNull();
  });
});
