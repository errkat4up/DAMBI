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
const fixture = await readJson(new URL("./multicall-self.cases.json", import.meta.url));
const approveId = "standard/erc20/approve@1.0.0";
const multicallId = "uniswap/v3-nfpm/multicall@1.0.0";
const mintId = "uniswap/v3-nfpm/mint@1.0.0";
const refundId = "uniswap/v3-nfpm/refundETH@1.0.0";
const multicallSelector = "0xac9650d8";
let registry;
let entries;
let bundles;
let installed;
let subsets;
let alternating;

function requestCase(id, requestId = id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, `Missing DEC-06a case: ${id}`);
  return { ...entry, id: requestId, input: { ...fixture.defaults, ...entry.input } };
}

async function runScenario(name, bundleIds, cases) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({
    bundles: bundleIds.map((id) => bundles.get(id)),
    requests: cases.map(({ id, input }) => ({ id, input })),
  }));
  try {
    // Reuse the existing transaction branch. Each installation set has its own
    // process; requests within that process share the real global Registry.
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const output = JSON.parse(stdout);
    assert.deepEqual(output.installations, bundleIds.map((id) => ({
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
  assert.equal(fixture.cases.length, 43, "Required DEC-06a request count changed");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);
  assert.deepEqual(fixture.registry_sources, [
    selection.nfpm_multicall_manifest.path, selection.nfpm_mint_manifest.path,
    selection.nfpm_refund_eth_manifest.path,
  ]);
  registry = await buildRegistry(selection, { includeNfpmSelf: true });
  const specs = [
    [selection.manifest, registry.source],
    [selection.nfpm_multicall_manifest, registry.nfpmMulticallSource],
    [selection.nfpm_mint_manifest, registry.nfpmMintSource],
    [selection.nfpm_refund_eth_manifest, registry.nfpmRefundEthSource],
  ];
  const approveAddresses = Object.fromEntries(selection.tokens.map(
    ({ chain_id, address }) => [String(chain_id), [address]],
  ));
  const expectedFiles = specs.flatMap(([, source]) => Object.entries(
    source.id === approveId ? approveAddresses : source.match.chain_to_addresses,
  ).flatMap(([chain, addresses]) => addresses.map(
    (to) => `${chain}__${to.toLowerCase()}__${source.match.selector}.json`,
  ))).sort();
  const callkeyDir = join(registry.root, "index/by-callkey");
  assert.deepEqual((await readdir(callkeyDir)).sort(), expectedFiles);
  assert.deepEqual(await readdir(join(registry.root, "index/by-typed-data")), []);
  assert.deepEqual(await readdir(join(registry.root, "index/by-selector")), []);
  entries = [];
  bundles = new Map();
  for (const [selected, source] of specs) {
    const addresses = source.id === approveId ? approveAddresses : source.match.chain_to_addresses;
    for (const [chain, targets] of Object.entries(addresses)) {
      for (const target of targets) {
        const entry = await readJson(join(callkeyDir,
          `${chain}__${target.toLowerCase()}__${source.match.selector}.json`));
        // build-index writes concrete NFPM callkeys inline. Only the sourced
        // approve manifest emits 3-ref indexes and a separate bundle file.
        assert.deepEqual(entry, {
          matched: true,
          bundle_id: source.id,
          manifest_path: selected.path,
          bundle_sha256: fixture.expected_bundle_digests[source.id],
          ...(source.id === approveId ? {
            schema_version: "3-ref",
            bundle_ref: `bundles/${fixture.expected_bundle_digests[approveId]}.json`,
          } : { bundle: source }),
        });
        // Resolve the sourced ref or concrete inline entry and verify JCS over
        // the entire bundle before installation. NFPM source objects are intact.
        const resolved = await resolveIndexBundle(registry.root, entry);
        const expected = source.id === approveId
          ? { ...source, match: { selector: source.match.selector, chain_to_addresses: addresses } }
          : source;
        assert.deepEqual(resolved, expected);
        if (bundles.has(source.id)) assert.deepEqual(resolved, bundles.get(source.id));
        bundles.set(source.id, resolved);
        entries.push(entry);
      }
    }
  }
  assert.deepEqual((await readdir(join(registry.root, "bundles"))).sort(),
    [`${fixture.expected_bundle_digests[approveId]}.json`]);
  alternating = [
    "mint-refund", "mint-truncated-tuple", "usdc-is-not-nfpm", "refund-direct",
    "malformed-child-last", "all-unknown", "nested-depth-4", "children-65", "mint-refund",
  ].map((id, index) => requestCase(id, `alternate-${index}-${id}`));
  const subsetRequests = ["mint-direct", "refund-direct", "mint-refund"].map((id) => requestCase(id));
  const plans = [
    ["all-bundles", [approveId, multicallId, mintId, refundId],
      [...fixture.cases.map(({ id }) => requestCase(id)), ...alternating]],
    ["parent-only", [approveId, multicallId], subsetRequests],
    ["parent-mint", [approveId, multicallId, mintId], subsetRequests],
    ["parent-refund", [approveId, multicallId, refundId], subsetRequests],
    ["children-only", [approveId, mintId, refundId], subsetRequests],
  ];
  const results = await Promise.allSettled(plans.map((args) => runScenario(...args)));
  const failures = results.filter(({ status }) => status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map(({ reason }) => reason), "DEC-06a WASM scenarios failed");
  }
  installed = results[0].value;
  subsets = new Map(plans.slice(1).map(([name], index) => [name, results[index + 1].value]));
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
    assert.equal(actual.data, null, "Malformed failures must not become partial success or Unknown");
    assert.deepEqual(Object.keys(actual.error).sort(), ["kind", "message"]);
    assert.equal(actual.error.kind, expected.error_kind);
    assert.equal(typeof actual.error.message, "string");
    assert.ok(actual.error.message.includes(expected.message_includes), actual.error.message);
  } else {
    // Compare the entire envelope, including exact diagnostics for recursive
    // results and their absence on direct mint/refund routes.
    assert.equal(Object.hasOwn(expected, "decoding"), expected.action.body.domain === "multicall");
    assert.deepEqual(actual, {
      ok: true,
      data: {
        actions: [expected.action], decoder_id: expected.decoder_id,
        ...(Object.hasOwn(expected, "decoding") ? { decoding: expected.decoding } : {}),
      },
      error: null,
    });
  }
}

test("four actual sources yield sixteen exact callkeys and four pinned JCS bundle digests", () => {
  assert.equal(entries.length, 16);
  assert.deepEqual([...bundles.keys()], [approveId, multicallId, mintId, refundId]);
  assert.equal(new Set(entries.map((entry) => entry.bundle_sha256)).size, 4);
  assert.equal(entries.filter((entry) => entry.schema_version === "3-ref").length, 4);
  assert.equal(entries.filter((entry) => Object.hasOwn(entry, "bundle")).length, 12);
  for (const id of bundles.keys()) {
    assert.equal(entries.filter((entry) => entry.bundle_id === id).length, 4);
  }
  for (const id of [multicallId, mintId, refundId]) {
    const match = bundles.get(id).match;
    assert.equal(match.chain_to_addresses_source, undefined);
    assert.equal(match.chain_ids, undefined);
    assert.notDeepEqual(match.chain_to_addresses["8453"], match.chain_to_addresses["1"]);
    for (const { chain_id, address } of selection.tokens) {
      assert.ok(!match.chain_to_addresses[chain_id].map((to) => to.toLowerCase()).includes(address));
    }
  }
  assert.equal(bundles.get(multicallId).emit.max_depth, 3);
});

// Independent fixed-byte inspection, deliberately without an ABI library or
// production mapper. Offsets are bytes relative to the tuple-after-array-length.
function wordAt(bytes, byteOffset) {
  assert.ok(byteOffset >= 0 && byteOffset + 32 <= bytes.length);
  return BigInt(`0x${bytes.subarray(byteOffset, byteOffset + 32).toString("hex")}`);
}

function inspectArray(calldata, trailer = "") {
  assert.equal(calldata.slice(0, 10), multicallSelector);
  assert.match(calldata, /^0x(?:[0-9a-f]{2})+$/);
  const bytes = Buffer.from(calldata.slice(10), "hex");
  assert.equal(wordAt(bytes, 0), 32n);
  const count = Number(wordAt(bytes, 32));
  assert.ok(count <= 65, "Fixture inspection remains bounded");
  const tupleStart = 64;
  let cursor = tupleStart + count * 32;
  const children = [];
  for (let i = 0; i < count; i++) {
    assert.equal(wordAt(bytes, tupleStart + i * 32), BigInt(cursor - tupleStart));
    const length = Number(wordAt(bytes, cursor));
    const start = cursor + 32;
    const paddedLength = Math.ceil(length / 32) * 32;
    assert.ok(start + paddedLength <= bytes.length);
    children.push(`0x${bytes.subarray(start, start + length).toString("hex")}`);
    assert.equal(bytes.subarray(start + length, start + paddedLength).toString("hex"),
      "00".repeat(paddedLength - length));
    cursor = start + paddedLength;
  }
  assert.equal(bytes.subarray(cursor).toString("hex"), trailer);
  return children;
}

test("fixed mint tuple independently pins addresses, signed ticks, quantities and omitted deadline", () => {
  const { mint, refund, approve } = fixture.fixed_calldata;
  const fields = [
    ["token0", "address"], ["token1", "address"], ["fee", "uint24"],
    ["tickLower", "int24"], ["tickUpper", "int24"], ["amount0Desired", "uint256"],
    ["amount1Desired", "uint256"], ["amount0Min", "uint256"], ["amount1Min", "uint256"],
    ["recipient", "address"], ["deadline", "uint256"],
  ];
  assert.deepEqual(registry.nfpmMintSource.abi_fragment.abi.inputs, [{
    name: "params", type: "tuple", components: fields.map(([name, type]) => ({ name, type })),
  }]);
  assert.equal(mint.slice(0, 10), "0x88316456");
  const bytes = Buffer.from(mint.slice(10), "hex");
  assert.equal(bytes.length, 11 * 32);
  fields.forEach(([name, type], index) => {
    const value = wordAt(bytes, index * 32);
    const semantic = fixture.mint_abi[name];
    if (type === "address") {
      assert.equal(value.toString(16).padStart(40, "0"), semantic.slice(2));
      assert.equal(bytes.subarray(index * 32, index * 32 + 12).toString("hex"), "00".repeat(12));
    } else if (type === "int24") {
      const signed = BigInt.asIntN(256, value);
      assert.equal(signed, BigInt(semantic));
      assert.equal(BigInt.asIntN(24, value), signed, "int24 must be sign-extended to the full ABI word");
    } else {
      assert.equal(value, BigInt(semantic));
    }
  });
  const { body, meta } = requestCase("mint-direct").expected.action;
  for (const [field, names] of [
    ["amount_desired", ["amount0Desired", "amount1Desired"]],
    ["amount_min", ["amount0Min", "amount1Min"]],
  ]) {
    assert.deepEqual(body.params[field].map(BigInt), names.map((name) => BigInt(fixture.mint_abi[name])));
  }
  assert.equal(body.venue.fee_tier_bp, 3000);
  assert.deepEqual(body.params.range, { kind: "tick", lower: -887220, upper: 887220, liquidity: "0x0" });
  assert.equal(body.params.recipient, fixture.mint_abi.recipient);
  assert.notEqual(body.params.recipient, meta.submitter);
  assert.equal(body.params.deadline, undefined);
  assert.equal(refund, "0x12210e8a");
  assert.equal(requestCase("refund-direct").expected.action.body.amount, undefined);
  assert.equal(approve.slice(0, 10), "0x095ea7b3");
  assert.equal(wordAt(Buffer.from(approve.slice(10), "hex"), 32), 1_000_000n);
});

test("fixed bytes[] offsets, lengths, padding, nested order and precise malformed mutations are reviewable", () => {
  const { mint, refund, mint_refund: pair } = fixture.fixed_calldata;
  assert.equal(Buffer.from(pair.slice(2), "hex").length, 612);
  const bytes = Buffer.from(pair.slice(10), "hex");
  for (const [at, value] of [[0, 32], [32, 2], [64, 64], [96, 480], [128, 356], [544, 4]]) {
    assert.equal(wordAt(bytes, at), BigInt(value));
  }
  assert.deepEqual(inspectArray(pair), [mint, refund]);
  assert.equal(requestCase("mint-refund").input.calldata, pair);
  const walk = (data) => {
    const children = inspectArray(data);
    for (const child of children) if (child.startsWith(multicallSelector)) walk(child);
  };
  for (const entry of fixture.cases.filter((entry) => entry.canonical_multicall)) walk(entry.input.calldata);
  for (const depth of [2, 3, 4]) {
    let data = requestCase(`nested-depth-${depth}`).input.calldata;
    let body = requestCase(`nested-depth-${depth}`).expected.action.body;
    for (let i = 1; i < depth; i++) {
      const children = inspectArray(data);
      assert.equal(children.length, 1);
      assert.equal(body.domain, "multicall");
      assert.equal(body.actions.length, 1);
      [data] = children;
      [body] = body.actions;
    }
    assert.deepEqual(inspectArray(data), [mint, refund]);
    assert.deepEqual(body.actions, depth === 4
      ? [mint, refund].map((calldata) => ({
        domain: "unknown", target: requestCase("nested-depth-4").input.to,
        chain: "eip155:1", calldata, value: "0x0",
      }))
      : [requestCase("mint-direct").expected.action.body,
        requestCase("refund-direct").expected.action.body]);
  }
  assert.deepEqual(inspectArray(requestCase("refund-mint").input.calldata), [refund, mint]);
  assert.deepEqual(inspectArray(requestCase("repeated-calls").input.calldata), [mint, refund, mint, refund]);
  for (const count of [64, 65]) {
    assert.deepEqual(inspectArray(requestCase(`children-${count}`).input.calldata), Array(count).fill(refund));
  }
  const capped = requestCase("children-65").expected;
  assert.deepEqual(capped.action.body.actions.slice(0, 64), requestCase("children-64").expected.action.body.actions);
  assert.deepEqual(capped.action.body.actions[64], {
    domain: "unknown", target: requestCase("children-65").input.to,
    chain: "eip155:1", calldata: refund, value: "0x0",
  });
  assert.deepEqual(capped.decoding, {
    status: "partial",
    diagnostics: [{ code: "child_limit", path: [{ kind: "self", index: 64 }], decoder_id: null }],
  });
  for (const count of [0, 1, 3]) {
    assert.deepEqual(inspectArray(requestCase(`short-child-${count}`).input.calldata), [refund, `0x${"ab".repeat(count)}`]);
  }
  assert.equal(requestCase("mint-selector-only").input.calldata, mint.slice(0, 10));
  assert.equal(requestCase("mint-truncated-tuple").input.calldata, mint.slice(0, -2));
  const normal = requestCase("multicall-refund-only").input.calldata;
  for (const [id, offset, value] of [
    // Four heads cannot fit in the three remaining words. Merely changing 1
    // to 2 aliases a length word as an offset under the permissive ABI decoder.
    ["outer-offset-out-of-bounds", 0, 4096], ["outer-count-out-of-bounds", 32, 4],
    ["outer-child-offset-out-of-bounds", 64, 4096], ["outer-child-length-out-of-bounds", 96, 1024],
  ]) {
    const at = 10 + offset * 2;
    assert.equal(requestCase(id).input.calldata,
      normal.slice(0, at) + BigInt(value).toString(16).padStart(64, "0") + normal.slice(at + 64));
  }
  assert.equal(requestCase("outer-selector-only").input.calldata, multicallSelector);
  assert.equal(requestCase("outer-truncated-child-data").input.calldata, normal.slice(0, 10 + 128 * 2 + 6));
  for (const [id, tail] of [["outer-trailing-byte", "ab"], ["outer-trailing-word", "deadbeef".repeat(8)]]) {
    assert.equal(requestCase(id).input.calldata, pair + tail);
    assert.deepEqual(inspectArray(pair + tail, tail), [mint, refund]);
  }
  assert.equal(requestCase("mint-trailing-byte").input.calldata, mint + "ab");
  assert.equal(requestCase("refund-trailing-byte").input.calldata, refund + "ab");
  assert.deepEqual(inspectArray(requestCase("child-mint-trailing-byte").input.calldata), [mint + "ab", refund]);
});

test("installed and omitted child bundles distinguish known bodies, Unknown legs and top-level misses", () => {
  const mint = requestCase("mint-direct");
  const refund = requestCase("refund-direct");
  const pair = requestCase("mint-refund");
  const miss = { error_kind: "no_declarative_v3_mapper", message_includes: "no v3 mapper bridged" };
  const unknown = (calldata) => ({
    domain: "unknown", target: pair.input.to, chain: "eip155:1", calldata, value: "0x0",
  });
  for (const [name, hasMint, hasRefund, hasParent] of [
    ["parent-only", false, false, true], ["parent-mint", true, false, true],
    ["parent-refund", false, true, true], ["children-only", true, true, false],
  ]) {
    const scenario = subsets.get(name);
    assertExpected(resultById(scenario, mint.id), hasMint ? mint.expected : miss);
    assertExpected(resultById(scenario, refund.id), hasRefund ? refund.expected : miss);
    const expected = structuredClone(pair.expected);
    expected.action.body.actions = [
      hasMint ? mint.expected.action.body : unknown(mint.input.calldata),
      hasRefund ? refund.expected.action.body : unknown(refund.input.calldata),
    ];
    const diagnostics = [hasMint, hasRefund].flatMap((present, index) => present ? [] : [{
      code: "unregistered_call", path: [{ kind: "self", index }], decoder_id: null,
    }]);
    expected.decoding = { status: diagnostics.length ? "partial" : "complete", diagnostics };
    assertExpected(resultById(scenario, pair.id), hasParent ? expected : miss);
  }
  assertExpected(resultById(installed, pair.id), pair.expected);
});

test("one WASM process alternates complete, partial, malformed and unsupported results without state leakage", () => {
  for (const entry of alternating) assertExpected(resultById(installed, entry.id), entry.expected);
  assert.deepEqual(resultById(installed, alternating[0].id),
    resultById(installed, alternating.at(-1).id));
});

for (const { id, expected } of fixture.cases) {
  test(id, () => { assertExpected(resultById(installed, id), expected); });
}
