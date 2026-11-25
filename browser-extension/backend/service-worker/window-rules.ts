/**
 * Window rules evaluated inside the extension — the pure half: presets, the
 * user's settings laid over them, and the algorithm request. No I/O.
 *
 * The algorithm itself is the unmodified `crates/scam-filter`, reached through
 * the extension's own WASM (`scam_window_analyze_json`). This file only decides
 * WHICH rules run and builds the request the algorithm expects.
 *
 * Scope:
 *  - Only `change_count` rules. The other three kinds are ignored wherever they
 *    appear (preset, override, additional rule) and never evaluated.
 *  - Only pools inside their first hour since first liquidity. An older pool has
 *    no rule that can run, and no setting can switch one on.
 *  - `lookbackSec` can never exceed the fetched window (one hour).
 *
 * Settings keep the SDK's `ScamSettings` field names (`thresholdBps`,
 * `changeMode`, `count`, …) — the storage format from `scam-filter:settings` is
 * used as is. `toEngineRule` maps them onto the crate's wire names, the same
 * table as `crates/dambi-core/src/scam/window_rules.rs`.
 */

/** The fetched history: the pool's `Sync` logs over the last this-many blocks. */
export const WINDOW_BLOCKS = 300;
/** A pool is "new" for this long after its first liquidity. Mainnet: 300 blocks × 12 s. */
export const NEW_POOL_MAX_AGE_SEC = 3_600;
/** Mainnet slot time. Only used by the algorithm's resolution check. */
export const BUCKET_MS = 12_000;
const MAX_RULES = 16;

/** A `change_count` rule in the SDK's `ScamSettings` vocabulary. */
export interface ChangeCountRule {
  readonly kind: "change_count";
  readonly id: string;
  readonly enabled: boolean;
  readonly lookbackSec: number;
  readonly metric: "price_quote_per_token" | "quote_reserve";
  readonly direction: "up" | "down" | "either";
  readonly changeMode: "step" | "cumulative";
  readonly thresholdBps: number;
  readonly count: number;
}

const upBurst = (id: string, changeMode: ChangeCountRule["changeMode"], count: number): ChangeCountRule => ({
  kind: "change_count", id, enabled: true, lookbackSec: 300, metric: "price_quote_per_token",
  direction: "up", changeMode, thresholdBps: 2_000, count,
});

/**
 * Fixed presets — the new-pool side of `scam-bundle-draft.mainnet.json`. (Its
 * established side has every rule disabled, which here is simply "no rule runs
 * on an older pool".)
 */
export const WINDOW_PRESETS: Readonly<Record<string, readonly ChangeCountRule[]>> = Object.freeze({
  "window-sensitive": [upBurst("r1-up-burst-sensitive", "step", 5)],
  "window-balanced": [upBurst("r1-up-burst-balanced", "cumulative", 8)],
  "window-strict": [upBurst("r1-up-burst-strict", "step", 8)],
});
export const DEFAULT_WINDOW_PRESET = "window-sensitive";

/** The user-owned part of `ScamSettings`, as stored under `scam-filter:settings`. */
export interface WindowRuleSettings {
  readonly enabled: boolean;
  readonly presetId: string;
  readonly overrides: readonly Record<string, unknown>[];
  readonly additionalRules: readonly Record<string, unknown>[];
}
/** Nothing saved yet: off. Switching it on is the user's choice on the /scam page. */
export const DEFAULT_WINDOW_SETTINGS: WindowRuleSettings = Object.freeze({
  enabled: false, presetId: DEFAULT_WINDOW_PRESET, overrides: [], additionalRules: [],
});

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** A complete, in-range `change_count` rule, or the reason it is not one. */
export function parseChangeCountRule(value: unknown): ChangeCountRule | string {
  if (!record(value)) return "not_a_rule";
  if (value.kind !== "change_count") return "unsupported_kind";
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.id)) return "invalid_id";
  if (typeof value.enabled !== "boolean") return "invalid_enabled";
  // The window that was fetched is one hour; a longer lookback could not be observed.
  if (!int(value.lookbackSec, 1, NEW_POOL_MAX_AGE_SEC)) return "lookback_out_of_range";
  if (value.metric !== "price_quote_per_token" && value.metric !== "quote_reserve") return "invalid_metric";
  if (value.direction !== "up" && value.direction !== "down" && value.direction !== "either") return "invalid_direction";
  if (value.changeMode !== "step" && value.changeMode !== "cumulative") return "invalid_change_mode";
  if (!int(value.thresholdBps, 1, 1_000_000)) return "threshold_out_of_range";
  if (!int(value.count, 1, 1_000)) return "count_out_of_range";
  return { kind: "change_count", id: value.id, enabled: value.enabled, lookbackSec: value.lookbackSec, metric: value.metric,
    direction: value.direction, changeMode: value.changeMode, thresholdBps: value.thresholdBps, count: value.count };
}

export interface EffectiveRules {
  readonly presetId: string;
  /** Enabled, valid `change_count` rules — what is evaluated. */
  readonly rules: readonly ChangeCountRule[];
  /** Overrides and additional rules that were ignored, with the reason. */
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Preset rules with the user's overrides merged in by rule id, plus the user's
 * additional rules. Anything invalid is dropped and listed in `rejected`; it
 * never widens what runs. An unknown preset yields no rules.
 */
export function effectiveRules(settings: WindowRuleSettings): EffectiveRules {
  const preset = Object.hasOwn(WINDOW_PRESETS, settings.presetId) ? WINDOW_PRESETS[settings.presetId] : undefined;
  const rejected: { id: string; reason: string }[] = [];
  const idOf = (v: unknown): string => (record(v) && typeof v.id === "string" ? v.id.slice(0, 128) : "?");
  if (!preset) return { presetId: settings.presetId, rules: [], rejected: [{ id: settings.presetId.slice(0, 128), reason: "unknown_preset" }] };

  const rules: ChangeCountRule[] = [];
  const seen = new Set<string>();
  for (const base of preset) {
    let rule: ChangeCountRule = base;
    for (const override of settings.overrides) {
      if (!record(override) || override.id !== base.id) continue;
      const merged = parseChangeCountRule({ ...rule, ...override });
      if (typeof merged === "string") rejected.push({ id: base.id, reason: merged });
      else rule = merged;
    }
    rules.push(rule);
    seen.add(rule.id);
  }
  for (const override of settings.overrides) {
    if (!preset.some((rule) => record(override) && override.id === rule.id)) rejected.push({ id: idOf(override), reason: "override_refers_to_absent_rule" });
  }
  for (const extra of settings.additionalRules) {
    const parsed = parseChangeCountRule(extra);
    if (typeof parsed === "string") rejected.push({ id: idOf(extra), reason: parsed });
    else if (seen.has(parsed.id)) rejected.push({ id: parsed.id, reason: "duplicate_id" });
    else if (rules.length >= MAX_RULES) rejected.push({ id: parsed.id, reason: "too_many_rules" });
    else { rules.push(parsed); seen.add(parsed.id); }
  }
  return { presetId: settings.presetId, rules: rules.filter((rule) => rule.enabled), rejected };
}

/** The crate's wire names for one rule. */
export function toEngineRule(rule: ChangeCountRule): Record<string, unknown> {
  return {
    kind: "change_count", id: rule.id, lookbackSec: rule.lookbackSec,
    metric: rule.metric === "quote_reserve" ? "liquidity" : "price",
    direction: rule.direction === "either" ? "both" : rule.direction,
    mode: rule.changeMode, minChangeBps: rule.thresholdBps, minCount: rule.count,
  };
}

/** End-of-block reserves of a pool: the last `Sync` of one block. */
export interface PoolPoint {
  readonly block: number;
  readonly tMs: number;
  /** Raw integers as decimal strings. */
  readonly reserveQuote: string;
  readonly reserveToken: string;
}

/**
 * The algorithm request for one pool, as of `asOf`.
 *
 * Composition (the one the validation numbers were produced with): the history
 * is the points from the pool's first `Sync` on — nothing is synthesised before
 * it — and that first `Sync` is both the start of the history and the pool's
 * creation time for the algorithm. Times are real block timestamps.
 * Decimals are a fixed 18/18: every supported rule looks at relative change,
 * where a constant scale factor cancels out.
 */
export function buildAnalysisRequest(input: {
  chainId: number; pool: string; token: string; quote: string;
  asOf: { block: number; tMs: number };
  points: readonly PoolPoint[];
  rules: readonly ChangeCountRule[];
}): Record<string, unknown> {
  const fromMs = input.points[0]?.tMs ?? input.asOf.tMs;
  return {
    subject: { chainId: input.chainId, pool: input.pool, token: input.token, quote: input.quote, venue: "uniswap_v2" },
    asOf: { block: String(input.asOf.block), blockHash: "0x" + "0".repeat(64), tMs: input.asOf.tMs },
    rules: input.rules.map(toEngineRule),
    rulesHash: "0x" + "0".repeat(64),
    poolHistory: {
      schema: "extension.pool_history/1", builderVersion: "extension-local/1", fromMs, bucketMs: BUCKET_MS,
      points: input.points.map((p) => ({ tMs: p.tMs, reserveQuote: p.reserveQuote, reserveToken: p.reserveToken, decimalsQuote: 18, decimalsToken: 18 })),
      missing: [],
      warmup: { fromMs, complete: true },
    },
    tokenProfile: { schema: "extension.token_profile/1", poolCreatedMs: fromMs, adminEvents: [], missing: [] },
  };
}

/** The part of the crate's `ScamAnalysis` this extension reads. */
export interface EngineRuleResult {
  readonly ruleId: string;
  readonly outcome: "fired" | "clear" | "incomplete" | "not_evaluable";
  readonly reason?: string;
  readonly observed?: number;
  readonly threshold: number;
}
export interface EngineAnalysis { readonly rules: readonly EngineRuleResult[] }

/** Where the outcome of the most recent in-extension window check is kept (`chrome.storage.local`). */
export const WINDOW_STATUS_KEY = "scam-filter:window-last";

/**
 * Outcome of the most recent window check, for the /scam page. Holds the time,
 * the result, the reason, the preset and the duration — nothing about the user,
 * the token or the transaction.
 */
export interface WindowStatus {
  readonly at: string;
  readonly result: string;
  readonly reason: string;
  readonly presetId: string;
  readonly ms: number;
}

export function parseWindowStatus(value: unknown): WindowStatus | null {
  if (!record(value)) return null;
  const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128;
  if (!text(value.at) || !text(value.result) || !text(value.reason) || !text(value.presetId) || !int(value.ms, 0, 3_600_000)) return null;
  return { at: value.at, result: value.result, reason: value.reason, presetId: value.presetId, ms: value.ms };
}
