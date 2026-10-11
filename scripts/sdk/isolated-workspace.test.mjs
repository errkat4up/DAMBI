import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markIsolatedWorkspacePrepared, openIsolatedWorkspace } from "./isolated-workspace.mjs";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "sdk-isolation-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "checkout");
  const runnerTemp = join(base, "runner");
  await mkdir(root);
  await mkdir(runnerTemp);
  return { root, runnerTemp, env: { GITHUB_ACTIONS: "true", RUNNER_TEMP: runnerTemp } };
}

test("CI preserves restored dependencies and prepared sources through verification for post-job saving", async (t) => {
  const { root, env } = await fixture(t);
  const isolated = await openIsolatedWorkspace(root, "prepare", env);
  await writeFile(join(isolated, "Cargo.toml"), "fresh source manifest");
  await markIsolatedWorkspacePrepared(isolated);
  // Emulate the cache action between source preparation and verification.
  await mkdir(join(isolated, "target"));
  await writeFile(join(isolated, "target", "dependency"), "cached dependency");
  assert.equal(await openIsolatedWorkspace(root, "verify", env), isolated);
  assert.equal(await readFile(join(isolated, "Cargo.toml"), "utf8"), "fresh source manifest");
  assert.equal(await readFile(join(isolated, "target", "dependency"), "utf8"), "cached dependency");
  await assert.rejects(openIsolatedWorkspace(root, "verify", env), { code: "ENOENT" });
});

test("CI rejects an unprepared, reused, inside-checkout or symlinked workspace", async (t) => {
  const { root, runnerTemp, env } = await fixture(t);
  const isolated = await openIsolatedWorkspace(root, "prepare", env);
  await assert.rejects(openIsolatedWorkspace(root, "verify", env), { code: "ENOENT" });
  await assert.rejects(openIsolatedWorkspace(root, "prepare", env), { code: "EEXIST" });
  await assert.rejects(openIsolatedWorkspace(root, "prepare", { ...env, RUNNER_TEMP: root }), /outside the checkout/);
  await assert.rejects(openIsolatedWorkspace(root, "prepare", { RUNNER_TEMP: runnerTemp }), /require GitHub Actions/);
  await rm(isolated, { recursive: true });
  await symlink(root, isolated, "dir");
  await assert.rejects(openIsolatedWorkspace(root, "verify", env), /Invalid prepared SDK directory/);
});

test("default local and release verification always starts in a fresh empty workspace", async (t) => {
  const { root, env } = await fixture(t);
  const cached = await openIsolatedWorkspace(root, "prepare", env);
  await markIsolatedWorkspacePrepared(cached);
  const first = await openIsolatedWorkspace(root, "all", env);
  const second = await openIsolatedWorkspace(root, "all", env);
  t.after(() => Promise.all([first, second].map((path) => rm(path, { recursive: true, force: true }))));
  assert.notEqual(first, cached);
  assert.notEqual(second, first);
  assert.deepEqual(await readdir(first), []);
  assert.deepEqual(await readdir(second), []);
});
