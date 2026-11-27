// Reuse the DEC handoff's complete suite list and D3 assertions on Native Core.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handoff, validateHandoffIndex } from "../../fixtures/decoder-policy/helpers/handoff.mjs";

process.env.DAMBI_FIXTURE_BACKEND = "native";
const { assertFixtureBackend } = await import("../../fixtures/sdk/helpers/native-backend.mjs");
await assertFixtureBackend();
await validateHandoffIndex();

const giwaManifest = "manifests/giwa/v2-router/swap-exact-eth-for-tokens@1.0.0.json";
const registryOriginal = new URL(`../../registryV2/${giwaManifest}`, import.meta.url);
const selectedInput = new URL(`../../fixtures/sdk/resolved-decoders/${giwaManifest}`, import.meta.url);
assert.deepEqual(await readFile(selectedInput), await readFile(registryOriginal),
  "the selected GIWA input must be byte-identical to its Registry source");

const files = [
  ...handoff.suites.map(({ verification }) => `fixtures/decoder-policy/${verification}`),
  "fixtures/sdk/policy-bundle.test.mjs",
  "fixtures/sdk/day1-policy.test.mjs",
  "fixtures/sdk/giwa-sf0/product-decoder.test.mjs",
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`Core fixture runner terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
