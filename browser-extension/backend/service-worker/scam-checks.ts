/**
 * Shared gate in front of the scam checks.
 *
 * Two routes sit behind it and never run together:
 *  - the server's pool check (`scam-api.ts`): the pool-backdoor check and the
 *    window rules, looked up and decided by Dambi's server in one request per
 *    token;
 *  - the SDK scam check (the team's local-demo host). With a host configuration
 *    stored (`scam-filter:host-config`) it runs instead of the server's window
 *    rules; `scam-filter.ts` is untouched by that choice.
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
 * The existing pre-sign confirmation path receives flagged pools, fired window
 * rules, SDK warnings, and configured SDK checks that are insufficient or failed.
 * SDK reasons and scope are passed through unchanged, not converted to policy
 * denial. Quiet, disabled, unconfigured, unsupported and cancelled SDK outcomes
 * stay silent. Server failures retain their existing silent routing.
 *
 * What goes where: the server is sent the token address and the rule values.
 * The holding lookup (`balanceOf(user)`, under the gate's own 1 s limit) carries
 * the wallet address, so the extension asks the chain itself. A lookup that
 * fails or runs out of time counts as "not held" and the checks proceed. It
 * exists for mainnet only; on any other chain there is none, which also counts
 * as "not held".
 *
 * Everything here is read-only and advisory: it never changes a policy verdict.
 */
import { RequestType, type Message } from "@lib/types";
import type { BackdoorDisplay } from "@lib/backdoor-display";
import type { ScamDisplay } from "@lib/scam-display";
import type { WindowDisplay, WindowFiredRule } from "@lib/window-display";
import { markPhase } from "./diagnostics";
import { ensureLoaded } from "./notify-settings";
import { SCAM_API_TIMEOUT_MS, makeScamApi, type CheckPool, type PoolCheck } from "./scam-api";
import {
  HOLDING_RPC_URL,
  SCAM_CHAIN_ID,
  SELECTOR,
  boughtTokens,
  isAddress,
  makeHttpRpc,
  padAddress,
  tryCall,
  wordAt,
  type Rpc,
} from "./scam-chain";
import { beginScamCheck, scamHostConfigured } from "./scam-filter";
import { effectiveRules, type ChangeCountRule, type WindowRuleSettings, type WindowStatus } from "./window-rules";
import { readWindowSettings, recordWindowStatus } from "./window-settings";

/** The gate's own limit. Past it, an unanswered balance counts as "not held". */
export const GATE_TIMEOUT_MS = 1_000;

export interface ScamCheckResults {
  /** SDK warning, insufficient report, or explicit check failure for pre-sign display. */
  readonly scam?: ScamDisplay;
  /** Present only for a flagged pool. */
  readonly backdoor?: BackdoorDisplay;
  /** Window rules — present only when a rule fired. */
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
/** One token's outcome from the server. A check that could not decide keeps its reason here. */
export interface PoolCheckTiming {
  readonly token: string;
  readonly ms: number;
  readonly backdoor?: { readonly result: string; readonly reason: string };
  readonly window?: { readonly result: string; readonly reason: string };
}

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
  /** The server's pool check: one request per token. A check that was off is absent from its token. */
  readonly server?: { readonly ms: number; readonly presetId?: string; readonly tokens: readonly PoolCheckTiming[] };
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
  /** The server's pool check. */
  checkPool: CheckPool;
  beginSdk(message: Message): SdkHandle;
  /** The user's window-rule settings (off by default). */
  windowSettings(): Promise<WindowRuleSettings>;
  gateTimeoutMs: number;
  /** The server check's deadline, counted from the end of the gate. */
  poolCheckTimeoutMs: number;
  recordTiming?(entry: ScamChecksTiming): void;
  /** Last window-check outcome, for the /scam page. */
  recordWindowStatus?(status: WindowStatus): void;
}

const defaults: ScamChecksDeps = {
  backdoorEnabled: async () => (await ensureLoaded()).backdoor,
  sdkConfigured: scamHostConfigured,
  gateRpc: (chainId) => (chainId === SCAM_CHAIN_ID ? makeHttpRpc(HOLDING_RPC_URL) : undefined),
  checkPool: makeScamApi(),
  beginSdk: beginScamCheck,
  windowSettings: readWindowSettings,
  gateTimeoutMs: GATE_TIMEOUT_MS,
  poolCheckTimeoutMs: SCAM_API_TIMEOUT_MS,
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

/** Select displayable SDK outcomes, without reinterpreting the SDK's verdict.
 * In particular, bundle_invalid is not proof of expiry. Cancellation (including
 * session replacement) is not a failed check to publish to a new confirmation.
 */
function sdkConfirmation(display: ScamDisplay | undefined): ScamDisplay | undefined {
  if (!display) return undefined;
  if (display.kind === "report") {
    return display.report.status === "warn" || display.report.status === "insufficient" ? display : undefined;
  }
  // Explicit failures only: do not turn preparation, unsupported requests, or
  // future host states into a prompt by default.
  switch (display.reason) {
    case "timeout":
    case "initialization_failed":
    case "invalid_configuration":
    case "invalid_request":
    case "host_error":
    case "report_missing":
      return display;
    default:
      return undefined;
  }
}
function sdkOutcome(display: ScamDisplay | undefined): string {
  if (!display) return "not_configured";
  return display.kind === "report" ? display.report.status : `unavailable:${display.reason}`;
}

/**
 * Ask the server about each token, within one deadline counted from this call.
 * Resolves at the deadline at the latest; an answer that arrives later is
 * discarded, warning or not. Never rejects.
 */
function runPoolChecks(
  checkPool: CheckPool,
  tokens: readonly string[],
  request: { backdoor: boolean; rules: readonly ChangeCountRule[] },
  timeoutMs: number,
): { promise: Promise<{ token: string; ms: number; check: PoolCheck }[]>; cancel(): void } {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timedOut: PoolCheck = { ok: false, reason: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); });
  const promise = Promise.all(tokens.map(async (token) => {
    const check = await Promise.race([
      checkPool({ token, ...request }, controller.signal).catch((): PoolCheck => ({ ok: false, reason: "server_unavailable" })),
      deadline.then(() => timedOut),
    ]);
    return { token, ms: Date.now() - startedAt, check };
  })).finally(() => { clearTimeout(timer); controller.abort(); });
  return { promise, cancel: () => { clearTimeout(timer); controller.abort(); } };
}

/** The fired rules of an answer, with the numbers of the rule that was sent. */
function firedRules(answerRules: readonly { id: string; outcome: string; observed?: number; threshold: number }[], sent: readonly ChangeCountRule[]): WindowFiredRule[] {
  const byId = new Map(sent.map((rule) => [rule.id, rule]));
  const fired: WindowFiredRule[] = [];
  for (const result of answerRules) {
    const rule = byId.get(result.id);
    if (result.outcome !== "fired" || !rule) continue;
    fired.push({ id: rule.id, observed: result.observed ?? result.threshold, threshold: result.threshold, lookbackSec: rule.lookbackSec,
      thresholdBps: rule.thresholdBps, direction: rule.direction, changeMode: rule.changeMode, metric: rule.metric });
  }
  return fired;
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
    // Observation is never a pre-sign interaction, even if actions are offered.
    if (data.bypassed || data.type !== RequestType.TRANSACTION) return finish({});
    const chainId = Number(data.chainId);
    const user = data.transaction.from;
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(user)) return finish({});
    const tokens = boughtTokens(actions, chainId);
    if (tokens.length === 0) return finish({});
    // Off means off: when no check would run, not even the holding lookup is sent.
    const mainnet = chainId === SCAM_CHAIN_ID;
    const [backdoorOn, sdkOn, windowSettings] = await Promise.all([
      mainnet ? deps.backdoorEnabled() : false,
      deps.sdkConfigured(),
      mainnet ? deps.windowSettings() : undefined,
    ]);
    // The SDK host and the server's window rules are alternatives: a stored
    // host configuration keeps the SDK route, otherwise the server evaluates them.
    const window = !sdkOn && windowSettings?.enabled ? effectiveRules(windowSettings) : undefined;
    const windowOn = window !== undefined && window.rules.length > 0;
    if (settled || (!backdoorOn && !sdkOn && !windowOn)) return finish({});

    // ── gate: does the user already hold what they are buying? ──
    markPhase(message.requestId, "scam_gate_start", { tokens: tokens.length });
    const gateStartedAt = Date.now();
    const { eligible, lookup } = await notHeldTokens(deps.gateRpc(chainId), user, tokens, deps.gateTimeoutMs);
    const gate = { ms: Date.now() - gateStartedAt, lookup, tokens, eligible };
    markPhase(message.requestId, "scam_gate_done", { ms: gate.ms, lookup, eligible: eligible.length });
    const record = (extra: Pick<ScamChecksTiming, "server" | "sdk"> = {}): void => {
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
    const rules = windowOn && window ? window.rules : [];
    const poolRun = backdoorOn || windowOn
      ? runPoolChecks(deps.checkPool, eligible, { backdoor: backdoorOn, rules }, deps.poolCheckTimeoutMs)
      : undefined;
    const sdkRun = sdkOn ? deps.beginSdk(message) : undefined;
    cancelRunning = () => { poolRun?.cancel(); sdkRun?.cancel(); };
    const [pool, sdk] = await Promise.all([
      poolRun?.promise.then((checks) => ({ checks, ms: Date.now() - checksStartedAt })),
      // The SDK host never rejects; guard anyway so one check cannot sink the other.
      sdkRun?.promise.catch(() => undefined).then((display) => ({ display, ms: Date.now() - checksStartedAt })),
    ]);
    if (settled) return;

    // A check the server could not be asked about is "undetermined", with the reason why.
    const outcomes: PoolCheckTiming[] = (pool?.checks ?? []).map(({ token, ms, check }) => {
      const failed = check.ok ? undefined : { result: "undetermined", reason: check.reason };
      const part = (answered: { result: string; reason: string } | undefined) =>
        failed ?? { result: answered?.result ?? "undetermined", reason: answered?.reason ?? "bad_response" };
      return {
        token, ms,
        ...(backdoorOn ? { backdoor: part(check.ok ? check.answer.backdoor : undefined) } : {}),
        ...(windowOn ? { window: part(check.ok ? check.answer.window : undefined) } : {}),
      };
    });
    record({
      ...(pool ? { server: { ms: pool.ms, ...(windowOn && window ? { presetId: window.presetId } : {}), tokens: outcomes } } : {}),
      ...(sdk ? { sdk: { ms: sdk.ms, outcome: sdkOutcome(sdk.display) } } : {}),
    });
    if (pool && windowOn && window) {
      // What the /scam page shows: the warning if there was one, otherwise the first token's outcome.
      const shown = outcomes.find((t) => t.window?.result === "fired") ?? outcomes[0];
      if (shown?.window) deps.recordWindowStatus?.({ at: new Date().toISOString(), result: shown.window.result, reason: shown.window.reason, presetId: window.presetId, ms: pool.ms });
    }
    markPhase(message.requestId, "scam_checks_done");

    let backdoor: BackdoorDisplay | undefined;
    let windowDisplay: WindowDisplay | undefined;
    for (const { token, check } of pool?.checks ?? []) {
      if (!check.ok) continue;
      const { answer } = check;
      const poolAddress = answer.pool;
      if (poolAddress === null) continue;
      if (backdoorOn && !backdoor && answer.backdoor.result === "flagged" && answer.backdoor.deployer) {
        backdoor = { version: 1, kind: "pool_backdoor", chainId: SCAM_CHAIN_ID, token, pool: poolAddress, deployer: answer.backdoor.deployer };
      }
      if (windowOn && window && !windowDisplay && answer.window.result === "fired") {
        const fired = firedRules(answer.window.rules, window.rules);
        if (fired.length > 0) {
          windowDisplay = { version: 1, kind: "window_rules", chainId: SCAM_CHAIN_ID, token, pool: poolAddress,
            presetId: window.presetId, poolAgeSec: answer.window.poolAgeSec ?? 0, rules: fired };
        }
      }
    }
    const scam = sdkConfirmation(sdk?.display);
    finish({
      ...(scam ? { scam } : {}),
      ...(backdoor ? { backdoor } : {}),
      ...(windowDisplay ? { window: windowDisplay } : {}),
    });
  }

  return {
    promise,
    offer(actions) {
      if (started || settled) return;
      started = true;
      // Unexpected gate failures keep the existing routing. Explicit SDK
      // failures are values handled above, not policy denials.
      void run(actions).catch(() => finish({}));
    },
    close() { if (!started) finish({}); },
    cancel() { cancelRunning?.(); finish({}); },
  };
}
