import test from "node:test";
import assert from "node:assert/strict";
import { createScamRpcSource } from "../../dist/adapters/scam-rpc.js";

const POOL = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;
const QUOTE = `0x${"44".repeat(20)}`;
const OTHER = `0x${"55".repeat(20)}`;
const TOPIC = `0x${"66".repeat(32)}`;
const NOW = 100_000_000;
const q = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const blockHash = (n) => `0x${word(BigInt(n) + 100n)}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const ok = (request, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
const header = (number) => ({ number: q(number), hash: blockHash(number),
  parentHash: blockHash(BigInt(number) - 1n), timestamp: q(BigInt(number) + 1_000n) });
const rawLog = (number, index = 0) => ({ address: POOL, blockNumber: q(number),
  blockHash: blockHash(number), transactionHash: `0x${word(BigInt(number) + 1_000_000n)}`,
  transactionIndex: "0x0", logIndex: q(index), topics: [TOPIC], data: "0x", removed: false });
const subject = () => ({ chainId: 91342, venue: "uniswap_v2", pool: POOL, factory: FACTORY,
  token: TOKEN, quoteToken: QUOTE, actionPaths: ["actions[0]"] });
const request = (overrides = {}) => ({ planId: "plan:test", referenceGroupId: "reference:test",
  confirmDepth: 2, deadlineMs: NOW + 5_000, subjects: [subject()], ...overrides });
const query = (from = "1", to = "10") => ({ scope: "pair", fromBlock: from, toBlock: to, topics: [TOPIC] });
const failure = (reason) => ({ name: "ScamRpcError", reason });
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture({ head = 20_050, limits = {}, handle, clock = { now: () => NOW } } = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const options = {
    chainId: 91342, endpoint: { rpcUrl: "https://rpc.invalid/test?key=private", headers: { "x-test": "copied" } },
    factories: [FACTORY], quoteTokens: [QUOTE], clock,
    limits: { maxRequests: 100, maxResponseBytes: 65_536, maxTotalResponseBytes: 1_000_000,
      maxLogs: 100, maxBlocksPerQuery: 10_000, concurrency: 2, maxRetries: 0, retryDelayMs: 0, ...limits },
    fetch: async (url, init) => {
      const rpc = JSON.parse(init.body);
      calls.push({ rpc, url, init });
      active++;
      peak = Math.max(peak, active);
      try {
        const override = await handle?.(rpc, calls);
        if (override !== undefined) return override;
        if (rpc.method === "eth_chainId") return ok(rpc, q(91342));
        if (rpc.method === "eth_getBlockByNumber") return ok(rpc, header(rpc.params[0] === "latest" ? head : BigInt(rpc.params[0])));
        if (rpc.method === "eth_getCode") return ok(rpc, "0x6000");
        if (rpc.method === "eth_getLogs") return ok(rpc, []);
        if (rpc.method === "eth_call") {
          const selector = rpc.params[0].data.slice(0, 10);
          const result = {
            "0x0dfe1681": addressWord(TOKEN), "0xd21220a7": addressWord(QUOTE),
            "0xc45a0155": addressWord(FACTORY), "0xe6a43905": addressWord(POOL),
            "0x0902f1ac": `0x${word(100)}${word(200)}${word(1_000)}`,
            "0x313ce567": `0x${word(18)}`,
          }[selector];
          assert.notEqual(result, undefined, `Unexpected fake eth_call selector: ${selector}`);
          return ok(rpc, result);
        }
        throw new Error(`Unexpected fake RPC method: ${rpc.method}`);
      } finally { active--; }
    },
  };
  return { options, calls, peak: () => peak, source: createScamRpcSource(options) };
}

test("scam RPC batches pin one confirmed reference, verify pool identity and copy caller inputs", async () => {
  const f = fixture();
  const input = request();
  const work = f.source.withBatch(input, async (batch) => {
    assert.equal(batch.planId, "plan:test");
    assert.equal(batch.referenceGroupId, "reference:test");
    const [pool, duplicate] = await Promise.all([batch.pool(0), batch.pool(0)]);
    assert.strictEqual(pool, duplicate);
    assert.equal(pool.subject.token, TOKEN);
    assert.deepEqual(pool.subject.actionPaths, ["actions[0]"]);
    assert.deepEqual(await batch.reserves(pool, "9"), { reserve0: "100", reserve1: "200", blockTimestampLast: 1_000 });
    await batch.reserves(pool);
    assert.equal(await batch.decimals(pool, "token0"), 18);
    assert.equal(await batch.decimals(pool, "token1"), 18);
    assert.equal(await batch.code(pool, "9"), "0x6000");
    assert.equal((await batch.block("9")).number, "9");
    return batch.reference;
  });
  input.subjects[0].token = OTHER;
  input.subjects[0].actionPaths.push("mutated");
  input.confirmDepth = 0;
  f.options.factories[0] = OTHER;
  f.options.endpoint.rpcUrl = "https://changed.invalid/";
  f.options.endpoint.headers["x-test"] = "changed";
  f.options.limits.maxRequests = 1;
  const result = await work;
  assert.strictEqual(result.value, result.reference);
  assert.deepEqual(result.reference, {
    block: { number: "20048", hash: blockHash(20_048), timestampMs: 21_048_000 },
    checkedHead: { number: "20050", hash: blockHash(20_050), timestampMs: 21_050_000 },
    requiredConfirmDepth: 2, observedConfirmDepth: 2,
  });
  assert.equal(result.observedAt, NOW);
  assert.equal(result.metrics.requests, f.calls.length);
  const stateCalls = f.calls.filter(({ rpc }) => ["eth_call", "eth_getCode"].includes(rpc.method));
  assert.ok(stateCalls.every(({ rpc }) => [q(20_048), q(9)].includes(rpc.params[1])));
  assert.equal(stateCalls.filter(({ rpc }) => rpc.params[0]?.data === "0xc45a0155").length, 1);
  const getPair = stateCalls.find(({ rpc }) => rpc.params[0]?.data?.startsWith("0xe6a43905")).rpc;
  assert.equal(getPair.params[0].to, FACTORY);
  assert.equal(getPair.params[0].data, `0xe6a43905${TOKEN.slice(2).padStart(64, "0")}${QUOTE.slice(2).padStart(64, "0")}`);
  assert.ok(f.calls.every(({ url, init }) => url === "https://rpc.invalid/test?key=private"
    && init.headers.get("x-test") === "copied" && init.credentials === "omit" && init.redirect === "error"));
});

test("scam RPC rejects wrong chains, forged identities and unverified or arbitrary log targets", async () => {
  const wrongChain = fixture({ handle: (rpc) => rpc.method === "eth_chainId" ? ok(rpc, "0x1") : undefined });
  await assert.rejects(wrongChain.source.withBatch(request(), async () => null), failure("chain_mismatch"));
  assert.equal(wrongChain.calls.length, 1);
  for (const selector of ["0xc45a0155", "0xe6a43905", "0x0dfe1681"]) {
    const f = fixture({ handle: (rpc) => rpc.method === "eth_call" && rpc.params[0].data.startsWith(selector)
      ? ok(rpc, addressWord(OTHER)) : undefined });
    await assert.rejects(f.source.withBatch(request(), (batch) => batch.pool(0)), failure("subject_mismatch"));
  }
  for (const collect of [
    async (batch) => batch.reserves({ ...(await batch.pool(0)) }),
    async (batch) => batch.logs(await batch.pool(0), { ...query(), scope: OTHER }),
    async (batch) => batch.logs(await batch.pool(0), null),
    async (batch) => batch.logs(await batch.pool(0), { ...query(), topics: undefined }),
  ]) {
    const f = fixture();
    await assert.rejects(f.source.withBatch(request(), collect), failure("invalid_request"));
    assert.equal(f.calls.filter(({ rpc }) => rpc.method === "eth_getLogs").length, 0);
  }
  const invalidSubject = fixture();
  await assert.rejects(invalidSubject.source.withBatch(request({ subjects: [{ ...subject(), factory: OTHER }] }), async () => null), failure("invalid_request"));
  assert.equal(invalidSubject.calls.length, 0);
});

test("scam RPC log chunks use inclusive 10000-block bounds and distinguish empty coverage from missing ranges", async () => {
  const f = fixture({ head: 40_010, handle: (rpc) => {
    if (rpc.method !== "eth_getLogs") return undefined;
    const from = BigInt(rpc.params[0].fromBlock);
    if (from === 1n) return ok(rpc, []);
    if (from === 10_001n) return new Response("unavailable", { status: 500 });
    if (from === 20_001n) return ok(rpc, [rawLog(20_001, 0), { ...rawLog(20_001, 1), address: OTHER }]);
    return ok(rpc, [rawLog(30_001, 2), rawLog(30_001, 1)]);
  } });
  const result = await f.source.withBatch(request(), async (batch) => batch.logs(await batch.pool(0), query("1", "30001")));
  assert.deepEqual(f.calls.filter(({ rpc }) => rpc.method === "eth_getLogs").map(({ rpc }) => {
    const params = rpc.params[0];
    assert.equal(params.address, POOL);
    assert.deepEqual(params.topics, [[TOPIC]]);
    return [BigInt(params.fromBlock).toString(), BigInt(params.toBlock).toString()];
  }), [["1", "10000"], ["10001", "20000"], ["20001", "30000"], ["30001", "30001"]]);
  assert.deepEqual(result.value.missing, [
    { fromBlock: "10001", toBlock: "20000", reason: "rpc_error" },
    { fromBlock: "20001", toBlock: "30000", reason: "invalid_response" },
  ]);
  assert.deepEqual(result.value.logs.map((log) => [log.blockNumber, log.logIndex]), [["30001", 1], ["30001", 2]]);
  assert.equal(result.metrics.logChunks, 4);
  assert.equal(result.metrics.failedChunks, 2);
});

test("scam RPC retries transient failures within its attempt cap and shares the concurrency limit", async () => {
  let chainAttempts = 0;
  const f = fixture({ limits: { maxRetries: 1, concurrency: 2 }, handle: async (rpc) => {
    if (rpc.method === "eth_chainId" && ++chainAttempts === 1) return new Response("slow down", { status: 429 });
    if (rpc.method === "eth_call") await turn();
    return undefined;
  } });
  const result = await f.source.withBatch(request(), (batch) => batch.pool(0));
  assert.equal(chainAttempts, 2);
  assert.equal(result.metrics.retries, 1);
  assert.equal(result.metrics.requests, f.calls.length);
  assert.equal(f.peak(), 2);
  const exhausted = fixture({ limits: { maxRetries: 2 }, handle: () => new Response("retry", { status: 429 }) });
  await assert.rejects(exhausted.source.withBatch(request(), async () => null), failure("rpc_error"));
  assert.equal(exhausted.calls.length, 3);
});

test("scam RPC discards drafts when checked head, reference, historical state or returned-log block hashes change", async () => {
  for (const mode of ["head", "reference", "historical", "log"]) {
    const reads = new Map();
    const f = fixture({ head: 25, handle: (rpc) => {
      if (mode === "log" && rpc.method === "eth_getLogs") return ok(rpc, [{ ...rawLog(9), blockHash: blockHash(999) }]);
      if (rpc.method !== "eth_getBlockByNumber" || rpc.params[0] === "latest") return undefined;
      const n = BigInt(rpc.params[0]);
      const seen = (reads.get(n) ?? 0) + 1;
      reads.set(n, seen);
      if ((mode === "head" && n === 25n)
          || (seen > 1 && ((mode === "reference" && n === 23n) || (mode === "historical" && n === 9n)))) {
        return ok(rpc, { ...header(n), hash: blockHash(999) });
      }
      return undefined;
    } });
    await assert.rejects(f.source.withBatch(request(), async (batch) => {
      if (mode === "head" || mode === "reference") return "must not escape";
      const pool = await batch.pool(0);
      return mode === "historical" ? batch.reserves(pool, "9") : batch.logs(pool, query("9", "9"));
    }), failure("reorg"));
  }
});

test("scam RPC cancellation and deadlines reject late fetches without poisoning the next batch", async () => {
  const entered = deferred(), late = deferred();
  let firstRequest;
  const f = fixture({ handle: (rpc) => {
    if (!firstRequest) { firstRequest = rpc; entered.resolve(); return late.promise; }
    return undefined;
  } });
  const controller = new AbortController();
  const pending = f.source.withBatch(request({ signal: controller.signal }), async () => "stale");
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, failure("aborted"));
  let oldBatch;
  const fresh = await f.source.withBatch(request({ planId: "next" }), async (batch) => {
    oldBatch = batch;
    return batch.planId;
  });
  assert.equal(fresh.value, "next");
  assert.equal(fresh.metrics.requests, 5);
  await assert.rejects(oldBatch.block("9"), failure("aborted"));
  late.resolve(ok(firstRequest, q(91342)));
  await turn();
  assert.equal(fresh.value, "next");
  assert.equal(new Set(f.calls.map(({ rpc }) => rpc.id)).size, f.calls.length);
  const lateTimeout = deferred();
  let timeoutRequest;
  const timeout = fixture({ clock: { now: () => Date.now() }, handle: (rpc) => {
    timeoutRequest = rpc;
    return lateTimeout.promise;
  } });
  await assert.rejects(timeout.source.withBatch(request({ deadlineMs: Date.now() + 30 }), async () => null), failure("timeout"));
  lateTimeout.resolve(ok(timeoutRequest, q(91342)));
  await turn();
  const stopped = fixture();
  await assert.rejects(stopped.source.withBatch(request({ signal: AbortSignal.abort() }), async () => null), failure("aborted"));
  assert.equal(stopped.calls.length, 0);
  const unfinishedReply = deferred();
  let unfinishedRequest, unfinishedOperation;
  const unfinished = fixture({ handle: (rpc) => {
    if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)) {
      unfinishedRequest = rpc;
      return unfinishedReply.promise;
    }
    return undefined;
  } });
  await assert.rejects(unfinished.source.withBatch(request(), async (batch) => {
    unfinishedOperation = batch.block("9");
    void unfinishedOperation.catch(() => {});
    return "unawaited draft";
  }), failure("invalid_request"));
  await assert.rejects(unfinishedOperation, failure("aborted"));
  unfinishedReply.resolve(ok(unfinishedRequest, header(9)));
  await turn();
});

test("scam RPC enforces request, individual-byte, total-byte and accumulated-log budgets", async () => {
  for (const limits of [{ maxRequests: 1 }, { maxResponseBytes: 16 }, { maxTotalResponseBytes: 80 }]) {
    const f = fixture({ limits });
    await assert.rejects(f.source.withBatch(request(), async () => null), failure("resource_limit"));
  }
  const retryBudget = fixture({ limits: { maxRequests: 2, maxRetries: 3 }, handle: () => new Response("retry", { status: 429 }) });
  await assert.rejects(retryBudget.source.withBatch(request(), async () => null), failure("resource_limit"));
  assert.equal(retryBudget.calls.length, 2);
  const logsBudget = fixture({ limits: { maxLogs: 1 }, handle: (rpc) => rpc.method === "eth_getLogs"
    ? ok(rpc, [rawLog(BigInt(rpc.params[0].fromBlock))]) : undefined });
  await assert.rejects(logsBudget.source.withBatch(request(), async (batch) => {
    const pool = await batch.pool(0);
    await batch.logs(pool, query("9", "9"));
    return batch.logs(pool, query("10", "10"));
  }), failure("resource_limit"));
});

test("scam RPC validates configuration and keeps endpoint errors free of remote messages or secrets", async () => {
  const base = fixture().options;
  for (const patch of [
    { chainId: 0 }, { factories: [] }, { endpoint: { rpcUrl: "http://external.invalid/" } },
    { endpoint: { rpcUrl: "https://user:password@rpc.invalid/" } },
    { endpoint: { rpcUrl: "https://rpc.invalid/", headers: { cookie: "private" } } },
    { limits: { ...base.limits, concurrency: 0 } }, { limits: { ...base.limits, maxRetries: 11 } },
    { limits: { ...base.limits, maxBlocksPerQuery: 0 } },
  ]) assert.throws(() => createScamRpcSource({ ...base, ...patch }), failure("invalid_config"));
  for (const handle of [
    () => { throw new Error("SECRET_endpoint_token"); },
    () => new Response("SECRET_endpoint_token", { status: 500 }),
    (rpc) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "SECRET_endpoint_token", data: "private" } })),
  ]) {
    const f = fixture({ handle });
    await assert.rejects(f.source.withBatch(request(), async () => null), (error) => {
      assert.equal(error.reason, "rpc_error");
      assert.equal(error.message, "Scam RPC operation failed: rpc_error.");
      assert.doesNotMatch(JSON.stringify(error), /SECRET|private|rpc\.invalid/);
      return true;
    });
  }
});
