import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readJson, repoRoot, resolveIndexBundle } from "./helpers/build-registry.mjs";
import { buildHandoffRegistry } from "./helpers/handoff.mjs";

const execFileAsync = promisify(execFile);
const selection = await readJson(new URL("./registry-selection.json", import.meta.url));
const fixture = await readJson(new URL("./approve.cases.json", import.meta.url));
const decoderId = "standard/erc20/approve@1.0.0";
const policyId = "unlimited-approval-deny";
const ordinarySpender = "0x00000000000000000000000000000000deadbeef";
// Independently pinned, then checked against the actual Cedar allowlist below.
const permit2Spender = "0x000000000022d473030f116ddee9f6b43ac78ba3";
// Temporary pre-D3 baseline input; this is not the final SDK dependency path.
const policyDirectory = join(repoRoot,
  "browser-extension/default-bundles/day1-safety/policies", policyId);

// Expectations come from the policy's two exact sentinel comparisons and
// independent raw-calldata analysis, never from an evaluated verdict/Action.
const cases = [
  { id: "amount-zero", amount: 0n, verdict: "pass" },
  { id: "amount-normal", amount: 1_000_000n, verdict: "pass" },
  { id: "amount-uint160-max", amount: (1n << 160n) - 1n, verdict: "warn" },
  { id: "amount-uint256-max", amount: (1n << 256n) - 1n, verdict: "warn" },
  { id: "amount-uint256-max-minus-one", amount: (1n << 256n) - 2n, verdict: "pass" },
  { id: "permit2-uint160-max", sourceId: "amount-uint160-max", amount: (1n << 160n) - 1n, verdict: "pass", permit2: true },
  { id: "permit2-uint256-max", sourceId: "amount-uint256-max", amount: (1n << 256n) - 1n, verdict: "pass", permit2: true },
];
let registry;
let scenario;
let requests;

function requestForCase({ id, sourceId = id, amount, permit2 }) {
  // Only input/defaults are used; DEC-01's expected Action is not an eval input.
  const source = fixture.cases.find((entry) => entry.id === sourceId);
  assert.ok(source, `Missing DEC-01 calldata: ${sourceId}`);
  const input = { ...fixture.defaults, ...source.input };
  assert.equal(input.chain_id, 1, "DEC-02 only needs one chain's policy cases");
  assert.equal(input.selector, "0x095ea7b3");
  assert.match(input.calldata, /^0x095ea7b3[0-9a-f]{128}$/);
  assert.equal(input.calldata.slice(10, 74), ordinarySpender.slice(2).padStart(64, "0"));
  assert.equal(BigInt(`0x${input.calldata.slice(74)}`), amount, id);
  if (permit2) {
    // Replace the original ABI spender word BEFORE decoding. Keep selector and
    // amount bytes intact; no already-decoded Action is ever patched.
    input.calldata = `${input.calldata.slice(0, 10)}${permit2Spender.slice(2).padStart(64, "0")}${input.calldata.slice(74)}`;
    assert.equal(input.calldata.slice(0, 10), source.input.calldata.slice(0, 10));
    assert.equal(input.calldata.slice(74), source.input.calldata.slice(74));
  }
  return { id, input };
}

before(async () => {
  // Missing prerequisites fail; this test never builds WASM or skips cases.
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch(() => {
      throw new Error(`Missing ${name}; build the legacy WASM first (see README.md).`);
    });
  }
  const policy = await readFile(join(policyDirectory, "policy.cedar"), "utf8");
  const manifest = await readJson(join(policyDirectory, "manifest.json"));
  assert.equal(manifest.id, policyId);
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(manifest.trigger, { where: { "action.tag": { eq: "erc20_approve" } } });
  assert.match(policy, /@id\("unlimited-approval-deny"\)/);
  assert.match(policy, /@severity\("warn"\)/);
  assert.ok(policy.includes(`["${permit2Spender}"].contains(context.spender)`),
    "Review the pinned Permit2 address against the actual Cedar allowlist");
  requests = cases.map(requestForCase);

  // Reuse DEC-01's actual builder and digest-checked resolved bundle, without
  // duplicating its four-chain/index/negative-decode assertions.
  assert.equal(fixture.registry_source, selection.manifest.path);
  registry = await buildHandoffRegistry(selection, "approve-policy");
  const { input } = requests[0];
  const entry = await readJson(join(registry.root, "index/by-callkey",
    `${input.chain_id}__${input.to}__${input.selector}.json`));
  const bundle = await resolveIndexBundle(registry.root, entry);
  assert.equal(bundle.id, decoderId);
  const path = join(registry.root, "approve-policy.json");
  await writeFile(path, JSON.stringify({ handoff: { suite: "approve-policy", scenario: "approve-policy" }, bundles: [bundle], requests, policyBundle: { policy, manifest } }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./helpers/wasm-worker.mjs", import.meta.url)), path,
    ], { cwd: repoRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    scenario = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`DEC-02 WASM policy scenario failed.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
  }
  assert.equal(scenario.installations.length, 1);
  assert.equal(scenario.installations[0].ok, true);
  assert.deepEqual(scenario.installations[0].data, { decoder_id: decoderId, bundle_id: decoderId });
  assert.deepEqual(scenario.results.map(({ id }) => id), cases.map(({ id }) => id));
}, { timeout: 200_000 });

after(async () => {
  await registry?.cleanup();
});

for (const { id, amount, verdict, permit2 } of cases) {
  test(`${id}: decoded approve -> ${policyId} -> ${verdict}`, () => {
    const { result, plan, evaluation } = scenario.results.find((entry) => entry.id === id);
    const { input } = requests.find((entry) => entry.id === id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.error, null);
    assert.equal(result.data.decoder_id, decoderId);
    assert.equal(result.data.actions.length, 1);
    const decoded = result.data.actions[0];
    assert.equal(decoded.body.domain, "token");
    assert.equal(decoded.body.action, "erc20_approve");
    assert.equal(decoded.body.token.key.chain, `eip155:${input.chain_id}`);
    assert.equal(decoded.body.token.key.address, input.to);
    assert.equal(decoded.meta.submitter, input.submitter);
    assert.equal(decoded.body.spender, permit2 ? permit2Spender : ordinarySpender);
    assert.equal(typeof decoded.body.amount, "string");
    assert.equal(BigInt(decoded.body.amount), amount);

    // Static policy: successful lowering/planning requires no external Facts.
    assert.deepEqual(plan, { ok: true, data: { planned: [] }, error: null });
    assert.equal(evaluation.ok, true, JSON.stringify(evaluation));
    assert.equal(evaluation.error, null);
    const actual = evaluation.data.verdict;
    assert.ok(["pass", "warn", "fail"].includes(actual.kind), "Use the actual VerdictDto kinds");
    // Exact matched DTO excludes __engine::*, quarantine, __system__, schema
    // errors and extra matches. `ok: true` or `kind: warn` alone is insufficient.
    assert.deepEqual(actual, verdict === "pass" ? { kind: "pass" } : {
      kind: "warn",
      matched: [{ policy_id: policyId, reason: null, severity: "warn", origin: "action" }],
    });
  });
}
