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
const results = scenario.requests.map(({ id, kind = "transaction", input }) => {
  assert.ok(kind === "transaction" || kind === "typed", `Unknown request kind: ${kind}`);
  if (scenario.policyBundle !== undefined) {
    assert.equal(kind, "transaction", "DEC-02 policy evaluation requires a transaction request");
  }
  const route = kind === "typed"
    ? wasm.declarative_route_typed_data_v3_json
    : wasm.declarative_route_request_v3_json;
  const result = JSON.parse(route(JSON.stringify(input)));
  // Preserve DEC-01's input/output contract when no policy bundle is supplied.
  if (scenario.policyBundle === undefined) return { id, result };

  assert.equal(result.ok, true, `Decode before policy evaluation failed: ${id}: ${JSON.stringify(result)}`);
  assert.equal(result.error, null);
  assert.equal(result.data.actions.length, 1);
  const decoded = result.data.actions[0];
  // Forward the actual decoded Action; never reconstruct its token, spender,
  // amount or meta from fixture expectations. Tx routing comes from the request.
  const evaluationInput = {
    action: decoded.body,
    meta: decoded.meta,
    tx: {
      chain_id: `eip155:${input.chain_id}`,
      from: input.submitter,
      to: input.to,
    },
  };
  const plan = JSON.parse(wasm.plan_action_rpc_v2_json(JSON.stringify({
    ...evaluationInput,
    manifests: [scenario.policyBundle.manifest],
  })));
  const evaluation = JSON.parse(wasm.evaluate_action_v2_json(JSON.stringify({
    ...evaluationInput,
    bundles: [scenario.policyBundle],
    results: {},
  })));
  return { id, result, plan, evaluation };
});
process.stdout.write(JSON.stringify({ installations, results }));
