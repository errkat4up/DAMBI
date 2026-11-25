import Browser from "webextension-polyfill";
import { backdoorConfirmKey, type BackdoorDisplay } from "@lib/backdoor-display";
import { windowConfirmKey, type WindowDisplay } from "@lib/window-display";

// Warnings evaluated inside the extension reach the confirmation page through
// session storage. The page removes its record after reading; the index bounds
// records whose window was closed or never opened.
const TTL_MS = 5 * 60_000;
const MAX_RECORDS = 8;
interface Entry { key: string; expiresAtMs: number }
let pending: Promise<void> = Promise.resolve();

function store(prefix: string, key: string, requestId: string, display: unknown): Promise<void> {
  const index = `${prefix}-index`;
  const work = pending.then(async () => {
    const now = Date.now();
    const raw = (await Browser.storage.session.get(index))[index];
    const previous: Entry[] = Array.isArray(raw) ? raw.filter((entry): entry is Entry =>
      !!entry && typeof entry.key === "string" && entry.key.startsWith(`${prefix}:`)
      && Number.isSafeInteger(entry.expiresAtMs)) : [];
    const retained = previous.filter((entry) => entry.key !== key && entry.expiresAtMs > now).slice(-(MAX_RECORDS - 1));
    const remove = previous.filter((entry) => entry.key !== key && !retained.includes(entry)).map((entry) => entry.key);
    if (remove.length) await Browser.storage.session.remove(remove);
    const record = { requestId, expiresAtMs: now + TTL_MS, display };
    await Browser.storage.session.set({ [key]: record, [index]: [...retained, { key, expiresAtMs: record.expiresAtMs }] });
  });
  pending = work.catch(() => {});
  return pending;
}

/** A storage failure only costs the address details: the page still shows the warning. */
export function storeBackdoorDisplay(requestId: string, display: BackdoorDisplay): Promise<void> {
  return store("backdoor:confirm", backdoorConfirmKey(requestId), requestId, display);
}

/** A storage failure leaves the page with the warning title but without the rule sentences. */
export function storeWindowDisplay(requestId: string, display: WindowDisplay): Promise<void> {
  return store("window:confirm", windowConfirmKey(requestId), requestId, display);
}
