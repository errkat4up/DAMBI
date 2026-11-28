import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import {
  RegistryClient, registryReference, safeSequence, validateIntent, publishOnchainPolicy, sha256,
  prepareOnchainPolicy, publishStoredIntent, publicationData, abi,
  type RegistryConfig, type Intent, type Transaction,
} from "../publish-onchain-policy.js";
import { signPayload, type BundlePayload } from "../publish-policy-bundle.js";

// QA entry point (Node 22, from registryV2):
//   node --import tsx --test scripts/__tests__/publish-onchain-policy.test.ts
// Run on the same candidate as Forge and isolated Anvil; no execution result is implied here.
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
  assert.deepEqual(JSON.parse(good.signed.payload).registry_ref, { chainId: 31337, registryAddress: config.registry });
  assert.equal(validateIntent(client, good).sequence, 1);
  assert.throws(() => validateIntent(client, { ...good, signed: { ...good.signed, payload: good.signed.payload + "\n" } }), /canonical/);
  const scopeChanges: Array<[string, Partial<BundlePayload>]> = [
    ["environment", { env: "production" }],
    ["profile", { profile: "other" }],
    ["registry address", { registry_ref: registryReference({ ...config, registry: "0x" + "33".repeat(20) }) }],
    ["registry chain ID", { registry_ref: registryReference({ ...config, network: "giwa" }) }],
    ["legacy string reference", { registry_ref: `dambi:policy-registry:31337:${config.registry}` }],
    ["HTTP null reference", { registry_ref: null }],
  ];
  for (const [name, change] of scopeChanges) {
    // Change one scope component of a complete valid payload and re-sign its
    // canonical bytes. A malformed object or stale signature is not this test.
    const changed = { ...payload(), ...change };
    const wrongScope = await intent(changed);
    assert.deepEqual(JSON.parse(wrongScope.signed.payload), changed, name);
    assert.equal(p256.verify(
      Buffer.from(wrongScope.signed.signature, "base64"),
      Buffer.from(sha256(Buffer.from(wrongScope.signed.payload)).slice(2), "hex"),
      Buffer.from(publicKey, "hex"), { prehash: false, lowS: false },
    ), true, `${name}: signature must be valid`);
    assert.throws(() => validateIntent(client, wrongScope, now),
      { message: "signed scope mismatch" }, name);
  }
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

test("signed sequence and expectedCurrent are independently bounded and must be adjacent", async () => {
  const client = new RegistryClient(config);
  const first = await intent();
  const second = await intent({ ...payload(), sequence: 2 });
  assert.equal(validateIntent(client, second, now).sequence, 2);
  // A correctly re-signed next sequence cannot reuse the previous CAS value.
  assert.throws(() => validateIntent(client, { ...second, expectedCurrent: 0 }, now),
    { message: "sequence mismatch" });
  // Conversely, changing only the CAS value cannot advance the signed sequence.
  assert.throws(() => validateIntent(client, { ...first, expectedCurrent: 1 }, now),
    { message: "sequence mismatch" });
  const zero = await intent({ ...payload(), sequence: 0 });
  assert.throws(() => validateIntent(client, { ...zero, expectedCurrent: 0 }, now),
    { message: "sequence mismatch" });
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const changed = await intent({ ...payload(), sequence });
    assert.throws(() => validateIntent(client, { ...changed, expectedCurrent: 0 }, now),
      { message: "unsafe sequence" }, `signed sequence ${sequence}`);
  }
  for (const expectedCurrent of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateIntent(client, { ...first, expectedCurrent }, now),
      { message: "unsafe sequence" }, `expectedCurrent ${expectedCurrent}`);
  }
  const maximum = await intent({ ...payload(), sequence: Number.MAX_SAFE_INTEGER });
  assert.equal(maximum.expectedCurrent, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(validateIntent(client, maximum, now).sequence, Number.MAX_SAFE_INTEGER);
  for (const expectedCurrent of [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateIntent(client, { ...maximum, expectedCurrent }, now),
      { message: "sequence mismatch" });
  }
  const overflow = await intent({ ...payload(), sequence: Number.MAX_SAFE_INTEGER + 1 });
  assert.throws(() => validateIntent(client, { ...overflow, expectedCurrent: Number.MAX_SAFE_INTEGER }, now),
    { message: "unsafe sequence" });
});

test("publication rejects string-valued wire sequences before simulation or submission", async () => {
  const { client, original, submit, state } = await retryFixture();
  // Re-sign the complete malformed payload so a stale signature cannot explain the failure.
  const signedString = await intent({ ...payload(), sequence: "1" as unknown as number });
  const stringCurrent = { ...original, expectedCurrent: "0" as unknown as number };
  for (const candidate of [signedString, stringCurrent]) {
    assert.throws(() => validateIntent(client, candidate, now), { message: "unsafe sequence" });
    await assert.rejects(publishOnchainPolicy(client, candidate, submit), { message: "unsafe sequence" });
  }
  assert.equal(state.simulations, 0);
  assert.equal(state.submissions, 0);
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

// These tests execute the production RPC, ABI, signature, receipt, finality and
// CLI journal paths. Only the remote node is scripted; real EVM out-of-gas
// behavior is covered separately in PolicyRegistry.anvil.test.mjs.
async function retryFixture() {
  const original = await intent();
  const data = publicationData(new RegistryClient(config), original);
  const failedHash = "0x" + "aa".repeat(32);
  const successHash = "0x" + "bb".repeat(32);
  const blockHash = "0x" + "cc".repeat(32);
  const otherHash = "0x" + "dd".repeat(32);
  const calls: string[] = [];
  const state = {
    mode: "normal", active: false, status: 1, head: 1,
    submissions: 0, simulations: 0, finalityReads: 0,
  };
  const encodeRecord = () => abi("abi-encode", "record(uint256,uint8,bytes32,bytes,bytes,string)", state.active ? [
    String(state.head), String(state.status), sha256(Buffer.from(original.signed.payload)),
    "0x" + Buffer.from(original.signed.payload).toString("hex"),
    "0x" + Buffer.from(original.signed.signature, "base64").toString("hex"), original.signed.key_id,
  ] : ["0", "0", "0x" + "00".repeat(32), "0x", "0x", ""]);
  const ownerCall = abi("calldata", "publisher()", []);
  const transport: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const [first] = request.params;
    calls.push(request.method);
    let result: unknown;
    switch (request.method) {
      case "eth_chainId": result = state.mode === "rpc-chain" ? "0x1" : "0x7a69"; break;
      case "eth_getCode": result = "0x6000"; break;
      case "eth_call":
        if (first.data === ownerCall) {
          result = abi("abi-encode", "owner(address)", [config.sender]);
        } else if (first.data === data) {
          state.simulations++;
          result = "0x";
        } else {
          result = encodeRecord();
        }
        break;
      case "eth_estimateGas": result = "0x100000"; break;
      case "eth_getTransactionReceipt":
        if (state.mode === "offline") throw new Error("receipt lookup offline");
        if (state.mode === "pending") { result = null; break; }
        result = {
          transactionHash: state.mode === "receipt-hash" ? otherHash : first,
          blockHash, blockNumber: "0x10", gasUsed: "0x10000", to: config.registry,
          status: state.mode === "status" ? "0x2" : first === failedHash ? "0x0" : "0x1",
        };
        break;
      case "eth_getTransactionByHash":
        result = state.mode === "missing-transaction" ? null : {
          hash: first, from: state.mode === "sender" ? config.registry : config.sender,
          to: state.mode === "registry" ? config.sender : config.registry,
          input: state.mode === "calldata" ? data + "00" : data,
          value: state.mode === "value" ? "0x1" : "0x0",
          chainId: state.mode === "transaction-chain" ? "0x1" : "0x7a69",
          blockNumber: "0x10", blockHash: state.mode === "transaction-block" ? otherHash : blockHash,
        };
        break;
      case "eth_getBlockByNumber":
        if (first === "finalized" || first === "safe") {
          assert.equal(first, config.finality);
          state.finalityReads++;
          result = state.mode === "no-finality" ? null : {
            number: state.mode === "unfinalized" ? "0xf" : "0x10", hash: blockHash,
          };
        } else {
          result = { number: first, hash: state.mode === "reorg" ? otherHash : blockHash };
        }
        break;
      default: assert.fail(`unexpected RPC ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  const client = new RegistryClient(config, transport);
  const submit = async (tx: Transaction) => {
    assert.equal(tx.data, data);
    assert.equal(tx.chainId, 31337);
    assert.equal(tx.from, config.sender);
    assert.equal(tx.to, config.registry);
    assert.ok(state.simulations > state.submissions, "each send must be freshly simulated");
    state.submissions++;
    if (state.submissions === 1) return failedHash;
    state.active = true;
    return successHash;
  };
  return { original, client, submit, state, calls, failedHash, successHash };
}

test("CLI journal: failed receipt, explicit retry, successful resume and duplicate preserve original intent and hash history", async (t) => {
  const f = await retryFixture();
  const directory = mkdtempSync(join(tmpdir(), "dambi-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "intent.json");
  const originalBytes = JSON.stringify(f.original, null, 2) + "\n";
  writeFileSync(path, originalBytes);
  const options = { attempts: 1, pollMs: 0 };
  await assert.rejects(publishStoredIntent(f.client, path, f.submit, options), /receipt/);
  assert.deepEqual(JSON.parse(readFileSync(path + ".txhash", "utf8")), {
    hashes: [f.failedHash], submitting: false,
  });
  await assert.rejects(publishStoredIntent(f.client, path, f.submit, options), /receipt/);
  assert.equal(f.state.submissions, 1, "ordinary publish must not retry failures");
  // Exercise migration of the sidecar produced by the previous CLI version.
  writeFileSync(path + ".txhash", f.failedHash + "\n");
  const result = await publishStoredIntent(f.client, path, f.submit, { ...options, retryFailed: true });
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.receipt?.transactionHash, f.successHash);
  assert.ok(f.state.finalityReads >= 2, "both failed and successful receipts require finality");
  assert.deepEqual(JSON.parse(readFileSync(path + ".txhash", "utf8")), {
    hashes: [f.failedHash, f.successHash], submitting: false,
  });
  assert.equal(readFileSync(path, "utf8"), originalBytes);
  for (const retryFailed of [false, true]) {
    assert.equal((await publishStoredIntent(f.client, path, f.submit, { ...options, retryFailed })).outcome, "confirmed");
  }
  assert.equal((await publishOnchainPolicy(f.client, f.original, f.submit, options)).outcome, "reconciled");
  assert.equal(f.state.submissions, 2);
  assert.equal(f.state.simulations, 2);
});

test("explicit failed retry never sends for pending, unavailable, mismatched or noncanonical evidence", async (t) => {
  for (const mode of [
    "pending", "offline", "receipt-hash", "status", "missing-transaction", "sender", "registry",
    "calldata", "value", "transaction-chain", "transaction-block", "rpc-chain", "no-finality", "unfinalized", "reorg",
  ]) {
    await t.test(mode, async () => {
      const f = await retryFixture();
      const directory = mkdtempSync(join(tmpdir(), "dambi-retry-denied-"));
      try {
        const path = join(directory, "intent.json");
        writeFileSync(path, JSON.stringify(f.original));
        writeFileSync(path + ".txhash", f.failedHash + "\n");
        f.state.mode = mode;
        await assert.rejects(publishStoredIntent(f.client, path, async () => {
          assert.fail("uncertain or mismatched evidence must not authorize a send");
        }, { retryFailed: true, attempts: 1, pollMs: 0 }));
        assert.equal(f.state.simulations, 0);
        assert.equal(readFileSync(path + ".txhash", "utf8"), f.failedHash + "\n");
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});

test("failed retry reconciles identical active bytes but rejects revoked, superseded and conflicting records", async () => {
  for (const status of [1, 2, 3]) {
    const f = await retryFixture();
    f.state.active = true;
    f.state.status = status;
    const operation = publishOnchainPolicy(f.client, f.original, async () => {
      assert.fail("existing versions must not be resubmitted");
    }, { transactionHash: f.failedHash, retryFailed: true, attempts: 1, pollMs: 0 });
    if (status === 1) assert.equal((await operation).outcome, "reconciled");
    else await assert.rejects(operation, /SUPERSEDED|REVOKED/);
    assert.equal(f.state.simulations, 0);
  }
  const f = await retryFixture();
  f.state.active = true;
  f.state.head = 2;
  await assert.rejects(publishOnchainPolicy(f.client, f.original, f.submit, {
    transactionHash: f.failedHash, retryFailed: true, attempts: 1, pollMs: 0,
  }), /SUPERSEDED/);
  const changed = await intent({ ...payload(), expires_at: now + 3601 });
  f.state.head = 1;
  await assert.rejects(publishOnchainPolicy(f.client, changed, f.submit, {
    transactionHash: f.failedHash, retryFailed: true, attempts: 1, pollMs: 0,
  }), /conflict/);
  assert.equal(f.state.submissions, 0);
});

test("ambiguous wallet outcome is durably blocked, and a retry authorizes at most one new send", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dambi-retry-unknown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await retryFixture();
  const path = join(directory, "intent.json");
  writeFileSync(path, JSON.stringify(f.original));
  writeFileSync(path + ".txhash", f.failedHash + "\n");
  let sends = 0;
  const options = { retryFailed: true, attempts: 1, pollMs: 0 };
  await assert.rejects(publishStoredIntent(f.client, path, async () => {
    sends++;
    // The marker must already be durable when the wallet is called.
    assert.deepEqual(JSON.parse(readFileSync(path + ".txhash", "utf8")), {
      hashes: [f.failedHash], submitting: true,
    });
    throw new Error("wallet disconnected after possible acceptance");
  }, options), /wallet disconnected/);
  await assert.rejects(publishStoredIntent(f.client, path, async () => {
    sends++; return f.successHash;
  }, options), /outcome unknown/);
  assert.equal(sends, 1);

  const second = join(directory, "second.json");
  writeFileSync(second, JSON.stringify(f.original));
  writeFileSync(second + ".txhash", f.failedHash + "\n");
  // A second failed transaction requires a separate explicit invocation, not
  // an unbounded failure/resubmit loop inside this one.
  await assert.rejects(publishStoredIntent(f.client, second, async () => {
    sends++;
    return f.failedHash;
  }, options), /reused a previous hash/);
  assert.equal(sends, 2);
  assert.equal(JSON.parse(readFileSync(second + ".txhash", "utf8")).submitting, true);
});
