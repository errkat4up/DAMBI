import test from "node:test";
import assert from "node:assert/strict";
import { verifyPoolCreation } from "../../dist/adapters/scam-pool-creation.js";
import { PAIR_CREATED_TOPIC, ADMIN_EVENT_TOPICS } from "../../dist/adapters/scam-profile-codec.js";

const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;
const POOL = `0x${"cc".repeat(20)}`;
const FACTORY = `0x${"dd".repeat(20)}`;
const OTHER = `0x${"ee".repeat(20)}`;
const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const TX = `0x${"ef".repeat(32)}`;
const TIME = 1_700_000_123_000;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const indexed = (value) => `0x${word(value)}`;
const data = (...values) => `0x${values.map(word).join("")}`;
const upper = (value) => `0x${value.slice(2).toUpperCase()}`;

function fixture() {
  return {
    expected: {
      chainId: 1, venue: "uniswap_v2", pool: POOL, factory: FACTORY,
      token: A, quoteToken: B, actionPaths: [],
    },
    observed: { chainId: 1, block: { number: "123", hash: HASH, timestampMs: TIME } },
    supplied: {
      chainId: 1,
      logs: [{
        address: FACTORY, blockNumber: "123", blockHash: HASH,
        transactionHash: TX, transactionIndex: 2, logIndex: 7,
        removed: false, topics: [PAIR_CREATED_TOPIC, indexed(A), indexed(B)],
        data: data(POOL, 39),
      }],
    },
  };
}
const run = ({ expected, observed, supplied }) => verifyPoolCreation(expected, observed, supplied);
function assertUnknown(result) {
  assert.equal(result.kind, "unknown");
  assert.ok(result.reasons.includes("age_unknown"));
  assert.equal(Object.hasOwn(result, "poolCreatedMs"), false);
  assert.equal(Object.hasOwn(result, "evidence"), false);
  assert.equal(Object.hasOwn(result, "ageSec"), false);
}

test("exact binding returns the actual creation header timestamp and DAMBI evidence", () => {
  const result = run(fixture());
  assert.deepEqual(result, {
    kind: "verified", poolCreatedMs: TIME,
    evidence: {
      kind: "factory_pair_created", factory: FACTORY,
      createdAt: { number: "123", hash: HASH, timestampMs: TIME },
      transactionHash: TX, logIndex: 7,
    },
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
  assert.ok(Object.isFrozen(result.evidence.createdAt));
});

const mismatches = [
  ["evidence chain", (f) => { f.supplied.chainId = 2; }],
  ["header chain", (f) => { f.observed.chainId = 2; }],
  ["independent expected chain", (f) => { f.expected.chainId = 2; }],
  ["factory emitter", (f) => { f.supplied.logs[0].address = OTHER; }],
  ["independent expected factory", (f) => { f.expected.factory = OTHER; }],
  ["event signature", (f) => { f.supplied.logs[0].topics[0] = ADMIN_EVENT_TOPICS.owner_changed; }],
  ["decoded target pool", (f) => { f.supplied.logs[0].data = data(OTHER, 39); }],
  ["independent expected pool", (f) => { f.expected.pool = OTHER; }],
  ["token0", (f) => { f.supplied.logs[0].topics[1] = indexed(OTHER); }],
  ["token1", (f) => { f.supplied.logs[0].topics[2] = indexed(OTHER); }],
  ["event block number", (f) => { f.supplied.logs[0].blockNumber = "124"; }],
  ["header block number", (f) => { f.observed.block.number = "124"; }],
  ["event block hash", (f) => { f.supplied.logs[0].blockHash = OTHER_HASH; }],
  ["header block hash", (f) => { f.observed.block.hash = OTHER_HASH; }],
  ["optional log timestamp", (f) => { f.supplied.logs[0].timestampMs = TIME + 1000; }],
];
for (const [name, change] of mismatches) {
  test(`rejects isolated ${name} mismatch`, () => {
    const f = fixture();
    change(f);
    assertUnknown(run(f));
  });
}

test("missing evidence never substitutes zero or a lookup timestamp", () => {
  for (const change of [
    (f) => { f.supplied = undefined; },
    (f) => { f.supplied = null; },
    (f) => { f.supplied.logs = []; },
    (f) => { f.observed = undefined; },
    (f) => { f.observed = null; },
    (f) => { delete f.observed.block; },
    (f) => { delete f.observed.block.timestampMs; f.supplied.logs[0].timestampMs = TIME; },
  ]) {
    const f = fixture();
    change(f);
    assertUnknown(run(f));
  }
});

test("removed, absent removal status and ambiguous candidates remain unknown", () => {
  for (const change of [
    (f) => { f.supplied.logs[0].removed = true; },
    (f) => { delete f.supplied.logs[0].removed; },
    (f) => { f.supplied.logs[0].removed = "false"; },
    (f) => { f.supplied.logs.push(structuredClone(f.supplied.logs[0])); },
    (f) => { f.supplied.logs.push({ ...f.supplied.logs[0], logIndex: 8 }); },
    (f) => { f.supplied.logs.push(null); },
  ]) {
    const f = fixture();
    change(f);
    assertUnknown(run(f));
  }
});

test("malformed event envelopes and ABI data cannot establish creation", () => {
  const patches = [
    { address: "0x00" }, { blockNumber: "0123" }, { blockNumber: "0x7b" },
    { blockNumber: "123\n" }, { blockHash: "0x00" }, { transactionHash: "0x00" },
    { transactionIndex: -1 }, { logIndex: 0.5 }, { logIndex: Number.MAX_SAFE_INTEGER + 1 },
    { topics: [] }, { topics: null }, { topics: new Array(3) },
    { topics: [PAIR_CREATED_TOPIC, indexed(A)] },
    { topics: [PAIR_CREATED_TOPIC, `0x1${"0".repeat(63)}`, indexed(B)] },
    { topics: [PAIR_CREATED_TOPIC, indexed(0), indexed(B)] },
    { data: data(0, 39) }, { data: data(POOL) }, { data: `${data(POOL, 39)}00` },
    { data: `${data(POOL, 39)}\n` }, { data: "0xzz" }, { data: null },
    { timestampMs: undefined }, { timestampMs: NaN },
  ];
  for (const patch of patches) {
    const f = fixture();
    Object.assign(f.supplied.logs[0], patch);
    assertUnknown(run(f));
  }
  for (const logs of [null, {}, [null], [{}], new Array(1)]) {
    const f = fixture();
    f.supplied.logs = logs;
    assertUnknown(run(f));
  }
});

test("malformed independent context is rejected", () => {
  for (const change of [
    (f) => { f.expected = null; },
    (f) => { f.expected.chainId = 0; },
    (f) => { f.expected.venue = "other"; },
    (f) => { f.expected.pool = "0x00"; },
    (f) => { f.expected.quoteToken = A; },
    (f) => { f.observed.chainId = NaN; },
    (f) => { f.supplied.chainId = "1"; },
    (f) => { f.observed.block.hash = "0x00"; },
    (f) => { f.observed.block.number = "123\n"; },
    ...[-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1700000123000"].map(
      (timestamp) => (f) => { f.observed.block.timestampMs = timestamp; }),
  ]) {
    const f = fixture();
    change(f);
    assertUnknown(run(f));
  }
});

test("case normalization and reversed subject token orientation preserve identity", () => {
  const f = fixture();
  for (const key of ["pool", "factory", "token", "quoteToken"]) f.expected[key] = upper(f.expected[key]);
  [f.expected.token, f.expected.quoteToken] = [f.expected.quoteToken, f.expected.token];
  const log = f.supplied.logs[0];
  for (const key of ["address", "blockHash", "transactionHash", "data"]) log[key] = upper(log[key]);
  log.topics = log.topics.map(upper);
  f.observed.block.hash = upper(HASH);
  log.timestampMs = TIME;
  assert.deepEqual(run(f), run(fixture()));
});

test("uses only the supplied header time, including a genuinely observed zero", () => {
  for (const timestampMs of [0, TIME + 50_000]) {
    const f = fixture();
    f.observed.block.timestampMs = timestampMs;
    assert.equal(run(f).poolCreatedMs, timestampMs);
  }
});

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test("verification is deterministic, accepts frozen inputs and owns its result", () => {
  const f = fixture();
  const before = structuredClone(f);
  const first = run(freezeDeep(f));
  assert.deepEqual(run(f), first);
  assert.deepEqual(f, before);
  const mutable = fixture();
  const result = run(mutable);
  mutable.observed.block.timestampMs = 99;
  mutable.supplied.logs[0].logIndex = 99;
  assert.deepEqual(result, first);
});
