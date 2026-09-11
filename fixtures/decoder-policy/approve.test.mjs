import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRegistry, readJson, repoRoot, resolveIndexBundle } from "./helpers/build-registry.mjs";

const execFileAsync = promisify(execFile);
const selection = await readJson(new URL("./registry-selection.json", import.meta.url));
const fixture = await readJson(new URL("./approve.cases.json", import.meta.url));
const decoderId = "standard/erc20/approve@1.0.0";
const selector = "0x095ea7b3";
let registry;
let bundle;
let entries;
let installed;
let empty;

async function runScenario(name, bundles, cases) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({
    bundles,
    requests: cases.map(({ id, input }) => ({ id, input: { ...fixture.defaults, ...input } })),
  }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`WASM scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  // Missing prerequisites are failures, never skipped tests or implicit builds.
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; build the legacy WASM first (see README.md).`);
    });
  }
  assert.equal(fixture.registry_source, selection.manifest.path);
  assert.equal(fixture.cases.length, 27, "Required DEC-01 case count changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  registry = await buildRegistry(selection);
  const expectedFiles = selection.tokens.map(({ chain_id, address }) => `${chain_id}__${address}__${selector}.json`).sort();
  const callkeyDir = join(registry.root, "index/by-callkey");
  assert.deepEqual((await readdir(callkeyDir)).sort(), expectedFiles);
  assert.deepEqual(await readdir(join(registry.root, "index/by-typed-data")), []);
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);
  entries = [];
  for (const name of expectedFiles) {
    const entry = await readJson(join(callkeyDir, name));
    assert.equal(entry.schema_version, "3-ref");
    assert.equal(entry.bundle_id, decoderId);
    assert.equal(entry.manifest_path, selection.manifest.path);
    const resolved = await resolveIndexBundle(registry.root, entry);
    if (bundle) assert.deepEqual(resolved, bundle, "All four callkeys must resolve to the same bundle");
    bundle = resolved;
    entries.push(entry);
  }
  assert.equal(bundle.schema_version, "3");
  assert.deepEqual(bundle.match, {
    selector,
    chain_to_addresses: Object.fromEntries(selection.tokens.map(({ chain_id, address }) => [String(chain_id), [address]])),
  });
  // Only match is expanded. ABI, emit, requires and other source fields survive.
  const { match: sourceMatch, ...sourceFields } = registry.source;
  const { match: resolvedMatch, ...resolvedFields } = bundle;
  assert.deepEqual(resolvedFields, sourceFields);
  assert.equal(sourceMatch.chain_to_addresses_source, "tokens:erc20");
  assert.equal(resolvedMatch.chain_to_addresses_source, undefined);
  // Every generated index and digest has been checked before any installation.
  const normal = fixture.cases.find(({ id }) => id === "amount-normal");
  assert.ok(normal);
  const scenarios = await Promise.allSettled([
    runScenario("installed", [bundle], fixture.cases),
    runScenario("empty", [], [normal]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map(({ reason }) => reason), "WASM installation scenarios failed");
  }
  [installed, empty] = scenarios.map(({ value }) => value);
  assert.deepEqual(installed.results.map(({ id }) => id), fixture.cases.map(({ id }) => id));
}, { timeout: 200_000 });

after(async () => {
  await registry?.cleanup();
});

test("actual source expands four chains; inline/ref resolution verifies resolved JCS digests", async () => {
  assert.equal(entries.length, 4);
  // This is the API's inline envelope for the SAME actual resolved bundle, not
  // a second authored manifest or a claim that approve's builder emits inline.
  const { schema_version, bundle_ref, ...inlineFields } = entries[0];
  assert.equal(schema_version, "3-ref");
  assert.ok(bundle_ref);
  assert.deepEqual(await resolveIndexBundle(registry.root, { ...inlineFields, bundle }), bundle);
  const tampered = structuredClone(bundle);
  tampered.requires.extension = ">=999.0.0";
  await assert.rejects(
    resolveIndexBundle(registry.root, { ...inlineFields, bundle: tampered }),
    /Resolved bundle JCS digest mismatch/,
  );
  await assert.rejects(
    resolveIndexBundle(registry.root, { ...entries[0], bundle_sha256: `0x${"0".repeat(64)}` }),
    /Resolved bundle JCS digest mismatch/,
  );
  await assert.rejects(
    resolveIndexBundle(registry.root, { ...entries[0], context_ref: "contexts/unsupported.json" }),
    /does not materialize source contexts/,
  );
});

test("installation scenarios use separate WASM processes", () => {
  assert.equal(installed.installations.length, 1);
  assert.deepEqual(installed.installations[0].data, { decoder_id: decoderId, bundle_id: decoderId });
  assert.deepEqual(empty.installations, []);
  assert.equal(empty.results.length, 1);
  assert.equal(empty.results[0].id, "amount-normal");
  assertFailure(empty.results[0].result, "no_declarative_v3_mapper");
  assert.equal(installed.results.find(({ id }) => id === "amount-normal").result.ok, true);
});

test("fixed calldata words independently preserve uint256 boundary values", () => {
  const boundaries = new Map([
    ["amount-zero", 0n],
    ["amount-normal", 1_000_000n],
    ["amount-uint160-max", (1n << 160n) - 1n],
    ["amount-uint256-max", (1n << 256n) - 1n],
    ["amount-uint256-max-minus-one", (1n << 256n) - 2n],
  ]);
  for (const [id, value] of boundaries) {
    const entry = fixture.cases.find((entry) => entry.id === id);
    assert.ok(entry, id);
    assert.equal(BigInt(entry.expected.body.amount), value, id);
  }
  for (const { id, input, expected } of fixture.cases.filter(({ expected }) => expected.body)) {
    assert.match(input.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(input.calldata.slice(0, 10), selector, id);
    assert.equal(input.calldata.slice(10, 34), "0".repeat(24), id);
    assert.equal(`0x${input.calldata.slice(34, 74).toLowerCase()}`, expected.body.spender, id);
    assert.equal(BigInt(`0x${input.calldata.slice(74, 138)}`), BigInt(expected.body.amount), id);
    const trailer = input.calldata.slice(138);
    assert.equal(trailer, id === "trailing-one-byte" ? "ab" : id === "trailing-full-word" ? "deadbeef".repeat(8) : "", id);
  }
});

function assertFailure(actual, kind) {
  assert.equal(actual.ok, false, JSON.stringify(actual));
  assert.equal(actual.data, null);
  assert.equal(actual.error.kind, kind);
  assert.equal(typeof actual.error.message, "string");
  assert.ok(actual.error.message.length > 0);
}

for (const { id, input, expected } of fixture.cases) {
  test(id, () => {
    const actual = installed.results.find((entry) => entry.id === id).result;
    if (expected.error_kind) {
      assertFailure(actual, expected.error_kind);
      return;
    }
    assert.equal(actual.ok, true, JSON.stringify(actual));
    assert.equal(actual.error, null);
    assert.equal(actual.data.decoder_id, expected.decoder_id);
    assert.equal(actual.data.actions.length, 1);
    assert.equal(actual.data.reenter_callback, undefined);
    const action = actual.data.actions[0];
    assert.deepEqual(action.body, expected.body);
    assert.equal(typeof action.body.amount, "string");
    const request = { ...fixture.defaults, ...input };
    const chain = expected.body.token.key.chain;
    assert.deepEqual(action.meta, {
      submitted_at: 1700000000,
      submitter: request.submitter.toLowerCase(),
      nature: {
        kind: "onchain_tx", chain, nonce: 1,
        gas_limit: "0x30d40", value: "0x0",
        gas_price: {
          value: "0x4a817c800",
          source: { kind: "oracle_feed", provider: "pyth", feed_id: `gas/${chain}` },
          synced_at: 1700000000,
        },
      },
    });
  });
}
