import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { AdapterError, createEvmFactProvider } from "@dambi/core/adapters";

const owner = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const word = `0x${"64".padStart(64, "0")}`;

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function code(expectedCode) {
  return (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function call(callId = "balance", chain = "eip155:1", account = owner) {
  return {
    manifestId: "transfer-full-balance-sweep", callId, method: "portfolio.balance",
    params: { chain_id: chain, owner: account, asset: { key: { standard: "erc20", chain, address: token } } },
    outputs: [], optional: true,
  };
}

function provider(options = {}) {
  return createEvmFactProvider({
    chains: { "eip155:1": { rpcUrl: "https://rpc.example/v1?project=test" } },
    maxResponseBytes: 4_096,
    ...options,
  });
}

function resultFor(request, chain = 1) {
  return request.method === "eth_chainId" ? `0x${chain.toString(16)}`
    : request.method === "eth_blockNumber" ? "0x1312d00" : word;
}

function responseFor(request, chain = 1) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: resultFor(request, chain) }));
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Fact provider validates configuration before I/O and captures endpoint, headers, clock and calls", async () => {
  let requests = 0;
  const forbiddenFetch = () => { requests++; throw new Error("unexpected I/O"); };
  for (const rpcUrl of [
    "https://rpc.example/v1/key?network=mainnet&token=a%2Fb", "http://localhost:3210/rpc",
    "http://127.17.3.4:3210/rpc", "http://[::1]:3210/rpc",
  ]) {
    assert.equal(typeof provider({ chains: { "eip155:1": { rpcUrl } }, fetch: forbiddenFetch }).fetch, "function");
  }
  for (const rpcUrl of [
    "http://rpc.example", "http://localhost.example", "http://128.0.0.1", "ftp://rpc.example",
    "https://name:secret@rpc.example", "https://@rpc.example", "https://rpc.example/#fragment",
    "https://rpc.example/#", " https://rpc.example", "https://rpc.example/a b",
    String.raw`https://rpc.example\private`, "not a URL",
  ]) {
    assert.throws(() => provider({ chains: { "eip155:1": { rpcUrl } }, fetch: forbiddenFetch }), code("INVALID_CONFIG"));
  }
  for (const options of [
    { chains: {} }, { chains: [] }, { chains: null },
    { chains: { "eip155:01": { rpcUrl: "https://rpc.example" } } },
    { chains: { "eip155:1": null } }, { chains: { "eip155:1": {} } },
    { maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 1.5 },
    { maxResponseBytes: Infinity }, { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 },
    { fetch: "not a function" }, { clock: null }, { clock: {} }, { clock: { now: 123 } },
  ]) {
    assert.throws(() => provider({ fetch: forbiddenFetch, ...options }), code("INVALID_CONFIG"));
  }
  for (const name of ["if-none-match", "If-Modified-Since", "host", "content-length", "transfer-encoding", "connection", "cookie"]) {
    assert.throws(() => provider({
      chains: { "eip155:1": { rpcUrl: "https://rpc.example", headers: { [name]: "forbidden" } } },
      fetch: forbiddenFetch,
    }), code("INVALID_CONFIG"));
  }
  assert.equal(requests, 0);

  const gate = deferred();
  const seen = [];
  const rpcUrl = "https://rpc.example/v1/key?network=mainnet&token=a%2Fb";
  const headers = { authorization: "Bearer test-only", "x-client": "original" };
  const chains = { "eip155:1": { rpcUrl, headers } };
  const clock = { now: () => 1_000 };
  const options = {
    chains, maxResponseBytes: 4_096, clock,
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      seen.push({ url, init, request });
      if (seen.length === 1) await gate.promise;
      return responseFor(request);
    },
  };
  const facts = createEvmFactProvider(options);
  chains["eip155:1"].rpcUrl = "https://different.example";
  headers.authorization = "mutated";
  headers["x-client"] = "mutated";
  clock.now = () => 2_000;
  options.fetch = forbiddenFetch;
  options.maxResponseBytes = 1;
  const input = call("original");
  const fetchOptions = { planId: "original-plan" };
  const pending = facts.fetch([input], fetchOptions);
  input.callId = "mutated";
  input.params.owner = "0x3333333333333333333333333333333333333333";
  input.params.asset.key.address = "0x4444444444444444444444444444444444444444";
  fetchOptions.planId = "mutated-plan";
  gate.resolve();
  const batch = await pending;
  assert.equal(batch.planId, "original-plan");
  assert.deepEqual(Object.keys(batch.results), ["original"]);
  assert.equal(batch.results.original.observedAt, 1_000);
  assert.equal(seen.length, 3);
  for (const { url, init } of seen) {
    assert.equal(String(url), rpcUrl);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    const actualHeaders = new Headers(init.headers);
    assert.equal(actualHeaders.get("accept"), "application/json");
    assert.equal(actualHeaders.get("content-type"), "application/json");
    assert.equal(actualHeaders.get("authorization"), "Bearer test-only");
    assert.equal(actualHeaders.get("x-client"), "original");
  }
  assert.equal(seen[2].request.params[0].to, token);
  assert.equal(seen[2].request.params[0].data, `0x70a08231${owner.slice(2).padStart(64, "0")}`);
  assert.equal(requests, 0);
});

test("Fact provider keeps preparation and response bodies within four concurrent HTTP requests", { timeout: 5_000 }, async () => {
  const chains = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `eip155:${index + 1}`, { rpcUrl: `https://rpc.example/${index + 1}` },
  ]));
  const queued = [];
  let wake = deferred();
  let active = 0;
  let peak = 0;
  let issued = 0;
  const ids = new Set();
  const facts = provider({ chains, fetch: async (url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(typeof request.id, "string");
    assert.equal(ids.has(request.id), false, "every HTTP request has its own correlation ID");
    ids.add(request.id);
    issued++;
    peak = Math.max(peak, ++active);
    assert.ok(active <= 4, "HTTP response bodies count toward the concurrency limit");
    const chain = Number(new URL(url).pathname.slice(1));
    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: resultFor(request, chain) }));
    return new Response(new ReadableStream({
      start(controller) {
        queued.push(() => { active--; controller.enqueue(body); controller.close(); });
        wake.resolve();
      },
    }));
  } });
  const next = async () => {
    while (queued.length === 0) { await wake.promise; wake = deferred(); }
    return queued.shift();
  };
  const pending = facts.fetch(Array.from({ length: 6 }, (_, index) => call(`balance-${index}`, `eip155:${index + 1}`)), { planId: "concurrent" });
  const first = [];
  for (let index = 0; index < 4; index++) first.push(await next());
  await tick();
  assert.equal(issued, 4, "a fifth chain cannot start while four bodies are pending");
  for (const finish of first) finish();
  for (let index = 4; index < 18; index++) (await next())();
  const batch = await pending;
  assert.equal(Object.keys(batch.results).length, 6);
  assert.equal(issued, 18);
  assert.equal(active, 0);
  assert.equal(peak, 4);
});

test("aborting queued chain preparation ignores late injected responses and leaves independent fetches usable", { timeout: 5_000 }, async () => {
  const chains = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `eip155:${index + 1}`, { rpcUrl: `https://rpc.example/${index + 1}` },
  ]));
  const firstFour = deferred();
  const held = [];
  const ids = new Set();
  let complete = false;
  let issued = 0;
  let cancelledLateBodies = 0;
  const facts = provider({ chains, fetch: async (url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(ids.has(request.id), false, "independent fetches must not reuse correlation IDs");
    ids.add(request.id);
    issued++;
    const chain = Number(new URL(url).pathname.slice(1));
    if (complete) return responseFor(request, chain);
    const response = deferred();
    held.push({ request, response, chain });
    if (held.length === 4) firstFour.resolve();
    // This injected transport intentionally ignores its AbortSignal.
    return response.promise;
  } });
  const controller = new AbortController();
  const pending = facts.fetch(Array.from({ length: 6 }, (_, index) => call(`old-${index}`, `eip155:${index + 1}`)), {
    planId: "old-plan", signal: controller.signal,
  });
  const rejected = assert.rejects(pending, code("ABORTED"));
  await firstFour.promise;
  controller.abort();
  await rejected;
  await tick();
  assert.equal(issued, 4, "cancelled queued chains never start");

  complete = true;
  const independent = await facts.fetch([call("new")], { planId: "new-plan" });
  assert.deepEqual(independent.results.new.value, { balance: "0x64" });
  assert.equal(issued, 7, "an independent fetch performs its own preparation and balance read");
  for (const { response } of held) {
    response.resolve(new Response(new ReadableStream({ cancel() { cancelledLateBodies++; } })));
  }
  await tick();
  assert.equal(cancelledLateBodies, 4);
  assert.equal(issued, 7, "late responses cannot resume cancelled work");
  const subsequent = await facts.fetch([call("after-late")], { planId: "after-late-plan" });
  assert.deepEqual(subsequent.results["after-late"].value, { balance: "0x64" });
  assert.equal(issued, 10, "adapter never caches chain preparation or Fact values across fetches");
});

test("real HTTP header and body cancellation stops queued balances without blocking an independent fetch", { timeout: 10_000 }, async (t) => {
  for (const mode of ["headers", "body"]) {
    const fourRequests = deferred();
    const fourResponses = deferred();
    const fourClosed = deferred();
    let heldRequests = 0;
    let heldResponses = 0;
    let closedResponses = 0;
    let issued = 0;
    const independentOwner = "0x3333333333333333333333333333333333333333";
    const baseUrl = await serverFor(t, (req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body);
        const held = request.method === "eth_call" && request.params[0].data.endsWith(owner.slice(2));
        if (held) {
          res.on("close", () => { if (++closedResponses === 4) fourClosed.resolve(); });
          if (++heldRequests === 4) fourRequests.resolve();
          if (mode === "body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"jsonrpc":"2.0","id":');
          }
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: resultFor(request) }));
      });
    });
    const facts = provider({
      chains: { "eip155:1": { rpcUrl: `${baseUrl}/rpc` } },
      fetch: async (url, init) => {
        issued++;
        const request = JSON.parse(init.body);
        const response = await globalThis.fetch(url, init);
        if (mode === "body" && request.method === "eth_call" && request.params[0].data.endsWith(owner.slice(2))) {
          if (++heldResponses === 4) fourResponses.resolve();
        }
        return response;
      },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(facts.fetch([call()], { planId: "already", signal: alreadyAborted.signal }), code("ABORTED"));
    assert.equal(issued, 0);
    const controller = new AbortController();
    const pending = facts.fetch(Array.from({ length: 8 }, (_, index) => call(`held-${index}`)), {
      planId: `held-${mode}`, signal: controller.signal,
    });
    const rejected = assert.rejects(pending, code("ABORTED"));
    await (mode === "body" ? fourResponses.promise : fourRequests.promise);
    const independent = await facts.fetch([call("independent", "eip155:1", independentOwner)], { planId: `independent-${mode}` });
    assert.deepEqual(independent.results.independent.value, { balance: "0x64" });
    controller.abort();
    await rejected;
    await fourClosed.promise;
    await tick();
    assert.equal(heldRequests, 4, `${mode}: queued balances cannot start after abort`);
    assert.equal(issued, 9, `${mode}: only two preparation requests, four held balances and three independent requests`);
  }
});

test("invalid observation clocks reject the whole fetch with sanitized configuration errors", async () => {
  const secret = "clock-private-detail";
  for (const now of [
    () => -1, () => NaN, () => Infinity, () => 0.5, () => Number.MAX_SAFE_INTEGER + 1,
    () => { throw new Error(secret); },
  ]) {
    const facts = provider({ clock: { now }, fetch: async (_url, init) => responseFor(JSON.parse(init.body)) });
    await assert.rejects(facts.fetch([call("first"), call("second")], { planId: "invalid-clock" }), (error) => {
      code("INVALID_CONFIG")(error);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});

test("RPC redirects reject without propagating authentication to the redirect target", async (t) => {
  let redirectedRequests = 0;
  const target = await serverFor(t, (_req, res) => { redirectedRequests++; res.end("unexpected"); });
  const baseUrl = await serverFor(t, (_req, res) => {
    res.writeHead(307, { location: `${target}/private-rpc` });
    res.end();
  });
  const facts = provider({ chains: { "eip155:1": { rpcUrl: `${baseUrl}/rpc`, headers: { authorization: "Bearer test-only" } } } });
  await assert.rejects(facts.fetch([call()], { planId: "redirect" }), code("NETWORK_ERROR"));
  assert.equal(redirectedRequests, 0);
});
