import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildRegistry, readJson, registryRoot, repoRoot, resolveIndexBundle, sha256 } from "./build-registry.mjs";

export const handoff = await readJson(new URL("../handoff-index.json", import.meta.url));
const fixtureRoot = new URL("../", import.meta.url);
const optionSources = {
  includeTransfer: ["transfer_manifest"],
  includePermit: ["permit_manifest"],
  includePermit2Single: ["permit2_single_manifest"],
  includePermit2Batch: ["permit2_batch_manifest"],
  includeNfpmSelf: ["nfpm_multicall_manifest", "nfpm_mint_manifest", "nfpm_refund_eth_manifest"],
  includeBundler3: ["bundler3_manifest"],
  includeMorphoCallbacks: ["morpho_flash_loan_manifest", "morpho_supply_collateral_manifest"],
};

function suiteById(id) {
  const suite = handoff.suites.find((suite) => suite.id === id);
  assert.ok(suite, `Unknown handoff suite: ${id}`);
  return suite;
}

function sourceKeys(options) {
  assert.deepEqual(Object.keys(options).sort(), Object.keys(optionSources).sort());
  for (const value of Object.values(options)) assert.equal(typeof value, "boolean");
  return ["manifest", ...Object.entries(optionSources).flatMap(([key, sources]) => options[key] ? sources : [])];
}

async function canonicalize(value) {
  const { default: jcs } = await import("../../../registryV2/node_modules/canonicalize/lib/canonicalize.js");
  return jcs(value);
}

// Fixture runners consume the same explicit options that the handoff documents.
// buildRegistry still owns pinned-byte copying, strict execution and failure cleanup.
export function buildHandoffRegistry(selection, suiteId) {
  const { build_options } = suiteById(suiteId);
  sourceKeys(build_options);
  assert.deepEqual(handoff.builder_args, ["--strict-callkeys"]);
  return buildRegistry(selection, build_options);
}

export async function validateHandoffIndex() {
  assert.equal(handoff.schema_version, 1);
  assert.equal(handoff.selection, "registry-selection.json");
  assert.equal(handoff.coverage, "coverage.md");
  assert.deepEqual(handoff.builder_args, ["--strict-callkeys"]);
  const selection = await readJson(new URL(handoff.selection, fixtureRoot));
  assert.deepEqual(handoff.artifacts.map(({ source_key }) => source_key).sort(),
    Object.keys(selection).filter((key) => key !== "tokens").sort());
  assert.equal(new Set(handoff.artifacts.map(({ id }) => id)).size, handoff.artifacts.length);
  const fullKeys = sourceKeys(handoff.full_build_options);
  assert.deepEqual(fullKeys.sort(), handoff.artifacts.map(({ source_key }) => source_key).sort());
  for (const artifact of handoff.artifacts) {
    const selected = selection[artifact.source_key];
    const bytes = await readFile(join(registryRoot, selected.path));
    assert.equal(sha256(bytes), selected.sha256, `Selected source changed: ${selected.path}`);
    const source = JSON.parse(bytes);
    assert.equal(artifact.id, source.id);
    assert.equal(artifact.version, source.id.split("@").at(-1));
    assert.match(artifact.bundle_sha256, /^0x[0-9a-f]{64}$/);
    assert.equal(artifact.index_format, source.match.chain_to_addresses_source ? "3-ref" : "inline");
    assert.equal(artifact.live_inputs_ref,
      source.emit.live_inputs ? `registryV2/${selected.path}#/emit/live_inputs` : null);
    assert.ok(artifact.index_paths.length > 0);
    assert.equal(new Set(artifact.index_paths).size, artifact.index_paths.length);
    for (const path of artifact.index_paths) {
      assert.match(path, /^index\/(by-callkey|by-typed-data)\/[^/]+\.json$/);
    }
  }
  for (const token of selection.tokens) {
    assert.equal(sha256(await readFile(join(registryRoot, token.path))), token.sha256, token.path);
  }
  await access(new URL(handoff.coverage, fixtureRoot));
  for (const path of handoff.generation_inputs) await access(join(repoRoot, path));
  assert.equal(new Set(handoff.suites.map(({ id }) => id)).size, handoff.suites.length);
  const fixtureFiles = (await readdir(fixtureRoot)).filter((name) => name.endsWith(".cases.json")).sort();
  assert.deepEqual([...new Set(handoff.suites.map(({ fixture }) => fixture))].sort(), fixtureFiles);
  const packageJson = await readJson(join(repoRoot, "package.json"));
  const runnerFiles = packageJson.scripts["decoder:test"].split(" ").filter((arg) => arg.endsWith(".test.mjs"));
  assert.deepEqual(handoff.suites.map(({ verification }) => `fixtures/decoder-policy/${verification}`).sort(), runnerFiles.sort());
  for (const suite of handoff.suites) {
    const fixture = await readJson(new URL(suite.fixture, fixtureRoot));
    await access(new URL(suite.verification, fixtureRoot));
    assert.equal(fixture.cases.length, suite.case_count, suite.id);
    const caseIds = fixture.cases.map(({ id }) => id);
    assert.equal(new Set(caseIds).size, caseIds.length, suite.id);
    const selectedKeys = sourceKeys(suite.build_options);
    const paths = selectedKeys.map((key) => selection[key].path);
    for (const path of fixture.registry_sources ?? [fixture.registry_source]) assert.ok(paths.includes(path), path);
    for (const [path, digest] of Object.entries(fixture.registry_source_sha256 ?? {})) {
      assert.equal(Object.values(selection).find((source) => source.path === path)?.sha256, digest);
    }
    for (const [id, digest] of Object.entries(fixture.expected_bundle_digests ?? {})) {
      assert.equal(handoff.artifacts.find((artifact) => artifact.id === id)?.bundle_sha256, digest);
    }
    assert.ok(suite.scenarios.length > 0);
    assert.equal(new Set(suite.scenarios.map(({ id }) => id)).size, suite.scenarios.length);
    for (const scenario of suite.scenarios) {
      assert.equal(new Set(scenario.installs).size, scenario.installs.length);
      for (const key of scenario.installs) assert.ok(selectedKeys.includes(key), `${suite.id}/${scenario.id}: ${key}`);
      assert.ok(scenario.case_ids === "all" || Array.isArray(scenario.case_ids));
      for (const id of scenario.case_ids === "all" ? caseIds : scenario.case_ids) assert.ok(caseIds.includes(id), `${suite.id}: ${id}`);
    }
  }
  return selection;
}

// Runs in the isolated worker BEFORE installation. The digest belongs to the
// actual installed object; route output itself has no bundle digest field.
export async function assertHandoffScenario({ handoff: reference, bundles, requests }) {
  assert.ok(reference, "Missing handoff installation scenario");
  const suite = suiteById(reference.suite);
  const scenario = suite.scenarios.find(({ id }) => id === reference.scenario);
  assert.ok(scenario, `Unknown handoff scenario: ${reference.suite}/${reference.scenario}`);
  const artifacts = scenario.installs.map((key) => handoff.artifacts.find(({ source_key }) => source_key === key));
  assert.deepEqual(bundles.map(({ id }) => id), artifacts.map(({ id }) => id), "Installed bundle combination changed");
  for (const [index, bundle] of bundles.entries()) {
    assert.equal(sha256(await canonicalize(bundle)), artifacts[index].bundle_sha256, `Installed digest changed: ${bundle.id}`);
  }
  const fixture = await readJson(new URL(suite.fixture, fixtureRoot));
  const requiredIds = scenario.case_ids === "all" ? fixture.cases.map(({ id }) => id) : scenario.case_ids;
  for (const id of requiredIds) assert.ok(requests.some((request) => request.id === id), `Missing handoff case: ${suite.id}/${scenario.id}/${id}`);
}

// Only stable decoder artifacts enter this comparison: relative index names,
// canonical entries/resolved bundles and physical bundle files. Builder logs,
// source copy paths and execution timing are deliberately not artifacts here.
export async function collectHandoffArtifacts(root) {
  const indexes = {};
  const canonicalBundles = {};
  const selection = await readJson(new URL(handoff.selection, fixtureRoot));
  for (const directory of ["by-callkey", "by-typed-data", "by-selector"]) {
    for (const name of (await readdir(join(root, "index", directory))).sort()) {
      const path = `index/${directory}/${name}`;
      const entry = await readJson(join(root, path));
      const bundle = await resolveIndexBundle(root, entry);
      const artifact = handoff.artifacts.find(({ id }) => id === bundle.id);
      assert.ok(artifact, `Unselected bundle: ${bundle.id}`);
      assert.ok(artifact.index_paths.includes(path), `Unexpected index path: ${path}`);
      assert.equal(entry.bundle_sha256, artifact.bundle_sha256);
      assert.equal(entry.manifest_path, selection[artifact.source_key].path);
      assert.equal(entry.schema_version ?? "inline", artifact.index_format);
      indexes[path] = await canonicalize(entry);
      canonicalBundles[entry.bundle_sha256] = await canonicalize(bundle);
    }
  }
  assert.deepEqual(Object.keys(indexes).sort(), handoff.artifacts.flatMap(({ index_paths }) => index_paths).sort());
  assert.deepEqual(await readdir(join(root, "contexts")), [], "Source context materialization is outside this handoff");
  const physicalBundles = {};
  for (const name of (await readdir(join(root, "bundles"))).sort()) {
    const digest = name.replace(/\.json$/, "");
    physicalBundles[name] = await canonicalize(await readJson(join(root, "bundles", name)));
    assert.equal(physicalBundles[name], canonicalBundles[digest]);
  }
  assert.deepEqual(Object.keys(physicalBundles).sort(), handoff.artifacts
    .filter(({ index_format }) => index_format === "3-ref").map(({ bundle_sha256 }) => `${bundle_sha256}.json`).sort());
  return { indexes, canonicalBundles, physicalBundles };
}

export async function buildReproducibleHandoff() {
  const selection = await validateHandoffIndex();
  let first;
  let second;
  try {
    first = await buildRegistry(selection, handoff.full_build_options);
    second = await buildRegistry(selection, handoff.full_build_options);
    assert.notEqual(first.root, second.root);
    const artifacts = await collectHandoffArtifacts(first.root);
    assert.deepEqual(await collectHandoffArtifacts(second.root), artifacts,
      "Selected Registry indexes or canonical bundles are not reproducible");
    return { ...first, artifacts };
  } catch (error) {
    await first?.cleanup();
    throw error;
  } finally {
    await second?.cleanup();
  }
}
