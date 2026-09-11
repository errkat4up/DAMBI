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
const fixture = await readJson(new URL("./typed-permit.cases.json", import.meta.url));
const permitId = "standard/erc20/permit@1.0.0";
const approveId = "standard/erc20/approve@1.0.0";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const permitSelector = "0xd505accf";
const approveSelector = "0x095ea7b3";
const groupCounts = { normal: 5, routing_miss: 4, input_error: 17, emit_error: 11, legacy_observation: 7 };
let registry;
let approveBundle;
let permitBundle;
let approveEntries;
let permitCallkeyEntry;
let typedEntry;
let installed;
let empty;
let approveOnly;

function caseById(id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing case: ${id}`);
  return entry;
}

function requestCase(id) {
  const entry = caseById(id);
  const input = structuredClone({ ...fixture.defaults, ...entry.input });
  if (entry.message_patch !== undefined) {
    assert.ok(input.message && typeof input.message === "object" && !Array.isArray(input.message), id);
    Object.assign(input.message, entry.message_patch);
  }
  for (const path of entry.omit ?? []) {
    const parts = path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((value, part) => value[part], input);
    assert.ok(Object.hasOwn(parent, key), `Omission must remove an existing field: ${id}: ${path}`);
    delete parent[key];
  }
  // The flat Permit message is sent to the typed WASM export, never encoded
  // as permit() calldata and never passed through a JS/Chrome decoder.
  assert.equal(Object.hasOwn(input, "calldata"), false, id);
  return { id, kind: "typed", input };
}

async function runScenario(name, bundles, requests) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ bundles, requests }));
  try {
    // A separate process owns each installation state; there is no reset API.
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const output = JSON.parse(stdout);
    assert.deepEqual(output.results.map(({ id }) => id), requests.map(({ id }) => id));
    return output;
  } catch (error) {
    throw new Error(`WASM scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  // Missing prerequisites fail. This test builds the Registry, never WASM.
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; prepare the paired legacy JS/WASM first (see README.md).`);
    });
  }
  assert.equal(fixture.registry_source, selection.permit_manifest.path);
  assert.equal(fixture.cases.length, 44, "Required DEC-04a request case count changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  assert.equal(fixture.expected_permit.decoder_id, permitId);

  // Explicit selection: approve (four token-expanded chains) + concrete
  // mainnet USDC permit. Transfer is not selected, and permit is not expanded.
  registry = await buildRegistry(selection, { includePermit: true });
  assert.equal(Object.hasOwn(registry, "transferSource"), false);
  const approveFiles = selection.tokens.map(
    ({ chain_id, address }) => `${chain_id}__${address}__${approveSelector}.json`,
  ).sort();
  const permitCallkeyFile = `1__${usdc}__${permitSelector}.json`;
  const typedFile = `1__${usdc}__Permit.json`;
  const callkeyDir = join(registry.root, "index/by-callkey");
  const typedDir = join(registry.root, "index/by-typed-data");
  assert.deepEqual((await readdir(callkeyDir)).sort(), [...approveFiles, permitCallkeyFile].sort());
  assert.deepEqual(await readdir(typedDir), [typedFile]);
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);

  approveEntries = [];
  for (const name of approveFiles) {
    const entry = await readJson(join(callkeyDir, name));
    assert.equal(entry.schema_version, "3-ref");
    assert.equal(entry.bundle_id, approveId);
    assert.equal(entry.manifest_path, selection.manifest.path);
    const resolved = await resolveIndexBundle(registry.root, entry);
    if (approveBundle) assert.deepEqual(resolved, approveBundle);
    approveBundle = resolved;
    approveEntries.push(entry);
  }
  assert.deepEqual(approveBundle.match, {
    selector: approveSelector,
    chain_to_addresses: Object.fromEntries(selection.tokens.map(
      ({ chain_id, address }) => [String(chain_id), [address]],
    )),
  });
  const { match: sourceMatch, ...sourceFields } = registry.source;
  const { match: resolvedMatch, ...resolvedFields } = approveBundle;
  assert.equal(sourceMatch.chain_to_addresses_source, "tokens:erc20");
  assert.equal(resolvedMatch.chain_to_addresses_source, undefined);
  assert.deepEqual(resolvedFields, sourceFields);

  // The actual typed index is the installation source. The separate calldata
  // index is checked for builder parity only; it does not exercise typed route.
  typedEntry = await readJson(join(typedDir, typedFile));
  permitCallkeyEntry = await readJson(join(callkeyDir, permitCallkeyFile));
  for (const entry of [typedEntry, permitCallkeyEntry]) {
    assert.equal(entry.schema_version, undefined, "Concrete permit is inline, not forced to 3-ref");
    assert.equal(entry.bundle_ref, undefined);
    assert.equal(entry.bundle_id, permitId);
    assert.equal(entry.manifest_path, selection.permit_manifest.path);
  }
  permitBundle = await resolveIndexBundle(registry.root, typedEntry);
  assert.deepEqual(await resolveIndexBundle(registry.root, permitCallkeyEntry), permitBundle);
  assert.deepEqual(permitCallkeyEntry, typedEntry);
  assert.deepEqual(permitBundle, registry.permitSource, "Concrete source fields remain unchanged");
  assert.deepEqual(permitBundle.match.chain_to_addresses, { "1": [usdc] });
  assert.equal(permitBundle.match.selector, permitSelector);
  assert.deepEqual(permitBundle.match.typed_data, {
    domain_name: "USD Coin",
    verifying_contract: usdc,
    primary_type: "Permit",
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
  });

  // Install only after every generated index has passed JCS verification.
  const normal = requestCase("value-normal");
  const scenarios = await Promise.allSettled([
    runScenario("typed-approve-and-permit", [approveBundle, permitBundle], fixture.cases.map(({ id }) => requestCase(id))),
    runScenario("typed-empty", [], [normal]),
    runScenario("typed-approve-only", [approveBundle], [normal]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map(({ reason }) => reason), "WASM installation scenarios failed");
  }
  [installed, empty, approveOnly] = scenarios.map(({ value }) => value);
}, { timeout: 200_000 });

after(async () => {
  await registry?.cleanup();
});

test("actual approve + USDC permit produce five callkeys and one inline typed index with verified JCS digests", async () => {
  assert.equal(approveEntries.length, 4);
  assert.equal(new Set(approveEntries.map((entry) => entry.bundle_sha256)).size, 1);
  assert.equal(typedEntry.bundle_sha256, permitCallkeyEntry.bundle_sha256);
  assert.notEqual(typedEntry.bundle_sha256, approveEntries[0].bundle_sha256);
  // Source bytes (selection pin) and resolved JCS (index digest) are distinct.
  assert.notEqual(typedEntry.bundle_sha256, selection.permit_manifest.sha256);
  await assert.rejects(resolveIndexBundle(registry.root, {
    ...typedEntry, bundle_sha256: `0x${"0".repeat(64)}`,
  }), /Resolved bundle JCS digest mismatch/);
});

test("fixed quantities, address roles and legacy observations are independently distinguished", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(groupCounts).map(
    (group) => [group, fixture.cases.filter((entry) => entry.group === group).length],
  )), groupCounts);
  const amounts = new Map([
    ["value-normal", 1_000_000n],
    ["value-zero", 0n],
    ["value-uint256-max", (1n << 256n) - 1n],
    ["mixed-case-addresses", 1_000_000n],
    ["deadline-safe-number-and-null-witness", 1_000_000n],
  ]);
  for (const [id, amount] of amounts) {
    const { input, kind } = requestCase(id);
    const { expected, group } = caseById(id);
    assert.equal(group, "normal");
    assert.equal(kind, "typed");
    assert.equal(typeof input.message.value, "string");
    assert.equal(input.message.value, amount.toString(10), id);
    assert.equal(BigInt(input.message.value), amount, id);
    assert.equal(typeof expected.amount, "string");
    assert.equal(expected.amount, `0x${amount.toString(16)}`, id);
    assert.equal(BigInt(expected.amount), amount, id);
    const addresses = [input.verifying_contract, input.message.spender, input.submitter, input.message.owner];
    for (const address of addresses) assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(new Set(addresses.map((address) => address.toLowerCase())).size, 4, id);
    assert.equal(input.verifying_contract.toLowerCase(), fixture.expected_permit.body.token.key.address, id);
    assert.equal(input.message.spender.toLowerCase(), fixture.expected_permit.body.spender, id);
    assert.equal(input.submitter.toLowerCase(), fixture.expected_permit.meta.submitter, id);
    assert.equal(input.message.nonce, "7", "Signed nonce is deliberately different from live default 0");
    assert.equal(BigInt(input.message.deadline), 1_738_002_000n);
    assert.ok(BigInt(input.message.deadline) <= BigInt(Number.MAX_SAFE_INTEGER));
  }
  const mixed = requestCase("mixed-case-addresses").input;
  for (const address of [mixed.verifying_contract, mixed.message.spender, mixed.submitter, mixed.message.owner]) {
    assert.match(address, /[a-f]/);
    assert.match(address, /[A-F]/);
  }
  assert.equal(BigInt(requestCase("value-uint256-overflow").input.message.value), 1n << 256n);
  assert.equal(Object.hasOwn(requestCase("value-normal").input, "witness_type"), false);
  assert.equal(requestCase("deadline-safe-number-and-null-witness").input.witness_type, null);
  assert.ok(Array.isArray(requestCase("message-array").input.message));
  for (const entry of fixture.cases) {
    assert.ok(Object.hasOwn(groupCounts, entry.group), entry.id);
    if (entry.group === "legacy_observation") {
      assert.equal(entry.expected.legacy_success, true, entry.id);
      assert.ok(entry.strict_requirement.length > 0, entry.id);
      assert.equal(entry.expected.error_kind, undefined);
    } else {
      assert.equal(entry.expected.legacy_success, undefined, entry.id);
    }
  }
  // u64 overflow deadline and unsafe JSON-number precision are deliberately
  // static 04b design findings, not asserted as valid success cases here.
});

test("typed permit installation is isolated from empty and approve-only WASM processes", () => {
  assert.deepEqual(installed.installations.map(({ data }) => data), [
    { decoder_id: approveId, bundle_id: approveId },
    { decoder_id: permitId, bundle_id: permitId },
  ]);
  assert.deepEqual(empty.installations, []);
  assert.deepEqual(approveOnly.installations.map(({ data }) => data), [
    { decoder_id: approveId, bundle_id: approveId },
  ]);
  assertFailure(resultById(empty, "value-normal"), "no_typed_data_mapper");
  assertFailure(resultById(approveOnly, "value-normal"), "no_typed_data_mapper");
  assertPermit(resultById(installed, "value-normal"), caseById("value-normal").expected);
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

function assertPermit(actual, expected) {
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  assert.equal(actual.data.decoder_id, permitId);
  assert.deepEqual(Object.keys(actual.data).sort(), ["actions", "decoder_id"]);
  assert.equal(actual.data.actions.length, 1);
  const action = actual.data.actions[0];
  const body = { ...fixture.expected_permit.body, amount: expected.amount };
  const meta = structuredClone(fixture.expected_permit.meta);
  if (Object.hasOwn(expected, "domain_name")) meta.nature.domain.name = expected.domain_name;
  assert.deepEqual(action, { body, meta });
  assert.equal(typeof action.body.amount, "string");
  assert.equal(typeof action.body.nonce.value, "string");
  assert.equal(action.body.nonce.value, "0x0");
  assert.equal(Object.hasOwn(action.body, "owner"), false);
  assert.equal(Object.hasOwn(action.body, "recipient"), false);
  assert.equal(Object.hasOwn(action.body.nonce, "confidence"), false);
  assert.equal(Object.hasOwn(action.meta.nature, "nonce_key"), false);
  assert.equal(Object.hasOwn(action.meta.nature.domain, "version"), false);
  assert.equal(Object.hasOwn(action.meta.nature.domain, "salt"), false);
  // nonce.value/source/ttl/synced_at describe the current unqueried skeleton,
  // not chain nonce validity, owner checks, signature recovery or a verdict.
}

for (const { id, group, expected } of fixture.cases) {
  const title = group === "legacy_observation"
    ? `legacy observation (not strict EIP-712 validity): ${id}`
    : `${group}: ${id}`;
  test(title, () => {
    const actual = resultById(installed, id);
    if (expected.error_kind) {
      assertFailure(actual, expected.error_kind);
    } else {
      assertPermit(actual, expected);
    }
  });
}
