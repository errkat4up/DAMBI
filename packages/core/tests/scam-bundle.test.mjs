import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CoreError, createCore } from "@dambi/core";
import { createScamBundleApiSource } from "@dambi/core/adapters";

// Public SDK + production WASM only. No fixture installer, algorithm stub,
// network, key generation or build is performed by this test.
const fixtures = new URL("../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const giwa = new URL("../../../fixtures/sdk/giwa-sf0/", import.meta.url);
const json = async (url) => JSON.parse(await readFile(url, "utf8"));
const [keys, policy, decoder, evidence] = await Promise.all([
  json(new URL("policy-bundle/test-only-keys.json", fixtures)),
  json(new URL("policy-bundle/day1.envelope.json", fixtures)),
  json(new URL("decoders/swap-exact-eth-for-tokens.json", giwa)),
  json(new URL("rpc-evidence.json", giwa)),
]);
assert.equal(keys.test_only, true);
const NOW = 1_800_000_000_000;
const FACTORY = "0xd51d7c2a3b9b0f6876336c165adda94468500c47";
const WETH = "0x4200000000000000000000000000000000000006";
const tx = evidence.queries.find(({ request }) => request.method === "eth_getTransactionByHash" &&
  request.params[0] === "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9").response.result;
const request = { kind: "transaction", chainId: "eip155:91342", from: tx.from,
  to: tx.to, data: tx.input, value: BigInt(tx.value).toString() };
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function payload(sequence = "1", overrides = {}) {
  const candidate = { rules: [{ id: "r1", enabled: true, kind: "change_count",
    metric: "quote_reserve", lookbackSec: 10, direction: "either", changeMode: "step",
    thresholdBps: 500, count: 2 }], bucketMs: 1_000, gridOriginMs: 0,
    warmupSec: 1, maxDataAgeSec: 30 };
  return { kind: "scam_bundle", schema: "0.1", sequence, issuedAtMs: NOW - 60_000,
    expiresAtMs: NOW + 60_000, env: "staging", profile: "default",
    compatibility: { engineRange: "*", builderRange: "dambi-v2/1", contractVersion: "0.1", algorithm: null },
    support: [{ chainId: 91342, venue: "uniswap_v2", factories: [FACTORY], quoteTokens: [WETH],
      exemptTokens: [WETH], allowedBucketMs: [1_000, 2_000], confirmDepth: 2 }],
    presets: [{ id: "signed-demo", purpose: "demo",
      selection: { ageThresholdSec: 60, unknownAge: "new_provisional_insufficient" },
      newMarket: { ...structuredClone(candidate), id: "new" },
      established: { ...structuredClone(candidate), id: "established" } }],
    templates: {}, model: null, ...overrides };
}
function signed(value = payload(), key = keys.decoder) {
  // Whitespace deliberately differs from canonical JSON: verify these bytes.
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { payload: raw, signature: sign("sha256", Buffer.from(raw), {
    key: key.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
  }).toString("base64"), keyId: "untrusted-server-label" };
}
function setup({ configured = true, timeout = 1_000 } = {}) {
  let now = NOW;
  let fetchScam = async () => signed();
  let fetchPolicy = async () => ({ payload: policy.payload, signature: policy.signature });
  const diagnostics = [];
  const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder] });
  const config = {
    decoderSnapshot: { artifact, expectedDigest: `0x${createHash("sha256").update(artifact).digest("hex")}` },
    trust: { env: "staging", profile: "default", keys: [{ keyId: keys.policy.key_id,
      role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64 }] },
    enforcement: "advisory", clock: { now: () => now },
    hooks: { onDiagnostic: (event) => diagnostics.push(event) },
    limits: { allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32, planTtlMs: 60_000,
      maxPendingPlans: 8, maxFactAgeMs: 30_000, factTimeoutMs: 1_000, policyTimeoutMs: timeout },
    ports: { policy: { fetch: (options) => fetchPolicy(options), fetchScam: (options) => fetchScam(options) },
      fact: { fetch: async () => assert.fail("An absent algorithm must not request market data") } },
  };
  if (configured) config.scam = {
    settings: { enabled: true, presetId: "signed-demo", overrides: [], additionalRules: [], locale: "ko" },
    trust: { env: "staging", profile: "default", keys: [{ keyId: "local-scam-only", role: "scam",
      publicKeySpkiBase64: keys.decoder.public_key_spki_b64 }] },
    limits: { scamTimeoutMs: 500, scamEvalReserveMs: 20, maxBundleBytes: 100_000,
      maxResultBytes: 100_000, maxCalls: 16, maxTargets: 8, maxRules: 16,
      maxLogs: 1_000, maxPoints: 1_000, maxAlgorithmWorkUnits: 100_000 },
  };
  return { config, diagnostics, setScam(fn) { fetchScam = fn; }, setPolicy(fn) { fetchPolicy = fn; },
    setNow(value) { now = value; } };
}
async function open(t, state) {
  const core = await createCore(state.config);
  t.after(() => core.dispose());
  return core;
}
const evaluate = (core, plan) => core.evaluate(plan, { planId: plan.planId, results: {} });

test("SF5-1 signed HTTP bundles cross production WASM and only new plans see a refresh", async (t) => {
  const state = setup();
  let bundle = signed();
  const urls = [];
  const source = createScamBundleApiSource({ baseUrl: "https://scam.example", env: "staging",
    profile: "default", maxResponseBytes: 200_000, fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ payload: bundle.payload, signature: bundle.signature,
        key_id: bundle.keyId }), { status: 200 });
    } });
  state.setScam(source.fetchScam);
  const core = await open(t, state);
  const oldPlan = await core.plan(request);
  bundle = signed(payload("2"));
  await core.refreshScam();
  const old = evaluate(core, oldPlan), latest = await core.check(request);
  assert.equal(old.scam.pinned.bundleSequence, "1");
  assert.equal(latest.scam.pinned.bundleSequence, "2");
  assert.deepEqual(latest.metadata, old.metadata);
  assert.equal(latest.source, "evaluated");
  assert.equal(latest.scam.status, "insufficient");
  assert.deepEqual(latest.scam.pinned.algorithm, { state: "unavailable" });
  assert.ok(latest.scam.reasons.includes("algorithm_unavailable"));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => new URL(url).pathname === "/v1/scam-bundle"));
});

test("SF5-1 rejected refreshes retain the valid scam snapshot without changing policy", async (t) => {
  const state = setup(), core = await open(t, state);
  const before = await core.check(request);
  const original = signed();
  for (const [bundle, expected] of [
    [signed(payload("2"), keys.policy), "INVALID_SIGNATURE"],
    [signed(payload("2", { env: "production" })), "SCAM_SCOPE_MISMATCH"],
    [signed(payload("0")), "SCAM_SEQUENCE_REJECTED"],
    [signed(payload("1", { expiresAtMs: NOW + 70_000 })), "SCAM_SEQUENCE_REJECTED"],
    [signed(payload("2", { expiresAtMs: NOW })), "SCAM_EXPIRED"],
    [{ ...original, payload: original.payload + " " }, "INVALID_SIGNATURE"],
  ]) {
    state.setScam(async () => bundle);
    await assert.rejects(core.refreshScam(), code(expected));
    const after = await core.check(request);
    assert.equal(after.scam.pinned.bundleSequence, "1");
    assert.equal(after.scam.pinned.bundleDigest, before.scam.pinned.bundleDigest);
    assert.deepEqual(after.metadata, before.metadata);
  }
  state.setScam(async () => original);
  await core.refreshScam(); // identical signed bytes are idempotent.
  state.setNow(NOW + 60_000);
  const expired = await core.check(request);
  assert.equal(expired.scam.status, "insufficient");
  assert.ok(expired.scam.reasons.includes("bundle_invalid"));
});

test("SF5-1 initial source failure is explicit and optional configuration keeps policy usable", async (t) => {
  for (const failure of ["absent", "fetch", "signature"]) {
    const state = setup();
    if (failure === "absent") delete state.config.ports.policy.fetchScam;
    else state.setScam(async () => {
      if (failure === "fetch") throw new Error("private remote detail");
      return signed(payload(), keys.policy);
    });
    const core = await open(t, state), verdict = await core.check(request);
    assert.equal(verdict.source, "evaluated");
    assert.equal(verdict.scam.status, "insufficient");
    assert.ok(verdict.scam.reasons.includes("bundle_unavailable"));
    if (failure !== "absent") assert.ok(state.diagnostics.some((d) => d.code === "scam_bundle_unavailable"));
    assert.ok(!JSON.stringify(state.diagnostics).includes("private remote detail"));
  }
  const state = setup({ configured: false });
  state.setScam(async () => assert.fail("An unconfigured consumer must not fetch a scam bundle"));
  const core = await open(t, state);
  assert.equal((await core.check(request)).scam, undefined);
});

test("SF5-1 separate refresh tickets reject superseded, aborted, timed-out and disposed results", async (t) => {
  const state = setup({ timeout: 250 }), core = await open(t, state);
  const old = deferred();
  state.setScam(() => old.promise);
  const pending = core.refreshScam();
  const superseded = assert.rejects(pending, code("ABORTED"));
  await tick();
  state.setScam(async () => signed(payload("2")));
  await core.refreshScam();
  await superseded;
  old.resolve(signed(payload("99")));
  await tick();
  assert.equal((await core.check(request)).scam.pinned.bundleSequence, "2");

  const policyRead = deferred();
  state.setPolicy(() => policyRead.promise);
  const policyRefresh = core.refreshPolicies();
  await tick();
  state.setScam(async () => signed(payload("3")));
  await core.refreshScam();
  const nextPolicy = JSON.stringify({ ...JSON.parse(policy.payload), sequence: 43 });
  policyRead.resolve({ payload: nextPolicy, signature: sign("sha256", Buffer.from(nextPolicy), {
    key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
  }).toString("base64") });
  await policyRefresh;
  assert.equal((await core.check(request)).metadata.policyVersion, "43");

  for (const mode of ["ABORTED", "TIMEOUT", "DISPOSED"]) {
    const late = deferred(), controller = new AbortController();
    state.setScam(() => late.promise);
    const refresh = core.refreshScam({ signal: controller.signal });
    const rejected = assert.rejects(refresh, code(mode));
    await tick();
    if (mode === "ABORTED") controller.abort();
    if (mode === "DISPOSED") core.dispose();
    await rejected;
    late.resolve(signed(payload("100")));
    await tick();
    if (mode !== "DISPOSED") assert.equal((await core.check(request)).scam.pinned.bundleSequence, "3");
  }
  const reentrantCore = await open(t, setup());
  await assert.rejects(reentrantCore.refreshScam(new Proxy({}, {
    getOwnPropertyDescriptor() { reentrantCore.dispose(); return undefined; },
  })), code("DISPOSED"));
});
