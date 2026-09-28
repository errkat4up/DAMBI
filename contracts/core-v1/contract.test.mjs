import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import bundleLoader from "../../scripts/sdk/policy-bundle.cjs";
import { contractCases, example, testKeys, validationContext } from "./fixtures.mjs";
import { structureErrors } from "./helpers/structure.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifyFixture = (envelope, key) => verify(
  "sha256", Buffer.from(envelope.payload, "utf8"),
  { key: createPublicKey({ key: Buffer.from(key.public_key_spki_b64, "base64"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" },
  Buffer.from(envelope.signature, "base64"),
);

test("normal example preserves all five D3 policies and manifest values", () => {
  const payload = JSON.parse(example.payload);
  assert.deepEqual(Object.keys(example).sort(), ["key_id", "payload", "signature"]);
  assert.deepEqual(Object.keys(payload).sort(),
    ["env", "expires_at", "issued_at", "policies", "profile", "registry_ref", "sequence"]);
  assert.deepEqual(payload.policies, bundleLoader.loadPolicyBundle(repoRoot));
  assert.equal(payload.policies.length, 5);
  assert.equal(payload.registry_ref, null);
  assert.equal(payload.sequence, 42);
  assert.equal(payload.expires_at, null);
  assert.equal(payload.env, validationContext.env);
  assert.equal(payload.profile, validationContext.profile);
});

test("B signature covers original UTF-8 text, not a reserialized object", () => {
  assert.equal(verifyFixture(example, testKeys.policy), true);
  const reformatted = { ...example, payload: JSON.stringify(JSON.parse(example.payload), null, 2) };
  assert.deepEqual(JSON.parse(reformatted.payload), JSON.parse(example.payload));
  assert.notEqual(reformatted.payload, example.payload);
  assert.equal(verifyFixture(reformatted, testKeys.policy), false);
  assert.equal(verifyFixture(JSON.parse(JSON.stringify(example)), testKeys.policy), true);
});

test("test keys are marked test-only and have separate policy/decoder roles", () => {
  assert.equal(testKeys.test_only, true);
  assert.equal(testKeys.policy.role, "policy");
  assert.equal(testKeys.decoder.role, "decoder");
  assert.notEqual(testKeys.policy.public_key_spki_b64, testKeys.decoder.public_key_spki_b64);
  assert.notEqual(testKeys.policy.key_id, testKeys.decoder.key_id);
});

test("optional key_id is telemetry and never selects the reference trust key", () => {
  for (const keyId of [undefined, "", "unknown-key", testKeys.decoder.key_id]) {
    const envelope = structuredClone(example);
    if (keyId === undefined) delete envelope.key_id;
    else envelope.key_id = keyId;
    assert.deepEqual(structureErrors(envelope), []);
    assert.equal(verifyFixture(envelope, testKeys.policy), true);
    assert.equal(verifyFixture(envelope, testKeys.decoder), false);
  }
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
    // Fixture metadata records the signing role independently of the untrusted envelope.
    const key = testKeys[scenario.signing_role ?? "policy"];
    assert.equal(verifyFixture(scenario.envelope, key), scenario.signature);
    if (scenario.layer === "key-role") {
      assert.equal(key.role, "decoder");
      assert.equal(scenario.envelope.key_id, testKeys.policy.key_id);
      assert.equal(verifyFixture(scenario.envelope, testKeys.policy), false);
    }
    if (scenario.layer === "parser") {
      assert.equal(scenario.envelope.payload.match(/"sequence"\s*:/g).length, 2);
    }
    if (scenario.id === "non-null-registry-ref") {
      assert.equal(scenario.expected_core_error, "UNSUPPORTED_REGISTRY_REF");
    }
    // Semantic/parser expected_core_error values are C3 handoff expectations.
    // No Core parser, semantic verifier, or policy decision is executed here.
  });
}
