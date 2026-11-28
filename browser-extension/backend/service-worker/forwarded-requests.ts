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
 *  - Positive correlation requires matching browser tab/frame/origin and known
 *    chain, method, signer and request fields. Incomplete context is observed.
 *  - Lifetime two minutes; one bypass message consumes one fingerprint, so the
 *    same request sent twice is matched twice.
 *
 * Kept in memory only. If the worker restarts in between, the copy is treated
 * as a genuine bypass row, which is observe-only anyway.
 */
import { walletAddress, walletChainId, walletQuantity } from "@lib/wallet-request-fields";
import { RequestType, type MessageData } from "@lib/types";

export const FORWARDED_TTL_MS = 120_000;
const MAX_ENTRIES = 256;

/** Where a message came from, as the browser reports it (not the page). */
export interface RequestSource {
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
}

export function sourceOf(sender: { tab?: { id?: number | undefined } | undefined; frameId?: number | undefined; url?: string | undefined; origin?: string | undefined } | undefined): RequestSource | undefined {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (typeof tabId !== "number" || !Number.isSafeInteger(frameId) || frameId === undefined || frameId < 0) return undefined;
  let origin = typeof sender?.origin === "string" ? sender.origin : undefined;
  if (!origin && typeof sender?.url === "string") {
    try { origin = new URL(sender.url).origin; } catch { /* no origin */ }
  }
  if (!origin || origin === "null") return undefined;
  return { tabId, frameId, origin };
}

interface Fingerprint {
  readonly method: string;
  readonly chainId: number;
  readonly signer: string;
  readonly to: string;
  readonly payload: string;
  readonly value: string;
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
  if (data.type !== RequestType.TRANSACTION && data.type !== RequestType.TYPED_SIGNATURE
      && data.type !== RequestType.UNTYPED_SIGNATURE) return undefined;
  const chainId = walletChainId(data.chainId);
  const method = data.method;
  if (chainId === undefined || !method) return undefined;
  if (data.type === RequestType.TRANSACTION) {
    const tx = data.transaction;
    if (!tx || !walletAddress(tx.from) || (tx.to != null && !walletAddress(tx.to))) return undefined;
    const raw = tx as Record<string, unknown>;
    const dataHex = raw.data ?? raw.input ?? "0x";
    if (typeof dataHex !== "string" || !/^0x(?:[a-f0-9]{2})*$/i.test(dataHex)) return undefined;
    const amount = walletQuantity(tx.value ?? 0);
    if (amount === undefined) return undefined;
    return { method, chainId, signer: tx.from.toLowerCase(), to: tx.to?.toLowerCase() ?? "", payload: dataHex.toLowerCase(), value: amount.toString() };
  }
  if (!walletAddress(data.address)) return undefined;
  const signer = data.address.toLowerCase();
  const payload = data.type === RequestType.TYPED_SIGNATURE ? typedPayload(data.typedData) : data.message;
  return { method, chainId, signer, to: "", payload, value: "" };
}

interface Entry extends Fingerprint {
  readonly requestId: string | undefined;
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
  readonly expiresAtMs: number;
}

let entries: Entry[] = [];

/** Remember a wrapper request that was just allowed through to the wallet. */
export function rememberForwarded(source: RequestSource | undefined, data: MessageData, nowMs = Date.now(), requestId?: string): void {
  if (!source) return;
  const fp = fingerprintOf(data);
  if (!fp) return;
  entries = entries.filter((e) => e.expiresAtMs > nowMs);
  if (entries.length >= MAX_ENTRIES) entries.shift();
  entries.push({ ...fp, requestId, tabId: source.tabId, frameId: source.frameId, origin: source.origin, expiresAtMs: nowMs + FORWARDED_TTL_MS });
}

/**
 * True when this bypass message is the wallet-side copy of a request the
 * wrapper allowed. The matching fingerprint is removed.
 *
 * Missing signer, chain or method leaves an observation available for audit.
 */
export function consumeForwarded(source: RequestSource | undefined, data: MessageData, nowMs = Date.now()): boolean {
  entries = entries.filter((e) => e.expiresAtMs > nowMs);
  if (!source) return false;
  const fp = fingerprintOf(data);
  if (!fp) return false;
  const index = entries.findIndex((e) =>
    e.tabId === source.tabId && e.frameId === source.frameId && e.origin === source.origin
    && e.chainId === fp.chainId && e.method === fp.method && e.signer === fp.signer
    && e.to === fp.to && e.payload === fp.payload && e.value === fp.value);
  if (index < 0) return false;
  entries.splice(index, 1);
  return true;
}

/** Retract only the unused correlation for a decision whose wallet handoff was cancelled. */
export function discardForwarded(source: RequestSource | undefined, requestId: string): void {
  if (!source || !requestId) return;
  entries = entries.filter((e) => e.requestId !== requestId || e.tabId !== source.tabId
    || e.frameId !== source.frameId || e.origin !== source.origin);
}

/** Tests only. */
export function resetForwarded(): void {
  entries = [];
}
