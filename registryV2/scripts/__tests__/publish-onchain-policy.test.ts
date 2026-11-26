import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import {
  RegistryClient, registryReference, safeSequence, validateIntent, publishOnchainPolicy,
  prepareOnchainPolicy, type RegistryConfig, type Intent,
} from "../publish-onchain-policy.js";
import { signPayload, type BundlePayload } from "../publish-policy-bundle.js";

// Ephemeral-policy test identity, unrelated to transaction publication authority.
const privateKey = new Uint8Array(32);
privateKey[31] = 7;
const publicKey = Buffer.from(p256.getPublicKey(privateKey, false)).toString("hex");
const config: RegistryConfig = {
  rpcUrl: "http://127.0.0.1:8545", network: "local",
  registry: "0x" + "11".repeat(20), sender: "0x" + "22".repeat(20),
  env: "staging", profile: "default", finality: "finalized", trustedPublicKeyHex: publicKey,
};
const now = Math.floor(Date.now() / 1000);
function payload(): BundlePayload {
  return {
    policies: [{ id: "p", manifest: { id: "p", schema_version: 2 },
      policy: '@id("p")\n@severity("deny")\nforbid(principal, action, resource);' }],
    sequence: 1, issued_at: now - 1, expires_at: now + 3600,
    env: "staging", profile: "default", registry_ref: registryReference(config),
  };
}
async function intent(p = payload()): Promise<Intent> {
  return { expectedCurrent: p.sequence - 1, signed: await signPayload(p, {
    privKeyHex: Buffer.from(privateKey).toString("hex"), keyId: "telemetry", mode: "local",
  }) };
}

test("existing signer binds original bytes, scope and safe sequence; HTTP null is preserved", async () => {
  const client = new RegistryClient(config);
  const good = await intent();
  assert.equal(validateIntent(client, good).sequence, 1);
  assert.throws(() => validateIntent(client, { ...good, signed: { ...good.signed, payload: good.signed.payload + "\n" } }), /canonical/);
  for (const change of [
    { env: "production" as const }, { profile: "other" },
    { registry_ref: registryReference({ ...config, registry: "0x" + "33".repeat(20) }) },
    { registry_ref: registryReference({ ...config, network: "giwa" }) },
    { registry_ref: null },
  ]) assert.throws(() => validateIntent(client, { ...good, signed: { ...good.signed, payload: JSON.stringify(change) } }));
  for (const changed of [
    { ...payload(), env: "production" as const }, { ...payload(), profile: "other" },
    { ...payload(), registry_ref: null },
  ]) assert.throws(() => validateIntent(client, { ...good, signed: ({} as Intent["signed"]) }));
  // A valid signature for the wrong scope is still rejected.
  const wrongScope = await intent({ ...payload(), env: "production" });
  assert.throws(() => validateIntent(client, wrongScope), /scope/);
  const http = await signPayload({ ...payload(), registry_ref: null, expires_at: null }, {
    mode: "local", privKeyHex: Buffer.from(privateKey).toString("hex"),
  });
  assert.equal(JSON.parse(http.payload).registry_ref, null);
  assert.equal(JSON.parse(http.payload).expires_at, null);
  const signature = Buffer.from(good.signed.signature, "base64");
  signature[0] ^= 1;
  assert.throws(() => validateIntent(client, { ...good, signed: { ...good.signed, signature: signature.toString("base64") } }), /signature/);
  assert.throws(() => validateIntent(new RegistryClient({ ...config, trustedPublicKeyHex: Buffer.from(p256.getPublicKey(new Uint8Array(32).fill(1), false)).toString("hex") }), good), /signature/);
  assert.throws(() => validateIntent(client, { ...good, expectedCurrent: 1 }), /sequence/);
  assert.throws(() => validateIntent(client, good, now + 3600), /lifetime/);
  assert.equal(safeSequence("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const bad of ["9007199254740992", 9007199254740992, -1, 1.5, "1e3", "01"]) assert.throws(() => safeSequence(bad), /sequence/);
});

test("chain mismatch is checked before policy loading, signing, simulation or submission", async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" }));
  };
  const client = new RegistryClient({ ...config, network: "giwa", rpcUrl: "https://example.invalid" }, transport);
  await assert.rejects(prepareOnchainPolicy(client, {
    repoRoot: "/does-not-exist", expiresAt: now + 60, signing: { mode: "kms" },
  }), /chain ID mismatch/);
  let submissions = 0;
  await assert.rejects(publishOnchainPolicy(client, await intent(), async () => {
    submissions++; return "0x" + "00".repeat(32);
  }), /chain ID mismatch/);
  assert.deepEqual(calls, ["eth_chainId", "eth_chainId"]);
  assert.equal(submissions, 0);
});

test("local mode cannot be used for non-loopback writes or latest finality", () => {
  for (const rpcUrl of ["http://localhost:8545", "http://example.com:8545", "https://127.0.0.1:8545", "http://user:password@127.0.0.1:8545"]) {
    assert.throws(() => new RegistryClient({ ...config, rpcUrl }));
  }
  assert.throws(() => new RegistryClient({ ...config, finality: "latest" as RegistryConfig["finality"] }));
});

test("unavailable RPC remains a failure, never revoked or successful", async () => {
  const client = new RegistryClient(config, async () => { throw new Error("offline"); });
  await assert.rejects(publishOnchainPolicy(client, await intent(), async () => {
    assert.fail("must not submit when chain is unavailable");
  }), /offline/);
});
