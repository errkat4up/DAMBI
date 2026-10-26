import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createScamRpcSource } from "../../dist/adapters/scam-rpc.js";
import { buildPoolHistory, SCAM_DATA_BUILDER_VERSION, V2_SYNC_TOPIC } from "../../dist/adapters/scam-pool-history.js";

// All RPC responses are local fixtures; these tests never contact a network.
const POOL = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;
const QUOTE = `0x${"44".repeat(20)}`;
const NOW = 10_000_000_000_000;
const q = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const blockHash = (n) => `0x${word(BigInt(n) + 100n)}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const time = (n) => (1_000 + n) * 1_000;
const header = (n) => ({ number: q(n), hash: blockHash(n), parentHash: blockHash(BigInt(n) - 1n), timestamp: q(BigInt(n) + 1_000n) });
const ok = (rpc, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
const failure = (reason) => ({ name: "ScamRpcError", reason });
const subject = () => ({ chainId: 91342, venue: "uniswap_v2", pool: POOL, factory: FACTORY,
  token: TOKEN, quoteToken: QUOTE, actionPaths: ["actions[0]"] });
const limits = { maxPoints: 100, maxLogs: 100, maxBlockLookups: 100, blockTimeHintMs: 1_000 };
const params = (target, overrides = {}) => ({ subject: target, referenceGroupId: "history:test", confirmDepth: 0,
  dataSchema: "scam.pool_history/1", builderVersion: SCAM_DATA_BUILDER_VERSION,
  lookbackSec: 10, warmupSec: 0, metrics: ["quote_reserve", "price_quote_per_token"],
  candidateResolutions: [{ bucketMs: 1_000, gridOriginMs: 0 }], ...overrides });
const sync = (n, index, reserve0, reserve1) => ({ address: POOL, blockNumber: q(n), blockHash: blockHash(n),
  transactionHash: `0x${word(BigInt(n) + 1_000_000n)}`, transactionIndex: "0x0", logIndex: q(index),
  topics: [V2_SYNC_TOPIC], data: `0x${word(reserve0)}${word(reserve1)}`, removed: false });
const withTimestamp = (log) => ({ ...log, blockTimestamp: q(BigInt(log.blockNumber) + 1_000n) });

function fixture({ head = 20, target = subject(), token0 = target.token, token1 = target.quoteToken,
  seed = [100n, 200n], decimals = [18, 6], logs = [], maxBlocksPerQuery = 10_000,
  headerFor = header, handle, verification } = {}) {
  const calls = [], preflights = [];
  const source = createScamRpcSource({ chainId: 91342, endpoint: { rpcUrl: "https://rpc.invalid/history" },
    factories: [target.factory], quoteTokens: [target.quoteToken], clock: { now: () => NOW }, verification,
    limits: { maxRequests: 300, maxResponseBytes: 65_536, maxTotalResponseBytes: 1_000_000,
      maxLogs: 100, maxBlocksPerQuery, concurrency: 2, maxRetries: 0, retryDelayMs: 0 },
    fetch: async (_url, init) => {
      const rpc = JSON.parse(init.body);
      calls.push(rpc);
      const override = await handle?.(rpc);
      if (override !== undefined) return override;
      if (rpc.method === "eth_chainId") return ok(rpc, q(91342));
      if (rpc.method === "eth_getBlockByNumber") return ok(rpc, headerFor(rpc.params[0] === "latest" ? BigInt(head) : BigInt(rpc.params[0])));
      if (rpc.method === "eth_getLogs") {
        const { fromBlock, toBlock } = rpc.params[0];
        return ok(rpc, logs.filter((log) => BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock)));
      }
      if (rpc.method === "eth_call") {
        const { to, data } = rpc.params[0];
        const selector = data.slice(0, 10);
        const result = {
          "0x0dfe1681": addressWord(token0), "0xd21220a7": addressWord(token1),
          "0xc45a0155": addressWord(target.factory), "0xe6a43905": addressWord(target.pool),
          "0x0902f1ac": `0x${word(seed[0])}${word(seed[1])}${word(0)}`,
          "0x313ce567": `0x${word(to === token0 ? decimals[0] : decimals[1])}`,
        }[selector];
        assert.notEqual(result, undefined, `Unexpected fake eth_call selector: ${selector}`);
        return ok(rpc, result);
      }
      throw new Error(`Unexpected fake RPC method: ${rpc.method}`);
    } });
  return { calls, preflights, build: async (overrides = {}, budget = {}) => source.withBatch({ planId: "plan:history",
    referenceGroupId: "history:test", confirmDepth: 0, deadlineMs: NOW + 5_000, subjects: [target] }, async (batch) => {
    const pool = await batch.pool(0);
    return buildPoolHistory({ ...batch, preflightHeaders(numbers) {
      preflights.push([...numbers]);
      batch.preflightHeaders(numbers);
    } }, pool, params(pool.subject, overrides), { ...limits, ...budget });
  }) };
}

test("pool history replays a saved GIWA Sync without mistaking its synthetic surroundings for observations", async () => {
  const evidence = JSON.parse(readFileSync(new URL("../../../../fixtures/sdk/giwa-sf0/rpc-evidence.json", import.meta.url), "utf8"));
  const receipt = evidence.queries.find((entry) => entry.request.method === "eth_getTransactionReceipt").response.result;
  const observed = receipt.logs.find((log) => log.topics[0] === V2_SYNC_TOPIC);
  const observedNumber = BigInt(observed.blockNumber), observedTime = BigInt(observed.blockTimestamp);
  const target = { ...subject(), pool: observed.address, factory: evidence.observations.swap.factory,
    token: evidence.observations.swap.path[1], quoteToken: evidence.observations.swap.path[0] };
  // Only the Sync itself is an unchanged saved RPC observation. Identity,
  // seed reserves and surrounding headers are synthetic local test responses.
  const f = fixture({ head: observedNumber + 2n, target, seed: [1n, 2n], decimals: [18, 18], logs: [observed],
    headerFor: (n) => ({ number: q(n), hash: n === observedNumber ? observed.blockHash : blockHash(n),
      parentHash: n - 1n === observedNumber ? observed.blockHash : blockHash(n - 1n),
      timestamp: q(observedTime + n - observedNumber) }) });
  const { value } = await f.build();
  const at = value.histories[0].history.points.find((point) => point.tMs === Number(observedTime) * 1_000);
  assert.deepEqual(at, { tMs: Number(observedTime) * 1_000,
    reserveToken: BigInt("0x0f89976860bc7d4f69").toString(), reserveQuote: BigInt("0x0122dc88427359e4").toString(),
    decimalsToken: 18, decimalsQuote: 18 });
  assert.equal(value.reference.block.number, (observedNumber + 2n).toString());
  assert.deepEqual(value.coverage.missing, []);
  const logCalls = f.calls.filter((rpc) => rpc.method === "eth_getLogs");
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].params[0].address, target.pool);
  assert.deepEqual(logCalls[0].params[0].topics, [[V2_SYNC_TOPIC]]);
});

test("pool history seeds from historical reserves and uses each block's final Sync on distinct frozen grids", async () => {
  const last = sync(12, 2, 150, 300);
  const f = fixture({ logs: [last, sync(12, 1, 120, 240), { ...last }] });
  const grids = [{ bucketMs: 2_000, gridOriginMs: 0 }, { bucketMs: 3_000, gridOriginMs: 500 }];
  const { value } = await f.build({ candidateResolutions: grids });
  assert.equal(value.histories.length, 2);
  assert.deepEqual(value.histories.map(({ gridOriginMs, history }) => [history.bucketMs, gridOriginMs]), [[2_000, 0], [3_000, 500]]);
  const first = value.histories[0].history, second = value.histories[1].history;
  assert.deepEqual(first.points.map((point) => point.tMs), [10, 12, 14, 16, 18, 20].map(time));
  assert.deepEqual(first.points.map((point) => point.reserveToken), ["100", "150", "150", "150", "150", "150"]);
  assert.deepEqual(second.points.map((point) => point.tMs), [1_011_500, 1_014_500, 1_017_500]);
  assert.equal(second.points[0].reserveToken, "100");
  assert.equal(second.points[1].reserveToken, "150");
  assert.equal(second.points.some((point) => point.tMs === time(20)), false, "No extra off-grid point at T");
  assert.deepEqual(first.warmup, { fromMs: time(10), complete: true });
  assert.deepEqual(first.missing, second.missing);
  const seedCalls = f.calls.filter((rpc) => rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac");
  assert.deepEqual(seedCalls.map((rpc) => rpc.params[1]), [q(10)]);
  const logCalls = f.calls.filter((rpc) => rpc.method === "eth_getLogs");
  assert.equal(logCalls.length, 1, "Candidate grids reuse one raw query");
  assert.deepEqual(logCalls[0].params[0], { address: POOL, fromBlock: q(11), toBlock: q(20), topics: [[V2_SYNC_TOPIC]] });
  const duplicate = await f.build({ candidateResolutions: [grids[0], { ...grids[0] }] });
  assert.equal(duplicate.value.histories.length, 1);
  assert.deepEqual(duplicate.value.histories[0].history.points, first.points);
});

test("pool history maps reversed token order without rounding raw integers or dropping observed zeros", async () => {
  const large = (1n << 112n) - 1n;
  const f = fixture({ token0: QUOTE, token1: TOKEN, seed: [0n, large], decimals: [6, 18],
    logs: [sync(15, 0, large - 1n, 0n)] });
  const { value } = await f.build();
  const points = value.histories[0].history.points;
  assert.deepEqual(points[0], { tMs: time(10), reserveToken: large.toString(), reserveQuote: "0", decimalsToken: 18, decimalsQuote: 6 });
  assert.deepEqual(points.find((point) => point.tMs === time(15)), { tMs: time(15), reserveToken: "0",
    reserveQuote: (large - 1n).toString(), decimalsToken: 18, decimalsQuote: 6 });
  assert.equal(points.length, 11);
  assert.deepEqual(value.coverage.missing, []);
});

test("pool history uses optional log times for identical grids while keeping actual final header checks", async () => {
  const logs = [sync(12, 0, 120, 240), sync(17, 0, 170, 340)];
  const fallback = fixture({ logs }), timed = fixture({ logs: logs.map(withTimestamp) });
  const grids = { candidateResolutions: [{ bucketMs: 2_000, gridOriginMs: 0 }, { bucketMs: 3_000, gridOriginMs: 500 }] };
  const expected = await fallback.build(grids);
  // Three boundary/reference lookups consume this local budget. The supplied
  // log times are draft evidence, not fake headers or extra header lookups.
  const actual = await timed.build(grids, { maxBlockLookups: 3 });
  assert.deepEqual(actual.value, expected.value);
  assert.deepEqual(timed.preflights, [[]]);
  assert.deepEqual(fallback.preflights, [["12", "17"]]);
  for (const n of [12, 17]) {
    const reads = (f) => f.calls.filter((rpc) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(n)).length;
    assert.equal(reads(timed), 1, "Timestamped logs still require an actual final header");
    assert.equal(reads(fallback), 2, "Missing timestamps retain the original lookup and final check");
  }
  const mixed = fixture({ logs: [withTimestamp(logs[0]), logs[1]] });
  assert.deepEqual((await mixed.build(grids)).value, expected.value);
  assert.deepEqual(mixed.preflights, [["17"]]);

  const anchorTimed = fixture({ logs: logs.map(withTimestamp), verification: { history: "rpc_anchor" } });
  assert.deepEqual((await anchorTimed.build(grids, { maxBlockLookups: 3 })).value, expected.value);
  const anchorMixed = fixture({ logs: [withTimestamp(logs[0]), logs[1]], verification: { history: "rpc_anchor" } });
  assert.deepEqual((await anchorMixed.build(grids)).value, expected.value);
  assert.deepEqual(anchorMixed.preflights, [["17"]]);
  for (const n of [12, 17]) {
    const reads = (f) => f.calls.filter((rpc) => rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(n)).length;
    assert.equal(reads(anchorTimed), 0, "Anchor mode omits timestamped log-only headers without changing grids");
    assert.equal(reads(anchorMixed), n === 17 ? 2 : 0, "Missing timestamps still need an actual header and final recheck");
  }
});

test("pool history carries raw chunk gaps through the millisecond before a later Sync on every candidate", async () => {
  const make = (unavailableGapHeader = false, timestamped = false) => fixture({ maxBlocksPerQuery: 4,
    logs: [sync(12, 0, 120, 240), sync(19, 0, 190, 380)].map((log) => timestamped ? withTimestamp(log) : log), handle: (rpc) => {
      if (rpc.method === "eth_getLogs" && rpc.params[0].fromBlock === q(15)) return new Response("unavailable", { status: 500 });
      if (unavailableGapHeader && rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(15)) return new Response("no header", { status: 500 });
      return undefined;
    } });
  const settings = { lookbackSec: 8, warmupSec: 2,
    candidateResolutions: [{ bucketMs: 1_000, gridOriginMs: 0 }, { bucketMs: 2_000, gridOriginMs: 0 }] };
  const { value } = await make().build(settings);
  const timed = make(false, true);
  assert.deepEqual((await timed.build(settings)).value, value);
  assert.deepEqual(timed.preflights, [["15"]], "Missing-range boundaries always use actual headers");
  const interval = { fromMs: time(15) - 1, toMs: time(19) - 1 };
  assert.deepEqual(value.coverage.missing, [{ ...interval, reason: "rpc_error" }]);
  assert.deepEqual(value.histories.map(({ history }) => history.missing), [[interval], [interval]]);
  assert.deepEqual(value.histories[0].history.points.map((point) => point.tMs), [10, 11, 12, 13, 14, 19, 20].map(time));
  assert.equal(value.histories[0].history.points.find((point) => point.tMs === time(19)).reserveToken, "190");
  assert.equal(value.histories[0].history.warmup.complete, true, "The gap is after the warm-up horizon");
  await assert.rejects(make(true).build(), failure("rpc_error"), "A missing block timestamp is not manufactured from the one-second hint");
});

test("pool history distinguishes complete empty logs from failed seed history and recovers only on a later Sync", async () => {
  const failSeed = (rpc) => rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac"
    ? new Response("archive unavailable", { status: 500 }) : undefined;
  const empty = (await fixture().build()).value;
  assert.equal(empty.histories[0].history.points.length, 11);
  assert.ok(empty.histories[0].history.points.every((point) => point.reserveToken === "100" && point.reserveQuote === "200"));
  assert.deepEqual(empty.coverage.missing, []);
  const absent = (await fixture({ handle: failSeed }).build()).value;
  assert.deepEqual(absent.histories[0].history.points, []);
  assert.deepEqual(absent.coverage.missing, [{ fromMs: time(10), toMs: time(20), reason: "rpc_error" }]);
  assert.equal(absent.histories[0].history.warmup.complete, false);
  const recovered = (await fixture({ handle: failSeed, logs: [sync(15, 0, 150, 300)] }).build()).value;
  assert.deepEqual(recovered.coverage.missing, [{ fromMs: time(10), toMs: time(15) - 1, reason: "rpc_error" }]);
  assert.deepEqual(recovered.histories[0].history.points.map((point) => point.tMs), [15, 16, 17, 18, 19, 20].map(time));
  assert.equal(recovered.histories[0].history.warmup.complete, false);
  const preGenesis = fixture({ head: 5, logs: [sync(2, 0, 20, 40)] });
  const initial = (await preGenesis.build({ lookbackSec: 1_010 }, { maxPoints: 1_100 })).value;
  assert.equal(initial.coverage.fromBlock, "0");
  assert.deepEqual(initial.coverage.missing, [{ fromMs: 0, toMs: time(2) - 1, reason: "unavailable_history" }]);
  assert.deepEqual(initial.histories[0].history.points.map((point) => point.tMs), [2, 3, 4, 5].map(time));
  assert.equal(initial.histories[0].history.warmup.complete, false);
  assert.equal(preGenesis.calls.filter((rpc) => rpc.method === "eth_call" && rpc.params[0].data === "0x0902f1ac").length, 0);
});

test("pool history treats malformed Sync blocks as unavailable instead of accepting their later same-block values", async () => {
  const malformed = { ...sync(14, 0, 140, 280), data: `0x${word(1n << 112n)}${word(280)}` };
  const logs = [sync(14, 1, 141, 282), malformed, sync(17, 0, 170, 340)];
  const { value } = await fixture({ logs }).build();
  assert.deepEqual((await fixture({ logs: logs.map(withTimestamp) }).build()).value, value);
  assert.deepEqual(value.coverage.missing, [{ fromMs: time(14) - 1, toMs: time(17) - 1, reason: "unavailable_history" }]);
  assert.deepEqual(value.histories[0].history.points.map((point) => point.tMs), [10, 11, 12, 13, 17, 18, 19, 20].map(time));
  assert.equal(value.histories[0].history.points.find((point) => point.tMs === time(17)).reserveToken, "170");
});

test("pool history reports unavailable decimals without an invented 18-decimal fallback or unnecessary log fetch", async () => {
  const f = fixture({ handle: (rpc) => rpc.method === "eth_call" && rpc.params[0].to === TOKEN && rpc.params[0].data === "0x313ce567"
    ? ok(rpc, "0x") : undefined });
  const { value } = await f.build();
  assert.deepEqual(value.coverage.unavailable, [{ field: "token0.decimals", reason: "unavailable_history" }]);
  assert.deepEqual(value.coverage.missing, [{ fromMs: time(10), toMs: time(20), reason: "unavailable_history" }]);
  assert.deepEqual(value.histories[0].history.points, []);
  assert.equal(value.histories[0].history.warmup.complete, false);
  assert.equal(f.calls.filter((rpc) => rpc.method === "eth_getLogs").length, 0);
  assert.equal(f.calls.filter((rpc) => rpc.method === "eth_call" && rpc.params[0].data === "0x313ce567").length, 2);
});

test("pool history rejects incompatible requests and impossible budgets before data work and does not truncate logs", async () => {
  let dataCalls = 0;
  const noData = async () => { dataCalls++; throw new Error("Data work must not start"); };
  const pool = { subject: subject(), token0: TOKEN, token1: QUOTE };
  const batch = { referenceGroupId: "history:test", reference: {
    block: { number: "20", hash: blockHash(20), timestampMs: time(20) }, requiredConfirmDepth: 0,
  }, block: noData, reserves: noData, decimals: noData, logs: noData,
  preflightHeaders: () => { throw new Error("Preflight must not start for invalid input"); } };
  for (const override of [
    { builderVersion: "unknown/99" }, { dataSchema: "scam.pool_history/99" }, { referenceGroupId: "other" },
    { confirmDepth: 1 }, { subject: { ...subject(), token: QUOTE } }, { lookbackSec: 86_401 },
    { candidateResolutions: [{ bucketMs: 0, gridOriginMs: 0 }] },
  ]) await assert.rejects(buildPoolHistory(batch, pool, params(pool.subject, override), limits), failure("invalid_request"));
  await assert.rejects(buildPoolHistory(batch, pool, params(pool.subject), { ...limits, maxPoints: 10 }), failure("resource_limit"));
  await assert.rejects(buildPoolHistory(batch, pool, params(pool.subject), { ...limits, blockTimeHintMs: 0 }), failure("invalid_config"));
  assert.equal(dataCalls, 0);
  await assert.rejects(fixture({ logs: [sync(12, 0, 120, 240), sync(13, 0, 130, 260)] }).build({}, { maxLogs: 1 }), failure("resource_limit"));
  const limited = fixture({ logs: [sync(12, 0, 120, 240), sync(13, 0, 130, 260)] });
  await assert.rejects(limited.build({}, { maxBlockLookups: 4 }), failure("resource_limit"));
  assert.deepEqual(limited.preflights, [["12", "13"]]);
  assert.equal(limited.calls.some((rpc) => rpc.method === "eth_getBlockByNumber" && [q(12), q(13)].includes(rpc.params[0])), false,
    "Known excess time-index work fails before the first event header, not midway through it");
});
