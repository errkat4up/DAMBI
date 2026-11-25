// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  SCAM_SETTINGS_GET,
  SCAM_SETTINGS_SET,
  SCAM_SETTINGS_SET_WINDOW,
  handleScamSettingsRequest,
  isTrustedSettingsSender,
  type ScamSettingsDeps,
  type SettingsSender,
} from "../scam-settings-handlers";

// Every test injects its own storage and sender policy; real extension APIs must not be touched.
vi.mock("webextension-polyfill", () => ({ default: {} }));

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${ID}`;
const here = dirname(fileURLToPath(import.meta.url));

function harness(initial: Record<string, unknown> | undefined, allowDevDashboard = false, localInitial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = initial === undefined ? {} : { settings: initial };
  const local: Record<string, unknown> = { ...localInitial };
  const set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, items); });
  const setLocal = vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, items); });
  const deps: ScamSettingsDeps = {
    policy: { runtimeId: ID, extensionBaseUrl: `${ORIGIN}/`, allowDevDashboard },
    storage: { get: async (key) => ({ [key]: store[key] }), set },
    local: { get: async (key) => ({ [key]: local[key] }), set: setLocal },
  };
  return { store, local, set, setLocal, deps };
}
const PRESETS = ["window-sensitive", "window-balanced", "window-strict"];
const UNCONFIGURED = { configured: false, settings: null, presets: PRESETS, rejected: [], last: null };
const WINDOW = { enabled: true, presetId: "window-strict", overrides: [{ id: "r1-up-burst-strict", kind: "change_count", count: 6 }], additionalRules: [] };

const EXTENSION_PAGES: SettingsSender[] = [
  { id: ID, url: `${ORIGIN}/options.html#/scam` },
  { id: ID, url: `${ORIGIN}/popup.html` },
];
/** What the browser reports when one of this extension's content scripts sends from a web page. */
const WEB_PAGES: SettingsSender[] = [
  { id: ID, url: "https://app.uniswap.org/swap" },
  { id: ID, url: "https://evil.example/" },
  { id: ID, url: `https://evil.example/?next=${ORIGIN}/options.html` },
  { id: ID, url: `https://${ID}.evil.example/options.html` },
  { id: ID, url: `${ORIGIN}.evil.example/options.html` }, // extension id as a host prefix
  { id: ID, url: `chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/options.html` },
  { id: ID, url: "http://localhost:5173/" }, // dev dashboard origin, not allowed in this build
  { id: ID, url: "http://localhost:8765/backdoor-check-test.html" },
  { id: ID, url: "file:///home/user/page.html" },
  { id: ID, url: "about:blank" },
  { id: ID }, // no url
  { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: `${ORIGIN}/options.html` }, // another extension
  { url: `${ORIGIN}/options.html` }, // no sender id
];

describe("scam settings: who may send", () => {
  it("accepts the extension's own pages", () => {
    for (const sender of EXTENSION_PAGES) expect(isTrustedSettingsSender(sender, harness({}).deps.policy), sender.url).toBe(true);
  });

  it("rejects ordinary web pages, other extensions and senders without an origin", () => {
    const { deps } = harness({});
    for (const sender of WEB_PAGES) expect(isTrustedSettingsSender(sender, deps.policy), JSON.stringify(sender)).toBe(false);
    expect(isTrustedSettingsSender(undefined, deps.policy)).toBe(false);
  });

  it("accepts the dev dashboard origin only when the build allows the dev bridge", () => {
    const dev = { id: ID, url: "http://localhost:5173/scam" };
    expect(isTrustedSettingsSender(dev, harness({}, true).deps.policy)).toBe(true);
    expect(isTrustedSettingsSender({ id: ID, url: "http://127.0.0.1:5173/" }, harness({}, true).deps.policy)).toBe(true);
    expect(isTrustedSettingsSender(dev, harness({}, false).deps.policy)).toBe(false);
    // Allowing the dev bridge does not open any other web origin.
    expect(isTrustedSettingsSender({ id: ID, url: "http://localhost:3000/" }, harness({}, true).deps.policy)).toBe(false);
    expect(isTrustedSettingsSender({ id: ID, url: "https://localhost:5173/" }, harness({}, true).deps.policy)).toBe(false);
  });
});

describe("scam settings: a web page cannot change or read the setting", () => {
  it("never writes for a web-page sender, whatever the message says", async () => {
    for (const sender of WEB_PAGES) {
      const { store, set, deps } = harness({ preset: "std", backdoor: true });
      const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET, backdoor: false }, sender, deps);
      expect(res, JSON.stringify(sender)).toEqual({ ok: false, error: { kind: "forbidden_sender", message: expect.any(String) } });
      expect(set).not.toHaveBeenCalled();
      expect(store.settings).toEqual({ preset: "std", backdoor: true });
    }
  });

  it("never writes window-rule settings for a web-page sender", async () => {
    for (const sender of WEB_PAGES) {
      const { local, setLocal, deps } = harness({}, false, { "scam-filter:host-config": { version: 1 } });
      const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET_WINDOW, settings: WINDOW }, sender, deps);
      expect(res, JSON.stringify(sender)).toMatchObject({ ok: false, error: { kind: "forbidden_sender" } });
      expect(setLocal).not.toHaveBeenCalled();
      expect(local).toEqual({ "scam-filter:host-config": { version: 1 } });
    }
  });

  it("does not answer a read from a web page either", async () => {
    const { deps } = harness({ backdoor: false });
    const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_GET }, WEB_PAGES[0], deps);
    expect(res).toMatchObject({ ok: false, error: { kind: "forbidden_sender" } });
  });
});

describe("scam settings: from an extension page", () => {
  const page = EXTENSION_PAGES[0];

  it("reads the stored value, defaulting to on", async () => {
    expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_GET }, page, harness({ backdoor: false }).deps)).toEqual({ ok: true, data: { backdoor: false, windowRules: UNCONFIGURED } });
    expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_GET }, page, harness(undefined).deps)).toEqual({ ok: true, data: { backdoor: true, windowRules: UNCONFIGURED } });
    expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_GET }, page, harness({ backdoor: "no" }).deps)).toEqual({ ok: true, data: { backdoor: true, windowRules: UNCONFIGURED } });
  });

  it("changes only the backdoor field and keeps the notification settings", async () => {
    const notify = { preset: "loud", desk: "all", modal: "both", ribbon: true, sound: true };
    const { store, deps } = harness({ ...notify, backdoor: true });
    expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET, backdoor: false }, page, deps)).toEqual({ ok: true, data: { backdoor: false, windowRules: UNCONFIGURED } });
    expect(store.settings).toEqual({ ...notify, backdoor: false });
  });

  it("the backdoor switch works with no host configuration, and reports window rules as not configured", async () => {
    const { deps, setLocal } = harness({ backdoor: true });
    const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET, backdoor: false }, page, deps);
    expect(res).toEqual({ ok: true, data: { backdoor: false, windowRules: UNCONFIGURED } });
    expect(setLocal).not.toHaveBeenCalled();
  });

  it("stores the user's window-rule settings apart from the host configuration", async () => {
    const hostConfig = { version: 1, mode: "local-demo", scam: { config: { settings: { presetId: "deployed" } } } };
    const { local, set, deps } = harness({ backdoor: true }, false, { "scam-filter:host-config": hostConfig });
    const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET_WINDOW, settings: { ...WINDOW, locale: "xx", extra: 1 } }, page, deps);
    expect(res).toEqual({ ok: true, data: { backdoor: true, windowRules: { ...UNCONFIGURED, configured: true, settings: WINDOW } } });
    expect(local["scam-filter:settings"]).toEqual(WINDOW); // only the four user-owned fields
    expect(local["scam-filter:host-config"]).toEqual(hostConfig); // untouched
    expect(set).not.toHaveBeenCalled(); // the sync settings object is not involved
  });

  it("reports the last check and which saved rules the extension's check ignores", async () => {
    const last = { at: "2026-11-25T03:00:00.000Z", result: "undetermined", reason: "rate_limited", presetId: "window-sensitive", ms: 812 };
    const saved = { enabled: true, presetId: "window-sensitive",
      overrides: [{ id: "r1-up-burst-sensitive", kind: "change_count", lookbackSec: 7200 }, { id: "nope", kind: "change_count", count: 3 }],
      additionalRules: [{ id: "drop", kind: "window_drop", enabled: true, lookbackSec: 600, windowSec: 300, metric: "quote_reserve", dropBps: 5000 }] };
    const { deps } = harness({}, false, { "scam-filter:settings": saved, "scam-filter:window-last": { ...last, token: "0xabc", extra: 1 } });
    const res = await handleScamSettingsRequest({ type: SCAM_SETTINGS_GET }, page, deps);
    expect(res).toMatchObject({ ok: true, data: { windowRules: { configured: false, last, rejected: [
      { id: "r1-up-burst-sensitive", reason: "lookback_out_of_range" },
      { id: "nope", reason: "override_refers_to_absent_rule" },
      { id: "drop", reason: "unsupported_kind" },
    ] } } });
  });

  it("rejects malformed window-rule settings without writing", async () => {
    const bad = [undefined, null, {}, { ...WINDOW, enabled: "yes" }, { ...WINDOW, presetId: "" }, { ...WINDOW, presetId: "a b" },
      { ...WINDOW, overrides: "none" }, { ...WINDOW, overrides: [{ id: "x" }] }, { ...WINDOW, additionalRules: [null] },
      { ...WINDOW, additionalRules: Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, kind: "window_drop" })) },
      { ...WINDOW, overrides: [{ id: "x", kind: "window_drop", blob: "y".repeat(70_000) }] }];
    for (const settings of bad) {
      const { setLocal, deps } = harness({});
      expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET_WINDOW, settings }, page, deps), JSON.stringify(settings)?.slice(0, 80))
        .toMatchObject({ ok: false, error: { kind: "invalid_request" } });
      expect(setLocal).not.toHaveBeenCalled();
    }
  });

  it("rejects a malformed value without writing", async () => {
    for (const backdoor of [undefined, "false", 0, null, {}]) {
      const { set, deps } = harness({ backdoor: true });
      expect(await handleScamSettingsRequest({ type: SCAM_SETTINGS_SET, backdoor }, page, deps)).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
      expect(set).not.toHaveBeenCalled();
    }
  });

  it("leaves unrelated messages to the rest of the router", async () => {
    const { deps } = harness({});
    expect(await handleScamSettingsRequest({ type: "verdicts:list" }, page, deps)).toBeUndefined();
    expect(await handleScamSettingsRequest(null, page, deps)).toBeUndefined();
  });
});

describe("where the switch lives", () => {
  const read = (path: string) => readFileSync(join(here, "../../..", path), "utf8");

  it("the service worker passes the browser-supplied sender to the handler", () => {
    const index = read("backend/service-worker/index.ts");
    expect(index).toContain("handleScamSettingsRequest(req, sender, scamSettingsDeps())");
  });

  it("the popup has no scam-check control but still preserves the stored value across presets", () => {
    const popup = read("frontend/popup/popup.js");
    expect(popup).not.toContain("스캠 검사");
    expect(popup).not.toContain("backdoor");
    expect(popup.match(/\{ \.\.\.state\.settings, preset:/g)).toHaveLength(2);
  });

  it("the dev dashboard bridge only runs on the dev origins the handler knows", () => {
    const bridge = read("backend/content-scripts/dashboard-bridge.ts");
    const handler = read("backend/service-worker/scam-settings-handlers.ts");
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      expect(bridge).toContain(`"${origin}"`);
      expect(handler).toContain(`"${origin}"`);
    }
  });
});
