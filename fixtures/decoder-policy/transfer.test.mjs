import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readJson, repoRoot, resolveIndexBundle } from "./helpers/build-registry.mjs";
import { buildHandoffRegistry } from "./helpers/handoff.mjs";

const execFileAsync = promisify(execFile);
const selection = await readJson(new URL("./registry-selection.json", import.meta.url));
const fixture = await readJson(new URL("./transfer.cases.json", import.meta.url));
const approveFixture = await readJson(new URL("./approve.cases.json", import.meta.url));
const transferId = "standard/erc20/transfer@1.0.0";
const approveId = "standard/erc20/approve@1.0.0";
const selector = "0xa9059cbb";
const approveSelector = "0x095ea7b3";
let registry;
let entries;
let bundles;
let installed;
let approveOnly;
let alternating;

function caseById(source, id) {
  const entry = source.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing case: ${id}`);
  return entry;
}

function requestCase(source, id, requestId = id) {
  const entry = caseById(source, id);
  return { ...entry, id: requestId, input: { ...source.defaults, ...entry.input } };
}

async function runScenario(name, selectedBundles, cases) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ handoff: { suite: "transfer", scenario: name },
    bundles: selectedBundles,
    requests: cases.map(({ id, input }) => ({ id, input })),
  }));
  try {
    // Each invocation starts a new process; no global Registry reset is assumed.
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const output = JSON.parse(stdout);
    assert.deepEqual(output.results.map(({ id }) => id), cases.map(({ id }) => id));
    return output;
  } catch (error) {
    throw new Error(`WASM scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  // Prerequisites fail explicitly; the test never builds WASM or skips cases.
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; build the legacy WASM first (see README.md).`);
    });
  }
  assert.equal(fixture.registry_source, selection.transfer_manifest.path);
  assert.equal(approveFixture.registry_source, selection.manifest.path);
  assert.equal(fixture.cases.length, 18, "Required DEC-03 case count changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  registry = await buildHandoffRegistry(selection, "transfer");
  const specs = [
    { id: approveId, selector: approveSelector, path: selection.manifest.path, source: registry.source },
    { id: transferId, selector, path: selection.transfer_manifest.path, source: registry.transferSource },
  ];
  const expectedFiles = specs.flatMap(({ selector }) => selection.tokens.map(
    ({ chain_id, address }) => `${chain_id}__${address}__${selector}.json`,
  )).sort();
  const callkeyDir = join(registry.root, "index/by-callkey");
  assert.deepEqual((await readdir(callkeyDir)).sort(), expectedFiles);
  assert.deepEqual(await readdir(join(registry.root, "index/by-typed-data")), []);
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);
  entries = [];
  bundles = new Map();
  for (const spec of specs) {
    for (const { chain_id, address } of selection.tokens) {
      const entry = await readJson(join(callkeyDir, `${chain_id}__${address}__${spec.selector}.json`));
      assert.equal(entry.schema_version, "3-ref");
      assert.equal(entry.bundle_id, spec.id);
      assert.equal(entry.manifest_path, spec.path);
      // Hash the complete resolved object with JCS before installing either bundle.
      const resolved = await resolveIndexBundle(registry.root, entry);
      if (bundles.has(spec.id)) {
        assert.deepEqual(resolved, bundles.get(spec.id), "Each selector's four callkeys share one bundle");
      }
      bundles.set(spec.id, resolved);
      entries.push(entry);
    }
    const bundle = bundles.get(spec.id);
    assert.equal(bundle.schema_version, "3");
    assert.deepEqual(bundle.match, {
      selector: spec.selector,
      chain_to_addresses: Object.fromEntries(selection.tokens.map(
        ({ chain_id, address }) => [String(chain_id), [address]],
      )),
    });
    const { match: sourceMatch, ...sourceFields } = spec.source;
    const { match: resolvedMatch, ...resolvedFields } = bundle;
    assert.equal(sourceMatch.chain_to_addresses_source, "tokens:erc20");
    assert.deepEqual(sourceMatch.chain_ids, [1, 10, 8453, 42161]);
    assert.equal(resolvedMatch.chain_to_addresses_source, undefined);
    assert.deepEqual(resolvedFields, sourceFields, "Only match expansion may change the source");
  }
  alternating = [
    requestCase(fixture, "chain-1-normal", "alternate-transfer-normal-before"),
    requestCase(approveFixture, "amount-normal", "alternate-approve-normal"),
    requestCase(fixture, "chain-8453-uint256-max", "alternate-transfer-max"),
    requestCase(approveFixture, "amount-uint256-max", "alternate-approve-max"),
    requestCase(fixture, "chain-1-normal", "alternate-transfer-normal-after"),
  ];
  const cases = fixture.cases.map(({ id }) => requestCase(fixture, id));
  // All alternating requests share the SAME worker, after both installations.
  // A second process deliberately installs approve only to check transfer miss.
  const scenarios = await Promise.allSettled([
    runScenario("approve-and-transfer", [bundles.get(approveId), bundles.get(transferId)], [...alternating, ...cases]),
    runScenario("approve-only", [bundles.get(approveId)], [
      requestCase(approveFixture, "amount-normal"), requestCase(fixture, "chain-1-normal"),
    ]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map(({ reason }) => reason), "WASM installation scenarios failed");
  }
  [installed, approveOnly] = scenarios.map(({ value }) => value);
}, { timeout: 200_000 });

after(async () => {
  await registry?.cleanup();
});

test("two actual sources produce eight callkeys with distinct verified bundle IDs and JCS digests", () => {
  assert.equal(entries.length, 8);
  assert.deepEqual([...bundles.keys()], [approveId, transferId]);
  for (const id of [approveId, transferId]) {
    const ownEntries = entries.filter((entry) => entry.bundle_id === id);
    assert.equal(ownEntries.length, 4);
    assert.equal(new Set(ownEntries.map((entry) => entry.bundle_sha256)).size, 1);
  }
  assert.equal(new Set(entries.map((entry) => entry.bundle_sha256)).size, 2);
});

test("fixed transfer calldata independently preserves selectors, recipient words and U256 amounts", () => {
  const amounts = new Map([
    ["chain-1-normal", 1_000_000n],
    ["chain-10-zero", 0n],
    ["chain-8453-uint256-max", (1n << 256n) - 1n],
    ["chain-42161-mixed-case", 1_000_000n],
    ["zero-recipient", 1_000_000n],
    ["trailing-one-byte", 1_000_000n],
    ["trailing-full-word", 1_000_000n],
  ]);
  assert.equal(fixture.cases.filter(({ expected }) => expected.body).length, amounts.size);
  for (const [id, amount] of amounts) {
    const { input, expected } = requestCase(fixture, id);
    assert.match(input.calldata, /^0x[0-9a-fA-F]+$/);
    assert.equal(input.selector, selector, id);
    assert.equal(input.calldata.slice(0, 10), selector, id);
    const recipient = id === "zero-recipient"
      ? "0x0000000000000000000000000000000000000000"
      : "0x111122223333444455556666777788889999abcd";
    assert.equal(input.calldata.slice(10, 74).toLowerCase(), recipient.slice(2).padStart(64, "0"), id);
    assert.equal(input.calldata.slice(74, 138), amount.toString(16).padStart(64, "0"), id);
    assert.equal(BigInt(`0x${input.calldata.slice(74, 138)}`).toString(10), amount.toString(10), id);
    assert.equal(typeof expected.body.amount, "string");
    assert.equal(expected.body.amount, `0x${amount.toString(16)}`, id);
    assert.equal(BigInt(expected.body.amount), amount, id);
    assert.equal(expected.body.recipient, recipient, id);
    const token = selection.tokens.find(({ chain_id }) => chain_id === input.chain_id);
    assert.ok(token, id);
    assert.equal(input.to.toLowerCase(), token.address, id);
    assert.deepEqual(expected.body.token.key, {
      standard: "erc20", chain: `eip155:${input.chain_id}`, address: token.address,
    });
    assert.equal(new Set([input.to.toLowerCase(), recipient, input.submitter.toLowerCase()]).size, 3, id);
    assert.equal(expected.body.spender, undefined, id);
    const trailer = input.calldata.slice(138);
    assert.equal(trailer, id === "trailing-one-byte" ? "ab" : id === "trailing-full-word" ? "deadbeef".repeat(8) : "", id);
  }
  const mixed = requestCase(fixture, "chain-42161-mixed-case").input;
  for (const address of [mixed.to, mixed.submitter, mixed.calldata.slice(34, 74)]) {
    assert.match(address, /[a-f]/);
    assert.match(address, /[A-F]/);
  }
  // These are complete hex bytes, but too short for the selected transfer ABI.
  const normal = caseById(fixture, "chain-1-normal").input.calldata;
  for (const [id, byteLength] of [["selector-only", 4], ["partial-recipient-word", 35], ["partial-amount-word", 67]]) {
    assert.equal(caseById(fixture, id).input.calldata, normal.slice(0, 2 + byteLength * 2), id);
  }
  assert.equal(Object.hasOwn(requestCase(fixture, "missing-selector").input, "selector"), false);
  assert.equal(typeof requestCase(fixture, "invalid-calldata-type").input.calldata, "number");
  for (const [id, lookup, calldataSelector] of [
    ["transfer-lookup-approve-calldata", selector, approveSelector],
    ["approve-lookup-transfer-calldata", approveSelector, selector],
    ["unregistered-selector-with-transfer-calldata", "0xdeadbeef", selector],
  ]) {
    const { input } = caseById(fixture, id);
    assert.equal(input.selector, lookup, id);
    assert.match(input.selector, /^0x[0-9a-f]{8}$/);
    assert.equal(input.calldata, calldataSelector + normal.slice(10), id);
  }
});

test("co-installed approve and transfer alternate without Action leakage; approve-only state is isolated", () => {
  assert.deepEqual(installed.installations.map(({ data }) => data), [
    { decoder_id: approveId, bundle_id: approveId },
    { decoder_id: transferId, bundle_id: transferId },
  ]);
  for (const entry of alternating) {
    assertSuccess(resultById(installed, entry.id), entry.expected, entry.input);
  }
  assert.deepEqual(approveOnly.installations.map(({ data }) => data), [
    { decoder_id: approveId, bundle_id: approveId },
  ]);
  const approve = requestCase(approveFixture, "amount-normal");
  assertSuccess(resultById(approveOnly, approve.id), approve.expected, approve.input);
  assertFailure(resultById(approveOnly, "chain-1-normal"), "no_declarative_v3_mapper");
  assertSuccess(resultById(installed, "chain-1-normal"),
    caseById(fixture, "chain-1-normal").expected, requestCase(fixture, "chain-1-normal").input);
});

function resultById(scenario, id) {
  const entry = scenario.results.find((entry) => entry.id === id);
  assert.ok(entry, id);
  return entry.result;
}

function assertFailure(actual, kind) {
  assert.equal(actual.ok, false, JSON.stringify(actual));
  assert.equal(actual.data, null);
  assert.equal(actual.error.kind, kind);
  assert.equal(typeof actual.error.message, "string");
  assert.ok(actual.error.message.length > 0);
}

function assertSuccess(actual, expected, request) {
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  assert.equal(actual.data.decoder_id, expected.decoder_id);
  assert.equal(actual.data.actions.length, 1);
  assert.equal(actual.data.reenter_callback, undefined);
  const action = actual.data.actions[0];
  assert.deepEqual(action.body, expected.body);
  assert.equal(typeof action.body.amount, "string");
  if (expected.decoder_id === transferId) {
    assert.equal(Object.hasOwn(action.body, "spender"), false);
    assert.equal(Object.hasOwn(action.body, "is_router_egress"), false);
  } else {
    assert.equal(Object.hasOwn(action.body, "recipient"), false);
  }
  const chain = expected.body.token.key.chain;
  assert.deepEqual(action.meta, {
    submitted_at: 1700000000,
    submitter: request.submitter.toLowerCase(),
    nature: {
      kind: "onchain_tx", chain, nonce: 1,
      gas_limit: "0x30d40", value: "0x0",
      gas_price: {
        value: "0x4a817c800",
        // Existing Rust Pyth stub: this metadata is not an external price query.
        source: { kind: "oracle_feed", provider: "pyth", feed_id: `gas/${chain}` },
        synced_at: 1700000000,
      },
    },
  });
}

for (const { id, expected } of fixture.cases) {
  test(id, () => {
    const actual = resultById(installed, id);
    if (expected.error_kind) {
      assertFailure(actual, expected.error_kind);
    } else {
      assertSuccess(actual, expected, requestCase(fixture, id).input);
    }
  });
}
