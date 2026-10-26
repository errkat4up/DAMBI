import test from "node:test";
import assert from "node:assert/strict";
import { createScamHistoryStore } from "../../dist/adapters/scam-history-store.js";

const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const block = (n) => ({ number: String(n), hash: hash(n), parentHash: hash(n - 1), timestampMs: n * 1_000 });
const log = (n) => ({ address: `0x${"11".repeat(20)}`, blockNumber: String(n), blockHash: hash(n),
  timestampMs: n * 1_000, transactionHash: hash(n + 1_000), transactionIndex: 0, logIndex: 0,
  topics: [hash(99)], data: "0x" });
const entry = (key = "pool:topic:mode", overrides = {}) => ({ key, fromBlock: "10", toBlock: "20",
  start: block(10), end: block(20), logs: [log(12), log(17)], rawObservedAt: { fromMs: 800, toMs: 900 },
  storedAt: 1_000, ...overrides });
const options = (overrides = {}) => ({ maxEntries: 3, maxBytes: 100_000, ttlMs: 100, maxBlockSpan: 100, ...overrides });
const get = (store, key = "pool:topic:mode", from = "10", to = "20", reference = "20", now = 1_000) =>
  store.get(key, from, to, reference, now);

test("history store owns complete scans and keeps empty hits and clipped source provenance immutable", () => {
  const store = createScamHistoryStore(options());
  const source = entry();
  assert.equal(store.put(source, store.generation), true);
  source.logs[0].topics[0] = hash(100);
  source.logs[0].timestampMs = 123;
  source.start.hash = hash(999);
  source.rawObservedAt.fromMs = 999;
  source.logs.push(log(18));
  const hit = get(store, undefined, "15", "24", "24");
  assert.deepEqual(hit.logs.map((value) => value.blockNumber), ["17"]);
  assert.deepEqual(hit.missing, [{ fromBlock: "21", toBlock: "24" }]);
  assert.deepEqual(hit.entry.rawObservedAt, { fromMs: 800, toMs: 900 });
  assert.equal(hit.entry.start.number, "10", "A clipped hit preserves the original verified scan boundary");
  assert.equal(hit.entry.start.hash, hash(10));
  assert.equal(hit.entry.logs[0].topics[0], hash(99));
  assert.equal(hit.entry.logs[0].timestampMs, 12_000);
  for (const value of [hit, hit.logs, hit.missing, hit.entry, hit.entry.start, hit.entry.end,
    hit.entry.logs, hit.entry.logs[0], hit.entry.logs[0].topics, hit.entry.rawObservedAt]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { hit.logs[0].topics[0] = hash(101); }, TypeError);
  assert.equal(store.put(entry("empty", { logs: [] }), store.generation), true);
  const empty = get(store, "empty");
  assert.deepEqual(empty.logs, []);
  assert.deepEqual(empty.missing, [], "A successful empty scan is a hit, not missing coverage");
  assert.equal(get(store, "other-filter"), undefined);
});

test("history store computes inclusive intersections and at most two gaps without borrowing future scans", () => {
  const store = createScamHistoryStore(options());
  store.put(entry(), store.generation);
  for (const [from, to, intersection, missing] of [
    [5, 25, [10, 20], [[5, 9], [21, 25]]],
    [5, 10, [10, 10], [[5, 9]]],
    [20, 25, [20, 20], [[21, 25]]],
    [12, 17, [12, 17], []],
  ]) {
    const hit = get(store, undefined, String(from), String(to), "25");
    assert.deepEqual([hit.fromBlock, hit.toBlock], intersection.map(String));
    assert.deepEqual(hit.missing, missing.map(([a, b]) => ({ fromBlock: String(a), toBlock: String(b) })));
  }
  assert.equal(get(store, undefined, "21", "25", "25"), undefined);
  assert.equal(get(store, undefined, "10", "19", "19"), undefined,
    "An older reference cannot borrow part of a scan completed against a newer endpoint");
  assert.equal(get(store, undefined, "10", "19", "20").toBlock, "19");
});

test("history store expires by original TTL and block retention without refreshing observations on hits", () => {
  const store = createScamHistoryStore(options({ maxBlockSpan: 20 }));
  store.put(entry(), store.generation);
  assert.equal(get(store, undefined, "10", "20", "39", 1_099).entry.storedAt, 1_000);
  assert.equal(get(store, undefined, "10", "20", "39", 1_100), undefined);
  assert.equal(store.size, 0);
  store.put(entry(), store.generation);
  assert.equal(get(store, undefined, "10", "20", "40"), undefined);
  assert.equal(store.size, 0);
  assert.equal(store.put(entry("too-wide", { fromBlock: "1", start: block(1), toBlock: "21", end: block(21) }), store.generation), false);
  store.put(entry(), store.generation);
  assert.equal(get(store, undefined, "10", "20", "20", 999), undefined);
  assert.ok(get(store), "A query with an older clock must not erase a newer entry");
});

test("history store bounds encoded bytes and entry count while oversized results remain uncached", () => {
  const baseline = createScamHistoryStore(options());
  baseline.put(entry("꼬리😀"), baseline.generation);
  const actualBytes = new TextEncoder().encode(JSON.stringify(get(baseline, "꼬리😀").entry)).byteLength;
  assert.equal(baseline.bytes, actualBytes);
  const exact = createScamHistoryStore(options({ maxBytes: actualBytes }));
  assert.equal(exact.put(entry("꼬리😀"), exact.generation), true);
  assert.equal(exact.put(entry("larger", { logs: Array.from({ length: 20 }, () => log(12)) }), exact.generation), false);
  assert.ok(get(exact, "꼬리😀"), "Storage failure does not discard an existing usable scan");
  const small = createScamHistoryStore(options({ maxBytes: actualBytes - 1 }));
  assert.equal(small.put(entry("꼬리😀"), small.generation), false);
  const lru = createScamHistoryStore(options({ maxEntries: 2 }));
  for (const key of ["a", "b"]) lru.put(entry(key), lru.generation);
  get(lru, "a");
  lru.put(entry("c"), lru.generation);
  assert.equal(get(lru, "b"), undefined);
  assert.ok(get(lru, "a") && get(lru, "c"));
  assert.equal(lru.size, 2);
  assert.ok(lru.bytes <= options().maxBytes);
});

test("history store generations prevent late reinsertion and older scans cannot displace newer completion", () => {
  const store = createScamHistoryStore(options());
  const oldGeneration = store.generation;
  store.put(entry(), oldGeneration);
  const staged = store.stage(entry("new", { storedAt: 1_101 }));
  assert.equal(Object.isFrozen(staged), true);
  assert.equal(store.size, 1, "Staging neither stores candidates nor prunes older entries");
  assert.ok(get(store));
  store.invalidateAll();
  assert.equal(store.generation, oldGeneration + 1);
  assert.equal(store.bytes, 0);
  assert.equal(store.size, 0);
  assert.equal(store.put(entry(), oldGeneration), false);
  assert.equal(store.commit([staged], oldGeneration), false);
  assert.equal(get(store), undefined);
  const ready = store.stage(entry("ready"));
  assert.equal(store.size, 0);
  assert.equal(store.commit([ready], store.generation), true);
  assert.ok(get(store, "ready"));
  store.put(entry("pool:topic:mode", { toBlock: "25", end: block(25), storedAt: 1_005 }), store.generation);
  assert.equal(store.put(entry(), store.generation), false);
  assert.equal(get(store, undefined, "10", "25", "25", 1_005).entry.toBlock, "25");
  const other = createScamHistoryStore(options());
  assert.equal(get(other), undefined, "Separate sources never share stored material");
});

test("history store rejects invalid configuration and malformed range contracts", () => {
  for (const overrides of [{ maxEntries: 0 }, { maxBytes: -1 }, { ttlMs: Infinity }, { maxBlockSpan: 1.5 }]) {
    assert.throws(() => createScamHistoryStore(options(overrides)), { code: "INVALID_CONFIG" });
  }
  const store = createScamHistoryStore(options());
  assert.throws(() => get(store, undefined, "21", "20"), { code: "INVALID_REQUEST" });
  assert.throws(() => get(store, undefined, "10", "21", "20"), { code: "INVALID_REQUEST" });
  assert.throws(() => store.put(entry("bad", { start: block(9) }), store.generation), { code: "INVALID_REQUEST" });
  assert.throws(() => store.put(entry("bad", { rawObservedAt: { fromMs: 900, toMs: 800 } }), store.generation), { code: "INVALID_REQUEST" });
  assert.throws(() => store.put(entry("bad", { logs: [log(21)] }), store.generation), { code: "INVALID_REQUEST" });
  const other = createScamHistoryStore(options());
  const candidate = store.stage(entry("owned"));
  const foreign = other.stage(entry("foreign"));
  assert.throws(() => store.commit([candidate, foreign], store.generation), { code: "INVALID_REQUEST" });
  assert.equal(store.size, 0, "A foreign candidate rejects the whole commit before any insertion");
  assert.throws(() => store.commit([{ ...candidate }], store.generation), { code: "INVALID_REQUEST" });
});
