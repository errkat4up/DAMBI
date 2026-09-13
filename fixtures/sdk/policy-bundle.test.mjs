import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadPolicyBundle, serializePolicyBundle } from "../../scripts/sdk/policy-bundle.cjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseline = JSON.parse(await readFile(new URL("../baseline-verdicts.json", import.meta.url), "utf8"));

async function isolatedSource(t) {
  const root = await mkdtemp(join(tmpdir(), "dambi-policy-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repoRoot, "policy-bundles", baseline.source.bundle),
    join(root, "policy-bundles", baseline.source.bundle), { recursive: true });
  return root;
}

test("shared source alone preserves the existing serialized baseline hash", async (t) => {
  // No extension, server, generated asset, or fallback exists in this root.
  const root = await isolatedSource(t);
  const bundles = loadPolicyBundle(root, baseline.source.bundle);
  assert.equal(bundles.length, 5);
  const bytes = Buffer.from(serializePolicyBundle(bundles), "utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), baseline.source.sha256);
});

test("missing manifest rejects the bundle instead of synthesizing a permissive trigger", async (t) => {
  const root = await isolatedSource(t);
  await unlink(join(root, "policy-bundles/day1-safety/policies/unlimited-approval-deny/manifest.json"));
  assert.throws(() => loadPolicyBundle(root), { code: "ENOENT" });
});

test("manifest identity mismatch rejects the bundle before it reaches consumers", async (t) => {
  const root = await isolatedSource(t);
  const manifestPath = join(root, "policy-bundles/day1-safety/policies/unlimited-approval-deny/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = "wrong-policy";
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.throws(() => loadPolicyBundle(root), /Invalid manifest identity\/version/);
});
