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
const fixture = await readJson(new URL("./permit2-single.cases.json", import.meta.url));
const flatFixture = await readJson(new URL("./typed-permit.cases.json", import.meta.url));
const singleId = "uniswap/permit2/permitSingle@1.0.0";
const approveId = "standard/erc20/approve@1.0.0";
const flatId = "standard/erc20/permit@1.0.0";
const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const chains = [1, 10, 8453, 42161];
const groupCounts = {
  normal: 19, routing_miss: 6, input_error: 12, emit_error: 26, legacy_diagnostic: 14, compatibility: 2,
};
let registry;
let approveBundle;
let flatBundle;
let singleBundle;
let installed;
let empty;
let withoutSingle;
const singleEntries = [];
const approveEntries = [];

function caseById(id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing case: ${id}`);
  return entry;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
}

function requestCase(id) {
  const entry = caseById(id);
  let input = structuredClone(fixture.defaults);
  for (const [path, value] of Object.entries(entry.set ?? {})) {
    const parts = path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((value, part) => value[part], input);
    parent[key] = structuredClone(value);
  }
  for (const path of entry.omit ?? []) {
    const parts = path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((value, part) => value[part], input);
    assert.ok(Object.hasOwn(parent, key), `Omission must remove an existing field: ${id}: ${path}`);
    delete parent[key];
  }
  if (entry.reverse_object_keys) input = reverseObjectKeys(input);
  assert.equal(Object.hasOwn(input, "calldata"), false);
  assert.equal(Object.hasOwn(input, "owner"), false);
  if (input.message && typeof input.message === "object") {
    assert.equal(Object.hasOwn(input.message, "owner"), false);
  }
  // Fixture patches arrange inputs only. The actual WASM performs all tuple
  // conversion and emit work; the existing typed worker is reused unchanged.
  return { id, kind: "typed", input };
}

async function runScenario(name, bundles, requests) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ handoff: { suite: "permit2-single", scenario: name }, bundles, requests }));
  try {
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
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; prepare the paired JS/WASM (see README.md).`);
    });
  }
  assert.equal(fixture.registry_source, selection.permit2_single_manifest.path);
  assert.equal(fixture.cases.length, 79, "Required DEC-05a request definitions changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  registry = await buildHandoffRegistry(selection, "permit2-single");
  assert.deepEqual(Object.keys(registry).sort(), [
    "root", "source", "tokens", "cleanup", "permitSource", "permit2SingleSource",
  ].sort());

  const approveFiles = selection.tokens.map(
    ({ chain_id, address }) => `${chain_id}__${address}__0x095ea7b3.json`,
  );
  const singleCallFiles = chains.map((chain) => `${chain}__${permit2}__0x2b67b570.json`);
  const singleTypedFiles = chains.map((chain) => `${chain}__${permit2}__PermitSingle.json`);
  const flatCallFile = `1__${usdc}__0xd505accf.json`;
  const flatTypedFile = `1__${usdc}__Permit.json`;
  const callkeyDir = join(registry.root, "index/by-callkey");
  const typedDir = join(registry.root, "index/by-typed-data");
  assert.deepEqual((await readdir(callkeyDir)).sort(), [...approveFiles, ...singleCallFiles, flatCallFile].sort());
  assert.deepEqual((await readdir(typedDir)).sort(), [...singleTypedFiles, flatTypedFile].sort());
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);

  for (const name of approveFiles) {
    const entry = await readJson(join(callkeyDir, name));
    assert.equal(entry.schema_version, "3-ref");
    assert.equal(entry.bundle_id, approveId);
    assert.equal(entry.manifest_path, selection.manifest.path);
    const bundle = await resolveIndexBundle(registry.root, entry);
    if (approveBundle) assert.deepEqual(bundle, approveBundle);
    approveBundle = bundle;
    approveEntries.push(entry);
  }
  // Every selected callkey AND typed reference is resolved and JCS-checked
  // before any installation. Source bytes are copied by the common builder.
  for (const [index, chain] of chains.entries()) {
    const typed = await readJson(join(typedDir, singleTypedFiles[index]));
    const callkey = await readJson(join(callkeyDir, singleCallFiles[index]));
    for (const entry of [typed, callkey]) {
      assert.equal(entry.schema_version, undefined, "Concrete Permit2 indexes are inline");
      assert.equal(entry.bundle_ref, undefined);
      assert.equal(entry.bundle_id, singleId);
      assert.equal(entry.manifest_path, selection.permit2_single_manifest.path);
    }
    const bundle = await resolveIndexBundle(registry.root, typed);
    assert.deepEqual(await resolveIndexBundle(registry.root, callkey), bundle);
    assert.deepEqual(callkey, typed);
    if (singleBundle) assert.deepEqual(bundle, singleBundle);
    singleBundle = bundle;
    singleEntries.push({ chain, typed, callkey });
  }
  const flatTyped = await readJson(join(typedDir, flatTypedFile));
  const flatCall = await readJson(join(callkeyDir, flatCallFile));
  for (const entry of [flatTyped, flatCall]) {
    assert.equal(entry.schema_version, undefined);
    assert.equal(entry.bundle_id, flatId);
    assert.equal(entry.manifest_path, selection.permit_manifest.path);
  }
  flatBundle = await resolveIndexBundle(registry.root, flatTyped);
  assert.deepEqual(await resolveIndexBundle(registry.root, flatCall), flatBundle);
  assert.deepEqual(flatTyped, flatCall);
  assert.deepEqual(flatBundle, registry.permitSource);
  assert.deepEqual(singleBundle, registry.permit2SingleSource);
  assert.deepEqual(singleBundle.match.chain_to_addresses, Object.fromEntries(chains.map((chain) => [chain, [permit2]])));
  assert.equal(singleBundle.match.chain_to_addresses_source, undefined);

  const normal = requestCase("named-normal");
  const strictGuard = {
    id: "strict-permit2-remains-unsupported", kind: "typed_strict",
    input: {
      requested_signer: fixture.defaults.submitter,
      submitter: fixture.defaults.submitter,
      submitted_at: fixture.defaults.submitted_at,
      typed_data: {
        domain: { name: "Permit2", chainId: "1", verifyingContract: permit2 },
        types: singleBundle.match.typed_data.types,
        primaryType: "PermitSingle",
        message: fixture.defaults.message,
      },
    },
  };
  const scenarios = await Promise.allSettled([
    runScenario("single-installed", [approveBundle, flatBundle, singleBundle], [
      ...fixture.cases.map(({ id }) => requestCase(id)),
      { id: "flat-permit-regression", kind: "typed", input: structuredClone(flatFixture.defaults) },
      strictGuard,
    ]),
    runScenario("single-empty", [], [normal]),
    runScenario("single-not-installed", [approveBundle, flatBundle], [normal]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "WASM installation scenarios failed");
  [installed, empty, withoutSingle] = scenarios.map(({ value }) => value);
}, { timeout: 200_000 });

after(async () => { await registry?.cleanup(); });

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

// Only validated JS-safe projections become Number. All large input/expected
// quantities remain decimal strings, hex strings or BigInt throughout checks.
function safeTime(decimal) {
  const integer = BigInt(decimal);
  assert.ok(integer >= 0n && integer <= (1n << 53n) - 1n);
  return Number(integer);
}

function assertSingle(actual, entry) {
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  assert.equal(actual.data.decoder_id, singleId);
  assert.deepEqual(Object.keys(actual.data).sort(), ["actions", "decoder_id"]);
  assert.equal(actual.data.actions.length, 1);
  const action = actual.data.actions[0];
  const expected = entry.expected;
  const wanted = structuredClone(fixture.expected_action);
  if (expected.amount !== undefined) wanted.body.amount = expected.amount;
  if (expected.expires_at !== undefined) wanted.body.expires_at = safeTime(expected.expires_at);
  if (expected.nonce !== undefined) wanted.body.nonce.value = expected.nonce;
  if (expected.sig_deadline !== undefined) {
    wanted.body.sig_deadline = safeTime(expected.sig_deadline);
    wanted.meta.nature.deadline = safeTime(expected.sig_deadline);
  }
  if (expected.meta_deadline !== undefined) wanted.meta.nature.deadline = safeTime(expected.meta_deadline);
  if (expected.domain_name !== undefined) wanted.meta.nature.domain.name = expected.domain_name;
  if (expected.chain_id !== undefined) {
    wanted.body.token.key.chain = `eip155:${expected.chain_id}`;
    wanted.body.nonce.source.chain = `eip155:${expected.chain_id}`;
    wanted.meta.nature.domain.chain_id = expected.chain_id;
  }
  if (expected.submitted_at !== undefined) {
    wanted.meta.submitted_at = safeTime(expected.submitted_at);
    wanted.body.nonce.synced_at = safeTime(expected.submitted_at);
  }
  if (expected.time_diagnostic) {
    // The existing worker has already JSON.parse'd raw WASM output. Do not
    // manufacture a rounded numeric oracle or claim raw u64 saturation here.
    const { sig_deadline: bodyTime, ...body } = action.body;
    const { deadline: metaTime, ...nature } = action.meta.nature;
    const { sig_deadline: ignoredBodyTime, ...wantedBody } = wanted.body;
    const { deadline: ignoredMetaTime, ...wantedNature } = wanted.meta.nature;
    assert.deepEqual(body, wantedBody);
    assert.deepEqual({ ...action.meta, nature }, { ...wanted.meta, nature: wantedNature });
    assert.equal(typeof bodyTime, "number");
    assert.ok(Number.isInteger(bodyTime));
    assert.equal(Number.isSafeInteger(bodyTime), false);
    if (expected.time_diagnostic === "unsafe-js-roundtrip") {
      assert.equal(bodyTime, metaTime);
      const original = requestCase(entry.id).input.message.sigDeadline;
      assert.equal(typeof original, "string");
      assert.notEqual(BigInt(bodyTime), BigInt(original), "The decimal input was exact; output lost precision");
    } else {
      assert.equal(expected.time_diagnostic, "u64-saturation-meta-zero");
      assert.equal(metaTime, 0);
      assert.notEqual(bodyTime, metaTime);
    }
  } else {
    assert.deepEqual(action, wanted);
  }
  assert.equal(typeof action.body.amount, "string");
  assert.equal(typeof action.body.nonce.value[0], "string");
  assert.equal(typeof action.body.nonce.value[1], "number");
  assert.equal(Object.hasOwn(action.body.nonce, "confidence"), false);
  assert.equal(Object.hasOwn(action.body, "owner"), false);
  assert.equal(Object.hasOwn(action.meta.nature, "nonce_key"), false);
  if (entry.group === "normal") {
    const { input } = requestCase(entry.id);
    const signed = BigInt(input.message.details.nonce);
    const [word, bit] = action.body.nonce.value;
    assert.equal(BigInt(word) * 256n + BigInt(bit), signed, "Signed nonce must survive current tuple representation");
    assert.equal(action.body.sig_deadline, action.meta.nature.deadline);
    assert.equal(BigInt(action.body.sig_deadline), BigInt(input.message.sigDeadline));
    assert.equal(BigInt(action.body.expires_at), BigInt(input.message.details.expiration));
  }
}

test("actual approve + USDC Permit + Single: exact 9 callkeys / 5 typed / 0 selector, four-chain refs and JCS", async (t) => {
  assert.equal(approveEntries.length, 4);
  assert.equal(new Set(approveEntries.map((entry) => entry.bundle_sha256)).size, 1);
  assert.deepEqual(singleEntries.map(({ chain }) => chain), chains);
  assert.equal(new Set(singleEntries.map(({ typed }) => typed.bundle_sha256)).size, 1);
  const { typed } = singleEntries[0];
  assert.notEqual(typed.bundle_sha256, selection.permit2_single_manifest.sha256);
  await assert.rejects(resolveIndexBundle(registry.root, {
    ...typed, bundle_sha256: `0x${"0".repeat(64)}`,
  }), /Resolved bundle JCS digest mismatch/);
  t.diagnostic(JSON.stringify({
    source: selection.permit2_single_manifest,
    resolved_jcs_sha256: typed.bundle_sha256,
    chains, callkeys: 9, typed_indexes: 5, selector_indexes: 0,
  }));
});

test("actual source ABI components and positional emit map all Single fields, including signed nonce", () => {
  const inputs = singleBundle.abi_fragment.abi.inputs;
  assert.deepEqual(inputs.map(({ name }) => name), ["owner", "permitSingle", "signature"]);
  assert.equal(inputs[1].type, "tuple");
  const components = inputs[1].components;
  assert.deepEqual(components.map(({ name, type }) => [name, type]), [
    ["details", "tuple"], ["spender", "address"], ["sigDeadline", "uint256"],
  ]);
  assert.deepEqual(components[0].components, [
    { name: "token", type: "address" }, { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" },
  ]);
  assert.deepEqual(singleBundle.emit.body.token.permit2_sign_allowance, {
    token: { key: { standard: "erc20", chain: "$chain", address: "$args.permitSingle[0][0]" } },
    spender: "$args.permitSingle[1]", amount: "$args.permitSingle[0][1]",
    expires_at: "$args.permitSingle[0][2]", sig_deadline: "$args.permitSingle[2]", nonce: "$args.permitSingle[0][3]",
  });
  assert.deepEqual(Object.keys(fixture.defaults.message), ["details", "spender", "sigDeadline"]);
  assert.equal(singleBundle.match.typed_data.types.PermitSingle.some(({ name }) => name === "owner"), false);
  assert.deepEqual(singleBundle.emit.live_inputs.nonce, {
    source: { kind: "onchain_view", chain: "$chain", contract: permit2,
      function: "nonceBitmap(address,uint256)", decoder_id: "permit2_nonce_bitmap" }, ttl_s: 12,
  });
});

test("fixed decimal/hex boundaries and nonce coordinates are independently checked with BigInt", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(groupCounts).map((group) => [
    group, fixture.cases.filter((entry) => entry.group === group).length,
  ])), groupCounts);
  for (const [field, bits, output] of [["amount", 160n, "amount"], ["expiration", 48n, "expires_at"], ["nonce", 48n, "nonce"]]) {
    for (const [suffix, integer] of [["zero", 0n], ["max", (1n << bits) - 1n], ["declared-width-overflow", 1n << bits]]) {
      const entry = caseById(`${field}-${suffix}`);
      const value = requestCase(entry.id).input.message.details[field];
      assert.equal(typeof value, "string");
      assert.equal(value, integer.toString(10));
      if (field === "nonce") {
        const [word, bit] = entry.expected.nonce;
        assert.equal(BigInt(word), integer / 256n);
        assert.equal(BigInt(bit), integer % 256n);
      } else {
        assert.equal(BigInt(entry.expected[output]), integer);
      }
      assert.equal(entry.group, suffix === "declared-width-overflow" ? "legacy_diagnostic" : "normal");
    }
  }
  for (const [id, integer] of [["nonce-255", 255n], ["nonce-256", 256n], ["named-normal", 513n]]) {
    assert.equal(requestCase(id).input.message.details.nonce, integer.toString(10));
    const [word, bit] = caseById(id).expected.nonce ?? fixture.expected_action.body.nonce.value;
    assert.equal(BigInt(word) * 256n + BigInt(bit), integer);
  }
  assert.equal(BigInt(fixture.defaults.message.details.amount), 1_000_000n);
  assert.equal(BigInt(fixture.expected_action.body.amount), 1_000_000n);
  for (const [id, value] of [
    ["sig-deadline-js-safe-max", (1n << 53n) - 1n],
    ["sig-deadline-js-precision", (1n << 53n) + 1n],
    ["sig-deadline-u64-overflow", 1n << 64n],
  ]) assert.equal(requestCase(id).input.message.sigDeadline, value.toString(10));
  assert.equal(BigInt(requestCase("amount-uint256-overflow").input.message.details.amount), 1n << 256n);
  assert.equal(BigInt(requestCase("uint256-overflow-nonce-fallback").input.message.details.nonce), 1n << 256n);
  const { input } = requestCase("named-normal");
  assert.equal(new Set([input.verifying_contract, input.message.details.token, input.message.spender, input.submitter]).size, 4);
  for (const entry of fixture.cases) {
    assert.ok(Object.hasOwn(groupCounts, entry.group), entry.id);
    if (entry.group === "legacy_diagnostic") assert.ok(entry.unresolved_issue?.length > 0, entry.id);
    else assert.equal(entry.unresolved_issue, undefined, entry.id);
    if (entry.group === "compatibility") assert.ok(entry.compatibility_note?.length > 0, entry.id);
  }
});

test("named key order is irrelevant; positional compatibility is distinguished from EIP-712 objects", () => {
  const normal = requestCase("named-normal").input;
  const reordered = requestCase("object-key-order").input;
  assert.notDeepEqual(Object.keys(normal.message), Object.keys(reordered.message));
  assert.notDeepEqual(Object.keys(normal.message.details), Object.keys(reordered.message.details));
  assert.deepEqual(resultById(installed, "object-key-order"), resultById(installed, "named-normal"));
  assert.deepEqual(resultById(installed, "positional-details"), resultById(installed, "named-normal"));
  const positional = resultById(installed, "positional-message").data.actions[0];
  assert.deepEqual(positional.body, resultById(installed, "named-normal").data.actions[0].body);
  assert.equal(positional.meta.nature.deadline, 0, "Internal array root loses the named meta deadline lookup");
});

test("installation states stay in separate WASM processes and existing EIP-2612 flat conversion remains exact", () => {
  assert.deepEqual(installed.installations.map(({ data }) => data), [approveId, flatId, singleId].map((id) => ({ decoder_id: id, bundle_id: id })));
  assert.deepEqual(empty.installations, []);
  assert.deepEqual(withoutSingle.installations.map(({ data }) => data), [approveId, flatId].map((id) => ({ decoder_id: id, bundle_id: id })));
  assertFailure(resultById(empty, "named-normal"), "no_typed_data_mapper");
  assertFailure(resultById(withoutSingle, "named-normal"), "no_typed_data_mapper");
  const flat = resultById(installed, "flat-permit-regression");
  assert.equal(flat.ok, true, JSON.stringify(flat));
  assert.equal(flat.error, null);
  const { decoder_id, ...expectedAction } = flatFixture.expected_permit;
  assert.equal(decoder_id, flatId);
  assert.deepEqual(flat.data, { decoder_id: flatId, actions: [expectedAction] });
});

test("installed Single remains explicitly unsupported by v4 and is never retried via v3", () => {
  assertFailure(resultById(installed, "strict-permit2-remains-unsupported"), "unsupported_typed_data_contract");
  assertSingle(resultById(installed, "named-normal"), caseById("named-normal"));
});

for (const entry of fixture.cases) {
  const label = entry.group === "legacy_diagnostic"
    ? "unresolved legacy diagnostic (not a Permit2 validity claim)"
    : entry.group === "compatibility" ? "internal array compatibility (not EIP-712 object)" : entry.group;
  test(`${label}: ${entry.id}`, (t) => {
    const actual = resultById(installed, entry.id);
    if (entry.expected.error_kind) assertFailure(actual, entry.expected.error_kind);
    else assertSingle(actual, entry);
    if (entry.unresolved_issue || entry.compatibility_note) {
      const message = requestCase(entry.id).input.message;
      t.diagnostic(JSON.stringify({
        issue: entry.unresolved_issue ?? entry.compatibility_note,
        message_input: message,
        signed_nonce_present: message?.details != null && Object.hasOwn(message.details, "nonce"),
        current_nonce_live_field: actual.data?.actions[0]?.body.nonce,
        sig_deadline_input: message?.sigDeadline ?? "positional; see fixture",
        current_body_time: actual.data?.actions[0]?.body.sig_deadline,
        current_meta_time: actual.data?.actions[0]?.meta.nature.deadline,
      }));
    }
  });
}
