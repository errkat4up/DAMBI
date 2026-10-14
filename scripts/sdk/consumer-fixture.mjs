import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createBalancePolicyFixture } from "./balance-policy-fixture.mjs";

// The signing key stays in this Node fixture. Browsers receive only signed
// policy wrappers and the public trust key, never the private key.
const fixtures = new URL("../../crates/dambi-core/tests/fixtures/policy-bundle/", import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
const word = (value) => `0x${value.toString(16).padStart(64, "0")}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function observed(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server, origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function createConsumerFixture() {
  const now = Date.now();
  const [initial, keys, optional, required] = await Promise.all([
    json("day1.envelope.json"), json("test-only-keys.json"),
    createBalancePolicyFixture({ now }), createBalancePolicyFixture({ now, required: true }),
  ]);
  assert.equal(keys.test_only, true);
  const payload = JSON.stringify({ ...JSON.parse(initial.payload), issued_at: Math.floor(now / 1_000), expires_at: null });
  const day1 = {
    payload, keyId: keys.policy.key_id,
    signature: sign("sha256", Buffer.from(payload), {
      key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
    }).toString("base64"),
  };
  const policies = { day1, optional: optional.policy, required: required.policy };
  const errors = [];
  let browserOrigin;
  let state;
  let hold;
  let nextHold = 0;
  const reset = (options = {}) => {
    assert.ok(!hold || hold.closed, "Finish held HTTP requests before resetting the fixture");
    hold = undefined;
    state = {
      policy: "day1", exposeEtag: true, policyCors: true, rpcCors: true,
      rpcMode: "balance", policyRequests: [], rpcRequests: [], preflights: [], ...options,
    };
    assert.ok(Object.hasOwn(policies, state.policy));
  };
  reset();

  function cors(req, res, kind) {
    if (state[`${kind}Cors`] && browserOrigin) {
      res.setHeader("Access-Control-Allow-Origin", browserOrigin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method !== "OPTIONS") return false;
    state.preflights.push({ kind, headers: req.headers["access-control-request-headers"] ?? "" });
    if (state[`${kind}Cors`]) {
      res.setHeader("Access-Control-Allow-Methods", kind === "policy" ? "GET" : "POST");
      res.setHeader("Access-Control-Allow-Headers", kind === "policy" ? "If-None-Match" : "Content-Type");
      res.setHeader("Access-Control-Max-Age", "0");
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  const policy = await listen((req, res) => {
    try {
      if (cors(req, res, "policy")) return;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/bundle?profile=default");
      const etag = `"consumer-${state.policy}"`;
      const conditional = req.headers["if-none-match"] ?? null;
      const status = conditional === etag ? 304 : 200;
      state.policyRequests.push({ conditional, status });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("ETag", etag);
      if (state.exposeEtag) res.setHeader("Access-Control-Expose-Headers", "ETag");
      res.writeHead(status);
      const envelope = policies[state.policy];
      res.end(status === 200 ? JSON.stringify({ payload: envelope.payload, signature: envelope.signature, key_id: envelope.keyId }) : undefined);
    } catch (error) { errors.push(error); res.destroy(); }
  });
  let rpc;
  try {
    rpc = await listen(async (req, res) => {
      try {
        if (cors(req, res, "rpc")) return;
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/rpc");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.rpcRequests.push(call);
        if (state.rpcMode === "outage") { res.writeHead(503); res.end(); return; }
        const reply = (body) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...body }));
        };
        if (call.method === "eth_chainId") return reply({ result: "0x1" });
        if (call.method === "eth_blockNumber") return reply({ result: "0x1312d00" });
        assert.equal(call.method, "eth_call");
        assert.deepEqual(call.params, [{
          to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          data: `0x70a08231${"aaaa".padStart(64, "0")}`,
        }, "0x1312d00"]);
        if (hold && !hold.started) {
          const pending = hold;
          pending.started = true;
          res.once("close", () => { pending.closed = true; pending.closedEvent.resolve(); });
          pending.startedEvent.resolve();
          return;
        }
        if (state.rpcMode === "revert") return reply({ error: { code: -32000, message: "fixture revert" } });
        reply({ result: word(100n) });
      } catch (error) { errors.push(error); res.destroy(); }
    });
  } catch (error) { await policy.close(); throw error; }

  return {
    origins: [policy.origin, rpc.origin],
    setBrowserOrigin(origin) { browserOrigin = origin; },
    settings: {
      policy: { baseUrl: policy.origin, maxResponseBytes: 1_500_000 },
      fact: { chains: { "eip155:1": { rpcUrl: `${rpc.origin}/rpc` } }, maxResponseBytes: 4_096 },
      trust: optional.trust, enforcement: "advisory",
      limits: {
        allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 5_000_000,
        maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
        planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
        factTimeoutMs: 5_000, policyTimeoutMs: 5_000,
      },
    },
    async control(action, value) {
      if (action === "reset") { reset(value); return; }
      if (action === "mode") { assert.ok(["balance", "revert", "outage"].includes(value)); state.rpcMode = value; return; }
      if (action === "inspect") return {
        policyRequests: state.policyRequests, rpcRequests: state.rpcRequests,
        preflights: state.preflights, errors: errors.map((error) => error.message),
      };
      if (action === "hold") {
        assert.ok(!hold || hold.closed);
        hold = { id: ++nextHold, started: false, closed: false, startedEvent: deferred(), closedEvent: deferred() };
        return hold.id;
      }
      if (action === "waitHeld" || action === "waitClosed") {
        assert.equal(value, hold?.id);
        await observed(action === "waitHeld" ? hold.startedEvent.promise : hold.closedEvent.promise,
          action === "waitHeld" ? "an actual pending eth_call" : "the cancelled HTTP connection to close");
        return;
      }
      throw new Error(`Unknown fixture action: ${action}`);
    },
    async close() {
      await Promise.all([policy.close(), rpc.close()]);
      assert.deepEqual(errors, [], "consumer fixture HTTP assertions must succeed");
    },
  };
}
