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
const fixture = await readJson(new URL("./permit2-batch.cases.json", import.meta.url));
const singleFixture = await readJson(new URL("./permit2-single.cases.json", import.meta.url));
const approveId = "standard/erc20/approve@1.0.0";
const singleId = "uniswap/permit2/permitSingle@1.0.0";
const batchId = "uniswap/permit2/permitBatch@1.0.0";
const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const chains = [1, 10, 8453, 42161];
const groupCounts = {
  normal: 25, legacy_diagnostic: 22, limit_boundary: 1, limit_error: 3,
  empty_observation: 1, emit_error: 37, input_error: 8, routing_miss: 5,
};
const entries = [];
let registry;
let approveBundle;
let singleBundle;
let batchBundle;
let installed;
let empty;
let singleOnly;
let batchOnly;

function caseById(id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing fixture case: ${id}`);
  return entry;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
}

function setPath(input, path, value) {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value[part], input);
  parent[key] = structuredClone(value);
}

function requestCase(id) {
  const entry = caseById(id);
  let input = structuredClone(fixture.defaults);
  if (entry.detail_order) {
    input.message.details = entry.detail_order.map((index) => {
      assert.ok(Number.isInteger(index) && index >= 0 && index < fixture.defaults.message.details.length);
      return structuredClone(fixture.defaults.message.details[index]);
    });
  }
  for (const [path, value] of Object.entries(entry.set ?? {})) setPath(input, path, value);
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
  if (input.message && typeof input.message === "object") assert.equal(Object.hasOwn(input.message, "owner"), false);
  // This only arranges fixture inputs. ABI tuple conversion and array_emit
  // remain in the actual WASM, reached through the unchanged typed worker.
  return { id, kind: "typed", input };
}

function singleRequest(id, zero = false) {
  const input = structuredClone(singleFixture.defaults);
  if (zero) input.message.details.amount = "0";
  return { id, kind: "typed", input };
}

const alternation = [
  { id: "alternating-0-batch", case: "two-distinct-details" },
  { id: "alternating-1-single", single: true },
  { id: "alternating-2-batch", case: "reversed-details" },
  { id: "alternating-3-single-zero", single: true, zero: true },
  { id: "alternating-4-batch-empty", case: "empty-details" },
  { id: "alternating-5-single", single: true },
  { id: "alternating-6-batch-limit", case: "details-65" },
  { id: "alternating-7-single", single: true },
  { id: "alternating-8-batch", case: "two-distinct-details" },
];

async function runScenario(name, bundles, requests) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ handoff: { suite: "permit2-batch", scenario: name }, bundles, requests }));
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
  assert.equal(fixture.registry_source, selection.permit2_batch_manifest.path);
  assert.equal(fixture.cases.length, 102, "Required DEC-05b request definitions changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  registry = await buildHandoffRegistry(selection, "permit2-batch");
  assert.deepEqual(Object.keys(registry).sort(), [
    "root", "source", "tokens", "cleanup", "permit2SingleSource", "permit2BatchSource",
  ].sort());
  const approveFiles = selection.tokens.map(({ chain_id, address }) => `${chain_id}__${address}__0x095ea7b3.json`);
  const typedSpecs = [
    { id: singleId, type: "PermitSingle", selector: "0x2b67b570", pin: selection.permit2_single_manifest },
    { id: batchId, type: "PermitBatch", selector: "0x2a2d80d1", pin: selection.permit2_batch_manifest },
  ];
  const typedFiles = typedSpecs.flatMap((spec) => chains.map((chain) => `${chain}__${permit2}__${spec.type}.json`));
  const callFiles = typedSpecs.flatMap((spec) => chains.map((chain) => `${chain}__${permit2}__${spec.selector}.json`));
  const callDir = join(registry.root, "index/by-callkey");
  const typedDir = join(registry.root, "index/by-typed-data");
  assert.deepEqual((await readdir(callDir)).sort(), [...approveFiles, ...callFiles].sort());
  assert.deepEqual((await readdir(typedDir)).sort(), typedFiles.sort());
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);
  for (const name of approveFiles) {
    const entry = await readJson(join(callDir, name));
    assert.equal(entry.schema_version, "3-ref");
    assert.equal(entry.bundle_id, approveId);
    assert.equal(entry.manifest_path, selection.manifest.path);
    const bundle = await resolveIndexBundle(registry.root, entry);
    if (approveBundle) assert.deepEqual(bundle, approveBundle);
    approveBundle = bundle;
  }
  // Resolve every selected typed AND callkey reference and verify JCS before
  // any bundle is installed. Permit2 addresses come from the real manifests.
  for (const spec of typedSpecs) {
    let resolved;
    for (const chain of chains) {
      const typed = await readJson(join(typedDir, `${chain}__${permit2}__${spec.type}.json`));
      const callkey = await readJson(join(callDir, `${chain}__${permit2}__${spec.selector}.json`));
      for (const entry of [typed, callkey]) {
        assert.equal(entry.schema_version, undefined, "Concrete Permit2 indexes remain inline");
        assert.equal(entry.bundle_ref, undefined);
        assert.equal(entry.bundle_id, spec.id);
        assert.equal(entry.manifest_path, spec.pin.path);
      }
      const bundle = await resolveIndexBundle(registry.root, typed);
      assert.deepEqual(await resolveIndexBundle(registry.root, callkey), bundle);
      assert.deepEqual(typed, callkey);
      if (resolved) assert.deepEqual(bundle, resolved);
      resolved = bundle;
      entries.push({ type: spec.type, chain, typed, callkey });
    }
    assert.deepEqual(resolved.match.chain_to_addresses, Object.fromEntries(chains.map((chain) => [chain, [permit2]])));
    assert.equal(resolved.match.chain_to_addresses_source, undefined);
    if (spec.id === singleId) singleBundle = resolved;
    else batchBundle = resolved;
  }
  assert.deepEqual(singleBundle, registry.permit2SingleSource);
  assert.deepEqual(batchBundle, registry.permit2BatchSource);
  const normal = requestCase("two-distinct-details");
  const single = singleRequest("single-normal");
  const strictRequests = [singleBundle, batchBundle].map((bundle) => ({
    id: `strict-${bundle.match.typed_data.primary_type}`, kind: "typed_strict",
    input: {
      requested_signer: fixture.defaults.submitter, submitter: fixture.defaults.submitter,
      submitted_at: fixture.defaults.submitted_at,
      typed_data: {
        domain: { name: "Permit2", chainId: "1", verifyingContract: permit2 },
        types: bundle.match.typed_data.types, primaryType: bundle.match.typed_data.primary_type,
        message: bundle.id === singleId ? singleFixture.defaults.message : fixture.defaults.message,
      },
    },
  }));
  const scenarios = await Promise.allSettled([
    runScenario("batch-installed", [approveBundle, singleBundle, batchBundle], [
      ...alternation.map((entry) => entry.single
        ? singleRequest(entry.id, entry.zero)
        : { ...requestCase(entry.case), id: entry.id }),
      ...fixture.cases.map(({ id }) => requestCase(id)),
      { id: "batch-message-matches-single", kind: "typed", input: { ...normal.input, primary_type: "PermitSingle" } },
      { id: "single-message-matches-batch", kind: "typed", input: { ...single.input, primary_type: "PermitBatch" } },
      ...strictRequests,
    ]),
    runScenario("batch-empty", [], [normal, single]),
    runScenario("batch-single-only", [approveBundle, singleBundle], [normal, single]),
    runScenario("batch-batch-only", [approveBundle, batchBundle], [normal, single]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "WASM installation scenarios failed");
  [installed, empty, singleOnly, batchOnly] = scenarios.map(({ value }) => value);
}, { timeout: 200_000 });

after(async () => { await registry?.cleanup(); });

function resultById(scenario, id) {
  const entry = scenario.results.find((entry) => entry.id === id);
  assert.ok(entry, id);
  return entry.result;
}

function assertFailure(actual, expected) {
  assert.equal(actual.ok, false, JSON.stringify(actual));
  assert.equal(actual.data, null, "Child/limit errors must fail the whole request; no partial children");
  assert.equal(actual.error.kind, expected.error_kind);
  assert.equal(typeof actual.error.message, "string");
  assert.ok(actual.error.message.length > 0);
  if (expected.error_message) assert.equal(actual.error.message, expected.error_message);
  if (expected.message_includes) assert.ok(actual.error.message.includes(expected.message_includes), actual.error.message);
}

function safeTime(value) {
  const integer = BigInt(value);
  assert.ok(integer >= 0n && integer <= (1n << 53n) - 1n);
  return Number(integer); // Only a checked JS-safe timestamp is projected.
}

function expectedAction(entry) {
  const expected = entry.expected;
  const wanted = structuredClone(fixture.expected_action);
  wanted.body.actions = (expected.child_order ?? [0, 1]).map((index) => structuredClone(fixture.expected_action.body.actions[index]));
  for (const [index, overrides] of Object.entries(expected.children ?? {})) {
    const child = wanted.body.actions[index];
    for (const [field, value] of Object.entries(overrides)) {
      if (field === "nonce") child.nonce.value = structuredClone(value);
      else if (field === "expires_at") child.expires_at = safeTime(value);
      else { assert.equal(field, "amount"); child.amount = value; }
    }
  }
  for (const child of wanted.body.actions) {
    if (expected.chain_id !== undefined) {
      child.token.key.chain = `eip155:${expected.chain_id}`;
      child.nonce.source.chain = `eip155:${expected.chain_id}`;
    }
    if (expected.spender !== undefined) child.spender = expected.spender;
    if (expected.sig_deadline !== undefined) child.sig_deadline = safeTime(expected.sig_deadline);
    if (expected.submitted_at !== undefined) child.nonce.synced_at = safeTime(expected.submitted_at);
  }
  if (expected.chain_id !== undefined) wanted.meta.nature.domain.chain_id = expected.chain_id;
  if (expected.sig_deadline !== undefined) wanted.meta.nature.deadline = safeTime(expected.sig_deadline);
  if (expected.submitted_at !== undefined) wanted.meta.submitted_at = safeTime(expected.submitted_at);
  if (expected.unknown) {
    wanted.body = { domain: "unknown", target: permit2, chain: "eip155:1", calldata: "", value: "0x0" };
  }
  return wanted;
}

function assertBatch(actual, entry) {
  if (entry.expected.error_kind) { assertFailure(actual, entry.expected); return; }
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  assert.deepEqual(Object.keys(actual.data).sort(), ["actions", "decoder_id"]);
  assert.equal(actual.data.decoder_id, batchId);
  assert.equal(actual.data.actions.length, 1, "Batch has one outer Action, not one per detail");
  const action = actual.data.actions[0];
  const wanted = expectedAction(entry);
  if (entry.expected.time_diagnostic) {
    // Worker JSON.parse has already crossed the precision boundary. Compare
    // complete non-time fields, then diagnose unsafe Numbers without inventing
    // a rounded oracle. Raw u64 saturation is established by source review only.
    const observed = structuredClone(action);
    const bodyTimes = observed.body.actions.map((child) => { const time = child.sig_deadline; delete child.sig_deadline; return time; });
    const metaTime = observed.meta.nature.deadline;
    delete observed.meta.nature.deadline;
    for (const child of wanted.body.actions) delete child.sig_deadline;
    delete wanted.meta.nature.deadline;
    assert.deepEqual(observed, wanted);
    for (const time of bodyTimes) {
      assert.equal(typeof time, "number");
      assert.ok(Number.isInteger(time));
      assert.equal(Number.isSafeInteger(time), false);
      assert.equal(time, bodyTimes[0]);
      if (entry.expected.time_diagnostic === "unsafe-js-roundtrip") {
        assert.equal(time, metaTime);
        assert.notEqual(BigInt(time), BigInt(requestCase(entry.id).input.message.sigDeadline));
      } else {
        assert.equal(entry.expected.time_diagnostic, "u64-saturation-meta-zero");
        assert.equal(metaTime, 0);
        assert.notEqual(time, metaTime);
      }
    }
  } else {
    assert.deepEqual(action, wanted);
  }
  if (["normal", "limit_boundary"].includes(entry.group)) {
    const input = requestCase(entry.id).input;
    assert.equal(action.body.domain, "multicall");
    assert.equal(action.body.actions.length, input.message.details.length);
    for (const [index, child] of action.body.actions.entries()) {
      const detail = input.message.details[index];
      assert.equal(child.token.key.address, detail.token.toLowerCase());
      assert.equal(child.spender, input.message.spender.toLowerCase());
      assert.equal(BigInt(child.amount), BigInt(detail.amount));
      assert.equal(BigInt(child.expires_at), BigInt(detail.expiration));
      assert.equal(BigInt(child.nonce.value[0]) * 256n + BigInt(child.nonce.value[1]), BigInt(detail.nonce));
      assert.equal(child.sig_deadline, action.meta.nature.deadline);
      assert.equal(BigInt(child.sig_deadline), BigInt(input.message.sigDeadline));
      assert.equal(Object.hasOwn(child, "meta"), false, "Children are ActionBody values, not full Actions");
      assert.equal(Object.hasOwn(child, "owner"), false);
      assert.equal(Object.hasOwn(child.nonce, "confidence"), false);
    }
  }
}

function assertSingle(actual, zero = false) {
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  const wanted = structuredClone(singleFixture.expected_action);
  if (zero) wanted.body.amount = "0x0";
  assert.deepEqual(actual.data, { decoder_id: singleId, actions: [wanted] });
}

test("actual approve + Single + Batch: 12 callkeys / 8 typed / 0 selector, all four-chain refs and JCS", async (t) => {
  for (const type of ["PermitSingle", "PermitBatch"]) {
    const selected = entries.filter((entry) => entry.type === type);
    assert.deepEqual(selected.map(({ chain }) => chain), chains);
    assert.equal(new Set(selected.map(({ typed }) => typed.bundle_sha256)).size, 1);
  }
  const single = entries.find((entry) => entry.type === "PermitSingle").typed;
  const batch = entries.find((entry) => entry.type === "PermitBatch").typed;
  assert.notEqual(single.bundle_sha256, batch.bundle_sha256);
  assert.notEqual(batch.bundle_sha256, selection.permit2_batch_manifest.sha256);
  await assert.rejects(resolveIndexBundle(registry.root, { ...batch, bundle_sha256: `0x${"0".repeat(64)}` }), /Resolved bundle JCS digest mismatch/);
  t.diagnostic(JSON.stringify({
    source: selection.permit2_batch_manifest, resolved_jcs_sha256: batch.bundle_sha256,
    single_jcs_sha256: single.bundle_sha256, chains, callkeys: 12, typed_indexes: 8, selector_indexes: 0,
  }));
});

test("real Batch types, ABI components and positional emit include every child nonce and common field", () => {
  assert.equal(batchBundle.emit.strategy, "array_emit");
  assert.equal(batchBundle.emit.array_source, "$args.permitBatch[0]");
  assert.equal(batchBundle.emit.max_elements, undefined, "The current cap is supplied by runtime, not rewritten into source");
  const inputs = batchBundle.abi_fragment.abi.inputs;
  assert.deepEqual(inputs.map(({ name }) => name), ["owner", "permitBatch", "signature"]);
  assert.equal(inputs[1].type, "tuple");
  const components = inputs[1].components;
  assert.deepEqual(components.map(({ name, type }) => [name, type]), [["details", "tuple[]"], ["spender", "address"], ["sigDeadline", "uint256"]]);
  assert.deepEqual(components[0].components, [
    { name: "token", type: "address" }, { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" },
  ]);
  assert.deepEqual(batchBundle.match.typed_data.types.PermitDetails, components[0].components);
  assert.deepEqual(batchBundle.match.typed_data.types.PermitBatch, [
    { name: "details", type: "PermitDetails[]" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" },
  ]);
  assert.deepEqual(batchBundle.emit.body.token.permit2_sign_allowance, {
    token: { key: { standard: "erc20", chain: "$chain", address: "$inputs[0]" } },
    spender: "$args.permitBatch[1]", amount: "$inputs[1]", expires_at: "$inputs[2]",
    sig_deadline: "$args.permitBatch[2]", nonce: "$inputs[3]",
  });
  assert.deepEqual(batchBundle.emit.live_inputs.nonce, {
    source: { kind: "onchain_view", chain: "$chain", contract: permit2,
      function: "nonceBitmap(address,uint256)", decoder_id: "permit2_nonce_bitmap" }, ttl_s: 12,
  });
});

test("decimal/hex bounds, nonce coordinates and fixture classification are independently checked with BigInt", () => {
  assert.deepEqual(Object.fromEntries(Object.keys(groupCounts).map((group) => [group, fixture.cases.filter((entry) => entry.group === group).length])), groupCounts);
  for (const [index, values] of [[0, [1_000_000n, 1_739_000_000n, 513n]], [1, [2_000_000_000_000_000_000n, 1_740_000_000n, 770n]]]) {
    const detail = fixture.defaults.message.details[index];
    const child = fixture.expected_action.body.actions[index];
    assert.equal(detail.amount, values[0].toString(10));
    assert.equal(BigInt(child.amount), values[0]);
    assert.equal(detail.expiration, values[1].toString(10));
    assert.equal(BigInt(child.expires_at), values[1]);
    assert.equal(detail.nonce, values[2].toString(10));
    assert.equal(BigInt(child.nonce.value[0]) * 256n + BigInt(child.nonce.value[1]), values[2]);
  }
  for (const index of [0, 1]) {
    for (const [field, bits, output] of [["amount", 160n, "amount"], ["expiration", 48n, "expires_at"], ["nonce", 48n, "nonce"]]) {
      for (const [suffix, integer] of [["zero", 0n], ["max", (1n << bits) - 1n], ["declared-width-overflow", 1n << bits]]) {
        const entry = caseById(`child-${index}-${field}-${suffix}`);
        assert.equal(requestCase(entry.id).input.message.details[index][field], integer.toString(10));
        const expected = entry.expected.children[index][output];
        if (field === "nonce") {
          assert.equal(BigInt(expected[0]), integer / 256n);
          assert.equal(BigInt(expected[1]), integer % 256n);
        } else assert.equal(BigInt(expected), integer);
        assert.equal(entry.group, suffix.endsWith("overflow") ? "legacy_diagnostic" : "normal");
      }
    }
  }
  for (const [id, n] of [["sig-deadline-js-safe-max", (1n << 53n) - 1n], ["sig-deadline-js-precision", (1n << 53n) + 1n], ["sig-deadline-u64-overflow", 1n << 64n]]) {
    assert.equal(requestCase(id).input.message.sigDeadline, n.toString(10));
  }
  assert.equal(requestCase("details-64").input.message.details.length, 64);
  assert.equal(requestCase("details-65").input.message.details.length, 65);
  const input = fixture.defaults;
  assert.equal(new Set([input.verifying_contract, input.submitter, input.message.spender, ...input.message.details.map(({ token }) => token)]).size, 5);
  for (const entry of fixture.cases) {
    assert.ok(Object.hasOwn(groupCounts, entry.group), entry.id);
    if (["legacy_diagnostic", "empty_observation"].includes(entry.group)) assert.ok(entry.observation?.length > 0, entry.id);
    else assert.equal(entry.observation, undefined, entry.id);
  }
});

test("key order does not matter; detail reversal and duplicate tokens preserve complete ordered children", () => {
  assert.notDeepEqual(Object.keys(requestCase("two-distinct-details").input.message.details[0]), Object.keys(requestCase("object-key-order").input.message.details[0]));
  const original = resultById(installed, "two-distinct-details");
  assert.deepEqual(resultById(installed, "object-key-order"), original);
  const reversed = resultById(installed, "reversed-details").data.actions[0];
  assert.deepEqual(reversed, { body: { domain: "multicall", actions: [...original.data.actions[0].body.actions].reverse() }, meta: original.data.actions[0].meta });
  const duplicate = resultById(installed, "duplicate-token-distinct-values").data.actions[0].body.actions;
  assert.equal(duplicate.length, 3);
  assert.equal(duplicate[0].token.key.address, duplicate[2].token.key.address);
  assert.notEqual(duplicate[0].amount, duplicate[2].amount);
  assert.notEqual(duplicate[0].expires_at, duplicate[2].expires_at);
  assert.notDeepEqual(duplicate[0].nonce.value, duplicate[2].nonce.value);
});

test("Single/Batch alternate in one WASM process; empty and independent installation states remain isolated", () => {
  const installData = (ids) => ids.map((id) => ({ decoder_id: id, bundle_id: id }));
  assert.deepEqual(installed.installations.map(({ data }) => data), installData([approveId, singleId, batchId]));
  assert.deepEqual(installed.results.slice(0, alternation.length).map(({ id }) => id), alternation.map(({ id }) => id));
  for (const entry of alternation) {
    if (entry.single) assertSingle(resultById(installed, entry.id), entry.zero);
    else assertBatch(resultById(installed, entry.id), caseById(entry.case));
  }
  assert.deepEqual(empty.installations, []);
  assert.deepEqual(singleOnly.installations.map(({ data }) => data), installData([approveId, singleId]));
  assert.deepEqual(batchOnly.installations.map(({ data }) => data), installData([approveId, batchId]));
  for (const id of ["two-distinct-details", "single-normal"]) assertFailure(resultById(empty, id), { error_kind: "no_typed_data_mapper" });
  assertFailure(resultById(singleOnly, "two-distinct-details"), { error_kind: "no_typed_data_mapper" });
  assertSingle(resultById(singleOnly, "single-normal"));
  assertFailure(resultById(batchOnly, "single-normal"), { error_kind: "no_typed_data_mapper" });
  assertBatch(resultById(batchOnly, "two-distinct-details"), caseById("two-distinct-details"));
  // Both names ARE registered here. Crossed shapes are matched input errors,
  // whereas the fixture's PermitOther is a genuine lookup miss.
  assertFailure(resultById(installed, "batch-message-matches-single"), { error_kind: "build_action_body_failed" });
  assertFailure(resultById(installed, "single-message-matches-batch"), { error_kind: "build_array_emit_failed" });
});

test("v4 continues to reject installed Single and Batch without any v3 retry", () => {
  for (const type of ["PermitSingle", "PermitBatch"]) {
    assertFailure(resultById(installed, `strict-${type}`), { error_kind: "unsupported_typed_data_contract" });
  }
});

for (const entry of fixture.cases) {
  const label = entry.observation ? `${entry.group} (not a Permit2 validity claim)` : entry.group;
  test(`${label}: ${entry.id}`, (t) => {
    const actual = resultById(installed, entry.id);
    assertBatch(actual, entry);
    if (entry.observation) {
      t.diagnostic(JSON.stringify({
        issue: entry.observation,
        message_input: requestCase(entry.id).input.message,
        body_domain: actual.data?.actions[0]?.body.domain,
        children: actual.data?.actions[0]?.body.actions?.map((body) => ({
          amount: body.amount, expiration: body.expires_at, nonce_live_field: body.nonce, sig_deadline: body.sig_deadline,
        })),
        meta_deadline: actual.data?.actions[0]?.meta.nature.deadline,
      }));
    }
  });
}
