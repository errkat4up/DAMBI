import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CoreError, createCore } from "@dambi/core";

// Real packaged WASM, locally signed policy fixtures, and mocked external I/O.
// Missing artifacts fail normally; this suite never builds or substitutes an engine.
const fixtures = new URL("../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const catalog = new URL("../../../crates/policy-engine/tests/fixtures/policy_catalog_v2/action/transfer/transfer-full-balance-sweep/", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [approveDecoder, envelope, keys, catalogManifest, catalogPolicy] = await Promise.all([
  readJson(new URL("snapshot-approve.json", fixtures)),
  readJson(new URL("policy-bundle/day1.envelope.json", fixtures)),
  readJson(new URL("policy-bundle/test-only-keys.json", fixtures)),
  readJson(new URL("manifest.json", catalog)),
  readFile(new URL("policy.cedar", catalog), "utf8"),
]);
assert.equal(keys.test_only, true);
assert.equal(catalogManifest.policy_rpc[0].optional, true);
const NOW = 1_800_000_000_000;
const CONTRACT = "0x1111111111111111111111111111111111111111";
const SECOND_CONTRACT = "0x2222222222222222222222222222222222222222";
const OWNER = "0x000000000000000000000000000000000000aaaa";
const SECOND_OWNER = "0x000000000000000000000000000000000000bbbb";
const THIRD_OWNER = "0x000000000000000000000000000000000000cccc";
const MAX_U256 = (1n << 256n) - 1n;
const initialPolicy = { payload: envelope.payload, signature: envelope.signature, keyId: envelope.key_id };
const options = { timeout: 30_000 };

function transferDecoder() {
  // Hand-resolved standard ERC20 transfer ABI/emit, using the SDK fixture's
  // container shape. No Registry, extension or server path is read at runtime.
  const bundle = structuredClone(approveDecoder);
  bundle.id = "standard/erc20/transfer@1.0.0";
  bundle.match = {
    selector: "0xa9059cbb",
    chain_to_addresses: { 1: [CONTRACT, SECOND_CONTRACT], 10: [CONTRACT, SECOND_CONTRACT] },
  };
  bundle.abi_fragment.function_name = "transfer";
  bundle.abi_fragment.abi.name = "transfer";
  bundle.abi_fragment.abi.inputs[0].name = "to";
  bundle.emit.body = {
    domain: "token", token: { action: "erc20_transfer", erc20_transfer: {
      token: { key: { standard: "erc20", chain: "$chain", address: "$to" } },
      recipient: "$args.to", amount: "$args.amount",
    } },
  };
  return bundle;
}

function request(kind = "transfer", amount = 100n, extra = {}) {
  return {
    kind: "transaction", chainId: "eip155:1", from: OWNER, to: CONTRACT,
    data: `0x${kind === "approve" ? "095ea7b3" : "a9059cbb"}${SECOND_OWNER.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`,
    value: "0", ...extra,
  };
}

function signed(entries, sequence = 42) {
  const payload = JSON.stringify({ ...JSON.parse(initialPolicy.payload), sequence, policies: entries });
  return { payload, signature: sign("sha256", Buffer.from(payload), {
    key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
  }).toString("base64") };
}

function balanceEntry(required = false) {
  const manifest = structuredClone(catalogManifest);
  let policy = catalogPolicy;
  if (required) {
    manifest.id = "check-required-balance";
    manifest.policy_rpc[0].optional = false;
    manifest.policy_rpc[0].outputs[0].required = true;
    policy = policy.replace('@id("transfer-full-balance-sweep")', '@id("check-required-balance")');
  }
  return { id: manifest.id, policy, manifest };
}

function fact(balance = "0x64", observedAt = NOW, blockNumber = "20000000") {
  return { value: { balance }, source: "fixture:eip155:eth_call", observedAt, blockNumber };
}

function batch(calls, { planId }, makeFact = () => fact()) {
  return { planId, results: Object.fromEntries(calls.map((call, index) => [call.callId, makeFact(call, index)])) };
}

function harness({ policy = initialPolicy, bundles = [approveDecoder, transferDecoder()], limits = {}, hooks } = {}) {
  let current = policy;
  let now = NOW;
  let fetchFacts = async (calls, context) => batch(calls, context, () => fact("0x64", now));
  const fetches = [];
  const artifact = JSON.stringify({ schema_version: 1, bundles });
  return {
    fetches,
    setPolicy(value) { current = value; },
    setNow(value) { now = value; },
    setFacts(value) { fetchFacts = value; },
    config: {
      decoderSnapshot: { artifact, expectedDigest: `0x${createHash("sha256").update(artifact).digest("hex")}` },
      trust: { env: "staging", profile: "default", keys: [{
        keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64,
      }] },
      enforcement: "advisory", clock: { now: () => now }, hooks,
      limits: {
        allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
        maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
        planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
        factTimeoutMs: 1_000, policyTimeoutMs: 1_000, ...limits,
      },
      ports: {
        policy: { fetch: async () => current },
        fact: { fetch(calls, context) { fetches.push({ calls, context }); return fetchFacts(calls, context); } },
      },
    },
  };
}

async function open(t, setup) {
  const core = await createCore(setup.config);
  t.after(() => core.dispose());
  return core;
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const hasDiagnostic = (verdict, expected) => verdict.diagnostics.some(({ code }) => code === expected);
const hasReason = (verdict, expected) => verdict.reasons.some(({ policyId }) => policyId === expected);

function failClosed(verdict, diagnostic) {
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.source, "fail_closed");
  assert.ok(hasDiagnostic(verdict, diagnostic), `${diagnostic}: ${JSON.stringify(verdict)}`);
}

test("check evaluates no-Fact approve and distinguishes unsupported requests from malformed ones", options, async (t) => {
  const emitted = [];
  const diagnostics = [];
  const setup = harness({ hooks: {
    onVerdict(verdict) { emitted.push(verdict); },
    onDiagnostic(event) { diagnostics.push(event); },
  } });
  const core = await open(t, setup);
  const allow = await core.check(request("approve", 7n));
  const warn = await core.check(request("approve", MAX_U256));
  assert.equal(allow.decision, "allow");
  assert.equal(allow.source, "evaluated");
  assert.equal(warn.decision, "warn");
  assert.ok(hasReason(warn, "unlimited-approval-deny"));
  assert.equal(warn.metadata.policyVersion, "42");
  assert.notEqual(allow.metadata.requestDigest, warn.metadata.requestDigest);
  assert.equal(hasDiagnostic(allow, "audit_metadata_unavailable"), false);
  assert.equal(setup.fetches.length, 0, "no enrichment calls means no FactProvider I/O");
  for (const req of [{ kind: "future_wallet_action" }, { kind: "untyped_signature", message: "opaque" }]) {
    const unsupported = await core.check(req);
    assert.equal(unsupported.decision, "warn");
    assert.equal(unsupported.source, "evaluated");
    assert.ok(hasDiagnostic(unsupported, "unsupported_request"));
    assert.deepEqual(unsupported.metadata, { status: "unavailable", reason: "unsupported_request" });
    assert.ok(hasDiagnostic(unsupported, "audit_metadata_unavailable"));
    assert.deepEqual(emitted.at(-1), unsupported);
    assert.deepEqual(diagnostics.at(-1), unsupported.diagnostics.at(-1));
  }
  const malformed = await core.check({ ...request("approve"), data: 123 });
  failClosed(malformed, "invalid_request");
  assert.deepEqual(malformed.metadata, { status: "unavailable", reason: "invalid_request" });
  assert.ok(hasDiagnostic(malformed, "audit_metadata_unavailable"));
  assert.deepEqual(emitted.at(-1), malformed);
  const controller = new AbortController();
  controller.abort();
  const aborted = await core.check(request(), { signal: controller.signal });
  failClosed(aborted, "aborted");
  assert.equal(aborted.metadata.status, "unavailable");
  assert.ok(hasDiagnostic(aborted, "audit_metadata_unavailable"));
  assert.deepEqual(emitted.at(-1), aborted);
  assert.equal(setup.fetches.length, 0);
});

test("raw transfer retains U256 precision and catalog optional semantics while required Facts fail closed", options, async (t) => {
  const setup = harness({ policy: signed([balanceEntry()]) });
  const core = await open(t, setup);
  setup.setFacts(async (_calls, { planId }) => ({ planId, results: {} }));
  assert.equal((await core.check(request())).decision, "allow");
  const precise = fact(`0x${MAX_U256.toString(16)}`);
  setup.setFacts(async (calls, context) => batch(calls, context, () => precise));
  const sweep = await core.check(request("transfer", MAX_U256, { from: SECOND_OWNER }));
  assert.equal(sweep.decision, "warn");
  assert.equal(sweep.source, "evaluated");
  assert.ok(hasReason(sweep, "transfer-full-balance-sweep"));
  assert.deepEqual(sweep.facts, [precise]);
  const planned = setup.fetches.at(-1).calls[0];
  assert.equal(planned.optional, true);
  assert.equal(planned.params.owner, SECOND_OWNER);
  assert.equal(planned.params.asset.key.address, CONTRACT);
  setup.setFacts(async (calls, context) => batch(calls, context, () => ({ ...fact(), value: {} })));
  const optional = await core.check(request("transfer", 100n, { from: THIRD_OWNER }));
  assert.equal(optional.decision, "allow");
  assert.equal(optional.source, "evaluated");
  assert.equal(optional.reasons.length, 0);
  const beforeRecovery = setup.fetches.length;
  setup.setFacts(async (calls, context) => batch(calls, context));
  const recovered = await core.check(request("transfer", 100n, { from: THIRD_OWNER }));
  assert.equal(recovered.decision, "warn");
  assert.equal(recovered.source, "evaluated");
  assert.ok(hasReason(recovered, "transfer-full-balance-sweep"));
  assert.equal(setup.fetches.length, beforeRecovery + 1, "a skipped optional projection must not cache its unusable response");

  const requiredEntry = balanceEntry(true);
  // v2 branches on call.optional; the legacy output.required flag does not
  // turn a required call's projection failure into a successful optional skip.
  requiredEntry.manifest.policy_rpc[0].outputs[0].required = false;
  const requiredSetup = harness({ policy: signed([requiredEntry]) });
  const required = await open(t, requiredSetup);
  requiredSetup.setFacts(async (_calls, { planId }) => ({ planId, results: {} }));
  failClosed(await required.check(request()), "required_fact_missing");
  requiredSetup.setFacts(async (calls, context) => batch(calls, context, () => ({ ...fact(), value: "0x64" })));
  failClosed(await required.check(request()), "projection_failed");
  requiredSetup.setFacts(async (calls, context) => batch(calls, context, () => ({ ...fact(), source: "" })));
  failClosed(await required.check(request()), "invalid_fact");
  requiredSetup.setFacts(async (calls, context) => ({
    ...batch(calls, context, () => fact("0x0")), planId: "different-plan",
  }));
  failClosed(await required.check(request()), "fact_plan_mismatch");
  requiredSetup.setFacts(async (calls, context) => batch(calls, context));
  assert.equal((await required.check(request())).decision, "warn");
  assert.equal(requiredSetup.fetches.length, 5, "failed or plan-mismatched evaluations must not seed the cache");
  assert.equal((await required.check(request())).decision, "warn");
  assert.equal(requiredSetup.fetches.length, 5, "successful required projections still seed the cache");
});

test("partial Unknown and sibling Fact fetch failure preserve decoded policy denies in either order", options, async (t) => {
  const deny = {
    id: "check-static-deny",
    policy: '@id("check-static-deny") @severity("deny") forbid(principal, action == Token::Action::"Erc20Approve", resource);',
    manifest: { id: "check-static-deny", schema_version: 2, trigger: { where: { "action.tag": { eq: "erc20_approve" } } } },
  };
  const token = { key: { standard: "erc20", chain: "eip155:1", address: CONTRACT } };
  for (const unknown of [true, false]) {
    for (const reversed of [false, true]) {
      const children = [
        { domain: "token", action: "erc20_approve", token, spender: SECOND_OWNER, amount: "0x7" },
        unknown
          ? { domain: "unknown", target: CONTRACT, chain: "eip155:1", calldata: "0xdeadbeef", value: "0x0" }
          : { domain: "token", action: "erc20_transfer", token, recipient: SECOND_OWNER, amount: "0x64" },
      ];
      if (reversed) children.reverse();
      const tree = structuredClone(approveDecoder);
      tree.id = "check/tree@1";
      tree.emit.body = { domain: "multicall", actions: children };
      const setup = harness({ policy: signed([deny, balanceEntry(true)]), bundles: [tree] });
      setup.setFacts(async () => { throw new Error("simulated provider outage"); });
      const core = await open(t, setup);
      const verdict = await core.check(request("approve"));
      assert.equal(verdict.decision, "deny");
      assert.ok(hasReason(verdict, "check-static-deny"), JSON.stringify(verdict));
      if (unknown) {
        assert.equal(verdict.source, "evaluated");
        assert.ok(hasDiagnostic(verdict, "partial_decode"));
        assert.equal(setup.fetches.length, 0);
      } else {
        failClosed(verdict, "fact_fetch_failed");
      }
    }
  }
});

test("Fact timeout, abort and disposal ignore late responses without cancelling an independent check", options, async (t) => {
  const setup = harness({ policy: signed([balanceEntry(true)]), limits: { factTimeoutMs: 20 } });
  const core = await open(t, setup);
  const slow = deferred();
  setup.setFacts(() => slow.promise);
  failClosed(await core.check(request()), "timeout");
  const timedOut = setup.fetches[0];
  assert.equal(timedOut.context.signal.aborted, true);
  slow.resolve(batch(timedOut.calls, timedOut.context));
  await tick();
  setup.setFacts(async (calls, context) => batch(calls, context, () => fact("0x0")));
  assert.equal((await core.check(request())).decision, "allow");
  assert.equal(setup.fetches.length, 2, "late timed-out Facts cannot populate cache");

  const concurrentSetup = harness({ policy: signed([balanceEntry(true)]) });
  const concurrent = await open(t, concurrentSetup);
  const waiting = [];
  const bothStarted = deferred();
  concurrentSetup.setFacts((calls, context) => {
    const response = deferred();
    waiting.push({ calls, context, response });
    if (waiting.length === 2) bothStarted.resolve();
    return response.promise;
  });
  const controller = new AbortController();
  const aborted = concurrent.check(request(), { signal: controller.signal });
  const independent = concurrent.check(request("transfer", 100n, { from: SECOND_OWNER }));
  await bothStarted.promise;
  controller.abort();
  const cancelled = await aborted;
  failClosed(cancelled, "aborted");
  const cancelledFetch = waiting.find(({ calls }) => calls[0].params.owner === OWNER);
  const independentFetch = waiting.find(({ calls }) => calls[0].params.owner === SECOND_OWNER);
  assert.equal(cancelledFetch.context.signal.aborted, true);
  assert.equal(independentFetch.context.signal.aborted, false);
  independentFetch.response.resolve(batch(independentFetch.calls, independentFetch.context));
  const completed = await independent;
  assert.equal(completed.decision, "warn");
  assert.equal(completed.source, "evaluated");
  assert.notEqual(completed.metadata.requestDigest, cancelled.metadata.requestDigest);
  cancelledFetch.response.resolve(batch(cancelledFetch.calls, cancelledFetch.context));
  await tick();

  const disposeStarted = deferred();
  const disposeResponse = deferred();
  let disposing;
  concurrentSetup.setFacts((calls, context) => {
    disposing = { calls, context };
    disposeStarted.resolve();
    return disposeResponse.promise;
  });
  const disposed = assert.rejects(concurrent.check(request("transfer", 100n, { from: THIRD_OWNER })), code("DISPOSED"));
  await disposeStarted.promise;
  concurrent.dispose();
  await disposed;
  assert.equal(disposing.context.signal.aborted, true);
  disposeResponse.resolve(batch(disposing.calls, disposing.context));
  await assert.rejects(concurrent.check(request()), code("DISPOSED"));

  // A second plan prunes A's expired Native handle before its I/O settles.
  // The private authoritative metadata retained by check must survive pruning.
  const expirySetup = harness({ policy: signed([balanceEntry(true)]), limits: { planTtlMs: 10 } });
  const expiryCore = await open(t, expirySetup);
  const expiryStarted = deferred();
  const expiryResponse = deferred();
  expirySetup.setFacts(() => { expiryStarted.resolve(); return expiryResponse.promise; });
  const expiring = expiryCore.check(request());
  await expiryStarted.promise;
  expirySetup.setNow(NOW + 11);
  assert.equal((await expiryCore.check(request("approve", 7n))).decision, "allow");
  assert.equal(expirySetup.fetches.length, 1, "the pruning approve needs no external Fact");
  const expiryFetch = expirySetup.fetches[0];
  expiryResponse.resolve(batch(expiryFetch.calls, expiryFetch.context, () => fact("0x64", NOW + 11)));
  const expired = await expiring;
  failClosed(expired, "timeout");
  assert.equal(expired.metadata.status, "available");
  assert.equal(expired.metadata.policyVersion, "42");
  assert.equal(hasDiagnostic(expired, "audit_metadata_unavailable"), false);
});

test("cache preserves original provenance and separates fresh entries by chain and resolved parameters", options, async (t) => {
  const setup = harness({ policy: signed([balanceEntry(true)]), limits: { maxFactAgeMs: 100 } });
  const core = await open(t, setup);
  const original = fact("0x64", NOW - 20);
  setup.setFacts(async (calls, context) => batch(calls, context, () => original));
  assert.equal((await core.check(request())).decision, "warn");
  original.value.balance = "0x0";
  original.observedAt = NOW + 50;
  setup.setNow(NOW + 50);
  const cached = await core.check(request());
  assert.equal(cached.decision, "warn");
  assert.equal(cached.facts[0].observedAt, NOW - 20);
  assert.equal(cached.facts[0].blockNumber, "20000000");
  assert.equal(cached.facts[0].value.balance, "0x64");
  assert.equal(setup.fetches.length, 1);
  setup.setNow(NOW + 101);
  setup.setFacts(async (calls, context) => batch(calls, context, () => fact("0x64", NOW + 101, "20000001")));
  const refreshed = await core.check(request());
  assert.equal(refreshed.facts[0].observedAt, NOW + 101);
  assert.equal(setup.fetches.length, 2);
  for (const extra of [{ from: SECOND_OWNER }, { to: SECOND_CONTRACT }, { chainId: "eip155:10" }]) {
    assert.equal((await core.check(request("transfer", 100n, extra))).source, "evaluated");
  }
  assert.equal(setup.fetches.length, 5, "other owners, tokens and chains cannot reuse this Fact");
  await core.check(request("transfer", 100n, { chainId: "eip155:10" }));
  assert.equal(setup.fetches.length, 5);
});

test("policy refresh keeps an in-flight check pinned and prevents old-epoch cache repopulation", options, async (t) => {
  const entries = [balanceEntry(true)];
  const setup = harness({ policy: signed(entries) });
  const core = await open(t, setup);
  const started = deferred();
  const response = deferred();
  setup.setFacts(() => { started.resolve(); return response.promise; });
  const pending = core.check(request());
  await started.promise;
  setup.setPolicy(signed(entries, 43));
  await core.refreshPolicies();
  const oldFetch = setup.fetches[0];
  response.resolve(batch(oldFetch.calls, oldFetch.context));
  const old = await pending;
  assert.equal(old.metadata.policyVersion, "42");
  assert.equal(old.decision, "warn");
  setup.setFacts(async (calls, context) => batch(calls, context, () => fact("0x0")));
  const current = await core.check(request());
  assert.equal(current.metadata.policyVersion, "43");
  assert.equal(current.decision, "allow");
  assert.equal(setup.fetches.length, 2);
  await core.check(request());
  assert.equal(setup.fetches.length, 2);
  const next = signed(entries, 44);
  setup.setPolicy(next);
  await core.refreshPolicies();
  await core.check(request());
  assert.equal(setup.fetches.length, 3, "successful policy refresh invalidates the cache");
  setup.setPolicy({ ...next, payload: `${next.payload} ` });
  await assert.rejects(core.refreshPolicies(), code("INVALID_SIGNATURE"));
  assert.equal((await core.check(request())).metadata.policyVersion, "44");
  assert.equal(setup.fetches.length, 3, "failed refresh preserves the active cache and snapshot");
});

test("notification hooks cannot mutate, delay or replace check and direct evaluate verdicts", options, async (t) => {
  const pending = [];
  const emitted = [];
  const immutable = [];
  const mutations = [];
  const diagnostics = [];
  let awaiting = 0;
  const setup = harness({ hooks: {
    onPending(req) {
      pending.push(req);
      immutable.push(Object.isFrozen(req));
      mutations.push(Reflect.set(req, "value", "999"));
      return new Promise(() => {}); // notification-only: check must not await this.
    },
    onVerdict(verdict) {
      emitted.push(verdict);
      immutable.push(Object.isFrozen(verdict), Object.isFrozen(verdict.metadata), Object.isFrozen(verdict.reasons));
      mutations.push(Reflect.set(verdict, "decision", "allow"));
      if (emitted.length === 1) return Promise.reject(new Error("asynchronous hook rejection"));
      throw new Error("synchronous hook failure");
    },
    onAwaitingUser() { awaiting++; throw new Error("notification failure"); },
    onDiagnostic(event) { diagnostics.push(event); throw new Error("must not recurse"); },
  } });
  const core = await open(t, setup);
  const result = await core.check(request("approve", MAX_U256));
  assert.equal(result.decision, "warn");
  assert.equal(result.source, "evaluated");
  assert.ok(hasReason(result, "unlimited-approval-deny"));
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(awaiting, 1);
  assert.deepEqual(emitted[0].metadata, result.metadata);
  const plan = await core.plan(request("approve", 7n));
  const direct = core.evaluate(plan, { planId: plan.planId, results: {} });
  await tick();
  assert.equal(direct.decision, "allow");
  assert.equal(pending.length, 1, "direct plan/evaluate does not emit check's onPending");
  assert.equal(emitted.length, 2, "one onVerdict notification per public evaluation");
  assert.equal(awaiting, 1, "onAwaitingUser only fires for warn");
  assert.deepEqual(emitted[1].metadata, direct.metadata);
  assert.ok(immutable.every(Boolean));
  assert.ok(mutations.every((changed) => changed === false));
  assert.ok(diagnostics.some(({ code }) => code === "hook_error"));
  assert.ok(diagnostics.length <= 4, "onDiagnostic throwing must not report itself recursively");
});

test("cache retains separate explicit block parameters and their observed block provenance", options, async (t) => {
  const id = "check-block-balance";
  const params = structuredClone(catalogManifest.policy_rpc[0].params);
  const manifest = {
    id, schema_version: 2, trigger: { where: { "action.tag": { eq: "erc20_transfer" } } },
    policy_rpc: ["20000000", "20000001"].map((blockNumber, index) => ({
      id: `at-${index}`, method: "portfolio.balance", params: { ...params, blockNumber }, optional: false,
      outputs: [{ kind: "context", field: `balance${index}`, type: "String", from: "$.result.balance", required: true }],
    })),
    custom_context: { fields: { balance0: "String", balance1: "String" } },
  };
  const policy = `@id("${id}") @severity("warn") forbid(principal, action == Token::Action::"Erc20Transfer", resource) when { context has custom && context.custom has balance0 && context.custom has balance1 && context.custom.balance0 != context.custom.balance1 };`;
  const setup = harness({ policy: signed([{ id, manifest, policy }]) });
  setup.setFacts(async (calls, context) => batch(calls, context, (call) =>
    fact(call.params.blockNumber === "20000000" ? "0x64" : "0xc8", NOW, call.params.blockNumber)));
  const core = await open(t, setup);
  const first = await core.check(request());
  assert.equal(first.decision, "warn");
  assert.equal(first.source, "evaluated");
  assert.equal(setup.fetches[0].calls.length, 2);
  const second = await core.check(request());
  assert.equal(second.decision, "warn");
  assert.equal(setup.fetches.length, 1);
  assert.deepEqual(second.facts, first.facts);
  assert.deepEqual(second.facts.map(({ blockNumber, value }) => [blockNumber, value.balance]), [
    ["20000000", "0x64"], ["20000001", "0xc8"],
  ]);
});
