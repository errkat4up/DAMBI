import { readFile } from "node:fs/promises";
import { CoreError } from "@dambi/core";
import { AdapterError } from "@dambi/core/adapters";
import { createAdapterCore } from "./client.mjs";

const controller = new AbortController();
const cancel = () => controller.abort();
let core;
let phase = "configuration";
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--request") {
    throw new Error("Invalid arguments");
  }
  const settings = JSON.parse(await readFile(args[1], "utf8"));
  const request = JSON.parse(await readFile(args[3], "utf8"));
  phase = "initialization";
  core = await createAdapterCore(settings, { signal: controller.signal });
  phase = "check";
  const verdict = await core.check(request, { signal: controller.signal });
  console.log(JSON.stringify(verdict, null, 2));
  // A completed deny/warn is a verdict; a failed evaluation is a failed command.
  if (verdict.source === "fail_closed") process.exitCode = 1;
} catch (error) {
  const code = error instanceof CoreError || error instanceof AdapterError ? error.code
    : controller.signal.aborted ? "ABORTED"
      : phase === "configuration" ? "INVALID_INPUT" : "CHECK_FAILED";
  console.error(JSON.stringify({
    status: "failed", phase, error: { code },
    hint: "Use node node.mjs --config <private-config.json> --request <request.json>. Check endpoints, public trust keys and limits locally.",
  }, null, 2));
  process.exitCode = 1;
} finally {
  core?.dispose();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
