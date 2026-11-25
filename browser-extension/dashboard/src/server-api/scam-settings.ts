/**
 * Scam-filter settings client — talks to the service worker
 * (`backend/service-worker/scam-settings-handlers.ts`) through the same
 * extension bridge the rest of the dashboard uses. The service worker accepts
 * these messages only from the extension's own pages (and, in development
 * builds, the dashboard dev server).
 */
import { sendToExtension } from "./extension-bridge";

/** The user-owned part of the SDK's `ScamSettings`. */
export interface WindowRuleSettings {
  enabled: boolean;
  presetId: string;
  overrides: Record<string, unknown>[];
  additionalRules: Record<string, unknown>[];
}

export interface WindowCheckStatus {
  at: string;
  result: string;
  reason: string;
  presetId: string;
  ms: number;
}

export interface ScamSettings {
  /** Pool-backdoor check on/off. */
  backdoor: boolean;
  windowRules: {
    /**
     * A host configuration is stored in the extension, so the SDK host runs the
     * window check. False — the ordinary case — means the extension's own check.
     */
    configured: boolean;
    /** What the user saved, or null when nothing is saved yet (off). */
    settings: WindowRuleSettings | null;
    /** Presets built into the extension. */
    presets: string[];
    /** Saved rule edits the extension's check ignores, with the reason. */
    rejected: { id: string; reason: string }[];
    /** Outcome of the most recent check, or null. */
    last: WindowCheckStatus | null;
  };
}

export function getScamSettings(): Promise<ScamSettings> {
  return sendToExtension<ScamSettings>({ type: "scam-settings:get" });
}

export function setBackdoorCheck(backdoor: boolean): Promise<ScamSettings> {
  return sendToExtension<ScamSettings>({ type: "scam-settings:set", backdoor });
}

export function setWindowRuleSettings(settings: WindowRuleSettings): Promise<ScamSettings> {
  return sendToExtension<ScamSettings>({ type: "scam-settings:set-window", settings });
}
