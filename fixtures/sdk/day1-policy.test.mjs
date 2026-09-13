import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadPolicyBundle } = require("../../scripts/sdk/policy-bundle.cjs");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("./day1-policy.cases.json", import.meta.url), "utf8"));
const baseline = JSON.parse(await readFile(new URL("../baseline-verdicts.json", import.meta.url), "utf8"));
const policies = new Map(fixture.policies.map((policy) => [policy.id, policy]));
let bundles;
let wasm;

function parentAt(object, path) {
  const parts = path.split(".");
  const key = parts.pop();
  for (const part of parts) {
    assert.ok(Object.hasOwn(object, part), `Unknown fixture path: ${path}`);
    object = object[part];
  }
  assert.ok(Object.hasOwn(object, key), `Unknown fixture path: ${path}`);
  return { object, key };
}

function inputFor(entry) {
  const template = fixture.action_templates[entry.action];
  assert.ok(template, `Unknown Action template: ${entry.action}`);
  const input = structuredClone({
    action: template.action,
    meta: fixture.meta_templates[template.meta],
    tx: fixture.tx,
  });
  for (const [path, value] of Object.entries(entry.set ?? {})) {
    const { object, key } = parentAt(input, path);
    object[key] = structuredClone(value);
  }
  for (const path of entry.omit ?? []) {
    const { object, key } = parentAt(input, path);
    delete object[key];
  }
  return input;
}

function runInput(input) {
  // Both phases consume the same shared manifests. No external Facts or
  // token-decimal/order enrichment are supplied; this is the actual v2 API.
  const plan = JSON.parse(wasm.plan_action_rpc_v2_json(JSON.stringify({
    ...input, manifests: bundles.map(({ manifest }) => manifest),
  })));
  const evaluation = JSON.parse(wasm.evaluate_action_v2_json(JSON.stringify({
    ...input, bundles, results: {},
  })));
  return { plan, evaluation };
}

before(async () => {
  // This suite never builds WASM or skips missing prerequisites. No decoder
  // Registry is installed, so no separate worker/global-registry cleanup is needed.
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; build the paired legacy JS/WASM first (see README.md).`);
    });
  }
  bundles = loadPolicyBundle(repoRoot, fixture.bundle);
  assert.equal(baseline.source.bundle, fixture.bundle);
  wasm = await import("../../crates/policy-engine-wasm/pkg/policy_engine_wasm.js");
  await wasm.default({
    module_or_path: await readFile(new URL("../../crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm", import.meta.url)),
  });
  for (const name of ["plan_action_rpc_v2_json", "evaluate_action_v2_json"]) {
    assert.equal(typeof wasm[name], "function", `Missing ${name}; rebuild the paired legacy JS/WASM.`);
  }
});

test("shared Day-1 bundle pins five policies, severity, triggers and no external Facts", async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "policy-bundles", fixture.bundle, "package.json"), "utf8"));
  assert.equal(pkg.package, fixture.bundle);
  assert.deepEqual(pkg.fact_dependencies, []);
  assert.deepEqual(pkg.policies.map(({ id }) => id), fixture.policies.map(({ id }) => id));
  assert.deepEqual(bundles.map(({ id }) => id), fixture.policies.map(({ id }) => id));
  for (const { id, policy, manifest } of bundles) {
    const expected = policies.get(id);
    const declaration = pkg.policies.find((entry) => entry.id === id);
    assert.equal(declaration.severity, expected.severity, id);
    assert.deepEqual(expected.requires_facts, [], id);
    assert.deepEqual(declaration.requires_facts, [], id);
    assert.equal(manifest.id, id);
    assert.equal(manifest.schema_version, 2);
    assert.deepEqual(manifest.trigger, expected.trigger, id);
    assert.deepEqual(manifest.policy_rpc ?? [], [], id);
    assert.deepEqual(manifest.custom_context?.fields ?? {}, {}, id);
    assert.ok(policy.includes(`@id("${id}")`), id);
    assert.ok(policy.includes(`@severity("${expected.severity}")`), id);
    if (expected.reason !== null) assert.ok(policy.includes(`@reason("${expected.reason}")`), id);
  }
});

// Keep the established baseline's inputs and complete expected DTOs intact.
// Its serialized bundle SHA-256 is guarded by policy-bundle.test.mjs.
for (const entry of baseline.cases) {
  test(`baseline/${entry.id}: shared source preserves the recorded verdict`, () => {
    assert.deepEqual(entry.input.results, {});
    const { plan, evaluation } = runInput({
      ...entry.input, meta: baseline.fixed_meta, tx: baseline.fixed_tx,
    });
    assert.deepEqual(plan, { ok: true, data: { planned: [] }, error: null });
    assert.deepEqual(evaluation, entry.expected);
  });
}

for (const entry of fixture.cases) {
  test(`${entry.id}: no external Facts -> ${entry.expected.kind}`, () => {
    const { plan, evaluation } = runInput(inputFor(entry));
    assert.deepEqual(plan, { ok: true, data: { planned: [] }, error: null });
    const expected = entry.expected.kind === "pass" ? { kind: "pass" } : {
      kind: entry.expected.kind,
      matched: [{
        policy_id: entry.expected.policy_id,
        reason: policies.get(entry.expected.policy_id).reason,
        severity: policies.get(entry.expected.policy_id).severity,
        origin: "action",
      }],
    };
    // The whole DTO excludes quarantine/schema/system failures and extra
    // matches. A warn/fail kind alone does not prove the intended policy ran.
    assert.deepEqual(evaluation, { ok: true, data: { verdict: expected }, error: null });
  });
}

for (const entry of fixture.missing_input_cases) {
  test(`${entry.id}: DTO error is distinct from a policy deny`, () => {
    const { plan, evaluation } = runInput(inputFor(entry));
    assert.equal(plan.ok, false);
    assert.equal(plan.data, null);
    assert.equal(plan.error.kind, "invalid_input_json");
    assert.ok(plan.error.message.includes(`missing field \`${entry.missing_field}\``), plan.error.message);
    // Legacy evaluate deliberately wraps invalid input in an ok envelope;
    // this is fail-closed engine_error, never a Day-1 matched policy.
    assert.deepEqual(evaluation, {
      ok: true,
      data: { verdict: { kind: "fail", matched: [{
        policy_id: "__engine::invalid_input_json",
        reason: plan.error.message,
        severity: "deny",
        origin: "engine_error",
      }] } },
      error: null,
    });
  });
}
