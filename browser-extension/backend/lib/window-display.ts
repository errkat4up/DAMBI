/**
 * Display payload for a window-rule warning decided by the server check
 * (not the SDK's `ScamReport`). A payload exists only when a rule fired.
 */
export interface WindowFiredRule {
  readonly id: string;
  /** Events counted in the lookback window. */
  readonly observed: number;
  /** Events needed for the rule to fire. */
  readonly threshold: number;
  readonly lookbackSec: number;
  readonly thresholdBps: number;
  readonly direction: "up" | "down" | "either";
  readonly changeMode: "step" | "cumulative";
  readonly metric: "price_quote_per_token" | "quote_reserve";
}

export interface WindowDisplay {
  readonly version: 1;
  readonly kind: "window_rules";
  readonly chainId: number;
  readonly token: string;
  readonly pool: string;
  readonly presetId: string;
  /** Seconds since the pool's first liquidity. */
  readonly poolAgeSec: number;
  readonly rules: readonly WindowFiredRule[];
}

export const WINDOW_WARNING_TITLE = "급격한 가격 변동 패턴 감지";

/** Delivered to the confirmation page through session storage, never in its URL. */
export const windowConfirmKey = (requestId: string): string => `window:confirm:${requestId}`;

export interface StoredWindowDisplay {
  readonly requestId: string;
  readonly expiresAtMs: number;
  readonly display: WindowDisplay;
}

/** One sentence per fired rule, built from the rule's own numbers. */
export function windowRuleSentence(rule: WindowFiredRule): string {
  const minutes = rule.lookbackSec % 60 === 0 ? `${rule.lookbackSec / 60}분` : `${rule.lookbackSec}초`;
  const percent = `${rule.thresholdBps / 100}%`;
  const subject = rule.metric === "quote_reserve" ? "풀의 유동성이" : "가격이";
  const move = rule.direction === "up" ? "오른" : rule.direction === "down" ? "내린" : "움직인";
  return `최근 ${minutes} 동안 ${subject} ${percent} 이상 ${move} 변동이 ${rule.observed}회 있었습니다 (기준 ${rule.threshold}회).`;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const count = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Validate what the confirmation page read back from session storage. */
export function readStoredWindowDisplay(value: unknown, requestId: string, nowMs: number): WindowDisplay | undefined {
  if (!requestId || typeof value !== "object" || value === null) return undefined;
  const stored = value as Partial<StoredWindowDisplay>;
  const d = stored.display as Partial<WindowDisplay> | undefined;
  if (stored.requestId !== requestId || typeof stored.expiresAtMs !== "number" || stored.expiresAtMs <= nowMs
      || typeof d !== "object" || d === null || d.version !== 1 || d.kind !== "window_rules"
      || !count(d.chainId, Number.MAX_SAFE_INTEGER) || !count(d.poolAgeSec, 1e9)
      || typeof d.token !== "string" || !ADDRESS.test(d.token) || typeof d.pool !== "string" || !ADDRESS.test(d.pool)
      || typeof d.presetId !== "string" || d.presetId.length > 128
      || !Array.isArray(d.rules) || d.rules.length === 0 || d.rules.length > 16) return undefined;
  const rules: WindowFiredRule[] = [];
  for (const r of d.rules as Partial<WindowFiredRule>[]) {
    if (typeof r !== "object" || r === null || typeof r.id !== "string" || r.id.length > 128
        || !count(r.observed, 1e9) || !count(r.threshold, 1e9) || !count(r.lookbackSec, 1e9) || !count(r.thresholdBps, 1e9)
        || !["up", "down", "either"].includes(String(r.direction)) || !["step", "cumulative"].includes(String(r.changeMode))
        || !["price_quote_per_token", "quote_reserve"].includes(String(r.metric))) return undefined;
    rules.push({ id: r.id, observed: r.observed, threshold: r.threshold, lookbackSec: r.lookbackSec, thresholdBps: r.thresholdBps,
      direction: r.direction as WindowFiredRule["direction"], changeMode: r.changeMode as WindowFiredRule["changeMode"],
      metric: r.metric as WindowFiredRule["metric"] });
  }
  return { version: 1, kind: "window_rules", chainId: d.chainId, token: d.token, pool: d.pool, presetId: d.presetId, poolAgeSec: d.poolAgeSec, rules };
}
