import test from "node:test";
import assert from "node:assert/strict";
import { copyJson, measureJson } from "../dist/runtime/json.js";

const code = "INVALID_REQUEST";
const limited = { name: "CoreError", code: "LIMIT_EXCEEDED" };
const invalid = { name: "CoreError", code };

test("JSON measurement matches safe copies at exact escaped UTF-8 byte limits", () => {
  const shared = { value: "같은 참조" };
  const values = [null, false, -0, 1.25, Number.MAX_SAFE_INTEGER,
    { "한글\"\\\n": ["ASCII", "é", "한글", "🦦", "\b\t\n\f\r\u0000", shared, shared] }];
  for (const value of values) {
    const serialized = JSON.stringify(value);
    const expected = Buffer.byteLength(serialized, "utf8");
    assert.equal(measureJson(value, code, expected), expected);
    assert.equal(JSON.stringify(copyJson(value, code, expected)), serialized);
    assert.equal(JSON.stringify(value), serialized, "Neither operation mutates the input");
    assert.throws(() => measureJson(value, code, expected - 1), limited);
    assert.throws(() => copyJson(value, code, expected - 1), limited);
  }
  const source = { nested: [{ value: 1 }] };
  const copied = copyJson(source, code, 1024);
  assert.notStrictEqual(copied, source);
  assert.notStrictEqual(copied.nested, source.nested);
  assert.notStrictEqual(copied.nested[0], source.nested[0]);
  assert.equal(Object.getPrototypeOf(copied), null);
  assert.equal(Object.getPrototypeOf(copied.nested), null);
});

test("JSON measurement and copying reject unsafe data without invoking getters or toJSON", () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { invoked++; return 1; } });
  const serializer = { toJSON() { invoked++; return "hidden"; } };
  const hidden = Object.defineProperty({}, "value", { value: 1 });
  const symbol = { [Symbol("hidden")]: 1 };
  const cycle = {};
  cycle.self = cycle;
  const sparse = Array(2);
  const extraArray = Object.assign([1], { extra: 2 });
  for (const value of [getter, serializer, hidden, symbol, cycle, sparse, extraArray,
    Object.create({ inherited: 1 }), { value: Infinity }, { value: Number.MAX_SAFE_INTEGER + 1 },
    { value: undefined }, { value: 1n }, { value: "\ud800" }, { value: "\udc00" }]) {
    for (const operation of [copyJson, measureJson]) assert.throws(() => operation(value, code, 4096), invalid);
  }
  assert.equal(invoked, 0);
});

test("JSON measurement retains the nesting and early-size resource limits", () => {
  let nested = null;
  for (let i = 0; i < 129; i++) nested = [nested];
  for (const operation of [copyJson, measureJson]) {
    assert.throws(() => operation(nested, code, 4096), limited);
    assert.throws(() => operation(Array(100_000), code, 16), limited,
      "Impossible array sizes stop before inspecting every element");
  }
});
