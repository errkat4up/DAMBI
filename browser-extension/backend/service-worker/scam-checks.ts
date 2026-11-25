/**
 * Shared gate in front of the scam checks.
 *
 * Three checks sit behind it: the pool-backdoor check, the window-rule check
 * evaluated inside the extension, and the SDK scam check (the team's local-demo
 * host). The last two are the same idea by two routes and never run together:
 * with a host configuration stored (`scam-filter:host-config`) the SDK check
 * runs as before; without one — every ordinary user — the in-extension check
 * runs instead. `scam-filter.ts` is untouched by that choice.
 *
 * No check starts unless ALL of these hold for the request being signed:
 *   - it is a transaction whose decoded actions buy a token through Uniswap V2
 *     (reuses the `Action[]` the lifecycle already decoded);
 *   - at least one check is switched on / configured;
 *   - the user does not already hold that token.
 *
 * When the gate does not pass, nothing is started and nothing is shown. When it
 * passes, each check gets its own deadline counted from the moment the gate
 * finished — the gate's time is not taken out of either check's budget.
 *
 * A confirmation window is only ever opened for a warning: a flagged pool, a
 * window rule that fired, or an SDK report whose status is `warn`. Every other
 * outcome stays silent.
 *
 * The backdoor and window checks need the same token/WETH pool and head block,
 * so that lookup is made once per token and shared.
 *
 * Holding lookup: one `balanceOf(user)` per bought token, under the gate's own
 * 1 s limit. A lookup that fails or runs out of time counts as "not held" and
 * the checks proceed. The lookup exists for mainnet only (the backdoor check's
 * endpoint); on any other chain there is none, which also counts as "not held".
 *
 * Everything here is read-only and advisory: it never changes a policy verdict.
 */
import { RequestType, type Message } from "@lib/types";
import type { BackdoorDisplay } from "@lib/backdoor-display";
import type { ScamDisplay } from "@lib/scam-display";
import type { WindowDisplay } from "@lib/window-display";
import {
  BACKDOOR_CHAIN_ID,
  BACKDOOR_RPC_URL,
  BACKDOOR_TIMEOUT_MS,
  SELECTOR,
  boughtTokens,
  isAddress,
  lookupPool,
  makeHttpRpc,
  padAddress,
  runBackdoorChecks,
  tryCall,
  wordAt,
  type BackdoorTokenTiming,
  type PoolLookup,
  type Rpc,
} from "./backdoor-check";
import { markPhase } from "./diagnostics";
import { ensureLoaded } from "./notify-settings";
import { beginScamCheck, scamHostConfigured } from "./scam-filter";
import { scamWindowAnalyze } from "./wasm-bridge";
import { WINDOW_TIMEOUT_MS, runWindowChecks, type Analyze, type WindowTokenTiming } from "./window-check";
import { effectiveRules, type EngineAnalysis, type WindowRuleSettings, type WindowStatus } from "./window-rules";
import { readWindowSettings, recordWindowStatus } from "./window-settings";

/** The gate's own limit. Past it, an unanswered balance counts as "not held". */
export const GATE_TIMEOUT_MS = 1_000;

export interface ScamCheckResults {
  /** SDK scam report — present only when its status is `warn`. */
  readonly scam?: ScamDisplay;
  /** Present only for a flagged pool. */
  readonly backdoor?: BackdoorDisplay;
  /** In-extension window rules — present only when a rule fired. */
  readonly window?: WindowDisplay;
}

export interface ScamChecksHandle {
  readonly promise: Promise<ScamCheckResults>;
  /** Hand over the `Action[]` the lifecycle already decoded. Runs the gate. */
  offer(actions: readonly unknown[]): void;
  /** The lifecycle finished. If nothing was offered, settle with no warning. */
  close(): void;
  cancel(): void;
}

/** How the holding lookup ended, per request. */
export type GateLookup = "ok" | "partial" | "timeout" | "failed" | "none";

/**
 * One request's timing, measured inside the service worker. The gate and each
 * check are recorded separately; a check that did not start is absent.
 *
 * Holds nothing about the user or the transaction: no wallet address, amount,
 * transaction hash or request id. Tokens are the contracts being bought.
 */
export interface ScamChecksTiming {
  readonly at: string;
  readonly chainId: number;
  readonly gate: {
    readonly ms: number;
    readonly lookup: GateLookup;
    readonly tokens: readonly string[];
    /** Tokens the user does not hold — the ones the checks ran for. */
    readonly eligible: readonly string[];
  };
  readonly backdoor?: { readonly ms: number; readonly tokens: readonly BackdoorTokenTiming[] };
  /** In-extension window rules. A check that could not decide keeps its reason here. */
  readonly window?: { readonly ms: number; readonly presetId: string; readonly tokens: readonly WindowTokenTiming[] };
  readonly sdk?: { readonly ms: number; readonly outcome: string };
}

// Build-time flag (webpack DefinePlugin): true only for the Web Store build.
declare const DAMBI_STRIP_CONSOLE: boolean | undefined;
const IS_WEBSTORE_BUILD = typeof DAMBI_STRIP_CONSOLE !== "undefined" && DAMBI_STRIP_CONSOLE;

/**
 * Local-only ring of recent timings (no remote collection). Off in the Web
 * Store build. Read it from the service worker's DevTools console with:
 *   `chrome.storage.local.get("dambi_diag_scam_checks").then(console.log)`
 */
export const SCAM_CHECKS_TIMING_KEY = "dambi_diag_scam_checks";
const MAX_TIMINGS = 30;
let timingWrites: Promise<void> = Promise.resolve();

function storeTiming(entry: ScamChecksTiming): void {
  // The SW global, not the polyfill import: keeps this module import-safe in unit tests.
  const area = (globalThis as { chrome?: { storage?: { local?: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  } } } }).chrome?.storage?.local;
  if (!area) return;
  timingWrites = timingWrites.then(async () => {
    const previous = (await area.get(SCAM_CHECKS_TIMING_KEY))[SCAM_CHECKS_TIMING_KEY];
    const kept = Array.isArray(previous) ? previous.slice(-(MAX_TIMINGS - 1)) : [];
    await area.set({ [SCAM_CHECKS_TIMING_KEY]: [...kept, entry] });
  }).catch(() => { /* diagnostics never affect the checks */ });
}

type SdkHandle = { promise: Promise<ScamDisplay | undefined>; cancel(): void };

export interface ScamChecksDeps {
  backdoorEnabled(): Promise<boolean>;
  sdkConfigured(): Promise<boolean>;
  /** RPC for the holding lookup, or `undefined` when the chain has none. */
  gateRpc(chainId: number): Rpc | undefined;
  backdoorRpc(): Rpc;
  beginSdk(message: Message): SdkHandle;
  /** The user's window-rule settings (off by default). */
  windowSettings(): Promise<WindowRuleSettings>;
  /** The window-rule algorithm (WASM). */
  analyze: Analyze;
  gateTimeoutMs: number;
  backdoorTimeoutMs: number;
  windowTimeoutMs: number;
  recordTiming?(entry: ScamChecksTiming): void;
  /** Last window-check outcome, for the /scam page. */
  recordWindowStatus?(status: WindowStatus): void;
}

const defaults: ScamChecksDeps = {
  backdoorEnabled: async () => (await ensureLoaded()).backdoor,
  sdkConfigured: scamHostConfigured,
  gateRpc: (chainId) => (chainId === BACKDOOR_CHAIN_ID ? makeHttpRpc(BACKDOOR_RPC_URL) : undefined),
  backdoorRpc: () => makeHttpRpc(BACKDOOR_RPC_URL),
  beginSdk: beginScamCheck,
  windowSettings: readWindowSettings,
  analyze: (request) => scamWindowAnalyze<EngineAnalysis>(request),
  gateTimeoutMs: GATE_TIMEOUT_MS,
  backdoorTimeoutMs: BACKDOOR_TIMEOUT_MS,
  windowTimeoutMs: WINDOW_TIMEOUT_MS,
  ...(IS_WEBSTORE_BUILD ? {} : { recordTiming: storeTiming }),
  recordWindowStatus,
};

/**
 * Which of `tokens` the user does not hold. Resolves within `timeoutMs`; a
 * balance that failed or has not arrived by then leaves its token eligible.
 */
export async function notHeldTokens(
  rpc: Rpc | undefined,
  user: string,
  tokens: readonly string[],
  timeoutMs: number,
): Promise<{ eligible: string[]; lookup: GateLookup }> {
  if (!rpc) return { eligible: [...tokens], lookup: "none" };
  // undefined = no answer yet, null = failed, bigint = balance.
  const balances = new Map<string, bigint | null | undefined>(tokens.map((token) => [token, undefined]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(tokens.map(async (token) => {
      const call = await tryCall(rpc, { to: token, data: SELECTOR.balanceOf + padAddress(user) });
      const word = call.status === "ok" ? wordAt(call.data, 0) : null;
      balances.set(token, word === null ? null : BigInt("0x" + word));
    })),
    new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const states = tokens.map((token) => balances.get(token));
  const answered = states.filter((b) => typeof b === "bigint").length;
  const lookup: GateLookup = answered === tokens.length ? "ok"
    : answered > 0 ? "partial"
    : states.every((b) => b === undefined) ? "timeout" : "failed";
  return { eligible: tokens.filter((token) => { const b = balances.get(token); return !(typeof b === "bigint" && b > 0n); }), lookup };
}

/** Only a warning is ever shown. */
function warning(display: ScamDisplay | undefined): ScamDisplay | undefined {
  return display?.kind === "report" && display.report.status === "warn" ? display : undefined;
}
function sdkOutcome(display: ScamDisplay | undefined): string {
  if (!display) return "not_configured";
  return display.kind === "report" ? display.report.status : `unavailable:${display.reason}`;
}

export function beginScamChecks(message: Message, deps: ScamChecksDeps = defaults): ScamChecksHandle {
  let started = false;
  let settled = false;
  let cancelRunning: (() => void) | undefined;
  let resolve!: (results: ScamCheckResults) => void;
  const promise = new Promise<ScamCheckResults>((done) => { resolve = done; });
  const finish = (results: ScamCheckResults): void => {
    if (settled) return;
    settled = true;
    resolve(results);
  };

  async function run(actions: readonly unknown[]): Promise<void> {
    const data = message.data;
    if (data.type !== RequestType.TRANSACTION) return finish({});
    const chainId = Number(data.chainId);
    const user = data.transaction.from;
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(user)) return finish({});
    const tokens = boughtTokens(actions, chainId);
    if (tokens.length === 0) return finish({});
    // Off means off: when no check would run, not even the holding lookup is sent.
    const mainnet = chainId === BACKDOOR_CHAIN_ID;
    const [backdoorOn, sdkOn, windowSettings] = await Promise.all([
      mainnet ? deps.backdoorEnabled() : false,
      deps.sdkConfigured(),
      mainnet ? deps.windowSettings() : undefined,
    ]);
    // The SDK host and the in-extension window check are alternatives: a stored
    // host configuration keeps the SDK route, otherwise the in-extension one runs.
    const window = !sdkOn && windowSettings?.enabled ? effectiveRules(windowSettings) : undefined;
    const windowOn = window !== undefined && window.rules.length > 0;
    if (settled || (!backdoorOn && !sdkOn && !windowOn)) return finish({});

    // ── gate: does the user already hold what they are buying? ──
    markPhase(message.requestId, "scam_gate_start", { tokens: tokens.length });
    const gateStartedAt = Date.now();
    const { eligible, lookup } = await notHeldTokens(deps.gateRpc(chainId), user, tokens, deps.gateTimeoutMs);
    const gate = { ms: Date.now() - gateStartedAt, lookup, tokens, eligible };
    markPhase(message.requestId, "scam_gate_done", { ms: gate.ms, lookup, eligible: eligible.length });
    const record = (extra: Pick<ScamChecksTiming, "backdoor" | "window" | "sdk"> = {}): void => {
      const entry: ScamChecksTiming = { at: new Date().toISOString(), chainId, gate, ...extra };
      console.info("[Dambi] scam-checks", { requestId: message.requestId, ...entry });
      deps.recordTiming?.(entry);
    };
    if (settled) return;
    if (eligible.length === 0) {
      record();
      return finish({});
    }

    // ── the checks start now, each with its own deadline from this point ──
    const checksStartedAt = Date.now();
    const rpc = backdoorOn || windowOn ? deps.backdoorRpc() : undefined;
    // One pool + head lookup per token, shared by the backdoor and window checks.
    const lookups = new Map<string, Promise<PoolLookup>>(rpc ? eligible.map((token) => [token, lookupPool(rpc, token)]) : []);
    const onStage = (phase: string, token: string): void => markPhase(message.requestId, phase, { token });
    const backdoorRun = backdoorOn && rpc
      ? runBackdoorChecks(rpc, eligible, { timeoutMs: deps.backdoorTimeoutMs, onStage, lookups })
      : undefined;
    const windowRun = windowOn && rpc && window
      ? runWindowChecks(rpc, eligible, { presetId: window.presetId, rules: window.rules, analyze: deps.analyze,
          timeoutMs: deps.windowTimeoutMs, onStage, lookups })
      : undefined;
    const sdkRun = sdkOn ? deps.beginSdk(message) : undefined;
    cancelRunning = () => { backdoorRun?.cancel(); windowRun?.cancel(); sdkRun?.cancel(); };
    const [backdoor, windowResult, sdk] = await Promise.all([
      backdoorRun?.promise.then((run) => ({ run, ms: Date.now() - checksStartedAt })),
      windowRun?.promise.then((run) => ({ run, ms: Date.now() - checksStartedAt })),
      // The SDK host never rejects; guard anyway so one check cannot sink the other.
      sdkRun?.promise.catch(() => undefined).then((display) => ({ display, ms: Date.now() - checksStartedAt })),
    ]);
    if (settled) return;
    record({
      ...(backdoor ? { backdoor: { ms: backdoor.ms, tokens: backdoor.run.timings } } : {}),
      ...(windowResult && window ? { window: { ms: windowResult.ms, presetId: window.presetId, tokens: windowResult.run.timings } } : {}),
      ...(sdk ? { sdk: { ms: sdk.ms, outcome: sdkOutcome(sdk.display) } } : {}),
    });
    if (windowResult && window) {
      // What the /scam page shows: the warning if there was one, otherwise the first token's outcome.
      const shown = windowResult.run.timings.find((t) => t.result === "fired") ?? windowResult.run.timings[0];
      if (shown) deps.recordWindowStatus?.({ at: new Date().toISOString(), result: shown.result, reason: shown.reason, presetId: window.presetId, ms: windowResult.ms });
    }
    markPhase(message.requestId, "scam_checks_done");
    const scam = warning(sdk?.display);
    finish({
      ...(scam ? { scam } : {}),
      ...(backdoor?.run.display ? { backdoor: backdoor.run.display } : {}),
      ...(windowResult?.run.display ? { window: windowResult.run.display } : {}),
    });
  }

  return {
    promise,
    offer(actions) {
      if (started || settled) return;
      started = true;
      // A failed gate or check never blocks or warns.
      void run(actions).catch(() => finish({}));
    },
    close() { if (!started) finish({}); },
    cancel() { cancelRunning?.(); finish({}); },
  };
}
