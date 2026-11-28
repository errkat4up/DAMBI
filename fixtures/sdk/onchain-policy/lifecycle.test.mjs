import assert from "node:assert/strict";
import test from "node:test";
import { createOnchainPolicySource } from "../../../packages/core/dist/adapters/index.js";
import { fakeRpc, NOW } from "./fake-rpc.mjs";
import { loadIntegration, openSource, publish, assertEvaluated, assertPlanRejected } from "./fixtures.mjs";

// The default pinned F5 base does not contain F1. This explicit integration
// entry fails for missing inputs; it never skips or tests the legacy HTTP path.
const integration = await loadIntegration();
const { createCore, CoreError, config, signed, input } = integration;
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const settings = { timeout: 15_000 };
async function open(t, rpc, source = openSource(createOnchainPolicySource, rpc)) {
  const core = await createCore(config(source, rpc));
  t.after(() => core.dispose());
  return { core, source };
}
async function rejectedCreate(rpc, expected) {
  let core;
  try {
    await assert.rejects(async () => {
      core = await createCore(config(openSource(createOnchainPolicySource, rpc), rpc));
    }, code(expected));
  } finally { core?.dispose(); }
}
function deny(verdict, version = 42) {
  assertEvaluated(verdict, "deny", version, input.denyPolicyId);
}

test("F1/F5 provenance labels and direct active source -> public Core -> policy deny", settings, async (t) => {
  t.diagnostic(JSON.stringify(integration.provenance));
  const rpc = await fakeRpc(t);
  const bundle = signed(42);
  publish(rpc, bundle);
  const source = openSource(createOnchainPolicySource, rpc);
  const candidate = await source.fetch();
  assert.equal(candidate.payload, bundle.payload);
  assert.equal(candidate.signature, bundle.signature);
  assert.deepEqual(JSON.parse(candidate.payload).registry_ref, input.registryRef);
  assert.equal(candidate.registryState.chainId, 91342);
  assert.equal(candidate.registryState.blockNumber, 100);
  assert.equal(candidate.registryState.version, 42);
  assert.equal(candidate.registryState.finality, "finalized");
  const { core } = await open(t, rpc, source);
  deny(await core.check(input.request));
  assert.ok(rpc.requests.length >= 14, "Core initialization itself must revalidate the chain");
  assert.deepEqual(rpc.rejectedCalls, []);
});

test("same registry-bound payload: bad P-256 is INVALID_SIGNATURE, revoked is POLICY_EXPIRED", settings, async (t) => {
  const rpc = await fakeRpc(t);
  const bundle = signed(42);
  publish(rpc, bundle);
  const { core } = await open(t, rpc);
  deny(await core.check(input.request));

  // Keep valid JSON, registry_ref, tuple digest, version and all time fields.
  // Only the signature changes; a schema/fetch/engine rejection is not a pass.
  const badSignature = Buffer.from(bundle.signature, "base64");
  badSignature[0] ^= 1;
  publish(rpc, { ...bundle, signature: badSignature.toString("base64") });
  await rejectedCreate(rpc, "INVALID_SIGNATURE");

  // Restore exactly the original signed bytes and alter only registry status.
  publish(rpc, bundle, 3);
  await rejectedCreate(rpc, "POLICY_EXPIRED");
  assert.deepEqual(rpc.rejectedCalls, []);
});

test("F0 new-active rule invalidates v1 plan; v2 is evaluated, then confirmed revocation blocks pending work", settings, async (t) => {
  const rpc = await fakeRpc(t);
  publish(rpc, signed(42));
  const { core } = await open(t, rpc);
  deny(await core.check(input.request));
  const v1Plan = await core.plan(input.request);
  rpc.advance();
  const v2 = signed(43, "allow");
  publish(rpc, v2);
  await core.refreshPolicies();
  assertPlanRejected(core, v1Plan, input.replacedPlan, CoreError);
  assertEvaluated(await core.check(input.request), "allow", 43);
  const v2Plan = await core.plan(input.request);
  rpc.advance();
  publish(rpc, v2, 3);
  if (input.revokedRefresh === "resolves") await core.refreshPolicies();
  else await assert.rejects(core.refreshPolicies(), code("POLICY_EXPIRED"));
  assertPlanRejected(core, v2Plan, input.revokedPlan, CoreError);
  await assert.rejects(core.plan(input.request), code("POLICY_EXPIRED"));
  // Losing RPC afterwards must not resurrect the formerly active v2 snapshot.
  rpc.mode = "outage";
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  await assert.rejects(core.plan(input.request), code("POLICY_EXPIRED"));
  rpc.mode = "ok";
  await rejectedCreate(rpc, "POLICY_EXPIRED");
});

test("host refresh hint, outage grace, exact deadline stop and recovery without re-signing", settings, async (t) => {
  const rpc = await fakeRpc(t);
  const bundle = signed(42);
  publish(rpc, bundle);
  const { core, source } = await open(t, rpc);
  assert.equal(source.refreshDue(), false);
  rpc.now = NOW + 5000;
  assert.equal(source.refreshDue(), true);
  // Host refreshes on the configured interval; a failure is not revocation.
  rpc.mode = "outage";
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  deny(await core.check(input.request));
  await rejectedCreate(rpc, "POLICY_FETCH_FAILED");
  const pending = await core.plan(input.request);
  const pendingAfterDeadline = await core.plan(input.request);
  rpc.now = NOW + input.stateDeadlineMs - 1;
  deny(await core.check(input.request));
  // The plan handle remains within its 60-second TTL. Expired policy trust
  // rejects new planning with CoreError, but evaluation of an existing live
  // handle returns fail_closed + trust_expired, not policy_expired.
  assert.ok(pending.expiresAt > NOW + input.stateDeadlineMs + 1);
  assert.ok(pendingAfterDeadline.expiresAt > NOW + input.stateDeadlineMs + 1);
  rpc.now++;
  await assert.rejects(core.plan(input.request), code("POLICY_EXPIRED"));
  assertPlanRejected(core, pending, { kind: "fail_closed", code: "trust_expired" }, CoreError);
  rpc.now++;
  await assert.rejects(core.plan(input.request), code("POLICY_EXPIRED"));
  assertPlanRejected(core, pendingAfterDeadline, { kind: "fail_closed", code: "trust_expired" }, CoreError);

  rpc.mode = "ok";
  // Reobserving the old block cannot renew the original observation deadline.
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  await assert.rejects(core.plan(input.request), code("POLICY_EXPIRED"));
  rpc.advance();
  assert.equal(rpc.tuple, (await import("./fake-rpc.mjs")).encodeRead(bundle));
  await core.refreshPolicies();
  deny(await core.check(input.request));
  assert.equal(source.refreshDue(), false);
  const count = rpc.requests.length;
  const restarted = await open(t, rpc);
  assert.ok(rpc.requests.length > count, "Restart cannot restore active state solely from cache");
  deny(await restarted.core.check(input.request));
});

test("resume revalidates; reorg and chain mismatch do not install a replacement", settings, async (t) => {
  const rpc = await fakeRpc(t);
  publish(rpc, signed(42));
  const { core } = await open(t, rpc);
  rpc.advance();
  publish(rpc, signed(43, "allow"));
  rpc.recheckHash = `0x${"99".repeat(32)}`;
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  deny(await core.check(input.request));
  rpc.recheckHash = undefined;
  rpc.chainId = "0x1";
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  await rejectedCreate(rpc, "POLICY_FETCH_FAILED");
  deny(await core.check(input.request));
  rpc.chainId = "0x164ce";
  // Explicit resume refresh, not a timer hidden inside Core.
  await core.refreshPolicies();
  assertEvaluated(await core.check(input.request), "allow", 43);
});
