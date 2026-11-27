/**
 * What the scam gate needs from the chain and from the decoded request, on the
 * extension's side:
 *
 *  - which token a Uniswap V2 swap buys ({@link boughtTokens}), read from the
 *    `Action[]` the lifecycle already decoded;
 *  - a plain JSON-RPC client for the one lookup that stays in the extension:
 *    `balanceOf(user)`, the "does the user already hold it?" question. That
 *    request carries the wallet address, so it is never sent to Dambi's server.
 *
 * The checks themselves (pool backdoor, window rules) are looked up and decided
 * by the server — see `scam-api.ts`.
 */

// ── constants (Ethereum mainnet; selectors are keccak-256 values) ──
export const SCAM_CHAIN_ID = 1;
/** Public, keyless endpoint used only for the holding lookup. */
export const HOLDING_RPC_URL = "https://gateway.tenderly.co/public/mainnet";
export const UNISWAP_V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const SELECTOR = {
  balanceOf: "0x70a08231", // balanceOf(address)
} as const;
/** The holding lookup's request timeout. The gate has its own, shorter limit. */
const RPC_TIMEOUT_MS = 2_500;
/** A transaction normally buys one token; bound a multicall that buys several. */
export const MAX_TARGETS = 2;

// ── minimal ABI helpers ──
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (a: unknown): a is string => typeof a === "string" && ADDRESS_RE.test(a);
export const padAddress = (a: string): string => a.slice(2).toLowerCase().padStart(64, "0");
export function wordAt(hex: unknown, i: number): string | null {
  if (typeof hex !== "string") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = h.slice(i * 64, i * 64 + 64);
  return w.length === 64 && /^[0-9a-fA-F]+$/.test(w) ? w : null;
}

// ── RPC: "the contract refused" vs "the node failed" ──
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export class RpcRevert extends Error {
  override name = "RpcRevert";
}
export class RpcTransportError extends Error {
  override name = "RpcTransportError";
}

const REVERT_WORDS = ["revert", "invalid opcode", "out of gas", "invalid jump", "stack", "execution"];

/** Does a JSON-RPC error object mean the EVM call itself failed (deterministic)? */
export function isRevertError(err: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 3) return true;
  const msg = String(err.message ?? "").toLowerCase();
  // "execution aborted (timeout = 5s)" is the node giving up, not the contract refusing.
  if (/aborted|timeout|timed out/.test(msg)) return false;
  return REVERT_WORDS.some((w) => msg.includes(w));
}

/**
 * JSON-RPC over HTTP. Only a JSON-RPC error object that reads as a revert is a
 * revert; an HTTP failure, a non-JSON body or a timeout never is.
 */
export function makeHttpRpc(url: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Rpc {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  let id = 0;
  return async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let json: { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: controller.signal,
      });
      json = await response.json();
    } catch (e) {
      throw new RpcTransportError(String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
    if (json && typeof json === "object" && "result" in json && !json.error) return json.result;
    if (isRevertError(json?.error)) throw new RpcRevert(String(json?.error?.message ?? "reverted").slice(0, 200));
    throw new RpcTransportError(JSON.stringify(json?.error ?? json ?? null).slice(0, 200));
  };
}

type CallResult =
  | { status: "ok"; data: string }
  | { status: "revert" }
  | { status: "error" };

/** `eth_call` that reports a revert as a value instead of throwing. */
export async function tryCall(rpc: Rpc, tx: { from?: string; to: string; data: string }): Promise<CallResult> {
  try {
    const data = await rpc("eth_call", [tx, "latest"]);
    return { status: "ok", data: typeof data === "string" ? data : "0x" };
  } catch (e) {
    return e instanceof RpcRevert ? { status: "revert" } : { status: "error" };
  }
}

// ── which token is being bought ──
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Tokens bought through Uniswap V2 in the decoded `Action[]` tree, lowercase.
 * Reads the swap body the declarative route already produced:
 *
 *   { meta, body: { domain: "amm", action: "swap",
 *       venue:  { name: "uniswap_v2", chain, pool, factory },
 *       params: { token_out: { key: { standard: "erc20", chain, address } } } } }
 *
 * A native `token_out` (a sell for ETH) and an unknown `token_out` yield
 * nothing. A multi-hop path yields its last token only. On mainnet WETH is not
 * a "bought token" and a pool of a non-canonical factory is out of scope.
 */
export function boughtTokens(actions: readonly unknown[] | undefined, chainId: number): string[] {
  const mainnet = chainId === SCAM_CHAIN_ID;
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!record(node) || depth > 4) return;
    const body = record(node.body) ? node.body : node;
    if (body.domain === "multicall" && Array.isArray(body.actions)) {
      for (const child of body.actions) visit(child, depth + 1);
      return;
    }
    if (body.domain !== "amm" || body.action !== "swap") return;
    const venue = body.venue;
    if (!record(venue) || venue.name !== "uniswap_v2") return;
    // A fork that reuses the V2 shape has its own factory; its pools were not validated.
    if (mainnet && isAddress(venue.factory) && venue.factory.toLowerCase() !== ZERO_ADDRESS &&
        venue.factory.toLowerCase() !== UNISWAP_V2_FACTORY) return;
    const tokenOut = record(body.params) ? body.params.token_out : undefined;
    const key = record(tokenOut) ? tokenOut.key : undefined;
    if (!record(key) || key.standard !== "erc20" || !isAddress(key.address)) return;
    const token = key.address.toLowerCase();
    if (!(mainnet && token === WETH) && !out.includes(token)) out.push(token);
  };
  for (const action of actions ?? []) visit(action, 0);
  return out.slice(0, MAX_TARGETS);
}
