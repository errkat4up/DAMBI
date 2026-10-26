import test from "node:test";
import assert from "node:assert/strict";
import { checkWithTiming } from "../../../examples/sdk-adapters/check-timing.mjs";

function validMeasurement(measurement) {
  assert.ok(Number.isFinite(measurement.checkDurationMs) && measurement.checkDurationMs >= 0);
  assert.equal(measurement.targetBudgetMs, 2500);
  assert.equal(measurement.withinBudget, measurement.checkDurationMs <= measurement.targetBudgetMs,
    "The budget flag compares measured latency; it is not a performance acceptance assertion");
  assert.equal(Object.isFrozen(measurement), true);
}

test("check timing preserves the verdict and reports only sanitized fields and declared stub mode", async () => {
  const request = { privateRequest: "secret request" };
  const options = { signal: new AbortController().signal };
  const verdict = { decision: "warn", source: "evaluated", reasons: ["secret reason"],
    scam: { status: "insufficient", targets: [
      { analysisMode: "stub", subject: { token: "secret address" } },
      { analysisMode: "stub" }, {}, { analysisMode: "secret mode" },
    ] }, endpoint: "https://secret.example" };
  const core = { check(receivedRequest, receivedOptions) {
    assert.equal(this, core);
    assert.equal(receivedRequest, request);
    assert.equal(receivedOptions, options);
    return Promise.resolve(verdict);
  } };
  const measurements = [];
  assert.equal(await checkWithTiming(core, request, options, (value) => { measurements.push(value); }), verdict);
  assert.equal(measurements.length, 1);
  const measurement = measurements[0];
  validMeasurement(measurement);
  assert.deepEqual(measurement, { outcome: "completed", checkDurationMs: measurement.checkDurationMs,
    targetBudgetMs: 2500, withinBudget: measurement.withinBudget,
    decision: "warn", source: "evaluated", scamStatus: "insufficient", analysisModes: ["stub"] });
  assert.equal(Object.isFrozen(measurement.analysisModes), true);
  assert.doesNotMatch(JSON.stringify(measurement), /secret/);
});

test("check timing records synchronous throws and promise rejections once without exposing or replacing errors", async () => {
  const original = new Error("secret error, endpoint and stack");
  for (const check of [() => { throw original; }, () => Promise.reject(original)]) {
    const measurements = [];
    await assert.rejects(checkWithTiming({ check }, {}, undefined, (value) => { measurements.push(value); }),
      (error) => error === original);
    assert.equal(measurements.length, 1);
    const measurement = measurements[0];
    validMeasurement(measurement);
    assert.deepEqual(measurement, { outcome: "rejected", checkDurationMs: measurement.checkDurationMs,
      targetBudgetMs: 2500, withinBudget: measurement.withinBudget });
    assert.doesNotMatch(JSON.stringify(measurement), /secret|error|stack/);
  }
});

test("timing observers cannot replace results or errors and their promises are not awaited", async () => {
  const verdict = { decision: "deny", source: "fail_closed" };
  const original = new Error("original check failure");
  for (const observer of [() => { throw new Error("observer failure"); },
    () => Promise.reject(new Error("observer rejection")), () => new Promise(() => {})]) {
    let calls = 0;
    const notify = (measurement) => { calls++; validMeasurement(measurement); return observer(); };
    assert.equal(await checkWithTiming({ check: async () => verdict }, {}, undefined, notify), verdict);
    assert.equal(calls, 1);
    await assert.rejects(checkWithTiming({ check: async () => { throw original; } }, {}, undefined, notify),
      (error) => error === original);
    assert.equal(calls, 2);
  }
  await new Promise((resolve) => setImmediate(resolve));
});
