import Browser from "webextension-polyfill";
import { scamConfirmKey, type ScamDisplay, type StoredScamDisplay } from "@lib/scam-display";

// Bound unread informational windows too. The confirmation page removes its
// own record after reading; an index handles closed/unopened pages on next use.
const INDEX = "scam:confirm-index";
const TTL_MS = 5 * 60_000;
const MAX_RECORDS = 8;
const MAX_BYTES = 512_000;
interface Entry { key: string; expiresAtMs: number }
let pending: Promise<void> = Promise.resolve();

/** Storage failure is shown as unavailable by the page, never an auto-approval. */
export function storeScamDisplay(requestId: string, display: ScamDisplay): Promise<void> {
  const work = pending.then(async () => {
    const now = Date.now(), key = scamConfirmKey(requestId);
    const raw = (await Browser.storage.session.get(INDEX))[INDEX];
    const previous: Entry[] = Array.isArray(raw) ? raw.filter((entry): entry is Entry =>
      !!entry && typeof entry.key === "string" && entry.key.startsWith("scam:confirm:")
      && Number.isSafeInteger(entry.expiresAtMs)) : [];
    const retained = previous.filter((entry) => entry.key !== key && entry.expiresAtMs > now).slice(-(MAX_RECORDS - 1));
    const remove = previous.filter((entry) => entry.key !== key && !retained.includes(entry)).map((entry) => entry.key);
    if (remove.length) await Browser.storage.session.remove(remove);
    const selected: ScamDisplay = new TextEncoder().encode(JSON.stringify(display)).byteLength <= MAX_BYTES
      ? display : { version: 1, kind: "unavailable", reason: "host_error", holding: "unknown" };
    const record: StoredScamDisplay = { requestId, expiresAtMs: now + TTL_MS, display: selected };
    await Browser.storage.session.set({ [key]: record, [INDEX]: [...retained, { key, expiresAtMs: record.expiresAtMs }] });
  });
  pending = work.catch(() => {});
  return pending;
}
