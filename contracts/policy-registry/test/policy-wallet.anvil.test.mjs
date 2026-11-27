import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Linux acceptance entry point; requires bubblewrap (bwrap) with user/network
// namespaces enabled, Node, pinned Foundry, and registryV2's installed dependencies.
// Missing tools, namespace support, pins or built artifacts FAIL, never skip.
// In an offline build environment, build the candidate @dambi/core first, then:
//   forge build --root contracts/policy-registry
//   anvil --host 127.0.0.1 --port 8545 --chain-id 31337
//   DAMBI_TEST_RPC_URL=http://127.0.0.1:8545 \
//   DAMBI_TEST_CANDIDATE_SHA=<full-candidate-HEAD> \
//   DAMBI_TEST_TOOL_VERSIONS='<pinned-JSON>' \
//   node --test contracts/policy-registry/test/policy-wallet.anvil.test.mjs
// Pin JSON has exact strings: node (process.version), forge/cast (complete trimmed
// --version output), and anvilClient (web3_clientVersion). Supply approved pins,
// not values automatically discovered by this test. Do not fork or forward a chain.
// DAMBI_TEST_CORE_TARBALL optionally selects a prebuilt tarball; its bytes must
// match an offline npm pack of this clean candidate's compiled workspace.
// npm installation is offline and ignores scripts. No registry download is needed.
// The SDK runs only in a separate, empty-network-namespace process. Its sole RPC
// capability is a framed stdio fetch relay to the designated reader proxy. Native
// sockets, DNS, workers and subprocesses inherit the empty network namespace;
// host /run, /tmp and home directories and their Unix sockets are not mounted.
// This is NOT a fake RPC: the relay forwards reads to the real deployed registry.
// Preserve full TAP/stdout/stderr plus the build/Anvil launch commands for QA and
// the existing dambi-review path. Runtime logs are not independent review approval.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const registryRequire = createRequire(new URL("../../../registryV2/package.json", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (exe, args, cwd = root) => {
  console.log(JSON.stringify({ kind: "local-wallet-command", exe, args, cwd }));
  return execFileSync(exe, args, { cwd, encoding: "utf8", timeout: 60_000 }).trim();
};

async function installWallet(t) {
  const candidate = process.env.DAMBI_TEST_CANDIDATE_SHA;
  assert.match(candidate ?? "", /^[0-9a-f]{40}$/, "supply the full candidate HEAD");
  assert.equal(command("git", ["rev-parse", "HEAD"]), candidate);
  command("git", ["diff", "--exit-code", "HEAD", "--"], root);
  const dir = await mkdtemp(join(tmpdir(), "policy-wallet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [packed] = JSON.parse(command("npm", ["pack", "--json", "--offline", "--ignore-scripts",
    "--pack-destination", dir], join(root, "packages/core")));
  const workspaceBytes = await readFile(join(dir, packed.filename));
  const tarball = process.env.DAMBI_TEST_CORE_TARBALL || join(dir, packed.filename);
  const bytes = await readFile(tarball);
  assert.equal(sha256(bytes), sha256(workspaceBytes), "supplied package must match this candidate workspace pack");
  // Install the bytes we checked, not a mutable external path.
  const selected = join(dir, "selected.tgz");
  await writeFile(selected, bytes);
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", selected], dir);
  const entry = join(dir, "consumer.mjs");
  await writeFile(entry, 'export { createCore, CoreError } from "@dambi/core";\n'
    + 'export { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";\n'
    + 'export { createOnchainPolicySource } from "@dambi/core/adapters";\n');
  const installed = JSON.parse(await readFile(join(dir, "node_modules/@dambi/core/package.json"), "utf8"));
  assert.equal(installed.name, "@dambi/core");
  t.diagnostic(JSON.stringify({ kind: "candidate-package-binding", candidate,
    tarballSha256: sha256(bytes), workspacePackSha256: sha256(workspaceBytes),
    packageVersion: installed.version, trackedTree: "clean",
    packageSource: process.env.DAMBI_TEST_CORE_TARBALL ? "supplied" : "workspace-pack",
    provenance: "byte equality to compiled candidate workspace; retain the separate build log" }));
  // Never import the SDK in the publisher/test process.
  return dir;
}

// Serialized into the installed wallet directory. All SDK imports and all Core,
// WASM and adapter operations happen inside bubblewrap, after isolation probes.
async function walletProcess() {
  const { default: assert } = await import("node:assert/strict");
  const { createInterface } = await import("node:readline");
  const { readlink, readFile } = await import("node:fs/promises");
  const { request } = await import("node:http");
  const [rpcUrl, parentNet] = process.argv.slice(2);
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const pending = new Map();
  const objects = new Map();
  const violations = [];
  let fetchId = 0;
  let objectId = 0;
  let now = 0;
  let probing = true;
  let sdk;
  const clock = { now: () => now };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line);
      if (message.kind === "fetch-result") {
        const waiter = pending.get(message.id);
        if (!waiter) return; // An aborted request cannot publish a late response.
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(new Response(message.text, { status: message.status }));
        return;
      }
      const { id, method, args } = message;
      try {
        assert.ok(sdk, "SDK must not execute before isolation probes");
        now = message.now;
        let value;
        if (method === "source") {
          const source = sdk.createOnchainPolicySource({ ...args, clock });
          value = ++objectId;
          objects.set(value, source);
        } else if (method === "wallet") {
          const core = await sdk.createCore({ ...args.config, clock,
            decoderSnapshot: sdk.decoderSnapshot,
            ports: { policy: objects.get(args.source), fact: {
              async fetch() { assert.fail("burn transfer requires no Facts"); },
            } },
          });
          value = ++objectId;
          objects.set(value, core);
        } else if (method === "finish") {
          assert.deepEqual(violations, [], "SDK attempted a forbidden fetch/fallback");
          for (const object of objects.values()) object.dispose?.();
          value = { violations, isolation: "empty-network-namespace + exact-URL stdio relay" };
        } else {
          assert.ok(["fetch", "check", "plan", "evaluate", "refreshPolicies", "dispose"].includes(method));
          const object = objects.get(args.handle);
          assert.ok(object, "unknown consumer handle");
          value = await object[method](...args.values);
          if (method === "dispose") objects.delete(args.handle);
        }
        emit({ kind: "result", id, value });
      } catch (error) {
        emit({ kind: "result", id, error: { message: String(error), code: error.code,
          coreError: !!sdk && error instanceof sdk.CoreError } });
      }
    })().catch((error) => { console.error(error); process.exit(1); });
  });

  // No real socket is granted to the SDK. Even another HTTP implementation,
  // DNS, a worker or a subprocess cannot bypass the kernel network namespace.
  // This one fetch capability transports ONLY the exact designated proxy URL.
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== rpcUrl || init.method !== "POST" || init.redirect !== "error"
        || typeof init.body !== "string") {
      const attempt = { url, method: init.method ?? "GET" };
      if (!probing) violations.push(attempt);
      throw Object.assign(new Error("wallet egress denied"), { code: "DAMBI_EGRESS_DENIED" });
    }
    const id = ++fetchId;
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (init.signal?.aborted) return abort();
      const cleanup = () => init.signal?.removeEventListener("abort", abort);
      pending.set(id, {
        resolve(value) { cleanup(); resolve(value); },
        reject(error) { cleanup(); reject(error); },
      });
      init.signal?.addEventListener("abort", abort, { once: true });
      emit({ kind: "fetch", id, url, body: init.body });
    });
  };

  const namespace = await readlink("/proc/self/ns/net");
  assert.notEqual(namespace, parentNet, "consumer must have a separate network namespace");
  const routes = await readFile("/proc/net/route", "utf8");
  assert.ok(!routes.split("\n").slice(1).some((line) => line.trim().split(/\s+/)[1] === "00000000"),
    "consumer must have no default route");
  const negative = [];
  // These names are never resolved: rejection must be our explicit guard, not
  // ENOTFOUND or an unavailable real service masquerading as isolation.
  for (const [service, url] of [
    ["policy-api", "https://policy-api.invalid/v1/bundle"],
    ["indexer", "https://indexer.invalid/graphql"],
    ["external-rpc", "https://rpc.invalid/"],
    ["proxy-policy-path", new URL("/v1/bundle", rpcUrl).href],
  ]) {
    await assert.rejects(fetch(url, { method: "POST", redirect: "error", body: "{}" }),
      { code: "DAMBI_EGRESS_DENIED" });
    negative.push({ service, outcome: "DAMBI_EGRESS_DENIED" });
  }
  // Bypass fetch entirely. This proxy is listening on the parent's loopback,
  // but cannot be reached through a native socket in the consumer namespace.
  // Only loopback is probed; no external packet or DNS request is attempted.
  await assert.rejects(new Promise((resolve, reject) => {
    const req = request(rpcUrl, { method: "POST", timeout: 2000 }, (res) => {
      res.resume();
      resolve();
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("native isolation probe timed out")));
    req.end("{}");
  }), { code: "ECONNREFUSED" });
  negative.push({ service: "native-http-bypass-to-host-loopback", outcome: "ECONNREFUSED" });
  probing = false;
  sdk = await import("./consumer.mjs");
  emit({ kind: "ready", decoderSnapshotInfo: sdk.decoderSnapshotInfo,
    isolation: { namespace, parentNet, defaultRoute: false, negative } });
}

async function startWallet(t, dir, proxy, getNow) {
  assert.equal(process.platform, "linux", "this acceptance gate requires Linux network namespaces");
  const script = join(dir, "isolated-wallet.mjs");
  await writeFile(script, `(${walletProcess.toString()})().catch(error => { console.error(error); process.exit(1); });\n`);
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp"];
  // Only runtime libraries/binaries and this fresh installation are visible.
  // In particular, do not ro-bind the host root (it exposes host Unix sockets).
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", process.execPath, "/node", "--ro-bind", dir, "/wallet",
    "--chdir", "/wallet", "/node", "/wallet/isolated-wallet.mjs", proxy.url,
    await readlink("/proc/self/ns/net"));
  t.diagnostic(JSON.stringify({ kind: "consumer-isolation-command", exe: "bwrap", args,
    env: {}, inheritedDescriptors: ["stdin-pipe", "stdout-pipe", "stderr-pipe"] }));
  const child = spawn("bwrap", args, { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  // The executable lookup must not depend on an inherited PATH in the child.
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  let closed = false;
  let failure;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error) => {
    failure ??= error;
    readyReject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const exit = new Promise((resolve) => child.once("close", (code, signal) => {
    closed = true;
    fail(new Error(`isolated wallet exited: code=${code} signal=${signal}`));
    resolve({ code, signal });
  }));
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (bytes) => t.diagnostic(JSON.stringify({ kind: "consumer-stderr", text: bytes.toString() })));
  const startup = setTimeout(() => fail(new Error("isolated wallet startup timeout")), 15_000);
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line);
      if (message.kind === "ready") {
        clearTimeout(startup);
        t.diagnostic(JSON.stringify({ kind: "consumer-isolation-probes", ...message.isolation }));
        readyResolve(message);
      } else if (message.kind === "fetch") {
        // Never become an arbitrary URL forwarding service, even if the
        // consumer guard regresses. readerProxy additionally restricts RPC.
        assert.equal(message.url, proxy.url);
        assert.equal(typeof message.body, "string");
        try {
          const response = await fetch(proxy.url, { method: "POST", redirect: "error",
            headers: { "content-type": "application/json" }, body: message.body,
            signal: AbortSignal.timeout(5000) });
          const text = await response.text();
          assert.ok(Buffer.byteLength(text) <= 2_000_000);
          if (!closed) send({ kind: "fetch-result", id: message.id, status: response.status, text });
        } catch {
          if (!closed) send({ kind: "fetch-result", id: message.id, error: "local RPC relay unavailable" });
        }
      } else {
        assert.equal(message.kind, "result");
        const entry = pending.get(message.id);
        assert.ok(entry, "unexpected consumer response");
        pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
        else entry.resolve(message.value);
      }
    })().catch(fail);
  });
  t.after(async () => {
    clearTimeout(startup);
    if (!closed) child.kill("SIGKILL");
    await exit;
    lines.close();
  });
  const info = await ready;
  const call = (method, args = {}) => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error(`consumer command timeout: ${method}`));
      }, 15_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      send({ kind: "command", id, method, args, now: getNow() });
    });
  };
  const invoke = async (handle, method, values = []) => call(method, { handle: await handle, values });
  const handles = [];
  // These are RPC handles, not SDK replacements. All input validation, policy
// evaluation and error classification occurs in the installed SDK process.
  const sdk = {
    decoderSnapshotInfo: info.decoderSnapshotInfo,
    createOnchainPolicySource(options) {
      const { clock: _clock, ...config } = options;
      const handle = call("source", config);
      return { handle, fetch: () => invoke(handle, "fetch") };
    },
    async createCore(options) {
      const { ports, clock: _clock, decoderSnapshot: _snapshot, ...config } = options;
      const handle = await call("wallet", { config, source: await ports.policy.handle });
      let disposed = false;
      const wallet = {};
      for (const method of ["check", "plan", "evaluate", "refreshPolicies"]) {
        wallet[method] = (...values) => invoke(handle, method, values);
      }
      wallet.dispose = async () => {
        if (!disposed) { disposed = true; await invoke(handle, "dispose"); }
      };
      handles.push(wallet);
      return wallet;
    },
    async finish() {
      for (const wallet of handles) await wallet.dispose();
      const result = await call("finish");
      t.diagnostic(JSON.stringify({ kind: "consumer-egress-final", ...result }));
      child.stdin.end();
      // readline no longer holds the child open once stdin reaches EOF.
      const status = await exit;
      assert.equal(status.code, 0);
      assert.equal(status.signal, null);
    },
  };
  return sdk;
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
  assert.ok(process.env.DAMBI_TEST_TOOL_VERSIONS, "supply approved exact tool-version pins");
  const pins = JSON.parse(process.env.DAMBI_TEST_TOOL_VERSIONS);
  for (const name of ["node", "forge", "cast", "anvilClient"]) {
    assert.equal(typeof pins[name], "string", `missing version pin: ${name}`);
    assert.ok(pins[name].length > 0);
  }
  assert.equal(process.version, pins.node, "Node pin mismatch");
  assert.equal(command("forge", ["--version"]), pins.forge, "Forge pin mismatch");
  assert.equal(command("cast", ["--version"]), pins.cast, "cast pin mismatch");
  t.diagnostic(JSON.stringify({ kind: "local-node-run-inputs", pins,
    invocation: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    rpcUrl: endpoint.href, review: "pending independent dambi-review; not conferred by this test" }));
  const installation = await installWallet(t);
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
  assert.equal(version, pins.anvilClient, "running Anvil version must match its approved pin");
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
    t.diagnostic(JSON.stringify({ kind: "local-node-receipt", receipt,
      finalized: { number: head.number, hash: head.hash, timestamp: head.timestamp },
      canonical: true }));
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
    t.diagnostic(JSON.stringify({ kind: "local-node-publication", sequence: JSON.parse(intent.signed.payload).sequence,
      payloadSha256: sha256(Buffer.from(intent.signed.payload)), outcome }));
    return intent.signed;
  }

  const signedV1 = await publish();
  const proxy = await readerProxy(t, endpoint, registry);
  const sdk = await startWallet(t, installation, proxy, () => now);
  assert.equal(proxy.count(), 0, "native isolation probe must not reach the host proxy");
  assert.deepEqual(proxy.violations, []);
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
  async function rejectedPlan(wallet, plan) {
    assert.ok(plan.expiresAt > now, "pending handle remains within its own TTL");
    const result = await wallet.evaluate(plan, { planId: plan.planId, results: {} });
    assert.equal(result.source, "fail_closed");
    assert.equal(result.decision, "deny");
    const diagnostics = result.diagnostics.map((item) => item.code);
    assert.ok(diagnostics.includes("trust_expired"));
    t.diagnostic(JSON.stringify({ source: result.source, decision: result.decision, diagnostics }));
  }
  const code = (expected) => (error) => {
    // coreError is set by `instanceof sdk.CoreError` INSIDE the consumer;
    // transport errors/timeouts cannot masquerade as expected product failures.
    assert.equal(error.coreError, true);
    assert.equal(error.code, expected);
    t.diagnostic(JSON.stringify({ kind: "consumer-expected-rejection", code: error.code, now }));
    return true;
  };
  async function sameBytes(source, signed, generation) {
    const observed = await source.fetch();
    assert.equal(observed.payload, signed.payload);
    assert.equal(observed.signature, signed.signature);
    assert.equal(observed.keyId, signed.key_id);
    assert.equal(observed.registryState.version, generation);
    t.diagnostic(JSON.stringify({ kind: "consumer-original-bytes", generation,
      payloadSha256: sha256(Buffer.from(observed.payload)),
      signatureSha256: sha256(Buffer.from(observed.signature, "base64")),
      registryState: observed.registryState }));
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
  await rejectedPlan(wallet, v1Plan);
  await deny(wallet, 2);
  const v2Plan = await wallet.plan(request);
  const observedAt = now;

  t.diagnostic(JSON.stringify({ kind: "consumer-outage", observedAt, maxStateAgeMs,
    confirmationDeadline: observedAt + maxStateAgeMs, clock: "controlled Unix milliseconds" }));
  await proxy.disconnect();
  await assert.rejects(wallet.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  await assert.rejects(openWallet(), code("POLICY_FETCH_FAILED"));
  now = observedAt + maxStateAgeMs - 1;
  await deny(wallet, 2);
  now++;
  await assert.rejects(wallet.plan(request), code("POLICY_EXPIRED"));
  await rejectedPlan(wallet, v2Plan);

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
  try { await deny(fresh, 2); } finally { await fresh.dispose(); }
  const beforeRevocation = await wallet.plan(request);
  await send(command("cast", ["calldata", "revoke(bytes32,uint256)", publisher.scopeId(config), "2"]), registry);
  await wallet.refreshPolicies();
  await rejectedPlan(wallet, beforeRevocation);
  await assert.rejects(wallet.plan(request), code("POLICY_EXPIRED"));
  const readCount = proxy.count();
  await assert.rejects(openWallet(), code("POLICY_EXPIRED"));
  assert.ok(proxy.count() > readCount, "a fresh consumer reads the revoked head instead of selecting v1");
  assert.deepEqual(proxy.violations, []);
  await sdk.finish();
  t.diagnostic(JSON.stringify({ kind: "local-node-wallet-acceptance", outcome: "passed",
    rpcReads: proxy.count(), fakeRpc: false,
    cases: ["isolated-consumer-negative-egress", "publish-original-bytes-deny-v1",
      "replace-reject-v1-plan-deny-v2", "outage-before-and-at-deadline",
      "fresh-instance-requires-RPC", "recovery-fresh-v2", "revoke-reject-active-plan",
      "fresh-instance-rejects-revoked-head-no-v1-fallback"],
    review: "pending independent dambi-review; retain complete TAP and Anvil logs" }));
});
