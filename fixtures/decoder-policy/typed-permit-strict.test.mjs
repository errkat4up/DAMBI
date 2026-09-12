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
const fixture = await readJson(new URL("./typed-permit-strict.cases.json", import.meta.url));
const legacy = await readJson(new URL("./typed-permit.cases.json", import.meta.url));
const permitId = "standard/erc20/permit@1.0.0";
const usdc = legacy.defaults.verifying_contract;
const groupCounts = {
  normal: 20, input_error: 49, message_error: 46, domain_error: 8,
  time_range: 5, consistency: 1, routing_error: 9, routing_miss: 5,
  precedence: 5, types_error: 12, preservation: 3,
};
let registry;
let permitBundle;
let typedEntry;
let installed;
let empty;
let approveOnly;
let legacyInstalled;

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
  }
  return value;
}

function requestCase(entry) {
  let input = structuredClone(fixture.defaults);
  for (const [path, value] of Object.entries(entry.set ?? {})) {
    const parts = path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((current, part) => current[part] ??= {}, input);
    parent[key] = structuredClone(value);
  }
  for (const path of entry.omit ?? []) {
    const parts = path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((current, part) => current[part], input);
    assert.ok(Object.hasOwn(parent, key), `Omission must remove an existing field: ${entry.id}: ${path}`);
    delete parent[key];
  }
  if (entry.reverse_object_keys) input = reverseObjectKeys(input);
  if (entry.typed_data_encoding === "json") input.typed_data = JSON.stringify(input.typed_data, null, 2);
  assert.equal(Object.hasOwn(input, "calldata"), false);
  return { id: entry.id, kind: "typed_strict", input };
}

function byId(id) {
  const entry = fixture.cases.find((entry) => entry.id === id);
  assert.ok(entry, id);
  return entry;
}

async function runScenario(name, bundles, requests) {
  const path = join(registry.root, `${name}.json`);
  await writeFile(path, JSON.stringify({ handoff: { suite: "typed-permit-strict", scenario: name }, bundles, requests }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const output = JSON.parse(stdout);
    assert.deepEqual(output.results.map(({ id }) => id), requests.map(({ id }) => id));
    return output;
  } catch (error) {
    throw new Error(`Strict WASM scenario ${name} failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
}

before(async () => {
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; build the paired JS/WASM from the DEC-04b Rust source (see README.md).`);
    });
  }
  registry = await buildHandoffRegistry(selection, "typed-permit-strict");
  assert.equal(fixture.registry_source, selection.permit_manifest.path);
  const callkeyDir = join(registry.root, "index/by-callkey");
  const typedDir = join(registry.root, "index/by-typed-data");
  assert.equal((await readdir(callkeyDir)).length, 5);
  assert.deepEqual(await readdir(typedDir), [`1__${usdc}__Permit.json`]);
  typedEntry = await readJson(join(typedDir, `1__${usdc}__Permit.json`));
  permitBundle = await resolveIndexBundle(registry.root, typedEntry);
  assert.deepEqual(permitBundle, registry.permitSource);
  const approveEntry = await readJson(join(callkeyDir, `1__${usdc}__0x095ea7b3.json`));
  const approveBundle = await resolveIndexBundle(registry.root, approveEntry);
  const normal = requestCase(byId("full-normal"));
  const missingOwnerLegacy = structuredClone(legacy.defaults);
  delete missingOwnerLegacy.message.owner;
  // Installation is process-local. Even the legacy comparison uses a
  // different WASM process from the strict requests, with the same bundles.
  const scenarios = await Promise.allSettled([
    runScenario("strict-installed", [approveBundle, permitBundle], fixture.cases.map(requestCase)),
    runScenario("strict-empty", [], [normal]),
    runScenario("strict-approve-only", [approveBundle], [normal]),
    runScenario("strict-v3-compatibility", [approveBundle, permitBundle], [
      { id: "legacy-normal", kind: "typed", input: legacy.defaults },
      { id: "legacy-missing-owner", kind: "typed", input: missingOwnerLegacy },
    ]),
  ]);
  const failures = scenarios.filter(({ status }) => status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "Strict WASM scenarios failed");
  [installed, empty, approveOnly, legacyInstalled] = scenarios.map(({ value }) => value);
}, { timeout: 200_000 });

after(async () => { await registry?.cleanup(); });

function resultById(scenario, id) {
  const entry = scenario.results.find((entry) => entry.id === id);
  assert.ok(entry, id);
  return entry.result;
}

function assertFailure(actual, expected) {
  assert.equal(actual.ok, false, JSON.stringify(actual));
  assert.equal(actual.data, null);
  assert.equal(actual.error.kind, expected.error_kind);
  assert.equal(typeof actual.error.message, "string");
  assert.ok(actual.error.message.length > 0);
  if (expected.error_path) assert.equal(actual.error.path, expected.error_path);
  if (expected.error_kind === "no_typed_data_mapper") {
    assert.match(actual.error.message, /detailed validation not performed/i);
  }
}

function assertPermit(actual, entry) {
  const { input } = requestCase(entry);
  const original = structuredClone(input);
  if (typeof original.typed_data === "string") {
    original.typed_data_json = original.typed_data;
    original.typed_data = JSON.parse(original.typed_data);
  }
  const { domain, message } = original.typed_data;
  const deadlineInteger = BigInt(message.deadline);
  assert.ok(deadlineInteger >= 0n && deadlineInteger <= 9_007_199_254_740_991n);
  const deadline = Number(deadlineInteger);
  const owner = message.owner.toLowerCase();
  const requestedSigner = input.requested_signer.toLowerCase();
  const submitter = (input.submitter ?? input.requested_signer).toLowerCase();
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.error, null);
  assert.deepEqual(Object.keys(actual.data).sort(), ["actions", "decoder_id", "request"]);
  assert.equal(actual.data.decoder_id, permitId);
  const body = structuredClone(legacy.expected_permit.body);
  body.spender = message.spender.toLowerCase();
  body.amount = entry.expected.amount ?? "0xf4240";
  assert.equal(BigInt(body.amount), BigInt(message.value), "Fixed expected amount must independently match input quantity");
  body.deadline = deadline;
  body.nonce.synced_at = input.submitted_at;
  const meta = structuredClone(legacy.expected_permit.meta);
  meta.submitted_at = input.submitted_at;
  meta.submitter = submitter;
  meta.nature.deadline = deadline;
  for (const key of ["version", "salt"]) {
    if (Object.hasOwn(domain, key)) meta.nature.domain[key] = domain[key];
  }
  assert.deepEqual(actual.data.actions, [{ body, meta }]);
  assert.deepEqual(actual.data.request, {
    original,
    routing: { chain_id: 1, verifying_contract: usdc, primary_type: "Permit" },
    validated: {
      owner, requested_signer: requestedSigner, submitter,
      signed_nonce: entry.expected.signed_nonce ?? "7",
      deadline_seconds: BigInt(message.deadline).toString(10),
    },
    validation: { signature_verification: "not_performed" },
  });
  assert.equal(actual.data.actions[0].body.nonce.value, "0x0", "Live nonce is an unqueried stub, not the signed nonce");
  assert.equal(Object.hasOwn(actual.data.actions[0].body, "owner"), false);
  assert.equal(owner, requestedSigner, "Address equality checks request consistency only");
  assert.ok(Number.isSafeInteger(actual.data.actions[0].body.deadline));
  assert.equal(actual.data.actions[0].body.deadline, actual.data.actions[0].meta.nature.deadline);
}

test("strict fixture uses the real unchanged permit typed index and verified JCS bundle", () => {
  assert.equal(typedEntry.bundle_id, permitId);
  assert.equal(typedEntry.manifest_path, selection.permit_manifest.path);
  assert.equal(typedEntry.bundle_ref, undefined);
  assert.deepEqual(permitBundle.match.typed_data.types, fixture.defaults.typed_data.types);
  assert.deepEqual(installed.installations.map(({ data }) => data.decoder_id), ["standard/erc20/approve@1.0.0", permitId]);
});

test("strict request matrix preserves required boundaries and the independent 47-case legacy baseline", () => {
  assert.equal(fixture.cases.length, 163);
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, 163);
  assert.deepEqual(Object.fromEntries(Object.keys(groupCounts).map(
    (group) => [group, fixture.cases.filter((entry) => entry.group === group).length],
  )), groupCounts);
  assert.equal(legacy.cases.length, 44);
  assert.notEqual(fixture.defaults.requested_signer, fixture.defaults.submitter);
  assert.equal(BigInt(byId("value-and-nonce-uint256-max").set["typed_data.message.value"]), (1n << 256n) - 1n);
  assert.equal(BigInt(byId("deadline-uint256-overflow").set["typed_data.message.deadline"]), 1n << 256n);
});

test("strict installation misses are isolated and never treated as validated input", () => {
  assert.equal(empty.installations.length, 0);
  assert.equal(approveOnly.installations.length, 1);
  for (const scenario of [empty, approveOnly]) {
    assertFailure(resultById(scenario, "full-normal"), { error_kind: "no_typed_data_mapper" });
  }
});

test("JSON-string and reordered object inputs retain original context and emit identical actions", () => {
  const normal = resultById(installed, "full-normal").data;
  for (const id of ["full-json-string", "full-object-key-order"]) {
    const actual = resultById(installed, id).data;
    assert.deepEqual(actual.actions, normal.actions);
    assert.deepEqual(actual.request.routing, normal.request.routing);
    assert.deepEqual(actual.request.validated, normal.request.validated);
  }
  assert.equal(resultById(installed, "full-json-string").data.request.original.typed_data_json,
    requestCase(byId("full-json-string")).input.typed_data);
});

test("v3 retains its legacy missing-owner success while v4 rejects it without fallback", () => {
  for (const id of ["legacy-normal", "legacy-missing-owner"]) {
    const actual = resultById(legacyInstalled, id);
    assert.deepEqual(actual, {
      ok: true, data: { actions: [{ body: legacy.expected_permit.body, meta: legacy.expected_permit.meta }], decoder_id: permitId }, error: null,
    });
  }
  assertFailure(resultById(installed, "owner-missing"), byId("owner-missing").expected);
  assertFailure(resultById(installed, "owner-requested-signer-mismatch"), byId("owner-requested-signer-mismatch").expected);
  assertFailure(resultById(installed, "unregistered-contract-malformed-owner"), byId("unregistered-contract-malformed-owner").expected);
});

for (const entry of fixture.cases) {
  test(`strict ${entry.group}: ${entry.id}`, () => {
    const actual = resultById(installed, entry.id);
    if (entry.expected.error_kind) assertFailure(actual, entry.expected);
    else assertPermit(actual, entry);
  });
}
