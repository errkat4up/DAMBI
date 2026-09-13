import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import bundleLoader from "../../scripts/sdk/policy-bundle.cjs";
import { contractCases, example, testKeys } from "./fixtures.mjs";
import { structureErrors } from "./helpers/structure.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifyFixture = (envelope, key) => verify(
  "sha256", Buffer.from(envelope.payload, "utf8"),
  { key: createPublicKey({ key: Buffer.from(key.public_key_spki_b64, "base64"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" },
  Buffer.from(envelope.sig.sig_b64, "base64"),
);

test("normal example preserves all five D3 policies and manifest values", () => {
  const payload = JSON.parse(example.payload);
  assert.deepEqual(payload.policies, bundleLoader.loadPolicyBundle(repoRoot));
  assert.equal(payload.policies.length, 5);
  assert.equal(payload.registry_ref, null);
});

test("B signature covers original UTF-8 text, not a reserialized object", () => {
  assert.equal(verifyFixture(example, testKeys.policy), true);
  const compact = { ...example, payload: JSON.stringify(JSON.parse(example.payload)) };
  assert.deepEqual(JSON.parse(compact.payload), JSON.parse(example.payload));
  assert.notEqual(compact.payload, example.payload);
  assert.equal(verifyFixture(compact, testKeys.policy), false);
  assert.equal(verifyFixture(JSON.parse(JSON.stringify(example)), testKeys.policy), true);
});

test("test keys are marked test-only and have separate policy/decoder roles", () => {
  assert.equal(testKeys.test_only, true);
  assert.equal(testKeys.policy.role, "policy");
  assert.equal(testKeys.decoder.role, "decoder");
  assert.notEqual(testKeys.policy.public_key_spki_b64, testKeys.decoder.public_key_spki_b64);
  assert.notEqual(testKeys.policy.key_id, testKeys.decoder.key_id);
});

const cases = contractCases();
test("fixture identifiers are unique and required validation layers are present", () => {
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.deepEqual([...new Set(cases.map(item => item.layer))].sort(),
    ["crypto", "key-role", "parser", "semantic", "structure", "valid"]);
});

for (const scenario of cases) {
  test(`${scenario.layer}: ${scenario.id} (fixture checks only)`, () => {
    const errors = structureErrors(scenario.envelope);
    if (scenario.layer === "structure") {
      assert.notEqual(errors.length, 0, scenario.id);
      return;
    }
    assert.deepEqual(errors, [], scenario.id);
    const key = Object.values(testKeys).find(item => item?.key_id === scenario.envelope.sig.key_id);
    assert.ok(key, "fixture key is known");
    assert.equal(verifyFixture(scenario.envelope, key), scenario.signature);
    if (scenario.layer === "key-role") {
      assert.equal(key.role, "decoder");
      assert.equal(verifyFixture(scenario.envelope, testKeys.policy), false);
    }
    if (scenario.layer === "parser") {
      assert.equal(scenario.envelope.payload.match(/"sequence"\s*:/g).length, 2);
    }
    // Semantic/parser expected_core_error values are C3 handoff expectations.
    // No Core parser, semantic verifier, or policy decision is executed here.
  });
}
