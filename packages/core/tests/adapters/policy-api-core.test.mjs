import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { CoreError, createCore } from "@dambi/core";
import { createPolicyApiSource } from "@dambi/core/adapters";

// Use the built package's real WASM and the existing test-only signing key.
// Missing artifacts fail normally; this suite never builds or substitutes an engine.
const fixtures = new URL("../../../../crates/dambi-core/tests/fixtures/", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, fixtures), "utf8"));
const [decoder, initialEnvelope, keys] = await Promise.all([
  readJson("snapshot-approve.json"),
  readJson("policy-bundle/day1.envelope.json"),
  readJson("policy-bundle/test-only-keys.json"),
]);
assert.equal(keys.test_only, true);
const NOW = 1_800_000_000_000;
const CONTRACT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x000000000000000000000000000000000000aaaa";
const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder] });
const expectedDigest = `0x${createHash("sha256").update(artifact, "utf8").digest("hex")}`;
const request = {
  kind: "transaction", chainId: "eip155:1", from: OWNER, to: CONTRACT,
  data: `0x095ea7b3${OWNER.slice(2).padStart(64, "0")}${"7".padStart(64, "0")}`,
  value: "0",
};
const options = { timeout: 15_000 };

function signed(sequence, extra = {}) {
  const payload = JSON.stringify({ ...JSON.parse(initialEnvelope.payload), sequence, ...extra });
  return {
    payload,
    signature: sign("sha256", Buffer.from(payload), {
      key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
    }).toString("base64"),
    key_id: keys.policy.key_id,
  };
}

function harness(policy, { policyTimeoutMs = 5_000 } = {}) {
  let now = NOW;
  return {
    setNow(value) { now = value; },
    config: {
      decoderSnapshot: { artifact, expectedDigest },
      trust: { env: "staging", profile: "default", keys: [{
        keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64,
      }] },
      enforcement: "advisory", clock: { now: () => now },
      limits: {
        allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
        maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
        planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
        factTimeoutMs: 1_000, policyTimeoutMs,
      },
      ports: {
        policy,
        fact: { fetch: async () => { throw new Error("approve must not fetch Facts"); } },
      },
    },
  };
}

function code(expected) {
  return (error) => error instanceof CoreError && error.code === expected;
}

function evaluate(core, plan) {
  const verdict = core.evaluate(plan, { planId: plan.planId, results: {} });
  assert.equal(verdict.source, "evaluated");
  assert.equal(verdict.decision, "allow");
  return verdict.metadata.policyVersion;
}

async function version(core) {
  return evaluate(core, await core.plan(request));
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

async function endpoint(t, envelope = initialEnvelope) {
  const state = { envelope, etag: '"policy-42"', status: 200, requests: [] };
  const server = createServer((req, res) => {
    const conditional = req.headers["if-none-match"];
    const status = state.status !== 200 ? state.status : conditional === state.etag ? 304 : 200;
    state.requests.push({ conditional, status });
    res.writeHead(status, { "Content-Type": "application/json", ETag: state.etag });
    res.end(status === 200 ? JSON.stringify(state.envelope) : undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  return state;
}

function source(state, fetch) {
  return createPolicyApiSource({ baseUrl: state.baseUrl, maxResponseBytes: 1_500_000, fetch });
}

test("HTTP policy source initializes Core, revalidates 304 and refreshes without replacing pinned plans", options, async (t) => {
  const state = await endpoint(t);
  const core = await open(t, harness(source(state)));
  const pinned = await core.plan(request);
  assert.deepEqual(state.requests, [{ conditional: undefined, status: 200 }]);

  await core.refreshPolicies();
  assert.equal(await version(core), "42");
  assert.deepEqual(state.requests.at(-1), { conditional: '"policy-42"', status: 304 });

  state.envelope = signed(43);
  state.etag = '"policy-43"';
  await core.refreshPolicies();
  assert.deepEqual(state.requests.at(-1), { conditional: '"policy-42"', status: 200 });
  assert.equal(evaluate(core, pinned), "42");
  assert.equal(await version(core), "43");
});

test("Core rejects a transport-cached invalid signature and preserves its active snapshot after HTTP failure", options, async (t) => {
  const state = await endpoint(t);
  const core = await open(t, harness(source(state)));
  const pinned = await core.plan(request);
  const invalid = signed(43);
  state.envelope = { ...invalid, payload: `${invalid.payload} ` };
  state.etag = '"unverified-envelope"';

  await assert.rejects(core.refreshPolicies(), code("INVALID_SIGNATURE"));
  // The adapter only validates transport shape. A 304 of that envelope must
  // reach Core verification again instead of being treated as trusted data.
  await assert.rejects(core.refreshPolicies(), code("INVALID_SIGNATURE"));
  assert.deepEqual(state.requests.at(-1), { conditional: state.etag, status: 304 });
  state.status = 503;
  await assert.rejects(core.refreshPolicies(), code("POLICY_FETCH_FAILED"));
  assert.equal(evaluate(core, pinned), "42");
  assert.equal(await version(core), "42");

  state.status = 200;
  state.envelope = signed(44);
  state.etag = '"policy-44"';
  await core.refreshPolicies();
  assert.equal(await version(core), "44");
});

test("304 reuse does not extend a signed policy's expiry in Core", options, async (t) => {
  const state = await endpoint(t, signed(42, { expires_at: NOW / 1000 + 2 }));
  const setup = harness(source(state));
  const core = await open(t, setup);
  setup.setNow(NOW + 1_000);
  await core.refreshPolicies();
  assert.equal(await version(core), "42");

  setup.setNow(NOW + 2_000);
  await assert.rejects(core.refreshPolicies(), code("POLICY_EXPIRED"));
  await assert.rejects(core.plan(request), code("POLICY_EXPIRED"));
  assert.deepEqual(state.requests.map(({ status }) => status), [200, 304, 304]);
});

test("Core timeout, abort and disposal cannot poison shared adapter cache or cancel another Core", options, async (t) => {
  const state = await endpoint(t);
  const queued = [];
  const policy = source(state, (url, init) => {
    const held = queued.shift();
    if (!held) return globalThis.fetch(url, init);
    // Deliberately ignore abort: the adapter must discard and cancel the
    // eventual response independently of the injected transport's behavior.
    held.started.resolve(init);
    return held.response.promise;
  });
  const independent = await open(t, harness(policy));

  for (const [index, reason] of ["TIMEOUT", "ABORTED", "DISPOSED"].entries()) {
    const activeSequence = 42 + index;
    const cancelSetup = harness(policy, { policyTimeoutMs: reason === "TIMEOUT" ? 250 : 5_000 });
    const cancelled = await open(t, cancelSetup);
    const originalEtag = state.etag;
    const other = { started: deferred(), response: deferred() };
    const late = { started: deferred(), response: deferred() };
    queued.push(other, late);

    // A newer cancelled request remains a publication barrier. The older
    // request can succeed for its own Core but cannot overwrite shared cache.
    const otherRefresh = independent.refreshPolicies();
    const otherInit = await other.started.promise;
    const controller = new AbortController();
    const rejected = assert.rejects(cancelled.refreshPolicies({ signal: controller.signal }), code(reason));
    const lateInit = await late.started.promise;
    if (reason === "ABORTED") controller.abort();
    if (reason === "DISPOSED") cancelled.dispose();
    await rejected;
    assert.equal(lateInit.signal.aborted, true, reason);
    assert.equal(otherInit.signal.aborted, false, reason);

    const nextEnvelope = signed(activeSequence + 1);
    const nextEtag = `"policy-${activeSequence + 1}"`;
    other.response.resolve(new Response(JSON.stringify(nextEnvelope), { headers: { ETag: nextEtag } }));
    await otherRefresh;
    assert.equal(await version(independent), String(activeSequence + 1), reason);
    if (reason !== "DISPOSED") assert.equal(await version(cancelled), String(activeSequence), reason);

    const bodyCancelled = deferred();
    late.response.resolve(new Response(new ReadableStream({
      start(stream) { stream.enqueue(Buffer.from(JSON.stringify(signed(100 + index)))); },
      cancel() { bodyCancelled.resolve(); },
    }), { headers: { ETag: '"late-poison"' } }));
    await bodyCancelled.promise;
    state.envelope = nextEnvelope;
    state.etag = nextEtag;
    await independent.refreshPolicies();
    assert.deepEqual(state.requests.at(-1), { conditional: originalEtag, status: 200 }, reason);
    assert.equal(await version(independent), String(activeSequence + 1), reason);
    cancelled.dispose();
  }
});
