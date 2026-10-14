import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { AdapterError, createEvmFactProvider } from "@dambi/core/adapters";

const owner = "0x1111111111111111111111111111111111111111";
const token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const otherToken = "0x2222222222222222222222222222222222222222";
const maximumBalance = `0x${"f".repeat(64)}`;

function call(callId, chainId = "eip155:1", address = token) {
  return {
    manifestId: "transfer-full-balance-sweep", callId, method: "portfolio.balance",
    params: {
      chain_id: chainId, owner,
      asset: { key: { standard: "erc20", chain: chainId, address } },
    },
    outputs: [{ kind: "context", field: "balance", type: "String", from: "$.result.balance", required: false }],
    optional: true,
  };
}

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function result(res, request, value) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }));
}

function revert(res, request) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    error: { code: -32000, message: "private-token: endpoint revert", data: "private-token" } }));
}

function code(expectedCode, status) {
  return (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  };
}

async function rpcServer(t, handler) {
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await handler(request, req, res);
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, [], "local RPC handler assertions must succeed");
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function provider(rpcUrl, options = {}) {
  return createEvmFactProvider({ chains: { "eip155:1": { rpcUrl } }, maxResponseBytes: 4_096, ...options });
}

test("HTTP balance requests pin a block, preserve opaque IDs and snapshot inputs with uncached provenance", { timeout: 10_000 }, async (t) => {
  const requests = [];
  const pending = [];
  const responseOrder = [];
  const rpcUrl = await rpcServer(t, (request, req, res) => {
    requests.push({ request, method: req.method, url: req.url, headers: req.headers });
    if (request.method === "eth_chainId") return result(res, request, "0x1");
    if (request.method === "eth_blockNumber") return result(res, request, "0x1312d00");
    assert.equal(request.method, "eth_call");
    pending.push({ request, res });
    if (pending.length % 2 === 0) {
      // Complete the second request before its sibling, without a timing race.
      for (const entry of [pending.at(-1), pending.at(-2)]) {
        responseOrder.push(entry.request.id);
        result(entry.res, entry.request, entry.request.params[0].to === token ? word(100) : maximumBalance);
      }
    }
  });
  let time = 1_700_000_000_000;
  const startedAt = new Map();
  const settings = [];
  const facts = provider(`${rpcUrl}/rpc/v1?network=one`, {
    clock: { now: () => ++time },
    fetch: (url, init) => {
      const request = JSON.parse(init.body);
      settings.push(init);
      if (request.method === "eth_call") startedAt.set(request.id, time);
      return globalThis.fetch(url, init);
    },
  });
  const calls = [call("__proto__"), call("opaque/call:2", "eip155:1", otherToken)];
  const options = { planId: "opaque-plan/one" };
  const fetching = facts.fetch(calls, options);
  calls[0].params.owner = "0x9999999999999999999999999999999999999999";
  calls[0].params.asset.key.address = otherToken;
  calls[1].callId = "changed";
  calls.push(call("late"));
  options.planId = "changed";
  const batch = await fetching;
  assert.equal(batch.planId, "opaque-plan/one");
  assert.deepEqual(Object.keys(batch.results).sort(), ["__proto__", "opaque/call:2"]);
  assert.ok(Object.hasOwn(batch.results, "__proto__"));
  for (const [id, address, balance] of [["__proto__", token, "0x64"], ["opaque/call:2", otherToken, maximumBalance]]) {
    const request = requests.find(({ request: value }) => value.method === "eth_call" && value.params[0].to === address).request;
    assert.deepEqual(batch.results[id], {
      value: { balance }, source: "onchain:eip155:1:eth_call", blockNumber: "20000000",
      observedAt: startedAt.get(request.id),
    });
    assert.deepEqual(request.params, [{ to: address, data: `0x70a08231${owner.slice(2).padStart(64, "0")}` }, "0x1312d00"]);
  }
  const firstBalances = requests.filter(({ request }) => request.method === "eth_call");
  assert.deepEqual(responseOrder, [firstBalances[1].request.id, firstBalances[0].request.id]);
  await facts.fetch([call("__proto__"), call("opaque/call:2", "eip155:1", otherToken)], { planId: "second-plan" });
  assert.equal(requests.length, 8, "each fetch obtains its own chain, block and balances");
  assert.equal(new Set(requests.map(({ request }) => request.id)).size, requests.length);
  for (const { request, method, url, headers } of requests) {
    assert.equal(request.jsonrpc, "2.0");
    assert.equal(typeof request.id, "string");
    assert.notEqual(request.id, "");
    assert.equal(method, "POST");
    assert.equal(url, "/rpc/v1?network=one");
    assert.match(headers["content-type"], /^application\/json\b/);
    if (request.method !== "eth_call") assert.deepEqual(request.params, []);
  }
  for (const init of settings) {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
  }
});

test("unsupported individual calls omit cleanly while invalid plan and duplicate call bindings fail before I/O", async () => {
  let requests = 0;
  const facts = provider("https://rpc.example", { fetch: async () => {
    requests++;
    throw new Error("unexpected I/O");
  } });
  const unsupported = [call("method"), call("chain", "eip155:5"), call("block"), call("asset"), call("params")];
  unsupported[0].method = "portfolio.price";
  unsupported[2].params.blockNumber = "20000000";
  unsupported[3].params.asset.key.standard = "native";
  unsupported[4].params = null;
  for (const calls of [[], unsupported]) {
    const batch = await facts.fetch(calls, { planId: "empty-plan" });
    assert.equal(batch.planId, "empty-plan");
    assert.deepEqual(Object.keys(batch.results), []);
  }
  for (const planId of [undefined, null, "", 17]) {
    await assert.rejects(facts.fetch([], { planId }), code("INVALID_REQUEST"));
  }
  for (const callId of [undefined, null, "", 17]) {
    const invalid = call("valid");
    invalid.callId = callId;
    invalid.method = "unsupported";
    await assert.rejects(facts.fetch([invalid], { planId: "valid" }), code("INVALID_REQUEST"));
  }
  const duplicate = call("same");
  duplicate.method = "unsupported";
  await assert.rejects(facts.fetch([call("same"), duplicate], { planId: "valid" }), code("INVALID_REQUEST"));
  assert.equal(requests, 0);
});

test("chain preparation failures and mismatches suppress that chain while successful sibling balances survive", { timeout: 10_000 }, async (t) => {
  const seen = new Map();
  const rpcUrl = await rpcServer(t, (request, req, res) => {
    const chain = req.url.slice(1);
    if (!seen.has(chain)) seen.set(chain, []);
    seen.get(chain).push(request);
    if (request.method === "eth_chainId") {
      return result(res, request, chain === "5" ? "0x6" : `0x${BigInt(chain).toString(16)}`);
    }
    if (request.method === "eth_blockNumber") {
      if (chain === "10") {
        res.writeHead(503);
        return res.end("private-token");
      }
      return result(res, request, chain === "137" ? "0x20000000000001" : "0x1312d00");
    }
    if (request.params[0].to === otherToken) return revert(res, request);
    result(res, request, word(100));
  });
  const chains = Object.fromEntries([1, 5, 10, 137].map((chain) => [`eip155:${chain}`, { rpcUrl: `${rpcUrl}/${chain}` }]));
  const facts = provider(rpcUrl, { chains });
  const batch = await facts.fetch([
    call("good"), call("reverted", "eip155:1", otherToken), call("wrong-chain", "eip155:5"),
    call("unavailable-block", "eip155:10"), call("other-chain", "eip155:137"),
  ], { planId: "multiple-chains" });
  assert.equal(batch.planId, "multiple-chains");
  assert.deepEqual(Object.keys(batch.results).sort(), ["good", "other-chain"]);
  assert.deepEqual(batch.results.good.value, { balance: "0x64" });
  assert.equal(batch.results["other-chain"].blockNumber, "9007199254740993");
  assert.equal(batch.results["other-chain"].source, "onchain:eip155:137:eth_call");
  assert.deepEqual(seen.get("5").map(({ method }) => method), ["eth_chainId"]);
  assert.deepEqual(seen.get("10").map(({ method }) => method), ["eth_chainId", "eth_blockNumber"]);
  assert.equal(seen.get("137").find(({ method }) => method === "eth_call").params[1], "0x20000000000001");
});

test("whole-batch transport outages reject but individual RPC reverts and malformed balances remain omissions", { timeout: 10_000 }, async (t) => {
  let mode;
  const rpcUrl = await rpcServer(t, (request, req, res) => {
    if (mode === "preparation-http" || (request.method === "eth_call" && (mode === "http"
      || (mode === "http-and-revert" && request.params[0].to === token)))) {
      res.writeHead(503);
      return res.end("private-token: unavailable");
    }
    if (request.method === "eth_chainId") return result(res, request, "0x1");
    if (request.method === "eth_blockNumber") return result(res, request, "0x1312d00");
    if (mode === "network") return req.socket.destroy();
    if (mode === "invalid-balance") return result(res, request, "0x");
    return revert(res, request);
  });
  const facts = provider(rpcUrl);
  const calls = [call("one"), call("two", "eip155:1", otherToken)];
  for (const failing of ["http", "preparation-http", "network"]) {
    mode = failing;
    await assert.rejects(facts.fetch(calls, { planId: failing }),
      code(failing === "network" ? "NETWORK_ERROR" : "HTTP_ERROR", failing === "network" ? undefined : 503));
  }
  for (const omitted of ["revert", "invalid-balance", "http-and-revert"]) {
    mode = omitted;
    const batch = await facts.fetch(calls, { planId: omitted });
    assert.equal(batch.planId, omitted);
    assert.deepEqual(Object.keys(batch.results), []);
  }
});

test("bounded and malformed HTTP RPC responses reject preparation but omit an individual balance", { timeout: 10_000 }, async (t) => {
  let stage;
  let failure;
  const rpcUrl = await rpcServer(t, (request, _req, res) => {
    if (request.method === stage) {
      if (failure === "oversized") return res.end("private-token".repeat(100));
      if (failure === "utf8") return res.end(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
      if (failure === "json") return res.end("not JSON: private-token");
      return result(res, { ...request, id: `${request.id}-wrong` }, "0x1");
    }
    if (request.method === "eth_chainId") return result(res, request, "0x1");
    if (request.method === "eth_blockNumber") return result(res, request, "0x1312d00");
    result(res, request, word(100));
  });
  const facts = provider(rpcUrl, { maxResponseBytes: 256 });
  for (const invalid of ["oversized", "utf8", "json", "id"]) {
    failure = invalid;
    stage = "eth_chainId";
    await assert.rejects(facts.fetch([call("balance")], { planId: `prep-${invalid}` }),
      code(invalid === "oversized" ? "RESPONSE_TOO_LARGE" : "INVALID_RESPONSE"));
    stage = "eth_call";
    const batch = await facts.fetch([call("balance")], { planId: `call-${invalid}` });
    assert.equal(batch.planId, `call-${invalid}`);
    assert.deepEqual(Object.keys(batch.results), []);
  }
});
