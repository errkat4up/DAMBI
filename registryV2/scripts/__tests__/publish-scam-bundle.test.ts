import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { publishScamBundle, validateScamBundleDraft } from "../publish-scam-bundle.js";

// Existing explicitly test-only fixture, read only by this test. No key generation,
// production config, committed signed output or implicit publisher key fallback.
const fixture = JSON.parse(readFileSync(new URL("../../../crates/dambi-core/tests/fixtures/policy-bundle/test-only-keys.json", import.meta.url), "utf8"));
assert.equal(fixture.test_only, true);
const privateKey = createPrivateKey(fixture.decoder.private_key_pkcs8_pem);
const publicKey = createPublicKey(privateKey);
const scalar = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url").toString("hex");
const NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function draft(sequence = "0") {
  const effective = { id: "base", rules: [{ id: "r1", enabled: true, kind: "change_count", metric: "quote_reserve",
    lookbackSec: 60, direction: "either", changeMode: "step", thresholdBps: 500, count: 2 }],
    bucketMs: 10_000, gridOriginMs: 0, warmupSec: 10, maxDataAgeSec: 30 };
  return { kind: "scam_bundle", schema: "0.1", sequence, issuedAtMs: NOW - 1000, expiresAtMs: NOW + 60_000,
    env: "staging", profile: "default", model: null,
    compatibility: { engineRange: "*", builderRange: "*", contractVersion: "0.1", algorithm: null },
    support: [{ chainId: 91342, venue: "uniswap_v2", factories: [`0x${"a".repeat(40)}`],
      quoteTokens: [`0x${"b".repeat(40)}`], exemptTokens: [], allowedBucketMs: [10_000], confirmDepth: 2 }],
    presets: [{ id: "demo", purpose: "demo", selection: { ageThresholdSec: 3600, unknownAge: "new_provisional_insufficient" },
      newMarket: effective, established: structuredClone(effective) }], templates: { detected: "변동 경고" } };
}
function options(input = draft()) {
  const root = mkdtempSync(join(tmpdir(), "dambi-scam-publisher-"));
  roots.push(root);
  const signingKeyPath = join(root, "explicit-test-only-scam.hex");
  writeFileSync(signingKeyPath, scalar, { mode: 0o600 });
  return { input, env: "staging" as const, profile: "default", signingKeyPath,
    keyId: "scam-test-only", outRoot: root, nowMs: NOW };
}

test("scam publisher preserves signed JCS bytes and writes only its environment scope", () => {
  const opts = options();
  const result = publishScamBundle(opts);
  assert.equal(result.sequence, "0");
  assert.equal(result.signed.key_id, "scam-test-only");
  const signature = Buffer.from(result.signed.signature, "base64");
  assert.equal(signature.byteLength, 64);
  assert.equal(verify("sha256", Buffer.from(result.signed.payload, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
  assert.equal(verify("sha256", Buffer.from(result.signed.payload + " ", "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature), false);
  assert.equal(readFileSync(result.written[0], "utf8"), readFileSync(result.written[1], "utf8"));
  assert.deepEqual(JSON.parse(result.signed.payload), opts.input);
  assert.equal(existsSync(join(opts.outRoot, "policy-bundles")), false);
  assert.equal(existsSync(join(opts.outRoot, "scam-bundles", "production")), false);
});

test("scam publisher rejects scope, decimal sequence, expiry and model mismatches before output", () => {
  const invalid = [
    { kind: "policy_bundle" }, { schema: "0.2" }, { env: "production" }, { profile: "other" },
    { sequence: 1 }, { sequence: "01" }, { sequence: "-1" }, { sequence: "1\n" }, { sequence: "1".repeat(79) },
    { sequence: (1n << 256n).toString() },
    { issuedAtMs: NOW + 1 }, { expiresAtMs: NOW }, { expiresAtMs: null }, { model: {} },
    { support: [] }, { presets: [] }, { templates: { warning: 42 } }, { policies: [] },
  ];
  for (const patch of invalid) {
    assert.throws(() => validateScamBundleDraft({ ...draft(), ...patch }, "staging", "default", NOW));
  }
  assert.throws(() => validateScamBundleDraft({ ...draft(), profile: "../default" }, "staging", "../default", NOW));
  assert.throws(() => validateScamBundleDraft({ ...draft(), profile: "a".repeat(129) }, "staging", "a".repeat(129), NOW));
  const opts = options();
  assert.throws(() => publishScamBundle({ ...opts, signingKeyPath: "" }), /SCAM_SIGNING_KEY_PATH/);
  assert.throws(() => publishScamBundle({ ...opts, keyId: "" }), /SCAM_SIGNING_KEY_ID/);
  assert.equal(existsSync(join(opts.outRoot, "scam-bundles")), false);
});

test("scam publisher keeps versions immutable, compares large sequences exactly and serializes latest writes", () => {
  const opts = options(draft("9007199254740992"));
  const first = publishScamBundle(opts);
  const original = readFileSync(first.written[0], "utf8");
  assert.throws(() => publishScamBundle(opts), /immutable/);
  assert.throws(() => publishScamBundle({ ...opts, input: { ...opts.input, templates: { detected: "changed" } } }), /immutable/);
  assert.throws(() => publishScamBundle({ ...opts, input: draft("9007199254740991") }), /backwards/);
  assert.equal(readFileSync(first.written[0], "utf8"), original);
  assert.equal(readFileSync(first.written[1], "utf8"), original);
  const next = publishScamBundle({ ...opts, input: draft("9007199254740993") });
  assert.equal(JSON.parse(JSON.parse(readFileSync(next.written[1], "utf8")).payload).sequence, "9007199254740993");
  const lock = join(opts.outRoot, "scam-bundles", "staging", "default", ".publish.lock");
  writeFileSync(lock, "existing writer");
  assert.throws(() => publishScamBundle({ ...opts, input: draft("9007199254740994") }), /EEXIST/);
  assert.equal(readFileSync(lock, "utf8"), "existing writer");
});

test("scam publisher dry run writes no artifacts and corrupt previous scope cannot advance latest", () => {
  const opts = options();
  assert.deepEqual(publishScamBundle({ ...opts, dryRun: true }).written, []);
  assert.equal(existsSync(join(opts.outRoot, "scam-bundles")), false);
  const dir = join(opts.outRoot, "scam-bundles", "staging", "default");
  mkdirSync(dir, { recursive: true });
  const previous = JSON.stringify({ payload: JSON.stringify({ ...draft(), env: "production" }) });
  writeFileSync(join(dir, "latest.json"), previous);
  assert.throws(() => publishScamBundle({ ...opts, input: draft("1") }), /previous scam scope/);
  assert.equal(readFileSync(join(dir, "latest.json"), "utf8"), previous);
  assert.equal(existsSync(join(dir, "1.json")), false);
});
