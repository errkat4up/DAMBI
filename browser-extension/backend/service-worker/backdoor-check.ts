/**
 * Pool-backdoor check — the lookup half. The decision itself is the pure
 * function in `backdoor-decision.ts`.
 *
 * Runs before signing, for a Uniswap V2 buy on Ethereum mainnet of a token the
 * user does not hold. Whether there is such a token is decided by the shared
 * gate in `scam-checks.ts`, which also starts the SDK scam check; this module
 * is handed the tokens to examine. It asks whether the account that created
 * the token/WETH pool can move the pool's tokens (`transferFrom(pool, deployer, 1)` simulated
 * as the deployer succeeds while the same call from an unrelated address is
 * refused).
 *
 * Constraints:
 *  - Read-only: `eth_call`, `eth_getLogs`, `eth_getTransactionByHash`,
 *    `eth_getBlockByNumber`. Nothing is signed or sent.
 *  - Advisory: it can add a warning to the confirmation window. It never
 *    changes the policy verdict.
 *  - Only `flagged` is shown. Every lookup failure, timeout or ambiguous
 *    result is `undetermined` and stays silent.
 *  - Independent of the SDK scam host (`scam-filter.ts`).
 *
 * RPC: the check talks to its own endpoint ({@link BACKDOOR_RPC_URL}) with
 * plain JSON-RPC over `fetch`. It does not use `rpcClient` / `chain-config`:
 * that client batches sender-less calls through Multicall3 (this check depends
 * on who the sender is), and its mainnet endpoints cap `eth_getLogs` ranges.
 */
import type { BackdoorDisplay } from "@lib/backdoor-display";
import {
  backdoorResult,
  evaluatePoolBackdoor,
  type BackdoorResult,
  type CallObservation,
  type PoolBackdoorObservation,
} from "./backdoor-decision";

// ── constants (Ethereum mainnet; selectors and topics are keccak-256 values) ──
export const BACKDOOR_CHAIN_ID = 1;
/**
 * The only endpoint this check uses. Serves the 30-day `eth_getLogs` range in
 * one request, which the extension's shared mainnet RPCs do not.
 */
export const BACKDOOR_RPC_URL = "https://gateway.tenderly.co/public/mainnet";
export const UNISWAP_V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
/** Caller of the control simulation: an address with no role in any token. */
export const CONTROL_ADDRESS = "0x000000000000000000000000000000000c0ffee1";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const SELECTOR = {
  getPair: "0xe6a43905", // getPair(address,address)
  balanceOf: "0x70a08231", // balanceOf(address)
  transferFrom: "0x23b872dd", // transferFrom(address,address,uint256)
} as const;
const PAIR_CREATED_TOPIC =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const BLOCKS_PER_DAY = 7200; // 12 s blocks
/** The check was validated on recently created pools only. Older pools are not checked. */
export const MAX_POOL_AGE_BLOCKS = 30 * BLOCKS_PER_DAY;
/** The check's own deadline. `rpcClient`'s 8 s request timeout is not a bound. */
export const BACKDOOR_TIMEOUT_MS = 2_500;
/** A transaction normally buys one token; bound a multicall that buys several. */
export const MAX_TARGETS = 2;

// ── minimal ABI helpers ──
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (a: unknown): a is string => typeof a === "string" && ADDRESS_RE.test(a);
export const padAddress = (a: string): string => a.slice(2).toLowerCase().padStart(64, "0");
const padUint = (v: bigint): string => v.toString(16).padStart(64, "0");
export const hexBlock = (n: number): string => "0x" + n.toString(16);
export function wordAt(hex: unknown, i: number): string | null {
  if (typeof hex !== "string") return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = h.slice(i * 64, i * 64 + 64);
  return w.length === 64 && /^[0-9a-fA-F]+$/.test(w) ? w : null;
}
const wordToAddress = (w: string): string => "0x" + w.slice(24).toLowerCase();

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
  const timeoutMs = options.timeoutMs ?? BACKDOOR_TIMEOUT_MS;
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

/** Succeeded = no revert and returned nothing or a non-zero word. `false` is a refusal. */
function observeCall(r: CallResult): CallObservation {
  if (r.status === "error") return "unavailable";
  if (r.status === "revert") return "refused";
  const w = wordAt(r.data, 0);
  return w === null || BigInt("0x" + w) !== 0n ? "succeeded" : "refused";
}

// ── which token is being bought ──
export const record = (v: unknown): v is Record<string, unknown> =>
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
  const mainnet = chainId === BACKDOOR_CHAIN_ID;
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

// ── the lookup ──
export interface BackdoorCheck {
  /** `skipped` = there is no token/WETH pool, so nothing was examined. */
  readonly result: BackdoorResult | "skipped";
  readonly reason: string;
  readonly token: string;
  readonly pool?: string;
  readonly deployer?: string;
}

type Mark = (phase: string) => void;

/**
 * The token/WETH pool and the head block, looked up once per token and shared
 * by the pool-backdoor check and the window-rule check.
 */
export type PoolLookup =
  | { readonly status: "ok"; readonly pool: string; readonly head: { readonly number: number; readonly timestampMs: number } }
  /** The factory has no token/WETH pair. */
  | { readonly status: "none" }
  | { readonly status: "unavailable"; readonly reason: "pair_unavailable" | "head_unavailable"; readonly pool?: string };

/** `factory.getPair(token, WETH)` and the latest block (number and timestamp), in parallel. Never rejects. */
export async function lookupPool(rpc: Rpc, tokenAddress: string): Promise<PoolLookup> {
  const token = tokenAddress.toLowerCase();
  const [pairCall, headRaw] = await Promise.all([
    tryCall(rpc, { to: UNISWAP_V2_FACTORY, data: SELECTOR.getPair + padAddress(token) + padAddress(WETH) }),
    rpc("eth_getBlockByNumber", ["latest", false]).catch(() => null),
  ]);
  const pairWord = pairCall.status === "ok" ? wordAt(pairCall.data, 0) : null;
  if (pairWord === null) return { status: "unavailable", reason: "pair_unavailable" };
  const pool = wordToAddress(pairWord);
  if (pool === ZERO_ADDRESS) return { status: "none" };
  try {
    const block = headRaw as { number?: unknown; timestamp?: unknown } | null;
    const number = Number(BigInt(block?.number as string));
    const timestampMs = Number(BigInt(block?.timestamp as string)) * 1000;
    if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(timestampMs) || timestampMs <= 0) throw new Error("head");
    return { status: "ok", pool, head: { number, timestampMs } };
  } catch {
    return { status: "unavailable", reason: "head_unavailable", pool };
  }
}

/**
 * Examine one token the user is buying and does not hold (the shared gate has
 * already established that). Four round trips:
 *   1. factory.getPair(token, WETH) · head block — {@link lookupPool}, shared when `args.lookup` is given
 *   2. PairCreated log (last 30 days) · token.balanceOf(pool)
 *   3. pair-creation transaction → deployer (`from`)
 *   4. deployer call · control call
 */
export async function checkPoolBackdoor(
  rpc: Rpc,
  args: { token: string; lookup?: PoolLookup | Promise<PoolLookup> | undefined },
  mark: Mark = () => {},
  /** The 30-day window is part of the shipped rule. Only tests widen it. */
  options: { maxPoolAgeBlocks?: number } = {},
): Promise<BackdoorCheck> {
  const maxPoolAgeBlocks = options.maxPoolAgeBlocks ?? MAX_POOL_AGE_BLOCKS;
  const token = args.token.toLowerCase();
  const done = (result: BackdoorCheck["result"], reason: string, extra: Partial<BackdoorCheck> = {}): BackdoorCheck =>
    ({ result, reason, token, ...extra });
  const balanceOf = (owner: string) =>
    tryCall(rpc, { to: token, data: SELECTOR.balanceOf + padAddress(owner) });

  // 1 ─ is there a token/WETH pool, and where is the head?
  const found = await (args.lookup ?? lookupPool(rpc, token));
  mark("backdoor_stage1");
  if (found.status === "none") return done("skipped", "no_weth_pair");
  if (found.status === "unavailable") return done("undetermined", found.reason, found.pool ? { pool: found.pool } : {});
  const pool = found.pool;
  const head = found.head.number;

  // 2 ─ who created the pool (recent pools only), and does it hold the token?
  const [t0, t1] = BigInt(token) < BigInt(WETH) ? [token, WETH] : [WETH, token];
  const [logs, poolBalance] = await Promise.all([
    rpc("eth_getLogs", [{
      address: UNISWAP_V2_FACTORY,
      topics: [PAIR_CREATED_TOPIC, "0x" + padAddress(t0), "0x" + padAddress(t1)],
      fromBlock: hexBlock(Math.max(0, head - maxPoolAgeBlocks)),
      toBlock: hexBlock(head),
    }]).catch(() => null),
    balanceOf(pool),
  ]);
  mark("backdoor_stage2");
  if (!Array.isArray(logs)) return done("undetermined", "logs_unavailable", { pool });
  const log: unknown = logs[0];
  const balanceWord = poolBalance.status === "ok" ? wordAt(poolBalance.data, 0) : null;
  const observation = {
    deployer: null as string | null,
    control: CONTROL_ADDRESS,
    poolTokenBalance: balanceWord === null ? null : BigInt("0x" + balanceWord).toString(10),
    deployerCall: "unavailable" as CallObservation,
    controlCall: "unavailable" as CallObservation,
  };
  const conclude = (extra: Partial<BackdoorCheck> = {}): BackdoorCheck => {
    const finding = evaluatePoolBackdoor(observation satisfies PoolBackdoorObservation);
    return done(backdoorResult(finding), finding.reason ?? finding.outcome, { pool, ...extra });
  };
  // No PairCreated in the window: the pool is older than 30 days (or unknown).
  if (!record(log) || typeof log.transactionHash !== "string") return conclude();
  const loggedPair = wordAt(log.data, 0);
  if (loggedPair === null || wordToAddress(loggedPair) !== pool) {
    return done("undetermined", "pair_mismatch", { pool });
  }

  // 3 ─ deployer = sender of the pair-creation transaction (not owner(), not the factory).
  const tx = await rpc("eth_getTransactionByHash", [log.transactionHash]).catch(() => null);
  mark("backdoor_stage3");
  if (!record(tx) || !isAddress(tx.from)) return conclude();
  const deployer = tx.from.toLowerCase();
  observation.deployer = deployer;
  // Nothing left to learn from the simulations when the pool balance already decides it.
  if (observation.poolTokenBalance === null || observation.poolTokenBalance === "0" || deployer === CONTROL_ADDRESS) {
    return conclude({ deployer });
  }

  // 4 ─ transferFrom(pool, caller, 1), as the deployer and as an unrelated address.
  // The amount is exactly 1: with 0 an ordinary token lets anyone succeed.
  const simulate = (from: string) => tryCall(rpc, {
    from, to: token,
    data: SELECTOR.transferFrom + padAddress(pool) + padAddress(from) + padUint(1n),
  });
  const [dep, ctl] = await Promise.all([simulate(deployer), simulate(CONTROL_ADDRESS)]);
  mark("backdoor_stage4");
  observation.deployerCall = observeCall(dep);
  observation.controlCall = observeCall(ctl);
  return conclude({ deployer });
}

// ── running the check for the gated tokens ──
/** One token's outcome and how long each round trip took (not cumulative). */
export interface BackdoorTokenTiming {
  readonly token: string;
  readonly result: string;
  readonly reason: string;
  readonly totalMs: number;
  readonly stagesMs: Record<string, number>;
}

export interface BackdoorRun {
  /** Present only for a flagged pool. */
  readonly display?: BackdoorDisplay;
  readonly timings: readonly BackdoorTokenTiming[];
}

/**
 * Check the given tokens within the check's own deadline, counted from this
 * call. Resolves at the deadline at the latest; a result that arrives later is
 * discarded, flagged or not. Never rejects.
 */
export function runBackdoorChecks(
  rpc: Rpc,
  tokens: readonly string[],
  options: {
    timeoutMs?: number;
    onStage?: (phase: string, token: string) => void;
    /** Shared pool lookups, keyed by token. Without one the check does its own. */
    lookups?: ReadonlyMap<string, Promise<PoolLookup>>;
  } = {},
): { promise: Promise<BackdoorRun>; cancel(): void } {
  const startedAt = Date.now();
  const stageMarks = new Map<string, [string, number][]>(tokens.map((token) => [token, []]));
  let settled = false;
  let resolve!: (run: BackdoorRun) => void;
  const promise = new Promise<BackdoorRun>((done) => { resolve = done; });
  const timing = (token: string, result: string, reason: string): BackdoorTokenTiming => {
    const stagesMs: Record<string, number> = {};
    let previous = 0;
    for (const [stage, atMs] of stageMarks.get(token) ?? []) {
      stagesMs[stage] = atMs - previous;
      previous = atMs;
    }
    return { token, result, reason, totalMs: Date.now() - startedAt, stagesMs };
  };
  const finish = (run: BackdoorRun): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(run);
  };
  // At the deadline, record how far each lookup got.
  const timer = setTimeout(
    () => finish({ timings: tokens.map((token) => timing(token, "undetermined", "timeout")) }),
    options.timeoutMs ?? BACKDOOR_TIMEOUT_MS,
  );

  void Promise.all(tokens.map((token) =>
    checkPoolBackdoor(rpc, { token, lookup: options.lookups?.get(token) }, (phase) => {
      stageMarks.get(token)?.push([phase.replace("backdoor_", ""), Date.now() - startedAt]);
      options.onStage?.(phase, token);
    }))).then((checks) => {
    const flagged = checks.find((c) => c.result === "flagged" && c.pool && c.deployer);
    finish({
      timings: checks.map((c) => timing(c.token, c.result, c.reason)),
      ...(flagged ? { display: {
        version: 1 as const, kind: "pool_backdoor" as const, chainId: BACKDOOR_CHAIN_ID,
        token: flagged.token, pool: flagged.pool!, deployer: flagged.deployer!,
      } } : {}),
    });
  }).catch(() => finish({ timings: tokens.map((token) => timing(token, "undetermined", "error")) }));

  return { promise, cancel: () => finish({ timings: [] }) };
}
