import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Build the Foundry contract and @dambi/core first. Run with DAMBI_TEST_RPC_URL pointing
// at a dedicated loopback Anvil (31337). DAMBI_TEST_CORE_TARBALL selects an exact CI
// package; otherwise pack the compiled workspace once. No registry download is needed.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const registryRequire = createRequire(new URL("../../../registryV2/package.json", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (exe, args, cwd = root) => execFileSync(exe, args, { cwd, encoding: "utf8", timeout: 60_000 }).trim();

async function installWallet(t) {
  const dir = await mkdtemp(join(tmpdir(), "policy-wallet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let tarball = process.env.DAMBI_TEST_CORE_TARBALL;
  if (!tarball) {
    const [packed] = JSON.parse(command("npm", ["pack", "--json", "--offline", "--ignore-scripts",
      "--pack-destination", dir], join(root, "packages/core")));
    tarball = join(dir, packed.filename);
  }
  const bytes = await readFile(tarball);
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", resolve(tarball)], dir);
  // This module resolves the same public exports that a third-party wallet imports.
  const entry = join(dir, "consumer.mjs");
  await writeFile(entry, 'export { createCore, CoreError } from "@dambi/core";\n'
    + 'export { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";\n'
    + 'export { createOnchainPolicySource } from "@dambi/core/adapters";\n');
  t.diagnostic(JSON.stringify({ tarballSha256: sha256(bytes), packageSource:
    process.env.DAMBI_TEST_CORE_TARBALL ? "supplied" : "workspace-pack" }));
  return import(pathToFileURL(entry).href);
}

async function readerProxy(t, endpoint, address) {
  let reads = 0;
  const violations = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const call = JSON.parse(body);
      assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode"].includes(call.method));
      if (call.method === "eth_getCode") assert.equal(call.params[0].toLowerCase(), address);
      if (call.method === "eth_call") assert.equal(call.params[0].to.toLowerCase(), address);
      reads++;
      const upstream = await fetch(endpoint, { method: "POST", redirect: "error", body,
        headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000) });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      violations.push(String(error));
      res.destroy();
    }
  });
  let port = 0;
  const connect = () => new Promise((yes, no) => {
    const fail = (error) => no(error);
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", fail);
      port = server.address().port;
      yes();
    });
  });
  async function disconnect() {
    if (!server.listening) return;
    await new Promise((done) => { server.close(done); server.closeAllConnections(); });
  }
  await connect();
  t.after(disconnect);
  return { url: `http://127.0.0.1:${port}/`, connect, disconnect, count: () => reads, violations };
}

test("installed wallet observes published, replaced and revoked policy on a real local registry", { timeout: 180_000 }, async (t) => {
  assert.ok(process.env.DAMBI_TEST_RPC_URL, "set DAMBI_TEST_RPC_URL to an isolated Anvil");
  const endpoint = new URL(process.env.DAMBI_TEST_RPC_URL);
  assert.ok(endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.hash);
  const sdk = await installWallet(t);
  let rpcId = 0;
  async function rpc(method, params = []) {
    const id = ++rpcId;
    const response = await fetch(endpoint, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    assert.ok(response.ok);
    const body = await response.json();
    assert.equal(body.id, id);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  }
  assert.equal(BigInt(await rpc("eth_chainId")), 31337n);
  const version = await rpc("web3_clientVersion");
  assert.match(version, /anvil/i);
  const info = await rpc("anvil_nodeInfo");
  assert.ok(!info.forkConfig?.forkUrl && !info.forkConfig?.forkBlockNumber, "use an unforked Anvil");
  t.diagnostic(JSON.stringify({ node: version, transactionChain: 1, registryChain: 31337 }));

  // Sample the actual finalized tag before admitting a publication. The reference clock
  // follows the fixture node's finalized time; only the explicit outage step advances it.
  let now;
  async function finalizedThrough(number) {
    for (let i = 0; i <= 8; i++) {
      const head = await rpc("eth_getBlockByNumber", ["finalized", false]);
      if (BigInt(head.number) >= BigInt(number)) {
        now = Math.max(now ?? 0, Number(BigInt(head.timestamp)) * 1000);
        return head;
      }
      if (i < 8) await rpc("anvil_mine", ["0x20"]);
    }
    assert.fail("finalized tag did not reach the target block");
  }
  async function finalized(hash) {
    let receipt;
    for (let i = 0; !receipt && i < 100; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (!receipt) await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(receipt?.status, "0x1");
    const head = await finalizedThrough(receipt.blockNumber);
    assert.equal((await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])).hash, receipt.blockHash);
    t.diagnostic(JSON.stringify({ hash, block: receipt.blockNumber, finalized: head.number }));
    return receipt;
  }
  const owner = "0x" + randomBytes(20).toString("hex");
  await rpc("anvil_setBalance", [owner, "0x3635c9adc5dea00000"]);
  await rpc("anvil_impersonateAccount", [owner]);
  t.after(() => rpc("anvil_stopImpersonatingAccount", [owner]));
  const send = (data, to) => rpc("eth_sendTransaction", [{ from: owner, ...(to && { to }),
    data, gas: "0x1c9c380" }]).then(finalized);
  const artifact = JSON.parse(await readFile(resolve(root, "contracts/policy-registry",
    process.env.FOUNDRY_OUT || "out", "PolicyRegistry.sol", "PolicyRegistry.json"), "utf8"));
  const constructor = command("cast", ["abi-encode", "constructor(address)", owner]);
  const registry = (await send(artifact.bytecode.object + constructor.slice(2))).contractAddress.toLowerCase();
  const expectedRuntimeCode = artifact.deployedBytecode.object;
  assert.equal(await rpc("eth_getCode", [registry, "finalized"]), expectedRuntimeCode);

  const { tsImport } = await import(registryRequire.resolve("tsx/esm/api"));
  const publisher = await tsImport(join(root, "registryV2/scripts/publish-onchain-policy.ts"), import.meta.url);
  const { p256 } = await import(registryRequire.resolve("@noble/curves/nist.js"));
  const secret = p256.utils.randomSecretKey();
  const pub = Buffer.from(p256.getPublicKey(secret, false));
  const keyId = "local-policy-wallet";
  const publicKeySpkiBase64 = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url"),
  } }).export({ type: "spki", format: "der" }).toString("base64");
  const config = { rpcUrl: endpoint.href, network: "local", registry, sender: owner, env: "staging",
    profile: "default", finality: "finalized", trustedPublicKeyHex: pub.toString("hex") };
  const client = new publisher.RegistryClient(config);
  async function publish() {
    const intent = await publisher.prepareOnchainPolicy(client, { repoRoot: root, set: "day1-safety",
      issuedAt: Math.min(Math.floor(Date.now() / 1000), now / 1000),
      expiresAt: Math.max(Math.ceil(Date.now() / 1000), now / 1000) + 86_400,
      signing: { mode: "local", privKeyHex: Buffer.from(secret).toString("hex"), keyId } });
    const outcome = await publisher.publishOnchainPolicy(client, intent, ({ chainId, ...tx }) => {
      assert.equal(chainId, 31337);
      return rpc("eth_sendTransaction", [tx]);
    }, { pollMs: 20, onSubmitted: finalized });
    assert.equal(outcome.outcome, "confirmed");
    return intent.signed;
  }

  const signedV1 = await publish();
  const proxy = await readerProxy(t, endpoint, registry);
  const maxStateAgeMs = 20_000;
  const clock = { now: () => now };
  const registryTrust = { chainId: 31337, registryAddress: registry, finality: "finalized", maxStateAgeMs };
  const makeSource = () => sdk.createOnchainPolicySource({
    env: "staging", profile: "default", ...registryTrust, chainId: "eip155:31337",
    rpcUrl: proxy.url, expectedRuntimeCode, clock, timeoutMs: 3500, allowedClockSkewMs: 1000,
    maxBlockAgeMs: 120_000, maxResponseBytes: 2_000_000, refreshIntervalMs: 5000,
  });
  const openWallet = (source = makeSource()) => sdk.createCore({
    decoderSnapshot: sdk.decoderSnapshot,
    trust: { env: "staging", profile: "default", registry: registryTrust,
      keys: [{ keyId, role: "policy", publicKeySpkiBase64 }] },
    limits: { allowedClockSkewMs: 1000, maxPolicyBytes: 1_000_000, maxDecoderBytes: sdk.decoderSnapshotInfo.bytes,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
      planTtlMs: 600_000, maxPendingPlans: 8, maxFactAgeMs: 30_000, factTimeoutMs: 1000, policyTimeoutMs: 5000 },
    enforcement: "enforcing", clock,
    ports: { policy: source, fact: { async fetch() { assert.fail("burn transfer requires no Facts"); } } },
  });
  const request = { kind: "transaction", chainId: "eip155:1", from: "0x" + "00".repeat(18) + "aaaa",
    to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", value: "0",
    data: "0xa9059cbb" + "dead".padStart(64, "0") + "1".padStart(64, "0") };
  async function deny(wallet, generation) {
    const verdict = await wallet.check(request);
    assert.equal(verdict.source, "evaluated");
    assert.equal(verdict.decision, "deny", JSON.stringify({ reasons: verdict.reasons, diagnostics: verdict.diagnostics }));
    assert.equal(verdict.enforcement, "enforcing");
    assert.equal(verdict.metadata.policyVersion, String(generation));
    const policyIds = verdict.reasons.map((reason) => reason.policyId);
    assert.ok(policyIds.includes("send-first-time-or-burn-recipient-warn"));
    t.diagnostic(JSON.stringify({ version: verdict.metadata.policyVersion, decision: verdict.decision, policyIds }));
  }
  function rejectedPlan(wallet, plan) {
    assert.ok(plan.expiresAt > now, "pending handle remains within its own TTL");
    const result = wallet.evaluate(plan, { planId: plan.planId, results: {} });
    assert.equal(result.source, "fail_closed");
    assert.equal(result.decision, "deny");
    const diagnostics = result.diagnostics.map((item) => item.code);
    assert.ok(diagnostics.includes("trust_expired"));
    t.diagnostic(JSON.stringify({ source: result.source, decision: result.decision, diagnostics }));
  }
  const code = (expected) => (error) => error instanceof sdk.CoreError && error.code === expected;
  async function sameBytes(source, signed, generation) {
    const observed = await source.fetch();
    assert.equal(observed.payload, signed.payload);
    assert.equal(observed.signature, signed.signature);
    assert.equal(observed.keyId, signed.key_id);
    assert.equal(observed.registryState.version, generation);
  }

  const source = makeSource();
  await sameBytes(source, signedV1, 1);
  const wallet = await openWallet(source);
  t.after(() => wallet.dispose());
  await deny(wallet, 1);
  const v1Plan = await wallet.plan(request);

  const signedV2 = await publish();
  await sameBytes(source, signedV2, 2);
  await wallet.refreshPolicies();
  rejectedPlan(wallet, v1Plan);
  await deny(wallet, 2);
  const v2Plan = await wallet.plan(request);
  const observedAt = now;

  await proxy.disconnect();
  await assert.rejects(wallet.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  await assert.rejects(openWallet(), code("POLICY_FETCH_FAILED"));
  now = observedAt + maxStateAgeMs - 1;
  await deny(wallet, 2);
  now++;
  await assert.rejects(wallet.plan(request), code("POLICY_EXPIRED"));
  rejectedPlan(wallet, v2Plan);

  await proxy.connect();
  // A new finalized block can renew v2 after the outage, without re-signing.
  const tip = await rpc("eth_getBlockByNumber", ["latest", false]);
  const nextTimestamp = Math.max(Math.floor(now / 1000), Number(BigInt(tip.timestamp))) + 1;
  await rpc("evm_setNextBlockTimestamp", [nextTimestamp]);
  await rpc("evm_mine");
  await finalizedThrough(await rpc("eth_blockNumber"));
  await sameBytes(source, signedV2, 2);
  await wallet.refreshPolicies();
  await deny(wallet, 2);
  const fresh = await openWallet();
  try { await deny(fresh, 2); } finally { fresh.dispose(); }
  const beforeRevocation = await wallet.plan(request);
  await send(command("cast", ["calldata", "revoke(bytes32,uint256)", publisher.scopeId(config), "2"]), registry);
  await wallet.refreshPolicies();
  rejectedPlan(wallet, beforeRevocation);
  await assert.rejects(wallet.plan(request), code("POLICY_EXPIRED"));
  const readCount = proxy.count();
  await assert.rejects(openWallet(), code("POLICY_EXPIRED"));
  assert.ok(proxy.count() > readCount, "a fresh consumer reads the revoked head instead of selecting v1");
  assert.deepEqual(proxy.violations, []);
});
