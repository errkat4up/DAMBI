// Reuse the DEC handoff's complete suite list and D3 assertions on Native Core.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handoff, validateHandoffIndex } from "../../fixtures/decoder-policy/helpers/handoff.mjs";

process.env.DAMBI_FIXTURE_BACKEND = "native";
const { assertFixtureBackend } = await import("../../fixtures/sdk/helpers/native-backend.mjs");
await assertFixtureBackend();
await validateHandoffIndex();

const files = [
  ...handoff.suites.map(({ verification }) => `fixtures/decoder-policy/${verification}`),
  "fixtures/sdk/policy-bundle.test.mjs",
  "fixtures/sdk/day1-policy.test.mjs",
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Core fixture runner terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
