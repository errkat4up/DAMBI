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
const fixture = await readJson(new URL("./multicall-limits.cases.json", import.meta.url));
const approveId = "standard/erc20/approve@1.0.0";
const transferId = "standard/erc20/transfer@1.0.0";
const selfId = "uniswap/v3-nfpm/multicall@1.0.0";
const bundlerId = "morpho/bundler3/1-multicall@1.0.0";
const flashId = "morpho/general-adapter1/1-morphoFlashLoan@1.0.0";
const supplyId = "morpho/general-adapter1/1-morphoSupplyCollateral@1.0.0";
const adapter = "0x4a6c312ec70e8747a587ee860a0353cd42be0ae0";
const sourceKeys = [
  "manifest", "transfer_manifest", "nfpm_multicall_manifest", "nfpm_mint_manifest",
  "nfpm_refund_eth_manifest", "bundler3_manifest", "morpho_flash_loan_manifest",
  "morpho_supply_collateral_manifest",
];
const sourcedIds = new Set([approveId, transferId]);
let registry;
let bundles;
let entries;
let installed;
let absentCallbacks;
let alternating;

function requestCase(id, requestId = id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing DEC-06c case: ${id}`);
  return { ...entry, id: requestId, input: { ...fixture.defaults, ...entry.input } };
}

async function runScenario(name, ids, cases) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({
    bundles: ids.map((id) => bundles.get(id)),
    requests: cases.map(({ id, input }) => ({ id, input })),
  }));
  try {
    // Use the existing transaction worker. Every request in this process must
    // receive a fresh recursion budget while retaining the installed Registry.
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
    throw new Error(`WASM limits scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  for (const file of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", file)).catch(() => {
      throw new Error(`Missing ${file}; DEC-06c requires the new paired WASM build in README.md.`);
    });
  }
  assert.equal(fixture.cases.length, 20);
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, 20);
  assert.deepEqual(fixture.registry_sources, sourceKeys.map((key) => selection[key].path));
  assert.deepEqual(fixture.registry_source_sha256, Object.fromEntries(sourceKeys.map(
    (key) => [selection[key].path, selection[key].sha256],
  )));
  registry = await buildRegistry(selection, {
    includeTransfer: true, includeNfpmSelf: true, includeBundler3: true, includeMorphoCallbacks: true,
  });
  const specs = [
    [selection.manifest, registry.source],
    [selection.transfer_manifest, registry.transferSource],
    [selection.nfpm_multicall_manifest, registry.nfpmMulticallSource],
    [selection.nfpm_mint_manifest, registry.nfpmMintSource],
    [selection.nfpm_refund_eth_manifest, registry.nfpmRefundEthSource],
    [selection.bundler3_manifest, registry.bundler3Source],
    [selection.morpho_flash_loan_manifest, registry.morphoFlashLoanSource],
    [selection.morpho_supply_collateral_manifest, registry.morphoSupplyCollateralSource],
  ];
  const tokenAddresses = Object.fromEntries(selection.tokens.map(
    ({ chain_id, address }) => [String(chain_id), [address]],
  ));
  const expectedFiles = specs.flatMap(([, source]) => Object.entries(
    sourcedIds.has(source.id) ? tokenAddresses : source.match.chain_to_addresses,
  ).flatMap(([chain, targets]) => targets.map(
    (target) => `${chain}__${target.toLowerCase()}__${source.match.selector}.json`,
  ))).sort();
  const callDir = join(registry.root, "index/by-callkey");
  assert.deepEqual((await readdir(callDir)).sort(), expectedFiles);
  for (const dir of ["index/by-typed-data", "index/by-selector", "contexts"]) {
    assert.deepEqual(await readdir(join(registry.root, dir)), []);
  }
  bundles = new Map();
  entries = [];
  for (const [selected, source] of specs) {
    const sourced = sourcedIds.has(source.id);
    const addresses = sourced ? tokenAddresses : source.match.chain_to_addresses;
    const expectedBundle = sourced
      ? { ...source, match: { selector: source.match.selector, chain_to_addresses: addresses } }
      : source;
    const digest = fixture.expected_bundle_digests[source.id];
    for (const [chain, targets] of Object.entries(addresses)) {
      for (const target of targets) {
        const entry = await readJson(join(callDir,
          `${chain}__${target.toLowerCase()}__${source.match.selector}.json`));
        assert.deepEqual(entry, {
          matched: true, bundle_id: source.id, manifest_path: selected.path, bundle_sha256: digest,
          ...(sourced ? { schema_version: "3-ref", bundle_ref: `bundles/${digest}.json` } : { bundle: source }),
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
  alternating = [
    "visited-nodes-257", "direct-flash-callback", "malformed-callback-before-limit",
    "visited-nodes-256", "child-cap-before-unread-malformed", "primary-with-complete-callback",
    "self-depth-over", "direct-flash-callback",
  ].map((id, index) => requestCase(id, `alternate-${index}-${id}`));
  const miss = requestCase("callback-depth-before", "alternate-unregistered-parent");
  miss.input = { ...miss.input, to: "0x000000000000000000000000000000000000beef" };
  miss.expected = { error_kind: "no_declarative_v3_mapper", message_includes: "no v3 mapper" };
  alternating.splice(3, 0, miss);
  const ids = [...bundles.keys()];
  const plans = [
    ["all", ids, [...fixture.cases.map(({ id }) => requestCase(id)), ...alternating]],
    ["without-callback-sources", ids.filter((id) => id !== flashId && id !== supplyId),
      [requestCase("callback-depth-before")]],
  ];
  const outcomes = await Promise.allSettled(plans.map((args) => runScenario(...args)));
  const failures = outcomes.filter(({ status }) => status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map(({ reason }) => reason), "DEC-06c WASM scenarios failed");
  }
  installed = outcomes[0].value;
  absentCallbacks = outcomes[1].value;
}, { timeout: 200_000 });

after(async () => { await registry?.cleanup(); });

function resultById(scenario, id) {
  const entry = scenario.results.find((entry) => entry.id === id);
  assert.ok(entry, id);
  return entry.result;
}

function assertExpected(actual, expected) {
  if (expected.error_kind) {
    assert.deepEqual(Object.keys(actual).sort(), ["data", "error", "ok"]);
    assert.equal(actual.ok, false, JSON.stringify(actual));
    assert.equal(actual.data, null, "Malformed data reached before a limit remains a whole-request error");
    assert.deepEqual(Object.keys(actual.error).sort(), ["kind", "message"]);
    assert.equal(actual.error.kind, expected.error_kind);
    assert.ok(actual.error.message.includes(expected.message_includes), actual.error.message);
  } else {
    assert.deepEqual(actual, {
      ok: true,
      data: {
        decoder_id: expected.decoder_id, actions: [expected.action], decoding: expected.decoding,
        ...(Object.hasOwn(expected, "reenter_callback") ? { reenter_callback: expected.reenter_callback } : {}),
      },
      error: null,
    });
  }
}

test("eight real sources produce twenty-three exact callkeys, eight ref entries and two physical bundles", () => {
  assert.equal(entries.length, 23);
  assert.equal(bundles.size, 8);
  assert.equal(entries.filter((entry) => entry.schema_version === "3-ref").length, 8);
  assert.equal(entries.filter((entry) => Object.hasOwn(entry, "bundle")).length, 15);
  assert.equal(new Set(entries.map((entry) => entry.bundle_sha256)).size, 8);
  for (const id of [flashId, supplyId]) {
    assert.deepEqual(bundles.get(id).match.chain_to_addresses, { "1": [adapter] });
    assert.equal(bundles.get(id).match.chain_to_addresses_source, undefined);
    assert.equal(bundles.get(id).emit.reenter_callback_arg, "data");
  }
  assert.equal(bundles.get(flashId).emit.strategy, "reenter_only");
  assert.equal(bundles.get(supplyId).emit.strategy, "single_emit");
  assert.equal(bundles.get(selfId).emit.max_depth, 3);
  assert.equal(bundles.get(bundlerId).emit.max_depth, 4);
});

function wordAt(bytes, offset) {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset + 32 <= bytes.length);
  return BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`);
}
function small(value) {
  assert.ok(value >= 0n && value <= 262_144n, "Fixture offsets and lengths remain bounded");
  return Number(value);
}
function addressAt(bytes, offset, address) {
  assert.equal(bytes.subarray(offset, offset + 12).toString("hex"), "00".repeat(12));
  assert.equal(bytes.subarray(offset + 12, offset + 32).toString("hex"), address.slice(2));
}
function dynamicAt(bytes, offset) {
  const length = small(wordAt(bytes, offset));
  const start = offset + 32;
  const end = start + length;
  const paddedEnd = start + Math.ceil(length / 32) * 32;
  assert.ok(paddedEnd <= bytes.length);
  assert.equal(bytes.subarray(end, paddedEnd).toString("hex"), "00".repeat(paddedEnd - end));
  return { data: bytes.subarray(start, end), end: paddedEnd };
}
function inspectCallback(bytes, tree) {
  if (tree.kind === "raw_callback") {
    assert.equal(`0x${bytes.toString("hex")}`, tree.data);
  } else {
    inspectCallArray(bytes, tree);
  }
}
function inspectCallArray(bytes, tree) {
  assert.equal(tree.kind, "call_array");
  assert.equal(wordAt(bytes, 0), 32n);
  assert.equal(wordAt(bytes, 32), BigInt(tree.legs.length));
  assert.ok(tree.legs.length <= 65);
  let cursor = 64 + tree.legs.length * 32;
  tree.legs.forEach((leg, index) => {
    assert.equal(wordAt(bytes, 64 + index * 32), BigInt(cursor - 64));
    addressAt(bytes, cursor, leg.to);
    assert.equal(wordAt(bytes, cursor + 32), 160n);
    assert.equal(wordAt(bytes, cursor + 64), BigInt(leg.value));
    assert.equal(wordAt(bytes, cursor + 96), leg.skipRevert ? 1n : 0n);
    assert.equal(`0x${bytes.subarray(cursor + 128, cursor + 160).toString("hex")}`, leg.callbackHash);
    const child = dynamicAt(bytes, cursor + 160);
    inspectNode(child.data, leg.node);
    cursor = child.end;
  });
  assert.equal(cursor, bytes.length);
}
function inspectNode(calldata, tree) {
  if (tree.kind === "leaf") {
    assert.equal(`0x${calldata.toString("hex")}`, tree.data);
    return;
  }
  const selector = calldata.subarray(0, 4).toString("hex");
  const bytes = calldata.subarray(4);
  if (tree.kind === "call_array") {
    assert.equal(selector, "374f435d");
    inspectCallArray(bytes, tree);
  } else if (tree.kind === "self") {
    assert.equal(selector, "ac9650d8");
    assert.equal(wordAt(bytes, 0), 32n);
    assert.equal(wordAt(bytes, 32), BigInt(tree.children.length));
    let cursor = 64 + tree.children.length * 32;
    tree.children.forEach((child, index) => {
      assert.equal(wordAt(bytes, 64 + index * 32), BigInt(cursor - 64));
      const decoded = dynamicAt(bytes, cursor);
      inspectNode(decoded.data, child);
      cursor = decoded.end;
    });
    assert.equal(cursor, bytes.length);
  } else if (tree.kind === "flash") {
    assert.equal(selector, "e2975912");
    addressAt(bytes, 0, tree.token);
    assert.equal(wordAt(bytes, 32), BigInt(tree.assets));
    assert.equal(wordAt(bytes, 64), 96n);
    const callback = dynamicAt(bytes, 96);
    assert.equal(callback.end, bytes.length);
    inspectCallback(callback.data, tree.callback);
  } else {
    assert.equal(tree.kind, "supply_collateral");
    assert.equal(selector, "ca463673");
    ["loanToken", "collateralToken", "oracle", "irm"].forEach((key, index) => {
      addressAt(bytes, index * 32, tree.marketParams[key]);
    });
    assert.equal(wordAt(bytes, 128), BigInt(tree.marketParams.lltv));
    assert.equal(wordAt(bytes, 160), BigInt(tree.assets));
    addressAt(bytes, 192, tree.onBehalf);
    assert.equal(wordAt(bytes, 224), 256n);
    const callback = dynamicAt(bytes, 256);
    assert.equal(callback.end, bytes.length);
    inspectCallback(callback.data, tree.callback);
  }
}

test("actual callback ABI tuples, fixed offsets and source-derived primary values remain independently checkable", () => {
  const signature = (source) => source.abi_fragment.abi.inputs.map(({ name, type }) => [name, type]);
  assert.deepEqual(signature(registry.morphoFlashLoanSource), [
    ["token", "address"], ["assets", "uint256"], ["data", "bytes"],
  ]);
  assert.deepEqual(signature(registry.morphoSupplyCollateralSource), [
    ["marketParams", "tuple"], ["assets", "uint256"], ["onBehalf", "address"], ["data", "bytes"],
  ]);
  assert.deepEqual(registry.morphoSupplyCollateralSource.abi_fragment.abi.inputs[0].components
    .map(({ name, type }) => [name, type]), [
    ["loanToken", "address"], ["collateralToken", "address"], ["oracle", "address"],
    ["irm", "address"], ["lltv", "uint256"],
  ]);
  assert.equal(Buffer.from(fixture.fixed_calldata.callback_approve.slice(2), "hex").length, 384);
  assert.equal(Buffer.from(fixture.fixed_calldata.flash_approve_callback.slice(2), "hex").length, 516);
  assert.equal(Buffer.from(fixture.fixed_calldata.supply_collateral_approve_callback.slice(2), "hex").length, 676);
  const primary = requestCase("primary-with-complete-callback").expected.action.body.actions[0];
  assert.equal(primary.venue.market_id, fixture.market_id);
  assert.equal(primary.amount, "0x309");
  assert.equal(primary.asset.key.address, fixture.market_params.collateralToken);
  assert.equal(primary.on_behalf_of, fixture.defaults.submitter);
  assert.equal(primary.live_inputs.reserve_state.value.total_supply, "0x0");
  assert.equal(primary.live_inputs.user_state_before.value.total_debt_usd, "0x0");
});

test("all fixed request trees independently match ABI words, offsets, values, lengths and padding", () => {
  for (const entry of fixture.cases) {
    const bytes = Buffer.from(entry.input.calldata.slice(2), "hex");
    assert.ok(bytes.length <= 82_000);
    inspectNode(bytes, entry.request_tree);
  }
  const approve = Buffer.from(fixture.fixed_calldata.approve.slice(10), "hex");
  assert.equal(wordAt(approve, 32), 1_234_567n);
  const transfer = Buffer.from(fixture.fixed_calldata.transfer.slice(10), "hex");
  assert.equal(wordAt(transfer, 32), (1n << 200n) + 12_345n);
});

test("node boundaries and diagnostics pin the approved counts and unvisited-call representation", () => {
  for (const total of [256, 257]) {
    const entry = requestCase(`visited-nodes-${total}`);
    assert.deepEqual(entry.leaf_counts, [63, 63, 63, total - 194]);
    assert.equal(1 + entry.leaf_counts.length + entry.leaf_counts.reduce((a, b) => a + b, 0), total);
    assert.equal(entry.request_tree.legs.length, 4);
    assert.deepEqual(entry.request_tree.legs.map(({ node }) => node.legs.length), entry.leaf_counts);
  }
  const exhausted = requestCase("visited-nodes-257").expected;
  assert.deepEqual(exhausted.decoding, {
    status: "partial", diagnostics: [{
      code: "node_limit", path: [{ kind: "call", index: 3 }, { kind: "call", index: 62 }], decoder_id: null,
    }],
  });
  assert.equal(exhausted.action.body.actions[3].actions[62].calldata, fixture.fixed_calldata.approve);
  assert.equal(exhausted.action.body.actions[3].actions[62].value, "0x11");
  const callbackBudget = requestCase("callback-container-node-budget");
  assert.deepEqual(callbackBudget.approve_prefix_counts, [63, 63, 63, 60]);
  const visitedBeforeCallbackChild = 1 + 4
    + callbackBudget.approve_prefix_counts.reduce((a, b) => a + b, 0) + 1 + 1;
  assert.equal(visitedBeforeCallbackChild, 256);
  assert.equal(callbackBudget.visited_before_blocked_child, visitedBeforeCallbackChild);
  assert.equal(callbackBudget.unlimited_visited_nodes, visitedBeforeCallbackChild + 1);
  assert.deepEqual(callbackBudget.request_tree.legs.map(({ node }) => node.legs.length), [63, 63, 63, 61]);
  const finalFlash = callbackBudget.request_tree.legs[3].node.legs[60];
  assert.equal(finalFlash.to, adapter);
  assert.equal(finalFlash.node.kind, "flash");
  assert.equal(finalFlash.node.callback.legs.length, 1);
  assert.equal(finalFlash.node.callback.legs[0].node.data, fixture.fixed_calldata.approve);
  assert.deepEqual(callbackBudget.expected.decoding, {
    status: "partial", diagnostics: [{
      code: "node_limit", path: [
        { kind: "call", index: 3 }, { kind: "call", index: 60 },
        { kind: "callback" }, { kind: "call", index: 0 },
      ], decoder_id: null,
    }],
  });
  assert.deepEqual(callbackBudget.expected.action.body.actions[3].actions[60], {
    domain: "unknown", target: finalFlash.node.callback.legs[0].to, chain: "eip155:1",
    calldata: fixture.fixed_calldata.approve, value: "0x11",
  });
  const callbackBlocked = requestCase("callback-container-depth-over").expected.decoding.diagnostics[0];
  assert.equal(callbackBlocked.code, "depth_limit");
  assert.equal(callbackBlocked.decoder_id, flashId);
  assert.deepEqual(callbackBlocked.path.at(-1), { kind: "callback" });
  for (const entry of fixture.cases.filter(({ expected }) => expected.action)) {
    assert.equal(entry.expected.decoding.status, entry.expected.decoding.diagnostics.length ? "partial" : "complete");
    for (const diagnostic of entry.expected.decoding.diagnostics) {
      assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "decoder_id", "path"]);
      for (const segment of diagnostic.path) {
        assert.ok(["call", "self", "callback"].includes(segment.kind));
        assert.deepEqual(Object.keys(segment).sort(), segment.kind === "callback" ? ["kind"] : ["index", "kind"]);
      }
    }
  }
});

test("full, exhausted, failed and unsupported requests cannot leak a recursion budget into the next request", () => {
  for (const entry of alternating) assertExpected(resultById(installed, entry.id), entry.expected);
});

test("missing callback manifests preserve the whole adapter call without guessing its unopened callback", () => {
  const base = requestCase("callback-depth-before");
  assertExpected(resultById(absentCallbacks, base.id), {
    decoder_id: bundlerId,
    action: {
      body: { domain: "multicall", actions: [{
        domain: "unknown", target: adapter, chain: "eip155:1",
        calldata: fixture.fixed_calldata.flash_approve_callback, value: "0x1f",
      }] },
      meta: base.expected.action.meta,
    },
    decoding: {
      status: "partial", diagnostics: [{ code: "unregistered_call", path: [{ kind: "call", index: 0 }], decoder_id: null }],
    },
  });
});

for (const entry of fixture.cases) {
  test(entry.id, () => assertExpected(resultById(installed, entry.id), entry.expected));
}
