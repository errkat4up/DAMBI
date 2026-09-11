// One installation scenario per Node process: the legacy WASM Registry is global.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scenario = JSON.parse(await readFile(process.argv[2], "utf8"));
const wasm = await import("../../../crates/policy-engine-wasm/pkg/policy_engine_wasm.js");
await wasm.default({
  module_or_path: await readFile(new URL("../../../crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm", import.meta.url)),
});

const installations = scenario.bundles.map((bundle) => {
  const result = JSON.parse(wasm.declarative_install_v3_json(JSON.stringify(bundle)));
  assert.equal(result.ok, true, `WASM install failed: ${JSON.stringify(result)}`);
  assert.equal(result.data.bundle_id, bundle.id);
  assert.equal(result.data.decoder_id, bundle.id);
  return result;
});
const results = scenario.requests.map(({ id, input }) => ({
  id,
  result: JSON.parse(wasm.declarative_route_request_v3_json(JSON.stringify(input))),
}));
process.stdout.write(JSON.stringify({ installations, results }));
