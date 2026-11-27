import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { probeProviderOptions, readProbeConfig, SCAM_EXECUTION_BUDGET } from "./scam-data-probe-session.mjs";
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

test("S2a host example and probe execute with the same bounded envelope", async () => {
  const doc = await readFile(new URL("../../browser-extension/docs/scam-filter-local-demo.md", import.meta.url), "utf8");
  const script = doc.match(/```javascript\n(const input = \{[\s\S]*?)\n```/)[1];
  // Evaluate configuration construction only. No storage call or network exists
  // in this sandbox. JSON round-trip removes cross-realm object prototypes.
  const host = JSON.parse(JSON.stringify(runInNewContext(`${script}\nscamHostConfig`, {})));
  const config = readProbeConfig({ SCAM_HISTORY_CACHE: "1" });
  const provider = probeProviderOptions(config);
  const budget = SCAM_EXECUTION_BUDGET;
  assert.equal(host.scam.config.limits.maxTargets, budget.maxTargets);
  assert.equal(host.scam.config.limits.maxCalls, budget.maxCalls);
  assert.equal(host.scam.config.limits.maxAlgorithmWorkUnits, budget.maxAlgorithmWorkUnits);
  assert.equal(host.scam.config.limits.maxPoints, budget.maxPoints);
  assert.equal(host.scam.config.limits.maxLogs, budget.maxLogs);
  assert.equal(host.scam.config.limits.maxResultBytes, budget.maxResultBytes);
  assert.equal(host.facts.scam.limits.maxTargets, budget.maxTargets);
  assert.equal(host.facts.scam.limits.maxCalls, budget.maxCalls);
  assert.deepEqual(host.facts.scam.rpc.limits, provider.rpc.limits);
  assert.deepEqual(host.facts.scam.rpc.historyCache, provider.rpc.historyCache);
  assert.equal(host.facts.scam.history.maxPoints, provider.history.maxPoints);
  assert.equal(host.facts.scam.limits.maxResultBytes, provider.limits.maxResultBytes);
  assert.equal(host.facts.scam.limits.timeoutMs, config.timeoutMs);
  assert.equal(config.lookbackSec + config.warmupSec, 172800);
});

test("isolated sources retain the GIWA Native runner and public adapter timing helper", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("./sdk-source-files.json", import.meta.url), "utf8"));
  const copies = new Map(manifest.copies.map(({ from, to }) => [to ?? from, from]));
  // These are executable dependencies, not generated output. The GIWA test
  // invokes fixture_runner, while the public adapter example uses its sibling
  // timing helper. A full checkout must not mask either missing isolated input.
  for (const path of [
    "fixtures/sdk/giwa-sf0/product-decoder.test.mjs",
    "fixtures/sdk/giwa-sf0/product-decoder.cases.json",
    "fixtures/sdk/helpers/native-backend.mjs",
    "crates/dambi-core/examples/fixture_runner.rs",
    "examples/sdk-adapters/client.mjs",
    "examples/sdk-adapters/check-timing.mjs",
  ]) {
    assert.equal(copies.get(path), path, `${path} must retain its repository-relative location`);
    assert.ok((await readFile(new URL(path, root), "utf8")).length > 0, `${path} must be a nonempty source input`);
  }
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
