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
const historyCacheOptions = () => ({ maxEntries: 8, maxBytes: 500_000, ttlMs: 10_000, maxBlockSpan: 10_000 });
const failure = (reason) => ({ name: "ScamRpcError", reason });
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture({ head = 20_050, limits = {}, handle, verification, historyCache, clock = { now: () => NOW } } = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const options = {
    chainId: 91342, endpoint: { rpcUrl: "https://rpc.invalid/test?key=private", headers: { "x-test": "copied" } },
    factories: [FACTORY], quoteTokens: [QUOTE], clock, verification, historyCache,
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
  assert.equal(result.verifiedAt, NOW);
  assert.deepEqual(result.verification, { history: "all_event_headers", stateBinding: "number_recheck" });
  assert.equal(Object.isFrozen(result.verification), true);
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

test("scam RPC freezes verification configuration and rejects unavailable modes before work", async () => {
  const f = fixture();
  for (const history of ["all_event_headers", "rpc_anchor"]) {
    const verification = { history, stateBinding: "number_recheck" };
    const source = createScamRpcSource({ ...f.options, verification });
    verification.history = history === "rpc_anchor" ? "all_event_headers" : "rpc_anchor";
    verification.stateBinding = "block_hash_canonical";
    const result = await source.withBatch(request(), async () => null);
    assert.deepEqual(result.verification, { history, stateBinding: "number_recheck" });
  }

  const before = f.calls.length;
  for (const invalid of [null, [], { history: "unknown" }, { stateBinding: "block_hash_canonical" },
    { history: null }, { stateBinding: "latest" }, { history: "all_event_headers", extra: true },
    { [Symbol("unexpected")]: true }]) {
    assert.throws(() => createScamRpcSource({ ...f.options, verification: invalid }), failure("invalid_config"));
  }
  assert.equal(f.calls.length, before, "Unsupported verification does not dispatch or silently downgrade");
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

test("scam RPC spaces actual attempts across batches and caps exponential retry backoff", { timeout: 5_000 }, async (t) => {
  const starts = [];
  let firstChain = true;
  const paced = fixture({ limits: { minRequestIntervalMs: 12, maxRetries: 1 }, handle: (rpc) => {
    starts.push(performance.now());
    if (rpc.method === "eth_chainId" && firstChain) {
      firstChain = false;
      return new Response("transient", { status: 503 });
    }
    return undefined;
  } });
  const results = await Promise.all([
    paced.source.withBatch(request({ planId: "paced:a" }), async () => null),
    paced.source.withBatch(request({ planId: "paced:b" }), async () => null),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.metrics.retries, 0), 1);
  assert.equal(starts.length, 11, "Both references and the retry pass through the same launch gate");
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 9,
    "Consecutive actual attempts retain the configured 12 ms spacing (3 ms scheduling tolerance)");

  const retryStarts = [], scheduled = [];
  let attempts = 0;
  const backoff = fixture({ limits: { maxRetries: 3, retryDelayMs: 20, maxRetryDelayMs: 30 }, handle: (rpc) => {
    if (rpc.method !== "eth_chainId") return undefined;
    retryStarts.push(performance.now());
    if (++attempts <= 3) return new Response("transient", { status: 503 });
    return undefined;
  } });
  // Observe requested delays without replacing timers or advancing the clock.
  // This checks the cap without a flaky upper bound on elapsed wall time.
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => { scheduled.push(args[1]); return originalTimer(...args); });
  const retried = await backoff.source.withBatch(request(), async () => null);
  t.mock.restoreAll();
  assert.equal(retried.metrics.retries, 3);
  assert.deepEqual(scheduled.filter((ms) => ms <= 100), [20, 30, 30]);
  for (let i = 1; i < retryStarts.length; i++) assert.ok(retryStarts[i] - retryStarts[i - 1] >= [17, 27, 27][i - 1]);
});

test("scam RPC cancels queued pacing waits and ignores late rate limits after abort or timeout", { timeout: 5_000 }, async () => {
  const entered = deferred(), late = deferred();
  let first = true;
  const paced = fixture({ limits: { minRequestIntervalMs: 40 }, handle: () => {
    if (first) { first = false; entered.resolve(); return late.promise; }
    return undefined;
  } });
  const initialController = new AbortController();
  const initial = paced.source.withBatch(request({ signal: initialController.signal }), async () => null);
  const initialRejected = assert.rejects(initial, failure("aborted"));
  await entered.promise;
  const queued = Array.from({ length: 20 }, (_, i) => {
    const controller = new AbortController();
    const pending = paced.source.withBatch(request({ planId: `cancelled:${i}`, signal: controller.signal }), async () => null);
    return { controller, rejected: assert.rejects(pending, failure("aborted")) };
  });
  for (const item of queued) item.controller.abort();
  initialController.abort();
  await Promise.all([initialRejected, ...queued.map((item) => item.rejected)]);
  assert.equal(paced.calls.length, 1, "Queued cancellations consume no actual dispatch slots");
  late.resolve(new Response("too late", { status: 429, headers: { "retry-after": "60" } }));
  await turn();
  const fresh = await paced.source.withBatch(request({ planId: "after-cancellation", deadlineMs: NOW + 700 }), async () => "fresh");
  assert.equal(fresh.value, "fresh", "Cancelled queues reserve no future slots and late 429 adds no cooldown");
  assert.equal(fresh.metrics.requests, 5);

  const timeoutReply = deferred();
  let timeoutFirst = true;
  const timed = fixture({ handle: () => {
    if (timeoutFirst) { timeoutFirst = false; return timeoutReply.promise; }
    return undefined;
  } });
  await assert.rejects(timed.source.withBatch(request({ deadlineMs: NOW + 25 }), async () => null), failure("timeout"));
  timeoutReply.resolve(new Response("too late", { status: 429, headers: { "retry-after": "60" } }));
  await turn();
  assert.equal((await timed.source.withBatch(request({ deadlineMs: NOW + 250 }), async () => "recovered")).value, "recovered");
});

test("scam RPC shares rate-limit cooldown with a later batch even when retries are exhausted", { timeout: 5_000 }, async () => {
  for (const kind of ["http", "json_rpc"]) {
    const starts = [];
    let first = true;
    const f = fixture({ limits: { maxRetries: 0, retryDelayMs: 80, maxRetryDelayMs: 80 }, handle: (rpc) => {
      starts.push(performance.now());
      if (!first) return undefined;
      first = false;
      return kind === "http" ? new Response("rate limited", { status: 429 })
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32005, message: "rate limited" } }));
    } });
    await assert.rejects(f.source.withBatch(request(), async () => null), failure("rpc_error"));
    assert.equal(f.calls.length, 1);
    const next = await f.source.withBatch(request({ planId: `after-${kind}` }), async () => "fresh");
    assert.equal(next.value, "fresh");
    assert.equal(next.metrics.retries, 0);
    assert.ok(starts[1] - starts[0] >= 77, `${kind}: the next batch must wait for the shared 80 ms cooldown`);
  }
});

test("scam RPC honors Retry-After seconds and HTTP dates beyond the backoff cap without retrying past its deadline", { timeout: 5_000 }, async () => {
  for (const retryAfter of ["1", new Date(Date.now() + 5_000).toUTCString()]) {
    const f = fixture({ limits: { maxRetries: 2, retryDelayMs: 5, maxRetryDelayMs: 10 }, handle: () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": retryAfter } }) });
    await assert.rejects(f.source.withBatch(request({ deadlineMs: NOW + 50 }), async () => null), failure("timeout"));
    assert.equal(f.calls.length, 1, "A 10 ms backoff cap must not shorten a longer server cooldown");
    await assert.rejects(f.source.withBatch(request({ planId: "still-cooling-down", deadlineMs: NOW + 25 }), async () => null), failure("timeout"));
    assert.equal(f.calls.length, 1, "The valid earlier 429 also delays a later batch instead of starting another burst");
  }
});

test("scam RPC discards drafts when checked head, reference, historical state or returned-log block hashes change", async () => {
  const cases = ["all_event_headers", "rpc_anchor"].flatMap((history) =>
    ["head", "reference", "historical", history === "rpc_anchor" ? "header" : "log"].map((mode) => ({ history, mode })));
  for (const { history, mode } of cases) {
    const reads = new Map();
    const f = fixture({ head: 25, verification: { history }, handle: (rpc) => {
      if (mode === "log" && rpc.method === "eth_getLogs") return ok(rpc, [{ ...rawLog(9), blockHash: blockHash(999) }]);
      if (rpc.method !== "eth_getBlockByNumber" || rpc.params[0] === "latest") return undefined;
      const n = BigInt(rpc.params[0]);
      const seen = (reads.get(n) ?? 0) + 1;
      reads.set(n, seen);
      if ((mode === "head" && n === 25n)
          || (seen > 1 && ((mode === "reference" && n === 23n) || (["historical", "header"].includes(mode) && n === 9n)))) {
        return ok(rpc, { ...header(n), hash: blockHash(999) });
      }
      return undefined;
    } });
    await assert.rejects(f.source.withBatch(request(), async (batch) => {
      if (mode === "head" || mode === "reference") return "must not escape";
      if (mode === "header") return batch.block("9");
      const pool = await batch.pool(0);
      return mode === "historical" ? batch.reserves(pool, "9") : batch.logs(pool, query("9", "9"));
    }), failure("reorg"));
  }
});

test("AH2 rpc_anchor omits only log-only final headers and keeps preflight aligned as event counts grow", async () => {
  for (const history of ["all_event_headers", "rpc_anchor"]) {
    for (const count of [1, 12]) {
      const heights = Array.from({ length: count }, (_, i) => i + 9);
      const f = fixture({ head: 25, verification: { history }, handle: (rpc) => rpc.method === "eth_getLogs"
        ? ok(rpc, heights.map((n) => ({ ...rawLog(n), blockTimestamp: q(n + 1000) }))) : undefined });
      let beforeFinal;
      const result = await f.source.withBatch(request(), async (batch) => {
        const scan = await batch.logs(await batch.pool(0), query("9", "20"));
        batch.preflightHeaders([]);
        beforeFinal = f.calls.length;
        return scan;
      });
      const finalHeights = f.calls.slice(beforeFinal).map(({ rpc }) => rpc.params[0]);
      const expected = history === "rpc_anchor" ? [25, 23] : [25, ...heights, 23];
      assert.deepEqual(finalHeights, expected.map(q));
      assert.equal(result.metrics.preflight.finalRecheckRequests, expected.length);
      assert.equal(result.metrics.preflight.minimumRemainingRequests, expected.length);
      assert.equal(result.metrics.preflight.uniqueLogBlocks, count);
      assert.equal(result.value.logs.length, count, "Fewer final headers must not truncate the log evidence");
      assert.equal(result.verification.history, history);
    }
  }
});

test("AH2 rpc_anchor budgets pending headers and restores their final checks without weakening on failure", async () => {
  for (const maxRequests of [11, 12]) {
    const reports = [];
    const f = fixture({ head: 25, limits: { maxRequests }, verification: { history: "rpc_anchor" },
      handle: (rpc) => rpc.method === "eth_getLogs" ? ok(rpc, [rawLog(9)]) : undefined });
    const work = f.source.withBatch(request({ onMetrics: (metric) => reports.push(metric) }), async (batch) => {
      await batch.logs(await batch.pool(0), query("9", "9"));
      batch.preflightHeaders(["9", "9"]);
      await batch.block("9");
      return "header-backed draft";
    });
    if (maxRequests === 12) {
      assert.equal((await work).value, "header-backed draft");
      assert.equal(f.calls.length, 12);
      assert.equal(reports[0].preflight.finalRecheckRequests, 3);
      assert.equal(f.calls.filter(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)).length, 2);
    } else {
      await assert.rejects(work, failure("resource_limit"));
      assert.equal(f.calls.length, 8);
      assert.equal(reports[0].preflight.additionalHeaderRequests, 1);
      assert.equal(reports[0].preflight.finalRecheckRequests, 3);
      assert.equal(reports[0].preflight.minimumRemainingRequests, 4);
      assert.deepEqual(reports[0].failure, { stage: "preflight", kind: "resource_limit" });
    }
  }
});

test("AH2 rpc_anchor exposes its log-only trust limit but rejects conflicts with observed headers", async () => {
  for (const order of ["log_only", "header_first", "log_first"]) {
    const f = fixture({ head: 25, verification: { history: "rpc_anchor" }, handle: (rpc) => rpc.method === "eth_getLogs"
      ? ok(rpc, [{ ...rawLog(9), blockHash: blockHash(999), blockTimestamp: q(1009) }]) : undefined });
    const work = f.source.withBatch(request(), async (batch) => {
      const pool = await batch.pool(0);
      if (order === "header_first") await batch.block("9");
      const scan = await batch.logs(pool, query("9", "9"));
      if (order === "log_first") await batch.block("9");
      return scan;
    });
    if (order === "log_only") {
      const result = await work;
      assert.equal(result.value.logs[0].blockHash, blockHash(999),
        "Anchor mode cannot detect a different backend branch without an individual log-header comparison");
      assert.equal(f.calls.some(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)), false);
    } else await assert.rejects(work, failure("reorg"), "Observed conflicting evidence remains terminal, never a missing chunk");
  }
  const lateProfile = fixture({ head: 25, verification: { history: "rpc_anchor" }, handle: (rpc) => {
    if (rpc.method === "eth_getLogs") return ok(rpc, [{ ...rawLog(9), blockTimestamp: q(1015) }]);
    if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(8)) return ok(rpc, { ...header(8), timestamp: q(1016) });
    return undefined;
  } });
  await assert.rejects(lateProfile.source.withBatch(request(), async (batch) => {
    const pool = await batch.pool(0);
    await batch.logs(pool, query("9", "9"));
    await batch.code(pool, "8");
    return "must not publish inverted history";
  }), failure("invalid_response"), "Later profile headers must still be ordered against skipped log-only evidence");
});

test("scam RPC verifies log timestamps against actual final headers before publishing drafts", async () => {
  for (const mode of ["valid", "wrong_time", "wrong_hash"]) {
    const f = fixture({ head: 25, handle: (rpc) => rpc.method === "eth_getLogs"
      ? ok(rpc, [{ ...rawLog(9), blockTimestamp: q(mode === "wrong_time" ? 1008 : 1009),
        ...(mode === "wrong_hash" ? { blockHash: blockHash(999) } : {}) }]) : undefined });
    let drafted = false;
    const work = f.source.withBatch(request(), async (batch) => {
      const scan = await batch.logs(await batch.pool(0), query("9", "9"));
      assert.equal(f.calls.filter(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)).length, 0);
      batch.preflightHeaders([]);
      drafted = true;
      return scan.logs[0].timestampMs;
    });
    if (mode === "valid") assert.equal((await work).value, 1_009_000);
    else await assert.rejects(work, failure(mode === "wrong_time" ? "invalid_response" : "reorg"));
    assert.equal(drafted, true, "unverified log times can form a draft, never a published result");
    assert.equal(f.calls.filter(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)).length, 1);
  }
});

test("scam RPC rejects log times beyond the reference or inconsistent across chunks and cached headers", async () => {
  const cases = ["all_event_headers", "rpc_anchor"].flatMap((history) =>
    ["future", "cross_chunk", "cached_header"].map((mode) => ({ history, mode })));
  for (const { history, mode } of cases) {
    const f = fixture({ verification: { history }, handle: (rpc) => {
      if (rpc.method !== "eth_getLogs") return undefined;
      if (mode === "cross_chunk") {
        const n = BigInt(rpc.params[0].fromBlock);
        return ok(rpc, [{ ...rawLog(n), blockTimestamp: q(n === 1n ? 2000 : 1999) }]);
      }
      return ok(rpc, [{ ...rawLog(9), blockTimestamp: q(mode === "future" ? 100_000 : 1008) }]);
    } });
    await assert.rejects(f.source.withBatch(request(), async (batch) => {
      const pool = await batch.pool(0);
      if (mode === "cached_header") await batch.block("9");
      return batch.logs(pool, mode === "cross_chunk" ? query("1", "10001") : query("9", "9"));
    }), failure("invalid_response"));
  }
});

test("scam RPC preflight counts uncached headers and all final checks without spending an impossible budget", async () => {
  for (const timestamped of [false, true]) {
    const reports = [];
    const f = fixture({ head: 25, limits: { maxRequests: 11 }, handle: (rpc) => rpc.method === "eth_getLogs"
      ? ok(rpc, [{ ...rawLog(9), ...(timestamped ? { blockTimestamp: q(1009) } : {}) }]) : undefined });
    const work = f.source.withBatch(request({ onMetrics: (value) => reports.push(value) }), async (batch) => {
      await batch.logs(await batch.pool(0), query("9", "9"));
      // Duplicate heights and the cached reference must not cost extra reads.
      batch.preflightHeaders(timestamped ? [] : ["9", "9", "23"]);
      return "verified";
    });
    if (timestamped) assert.equal((await work).value, "verified");
    else await assert.rejects(work, failure("resource_limit"));
    const metric = reports[0];
    assert.equal(reports.length, 1);
    assert.equal(metric.preflight.uniqueLogBlocks, 1);
    assert.equal(metric.preflight.timestampedLogBlocks, timestamped ? 1 : 0);
    assert.equal(metric.preflight.additionalHeaderRequests, timestamped ? 0 : 1);
    assert.equal(metric.preflight.finalRecheckRequests, 3);
    assert.equal(metric.preflight.minimumRemainingRequests, timestamped ? 3 : 4);
    assert.equal(metric.preflight.remainingRequestBudget, 3);
    assert.equal(metric.preflight.minimumPacingMs, 0);
    assert.ok(Object.isFrozen(metric.preflight));
    assert.equal(f.calls.length, timestamped ? 11 : 8);
    if (!timestamped) {
      assert.deepEqual(metric.failure, { stage: "preflight", kind: "resource_limit" });
      assert.equal(f.calls.filter(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)).length, 0);
    }
  }
  const pacedReports = [];
  const paced = fixture({ limits: { maxRequests: 200, minRequestIntervalMs: 2 } });
  await assert.rejects(paced.source.withBatch(request({ deadlineMs: NOW + 200,
    onMetrics: (value) => pacedReports.push(value) }), async (batch) => {
    batch.preflightHeaders(Array.from({ length: 80 }, (_, i) => String(i + 1)));
    return "must not publish";
  }), failure("resource_limit"));
  assert.equal(paced.calls.length, 3);
  assert.ok(pacedReports[0].preflight.minimumRemainingRequests <= pacedReports[0].preflight.remainingRequestBudget);
  assert.ok(pacedReports[0].preflight.minimumPacingMs >= pacedReports[0].preflight.remainingTimeMs);
  assert.deepEqual(pacedReports[0].failure, { stage: "preflight", kind: "resource_limit" });
});

test("AH1-2 final checks merge evidence roles, seal collection and check the reference last", async () => {
  for (const confirmDepth of [2, 0]) {
    const reference = 25 - confirmDepth;
    let collected = false, closedCollectionChecked = false, retainedBatch, beforeFinal;
    const f = fixture({ head: 25, handle: async (rpc) => {
      if (rpc.method === "eth_getLogs") return ok(rpc, [
        { ...rawLog(9), blockTimestamp: q(1009) },
        { ...rawLog(reference), blockTimestamp: q(reference + 1000) },
      ]);
      if (collected && !closedCollectionChecked && rpc.method === "eth_getBlockByNumber") {
        closedCollectionChecked = true;
        // Retaining the old handle cannot extend the frozen final-check set.
        assert.throws(() => retainedBatch.preflightHeaders(["8"]), failure("invalid_request"));
        await assert.rejects(retainedBatch.block("8"), failure("invalid_request"));
      }
      return undefined;
    } });
    const result = await f.source.withBatch(request({ confirmDepth }), async (batch) => {
      retainedBatch = batch;
      const pool = await batch.pool(0);
      await batch.block("9");
      await batch.reserves(pool, "9");
      await batch.code(pool, "9");
      await batch.logs(pool, query("9", String(reference)));
      await batch.block(String(reference));
      batch.preflightHeaders(["9", "9", String(reference)]);
      beforeFinal = f.calls.length;
      collected = true;
      return "verified draft";
    });
    const finalCalls = f.calls.slice(beforeFinal).map(({ rpc }) => rpc);
    const expected = confirmDepth === 0 ? [9, 25] : [25, 9, 23];
    assert.equal(result.value, "verified draft");
    assert.equal(closedCollectionChecked, true);
    assert.ok(finalCalls.every((rpc) => rpc.method === "eth_getBlockByNumber"));
    assert.deepEqual(finalCalls.map((rpc) => rpc.params[0]), expected.map(q),
      "A height shared by log, state and header evidence is checked once; head=reference is checked once too");
    assert.equal(result.metrics.preflight.additionalHeaderRequests, 0);
    assert.equal(result.metrics.preflight.finalRecheckRequests, finalCalls.length);
    assert.equal(result.metrics.preflight.minimumRemainingRequests, finalCalls.length);
    assert.equal(f.calls.some(({ rpc }) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(8)), false);
  }
});

test("AH1-2 final preflight includes later profile evidence before dispatching any final header", async () => {
  for (const maxRequests of [14, 12]) {
    const reports = [];
    const f = fixture({ head: 25, limits: { maxRequests }, handle: (rpc) => rpc.method === "eth_getLogs"
      ? ok(rpc, [{ ...rawLog(9), blockTimestamp: q(1009) }]) : undefined });
    let beforeFinal;
    const work = f.source.withBatch(request({ onMetrics: (metric) => reports.push(metric) }), async (batch) => {
      const pool = await batch.pool(0);
      await batch.logs(pool, query("9", "9"));
      batch.preflightHeaders([]); // The history-only snapshot has three final checks.
      await batch.code(pool, "8"); // Profile work adds a fourth evidence height and spends two requests.
      beforeFinal = f.calls.length;
      return "history and profile draft";
    });
    if (maxRequests === 14) assert.equal((await work).value, "history and profile draft");
    else await assert.rejects(work, failure("resource_limit"));
    assert.equal(beforeFinal, 10, "The earlier history preflight admits profile collection");
    assert.equal(reports.length, 1);
    const metric = reports[0];
    assert.equal(metric.preflight.additionalHeaderRequests, 0);
    assert.equal(metric.preflight.finalRecheckRequests, 4);
    assert.equal(metric.preflight.minimumRemainingRequests, 4);
    assert.equal(metric.preflight.remainingRequestBudget, maxRequests - beforeFinal);
    const finalCalls = f.calls.slice(beforeFinal).map(({ rpc }) => rpc);
    if (maxRequests === 14) {
      assert.deepEqual(finalCalls.map((rpc) => rpc.params[0]), [25, 9, 8, 23].map(q));
      assert.equal(finalCalls.length, metric.preflight.finalRecheckRequests);
    } else {
      assert.deepEqual(finalCalls, [], "A stale history-only estimate cannot start an unaffordable final pass");
      assert.deepEqual(metric.failure, { stage: "preflight", kind: "resource_limit" });
    }
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
    { limits: { ...base.limits, minRequestIntervalMs: -1 } },
    { limits: { ...base.limits, minRequestIntervalMs: 0.5 } },
    { limits: { ...base.limits, minRequestIntervalMs: 60_001 } },
    { limits: { ...base.limits, maxRetryDelayMs: -1 } },
    { limits: { ...base.limits, maxRetryDelayMs: 60_001 } },
    { limits: { ...base.limits, retryDelayMs: 20, maxRetryDelayMs: 10 } },
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

test("scam RPC emits one sanitized immutable terminal snapshot without trusting its observer", async () => {
  const received = [];
  const f = fixture();
  const result = await f.source.withBatch(request({ onMetrics: (metrics) => {
    received.push(metrics);
    throw new Error("observer must not alter success");
  } }), async () => "collected");
  assert.equal(result.value, "collected");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { ...result.metrics, outcome: "success" });
  assert.ok(Object.isFrozen(received[0]));
  assert.ok(Object.isFrozen(result.metrics));
  assert.throws(() => { received[0].requests = 123; }, TypeError);
  const asynchronous = await f.source.withBatch(request({ onMetrics: async () => {
    throw new Error("asynchronous observer rejection is diagnostic only");
  } }), async () => "still collected");
  assert.equal(asynchronous.value, "still collected");
  await turn();
  const failures = [];
  for (const mode of ["invalid", "chain", "resource", "pre-abort"]) {
    const local = fixture({ ...(mode === "resource" ? { limits: { maxRequests: 1 } } : {}),
      handle: mode === "chain" ? (rpc) => ok(rpc, "0x1") : undefined });
    const reports = [];
    const expected = { invalid: "invalid_request", chain: "chain_mismatch", resource: "resource_limit", "pre-abort": "aborted" }[mode];
    await assert.rejects(local.source.withBatch(request({
      ...(mode === "invalid" ? { subjects: [] } : {}),
      ...(mode === "pre-abort" ? { signal: AbortSignal.abort() } : {}),
      onMetrics: (metrics) => { reports.push(metrics); throw new Error("observer must not replace failure"); },
    }), async () => null), failure(expected));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "failed");
    assert.equal(reports[0].reason, expected);
    assert.equal(reports[0].requests, local.calls.length);
    assert.ok(Object.isFrozen(reports[0]));
    failures.push(reports[0]);
  }
  assert.doesNotMatch(JSON.stringify([received, failures]), /private|rpc\.invalid|x-test|headers|url/i);
});

test("scam RPC late replies cannot mutate or repeat an aborted metrics snapshot", async () => {
  const entered = deferred(), late = deferred();
  let rpcRequest;
  const reports = [];
  const f = fixture({ handle: (rpc) => { rpcRequest = rpc; entered.resolve(); return late.promise; } });
  const controller = new AbortController();
  const pending = f.source.withBatch(request({ signal: controller.signal, onMetrics: (metrics) => reports.push(metrics) }), async () => null);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, failure("aborted"));
  assert.equal(reports.length, 1);
  const terminal = JSON.stringify(reports);
  assert.equal(reports[0].requests, 1);
  assert.equal(reports[0].receivedBytes, 0);
  assert.equal(reports[0].failure.kind, "lifecycle");
  assert.equal(reports[0].failure.httpStatus, undefined);
  assert.equal(reports[0].failure.rpcCode, undefined);
  late.resolve(ok(rpcRequest, q(91342)));
  await turn();
  assert.equal(JSON.stringify(reports), terminal);
});

test("scam RPC terminal diagnostics distinguish header reads, final rechecks and sanitized error kinds", async () => {
  for (const mode of ["http", "json_rpc", "network", "decode", "internal"]) {
    const reports = [];
    const f = fixture({ limits: { maxRetries: 1 }, handle: (rpc) => {
      if (mode === "network" && rpc.method === "eth_chainId") throw new Error("SECRET network detail");
      if (mode === "http" && rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9)) {
        return new Response("SECRET http detail", { status: 429 });
      }
      // The checked head is reread by number only at finalization.
      if (rpc.method !== "eth_getBlockByNumber" || rpc.params[0] !== q(20_050)) return undefined;
      if (mode === "json_rpc") return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
        error: { code: -32000, message: "SECRET remote detail", data: { url: "private" } } }));
      if (mode === "decode") return ok(rpc, { ...header(20_050), hash: "SECRET invalid hash" });
      return undefined;
    } });
    await assert.rejects(f.source.withBatch(request({ onMetrics: (value) => reports.push(value) }), async (batch) => {
      if (mode === "internal") throw new TypeError("SECRET builder detail");
      return batch.block("9");
    }), failure(mode === "decode" ? "invalid_response" : "rpc_error"));
    assert.equal(reports.length, 1);
    const expected = {
      http: { stage: "block_header", kind: "http", method: "eth_getBlockByNumber", httpStatus: 429, attempt: 2 },
      json_rpc: { stage: "final_recheck", kind: "json_rpc", method: "eth_getBlockByNumber", rpcCode: -32000, attempt: 1 },
      network: { stage: "reference", kind: "network", method: "eth_chainId", attempt: 2 },
      decode: { stage: "final_recheck", kind: "validation", method: "eth_getBlockByNumber", attempt: 1 },
      internal: { stage: "collect", kind: "internal" },
    }[mode];
    assert.deepEqual(reports[0].failure, expected);
    assert.ok(Object.isFrozen(reports[0].failure));
    assert.throws(() => { reports[0].failure.stage = "changed"; }, TypeError);
    assert.doesNotMatch(JSON.stringify(reports), /SECRET|private|rpc\.invalid|params|message|stack/);
  }
});

test("scam RPC diagnostics do not promote recovered retries or missing log chunks to the terminal cause", async () => {
  let chainAttempts = 0;
  const reports = [];
  const f = fixture({ limits: { maxRetries: 1 }, handle: (rpc) => {
    if (rpc.method === "eth_chainId" && ++chainAttempts === 1) return new Response("retry", { status: 429 });
    if (rpc.method === "eth_getLogs") return new Response("missing chunk", { status: 500 });
    return undefined;
  } });
  const collect = async (batch) => {
    const scan = await batch.logs(await batch.pool(0), query("9", "9"));
    assert.equal(scan.missing.length, 1);
    return scan;
  };
  await f.source.withBatch(request({ onMetrics: (value) => reports.push(value) }), collect);
  assert.equal(reports[0].retries, 1);
  assert.equal(reports[0].failedChunks, 1);
  assert.equal(reports[0].failure, undefined);
  await assert.rejects(f.source.withBatch(request({ onMetrics: (value) => reports.push(value) }), async (batch) => {
    await collect(batch);
    throw new TypeError("SECRET unrelated processing error");
  }), failure("rpc_error"));
  assert.equal(reports[1].failedChunks, 1);
  assert.deepEqual(reports[1].failure, { stage: "collect", kind: "internal" });
  await f.source.withBatch(request({ onMetrics: (value) => reports.push(value) }), async () => null);
  assert.equal(reports[2].failure, undefined);

  // A deadline superseding HTTP 429 must not retain its status as the cause.
  let time = NOW;
  const expired = fixture({ clock: { now: () => time }, handle: () => {
    time = NOW + 5_000;
    return new Response("SECRET prior HTTP failure", { status: 429 });
  } });
  const timedOut = [];
  await assert.rejects(expired.source.withBatch(request({ onMetrics: (value) => timedOut.push(value) }), async () => null), failure("timeout"));
  assert.equal(timedOut[0].failure.kind, "lifecycle");
  assert.equal(timedOut[0].failure.httpStatus, undefined);
  assert.equal(timedOut[0].failure.rpcCode, undefined);
});

test("scam RPC reuses complete and empty history intervals, downloads only extensions and retains original boundary evidence", async () => {
  for (const history of [undefined, "rpc_anchor"]) for (const empty of [false, true]) {
    let head = 25, time = NOW;
    const f = fixture({ historyCache: historyCacheOptions(), verification: history ? { history } : undefined,
      clock: { now: () => time }, handle: (rpc) => {
        if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "latest") return ok(rpc, header(head));
        if (rpc.method !== "eth_getLogs") return undefined;
        const { fromBlock, toBlock } = rpc.params[0];
        return ok(rpc, (empty ? [] : [10, 14]).filter((n) => BigInt(n) >= BigInt(fromBlock) && BigInt(n) <= BigInt(toBlock))
          .map((n) => ({ ...rawLog(n), blockTimestamp: q(n + 1_000) })));
      } });
    const collect = async (from, to, planId) => {
      let finalStart;
      const result = await f.source.withBatch(request({ planId }), async (batch) => {
        const scan = await batch.logs(await batch.pool(0), query(from, to));
        finalStart = f.calls.length;
        return scan;
      });
      const finalHeights = f.calls.slice(finalStart).map(({ rpc }) => {
        assert.equal(rpc.method, "eth_getBlockByNumber");
        return BigInt(rpc.params[0]).toString();
      });
      assert.equal(result.metrics.preflight.finalRecheckRequests, finalHeights.length);
      assert.equal(finalHeights.at(-1), result.reference.block.number, "The pinned reference remains the last check");
      assert.equal(result.verification.history, history ?? "all_event_headers");
      return { ...result, finalHeights };
    };
    const first = await collect("9", "12", "cache:first");
    assert.equal(first.value.provenance, undefined);
    const beforeReuse = f.calls.length;
    time += 10;
    const reused = await collect("9", "12", "cache:fresh-plan");
    assert.equal(f.calls.slice(beforeReuse).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 0);
    assert.deepEqual(reused.value.logs, first.value.logs);
    assert.deepEqual(reused.value.missing, []);
    assert.deepEqual(reused.value.provenance, { reuse: "interval_cache", rawObservedAt: { fromMs: NOW, toMs: NOW } });
    assert.equal(reused.observedAt, NOW + 10, "A raw cache hit does not reuse the preceding batch identity or time");
    assert.ok(reused.finalHeights.includes("9") && reused.finalHeights.includes("12"));
    assert.equal(reused.finalHeights.includes("10"), !empty && history !== "rpc_anchor",
      "Caching preserves the configured treatment of log-only headers");

    const beforeExtension = f.calls.length;
    time += 10;
    head = 27;
    const extended = await collect("10", "14", "cache:new-reference");
    assert.deepEqual(f.calls.slice(beforeExtension).filter(({ rpc }) => rpc.method === "eth_getLogs")
      .map(({ rpc }) => [BigInt(rpc.params[0].fromBlock).toString(), BigInt(rpc.params[0].toBlock).toString()]), [["13", "14"]]);
    assert.deepEqual(extended.value.logs.map((log) => log.blockNumber), empty ? [] : ["10", "14"]);
    assert.deepEqual(extended.value.provenance, { reuse: "interval_cache", rawObservedAt: { fromMs: NOW, toMs: NOW + 20 } });
    assert.ok(extended.finalHeights.includes("9") && extended.finalHeights.includes("12"),
      "Both original cache boundaries are rechecked even when the requested interval clips the start");
  }
});

test("scam RPC charges cached logs to the batch budget and separates cached scopes and topic filters", async () => {
  const otherTopic = `0x${"77".repeat(32)}`;
  const f = fixture({ head: 25, historyCache: historyCacheOptions(), limits: { maxLogs: 1 }, handle: (rpc) => {
    if (rpc.method !== "eth_getLogs") return undefined;
    return ok(rpc, [{ ...rawLog(10), blockTimestamp: q(1010), address: rpc.params[0].address,
      topics: [rpc.params[0].topics[0][0]] }]);
  } });
  const collect = (filter) => f.source.withBatch(request(), async (batch) => batch.logs(await batch.pool(0), filter));
  await collect(query("9", "12"));
  const beforeOverflow = f.calls.length;
  await assert.rejects(f.source.withBatch(request(), async (batch) => {
    const pool = await batch.pool(0);
    assert.equal((await batch.logs(pool, query("9", "12"))).provenance.reuse, "interval_cache");
    return batch.logs(pool, query("9", "12"));
  }), failure("resource_limit"));
  assert.equal(f.calls.slice(beforeOverflow).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 0,
    "Cached entries count even when no response is downloaded");
  for (const filter of [{ ...query("9", "12"), topics: [otherTopic] }, { ...query("9", "12"), scope: "factory" }]) {
    const before = f.calls.length;
    const result = await collect(filter);
    assert.equal(result.value.provenance, undefined);
    assert.equal(f.calls.slice(before).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 1);
    assert.equal(result.value.logs[0].address, filter.scope === "factory" ? FACTORY : POOL);
    assert.deepEqual(result.value.logs[0].topics, filter.topics);
  }
});

test("scam RPC invalidates cached history on boundary changes or head rollback and can subsequently fetch cold", async () => {
  for (const mode of ["boundary", "rollback"]) {
    let head = 25, changedBoundary = false;
    const f = fixture({ historyCache: historyCacheOptions(), verification: { history: "rpc_anchor" }, handle: (rpc) => {
      if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "latest") return ok(rpc, header(head));
      if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(9) && changedBoundary) {
        return ok(rpc, { ...header(9), hash: blockHash(999) });
      }
      if (rpc.method === "eth_getLogs") return ok(rpc, [{ ...rawLog(10), blockTimestamp: q(1010) }]);
      return undefined;
    } });
    const collect = () => f.source.withBatch(request(), async (batch) => batch.logs(await batch.pool(0), query("9", "12")));
    await collect();
    if (mode === "boundary") changedBoundary = true;
    else head = 24;
    await assert.rejects(collect(), failure("reorg"));
    const beforeCold = f.calls.length;
    const cold = await collect();
    assert.equal(cold.value.provenance, undefined);
    assert.equal(f.calls.slice(beforeCold).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 1,
      "An invalidated interval is downloaded again under the new stable reference");
  }
});

test("scam RPC never commits earlier cache drafts or late replies from an aborted batch", async () => {
  const entered = deferred(), late = deferred();
  let delayedRequest, delayFactory = true;
  const f = fixture({ head: 25, historyCache: historyCacheOptions(), handle: (rpc) => {
    if (rpc.method !== "eth_getLogs") return undefined;
    if (rpc.params[0].address === FACTORY && delayFactory) {
      delayedRequest = rpc;
      entered.resolve();
      return late.promise;
    }
    return ok(rpc, [{ ...rawLog(10), address: rpc.params[0].address, blockTimestamp: q(1010) }]);
  } });
  const collect = async (batch) => {
    const pool = await batch.pool(0);
    const pair = await batch.logs(pool, query("9", "12"));
    const factory = await batch.logs(pool, { ...query("9", "12"), scope: "factory" });
    return [pair, factory];
  };
  const controller = new AbortController();
  const rejected = assert.rejects(f.source.withBatch(request({ signal: controller.signal }), collect), failure("aborted"));
  await entered.promise;
  controller.abort();
  await rejected;
  delayFactory = false;
  late.resolve(ok(delayedRequest, [{ ...rawLog(10), address: FACTORY, blockTimestamp: q(1010) }]));
  await turn();
  const beforeFresh = f.calls.length;
  const fresh = await f.source.withBatch(request({ planId: "after-abort" }), collect);
  assert.ok(fresh.value.every((scan) => scan.provenance === undefined));
  assert.equal(f.calls.slice(beforeFresh).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 2,
    "Neither the completed pair draft nor the late factory response became reusable");
});

test("scam RPC prevents stale-generation batches from publishing or deleting replacement cache entries", async () => {
  let head = 25;
  const ready = deferred(), release = deferred();
  const f = fixture({ historyCache: historyCacheOptions(), handle: (rpc) => {
    if (rpc.method === "eth_getBlockByNumber" && rpc.params[0] === "latest") return ok(rpc, header(head));
    if (rpc.method === "eth_getLogs") return ok(rpc, BigInt(rpc.params[0].fromBlock) <= 10n
      && BigInt(rpc.params[0].toBlock) >= 10n ? [{ ...rawLog(10), blockTimestamp: q(1010) }] : []);
    return undefined;
  } });
  const collect = async (batch) => batch.logs(await batch.pool(0), query("9", "12"));
  await f.source.withBatch(request(), collect);
  const stale = assert.rejects(f.source.withBatch(request({ planId: "old-generation" }), async (batch) => {
    // Completing the extension creates an unpublished cache draft before the
    // next batch invalidates its generation.
    const scan = await batch.logs(await batch.pool(0), query("9", "13"));
    assert.equal(scan.provenance.reuse, "interval_cache");
    ready.resolve();
    await release.promise;
    return scan;
  }), failure("reorg"));
  await ready.promise;
  head = 24;
  await assert.rejects(f.source.withBatch(request({ planId: "rollback" }), collect), failure("reorg"));
  const replacement = await f.source.withBatch(request({ planId: "new-generation" }), collect);
  assert.equal(replacement.value.provenance, undefined);
  release.resolve();
  await stale;
  const beforeReuse = f.calls.length;
  const reused = await f.source.withBatch(request({ planId: "after-stale-failure" }), collect);
  assert.equal(reused.value.provenance.reuse, "interval_cache");
  assert.equal(f.calls.slice(beforeReuse).filter(({ rpc }) => rpc.method === "eth_getLogs").length, 0,
    "Rejecting an older generation must leave the newly verified cache intact");
});
