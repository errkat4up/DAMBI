import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Manual isolated acceptance entry point:
//   forge build --root contracts/policy-registry
//   DAMBI_TEST_RPC_URL=http://127.0.0.1:8545 node --test contracts/policy-registry/test/PolicyRegistry.anvil.test.mjs
// Requires Anvil chain 31337, cast, and registryV2's installed tsx dependencies.
// No process/chain reset, live endpoint, preconfigured account or secret is used.
// Output is a measurement at execution time, not checked-in evidence.
const endpoint = process.env.DAMBI_TEST_RPC_URL;
if (endpoint) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.hash, "DAMBI_TEST_RPC_URL must be literal loopback HTTP");
}
const requireRegistry = createRequire(new URL("../../../registryV2/package.json", import.meta.url));
let nextId = 0;
async function rpc(method, params = []) {
  const id = ++nextId;
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.ok, true);
  const result = await response.json();
  assert.equal(result.id, id);
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result;
}
function calldata(signature, ...args) {
  return execFileSync("cast", ["calldata", signature, ...args.map(String)], { encoding: "utf8" }).trim();
}
async function receipt(hash) {
  for (let i = 0; i < 100; i++) {
    const value = await rpc("eth_getTransactionReceipt", [hash]);
    if (value) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("receipt timeout");
}
// Test-only progress for the isolated Anvil node checked below. Automining a
// transaction does not necessarily advance finalized to its receipt block.
// Keep the publisher's configured finality intact; mine bounded empty blocks
// and inspect the real finalized tag rather than substituting latest.
async function advanceFinalizedThrough(included) {
  const target = BigInt(included.blockNumber);
  for (let batch = 0; batch <= 8; batch++) {
    const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
    assert.ok(finalized, "Anvil must expose finalized blocks");
    if (BigInt(finalized.number) >= target) {
      const canonical = await rpc("eth_getBlockByNumber", [included.blockNumber, false]);
      assert.equal(canonical?.hash, included.blockHash, "receipt must remain canonical");
      return;
    }
    if (batch < 8) await rpc("anvil_mine", ["0x20"]);
  }
  assert.fail("Anvil finalized did not reach the receipt after 256 empty blocks");
}
async function send(from, to, data, extra = {}) {
  const hash = await rpc("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, gas: "0x1c9c380", ...extra }]);
  return receipt(hash);
}
async function account() {
  const address = "0x" + randomBytes(20).toString("hex");
  await rpc("anvil_setBalance", [address, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [address]);
  return address;
}

test("real registry and fixed publisher: CAS, receipts, retries, revocation, rotation and local gas", {
  skip: !endpoint && "set DAMBI_TEST_RPC_URL to an isolated Anvil node", timeout: 180_000,
}, async (t) => {
  assert.equal(BigInt(await rpc("eth_chainId")), 31337n, "not a local development chain");
  assert.match(await rpc("web3_clientVersion"), /anvil/i, "requires isolated Anvil, not a forwarded live RPC");
  const { tsImport } = await import(requireRegistry.resolve("tsx/esm/api"));
  const tool = await tsImport(fileURLToPath(new URL("../../../registryV2/scripts/publish-onchain-policy.ts", import.meta.url)), import.meta.url);
  const { p256 } = await import(requireRegistry.resolve("@noble/curves/nist.js"));
  const owner = await account();
  const next = await account();
  const outsider = await account();
  t.after(async () => {
    for (const who of [owner, next, outsider]) await rpc("anvil_stopImpersonatingAccount", [who]);
  });
  const foundryRoot = fileURLToPath(new URL("..", import.meta.url));
  const artifactPath = resolve(foundryRoot, process.env.FOUNDRY_OUT || "out", "PolicyRegistry.sol", "PolicyRegistry.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const constructor = execFileSync("cast", ["abi-encode", "constructor(address)", owner], { encoding: "utf8" }).trim();
  const deployment = await send(owner, undefined, artifact.bytecode.object + constructor.slice(2));
  assert.equal(deployment.status, "0x1");
  const registry = deployment.contractAddress;
  assert.ok(registry);
  const secret = p256.utils.randomSecretKey();
  const config = {
    rpcUrl: endpoint, network: "local", registry, sender: owner,
    env: "staging", profile: "default", finality: "finalized",
    trustedPublicKeyHex: Buffer.from(p256.getPublicKey(secret, false)).toString("hex"),
  };
  const client = new tool.RegistryClient(config);
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const prepare = (c = client) => tool.prepareOnchainPolicy(c, {
    repoRoot, set: "day1-safety", expiresAt: Math.floor(Date.now() / 1000) + 3600,
    signing: { mode: "local", privKeyHex: Buffer.from(secret).toString("hex"), keyId: "ephemeral-anvil-policy" },
  });
  let submissions = 0;
  const submit = async (tx) => {
    submissions++;
    assert.equal(tx.chainId, 31337);
    const { chainId, ...request } = tx;
    return rpc("eth_sendTransaction", [request]);
  };
  const first = await prepare();
  assert.equal(first.expectedCurrent, 0);
  assert.equal(JSON.parse(first.signed.payload).registry_ref, tool.registryReference(config));
  const scope = tool.scopeId(config);
  const encodedScope = await rpc("eth_call", [{ to: registry, data: calldata("scopeId(string,string)", "staging", "default") }, "latest"]);
  assert.equal(encodedScope.toLowerCase(), scope);
  const data = tool.publicationData(client, first);
  // Bypass the TS validator only for negative contract transactions. All other
  // arguments remain valid, so these exercise Solidity's version checks.
  const rawPublication = (targetScope, expectedCurrent, sequence, signed) => calldata(
    "publish(bytes32,uint256,uint256,bytes32,bytes,bytes,string)",
    targetScope, expectedCurrent, sequence, tool.sha256(Buffer.from(signed.payload)),
    "0x" + Buffer.from(signed.payload).toString("hex"),
    "0x" + Buffer.from(signed.signature, "base64").toString("hex"), signed.key_id,
  );
  const rawRecord = (target, targetScope, sequence) => rpc("eth_call", [{
    to: target, data: calldata("read(bytes32,uint256)", targetScope, sequence),
  }, "latest"]);
  // Actual authority and data-integrity failures, not mocked publisher responses.
  assert.equal((await send(outsider, registry, data)).status, "0x0");
  const badDigest = calldata("publish(bytes32,uint256,uint256,bytes32,bytes,bytes,string)", scope, 0, 1,
    "0x" + "00".repeat(32), "0x" + Buffer.from(first.signed.payload).toString("hex"),
    "0x" + Buffer.from(first.signed.signature, "base64").toString("hex"), first.signed.key_id);
  assert.equal((await send(owner, registry, badDigest)).status, "0x0");
  const maximumSequence = 9_007_199_254_740_991n;
  assert.equal(tool.safeSequence(maximumSequence.toString()), Number.MAX_SAFE_INTEGER);
  const emptyRecord = await client.read();
  assert.equal(emptyRecord.head, 0);
  assert.equal(emptyRecord.status, 0);
  for (const [name, expectedCurrent, sequence] of [
    ["zero", 0n, 0n],
    ["skipped version", 0n, 2n],
    ["above MAX_SEQUENCE", maximumSequence, maximumSequence + 1n],
  ]) {
    const before = await rawRecord(registry, scope, sequence);
    const failed = await send(owner, registry, rawPublication(scope, expectedCurrent, sequence, first.signed));
    assert.equal(failed.status, "0x0", `${name}: must produce a failed receipt`);
    assert.equal(failed.to.toLowerCase(), registry.toLowerCase());
    assert.deepEqual(await client.read(), emptyRecord, `${name}: head and record unchanged`);
    assert.equal(await rawRecord(registry, scope, sequence), before, `${name}: no version stored`);
  }
  let firstHash;
  const published = await tool.publishOnchainPolicy(client, first, submit, {
    pollMs: 20,
    async onSubmitted(hash) {
      firstHash = hash;
      const included = await receipt(hash);
      assert.equal(included.status, "0x1");
      const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
      assert.ok(finalized, "Anvil must expose finalized blocks");
      if (BigInt(finalized.number) < BigInt(included.blockNumber)) {
        // A successful receipt alone cannot satisfy the public finality rule.
        // Resume the actual mined transaction without sending it again.
        await assert.rejects(tool.publishOnchainPolicy(client, first, submit, {
          transactionHash: hash, attempts: 1, pollMs: 0,
        }), /confirmation pending/);
        assert.equal(submissions, 1);
      }
      await advanceFinalizedThrough(included);
    },
  });
  assert.equal(published.outcome, "confirmed");
  assert.equal(published.receipt.transactionHash, firstHash);
  assert.ok(BigInt(published.blockNumber) >= BigInt(published.receipt.blockNumber));
  assert.equal(client.config.finality, "finalized");
  const stored = await client.read(1);
  assert.equal(stored.payload, first.signed.payload);
  assert.equal(stored.signature, first.signed.signature);
  assert.equal(stored.digest, tool.sha256(Buffer.from(first.signed.payload)));
  assert.equal(stored.status, 1);
  assert.equal(submissions, 1);
  const resumed = await tool.publishOnchainPolicy(client, first, submit, { transactionHash: firstHash, pollMs: 20 });
  assert.equal(resumed.outcome, "confirmed");
  const reconciled = await tool.publishOnchainPolicy(client, first, submit, { pollMs: 20 });
  assert.equal(reconciled.outcome, "reconciled");
  assert.equal(submissions, 1, "completed retry must not send another transaction");
  // Contract-level retry also preserves the original immutable record.
  assert.equal((await send(owner, registry, data)).status, "0x1");
  assert.equal((await client.read()).head, 1);

  // Exercise the CLI's actual persistence path with an independent scope:
  // genuine out-of-gas receipt -> explicit retry -> successful duplicate resume.
  // No intent regeneration, automining changes or chain reset is involved.
  const retryDirectory = await mkdtemp(resolve(tmpdir(), "dambi-anvil-retry-"));
  t.after(() => rm(retryDirectory, { recursive: true, force: true }));
  const retryConfig = { ...config, profile: "failed-retry" };
  const retryClient = new tool.RegistryClient(retryConfig);
  const retryIntent = await prepare(retryClient);
  const retryPath = resolve(retryDirectory, "intent.json");
  const retryBytes = JSON.stringify(retryIntent, null, 2) + "\n";
  await writeFile(retryPath, retryBytes);
  let retrySends = 0;
  let failedGas;
  let failedReceipt;
  let replacementReceipt;
  const retrySubmit = async ({ chainId, ...tx }) => {
    assert.equal(chainId, 31337);
    assert.equal(tx.data, tool.publicationData(retryClient, retryIntent));
    retrySends++;
    if (retrySends === 1) {
      // Enough for intrinsic calldata gas, deliberately not enough to store a
      // policy. This is an actual EVM failure, not a rejected RPC submission.
      const intrinsic = [...Buffer.from(tx.data.slice(2), "hex")]
        .reduce((gas, byte) => gas + (byte === 0 ? 4n : 16n), 21_000n);
      failedGas = intrinsic + 1_000n;
      tx.gas = "0x" + failedGas.toString(16);
    }
    return rpc("eth_sendTransaction", [tx]);
  };
  const retryOptions = {
    attempts: 1, pollMs: 0,
    async onSubmitted(hash) {
      const included = await receipt(hash);
      if (retrySends === 1) {
        failedReceipt = included;
        assert.equal(included.status, "0x0");
        assert.equal(BigInt(included.gasUsed), failedGas, "transaction must exhaust its gas");
      } else {
        replacementReceipt = included;
        assert.equal(included.status, "0x1");
      }
      await advanceFinalizedThrough(included);
    },
  };
  await assert.rejects(tool.publishStoredIntent(retryClient, retryPath, retrySubmit, retryOptions), /receipt/);
  assert.equal(retrySends, 1);
  assert.equal((await retryClient.read()).status, 0);
  const failedJournal = await readFile(retryPath + ".txhash", "utf8");
  assert.deepEqual(JSON.parse(failedJournal), { hashes: [failedReceipt.transactionHash], submitting: false });
  await assert.rejects(tool.publishStoredIntent(retryClient, retryPath, retrySubmit, retryOptions), /receipt/);
  assert.equal(retrySends, 1, "ordinary publish cannot authorize a failed-transaction retry");

  // Inject only a receipt lookup outage over the real local chain. No amount
  // of explicit retry permission may turn an unavailable result into a send.
  const unavailable = new tool.RegistryClient(retryConfig, async (url, init) => {
    if (JSON.parse(String(init.body)).method === "eth_getTransactionReceipt") throw new Error("isolated receipt outage");
    return fetch(url, init);
  });
  await assert.rejects(tool.publishStoredIntent(unavailable, retryPath, retrySubmit, {
    ...retryOptions, retryFailed: true,
  }), /receipt outage/);
  assert.equal(retrySends, 1);
  assert.equal(await readFile(retryPath + ".txhash", "utf8"), failedJournal);

  const recovered = await tool.publishStoredIntent(retryClient, retryPath, retrySubmit, {
    ...retryOptions, retryFailed: true,
  });
  assert.equal(recovered.outcome, "confirmed");
  assert.equal(recovered.receipt.transactionHash, replacementReceipt.transactionHash);
  assert.notEqual(replacementReceipt.transactionHash, failedReceipt.transactionHash);
  assert.equal(recovered.receipt.status, "0x1");
  assert.equal(await readFile(retryPath, "utf8"), retryBytes, "original signed intent must remain byte-identical");
  assert.deepEqual(JSON.parse(await readFile(retryPath + ".txhash", "utf8")), {
    hashes: [failedReceipt.transactionHash, replacementReceipt.transactionHash], submitting: false,
  });
  const retryRecord = await retryClient.read();
  assert.equal(retryRecord.head, 1);
  assert.equal(retryRecord.status, 1);
  assert.equal(retryRecord.payload, retryIntent.signed.payload);
  assert.equal(retryRecord.signature, retryIntent.signed.signature);
  for (const retryFailed of [false, true]) {
    assert.equal((await tool.publishStoredIntent(retryClient, retryPath, retrySubmit, {
      ...retryOptions, retryFailed,
    })).outcome, "confirmed");
  }
  assert.equal(retrySends, 2, "successful duplicate execution must not send again");

  // A real queued transaction (nonce gap) has no receipt. Explicit retry must
  // retain its hash without creating another transaction. Drop only this test's
  // queued transaction afterwards; leave the isolated node's mining untouched.
  const pendingIntent = await prepare(retryClient);
  const pendingPath = resolve(retryDirectory, "pending.json");
  await writeFile(pendingPath, JSON.stringify(pendingIntent));
  const pendingNonce = BigInt(await rpc("eth_getTransactionCount", [owner, "pending"])) + 1n;
  const pendingHash = await rpc("eth_sendTransaction", [{
    from: owner, to: registry, data: tool.publicationData(retryClient, pendingIntent),
    gas: "0x1c9c380", nonce: "0x" + pendingNonce.toString(16),
  }]);
  try {
    assert.equal(await rpc("eth_getTransactionReceipt", [pendingHash]), null);
    assert.ok(await rpc("eth_getTransactionByHash", [pendingHash]));
    // Legacy CLI sidecar must remain readable without discarding its hash.
    await writeFile(pendingPath + ".txhash", pendingHash + "\n");
    for (const retryFailed of [false, true]) {
      await assert.rejects(tool.publishStoredIntent(retryClient, pendingPath, async () => {
        assert.fail("pending transaction must never be resubmitted");
      }, { retryFailed, attempts: 1, pollMs: 0 }), /confirmation pending/);
    }
    assert.equal(await readFile(pendingPath + ".txhash", "utf8"), pendingHash + "\n");
    assert.equal(retrySends, 2);
  } finally {
    await rpc("anvil_dropTransaction", [pendingHash]);
  }

  // Two genuinely different signed candidates prepared from the same head.
  const second = await prepare();
  const third = await prepare();
  const signer = await tsImport(fileURLToPath(new URL("../../../registryV2/scripts/publish-policy-bundle.ts", import.meta.url)), import.meta.url);
  const competingPayload = JSON.parse(third.signed.payload);
  competingPayload.expires_at += 1;
  third.signed = await signer.signPayload(competingPayload, {
    mode: "local", privKeyHex: Buffer.from(secret).toString("hex"), keyId: first.signed.key_id,
  });
  const secondData = tool.publicationData(client, second);
  const thirdData = tool.publicationData(client, third);
  // Both simulate successfully before either is submitted. Sequential EVM
  // execution must nevertheless allow exactly one conditional state change.
  await Promise.all([secondData, thirdData].map((d) => rpc("eth_call", [{ from: owner, to: registry, data: d }, "latest"])));
  const nonce = BigInt(await rpc("eth_getTransactionCount", [owner, "pending"]));
  // Both candidates already simulated against the same head. Await the first
  // receipt before submitting the next nonce so automining order is explicit;
  // the losing candidate must still fail the contract's conditional update.
  const contenders = [
    await send(owner, registry, secondData, { nonce: "0x" + nonce.toString(16) }),
    await send(owner, registry, thirdData, { nonce: "0x" + (nonce + 1n).toString(16) }),
  ];
  assert.deepEqual(contenders.map((r) => r.status), ["0x1", "0x0"]);
  assert.equal((await client.read(1)).status, 2);
  assert.equal((await client.read(2)).payload, second.signed.payload);
  await assert.rejects(tool.publishOnchainPolicy(client, third, submit), /conflict/);
  await assert.rejects(tool.publishOnchainPolicy(client, first, submit), /SUPERSEDED/);
  assert.equal((await send(owner, registry, data)).status, "0x0", "history cannot reactivate");
  // A failed receipt cannot be mistaken for publication success, even when a
  // different transaction has installed the intended version.
  await assert.rejects(tool.publishOnchainPolicy(client, second, submit, {
    transactionHash: contenders[1].transactionHash, pollMs: 0,
  }), /receipt/);

  const oldRevocation = await send(owner, registry, calldata("revoke(bytes32,uint256)", scope, 1));
  assert.equal(oldRevocation.status, "0x1");
  assert.equal((await client.read(1)).status, 3);
  assert.equal((await client.read()).status, 1);
  const revocation = await send(owner, registry, calldata("revoke(bytes32,uint256)", scope, 2));
  assert.equal(revocation.status, "0x1");
  assert.equal((await client.read()).head, 2);
  assert.equal((await client.read()).status, 3);
  assert.equal((await send(owner, registry, secondData)).status, "0x0");
  await assert.rejects(tool.publishOnchainPolicy(client, second, submit), /REVOKED/);
  assert.equal((await send(owner, registry, calldata("revoke(bytes32,uint256)", scope, 2))).status, "0x1");

  assert.equal((await send(owner, registry, calldata("proposePublisher(address)", next))).status, "0x1");
  assert.equal((await send(next, registry, calldata("revoke(bytes32,uint256)", scope, 1))).status, "0x0");
  assert.equal((await send(owner, registry, calldata("cancelPublisherTransfer()"))).status, "0x1");
  assert.equal((await send(next, registry, calldata("acceptPublisher()"))).status, "0x0");
  assert.equal((await send(owner, registry, calldata("proposePublisher(address)", next))).status, "0x1");
  assert.equal((await send(outsider, registry, calldata("acceptPublisher()"))).status, "0x0");
  assert.equal((await send(next, registry, calldata("acceptPublisher()"))).status, "0x1");
  assert.equal((await send(owner, registry, calldata("revoke(bytes32,uint256)", scope, 1))).status, "0x0");
  await assert.rejects(client.guard(), /publisher/);
  const rotated = new tool.RegistryClient({ ...config, sender: next });
  const afterRevocation = await prepare(rotated);
  assert.equal(afterRevocation.expectedCurrent, 2);
  const rotation = await tool.publishOnchainPolicy(rotated, afterRevocation, submit, {
    pollMs: 20,
    async onSubmitted(hash) {
      const included = await receipt(hash);
      assert.equal(included.status, "0x1");
      await advanceFinalizedThrough(included);
    },
  });
  assert.equal(rotation.outcome, "confirmed");
  assert.ok(BigInt(rotation.blockNumber) >= BigInt(rotation.receipt.blockNumber));
  assert.equal(rotated.config.finality, "finalized");
  assert.equal((await rotated.read()).head, 3);
  assert.equal((await rotated.read(2)).status, 3);

  // Reuse only the existing test harness, never add seeding to production.
  // This isolates the 2^53 boundary without billions of preliminary writes.
  const boundaryArtifact = JSON.parse(await readFile(resolve(foundryRoot,
    process.env.FOUNDRY_OUT || "out", "PolicyRegistry.t.sol", "BoundaryRegistry.json"), "utf8"));
  const boundaryDeployment = await send(owner, undefined, boundaryArtifact.bytecode.object);
  assert.equal(boundaryDeployment.status, "0x1");
  const boundaryAddress = boundaryDeployment.contractAddress;
  assert.ok(boundaryAddress);
  const boundaryConfig = { ...config, registry: boundaryAddress };
  const boundaryClient = new tool.RegistryClient(boundaryConfig);
  await boundaryClient.guard();
  const boundaryScope = tool.scopeId(boundaryConfig);
  const onchainMaximum = BigInt(await rpc("eth_call", [{
    to: boundaryAddress, data: calldata("MAX_SEQUENCE()"),
  }, "latest"]));
  assert.equal(onchainMaximum, maximumSequence);
  const maximum = tool.safeSequence(onchainMaximum.toString());
  assert.equal(maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(BigInt(maximum), onchainMaximum, "TS conversion must be lossless");
  assert.throws(() => tool.safeSequence((onchainMaximum + 1n).toString()), /unsafe sequence/);
  const seed = await send(owner, boundaryAddress,
    calldata("seedHead(bytes32,uint256)", boundaryScope, onchainMaximum - 1n));
  assert.equal(seed.status, "0x1");
  const seeded = await boundaryClient.read();
  assert.equal(seeded.head, maximum - 1);
  assert.equal(seeded.status, 0, "seedHead must not synthesize a policy record");
  const maximumIntent = await prepare(boundaryClient);
  assert.equal(maximumIntent.expectedCurrent, maximum - 1);
  assert.equal(JSON.parse(maximumIntent.signed.payload).sequence, maximum);
  assert.equal(JSON.parse(maximumIntent.signed.payload).registry_ref, tool.registryReference(boundaryConfig));
  const maximumPublication = await tool.publishOnchainPolicy(boundaryClient, maximumIntent, submit, {
    pollMs: 20,
    async onSubmitted(hash) {
      const included = await receipt(hash);
      assert.equal(included.status, "0x1");
      await advanceFinalizedThrough(included);
    },
  });
  assert.equal(maximumPublication.outcome, "confirmed");
  assert.equal(maximumPublication.receipt.status, "0x1");
  assert.ok(BigInt(maximumPublication.blockNumber) >= BigInt(maximumPublication.receipt.blockNumber));
  const maximumRecord = await boundaryClient.read(maximum);
  assert.equal(maximumRecord.head, maximum);
  assert.equal(BigInt(maximumRecord.head), onchainMaximum);
  assert.equal(maximumRecord.status, 1);
  assert.equal(maximumRecord.payload, maximumIntent.signed.payload);
  assert.equal(maximumRecord.signature, maximumIntent.signed.signature);
  assert.equal(maximumRecord.keyId, maximumIntent.signed.key_id);
  assert.equal(maximumRecord.digest, tool.sha256(Buffer.from(maximumIntent.signed.payload)));
  assert.deepEqual(await boundaryClient.read(), maximumRecord);
  const latestMaximum = BigInt(await rpc("eth_call", [{
    to: boundaryAddress, data: calldata("latest(bytes32)", boundaryScope),
  }, "latest"]));
  assert.equal(latestMaximum, onchainMaximum, "actual Solidity head must equal the TS head");
  await assert.rejects(prepare(boundaryClient), /sequence exhausted/);
  await assert.rejects(boundaryClient.read(maximum + 1), /unsafe sequence/);

  // Even a freshly signed full payload cannot exceed the numeric wire bound.
  // Raw ABI submission is intentional: TS must reject it, AND the real EVM
  // transaction must fail independently with no change to the active record.
  const overflowPayload = { ...JSON.parse(maximumIntent.signed.payload), sequence: maximum + 1 };
  const overflowSigned = await signer.signPayload(overflowPayload, {
    mode: "local", privKeyHex: Buffer.from(secret).toString("hex"), keyId: maximumIntent.signed.key_id,
  });
  assert.throws(() => tool.validateIntent(boundaryClient, {
    expectedCurrent: maximum, signed: overflowSigned,
  }), /unsafe sequence/);
  for (const [name, expectedCurrent, sequence, signed] of [
    ["exhausted successor", onchainMaximum, onchainMaximum + 1n, overflowSigned],
    ["exhausted expectedCurrent", onchainMaximum, onchainMaximum, maximumIntent.signed],
  ]) {
    const before = await rawRecord(boundaryAddress, boundaryScope, sequence);
    const failed = await send(owner, boundaryAddress,
      rawPublication(boundaryScope, expectedCurrent, sequence, signed));
    assert.equal(failed.status, "0x0", `${name}: must produce a failed receipt`);
    assert.equal(failed.to.toLowerCase(), boundaryAddress.toLowerCase());
    assert.deepEqual(await boundaryClient.read(), maximumRecord, `${name}: active state unchanged`);
    assert.deepEqual(await boundaryClient.read(maximum), maximumRecord, `${name}: immutable bytes unchanged`);
    assert.equal(await rawRecord(boundaryAddress, boundaryScope, sequence), before, `${name}: selected record unchanged`);
  }

  const measurements = {
    deploymentGas: BigInt(deployment.gasUsed).toString(),
    initialPublicationGas: BigInt(published.receipt.gasUsed).toString(),
    replacementGas: BigInt(contenders[0].gasUsed).toString(),
    revocationGas: BigInt(revocation.gasUsed).toString(),
    payloadBytes: Buffer.byteLength(first.signed.payload),
    signatureBytes: Buffer.from(first.signed.signature, "base64").length,
  };
  const budgets = process.env.DAMBI_TEST_POLICY_BUDGETS ? JSON.parse(process.env.DAMBI_TEST_POLICY_BUDGETS) : null;
  if (budgets) {
    for (const [name, measured] of Object.entries(measurements)) {
      assert.ok(Object.hasOwn(budgets, name), `missing approved budget: ${name}`);
      assert.match(String(budgets[name]), /^[1-9][0-9]*$/, `invalid budget: ${name}`);
      assert.ok(BigInt(measured) <= BigInt(budgets[name]), `${name} exceeds supplied budget; evaluate one storage alternative before acceptance`);
    }
  }
  t.diagnostic(JSON.stringify({
    kind: "local-Anvil-receipt-measurement", chainId: 31337, measurements,
    budgetAssessment: budgets ? "compared-to-explicit-test-input" : "pending-no-approved-numeric-budget",
    ethereum: "not measured; local gas units are not Ethereum fee evidence or GIWA L1-data fees",
    giwa: "not measured; requires separate external execution approval",
    review: "test output is not independent review approval",
  }));
});
