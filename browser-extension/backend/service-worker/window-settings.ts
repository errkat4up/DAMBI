/**
 * Storage for the in-extension window-rule check.
 *
 *  - Settings: `scam-filter:settings` in `chrome.storage.local`, the `ScamSettings`
 *    shape written by the /scam page (`scam-settings-handlers.ts`).
 *  - Last status: `scam-filter:window-last`, shown on the /scam page so a check
 *    that could not decide (lookup failure, rate limit, deadline) is visible
 *    with its reason.
 */
import Browser from "webextension-polyfill";
import { parseWindowRuleSettings } from "./scam-settings-handlers";
import { DEFAULT_WINDOW_SETTINGS, WINDOW_STATUS_KEY, type WindowRuleSettings, type WindowStatus } from "./window-rules";

const USER_SETTINGS_KEY = "scam-filter:settings";

/** The saved settings, or the defaults (off) when nothing valid is saved. */
export async function readWindowSettings(): Promise<WindowRuleSettings> {
  try {
    const stored = (await Browser.storage.local.get(USER_SETTINGS_KEY))[USER_SETTINGS_KEY];
    return parseWindowRuleSettings(stored) ?? DEFAULT_WINDOW_SETTINGS;
  } catch {
    return DEFAULT_WINDOW_SETTINGS;
  }
}

/** Best-effort: a failed write never affects the check. */
export function recordWindowStatus(status: WindowStatus): void {
  try {
    void Browser.storage.local.set({ [WINDOW_STATUS_KEY]: status }).catch(() => {});
  } catch {
    /* storage unavailable */
  }
}
