import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markIsolatedWorkspacePrepared, openIsolatedWorkspace } from "./isolated-workspace.mjs";

test("isolated Cargo workspace supplies every inherited member dependency with the repository declaration", async () => {
  const root = new URL("../../", import.meta.url);
  const isolated = await readFile(new URL("./isolated/Cargo.toml", import.meta.url), "utf8");
  const repository = await readFile(new URL("Cargo.toml", root), "utf8");
  // These source manifests use single-line dependency declarations. Keep the
  // check source-only: missing inheritance must fail before Cargo is invoked.
  const declarations = (manifest) => {
    const section = manifest.split("[workspace.dependencies]\n")[1]?.split(/^\[/m)[0];
    assert.ok(section, "workspace.dependencies is required");
    return new Map([...section.matchAll(/^([\w-]+)\s*=\s*(.+)$/gm)]
      .map(([, name, value]) => [name, value.trim()]));
  };
  const expected = declarations(repository);
  const actual = declarations(isolated);
  const members = isolated.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(members, "isolated workspace members are required");
  let dependencies = 0;
  for (const [, member] of members.matchAll(/"([^"]+)"/g)) {
    const manifest = await readFile(new URL(`${member}/Cargo.toml`, root), "utf8");
    for (const [, header, body] of manifest.matchAll(/^\[([^\]\n]+)\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
      if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(header)) continue;
      for (const line of body.split("\n").filter((line) => /\bworkspace\s*=\s*true\b/.test(line))) {
        const name = line.match(/^([\w-]+)(?:\.workspace\s*=\s*true|\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b)/)?.[1];
        assert.ok(name, `unsupported inherited dependency declaration in ${member}: ${line}`);
        assert.ok(actual.has(name), `${member} inherits ${name}, missing from isolated workspace`);
        assert.equal(actual.get(name), expected.get(name), `${member}: isolated ${name} differs from repository`);
        dependencies++;
      }
    }
  }
  assert.ok(dependencies > 0, "check must inspect inherited dependencies");
});

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
