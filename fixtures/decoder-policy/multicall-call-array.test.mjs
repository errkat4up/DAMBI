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
const fixture = await readJson(new URL("./multicall-call-array.cases.json", import.meta.url));
const approveId = "standard/erc20/approve@1.0.0";
const transferId = "standard/erc20/transfer@1.0.0";
const bundlerId = "morpho/bundler3/1-multicall@1.0.0";
const selector = "0x374f435d";
const bundler = "0x6566194141eefa99af43bb5aa71460ca2dc90245";
let registry;
let bundles;
let entries;
let installed;
let subsets;
let alternating;
let direct;

function requestCase(id, requestId = id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing DEC-06b case: ${id}`);
  return { ...entry, id: requestId, input: { ...fixture.defaults, ...entry.input } };
}

function unknown(call, chain = 1) {
  return {
    domain: "unknown", target: call.to.toLowerCase(), chain: `eip155:${chain}`,
    calldata: call.data.toLowerCase(), value: `0x${BigInt(call.value).toString(16)}`,
  };
}

function directRequests(base) {
  return base.calls.map((call, index) => {
    const action = structuredClone(base.expected.action);
    action.body = structuredClone(base.expected.action.body.actions[index]);
    action.meta.nature.value = `0x${BigInt(call.value).toString(16)}`;
    return {
      id: index === 0 ? "direct-approve" : "direct-transfer",
      input: { ...base.input, to: call.to, selector: call.data.slice(0, 10), calldata: call.data, value: call.value },
      expected: { decoder_id: index === 0 ? approveId : transferId, action },
    };
  });
}

async function runScenario(name, ids, cases) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ handoff: { suite: "multicall-call-array", scenario: name },
    bundles: ids.map((id) => bundles.get(id)),
    requests: cases.map(({ id, input }) => ({ id, input })),
  }));
  try {
    // Each installation set uses a fresh process. Requests within it share the
    // existing global Registry and the unmodified worker transaction branch.
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const output = JSON.parse(stdout);
    assert.deepEqual(output.installations, ids.map((id) => ({
      ok: true, data: { decoder_id: id, bundle_id: id }, error: null,
    })));
    assert.deepEqual(output.results.map(({ id }) => id), cases.map(({ id }) => id));
    return output;
  } catch (error) {
    throw new Error(`WASM scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; see README.md for paired JS/WASM prerequisites.`);
    });
  }
  assert.equal(fixture.cases.length, 43);
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  assert.deepEqual(fixture.registry_sources, [
    selection.bundler3_manifest.path, selection.manifest.path, selection.transfer_manifest.path,
  ]);
  assert.deepEqual(fixture.registry_source_sha256, Object.fromEntries([
    selection.bundler3_manifest, selection.manifest, selection.transfer_manifest,
  ].map(({ path, sha256 }) => [path, sha256])));
  registry = await buildHandoffRegistry(selection, "multicall-call-array");
  const specs = [
    [selection.manifest, registry.source],
    [selection.transfer_manifest, registry.transferSource],
    [selection.bundler3_manifest, registry.bundler3Source],
  ];
  const tokenAddresses = Object.fromEntries(selection.tokens.map(
    ({ chain_id, address }) => [String(chain_id), [address]],
  ));
  const expectedFiles = specs.flatMap(([, source]) => Object.entries(
    source.id === bundlerId ? source.match.chain_to_addresses : tokenAddresses,
  ).flatMap(([chain, addresses]) => addresses.map(
    (address) => `${chain}__${address}__${source.match.selector}.json`,
  ))).sort();
  const callDir = join(registry.root, "index/by-callkey");
  assert.deepEqual((await readdir(callDir)).sort(), expectedFiles);
  for (const dir of ["index/by-typed-data", "index/by-selector", "contexts"]) {
    assert.deepEqual(await readdir(join(registry.root, dir)), []);
  }
  bundles = new Map();
  entries = [];
  for (const [selected, source] of specs) {
    const concrete = source.id === bundlerId;
    const addresses = concrete ? source.match.chain_to_addresses : tokenAddresses;
    const expectedBundle = concrete ? source : {
      ...source, match: { selector: source.match.selector, chain_to_addresses: addresses },
    };
    const digest = fixture.expected_bundle_digests[source.id];
    for (const [chain, targets] of Object.entries(addresses)) {
      for (const target of targets) {
        const entry = await readJson(join(callDir, `${chain}__${target}__${source.match.selector}.json`));
        // Exact output forms from the builder: sourced tokens use references;
        // the concrete Bundler3 manifest is inline and has no index schema tag.
        assert.deepEqual(entry, {
          matched: true, bundle_id: source.id, manifest_path: selected.path, bundle_sha256: digest,
          ...(concrete ? { bundle: source } : { schema_version: "3-ref", bundle_ref: `bundles/${digest}.json` }),
        });
        const resolved = await resolveIndexBundle(registry.root, entry);
        assert.deepEqual(resolved, expectedBundle);
        if (bundles.has(source.id)) assert.deepEqual(resolved, bundles.get(source.id));
        bundles.set(source.id, resolved);
        entries.push(entry);
      }
    }
  }
  assert.deepEqual((await readdir(join(registry.root, "bundles"))).sort(),
    [approveId, transferId].map((id) => `${fixture.expected_bundle_digests[id]}.json`).sort());
  const base = requestCase("approve-transfer");
  direct = directRequests(base);
  // Build a bounded sequence from explicit fixture classifications, always
  // returning to the identical normal request after each failure, miss or
  // partial child-limit result. Malformed errors are selected independently
  // of children-65, which is now a successful partial response.
  const error = fixture.cases.find((entry) => entry.expected.error_kind === "build_multicall_failed"
    && entry.expected.message_includes.includes("leg #"));
  const miss = fixture.cases.find((entry) => entry.expected.error_kind === "no_declarative_v3_mapper");
  assert.ok(error);
  assert.ok(miss);
  alternating = [base.id, error.id, base.id, miss.id, base.id, "children-65", base.id]
    .map((id, index) => requestCase(id, `alternate-${index}-${id}`));
  const subsetCases = [...direct, base];
  const plans = [
    ["all", [approveId, transferId, bundlerId],
      [...fixture.cases.map(({ id }) => requestCase(id)), ...direct, ...alternating]],
    ["parent-only", [bundlerId], subsetCases],
    ["children-only", [approveId, transferId], subsetCases],
    ["without-transfer", [approveId, bundlerId], subsetCases],
    ["without-approve", [transferId, bundlerId], subsetCases],
    ["empty-registry", [], subsetCases],
  ];
  const results = await Promise.allSettled(plans.map((args) => runScenario(...args)));
  const failures = results.filter(({ status }) => status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map(({ reason }) => reason), "DEC-06b WASM scenarios failed");
  }
  installed = results[0].value;
  subsets = new Map(plans.slice(1).map(([name], index) => [name, results[index + 1].value]));
}, { timeout: 200_000 });

after(async () => { await registry?.cleanup(); });

function resultById(scenario, id) {
  const found = scenario.results.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found.result;
}

function assertExpected(actual, expected) {
  if (expected.error_kind) {
    assert.deepEqual(Object.keys(actual).sort(), ["data", "error", "ok"]);
    assert.equal(actual.ok, false, JSON.stringify(actual));
    assert.equal(actual.data, null, "Known malformed children must remain whole-request errors");
    assert.deepEqual(Object.keys(actual.error).sort(), ["kind", "message"]);
    assert.equal(actual.error.kind, expected.error_kind);
    assert.equal(typeof actual.error.message, "string");
    assert.ok(actual.error.message.includes(expected.message_includes), actual.error.message);
  } else {
    // Full envelope and outer Action/meta, not a count of Unknown children.
    assert.equal(Object.hasOwn(expected, "decoding"), expected.action.body.domain === "multicall");
    assert.deepEqual(actual, {
      ok: true,
      data: {
        decoder_id: expected.decoder_id, actions: [expected.action],
        ...(Object.hasOwn(expected, "decoding") ? { decoding: expected.decoding } : {}),
      },
      error: null,
    });
  }
}

test("actual sources yield nine callkeys, three verified digests and two physical bundle files", () => {
  assert.equal(entries.length, 9);
  assert.deepEqual([...bundles.keys()], [approveId, transferId, bundlerId]);
  assert.equal(new Set(entries.map((entry) => entry.bundle_sha256)).size, 3);
  assert.equal(entries.filter((entry) => entry.schema_version === "3-ref").length, 8);
  assert.equal(entries.filter((entry) => Object.hasOwn(entry, "bundle")).length, 1);
  assert.deepEqual(bundles.get(bundlerId).match, {
    selector, chain_to_addresses: { "1": [bundler] },
  });
  assert.deepEqual(bundles.get(bundlerId).emit, {
    strategy: "multicall_call_array", recurse_arg: "bundle", max_depth: 4,
  });
});

function wordAt(bytes, offset) {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset + 32 <= bytes.length);
  return BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`);
}

function smallOffset(value) {
  assert.ok(value <= 65_536n, "Fixture offsets stay bounded and exactly representable");
  return Number(value);
}

// Independent byte inspection without importing an ABI codec or route code.
// Array offsets start after count; data offsets start at each Call tuple.
function inspectCalls(calldata, trailer = "") {
  assert.equal(calldata.slice(0, 10), selector);
  assert.match(calldata, /^0x(?:[0-9a-f]{2})+$/);
  const bytes = Buffer.from(calldata.slice(10), "hex");
  assert.equal(wordAt(bytes, 0), 32n);
  const count = smallOffset(wordAt(bytes, 32));
  assert.ok(count <= 65);
  let cursor = 64 + 32 * count;
  const calls = [];
  for (let i = 0; i < count; i++) {
    assert.equal(wordAt(bytes, 64 + 32 * i), BigInt(cursor - 64));
    const tuple = cursor;
    assert.equal(bytes.subarray(tuple, tuple + 12).toString("hex"), "00".repeat(12));
    const to = `0x${bytes.subarray(tuple + 12, tuple + 32).toString("hex")}`;
    assert.equal(wordAt(bytes, tuple + 32), 160n);
    const value = wordAt(bytes, tuple + 64).toString(10);
    const flag = wordAt(bytes, tuple + 96);
    assert.ok(flag === 0n || flag === 1n);
    const callbackHash = `0x${bytes.subarray(tuple + 128, tuple + 160).toString("hex")}`;
    const length = smallOffset(wordAt(bytes, tuple + 160));
    const dataStart = tuple + 192;
    const paddedLength = Math.ceil(length / 32) * 32;
    assert.ok(dataStart + paddedLength <= bytes.length);
    const data = `0x${bytes.subarray(dataStart, dataStart + length).toString("hex")}`;
    assert.equal(bytes.subarray(dataStart + length, dataStart + paddedLength).toString("hex"),
      "00".repeat(paddedLength - length));
    calls.push({ to, data, value, skipRevert: flag === 1n, callbackHash });
    cursor = dataStart + paddedLength;
  }
  assert.equal(bytes.subarray(cursor).toString("hex"), trailer);
  return calls;
}

test("fixed approve and transfer calldata independently preserve recipient roles and large quantities", () => {
  const base = requestCase("approve-transfer");
  assert.equal(base.calls.length, 2);
  const token = selection.tokens.find((token) => token.chain_id === 1).address;
  const expectedAmounts = [1_234_567n, (1n << 200n) + 12_345n];
  assert.deepEqual(fixture.child_abi, {
    token, spender: "0x00000000000000000000000000000000deadbeef",
    recipient: "0x111122223333444455556666777788889999abcd",
    approve_amount: expectedAmounts[0].toString(), transfer_amount: expectedAmounts[1].toString(),
  });
  for (const [index, call] of base.calls.entries()) {
    assert.equal(call.to, token);
    assert.notEqual(call.to, base.input.to);
    const bytes = Buffer.from(call.data.slice(10), "hex");
    assert.equal(bytes.length, 64);
    assert.equal(call.data.slice(0, 10), index === 0 ? "0x095ea7b3" : "0xa9059cbb");
    assert.equal(call.data, index === 0 ? fixture.fixed_calldata.approve : fixture.fixed_calldata.transfer);
    const body = base.expected.action.body.actions[index];
    const role = index === 0 ? "spender" : "recipient";
    assert.equal(body[role], fixture.child_abi[role]);
    assert.equal(body.domain, "token");
    assert.equal(body.action, index === 0 ? "erc20_approve" : "erc20_transfer");
    assert.deepEqual(body.token, { key: { standard: "erc20", chain: "eip155:1", address: token } });
    assert.equal(wordAt(bytes, 0), BigInt(body[role]));
    assert.equal(wordAt(bytes, 32), expectedAmounts[index]);
    assert.equal(BigInt(body.amount), expectedAmounts[index]);
    assert.equal(typeof body.amount, "string");
    assert.equal(body[index === 0 ? "recipient" : "spender"], undefined);
  }
  assert.notEqual(base.expected.action.body.actions[0].spender, base.expected.action.body.actions[1].recipient);
  assert.equal(base.input.value, "999");
  assert.deepEqual(base.calls.map((call) => call.value), ["17", "19"]);
});

test("fixed Call[] tuple order, offset origins, lengths, padding and boundary counts are independently checked", () => {
  const abi = registry.bundler3Source.abi_fragment.abi;
  assert.equal(abi.name, "multicall");
  assert.equal(abi.inputs.length, 1);
  assert.equal(abi.inputs[0].name, "bundle");
  assert.equal(abi.inputs[0].type, "tuple[]");
  assert.deepEqual(abi.inputs[0].components.map(({ name, type }) => [name, type]), [
    ["to", "address"], ["data", "bytes"], ["value", "uint256"],
    ["skipRevert", "bool"], ["callbackHash", "bytes32"],
  ]);
  const base = requestCase("approve-transfer");
  assert.equal(base.input.calldata, fixture.fixed_calldata.approve_transfer);
  assert.equal(Buffer.from(base.input.calldata.slice(2), "hex").length, 708);
  const bytes = Buffer.from(base.input.calldata.slice(10), "hex");
  for (const [offset, value] of [[0, 32], [32, 2], [64, 64], [96, 352], [160, 160], [288, 68], [448, 160], [576, 68]]) {
    assert.equal(wordAt(bytes, offset), BigInt(value));
  }
  for (const entry of fixture.cases.filter((entry) => entry.canonical_call_array)) {
    assert.deepEqual(inspectCalls(entry.input.calldata), entry.calls, entry.id);
  }
  assert.deepEqual(inspectCalls(requestCase("transfer-approve").input.calldata), [...base.calls].reverse());
  assert.deepEqual(inspectCalls(requestCase("repeated-calls").input.calldata), [...base.calls, ...base.calls]);
  for (const count of [64, 65]) assert.equal(inspectCalls(requestCase(`children-${count}`).input.calldata).length, count);
  const capped = requestCase("children-65");
  assert.deepEqual(capped.expected.action.body.actions.slice(0, 64), requestCase("children-64").expected.action.body.actions);
  assert.deepEqual(capped.expected.action.body.actions[64], unknown(capped.calls[64]));
  assert.deepEqual(capped.expected.decoding, {
    status: "partial",
    diagnostics: [{ code: "child_limit", path: [{ kind: "call", index: 64 }], decoder_id: null }],
  });
  assert.deepEqual(inspectCalls(requestCase("empty-array").input.calldata), []);
  for (const [id, trailer] of [["outer-trailing-byte", "ab"], ["outer-trailing-word", "ab".repeat(32)]]) {
    const entry = requestCase(id);
    assert.equal(entry.input.calldata, base.input.calldata + trailer);
    assert.deepEqual(inspectCalls(entry.input.calldata, trailer), base.calls);
  }
  // Pin the exact damage relative to independently inspected canonical bytes.
  // Offsets here exclude the selector; the one-call tuple begins at byte 96.
  const one = Buffer.from(requestCase("approve-only").input.calldata.slice(10), "hex");
  assert.equal(one.length, 384);
  for (const [id, offset, value] of [
    ["outer-array-offset-out-of-bounds", 0, 4096],
    ["outer-array-count-overrun", 32, 3],
    ["outer-element-offset-out-of-bounds", 64, 4096],
    ["outer-tuple-data-offset-out-of-bounds", 128, 4096],
    ["outer-tuple-data-length-overrun", 256, 1024],
  ]) {
    const expected = Buffer.from(one);
    Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex").copy(expected, offset);
    assert.equal(requestCase(id).input.calldata, selector + expected.toString("hex"));
  }
  for (const [id, source, length] of [
    ["outer-selector-only", one, 0], ["outer-head-truncated", one, 31],
    ["outer-tuple-head-truncated", one, 224], ["outer-child-data-truncated", one, 355],
    ["outer-offset-table-truncated", bytes, 92],
  ]) {
    assert.equal(requestCase(id).input.calldata, selector + source.subarray(0, length).toString("hex"));
  }
  for (const position of ["first", "last"]) {
    const index = position === "first" ? 0 : 1;
    const entry = requestCase(`malformed-known-${position}-skip-revert-false`);
    assert.equal(entry.calls[index].data, base.calls[index].data.slice(0, position === "first" ? 74 : -2));
    assert.deepEqual(entry.calls[1 - index], base.calls[1 - index]);
  }
});

test("Call.value is retained in short and selector-bearing Unknown; flags do not fabricate callback results", () => {
  let shortCount = 0;
  let selectorCount = 0;
  let largeCount = 0;
  for (const entry of fixture.cases.filter((entry) => entry.expected.action && entry.calls)) {
    const base = requestCase(entry.id);
    const bodies = entry.expected.action.body.actions;
    assert.equal(bodies.length, entry.calls.length);
    for (const [index, call] of entry.calls.entries()) {
      if (bodies[index].domain === "unknown") {
        assert.deepEqual(bodies[index], unknown(call, base.input.chain_id), entry.id);
        if (call.data.length < 10) shortCount++; else selectorCount++;
        if (BigInt(call.value) > (1n << 64n)) largeCount++;
      }
      assert.equal(bodies[index].meta, undefined);
      assert.equal(bodies[index].decoder_id, undefined);
      assert.equal(bodies[index].skipRevert, undefined);
      assert.equal(bodies[index].callbackHash, undefined);
    }
    assertExpected(resultById(installed, entry.id), entry.expected);
  }
  assert.ok(shortCount >= 4);
  assert.ok(selectorCount >= 2);
  assert.ok(largeCount >= 2);
  const base = requestCase("approve-transfer");
  for (const id of ["skip-revert-true", "callback-hashes-nonzero", "skip-and-callback-variants"]) {
    const entry = requestCase(id);
    assert.notEqual(entry.input.calldata, base.input.calldata);
    assert.deepEqual(entry.calls.map(({ to, data, value }) => ({ to, data, value })),
      base.calls.map(({ to, data, value }) => ({ to, data, value })));
    assert.deepEqual(entry.expected, base.expected);
    assert.deepEqual(resultById(installed, id), resultById(installed, base.id));
  }
  for (const position of ["first", "last"]) {
    const noSkip = requestCase(`malformed-known-${position}-skip-revert-false`);
    const skip = requestCase(`malformed-known-${position}-skip-revert-true`);
    assert.equal(skip.calls[position === "first" ? 0 : 1].skipRevert, true);
    assert.deepEqual(skip.calls.map((call) => ({ ...call, skipRevert: false })), noSkip.calls);
    assert.deepEqual(skip.expected, noSkip.expected);
    assertExpected(resultById(installed, skip.id), noSkip.expected);
    assert.deepEqual(resultById(installed, skip.id), resultById(installed, noSkip.id));
  }
});

test("six isolated installation states distinguish real child Actions, per-call Unknown and parent misses", () => {
  const base = requestCase("approve-transfer");
  const miss = { error_kind: "no_declarative_v3_mapper", message_includes: "no v3 mapper bridged" };
  for (const entry of direct) assertExpected(resultById(installed, entry.id), entry.expected);
  for (const [name, hasApprove, hasTransfer, hasParent] of [
    ["parent-only", false, false, true], ["children-only", true, true, false],
    ["without-transfer", true, false, true], ["without-approve", false, true, true],
    ["empty-registry", false, false, false],
  ]) {
    const scenario = subsets.get(name);
    for (const [index, hasChild] of [hasApprove, hasTransfer].entries()) {
      assertExpected(resultById(scenario, direct[index].id), hasChild ? direct[index].expected : miss);
    }
    const expected = structuredClone(base.expected);
    expected.action.body.actions = base.calls.map((call, index) =>
      (index === 0 ? hasApprove : hasTransfer) ? base.expected.action.body.actions[index] : unknown(call));
    const diagnostics = [hasApprove, hasTransfer].flatMap((present, index) => present ? [] : [{
      code: "unregistered_call", path: [{ kind: "call", index }], decoder_id: null,
    }]);
    expected.decoding = { status: diagnostics.length ? "partial" : "complete", diagnostics };
    assertExpected(resultById(scenario, base.id), hasParent ? expected : miss);
  }
});

test("one WASM process repeatedly returns to the same normal Action after malformed, unsupported and limit requests", () => {
  for (const entry of alternating) assertExpected(resultById(installed, entry.id), entry.expected);
  assert.deepEqual(resultById(installed, alternating[0].id), resultById(installed, alternating.at(-1).id));
});

for (const { id, expected } of fixture.cases) {
  test(id, () => { assertExpected(resultById(installed, id), expected); });
}
