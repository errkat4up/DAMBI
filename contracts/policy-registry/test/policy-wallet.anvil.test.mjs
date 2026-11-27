import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Isolated, opt-in acceptance; missing inputs FAIL rather than skip.
// Prerequisites: Node >=20, forge/cast/anvil, registryV2's installed tsx and
// @noble/curves dependencies, a built candidate @dambi/core npm tarball, and
// the independent wallet consumer module from the existing QA review route.
// No package download, credentials, external RPC, fork, or deployment script.
//
//   forge build --root contracts/policy-registry
//   anvil --host 127.0.0.1 --port 8545 --chain-id 31337
//   DAMBI_TEST_RPC_URL=http://127.0.0.1:8545 \
//   DAMBI_TEST_CANDIDATE_HEAD=<40-digit-candidate-HEAD> \
//   DAMBI_TEST_ANVIL_VERSION='<exact web3_clientVersion of pinned Anvil>' \
//   DAMBI_TEST_CORE_TARBALL=/absolute/path/dambi-core-0.1.0.tgz \
//   DAMBI_TEST_WALLET_MODULE=/absolute/path/independent-wallet.mjs \
//   node --test contracts/policy-registry/test/policy-wallet.anvil.test.mjs
//
// The independent wallet is an explicit acceptance input, NOT a substitute
// implementation of Core. Its self-contained ESM module exports:
//   createWallet({ core, adapters, rpcUrl, chainId, registryAddress, env,
//                  profile, trustedPublicKeyHex, confirmationWindowMs })
// The namespaces core/adapters are imported by the host from the installed
// candidate tarball's PUBLIC exports, never from the checkout. The wallet
// integrates those APIs and returns:
//   refresh() -> { sequence, payload, signature }
//   check(tx) -> { decision: 'deny' | 'allow', policyIds: string[] }
//   prepare(tx) -> opaque active plan
//   evaluate(plan) -> decision, or rejection
//   acceptEnvelope(envelope) -> rejection for superseded/revoked envelopes
//   close() -> Promise<void>
// This protocol belongs only to the independent acceptance host; it does not
// assert undocumented @dambi/core method names. QA must supply/review the
// wallet implementation. It must not manufacture decisions or implement
// signature verification/policy evaluation itself. Missing that artifact is
// a hard failure, not evidence that F1/F4/F5 passed. The module is copied into
// the isolated consumer directory and cannot use relative checkout imports.
//
// Run in an OS/network-isolated local QA environment. The consumer additionally
// permits fetch only to its literal-loopback RPC proxy; all other Node socket
// connections and child processes are blocked. The proxy forwards original RPC
// replies; it never fabricates chain data. Outages close the listening socket.
// Runtime JSON diagnostics and TAP are measurements, not checked-in evidence
// or dambi-review approval. Preserve BOTH stdout and stderr for that review.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRegistry = createRequire(new URL("../../../registryV2/package.json", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const command = (exe, args, cwd = root) => execFileSync(exe, args, {
  cwd, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, NODE_OPTIONS: "" },
}).trim();

function required(name) {
  assert.ok(process.env[name], `missing required acceptance input: ${name}`);
  return process.env[name];
}
function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.hash && !url.search,
  "RPC must be literal loopback HTTP without credentials/query/fragment");
  return url.href;
}

// Host for the genuinely separate wallet process. Messages carry signed policy
// bytes and transaction vectors, never signing material or publisher authority.
const consumerHost = String.raw`
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

const config = JSON.parse(process.env.DAMBI_WALLET_CONFIG);
const nativeFetch = globalThis.fetch;
const endpoint = new URL(config.rpcUrl);
const blocked = [];
function deny(kind) {
  blocked.push(kind);
  throw new Error('acceptance network boundary: ' + kind);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host = typeof options === 'object' ? options.host : args[1];
  const port = typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || Number(port) !== Number(endpoint.port)) deny('socket');
  return connect.apply(this, args);
};
tls.connect = () => deny('TLS');
dgram.createSocket = () => deny('UDP');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => deny('child process');
}
syncBuiltinESMExports();
globalThis.fetch = (input, init = {}) => {
  const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (new URL(value).href !== endpoint.href) return Promise.reject(new Error('acceptance network boundary: fetch'));
  return nativeFetch(input, { ...init, redirect: 'error' });
};
const core = await import('@dambi/core');
const adapters = await import('@dambi/core/adapters');
const { createWallet } = await import('./wallet.mjs');
assert.equal(typeof createWallet, 'function');
let wallet;
const plans = new Map();
let nextPlan = 0;
const respond = (message) => process.send(message);
process.on('message', async ({ id, op, value }) => {
  try {
    let result;
    switch (op) {
      case 'start':
        assert.equal(wallet, undefined);
        wallet = await createWallet({ core, adapters, ...config });
        for (const name of ['refresh', 'check', 'prepare', 'evaluate', 'acceptEnvelope', 'close']) {
          assert.equal(typeof wallet[name], 'function', 'wallet interface: ' + name);
        }
        result = { ready: true };
        break;
      case 'refresh': result = await wallet.refresh(); break;
      case 'check': result = await wallet.check(value); break;
      case 'prepare': {
        const plan = await wallet.prepare(value);
        assert.ok(plan, 'must create an actual active Core plan');
        result = String(++nextPlan);
        plans.set(result, plan);
        break;
      }
      case 'evaluate':
        assert.ok(plans.has(value), 'unknown host plan handle');
        result = await wallet.evaluate(plans.get(value));
        break;
      case 'acceptEnvelope': result = await wallet.acceptEnvelope(value); break;
      case 'audit': result = { blocked }; break;
      case 'close': await wallet.close(); result = true; break;
      default: throw new Error('unknown host operation');
    }
    respond({ id, ok: true, result });
  } catch (error) {
    respond({ id, ok: false, error: { name: error.name, code: error.code, message: error.message } });
  }
});
respond({ ready: true });
`;

async function startConsumer(directory, config, diagnostic) {
  const child = spawn(process.execPath, [resolve(directory, "host.mjs")], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, NODE_OPTIONS: "",
      DAMBI_WALLET_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", (bytes) => diagnostic(`wallet stdout: ${bytes}`));
  child.stderr.on("data", (bytes) => diagnostic(`wallet stderr: ${bytes}`));
  let serial = 0;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const timer = setTimeout(() => readyReject(new Error("wallet startup timeout")), 30_000);
  child.on("error", readyReject);
  child.on("exit", (code, signal) => {
    const error = new Error(`wallet exited: code=${code} signal=${signal}`);
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  });
  child.on("message", (message) => {
    if (message.ready) return readyResolve();
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    item.resolve(message);
  });
  try { await ready; } catch (error) { child.kill(); throw error; } finally { clearTimeout(timer); }
  async function request(op, value) {
    const id = ++serial;
    let timeout;
    try {
      return await new Promise((yes, no) => {
        timeout = setTimeout(() => { pending.delete(id); no(new Error(`wallet ${op} timed out`)); }, 20_000);
        pending.set(id, { resolve: yes, reject: no });
        child.send({ id, op, value }, (error) => { if (error) no(error); });
      });
    } finally { clearTimeout(timeout); }
  }
  async function call(op, value) {
    const response = await request(op, value);
    assert.equal(response.ok, true, `${op}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  return { request, call, kill: () => child.kill(), async close() {
    try { await call("close"); } finally { child.kill(); }
  } };
}

test("installed independent wallet: real registry lifecycle, outage deadline and cold restart", {
  timeout: 240_000,
}, async (t) => {
  let stage = "prerequisites";
  const record = (kind, value) => t.diagnostic(JSON.stringify({ kind, ...value }));
  try {
    const endpoint = loopback(required("DAMBI_TEST_RPC_URL"));
    const candidate = required("DAMBI_TEST_CANDIDATE_HEAD");
    assert.match(candidate, /^[0-9a-f]{40}$/);
    assert.equal(command("git", ["rev-parse", "HEAD"]), candidate, "candidate HEAD mismatch");
    const pinnedVersion = required("DAMBI_TEST_ANVIL_VERSION");
    const tarball = await realpath(required("DAMBI_TEST_CORE_TARBALL"));
    const walletModule = await realpath(required("DAMBI_TEST_WALLET_MODULE"));
    const tarballBytes = await readFile(tarball);
    const walletBytes = await readFile(walletModule);
    const directory = await mkdtemp(resolve(tmpdir(), "dambi-policy-wallet-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(resolve(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    // Isolated installation, no lifecycle scripts and no registry access.
    command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=false", tarball], directory);
    const installed = JSON.parse(await readFile(resolve(directory, "node_modules/@dambi/core/package.json"), "utf8"));
    assert.equal(installed.name, "@dambi/core");
    await writeFile(resolve(directory, "wallet.mjs"), walletBytes);
    await writeFile(resolve(directory, "host.mjs"), consumerHost);

    let rpcId = 0;
    async function rpc(method, params = []) {
      const id = ++rpcId;
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      assert.equal(response.ok, true);
      const body = await response.json();
      assert.equal(body.id, id);
      assert.equal(body.error, undefined, JSON.stringify(body.error));
      return body.result;
    }
    assert.equal(BigInt(await rpc("eth_chainId")), 31337n);
    const nodeVersion = await rpc("web3_clientVersion");
    assert.match(nodeVersion, /anvil/i);
    assert.equal(nodeVersion, pinnedVersion, "node version differs from explicit pin");
    const nodeInfo = await rpc("anvil_nodeInfo");
    assert.ok(nodeInfo && typeof nodeInfo === "object");
    assert.ok(!nodeInfo.forkConfig?.forkUrl && !nodeInfo.forkConfig?.forkBlockNumber,
      "forked nodes are not isolated acceptance nodes");
    record("acceptance-inputs", {
      candidate, nodeVersion, node: process.version, forge: command("forge", ["--version"]),
      cast: command("cast", ["--version"]), tarballSha256: hash(tarballBytes),
      independentWalletSha256: hash(walletBytes), packageVersion: installed.version,
      command: "node --test contracts/policy-registry/test/policy-wallet.anvil.test.mjs",
      transport: "real-loopback-Anvil; no fake RPC responses", review: "pending-dambi-review",
    });

    async function receipt(transactionHash) {
      for (let i = 0; i < 100; i++) {
        const included = await rpc("eth_getTransactionReceipt", [transactionHash]);
        if (included) {
          assert.equal(included.status, "0x1", `failed transaction ${transactionHash}`);
          for (let batch = 0; batch <= 8; batch++) {
            const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
            assert.ok(finalized, "Anvil must expose finalized");
            if (BigInt(finalized.number) >= BigInt(included.blockNumber)) {
              const canonical = await rpc("eth_getBlockByNumber", [included.blockNumber, false]);
              assert.equal(canonical.hash, included.blockHash);
              record("real-receipt", { stage, transactionHash, blockNumber: included.blockNumber,
                blockHash: included.blockHash, status: included.status, gasUsed: included.gasUsed,
                finalizedBlock: finalized.number });
              return included;
            }
            if (batch < 8) await rpc("anvil_mine", ["0x20"]);
          }
          assert.fail("finalized did not reach receipt after 256 empty blocks");
        }
        await sleep(20);
      }
      assert.fail("transaction receipt timeout");
    }
    const calldata = (signature, ...args) => command("cast", ["calldata", signature, ...args.map(String)]);
    const owner = "0x" + randomBytes(20).toString("hex");
    await rpc("anvil_setBalance", [owner, "0x3635c9adc5dea00000"]);
    await rpc("anvil_impersonateAccount", [owner]);
    t.after(() => rpc("anvil_stopImpersonatingAccount", [owner]));
    const send = (to, data) => rpc("eth_sendTransaction", [{ from: owner,
      ...(to ? { to } : {}), data, gas: "0x1c9c380" }]).then(receipt);
    const artifactBytes = await readFile(resolve(root, "contracts/policy-registry",
      process.env.FOUNDRY_OUT || "out", "PolicyRegistry.sol/PolicyRegistry.json"));
    const artifact = JSON.parse(artifactBytes);
    assert.ok(Array.isArray(artifact.abi));
    for (const name of ["publish", "read", "revoke", "scopeId"]) {
      assert.ok(artifact.abi.some((entry) => entry.type === "function" && entry.name === name));
    }
    assert.match(artifact.bytecode.object, /^0x[0-9a-fA-F]+$/);
    stage = "deploy-local-registry";
    const constructor = command("cast", ["abi-encode", "constructor(address)", owner]);
    const deployment = await send(undefined, artifact.bytecode.object + constructor.slice(2));
    const registry = deployment.contractAddress.toLowerCase();
    assert.notEqual(await rpc("eth_getCode", [registry, "latest"]), "0x");
    record("registry-artifact", { registry, sha256: hash(artifactBytes) });

    const { tsImport } = await import(requireRegistry.resolve("tsx/esm/api"));
    const tool = await tsImport(resolve(root, "registryV2/scripts/publish-onchain-policy.ts"), import.meta.url);
    const { p256 } = await import(requireRegistry.resolve("@noble/curves/nist.js"));
    const secret = p256.utils.randomSecretKey();
    const trustedPublicKeyHex = Buffer.from(p256.getPublicKey(secret, false)).toString("hex");
    const config = { rpcUrl: endpoint, network: "local", registry, sender: owner,
      env: "staging", profile: "default", finality: "finalized", trustedPublicKeyHex };
    const client = new tool.RegistryClient(config);
    async function publish() {
      const intent = await tool.prepareOnchainPolicy(client, {
        repoRoot: root, set: "day1-safety", expiresAt: Math.floor(Date.now() / 1000) + 3600,
        signing: { mode: "local", privKeyHex: Buffer.from(secret).toString("hex"), keyId: "ephemeral-wallet-acceptance" },
      });
      const result = await tool.publishOnchainPolicy(client, intent, async ({ chainId, ...tx }) => {
        assert.equal(chainId, 31337);
        return rpc("eth_sendTransaction", [tx]);
      }, { pollMs: 20, onSubmitted: receipt });
      assert.equal(result.outcome, "confirmed");
      const stored = await client.read();
      assert.equal(stored.payload, intent.signed.payload);
      assert.equal(stored.signature, intent.signed.signature);
      assert.equal(stored.status, 1);
      return intent.signed;
    }
    stage = "publish-v1";
    const first = await publish();
    assert.equal(JSON.parse(first.payload).sequence, 1);

    // A transparent, read-only TCP outage boundary. The publisher never uses it.
    const reads = [];
    const violations = [];
    const allowed = new Set(["eth_chainId", "eth_call", "eth_getBlockByNumber", "eth_blockNumber", "eth_getCode"]);
    const proxy = createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/");
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          assert.ok(length < 1_048_576);
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const body = JSON.parse(bytes.toString("utf8"));
        for (const call of Array.isArray(body) ? body : [body]) {
          assert.ok(allowed.has(call.method), `wallet attempted ${call.method}`);
          if (call.method === "eth_call" || call.method === "eth_getCode") {
            const target = call.method === "eth_call" ? call.params[0].to : call.params[0];
            assert.equal(target.toLowerCase(), registry, "wallet may read only the deployed registry");
          }
          reads.push({ method: call.method, params: call.params });
        }
        const upstream = await fetch(endpoint, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json" }, body: bytes,
          signal: AbortSignal.timeout(10_000) });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        violations.push(error.message);
        response.destroy();
      }
    });
    await new Promise((yes, no) => { proxy.once("error", no); proxy.listen(0, "127.0.0.1", yes); });
    const port = proxy.address().port;
    async function disconnect() {
      if (!proxy.listening) return;
      await new Promise((done) => { proxy.close(done); proxy.closeAllConnections(); });
    }
    t.after(disconnect);
    const confirmationWindowMs = 2_000;
    const consumerConfig = { rpcUrl: `http://127.0.0.1:${port}/`, chainId: 31337,
      registryAddress: registry, env: "staging", profile: "default",
      trustedPublicKeyHex, confirmationWindowMs };
    let wallet = await startConsumer(directory, consumerConfig, (text) => t.diagnostic(text));
    t.after(() => wallet.kill());
    await wallet.call("start");
    const refresh = async (signed, sequence) => {
      const before = reads.length;
      const loaded = await wallet.call("refresh");
      assert.equal(loaded.sequence, sequence);
      assert.equal(loaded.payload, signed.payload, "original UTF-8 bytes must survive registry/adapter/Core path");
      assert.equal(loaded.signature, signed.signature);
      assert.ok(reads.slice(before).some((call) => call.method === "eth_call"), "refresh must read real registry");
    };
    // Existing policy catalog's unverified-token-approve-deny trigger and the
    // canonical ERC-20 approve selector; no token/price/indexer request is needed.
    const transaction = { chainId: 31337, from: "0x" + "11".repeat(20),
      to: "0x" + "22".repeat(20), value: "0x0",
      data: "0x095ea7b3" + "33".repeat(20).padStart(64, "0") + "f".repeat(64) };
    const assertDeny = async (label) => {
      const decision = await wallet.call("check", transaction);
      assert.equal(decision.decision, "deny", `${label}: must produce an actual deny, not an unavailable/error result`);
      assert.ok(Array.isArray(decision.policyIds) && decision.policyIds.length > 0);
      const ids = new Set(JSON.parse(first.payload).policies.map((policy) => policy.id));
      assert.ok(decision.policyIds.some((id) => ids.has(id)), "deny must identify a published policy");
      record("consumer-decision", { stage: label, ...decision });
    };
    async function reject(op, value, label) {
      const response = await wallet.request(op, value);
      assert.equal(response.ok, false, `${label}: operation unexpectedly succeeded`);
      assert.ok(response.error?.message);
      // Host failures and network accidents are not semantic lifecycle rejection.
      assert.doesNotMatch(response.error.message, /unknown host|wallet interface|not a function|acceptance network boundary/i);
      record("consumer-rejection", { stage: label, operation: op, error: response.error });
    }
    stage = "fresh-consumer-deny";
    await refresh(first, 1);
    await assertDeny(stage);
    const oldPlan = await wallet.call("prepare", transaction);
    // Positive control: it was an evaluable active plan before replacement.
    assert.equal((await wallet.call("evaluate", oldPlan)).decision, "deny");

    stage = "publish-v2";
    const second = await publish();
    assert.equal(JSON.parse(second.payload).sequence, 2);
    assert.equal((await client.read(1)).status, 2);
    await refresh(second, 2);
    await reject("evaluate", oldPlan, "superseded-active-plan");
    await reject("acceptEnvelope", first, "superseded-envelope");
    await assertDeny("updated-consumer-deny");
    const outagePlan = await wallet.call("prepare", transaction);
    assert.equal((await wallet.call("evaluate", outagePlan)).decision, "deny");

    stage = "socket-outage";
    await disconnect();
    const outageStarted = Date.now();
    // This is a real elapsed confirmation deadline, not a fake adapter clock.
    await sleep(confirmationWindowMs + 100);
    await reject("evaluate", outagePlan, "confirmation-deadline-expired");
    await reject("prepare", transaction, "no-new-plan-after-confirmation-deadline");
    record("outage-deadline", { configuredMs: confirmationWindowMs, elapsedMs: Date.now() - outageStarted,
      mechanism: "loopback listening socket closed; no synthetic RPC responses" });
    await wallet.close();
    wallet = await startConsumer(directory, consumerConfig, (text) => t.diagnostic(text));
    await wallet.call("start");
    await reject("acceptEnvelope", first, "cold-offline-replay-v1");
    await reject("prepare", transaction, "cold-offline-no-confirmation");
    await wallet.close();
    await new Promise((yes, no) => { proxy.once("error", no); proxy.listen(port, "127.0.0.1", yes); });
    wallet = await startConsumer(directory, consumerConfig, (text) => t.diagnostic(text));
    await wallet.call("start");
    await refresh(second, 2);
    await reject("acceptEnvelope", first, "cold-online-superseded-replay");
    await assertDeny("cold-online-v2-deny");
    const revokedPlan = await wallet.call("prepare", transaction);
    assert.equal((await wallet.call("evaluate", revokedPlan)).decision, "deny");

    stage = "revoke-v2";
    await send(registry, calldata("revoke(bytes32,uint256)", tool.scopeId(config), 2));
    assert.equal((await client.read()).head, 2);
    assert.equal((await client.read()).status, 3);
    await sleep(confirmationWindowMs + 100);
    await reject("refresh", undefined, "revoked-refresh");
    await reject("evaluate", revokedPlan, "revoked-active-plan");
    await reject("prepare", transaction, "revoked-no-new-plan");
    await wallet.close();
    wallet = await startConsumer(directory, consumerConfig, (text) => t.diagnostic(text));
    await wallet.call("start");
    await reject("refresh", undefined, "cold-revoked-head");
    await reject("acceptEnvelope", second, "cold-revoked-envelope");
    await reject("acceptEnvelope", first, "cold-no-fallback-to-v1");
    await reject("prepare", transaction, "cold-revoked-no-plan");
    assert.deepEqual((await wallet.call("audit")).blocked, []);
    assert.deepEqual(violations, [], "consumer violated read-only registry network boundary");
    assert.ok(reads.filter((call) => call.method === "eth_call").length >= 4);
    await wallet.close();
    record("acceptance-result", { outcome: "PASS", candidate, nodeVersion,
      transport: "real-local-chain", registryReads: reads.length,
      independentWalletSha256: hash(walletBytes), review: "pending-independent-dambi-review; test success is not approval" });
  } catch (error) {
    record("acceptance-result", { outcome: "FAIL", stage, error: error.message,
      review: "not-approved; retain reproduction and logs for existing team review" });
    throw error;
  }
});
