import test from "node:test";
import assert from "node:assert/strict";
import {
  address, hash, quantity, decodeBlock, decodeLogs,
  decodeAddressWord, decodeReserves, decodeDecimals, decodeCode,
} from "../../dist/adapters/scam-rpc-codec.js";

const ADDRESS = `0x${"ab".repeat(20)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_HASH = `0x${"ef".repeat(32)}`;
const TX_HASH = `0x${"12".repeat(32)}`;
const TOPIC = `0x${"34".repeat(32)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const invalid = (call) => assert.throws(call, { name: "AdapterError", code: "INVALID_RESPONSE" });
const block = () => ({ number: "0xa", hash: BLOCK_HASH, parentHash: OTHER_HASH, timestamp: "0x10" });
const log = (overrides = {}) => ({
  address: ADDRESS, blockNumber: "0xa", blockHash: BLOCK_HASH,
  transactionHash: TX_HASH, transactionIndex: "0x1", logIndex: "0x2",
  removed: false, topics: [TOPIC], data: "0xab00", ...overrides,
});
const logs = (value, maxLogs = 20) => decodeLogs(value, ADDRESS, 10n, 11n, [TOPIC], maxLogs);

test("scam RPC headers require mined identity, the requested number and a safe timestamp", () => {
  assert.deepEqual(decodeBlock({ ...block(), hash: `0x${"CD".repeat(32)}` }, 10n), {
    number: "10", hash: BLOCK_HASH, timestampMs: 16_000, parentHash: OTHER_HASH,
  });
  for (const bad of [
    null, { ...block(), number: null }, { ...block(), hash: null },
    { ...block(), parentHash: "0x12" }, { ...block(), number: "0x0a" },
    { ...block(), timestamp: "0x10\n" },
    { ...block(), timestamp: quantity(BigInt(Number.MAX_SAFE_INTEGER) / 1_000n + 1n) },
  ]) invalid(() => decodeBlock(bad));
  invalid(() => decodeBlock(block(), 11n));
});

test("scam RPC logs normalize, sort and deduplicate without fabricating entries", () => {
  const first = log({ transactionIndex: "0x0", logIndex: "0x0" });
  const second = log();
  const third = log({ blockNumber: "0xb", blockHash: OTHER_HASH, logIndex: "0x0" });
  const result = logs([
    third, second, first,
    { ...first, address: `0x${"AB".repeat(20)}`, blockHash: `0x${"CD".repeat(32)}`, data: "0xAB00" },
  ]);
  assert.deepEqual(result.map((entry) => [entry.blockNumber, entry.transactionIndex, entry.logIndex]), [
    ["10", 0, 0], ["10", 1, 2], ["11", 1, 0],
  ]);
  assert.equal(result[0].address, ADDRESS);
  assert.equal(result[0].data, "0xab00");
  assert.deepEqual(logs([]), []);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]) && Object.isFrozen(result[0].topics));
});

test("scam RPC logs reject scope violations, incomplete identities, conflicting duplicates and overflow", () => {
  for (const override of [
    { removed: true }, { removed: undefined }, { address: `0x${"11".repeat(20)}` },
    { blockNumber: "0x9" }, { blockNumber: "0xc" }, { blockNumber: null },
    { blockHash: null }, { transactionHash: "0x" }, { transactionIndex: "0x00" },
    { logIndex: quantity(BigInt(Number.MAX_SAFE_INTEGER) + 1n) },
    { topics: [] }, { topics: [OTHER_HASH] }, { topics: [TOPIC, "0x12"] },
    { topics: Array(5).fill(TOPIC) }, { data: "0xabc" }, { data: "0xab\n" },
  ]) invalid(() => logs([log(override)]));
  for (const override of [
    { transactionHash: OTHER_HASH }, { transactionIndex: "0x3" }, { data: "0x" },
    { blockHash: OTHER_HASH }, { topics: [TOPIC, OTHER_HASH] },
  ]) invalid(() => logs([log(), log(override)]));
  invalid(() => logs([log(), log({ blockHash: OTHER_HASH, logIndex: "0x3" })]));
  assert.throws(() => logs([log(), log()], 1), { name: "AdapterError", code: "RESPONSE_TOO_LARGE" });
  invalid(() => logs(null));
});

test("scam RPC optional log timestamps retain only safe, consistent observations", () => {
  assert.equal(Object.hasOwn(logs([log()])[0], "timestampMs"), false);
  assert.equal(logs([log({ blockTimestamp: "0x0" })])[0].timestampMs, 0);
  const timed = log({ blockTimestamp: "0x10" });
  const result = logs([log({ blockNumber: "0xb", blockHash: OTHER_HASH, blockTimestamp: "0x11" }), timed, timed]);
  assert.deepEqual(result.map((entry) => entry.timestampMs), [16_000, 17_000]);
  for (const bad of [null, undefined, 16, "0x", "0x00", "0x10\n",
    quantity(BigInt(Number.MAX_SAFE_INTEGER) / 1_000n + 1n)]) {
    invalid(() => logs([log({ blockTimestamp: bad })]));
  }
  // Distinct entries in one block cannot disagree; duplicates cannot silently
  // gain or lose a time observation either.
  invalid(() => logs([timed, log({ logIndex: "0x3", blockTimestamp: "0x11" })]));
  invalid(() => logs([timed, log()]));
  invalid(() => logs([log(), timed]));
  invalid(() => logs([timed, log({ blockNumber: "0xb", blockHash: OTHER_HASH, blockTimestamp: "0xf" })]));
  assert.equal(logs([timed, log({ logIndex: "0x3" })])[1].timestampMs, undefined);
});

test("scam RPC ABI returns enforce exact padding and widths while retaining valid zeros", () => {
  assert.equal(decodeAddressWord(`0x${"0".repeat(24)}${"AB".repeat(20)}`), ADDRESS);
  for (const bad of [ADDRESS, `0x${"1".repeat(24)}${"ab".repeat(20)}`, `0x${word(0)}`]) {
    invalid(() => decodeAddressWord(bad));
  }
  assert.deepEqual(decodeReserves(`0x${word(0)}${word((1n << 112n) - 1n)}${word((1n << 32n) - 1n)}`), {
    reserve0: "0", reserve1: ((1n << 112n) - 1n).toString(), blockTimestampLast: 4_294_967_295,
  });
  for (const bad of [
    `0x${word(0)}${word(1)}`, `0x${word(1n << 112n)}${word(0)}${word(0)}`,
    `0x${word(0)}${word(1n << 112n)}${word(0)}`, `0x${word(0)}${word(0)}${word(1n << 32n)}`,
  ]) invalid(() => decodeReserves(bad));
  assert.equal(decodeDecimals(`0x${word(0)}`), 0);
  assert.equal(decodeDecimals(`0x${word(255)}`), 255);
  for (const bad of ["0x12", `0x${word(256)}`, `0x${word(18)}00`]) invalid(() => decodeDecimals(bad));
});

test("scam RPC primitives distinguish address, hash, byte data and quantity encodings", () => {
  assert.ok(address(ADDRESS));
  assert.equal(address(`0x${"00".repeat(20)}`), false);
  assert.equal(address(`${ADDRESS}\n`), false);
  assert.ok(hash(BLOCK_HASH));
  assert.ok(hash(`0x${word(0)}`));
  assert.equal(hash(ADDRESS), false);
  assert.equal(decodeCode("0x"), "0x");
  assert.equal(decodeCode("0xAB00"), "0xab00");
  for (const bad of [null, "0x0", "0xGG", "0x00\n"]) invalid(() => decodeCode(bad));
  assert.equal(quantity(0n), "0x0");
  assert.equal(quantity(16n), "0x10");
  assert.throws(() => quantity(-1n), TypeError);
});
