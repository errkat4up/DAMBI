import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CoreError, createCore } from "@dambi/core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = new URL("../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, fixtures), "utf8"));
const [decoder, envelope, keys] = await Promise.all([
  readJson("snapshot-approve.json"),
  readJson("policy-bundle/day1.envelope.json"),
  readJson("policy-bundle/test-only-keys.json"),
]);
assert.equal(keys.test_only, true);
const NOW = 1_800_000_000_000;
const CONTRACT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x000000000000000000000000000000000000aaaa";
const MAX_U256 = `0x${"f".repeat(64)}`;
const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder] });
const expectedDigest = `0x${createHash("sha256").update(artifact, "utf8").digest("hex")}`;
const initialPolicy = {
  payload: envelope.payload,
  signature: envelope.signature,
  keyId: envelope.key_id,
};

function request(amount = 7n) {
  return {
    kind: "transaction", chainId: "eip155:1", from: OWNER, to: CONTRACT,
    data: `0x095ea7b3${OWNER.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
    value: "0",
  };
}

function localConfig() {
  return {
    decoderSnapshot: { artifact, expectedDigest },
    trust: {
      env: "staging", profile: "default",
      keys: ["policy", "decoder"].map((role) => ({
        keyId: keys[role].key_id, role,
        publicKeySpkiBase64: keys[role].public_key_spki_b64,
      })),
    },
    enforcement: "advisory",
    limits: {
      allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
      planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
      factTimeoutMs: 1_000, policyTimeoutMs: 1_000,
    },
  };
}

function harness(policy = initialPolicy) {
  const local = localConfig();
  let current = policy;
  let now = NOW;
  let fetchPolicy = async () => current;
  return {
    local,
    config: {
      ...local,
      clock: { now: () => now },
      ports: {
        policy: { fetch: (options) => fetchPolicy(options) },
        fact: { fetch: async () => { throw new Error("plan/evaluate must not fetch Facts"); } },
      },
    },
    setPolicy(value) { current = value; },
    setNow(value) { now = value; },
    setFetcher(fetch) { fetchPolicy = fetch; },
  };
}

function signed(payload) {
  const bytes = JSON.stringify(payload);
  return {
    payload: bytes,
    signature: sign("sha256", Buffer.from(bytes), {
      key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
    }).toString("base64"),
  };
}

function policyAt(sequence) {
  return signed({ ...JSON.parse(initialPolicy.payload), sequence });
}

function code(expected) {
  return (error) => error instanceof CoreError && error.code === expected;
}

function emptyFacts(plan) {
  return { planId: plan.planId, results: {} };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function native(config, policy, req, facts) {
  const binary = process.env.DAMBI_SESSION_RUNNER
    ? resolve(process.env.DAMBI_SESSION_RUNNER)
    : resolve(root, "target/debug/examples", process.platform === "win32" ? "session_runner.exe" : "session_runner");
  // Missing/stale prerequisites fail. Tests never build or fall back to a mock.
  return JSON.parse(execFileSync(binary, [], {
    input: JSON.stringify({ config, policy, request: req, nowMs: NOW, facts }),
    encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  }));
}

function withoutCallIds(plan) {
  return plan.calls.map(({ callId: _callId, ...call }) => call);
}

test("built Core loads its own WASM and agrees with Native on a decoded approve", async (t) => {
  const setup = harness();
  const core = await createCore(setup.config);
  t.after(() => core.dispose());
  const req = request();
  const plan = await core.plan(req);
  const verdict = core.evaluate(plan, emptyFacts(plan));
  const reference = native(setup.local, initialPolicy, req);
  assert.deepEqual(withoutCallIds(plan), withoutCallIds(reference.plan));
  assert.equal(plan.expiresAt, reference.plan.expiresAt);
  assert.deepEqual(verdict, reference.verdict);
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.source, "evaluated");
  assert.equal(verdict.metadata.policyVersion, "42");
  await import("@dambi/core/internal");

  const { loadWasm } = await import("../dist/runtime/wasm-loader.js");
  const { WasmCore } = await loadWasm();
  for (const now of [NaN, Infinity, -1, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new WasmCore(JSON.stringify(setup.local), JSON.stringify(initialPolicy), now),
      (error) => typeof error === "string" && JSON.parse(error).code === "INVALID_CONFIG",
    );
  }
});

test("handles bind immutable requests to one instance and are consumed once", async (t) => {
  const setup = harness();
  const core = await createCore(setup.config);
  const other = await createCore(harness().config);
  t.after(() => { core.dispose(); other.dispose(); });
  let getterCalls = 0;
  const hostile = request();
  Object.defineProperty(hostile, "data", { enumerable: true, get() { getterCalls++; return "0x"; } });
  await assert.rejects(core.plan(hostile), code("INVALID_REQUEST"));
  assert.equal(getterCalls, 0, "request validation must not invoke caller getters");
  const cycle = {};
  cycle.self = cycle;
  for (const typedData of [cycle, { value: Number.MAX_SAFE_INTEGER + 1 }, { value: "\ud800" }]) {
    await assert.rejects(core.plan({
      kind: "typed_signature", chainId: "eip155:1", from: OWNER, typedData,
    }), code("INVALID_REQUEST"));
  }
  const req = request();
  Object.defineProperty(req, "hostname", { get() { getterCalls++; throw new Error("transport-only field"); } });
  const plan = await core.plan(req);
  assert.equal(getterCalls, 0, "transport-only fields must not be read");
  req.data = request(BigInt(MAX_U256)).data;
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.calls));
  assert.throws(() => core.evaluate({ ...plan }, emptyFacts(plan)), code("INVALID_PLAN"));
  assert.throws(() => other.evaluate(plan, emptyFacts(plan)), code("INVALID_PLAN"));
  assert.equal(core.evaluate(plan, emptyFacts(plan)).decision, "allow");
  assert.throws(() => core.evaluate(plan, emptyFacts(plan)), code("PLAN_CONSUMED"));

  const invalidFactPlan = await core.plan(request());
  const invalidFacts = { planId: invalidFactPlan.planId };
  Object.defineProperty(invalidFacts, "results", { enumerable: true, get() { getterCalls++; return {}; } });
  const failure = core.evaluate(invalidFactPlan, invalidFacts);
  assert.equal(getterCalls, 0, "Fact validation must not invoke caller getters");
  assert.equal(failure.source, "fail_closed");
  assert.ok(failure.diagnostics.some((item) => item.code === "invalid_fact"));
  assert.throws(() => core.evaluate(invalidFactPlan, emptyFacts(invalidFactPlan)), code("PLAN_CONSUMED"));

  const expired = await core.plan(request());
  setup.setNow(expired.expiresAt);
  assert.throws(() => core.evaluate(expired, emptyFacts(expired)), code("PLAN_EXPIRED"));
  core.dispose();
  core.dispose();
  await assert.rejects(core.plan(request()), code("DISPOSED"));
});

test("local keys stay authoritative and failed refresh preserves pinned plans", async (t) => {
  const setup = harness();
  const core = await createCore(setup.config);
  t.after(() => core.dispose());
  const oldPlan = await core.plan(request());
  // Changing caller-owned keys and untrusted keyId cannot change local trust.
  setup.config.trust.keys.length = 0;
  setup.setPolicy({ ...initialPolicy, payload: `${initialPolicy.payload} `, keyId: keys.decoder.key_id });
  await assert.rejects(core.refreshPolicies(), code("INVALID_SIGNATURE"));
  setup.setPolicy({ ...policyAt(43), keyId: "untrusted-response-label" });
  await core.refreshPolicies();
  const newPlan = await core.plan(request());
  assert.equal(core.evaluate(oldPlan, emptyFacts(oldPlan)).metadata.policyVersion, "42");
  assert.equal(core.evaluate(newPlan, emptyFacts(newPlan)).metadata.policyVersion, "43");

  // A superseded response cannot commit, even with a higher signed sequence.
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstResponse = deferred();
  const secondResponse = deferred();
  let fetchCount = 0;
  setup.setFetcher(() => {
    if (fetchCount++ === 0) {
      firstStarted.resolve();
      return firstResponse.promise;
    }
    secondStarted.resolve();
    return secondResponse.promise;
  });
  const superseded = assert.rejects(core.refreshPolicies(), code("ABORTED"));
  await firstStarted.promise;
  const latest = core.refreshPolicies();
  await secondStarted.promise;
  secondResponse.resolve(policyAt(44));
  await latest;
  firstResponse.resolve(policyAt(100));
  await superseded;
  const latestPlan = await core.plan(request());
  assert.equal(core.evaluate(latestPlan, emptyFacts(latestPlan)).metadata.policyVersion, "44");

  const disposingStarted = deferred();
  const disposingResponse = deferred();
  let disposingSignal;
  setup.setFetcher(({ signal }) => {
    disposingSignal = signal;
    disposingStarted.resolve();
    return disposingResponse.promise;
  });
  const disposing = assert.rejects(core.refreshPolicies(), code("DISPOSED"));
  await disposingStarted.promise;
  core.dispose();
  await disposing;
  assert.equal(disposingSignal.aborted, true);
  disposingResponse.resolve(policyAt(101));

  const untrusted = harness();
  untrusted.config.trust.keys = [{
    keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.decoder.public_key_spki_b64,
  }];
  await assert.rejects(createCore(untrusted.config), code("INVALID_SIGNATURE"));
});

test("required Fact projection, provenance and failure behavior cross the WASM boundary", async (t) => {
  const payload = JSON.parse(initialPolicy.payload);
  // SDK-only required-Fact case; the shared Day-1 policies remain unchanged.
  payload.policies = [{
    id: "sdk-required-balance",
    policy: `@id("sdk-required-balance")\n@severity("warn")\nforbid(principal, action == Token::Action::"Erc20Approve", resource) when { context has custom && context.custom has balance && context.custom.balance == "${MAX_U256}" };`,
    manifest: {
      id: "sdk-required-balance", schema_version: 2,
      trigger: { where: { "action.tag": { eq: "erc20_approve" } } },
      policy_rpc: [{
        id: "owner-balance", method: "portfolio.balance",
        params: { chain_id: "$.root.chain_id", owner: "$.root.from", asset: "$.action.token" },
        outputs: [{ kind: "context", field: "balance", type: "String", from: "$.result.balance", required: true }],
        optional: false,
      }],
      custom_context: { fields: { balance: "String" } },
    },
  }];
  const policy = signed(payload);
  const setup = harness(policy);
  const core = await createCore(setup.config);
  t.after(() => core.dispose());
  const fact = { value: { balance: MAX_U256 }, source: "fixture:balance", observedAt: NOW, blockNumber: "20000000" };
  const plan = await core.plan(request());
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].method, "portfolio.balance");
  assert.equal(plan.calls[0].params.owner, OWNER);
  const verdict = core.evaluate(plan, { planId: plan.planId, results: { [plan.calls[0].callId]: fact } });
  assert.equal(verdict.decision, "warn");
  assert.equal(verdict.source, "evaluated");
  assert.deepEqual(verdict.facts, [fact]);
  const reference = native(setup.local, policy, request(), [fact]);
  assert.deepEqual(withoutCallIds(plan), withoutCallIds(reference.plan));
  assert.deepEqual(verdict, reference.verdict);

  let lengthReads = 0;
  const history = new Proxy([1, 2], {
    get(target, key, receiver) {
      if (key === "length") { lengthReads++; return 0; }
      return Reflect.get(target, key, receiver);
    },
  });
  const proxyPlan = await core.plan(request());
  const proxyVerdict = core.evaluate(proxyPlan, {
    planId: proxyPlan.planId,
    results: { [proxyPlan.calls[0].callId]: { ...fact, value: { balance: MAX_U256, history } } },
  });
  assert.equal(lengthReads, 0, "array copying must use own data descriptors");
  assert.equal(proxyVerdict.decision, "warn");
  assert.deepEqual(proxyVerdict.facts[0].value.history, [1, 2]);

  for (const [diagnostic, makeBatch] of [
    ["required_fact_missing", (next) => emptyFacts(next)],
    ["projection_failed", (next) => ({ planId: next.planId, results: { [next.calls[0].callId]: { ...fact, value: {} } } })],
    ["fact_stale", (next) => ({ planId: next.planId, results: { [next.calls[0].callId]: { ...fact, observedAt: NOW - 30_001 } } })],
    ["unknown_fact_call", (next) => ({ planId: next.planId, results: { foreign: fact } })],
  ]) {
    const next = await core.plan(request());
    const failure = core.evaluate(next, makeBatch(next));
    assert.equal(failure.decision, "deny", diagnostic);
    assert.equal(failure.source, "fail_closed", diagnostic);
    assert.ok(failure.diagnostics.some((item) => item.code === diagnostic), diagnostic);
    assert.throws(() => core.evaluate(next, emptyFacts(next)), code("PLAN_CONSUMED"));
  }
});

test("aborted or timed-out initialization ignores late source completion", async () => {
  const setup = harness();
  const controller = new AbortController();
  const started = deferred();
  const response = deferred();
  let sourceSignal;
  setup.setFetcher(({ signal }) => {
    sourceSignal = signal;
    started.resolve();
    return response.promise;
  });
  const pending = createCore(setup.config, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, code("ABORTED"));
  assert.equal(sourceSignal.aborted, true);
  response.resolve(initialPolicy);

  const slow = harness();
  slow.config.limits.policyTimeoutMs = 10;
  const lateResponse = deferred();
  let timedOutSignal;
  slow.setFetcher(({ signal }) => {
    timedOutSignal = signal;
    return lateResponse.promise;
  });
  await assert.rejects(createCore(slow.config), code("TIMEOUT"));
  assert.equal(timedOutSignal.aborted, true);
  lateResponse.resolve(initialPolicy);
});
