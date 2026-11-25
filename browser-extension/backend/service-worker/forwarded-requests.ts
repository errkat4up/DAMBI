/**
 * Requests Dambi itself let through to the wallet, remembered for a moment so
 * the bypass observer's copy of the same request is not judged a second time.
 *
 * `bypass-check.ts` watches the wallet's own message stream and reports every
 * `eth_sendTransaction` / signature it sees there as `bypassed: true`. A request
 * the wrapper already evaluated and allowed reaches the wallet through that same
 * stream, so it is reported too. "Bypassed" really means "seen at the wallet and
 * never decided by the wrapper"; this module supplies the second half.
 *
 *  - A fingerprint is stored only when the wrapper request was answered `ok`.
 *    A blocked request never reaches the wallet, so nothing is stored for it.
 *  - Fingerprint: tab, page origin, and the request itself (from, to, data,
 *    value for a transaction; signer and payload for a signature). The chain id
 *    is left out — the observer's chain id is a guess that defaults to 1.
 *  - Lifetime two minutes; one bypass message consumes one fingerprint, so the
 *    same request sent twice is matched twice.
 *
 * Kept in memory only. If the worker restarts in between, the copy is treated
 * as a genuine bypass row, which is observe-only anyway.
 */
import { RequestType, type MessageData } from "@lib/types";

export const FORWARDED_TTL_MS = 120_000;
const MAX_ENTRIES = 256;

/** Where a message came from, as the browser reports it (not the page). */
export interface RequestSource {
  readonly tabId: number;
  readonly origin: string;
}

export function sourceOf(sender: { tab?: { id?: number | undefined } | undefined; url?: string | undefined; origin?: string | undefined } | undefined): RequestSource | undefined {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return undefined;
  let origin = typeof sender?.origin === "string" ? sender.origin : undefined;
  if (!origin && typeof sender?.url === "string") {
    try { origin = new URL(sender.url).origin; } catch { /* no origin */ }
  }
  if (!origin || origin === "null") return undefined;
  return { tabId, origin };
}

interface Fingerprint {
  readonly kind: "tx" | "typed" | "untyped";
  /** Lowercased sender / signer. `undefined` when the request carries none. */
  readonly from: string | undefined;
  readonly to: string;
  /** Calldata, or the canonical signature payload. */
  readonly payload: string;
  /** Every amount the `value` field can mean, as decimal strings. */
  readonly values: readonly string[];
}

const address = (v: unknown): string | undefined =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? v.trim().toLowerCase() : undefined;

const hexData = (v: unknown): string => {
  if (typeof v !== "string") return "0x";
  const s = v.trim().toLowerCase();
  return s === "" || s === "0x" ? "0x" : s.startsWith("0x") ? s : `0x${s}`;
};

/**
 * The amounts a `value` can stand for. Missing or empty is 0. A `0x` string is
 * hex. A bare string is ambiguous — the Coinbase observer forwards hex without
 * the prefix, a dApp may pass decimal — so both readings are kept and two
 * requests agree when any reading does.
 */
export function valueReadings(v: unknown): string[] {
  if (v === undefined || v === null) return ["0"];
  if (typeof v === "bigint") return [v.toString()];
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? [String(v)] : [];
  if (typeof v !== "string") return [];
  const s = v.trim().toLowerCase();
  if (s === "" || s === "0x") return ["0"];
  try {
    if (s.startsWith("0x")) return /^0x[0-9a-f]+$/.test(s) ? [BigInt(s).toString()] : [];
    const out = new Set<string>();
    if (/^[0-9]+$/.test(s)) out.add(BigInt(s).toString());
    if (/^[0-9a-f]+$/.test(s)) out.add(BigInt(`0x${s}`).toString());
    return [...out];
  } catch {
    return [];
  }
}

/** JSON with object keys sorted, so key order does not change the text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Typed data arrives as an object from the wrapper and as parsed JSON from the observer. */
function typedPayload(typedData: unknown): string {
  if (typeof typedData === "string") {
    try { return canonical(JSON.parse(typedData)); } catch { return canonical(typedData); }
  }
  return canonical(typedData);
}

function fingerprintOf(data: MessageData): Fingerprint | undefined {
  if (data.type === RequestType.TRANSACTION) {
    const tx = (data.transaction ?? {}) as Record<string, unknown>;
    const values = valueReadings(tx.value);
    if (values.length === 0) return undefined;
    return { kind: "tx", from: address(tx.from), to: address(tx.to) ?? "", payload: hexData(tx.data ?? tx.input), values };
  }
  if (data.type === RequestType.TYPED_SIGNATURE) {
    return { kind: "typed", from: address(data.address), to: "", payload: typedPayload(data.typedData), values: ["0"] };
  }
  if (data.type === RequestType.UNTYPED_SIGNATURE) {
    // The wrapper's untyped payload carries no signer; only the message is compared.
    return { kind: "untyped", from: undefined, to: "", payload: String(data.message ?? ""), values: ["0"] };
  }
  return undefined;
}

interface Entry extends Fingerprint {
  readonly tabId: number;
  readonly origin: string;
  readonly expiresAtMs: number;
}

let entries: Entry[] = [];

/** Remember a wrapper request that was just allowed through to the wallet. */
export function rememberForwarded(source: RequestSource | undefined, data: MessageData, nowMs = Date.now()): void {
  if (!source) return;
  const fp = fingerprintOf(data);
  if (!fp) return;
  entries = entries.filter((e) => e.expiresAtMs > nowMs);
  if (entries.length >= MAX_ENTRIES) entries.shift();
  entries.push({ ...fp, tabId: source.tabId, origin: source.origin, expiresAtMs: nowMs + FORWARDED_TTL_MS });
}

/**
 * True when this bypass message is the wallet-side copy of a request the
 * wrapper allowed. The matching fingerprint is removed.
 *
 * The wrapper fills in a missing `from` with the connected account before it
 * asks for a verdict, but hands the wallet the dApp's original object. So a
 * copy without `from` matches on the remaining fields.
 */
export function consumeForwarded(source: RequestSource | undefined, data: MessageData, nowMs = Date.now()): boolean {
  entries = entries.filter((e) => e.expiresAtMs > nowMs);
  if (!source) return false;
  const fp = fingerprintOf(data);
  if (!fp) return false;
  const index = entries.findIndex((e) =>
    e.tabId === source.tabId && e.origin === source.origin && e.kind === fp.kind
    && (fp.from === undefined || e.from === undefined || e.from === fp.from)
    && e.to === fp.to && e.payload === fp.payload
    && e.values.some((v) => fp.values.includes(v)));
  if (index < 0) return false;
  entries.splice(index, 1);
  return true;
}

/** Tests only. */
export function resetForwarded(): void {
  entries = [];
}
