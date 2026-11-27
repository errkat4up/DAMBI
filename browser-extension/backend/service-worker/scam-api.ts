/**
 * Client for the server's scam pool check (`POST /v1/scam/pool-check`).
 *
 * The extension sends the token being bought and the window rules to evaluate;
 * the server looks the token/WETH pool up on chain, decides, and answers with
 * the result of both checks (pool backdoor, window rules).
 *
 * What leaves the extension is the token address and the rule values — no
 * wallet address, amount, transaction or account, and no credentials: the
 * request is sent without the user's session.
 *
 * Advisory only. A server that is down, slow, rate-limiting or answering
 * something unexpected ends as a failure with a reason; the caller treats that
 * as "undetermined" and shows nothing.
 */
import { getServerBaseUrl } from "./dambi-auth/client";
import { SCAM_CHAIN_ID } from "./scam-chain";
import type { ChangeCountRule } from "./window-rules";

/** The check's deadline, counted by the caller from the end of the gate. */
export const SCAM_API_TIMEOUT_MS = 2_500;
export const SCAM_API_PATH = "/v1/scam/pool-check";

export interface PoolCheckRequest {
  readonly token: string;
  /** `false` switches the pool-backdoor check off. */
  readonly backdoor: boolean;
  /** Enabled window rules. Empty switches the window check off. */
  readonly rules: readonly ChangeCountRule[];
}

export interface PoolCheckRule {
  readonly id: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly observed?: number;
  readonly threshold: number;
}

export interface PoolCheckAnswer {
  readonly pool: string | null;
  readonly backdoor: { readonly result: string; readonly reason: string; readonly deployer?: string };
  readonly window: { readonly result: string; readonly reason: string; readonly poolAgeSec?: number; readonly rules: readonly PoolCheckRule[] };
}

export type PoolCheckFailure = "timeout" | "rate_limited" | "server_unavailable" | "server_refused" | "bad_response";

export type PoolCheck =
  | { readonly ok: true; readonly answer: PoolCheckAnswer }
  | { readonly ok: false; readonly reason: PoolCheckFailure };

export type CheckPool = (request: PoolCheckRequest, signal?: AbortSignal) => Promise<PoolCheck>;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^[a-z_]{1,64}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e9;
const word = (v: unknown): v is string => typeof v === "string" && WORD.test(v);

/** The server's answer for `token`, or `null` when it is not one this client understands. */
export function parsePoolCheckAnswer(value: unknown, token: string): PoolCheckAnswer | null {
  if (!record(value) || value.chainId !== SCAM_CHAIN_ID || value.token !== token) return null;
  const pool = value.pool ?? null;
  if (pool !== null && !(typeof pool === "string" && ADDRESS.test(pool))) return null;
  const b = value.backdoor, w = value.window;
  if (!record(b) || !word(b.result) || !word(b.reason)) return null;
  if (b.deployer !== undefined && !(typeof b.deployer === "string" && ADDRESS.test(b.deployer))) return null;
  if (!record(w) || !word(w.result) || !word(w.reason) || !Array.isArray(w.rules) || w.rules.length > 16) return null;
  if (w.poolAgeSec !== undefined && !count(w.poolAgeSec)) return null;
  const rules: PoolCheckRule[] = [];
  for (const r of w.rules as unknown[]) {
    if (!record(r) || typeof r.id !== "string" || r.id.length === 0 || r.id.length > 128 || !word(r.outcome) || !count(r.threshold)) return null;
    if (r.observed !== undefined && !count(r.observed)) return null;
    if (r.reason !== undefined && !(typeof r.reason === "string" && r.reason.length <= 128)) return null;
    rules.push({ id: r.id, outcome: r.outcome, threshold: r.threshold,
      ...(r.observed !== undefined ? { observed: r.observed } : {}), ...(typeof r.reason === "string" ? { reason: r.reason } : {}) });
  }
  return {
    pool,
    backdoor: { result: b.result, reason: b.reason, ...(typeof b.deployer === "string" ? { deployer: b.deployer } : {}) },
    window: { result: w.result, reason: w.reason, rules, ...(w.poolAgeSec !== undefined ? { poolAgeSec: w.poolAgeSec } : {}) },
  };
}

/** The request body: exactly the token and the rule values. */
export function poolCheckBody(request: PoolCheckRequest): Record<string, unknown> {
  return {
    chainId: SCAM_CHAIN_ID,
    token: request.token.toLowerCase(),
    backdoor: request.backdoor,
    rules: request.rules.map((rule) => ({
      id: rule.id, lookbackSec: rule.lookbackSec, metric: rule.metric, direction: rule.direction,
      changeMode: rule.changeMode, thresholdBps: rule.thresholdBps, count: rule.count,
    })),
  };
}

export function makeScamApi(options: { baseUrl?: () => string; fetchImpl?: typeof fetch } = {}): CheckPool {
  const baseUrl = options.baseUrl ?? getServerBaseUrl;
  return async (request, signal) => {
    const token = request.token.toLowerCase();
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${baseUrl()}${SCAM_API_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(poolCheckBody(request)),
        // No cookies, no Authorization header: the check is not tied to an account.
        credentials: "omit",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      return { ok: false, reason: (e as Error)?.name === "AbortError" ? "timeout" : "server_unavailable" };
    }
    if (response.status === 429) return { ok: false, reason: "rate_limited" };
    if (response.status >= 500) return { ok: false, reason: "server_unavailable" };
    if (!response.ok) return { ok: false, reason: "server_refused" };
    let body: unknown;
    try { body = await response.json(); } catch { return { ok: false, reason: "bad_response" }; }
    const answer = parsePoolCheckAnswer(body, token);
    return answer ? { ok: true, answer } : { ok: false, reason: "bad_response" };
  };
}
