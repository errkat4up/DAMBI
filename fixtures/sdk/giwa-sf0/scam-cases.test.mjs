import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Fixture integrity only. No event generation, window search, verdict composer,
// stub, RPC or algorithm is implemented or executed by these tests.
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixtures = readJson("./scam-cases.json");
const evidence = readJson("./rpc-evidence.json");
const inGap = (t, gap) => gap.startMs < t && t <= gap.endMs;
const uintString = (value) => {
  assert.equal(typeof value, "string", "reserve must stay a decimal string");
  assert.match(value, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(value) < (1n << 256n), "reserve exceeds U256");
};
const orderedTimes = (times, from, to) => {
  let previous = -Infinity;
  for (const t of times) {
    assert.ok(Number.isSafeInteger(t) && from <= t && t <= to, "time outside fixture range");
    assert.ok(t > previous, "duplicate or unordered time");
    previous = t;
  }
};
function validateGaps(gaps, from, to) {
  let end = from;
  for (const gap of gaps) {
    assert.ok(Number.isSafeInteger(gap.startMs) && Number.isSafeInteger(gap.endMs));
    assert.ok(end <= gap.startMs && gap.startMs < gap.endMs && gap.endMs <= to, "invalid missing interval");
    assert.equal(typeof gap.reason, "string");
    assert.ok(gap.reason.length > 0);
    end = gap.endMs;
  }
}
function validateSnapshots(item) {
  const d = fixtures.snapshotDefaults;
  const from = d.Bms - d.warmupMs;
  validateGaps(item.missing, from, d.Tms);
  const times = item.samples.map(([time]) => time);
  orderedTimes(times, from, d.Tms);
  for (const row of item.samples) {
    assert.equal(row.length, 3);
    const [time, token, quote] = row;
    assert.ok((time - d.gridOriginMs) % d.bucketMs === 0, "sample is off the snapshot grid");
    assert.ok(!item.missing.some((gap) => inGap(time, gap)), "sample inside declared missing interval");
    uintString(token);
    uintString(quote);
  }
  // Every grid point is either present or explicitly missing. This validates
  // input coverage only; it does not fill gaps or infer state/events.
  const present = new Set(times);
  for (let time = from; time <= d.Tms; time += d.bucketMs) {
    assert.equal(present.has(time), !item.missing.some((gap) => inGap(time, gap)), "unmarked sample hole");
  }
}
function validateEventCase(item) {
  const c = { ...fixtures.eventDefaults, ...item.context };
  assert.ok(c.contextFromMs <= c.Bms && c.Bms < c.Tms);
  assert.ok(Number.isSafeInteger(c.X2ms) && c.X2ms > 0);
  assert.ok(Number.isSafeInteger(c.n) && c.n > 0);
  assert.ok(Number.isSafeInteger(c.m) && c.m > 0);
  validateGaps(c.missing, c.contextFromMs, c.Tms);
  for (const times of [item.changesMs, item.switchesMs]) {
    orderedTimes(times, c.contextFromMs, c.Tms);
    for (const t of times) assert.ok(!c.missing.some((gap) => inGap(t, gap)), "confirmed event inside missing interval");
  }
  assert.ok(["confirmed", "confirmed_from_creation", "unconfirmed"].includes(c.initialState));
  assert.ok(["verified_lower_bound", "exact_from_creation"].includes(c.age.kind));
  assert.ok(Number.isSafeInteger(c.age.ms) && c.age.ms >= 0);
  assert.ok(Number.isSafeInteger(c.age.thresholdMs) && c.age.thresholdMs > 0);
  assert.equal(typeof c.fresh, "boolean");
  // Only the shape of the hand-authored expected output is checked. Its counts,
  // chosen window and verdict are acceptance targets for a future implementation.
  const expected = item.expected;
  assert.equal(expected.rules.length, 2);
  for (const status of expected.rules) assert.ok(["clear", "fired", "incomplete", "not_evaluable"].includes(status));
  for (const count of [expected.r1Count, expected.r2MaxCount]) assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.ok(["quiet", "warn", "insufficient"].includes(expected.report));
  assert.equal(typeof expected.partial, "boolean");
  if (expected.window !== null) {
    const { startMs, endMs } = expected.window;
    assert.ok(Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs));
    assert.ok(c.Bms <= startMs && startMs < endMs && endMs <= c.Tms);
    assert.ok(endMs - startMs <= c.X2ms);
  }
}

test("four synthetic snapshot inputs preserve integer reserves, cadence and explicit gaps", () => {
  assert.equal(fixtures.scope, "fixture_only_not_public_api");
  assert.equal(fixtures.provenance.snapshots, "synthetic_reserve_snapshots_not_observed_GIWA_history");
  assert.equal(fixtures.snapshotDefaults.expectationStatus, "pending_SF1_no_event_count_or_verdict_claim");
  assert.equal(fixtures.snapshotFixtures.length, 4);
  assert.equal(new Set(fixtures.snapshotFixtures.map(({ id }) => id)).size, 4);
  for (const item of fixtures.snapshotFixtures) validateSnapshots(item);
});

test("manual semantic cases are well-formed and remain separate from snapshot calculation", () => {
  assert.equal(fixtures.provenance.events, "hand_specified_qualified_events_not_derived_from_snapshots");
  assert.equal(fixtures.eventDefaults.executionStatus, "not_run_no_algorithm_connected");
  assert.equal(fixtures.cases.length, 12);
  assert.equal(new Set(fixtures.cases.map(({ id }) => id)).size, 12);
  for (const item of fixtures.cases) {
    assert.equal(typeof item.purpose, "string");
    assert.equal(Object.hasOwn(item, "snapshotRef"), false, "do not imply an unverified snapshot-to-event mapping");
    if (item.kind === "qualified_events") validateEventCase(item);
    else assert.equal(item.kind, "subject_selection");
  }
});

test("identity references resolve and excluded/unresolved subjects are not invented successes", () => {
  for (const key of ["pool", "factory"]) assert.equal(fixtures.subject[key], evidence.observations.swap[key]);
  assert.equal(fixtures.subject.chainId, evidence.chainId);
  assert.equal(fixtures.subject.quote, evidence.observations.swap.path[0]);
  assert.equal(fixtures.subject.token, evidence.observations.swap.path[1]);
  const excluded = fixtures.cases.find(({ id }) => id === "unsupported-launchpad-request");
  const tx = evidence.queries.find(({ request }) =>
    request.method === "eth_getTransactionByHash" && request.params[0] === excluded.input.evidenceTx)?.response.result;
  assert.ok(tx, "missing referenced real transaction");
  assert.equal(tx.to, evidence.observations.liquidity.target);
  assert.equal(tx.input.slice(0, 10), evidence.observations.liquidity.selector);
  assert.equal(excluded.expected.disposition, "not_applicable");
  assert.equal(excluded.expected.rules, null);
  const unresolved = fixtures.cases.find(({ id }) => id === "supported-path-zero-pool");
  assert.equal(unresolved.input.pool, "0x" + "0".repeat(40));
  assert.equal(unresolved.expected.disposition, "insufficient");
  assert.equal(unresolved.expected.rules, null);
});

test("integrity checks reject precision loss, unmarked holes and events in unknown time", () => {
  const original = fixtures.snapshotFixtures[0];
  const numericReserve = structuredClone(original);
  numericReserve.samples[0][1] = Number(numericReserve.samples[0][1]);
  assert.throws(() => validateSnapshots(numericReserve), /decimal string/);
  const hole = structuredClone(original);
  hole.samples.splice(3, 1);
  assert.throws(() => validateSnapshots(hole), /unmarked sample hole/);
  const duplicate = structuredClone(original);
  duplicate.samples[1][0] = duplicate.samples[0][0];
  assert.throws(() => validateSnapshots(duplicate), /duplicate or unordered/);
  const future = structuredClone(original);
  future.samples.at(-1)[0] += 1000;
  assert.throws(() => validateSnapshots(future), /outside fixture range/);
  const gapEvent = structuredClone(fixtures.cases.find(({ id }) => id === "partial-but-fired"));
  gapEvent.switchesMs.push(15000);
  assert.throws(() => validateEventCase(gapEvent), /event inside missing interval/);
});
