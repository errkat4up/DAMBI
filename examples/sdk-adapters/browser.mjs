import { CoreError } from "@dambi/core";
import { AdapterError } from "@dambi/core/adapters";
import { decoderSnapshotInfo } from "@dambi/core/decoders";
import { createAdapterCore } from "./client.mjs";
import { checkWithTiming } from "./check-timing.mjs";

const settingsInput = document.querySelector("#settings");
const requestInput = document.querySelector("#request");
const checkButton = document.querySelector("#check");
const cancelButton = document.querySelector("#cancel");
const result = document.querySelector("#result");
const timing = document.createElement("small");
timing.id = "check-timing";
timing.setAttribute("role", "status");
timing.setAttribute("aria-live", "polite");
result.insertAdjacentElement("afterend", timing);
let active;

// These are editable demonstration limits, not production recommendations.
settingsInput.value = JSON.stringify({
  policy: { baseUrl: "", maxResponseBytes: 1_100_000 },
  fact: { chains: { "eip155:1": { rpcUrl: "" } }, maxResponseBytes: 16_384 },
  trust: { env: "staging", profile: "default", keys: [] },
  limits: {
    allowedClockSkewMs: 60_000,
    maxPolicyBytes: 1_000_000,
    maxDecoderBytes: decoderSnapshotInfo.bytes,
    maxRequestBytes: 256_000,
    maxFactBytes: 1_000_000,
    maxPlanCalls: 64,
    maxPendingPlans: 16,
    planTtlMs: 60_000,
    maxFactAgeMs: 30_000,
    factTimeoutMs: 5_000,
    policyTimeoutMs: 10_000,
  },
  enforcement: "advisory",
}, null, 2);
requestInput.value = JSON.stringify({
  kind: "transaction", chainId: "eip155:1", from: "", to: "", data: "0x", value: "0",
}, null, 2);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Conservative sample guard; callers must also ensure URL paths contain no secrets. */
export function assertBrowserSettings(settings) {
  function endpoint(config, key) {
    if (!record(config) || typeof config[key] !== "string") throw new Error("Browser settings invalid");
    if (config.headers !== undefined && (!record(config.headers) || Object.keys(config.headers).length > 0)) {
      throw new Error("Browser credentials are not supported");
    }
    const input = config[key];
    if (/[\s\\]/.test(input)) throw new Error("Browser settings invalid");
    const url = new URL(input);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash
        || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
      throw new Error("Use an endpoint approved for public browser access");
    }
  }
  if (!record(settings) || !record(settings.fact) || !record(settings.fact.chains)) {
    throw new Error("Browser settings invalid");
  }
  endpoint(settings.policy, "baseUrl");
  for (const config of Object.values(settings.fact.chains)) endpoint(config, "rpcUrl");
}

checkButton.addEventListener("click", async () => {
  if (active) return;
  const operation = { controller: new AbortController(), core: undefined };
  active = operation;
  checkButton.disabled = true;
  cancelButton.disabled = false;
  settingsInput.readOnly = requestInput.readOnly = true;
  let phase = "configuration";
  result.textContent = "Checking…";
  timing.textContent = "";
  try {
    const settings = JSON.parse(settingsInput.value);
    const request = JSON.parse(requestInput.value);
    assertBrowserSettings(settings);
    phase = "initialization";
    operation.core = await createAdapterCore(settings, { signal: operation.controller.signal });
    phase = "check";
    const verdict = await checkWithTiming(operation.core, request, { signal: operation.controller.signal }, (measurement) => {
      const modes = measurement.analysisModes?.length ? ` Algorithm: ${measurement.analysisModes.join(", ")}.` : "";
      timing.textContent = `Check ${measurement.outcome}: ${measurement.checkDurationMs.toFixed(1)} ms; `
        + `${measurement.withinBudget ? "within" : "over"} ${measurement.targetBudgetMs} ms comparison.${modes} `
        + "Latency only; excludes initialization, preparation and display. This does not establish analysis completeness or performance acceptance.";
    });
    result.textContent = JSON.stringify(verdict, null, 2);
  } catch (error) {
    const code = error instanceof CoreError || error instanceof AdapterError ? error.code
      : operation.controller.signal.aborted ? "ABORTED"
        : phase === "configuration" ? "INVALID_INPUT" : "CHECK_FAILED";
    result.textContent = JSON.stringify({
      status: "failed", phase, error: { code },
      hint: "Check public endpoint URLs, CORS, public trust keys and limits. This sample accepts no custom headers, URL userinfo or query strings.",
    }, null, 2);
  } finally {
    operation.core?.dispose();
    active = undefined;
    checkButton.disabled = false;
    cancelButton.disabled = true;
    settingsInput.readOnly = requestInput.readOnly = false;
  }
});

cancelButton.addEventListener("click", () => active?.controller.abort());
window.addEventListener("pagehide", () => {
  active?.controller.abort();
  active?.core?.dispose();
});
