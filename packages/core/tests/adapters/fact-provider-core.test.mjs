import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { CoreError, createCore } from "@dambi/core";
import { createEvmFactProvider } from "@dambi/core/adapters";
import { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";
import { createBalancePolicyFixture, makeTransferRequest } from "../../../../scripts/sdk/balance-policy-fixture.mjs";

// Real package WASM and Registry snapshot with local HTTP RPC responses. This
// suite never builds artifacts or contacts a live RPC or policy publisher.
const NOW = 1_800_000_000_000;
const OWNER = "0x000000000000000000000000000000000000aaaa";
const OTHER_OWNER = "0x000000000000000000000000000000000000cccc";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MAX_U256 = (1n << 256n) - 1n;
const options = { timeout: 20_000 };
const request = (amount = 100n, owner = OWNER) => makeTransferRequest({ owner, token: TOKEN, amount });
const word = (value) => `0x${value.toString(16).padStart(64, "0")}`;

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function reply(res, rpc, result) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
}

async function endpoint(t) {
  const errors = [];
  const state = { requests: [], mode: "balance", balance: 100n, block: 20_000_000n, onBalance: undefined };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.requests.push(rpc);
      assert.equal(req.method, "POST");
      if (state.mode === "outage") {
        res.writeHead(503);
        return res.end("unavailable");
      }
      if (rpc.method === "eth_chainId") return reply(res, rpc, "0x1");
      if (rpc.method === "eth_blockNumber") return reply(res, rpc, `0x${state.block.toString(16)}`);
      assert.equal(rpc.method, "eth_call");
      if (state.onBalance) return state.onBalance(rpc, res);
      if (state.mode === "revert") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "execution reverted" } }));
      }
      reply(res, rpc, word(state.balance));
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
    assert.deepEqual(errors, [], "local RPC handler assertions must succeed");
  });
  state.rpcUrl = `http://127.0.0.1:${server.address().port}`;
  return state;
}

function provider(state, clock = { now: () => NOW }) {
  return createEvmFactProvider({ chains: { "eip155:1": { rpcUrl: state.rpcUrl } }, maxResponseBytes: 4_096, clock });
}

async function open(t, fact, { required = false, clock = { now: () => NOW }, limits = {} } = {}) {
  const fixture = await createBalancePolicyFixture({ now: clock.now(), required });
  const core = await createCore({
    decoderSnapshot, trust: fixture.trust, enforcement: "advisory", clock,
    limits: {
      allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: decoderSnapshotInfo.bytes,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
      planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
      factTimeoutMs: 5_000, policyTimeoutMs: 1_000, ...limits,
    },
    ports: { policy: { fetch: async () => fixture.policy }, fact },
  });
  t.after(() => core.dispose());
  return { core, policyId: fixture.policyId };
}

function sweep(verdict, policyId) {
  assert.equal(verdict.decision, "warn");
  assert.equal(verdict.source, "evaluated");
  assert.ok(verdict.reasons.some((reason) => reason.policyId === policyId));
}

function failClosed(verdict, diagnostic) {
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.source, "fail_closed");
  assert.ok(verdict.diagnostics.some(({ code }) => code === diagnostic), JSON.stringify(verdict));
}

test("packaged transfer plans reach HTTP balanceOf and project full U256 Facts once in WASM", options, async (t) => {
  const state = await endpoint(t);
  const fact = provider(state);
  const { core, policyId } = await open(t, fact);
  for (const amount of [100n, MAX_U256]) {
    state.balance = amount;
    const plan = await core.plan(request(amount));
    assert.equal(plan.calls.length, 1);
    const call = plan.calls[0];
    assert.equal(call.manifestId, "transfer-full-balance-sweep");
    assert.equal(call.method, "portfolio.balance");
    assert.equal(call.optional, true);
    assert.equal(call.params.chain_id, "eip155:1");
    assert.equal(call.params.owner, OWNER);
    assert.deepEqual(call.params.asset.key, { standard: "erc20", chain: "eip155:1", address: TOKEN });
    const batch = await fact.fetch(plan.calls, { planId: plan.planId });
    assert.equal(batch.planId, plan.planId);
    assert.deepEqual(Object.keys(batch.results), [call.callId]);
    const result = {
      value: { balance: `0x${amount.toString(16)}` }, source: "onchain:eip155:1:eth_call",
      blockNumber: "20000000", observedAt: NOW,
    };
    assert.deepEqual(batch.results[call.callId], result);
    assert.deepEqual(state.requests.at(-1).params, [{
      to: TOKEN, data: `0x70a08231${OWNER.slice(2).padStart(64, "0")}`,
    }, "0x1312d00"]);
    const verdict = core.evaluate(plan, batch);
    sweep(verdict, policyId);
    assert.deepEqual(verdict.facts, [result]);
  }
  assert.deepEqual(state.requests.map(({ method }) => method), [
    "eth_chainId", "eth_blockNumber", "eth_call", "eth_chainId", "eth_blockNumber", "eth_call",
  ]);
});

test("Core keeps catalog Facts optional, fails closed for required Facts and never caches omissions or outages", options, async (t) => {
  const state = await endpoint(t);
  const fact = provider(state);
  const optional = await open(t, fact);
  const required = await open(t, fact, { required: true });
  assert.equal(optional.policyId, "transfer-full-balance-sweep");
  assert.equal(required.policyId, "adapter-required-balance");

  state.mode = "revert";
  const skipped = await optional.core.check(request());
  assert.equal(skipped.decision, "allow");
  assert.equal(skipped.source, "evaluated");
  assert.deepEqual(skipped.facts, []);
  failClosed(await required.core.check(request()), "required_fact_missing");

  state.mode = "outage";
  failClosed(await required.core.check(request()), "fact_fetch_failed");
  state.mode = "balance";
  const before = state.requests.length;
  sweep(await optional.core.check(request()), optional.policyId);
  sweep(await required.core.check(request()), required.policyId);
  assert.equal(state.requests.length, before + 6, "omissions and rejected fetches must not seed either Core cache");
});

test("Core check cache preserves RPC observation and block until freshness expiry triggers a new pinned read", options, async (t) => {
  const state = await endpoint(t);
  let now = NOW;
  const clock = { now: () => now };
  const { core, policyId } = await open(t, provider(state, clock), { required: true, clock });
  const first = await core.check(request());
  sweep(first, policyId);
  assert.deepEqual(first.facts, [{
    value: { balance: "0x64" }, source: "onchain:eip155:1:eth_call", observedAt: NOW, blockNumber: "20000000",
  }]);
  now += 29_999;
  state.balance = 101n;
  state.block++;
  const cached = await core.check(request());
  sweep(cached, policyId);
  assert.deepEqual(cached.facts, first.facts);
  assert.equal(state.requests.length, 3, "cache hits issue no chain, block or balance request");
  now += 2;
  const fresh = await core.check(request());
  assert.equal(fresh.decision, "allow");
  assert.equal(fresh.source, "evaluated");
  assert.deepEqual(fresh.facts, [{
    value: { balance: "0x65" }, source: "onchain:eip155:1:eth_call", observedAt: now, blockNumber: "20000001",
  }]);
  assert.equal(state.requests.length, 6);
  assert.equal(state.requests.at(-1).params[1], "0x1312d01");
});

test("Core timeout, abort and disposal close pending RPC work while another Core shares the provider", options, async (t) => {
  const state = await endpoint(t);
  const fact = provider(state);
  for (const reason of ["timeout", "aborted", "disposed"]) {
    const active = await open(t, fact, { required: true, limits: { factTimeoutMs: reason === "timeout" ? 500 : 5_000 } });
    const independent = await open(t, fact, { required: true });
    const started = deferred();
    const closed = deferred();
    state.onBalance = (rpc, res) => {
      if (rpc.params[0].data.endsWith(OWNER.slice(2))) {
        res.on("close", () => closed.resolve());
        started.resolve();
      } else reply(res, rpc, word(100n));
    };
    const controller = new AbortController();
    const checking = active.core.check(request(), { signal: controller.signal });
    // Attach disposal rejection handling immediately, before another await.
    const disposal = reason === "disposed" ? assert.rejects(checking,
      (error) => error instanceof CoreError && error.code === "DISPOSED") : undefined;
    await started.promise;
    const other = independent.core.check(request(100n, OTHER_OWNER));
    if (reason === "aborted") controller.abort();
    if (reason === "disposed") active.core.dispose();
    if (disposal) await disposal;
    else failClosed(await checking, reason);
    await closed.promise;
    sweep(await other, independent.policyId);
    state.onBalance = undefined;
    if (reason !== "disposed") {
      const before = state.requests.length;
      sweep(await active.core.check(request()), active.policyId);
      assert.equal(state.requests.length, before + 3, "cancelled work cannot fill the active Core's cache");
    }
  }
});
