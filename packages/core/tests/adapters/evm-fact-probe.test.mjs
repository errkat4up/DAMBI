import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Run the real manual command against a loopback fixture, never a public RPC.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = join(root, "scripts/sdk/verify-evm-fact.mjs");
const OWNER = "0x000000000000000000000000000000000000dead";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SECRET = "fixture-only-private-rpc-detail";
const options = { timeout: 30_000 };

async function endpoint(t, mode = "success") {
  const requests = [];
  const errors = [];
  let balanceReads = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(rpc);
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
      assert.equal(req.url, `/rpc/${SECRET}?key=${SECRET}`);
      assert.ok(["eth_chainId", "eth_blockNumber", "eth_call"].includes(rpc.method));
      let result;
      if (rpc.method === "eth_chainId") result = "0x1";
      else if (rpc.method === "eth_blockNumber") result = "0x1312d00";
      else {
        balanceReads++;
        assert.deepEqual(rpc.params, [{
          to: TOKEN, data: `0x70a08231${OWNER.slice(2).padStart(64, "0")}`,
        }, "0x1312d00"]);
        if (mode === "missing") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: SECRET } }));
          return;
        }
        result = `0x${(mode === "mismatch" && balanceReads === 2 ? "65" : "64").padStart(64, "0")}`;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, [], "local RPC assertions must succeed");
  });
  return { requests, config: {
    chainId: "eip155:1", owner: OWNER, token: TOKEN,
    rpcUrl: `http://127.0.0.1:${server.address().port}/rpc/${SECRET}?key=${SECRET}`,
    headers: { authorization: `Bearer ${SECRET}` }, maxResponseBytes: 16_384, timeoutMs: 15_000,
  } };
}

async function probe(t, config) {
  const directory = await mkdtemp(join(tmpdir(), "dambi-fact-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "rpc.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [script, "--config", path], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [exitCode, signal] = await exit;
  assert.equal(signal, null);
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), "reports must not expose endpoint credentials or remote errors");
  return { exitCode, report: JSON.parse(stdout) };
}

test("manual Fact probe verifies Core and same-block RPC balance while marking loopback and hiding credentials", options, async (t) => {
  const state = await endpoint(t);
  const { exitCode, report } = await probe(t, state.config);
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report.status, "passed");
  assert.equal(report.connection, "loopback-fixture");
  assert.equal(report.policySource, "local-test-fixture");
  assert.equal(report.decision, "warn");
  assert.equal(report.matchedPolicy, "transfer-full-balance-sweep");
  assert.equal(report.fact.chainId, "eip155:1");
  assert.equal(report.fact.balance, "0x64");
  assert.equal(report.fact.blockNumber, "20000000");
  assert.equal(report.fact.source, "onchain:eip155:1:eth_call");
  assert.ok(Number.isSafeInteger(report.fact.observedAt));
  assert.deepEqual(report.rpc, {
    adapter: { eth_chainId: 1, eth_blockNumber: 1, eth_call: 1 },
    comparison: { eth_chainId: 1, eth_call: 1 },
  });
  assert.equal(state.requests.length, 5);
});

test("manual Fact probe fails on a same-block mismatch and rejects invalid local config before I/O", options, async (t) => {
  const state = await endpoint(t, "mismatch");
  const mismatch = await probe(t, state.config);
  assert.equal(mismatch.exitCode, 1);
  assert.equal(mismatch.report.status, "failed");
  assert.equal(mismatch.report.error.code, "RPC_COMPARISON_FAILED");
  const before = state.requests.length;
  const invalid = await probe(t, { ...state.config, owner: `${OWNER}\n` });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.report.status, "failed");
  assert.equal(invalid.report.error.code, "INVALID_CONFIG");
  assert.equal(state.requests.length, before);
});

test("an optional-policy allow with no observed Fact cannot count as a passed live probe", options, async (t) => {
  const state = await endpoint(t, "missing");
  const { exitCode, report } = await probe(t, state.config);
  assert.equal(exitCode, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.error.code, "FACT_CHECK_FAILED");
  assert.equal(state.requests.length, 3);
});
