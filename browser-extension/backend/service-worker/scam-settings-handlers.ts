/**
 * Scam-filter settings messages for the dashboard's `/scam` page.
 *
 *   { type: "scam-settings:get" }                           → ScamSettingsView
 *   { type: "scam-settings:set", backdoor: boolean }        → ScamSettingsView
 *   { type: "scam-settings:set-window", settings: {...} }   → ScamSettingsView
 *
 * Two independent values:
 *  - `backdoor` lives where the service worker already reads it: the `backdoor`
 *    field of the `"settings"` object in `chrome.storage.sync`
 *    (`notify-settings.ts`). Other fields of that object are preserved.
 *  - Window rules: the user's `ScamSettings` (enabled, presetId, overrides,
 *    additionalRules) in `chrome.storage.local` under `scam-filter:settings`,
 *    apart from the deployment input in `scam-filter:host-config`. The host
 *    With a host configuration the SDK host lays them over the deployed
 *    settings and the Core validates them. Without one — the ordinary case —
 *    the extension's own window check reads them (`window-rules.ts`).
 *
 * Who may send these: the extension's own pages, and — in development builds
 * only — the dashboard dev server through the existing `dashboard-bridge`
 * content script. Nothing else. The extension's content scripts run on every
 * web page, so a message's `type` alone proves nothing about where it came
 * from; the browser-supplied `sender` does.
 */
import Browser from "webextension-polyfill";
import { WINDOW_PRESETS, WINDOW_STATUS_KEY, effectiveRules, parseWindowStatus, type WindowStatus } from "./window-rules";

export const SCAM_SETTINGS_GET = "scam-settings:get";
export const SCAM_SETTINGS_SET = "scam-settings:set";
export const SCAM_SETTINGS_SET_WINDOW = "scam-settings:set-window";
// Same keys as scam-filter.ts (not imported: that module pulls in the SDK runtime).
const HOST_CONFIG_KEY = "scam-filter:host-config";
const USER_SETTINGS_KEY = "scam-filter:settings";
const MAX_RULES = 16;
const MAX_SETTINGS_BYTES = 64_000;

/** The user-owned part of the SDK's `ScamSettings`. */
export interface WindowRuleSettings {
  readonly enabled: boolean;
  readonly presetId: string;
  readonly overrides: readonly Record<string, unknown>[];
  readonly additionalRules: readonly Record<string, unknown>[];
}
export interface ScamSettingsView {
  readonly backdoor: boolean;
  readonly windowRules: {
    /**
     * A host configuration is stored, so the SDK host runs the window check.
     * False — the ordinary case — means the extension's own check is used.
     */
    readonly configured: boolean;
    /** What the user saved, or null when they have saved nothing yet (off). */
    readonly settings: WindowRuleSettings | null;
    /** Presets built into the extension. */
    readonly presets: readonly string[];
    /** Saved overrides / additional rules the extension's check ignores, with the reason. */
    readonly rejected: readonly { readonly id: string; readonly reason: string }[];
    /** Outcome of the most recent window check, or null. */
    readonly last: WindowStatus | null;
  };
}

const SETTINGS_KEY = "settings";
const BACKDOOR_DEFAULT = true; // keep equal to NOTIFY_DEFAULTS.backdoor

/** Same origins `content-scripts/dashboard-bridge.ts` accepts. Keep in sync. */
const DEV_DASHBOARD_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

export interface SettingsSender {
  /** Extension id of the sender, set by the browser. */
  readonly id?: string;
  /** URL of the page or frame that sent the message, set by the browser. */
  readonly url?: string;
}

export interface SenderPolicy {
  readonly runtimeId: string;
  /**
   * `runtime.getURL("")`, e.g. `chrome-extension://<id>/` — with the trailing
   * slash. Compared as a URL prefix rather than through `URL.origin`, which is
   * the opaque string "null" for extension schemes outside the browser.
   */
  readonly extensionBaseUrl: string;
  /** Whether the dev dashboard bridge is an accepted channel in this build. */
  readonly allowDevDashboard: boolean;
}

function originOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * True only for the extension's own pages and (when allowed) the dev dashboard
 * origin. A content script on an ordinary web page has this extension's `id`
 * but that page's `url`, so it is rejected.
 */
export function isTrustedSettingsSender(sender: SettingsSender | undefined, policy: SenderPolicy): boolean {
  if (!sender || sender.id !== policy.runtimeId) return false;
  if (typeof sender.url !== "string") return false;
  // The trailing slash ends the host, so `…<id>.evil.example` cannot match.
  if (policy.extensionBaseUrl.endsWith("/") && sender.url.startsWith(policy.extensionBaseUrl)) return true;
  const origin = originOf(sender.url);
  return policy.allowDevDashboard && origin !== null && DEV_DASHBOARD_ORIGINS.has(origin);
}

interface SyncArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ScamSettingsDeps {
  readonly policy: SenderPolicy;
  /** `chrome.storage.sync` — holds the `settings` object with `backdoor`. */
  readonly storage: SyncArea;
  /** `chrome.storage.local` — holds the host configuration and the user's window-rule settings. */
  readonly local: SyncArea;
}

type Envelope =
  | { ok: true; data: ScamSettingsView }
  | { ok: false; error: { kind: string; message: string } };

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readSettings(storage: SyncArea): Promise<Record<string, unknown>> {
  const stored = (await storage.get(SETTINGS_KEY))[SETTINGS_KEY];
  return record(stored) ? stored : {};
}

/**
 * Shape check only — ids, kinds and sizes. Ranges, preset existence and rule
 * semantics are the Core's to validate against the signed bundle.
 */
export function parseWindowRuleSettings(value: unknown): WindowRuleSettings | null {
  if (!record(value) || typeof value.enabled !== "boolean"
      || typeof value.presetId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.presetId)) return null;
  const rules = (list: unknown): Record<string, unknown>[] | null =>
    Array.isArray(list) && list.length <= MAX_RULES && list.every((rule) =>
      record(rule) && typeof rule.id === "string" && rule.id.length > 0 && rule.id.length <= 128
      && typeof rule.kind === "string" && rule.kind.length > 0 && rule.kind.length <= 64)
      ? (list as Record<string, unknown>[]) : null;
  const overrides = rules(value.overrides), additionalRules = rules(value.additionalRules);
  if (!overrides || !additionalRules) return null;
  const parsed: WindowRuleSettings = { enabled: value.enabled, presetId: value.presetId, overrides, additionalRules };
  let json: string;
  try { json = JSON.stringify(parsed); } catch { return null; }
  if (json.length > MAX_SETTINGS_BYTES) return null;
  return JSON.parse(json) as WindowRuleSettings; // a plain JSON copy: nothing but data is stored
}

async function view(deps: ScamSettingsDeps): Promise<ScamSettingsView> {
  const [current, local] = await Promise.all([
    readSettings(deps.storage),
    Promise.all([deps.local.get(HOST_CONFIG_KEY), deps.local.get(USER_SETTINGS_KEY), deps.local.get(WINDOW_STATUS_KEY)]),
  ]);
  const settings = parseWindowRuleSettings(local[1][USER_SETTINGS_KEY]);
  return {
    backdoor: typeof current.backdoor === "boolean" ? current.backdoor : BACKDOOR_DEFAULT,
    windowRules: {
      configured: local[0][HOST_CONFIG_KEY] !== undefined,
      settings,
      presets: Object.keys(WINDOW_PRESETS),
      rejected: settings ? effectiveRules(settings).rejected : [],
      last: parseWindowStatus(local[2][WINDOW_STATUS_KEY]),
    },
  };
}

const SCAM_SETTINGS_TYPES = new Set([SCAM_SETTINGS_GET, SCAM_SETTINGS_SET, SCAM_SETTINGS_SET_WINDOW]);

/**
 * Returns `undefined` for messages that are not scam-settings requests, so the
 * caller's router can keep going. Never writes for an untrusted sender or a
 * malformed value.
 */
export async function handleScamSettingsRequest(
  request: unknown,
  sender: SettingsSender | undefined,
  deps: ScamSettingsDeps,
): Promise<Envelope | undefined> {
  if (!record(request)) return undefined;
  if (typeof request.type !== "string" || !SCAM_SETTINGS_TYPES.has(request.type)) return undefined;
  if (!isTrustedSettingsSender(sender, deps.policy)) {
    return { ok: false, error: { kind: "forbidden_sender", message: "scam settings are only available to the extension's own pages" } };
  }
  try {
    if (request.type === SCAM_SETTINGS_SET) {
      if (typeof request.backdoor !== "boolean") {
        return { ok: false, error: { kind: "invalid_request", message: "backdoor must be a boolean" } };
      }
      const current = await readSettings(deps.storage);
      await deps.storage.set({ [SETTINGS_KEY]: { ...current, backdoor: request.backdoor } });
    } else if (request.type === SCAM_SETTINGS_SET_WINDOW) {
      const settings = parseWindowRuleSettings(request.settings);
      if (!settings) {
        return { ok: false, error: { kind: "invalid_request", message: "window-rule settings are malformed" } };
      }
      // Only the user's settings key is written; the host configuration is never touched from here.
      await deps.local.set({ [USER_SETTINGS_KEY]: settings });
    }
    return { ok: true, data: await view(deps) };
  } catch (err) {
    return { ok: false, error: { kind: "scam_settings_failed", message: String(err) } };
  }
}

export function isScamSettingsRequest(request: unknown): boolean {
  return record(request) && typeof request.type === "string" && SCAM_SETTINGS_TYPES.has(request.type);
}

/** Production wiring: the real runtime id, extension origin and sync storage. */
export function scamSettingsDeps(): ScamSettingsDeps {
  return {
    policy: {
      runtimeId: Browser.runtime.id,
      extensionBaseUrl: Browser.runtime.getURL(""),
      // The dev bridge content script is not shipped in production builds.
      allowDevDashboard: process.env.NODE_ENV !== "production",
    },
    storage: Browser.storage.sync,
    local: Browser.storage.local,
  };
}
