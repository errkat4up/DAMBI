import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeLogs } from "../../dist/adapters/scam-rpc-codec.js";
import { PAIR_CREATED_TOPIC, ADMIN_EVENT_TOPICS, decodePairCreated, decodeAdminEvent } from "../../dist/adapters/scam-profile-codec.js";

const A = `0x${"11".repeat(20)}`;
const B = `0x${"22".repeat(20)}`;
const PAIR = `0x${"33".repeat(20)}`;
const ZERO = `0x${"00".repeat(20)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const indexed = (value) => `0x${word(value)}`;
const data = (...values) => `0x${values.map(word).join("")}`;
const log = (topics, payload = "0x") => ({
  address: PAIR, blockNumber: "10", blockHash: `0x${"44".repeat(32)}`,
  transactionHash: `0x${"55".repeat(32)}`, transactionIndex: 0, logIndex: 0,
  topics, data: payload,
});
const pairLog = () => log([PAIR_CREATED_TOPIC, indexed(A), indexed(B)], data(PAIR, 1));
const adminLogs = (a = A, b = B) => ({
  owner_changed: log([ADMIN_EVENT_TOPICS.owner_changed, indexed(a), indexed(b)]),
  proxy_upgraded: log([ADMIN_EVENT_TOPICS.proxy_upgraded, indexed(a)]),
  admin_changed: log([ADMIN_EVENT_TOPICS.admin_changed], data(a, b)),
  paused: log([ADMIN_EVENT_TOPICS.paused], data(a)),
  unpaused: log([ADMIN_EVENT_TOPICS.unpaused], data(a)),
});

test("profile codec decodes the recorded GIWA factory PairCreated and preserves uint256 precision", () => {
  const evidence = JSON.parse(readFileSync(new URL("../../../../fixtures/sdk/giwa-sf0/rpc-evidence.json", import.meta.url), "utf8"));
  const raw = evidence.queries.flatMap((query) => query.response?.result?.logs ?? [])
    .find((entry) => entry.topics[0] === PAIR_CREATED_TOPIC);
  assert.ok(raw, "The existing factory receipt must contain PairCreated evidence.");
  const [entry] = decodeLogs([raw], raw.address, BigInt(raw.blockNumber), BigInt(raw.blockNumber), [PAIR_CREATED_TOPIC], 1);
  assert.deepEqual(decodePairCreated(entry), {
    token0: "0x0274c57358c3a6b8a08b7297ba51665c303a471f",
    token1: "0x4200000000000000000000000000000000000006",
    pair: "0xcaafb95fc292c10a526f03fa480407bb438dac67", pairCount: "39",
  });
  const maximum = (1n << 256n) - 1n;
  assert.equal(decodePairCreated({ ...pairLog(), data: data(PAIR, maximum) }).pairCount, maximum.toString());
  assert.ok(Object.isFrozen(decodePairCreated(entry)));
});

test("profile codec recognizes the five exact standard administrator event layouts", () => {
  for (const [kind, entry] of Object.entries(adminLogs())) assert.equal(decodeAdminEvent(entry), kind);
  assert.ok(Object.isFrozen(ADMIN_EVENT_TOPICS));
  // ABI encoding is case-insensitive; normalizing fields is not a capability claim.
  const mixed = pairLog();
  mixed.topics = mixed.topics.map((topic) => `0x${topic.slice(2).toUpperCase()}`);
  assert.deepEqual(decodePairCreated(mixed), { token0: A, token1: B, pair: PAIR, pairCount: "1" });
});

test("profile codec permits zero administrator addresses but never zero pool or token identities", () => {
  for (const [kind, entry] of Object.entries(adminLogs(ZERO, ZERO))) assert.equal(decodeAdminEvent(entry), kind);
  assert.equal(decodeAdminEvent(adminLogs(A, ZERO).owner_changed), "owner_changed");
  for (const entry of [
    { ...pairLog(), topics: [PAIR_CREATED_TOPIC, indexed(ZERO), indexed(B)] },
    { ...pairLog(), topics: [PAIR_CREATED_TOPIC, indexed(A), indexed(ZERO)] },
    { ...pairLog(), data: data(ZERO, 1) },
  ]) assert.equal(decodePairCreated(entry), undefined);
});

test("profile codec rejects malformed address padding, extra data and incorrect indexed layouts", () => {
  const badAddress = `0x1${"0".repeat(63)}`;
  for (const entry of [
    { ...pairLog(), topics: [PAIR_CREATED_TOPIC, badAddress, indexed(B)] },
    { ...pairLog(), topics: [PAIR_CREATED_TOPIC, indexed(A), badAddress] },
    { ...pairLog(), topics: [...pairLog().topics, indexed(A)] },
    { ...pairLog(), topics: pairLog().topics.slice(0, 2) },
    { ...pairLog(), data: `${badAddress}${word(1)}` },
    { ...pairLog(), data: data(PAIR) },
    { ...pairLog(), data: `${pairLog().data}00` },
    { ...pairLog(), data: `${pairLog().data}\n` },
  ]) assert.equal(decodePairCreated(entry), undefined);
  for (const entry of Object.values(adminLogs())) {
    assert.equal(decodeAdminEvent({ ...entry, topics: [...entry.topics, indexed(A)] }), undefined);
    assert.equal(decodeAdminEvent({ ...entry, data: `${entry.data}00` }), undefined);
    if (entry.data !== "0x") assert.equal(decodeAdminEvent({ ...entry, data: entry.data.slice(0, -2) }), undefined);
  }
  for (const entry of [
    log([ADMIN_EVENT_TOPICS.owner_changed, badAddress, indexed(B)]),
    log([ADMIN_EVENT_TOPICS.owner_changed, indexed(A), badAddress]),
    log([ADMIN_EVENT_TOPICS.proxy_upgraded, badAddress]),
    log([ADMIN_EVENT_TOPICS.admin_changed], `${badAddress}${word(B)}`),
    log([ADMIN_EVENT_TOPICS.admin_changed], `0x${word(A)}${badAddress.slice(2)}`),
    log([ADMIN_EVENT_TOPICS.paused], badAddress),
    log([ADMIN_EVENT_TOPICS.unpaused], badAddress),
    log([ADMIN_EVENT_TOPICS.paused, indexed(A)]),
    log([ADMIN_EVENT_TOPICS.owner_changed], data(A, B)),
  ]) assert.equal(decodeAdminEvent(entry), undefined);
});

test("profile codec returns no event for unknown signatures or malformed event envelopes", () => {
  for (const entry of [
    log([`0x${"66".repeat(32)}`], data(A)), log([]), null, {},
    { topics: null, data: "0x" }, log([null]), log(["0x1"]),
    { ...pairLog(), data: null }, { ...pairLog(), data: "0xzz" },
  ]) {
    assert.equal(decodePairCreated(entry), undefined);
    assert.equal(decodeAdminEvent(entry), undefined);
  }
  assert.equal(decodeAdminEvent(pairLog()), undefined);
  assert.equal(decodePairCreated(adminLogs().owner_changed), undefined);
});
