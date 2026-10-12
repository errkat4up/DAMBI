import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";

// Local SDK verification only. Never publishes or changes the Registry catalog.
const fixtures = new URL("../../crates/dambi-core/tests/fixtures/policy-bundle/", import.meta.url);
const catalog = new URL("../../crates/policy-engine/tests/fixtures/policy_catalog_v2/action/transfer/transfer-full-balance-sweep/", import.meta.url);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

export async function createBalancePolicyFixture({ now = Date.now(), required = false, sequence = 42 } = {}) {
  const [envelope, keys, manifest, catalogPolicy] = await Promise.all([
    readJson(new URL("day1.envelope.json", fixtures)),
    readJson(new URL("test-only-keys.json", fixtures)),
    readJson(new URL("manifest.json", catalog)),
    readFile(new URL("policy.cedar", catalog), "utf8"),
  ]);
  assert.equal(keys.test_only, true, "SDK verification requires the explicit test-only signing key");
  assert.equal(manifest.policy_rpc[0].optional, true);
  assert.equal(manifest.policy_rpc[0].outputs[0].required, false);
  assert.ok(Number.isSafeInteger(now) && now >= 0);
  assert.ok(Number.isSafeInteger(sequence) && sequence >= 1);
  let policyText = catalogPolicy;
  if (required) {
    manifest.id = "adapter-required-balance";
    manifest.policy_rpc[0].optional = false;
    manifest.policy_rpc[0].outputs[0].required = true;
    policyText = policyText.replace('@id("transfer-full-balance-sweep")', '@id("adapter-required-balance")');
  }
  const payload = JSON.stringify({
    ...JSON.parse(envelope.payload), issued_at: Math.floor(now / 1_000), expires_at: null, sequence,
    policies: [{ id: manifest.id, manifest, policy: policyText }],
  });
  return {
    policy: {
      payload, keyId: keys.policy.key_id,
      signature: sign("sha256", Buffer.from(payload), {
        key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
      }).toString("base64"),
    },
    trust: { env: "staging", profile: "default", keys: [{
      keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64,
    }] },
    policyId: manifest.id,
  };
}

export function makeTransferRequest({ owner, token, amount = 100n, recipient = "0x000000000000000000000000000000000000bbbb" }) {
  return {
    kind: "transaction", chainId: "eip155:1", from: owner, to: token, value: "0",
    data: `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
  };
}
