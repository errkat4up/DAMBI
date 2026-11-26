import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCore } from "@dambi/core";
import { createOnchainPolicySource } from "@dambi/core/adapters";
import { fakeRpc, options, encodeRead, NOW } from "../../../../fixtures/sdk/onchain-policy/fake-rpc.mjs";

// Real packaged WASM, never a mock Core. This is a negative trust-boundary
// regression, not an assertion that the final F1/F4 positive contract is accepted.
const root = new URL("../../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
const [decoder, envelope, keys] = await Promise.all([
  json("snapshot-approve.json"), json("policy-bundle/day1.envelope.json"), json("policy-bundle/test-only-keys.json"),
]);
assert.equal(keys.test_only, true);
const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder] });
const expectedDigest = `0x${createHash("sha256").update(artifact).digest("hex")}`;
function config(policy) {
  return {
    decoderSnapshot: { artifact, expectedDigest },
    trust: { env: "staging", profile: "default", keys: [{
      keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64,
    }] },
    enforcement: "enforcing", clock: { now: () => NOW },
    limits: {
      allowedClockSkewMs: 5000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
      planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
      factTimeoutMs: 1000, policyTimeoutMs: 5000,
    },
    ports: { policy, fact: { async fetch() { assert.fail("This test must not fetch Facts"); } } },
  };
}

test("onchain transport cannot authorize an invalid P-256 payload in real Core", { timeout: 15_000 }, async (t) => {
  const rpc = await fakeRpc(t);
  const payload = JSON.stringify({
    ...JSON.parse(envelope.payload), sequence: 42,
    issued_at: NOW / 1000, expires_at: NOW / 1000 + 3600,
  });
  const signature = sign("sha256", Buffer.from(payload), {
    key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
  }).toString("base64");
  const valid = { payload, signature, keyId: keys.policy.key_id };
  // Establish that the actual engine, decoder and local verification key work.
  const control = await createCore(config({ async fetch() { return valid; } }));
  control.dispose();

  rpc.tuple = encodeRead({ payload: `${payload} `, signature, keyId: keys.policy.key_id });
  const source = createOnchainPolicySource(options(rpc));
  const candidate = await source.fetch();
  assert.equal(candidate.payload, `${payload} `);
  assert.equal(candidate.signature, signature);
  // F1 may reject the HTTP registry_ref/null mismatch before signature checking.
  // Either rejection is safe, but an adapter/network failure is not this test.
  let created;
  try {
    await assert.rejects(async () => { created = await createCore(config(source)); }, (error) => {
      assert.notEqual(error.code, "POLICY_FETCH_FAILED", "RPC succeeded; rejection must occur inside Core validation");
      assert.notEqual(error.code, "ENGINE_ERROR", "Missing/broken WASM is not trust validation");
      assert.equal(typeof error.code, "string");
      return true;
    });
  } finally { created?.dispose(); }
  assert.ok(rpc.requests.every((request) => !request.method.startsWith("eth_send")));
});
