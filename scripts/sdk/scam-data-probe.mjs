import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readProbeConfig as readSharedConfig, runProbe } from "./scam-data-probe-session.mjs";

export { createProbeSession, probeCalls, runProbe, summarizeTrials } from "./scam-data-probe-session.mjs";
export function readProbeConfig(env = process.env) { return readSharedConfig(env); }

async function main() {
  try {
    const config = readProbeConfig();
    const { createScamFactProvider } = await import("@dambi/core/adapters");
    const result = await runProbe(config, createScamFactProvider);
    console.log(JSON.stringify(result, null, 2));
    if (result.summary.failed || result.preparation?.outcome === "failed") process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "probe_setup_failed",
      hint: "Check environment settings and build the current Core adapter. Endpoint, headers and remote errors are omitted." }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
