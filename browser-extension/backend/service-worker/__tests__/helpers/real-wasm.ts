/**
 * The extension's real WASM build, loaded from disk for tests that must run the
 * actual algorithm (not a mock). `backend/wasm/` is produced by
 * `yarn prepare:wasm`, which `yarn typecheck` runs before the test job.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, scam_window_analyze_json, scam_window_events_json } from "../../../wasm/policy_engine_wasm";

const here = dirname(fileURLToPath(import.meta.url));
let ready = false;
function load(): void {
  if (ready) return;
  initSync({ module: readFileSync(join(here, "../../../wasm/policy_engine_wasm_bg.wasm")) });
  ready = true;
}
function unwrap<T>(json: string): T {
  const parsed = JSON.parse(json) as { ok: boolean; data?: T; error?: { kind: string; message: string } };
  if (!parsed.ok) throw new Error(`${parsed.error?.kind}: ${parsed.error?.message}`);
  return parsed.data as T;
}

export function realWindowAnalyze<T>(request: unknown): T {
  load();
  return unwrap<T>(scam_window_analyze_json(JSON.stringify(request)));
}
export function realWindowEvents(input: unknown): number[] {
  load();
  return unwrap<number[]>(scam_window_events_json(JSON.stringify(input)));
}
