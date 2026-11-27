import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NOW, REGISTRY, encodeRead, options } from "./fake-rpc.mjs";

// F1 is intentionally not copied into this F5 checkout. Injection is a real
// installed SDK plus JSON source inputs, never a createCore wrapper/test stub.
// Known lifecycle expectations are fixed below, not operator-selected outcomes.
// Missing remaining wire/policy inputs are hard failures, never HTTP fallbacks.
export async function loadIntegration() {
  function required(name) {
    const value = process.env[name];
    assert.ok(value, `Missing ${name}; see packages/core/README.md, F1/F5 integration inputs`);
    return value;
  }
  const f1Sha = required("DAMBI_F1_SHA");
  const f5Sha = required("DAMBI_F5_SHA");
  for (const sha of [f1Sha, f5Sha]) assert.match(sha, /^[0-9a-f]{40}$/);
  const consumer = required("DAMBI_F1_CONSUMER");
  const inputPath = required("DAMBI_F1_INPUT");
  assert.ok(isAbsolute(consumer) && isAbsolute(inputPath), "Use explicit absolute local paths");
  const require = createRequire(join(consumer, "package.json"));
  const packagePath = require.resolve("@dambi/core/package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(pkg.name, "@dambi/core");
  const entry = pkg.exports?.["."]?.import;
  assert.ok(typeof entry === "string" && entry.startsWith("./"));
  const sdk = await import(new URL(entry, pathToFileURL(packagePath)).href);
  assert.equal(typeof sdk.createCore, "function");
  assert.equal(typeof sdk.CoreError, "function");
  const supplied = JSON.parse(await readFile(inputPath, "utf8"));
  assert.ok(supplied && typeof supplied === "object" && !Array.isArray(supplied));
  // Defaults describe the reviewed F1 public contract. Keep the independent
  // package selection and input/source SHA binding mandatory. Existing complete
  // input files remain usable; conflicting expectations fail rather than
  // selecting a different assertion path.
  const input = {
    limits: {},
    stateDeadlineMs: 20_000,
    planRule: "invalidate-on-new-active",
    replacedPlan: { kind: "fail_closed", code: "trust_expired" },
    revokedPlan: { kind: "fail_closed", code: "trust_expired" },
    revokedRefresh: "resolves",
    ...supplied,
    trust: { env: "staging", profile: "default", ...supplied.trust },
  };
  assert.equal(input.f1Sha, f1Sha, "Configuration/drafts must identify the same F1 contract");
  assert.ok(input.registryRef && typeof input.registryRef === "object" && !Array.isArray(input.registryRef));
  assert.ok(input.trust && typeof input.trust === "object" && !Array.isArray(input.trust));
  assert.equal(input.trust.env, "staging");
  assert.equal(input.trust.profile, "default");
  assert.ok(input.trust.registry && typeof input.trust.registry === "object"
    && !Array.isArray(input.trust.registry), "Supply the F1 trust.registry configuration");
  assert.ok(input.limits && typeof input.limits === "object" && !Array.isArray(input.limits));
  assert.equal(input.stateDeadlineMs, 20_000, "Fixture observation deadline is fixed, not an acceptance override");
  assert.equal(input.planRule, "invalidate-on-new-active");
  assert.equal(input.revokedRefresh, "resolves",
    "F1 confirmed-revocation refresh resolves after installing the revocation");
  for (const name of ["replacedPlan", "revokedPlan"]) {
    assert.deepEqual(input[name], { kind: "fail_closed", code: "trust_expired" },
      `${name}: a live handle with invalidated trust must fail closed`);
  }
  assert.equal(input.request?.kind, "transaction");
  assert.equal(input.request.chainId, "eip155:1");
  assert.ok(typeof input.denyPolicyId === "string" && input.denyPolicyId.length > 0);
  for (const draft of [input.denyDraft, input.allowDraft]) {
    assert.ok(draft && typeof draft === "object" && !Array.isArray(draft));
    assert.equal(draft.env, "staging");
    assert.equal(draft.profile, "default");
  }

  const root = new URL("../../../crates/dambi-core/tests/fixtures/", import.meta.url);
  const json = async (name) => JSON.parse(await readFile(new URL(name, root), "utf8"));
  const [decoder, keys] = await Promise.all([
    json("snapshot-approve.json"), json("policy-bundle/test-only-keys.json"),
  ]);
  assert.equal(keys.test_only, true);
  const artifact = JSON.stringify({ schema_version: 1, bundles: [decoder] });
  const decoderSnapshot = { artifact, expectedDigest: `0x${createHash("sha256").update(artifact).digest("hex")}` };
  function signed(sequence, kind = "deny") {
    const payload = JSON.stringify({
      ...(kind === "deny" ? input.denyDraft : input.allowDraft),
      sequence, issued_at: NOW / 1000, expires_at: NOW / 1000 + 3600,
      registry_ref: input.registryRef,
    });
    return { sequence, payload, keyId: keys.policy.key_id,
      signature: sign("sha256", Buffer.from(payload), {
        key: keys.policy.private_key_pkcs8_pem, dsaEncoding: "ieee-p1363",
      }).toString("base64") };
  }
  function config(policy, rpc) {
    return {
      decoderSnapshot,
      trust: { ...input.trust, env: "staging", profile: "default", keys: [{
        keyId: keys.policy.key_id, role: "policy", publicKeySpkiBase64: keys.policy.public_key_spki_b64,
      }] },
      limits: {
        ...input.limits,
        allowedClockSkewMs: 1000, maxPolicyBytes: 1_000_000, maxDecoderBytes: 1_000_000,
        maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 32,
        planTtlMs: 60_000, maxPendingPlans: 8, maxFactAgeMs: 30_000,
        factTimeoutMs: 1000, policyTimeoutMs: 5000,
      },
      enforcement: "enforcing", clock: { now: () => rpc.now },
      ports: { policy, fact: { async fetch() { assert.fail("Selected approve requires no Facts"); } } },
    };
  }
  return { ...sdk, input, signed, config, provenance: {
    f1Sha, f5Sha, packageVersion: pkg.version, connection: "loopback-fake-rpc",
    registryChainId: 91342, registryAddress: REGISTRY, transactionChainId: 1,
    // Labels supplied by the operator, not Git/artifact provenance attestation.
    provenanceSource: "operator-supplied",
  } };
}

// Only the actual F5 adapter is injected here, not a policy envelope port.
export function openSource(createOnchainPolicySource, rpc, extra = {}) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return createOnchainPolicySource(options(rpc, {
    ...extra,
    fetch(url, init) {
      assert.equal(new URL(url).href, new URL(rpc.url).href, "Policy HTTP and remote endpoints are forbidden");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(body.method));
      return nativeFetch(url, init);
    },
  }));
}

export function publish(rpc, bundle, status = 1) {
  rpc.tuple = encodeRead({ ...bundle, status });
}

export function assertEvaluated(verdict, decision, version, policyId) {
  assert.equal(verdict.source, "evaluated");
  assert.equal(verdict.decision, decision);
  assert.equal(verdict.enforcement, "enforcing");
  assert.equal(verdict.metadata.status, "available");
  assert.equal(verdict.metadata.policyVersion, String(version));
  if (policyId) assert.ok(verdict.reasons.some((reason) => reason.policyId === policyId));
}

export function assertPlanRejected(core, plan, expectation, CoreError) {
  const evaluate = () => core.evaluate(plan, { planId: plan.planId, results: {} });
  if (expectation.kind === "throw") {
    assert.throws(evaluate, (error) => error instanceof CoreError && error.code === expectation.code);
  } else {
    const verdict = evaluate();
    assert.equal(verdict.source, "fail_closed");
    assert.equal(verdict.decision, "deny");
    assert.ok(verdict.diagnostics.some((diagnostic) => diagnostic.code === expectation.code));
  }
}
