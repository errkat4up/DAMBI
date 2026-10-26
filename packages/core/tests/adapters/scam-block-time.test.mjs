import test from "node:test";
import assert from "node:assert/strict";
import { createBlockTimeIndex } from "../../dist/adapters/scam-block-time.js";

const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, "0")}`;
const header = (number, timestampMs) => ({
  number: BigInt(number).toString(), hash: hash(BigInt(number) + 1n), timestampMs,
  parentHash: hash(number),
});
function fixture(times, options = {}) {
  const baseNumber = options.baseNumber ?? BigInt(times.length - 1);
  const get = options.get ?? ((number) => header(number, times[Number(number)]));
  const reference = options.reference ?? get(baseNumber);
  const requested = [];
  const batch = {
    reference: { block: reference },
    block: async (number) => {
      requested.push(number);
      return get(BigInt(number));
    },
  };
  const index = createBlockTimeIndex(batch, { maxBlocks: options.maxBlocks ?? 30, blockTimeHintMs: options.hint ?? 1_000 });
  return { index, requested, batch };
}
const reason = (value) => ({ name: "ScamRpcError", reason: value });
const bounds = (result) => [result.before?.number ?? null, result.after?.number ?? null];

test("block time hints find regular boundaries using actual neighboring headers", async () => {
  const { index, requested } = fixture(Array.from({ length: 101 }, (_, n) => 50_000 + n * 1_000));
  const found = await index.atOrBefore(90_500);
  assert.deepEqual(bounds(found), ["40", "41"]);
  assert.deepEqual(requested, ["100", "40", "41"]);
  assert.equal(found.before.timestampMs, 90_000);
  assert.equal(found.after.timestampMs, 91_000);
  assert.ok(Object.isFrozen(found) && Object.isFrozen(found.before));
});

test("block time search handles irregular intervals and chooses the last equal timestamp", async () => {
  const times = [1_000, 2_000, 2_000, 2_000, 2_500, 8_000, 9_000, 20_000, 21_000];
  const { index } = fixture(times, { hint: 7_000 });
  assert.deepEqual(bounds(await index.atOrBefore(2_000)), ["3", "4"]);
  assert.deepEqual(bounds(await index.atOrBefore(7_999)), ["4", "5"]);
  assert.deepEqual(bounds(await index.atOrBefore(20_500)), ["7", "8"]);
  const undershot = fixture([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000], { hint: 100 });
  assert.deepEqual(bounds(await undershot.index.atOrBefore(6_500)), ["5", "6"]);
});

test("block time boundaries handle genesis, the reference and heights above Number precision", async () => {
  const { index } = fixture([5_000, 6_000, 7_000]);
  assert.deepEqual(bounds(await index.atOrBefore(4_999)), [null, "0"]);
  assert.deepEqual(bounds(await index.atOrBefore(5_000)), ["0", "1"]);
  assert.deepEqual(bounds(await index.atOrBefore(7_000)), ["2", null]);
  const single = fixture([5_000]);
  assert.deepEqual(bounds(await single.index.atOrBefore(4_999)), [null, "0"]);
  assert.deepEqual(bounds(await single.index.atOrBefore(5_000)), ["0", null]);
  const baseNumber = 9_007_199_254_741_000n;
  const huge = fixture([], {
    baseNumber,
    get: (n) => header(n, 1_000_000 - Number(baseNumber - n) * 1_000),
  });
  assert.deepEqual(bounds(await huge.index.atOrBefore(995_500)), [(baseNumber - 5n).toString(), (baseNumber - 4n).toString()]);
});

test("block time validation rejects invalid inputs, inconsistent headers and exhausted budgets", async () => {
  const { index, batch, requested } = fixture([1_000, 2_000, 3_000]);
  for (const options of [null, { maxBlocks: 0, blockTimeHintMs: 1 }, { maxBlocks: 2, blockTimeHintMs: 0 }, { maxBlocks: 1.5, blockTimeHintMs: 1 }]) {
    assert.throws(() => createBlockTimeIndex(batch, options), reason("invalid_config"));
  }
  for (const bad of ["-1", "01", "0x1", "1\n", "3", "9".repeat(79)]) {
    assert.throws(() => index.block(bad), reason("invalid_request"));
  }
  for (const time of [-1, 3_001, 0.5, NaN, Infinity]) {
    await assert.rejects(index.atOrBefore(time), reason("invalid_request"));
  }
  assert.equal(requested.length, 0);
  const limited = fixture([1_000, 2_000, 3_000], { maxBlocks: 2 });
  await assert.rejects(limited.index.atOrBefore(1_500), reason("resource_limit"));
  assert.equal(limited.requested.length, 2);

  const inconsistent = fixture([1_000, 3_000, 2_000, 4_000]);
  await inconsistent.index.block("1");
  await assert.rejects(inconsistent.index.block("2"), reason("invalid_response"));
  const wrongNumber = fixture([1_000, 2_000], {
    reference: header(1, 2_000), get: (n) => ({ ...header(n, Number(n) * 1_000), number: "0" }),
  });
  await assert.rejects(wrongNumber.index.block("1"), reason("invalid_response"));
  const changed = fixture([1_000, 2_000], { reference: { ...header(1, 2_000), hash: hash(999) } });
  await assert.rejects(changed.index.atOrBefore(2_000), reason("reorg"));
});

test("block time callers share cached and in-flight headers without retrying failed heights", async () => {
  let release;
  let calls = 0;
  const base = header(2, 3_000);
  const batch = {
    reference: { block: base },
    block: (number) => {
      calls++;
      if (number === "1") return new Promise((resolve) => { release = () => resolve(header(1, 2_000)); });
      if (number === "0") return Promise.reject(new Error("unavailable"));
      return Promise.resolve(base);
    },
  };
  const index = createBlockTimeIndex(batch, { maxBlocks: 3, blockTimeHintMs: 1_000 });
  const first = index.block("1");
  const second = index.block("1");
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, await second);
  assert.equal(await index.block("1"), await first);
  assert.deepEqual(bounds(await index.atOrBefore(2_000)), ["1", "2"]);
  assert.equal(calls, 2);
  const failed = index.block("0");
  await assert.rejects(failed, /unavailable/);
  assert.equal(index.block("0"), failed);
  await assert.rejects(index.block("0"), /unavailable/);
  assert.equal(calls, 3);
});

test("block time draft log evidence neither invents headers nor bypasses time consistency and lookup budgets", async () => {
  const log = (n, timestampMs) => ({ blockNumber: String(n), blockHash: hash(BigInt(n) + 1n), timestampMs });
  const f = fixture([1_000, 2_000, 3_000, 4_000, 5_000], { maxBlocks: 2 });
  assert.equal(f.index.logTime(log(2, 3_000)), 3_000);
  assert.deepEqual(f.requested, [], "Draft time evidence is not a header lookup");
  assert.doesNotThrow(() => f.index.preflight(["2", "2", "4"]));
  const actual = await f.index.block("2");
  assert.equal(actual.parentHash, hash(2), "The real parent hash still comes from a header");
  assert.deepEqual(f.requested, ["2"]);
  assert.throws(() => f.index.preflight(["1", "4"]), reason("resource_limit"));
  assert.deepEqual(f.requested, ["2"], "Preflight does not spend a partial header budget");

  const conflict = fixture([1_000, 2_000, 3_000, 4_000]);
  await conflict.index.block("1");
  assert.throws(() => conflict.index.logTime(log(1, 2_001)), reason("invalid_response"));
  const inverted = fixture([1_000, 2_000, 3_000, 4_000]);
  await inverted.index.block("1");
  assert.throws(() => inverted.index.logTime(log(2, 1_500)), reason("invalid_response"));
  const laterHeader = fixture([1_000, 2_000, 3_000, 4_000]);
  laterHeader.index.logTime(log(2, 2_500));
  await assert.rejects(laterHeader.index.block("2"), reason("invalid_response"));
});
