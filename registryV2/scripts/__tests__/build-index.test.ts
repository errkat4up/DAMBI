/**
 * build-index.test.ts — by-typed-data index emission (Phase A.1 Task 2)
 *
 * Exercises the REAL `scripts/build-index.ts` end-to-end via `tsx`, isolated
 * through the `BUILD_INDEX_REGISTRY_ROOT` env override (the script's
 * REGISTRY_ROOT is otherwise script-location-relative, NOT cwd-relative, so a
 * plain `cd` into a temp dir would read the real registryV2/).
 *
 * Uses Node's test runner and registryV2's existing tsx dependency:
 *
 *   cd registryV2
 *   node --import tsx --test scripts/__tests__/build-index.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// scripts/__tests__/build-index.test.ts → scripts/build-index.ts
const SCRIPTS_DIR = resolve(__dirname, "..");
const BUILD_INDEX = join(SCRIPTS_DIR, "build-index.ts");
// registryV2 root (scripts/.. ) → node_modules/.bin/tsx
const REGISTRY_V2_ROOT = resolve(SCRIPTS_DIR, "..");
const TSX_BIN = join(REGISTRY_V2_ROOT, "node_modules", ".bin", "tsx");

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const ERC20_TOKEN = "0x1111111111111111111111111111111111111111";
const ERC20_TOKEN_2 = "0x3333333333333333333333333333333333333333";
const ERC721_TOKEN = "0x2222222222222222222222222222222222222222";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Scaffold a temp registry root with manifests/, write the given manifests. */
function scaffold(manifests: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "sb-build-index-"));
  const manifestsDir = join(root, "manifests");
  mkdirSync(manifestsDir, { recursive: true });
  let i = 0;
  for (const [name, body] of Object.entries(manifests)) {
    const fname = name.endsWith(".json") ? name : `m${i}.json`;
    writeFileSync(join(manifestsDir, fname), JSON.stringify(body, null, 2), "utf8");
    i += 1;
  }
  return root;
}

/** Run the real build-index.ts against a temp REGISTRY_ROOT. Never throws. */
function runBuild(registryRoot: string, args: string[] = []): RunResult {
  try {
    const stdout = execFileSync(TSX_BIN, [BUILD_INDEX, ...args], {
      env: { ...process.env, BUILD_INDEX_REGISTRY_ROOT: registryRoot },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stdout: stdout ?? "", stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function typedDataDir(root: string): string {
  return join(root, "index", "by-typed-data");
}

function callkeyDir(root: string): string {
  return join(root, "index", "by-callkey");
}

function listTypedData(root: string): string[] {
  const dir = typedDataDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function listCallkeys(root: string): string[] {
  const dir = callkeyDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function writeToken(
  root: string,
  chainId: number,
  address: string,
  ercKind: "erc20" | "erc721" | "erc1155" | "native",
  overrides: Record<string, unknown> = {},
): void {
  const dir = join(root, "tokens", String(chainId));
  mkdirSync(dir, { recursive: true });
  const lower = address.toLowerCase();
  writeFileSync(
    join(dir, `${lower}.json`),
    JSON.stringify(
      {
        erc_kind: ercKind,
        chainId,
        address: lower,
        symbol: "TEST",
        decimals: ercKind === "erc20" ? 18 : 0,
        name: "Test Token",
        source: "https://example.invalid/test-token",
        token_kind: { kind: "unknown" },
        ...overrides,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** A Permit2-shaped manifest: vc present in every chain_to_addresses entry. */
function permit2Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "adapter_action",
    id: "uniswap/permit2/permitSingle@1.0.0",
    schema_version: "3",
    match: {
      selector: "0x2b67b570",
      chain_to_addresses: {
        "1": [PERMIT2],
        "10": [PERMIT2],
        "8453": [PERMIT2],
        "42161": [PERMIT2],
      },
      typed_data: {
        domain_name: "Permit2",
        verifying_contract: PERMIT2,
        primary_type: "PermitSingle",
        types: {
          PermitSingle: [
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
      },
    },
    emit: { strategy: "single_emit" },
    ...overrides,
  };
}

function erc20TransferManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "adapter_action",
    id: "standard/erc20/transfer@1.0.0",
    schema_version: "3",
    match: {
      selector: "0xa9059cbb",
      chain_to_addresses_source: "tokens:erc20",
      chain_ids: [1],
    },
    abi_fragment: {
      function_name: "transfer",
      abi: {
        type: "function",
        name: "transfer",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    },
    emit: { strategy: "single_emit" },
    ...overrides,
  };
}

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

function track(root: string): string {
  roots.push(root);
  return root;
}

describe("build-index by-typed-data emission", () => {
  it("(1) emits one by-typed-data entry per chain for a Permit2-shaped manifest", () => {
    const root = track(scaffold({ "permitSingle.json": permit2Manifest() }));
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    const files = listTypedData(root);
    // Order-independent: one entry per chain (emit order = chain_to_addresses
    // insertion order; listTypedData() applies its own .sort()).
    assert.deepEqual(
      [...files].sort(),
      [
        `1__${PERMIT2}__PermitSingle.json`,
        `10__${PERMIT2}__PermitSingle.json`,
        `42161__${PERMIT2}__PermitSingle.json`,
        `8453__${PERMIT2}__PermitSingle.json`,
      ].sort(),
    );

    // entry shape: matched + bundle_id + manifest_path + bundle_sha256 + bundle
    const entry = JSON.parse(readFileSync(join(typedDataDir(root), `1__${PERMIT2}__PermitSingle.json`), "utf8"));
    assert.equal(entry.matched, true);
    assert.equal(entry.bundle_id, "uniswap/permit2/permitSingle@1.0.0");
    assert.equal(entry.manifest_path, "manifests/permitSingle.json");
    assert.equal(typeof entry.bundle_sha256, "string");
    assert.equal(entry.bundle.match.typed_data.primary_type, "PermitSingle");
  });

  it("(2) escapes a colon in primaryType to '__' in the filename", () => {
    // HyperLiquid-style primary type with EIP-712 colon.
    const vc = "0x1111111111111111111111111111111111111111";
    const manifest = {
      type: "adapter_action",
      id: "hyperliquid/usd-send/usdSend@1.0.0",
      schema_version: "3",
      match: {
        selector: "0xdeadbeef",
        chain_to_addresses: { "999": [vc] },
        typed_data: {
          domain_name: "HyperliquidSignTransaction",
          verifying_contract: vc,
          primary_type: "HyperliquidTransaction:UsdSend",
          types: { "HyperliquidTransaction:UsdSend": [{ name: "destination", type: "string" }] },
        },
      },
      emit: { strategy: "single_emit" },
    };
    const root = track(scaffold({ "usdSend.json": manifest }));
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    assert.deepEqual(listTypedData(root), [`999__${vc}__HyperliquidTransaction__UsdSend.json`]);
  });

  it("(2b) rejects path-unsafe typed-data primary and witness names", () => {
    const primaryPath = permit2Manifest({
      match: {
        selector: "0x2b67b570",
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: PERMIT2,
          primary_type: "PermitSingle/../../bundles/evil",
          types: { "PermitSingle/../../bundles/evil": [{ name: "spender", type: "address" }] },
        },
      },
    });
    const rootA = track(scaffold({ "bad-primary.json": primaryPath }));
    const resA = runBuild(rootA);
    assert.notEqual(resA.status, 0);
    assert.match(resA.stderr + resA.stdout, /primary_type.*path-safe/);
    assert.deepEqual(listTypedData(rootA), []);

    const witnessPath = permit2Manifest({
      match: {
        selector: "0x30f28b7a",
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: PERMIT2,
          primary_type: "PermitWitnessTransferFrom",
          witness_type: "ExclusiveDutchOrder?x=1",
          types: {
            PermitWitnessTransferFrom: [
              { name: "witness", type: "ExclusiveDutchOrder?x=1" },
            ],
          },
        },
      },
    });
    const rootB = track(scaffold({ "bad-witness.json": witnessPath }));
    const resB = runBuild(rootB);
    assert.notEqual(resB.status, 0);
    assert.match(resB.stderr + resB.stdout, /witness_type.*path-safe/);
    assert.deepEqual(listTypedData(rootB), []);
  });

  it("(3) rejects a manifest whose typed_data.verifying_contract is absent from chain_to_addresses", () => {
    const vc = "0x2222222222222222222222222222222222222222";
    const manifest = permit2Manifest({
      match: {
        selector: "0x2b67b570",
        // vc below NOT in this map
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: vc,
          primary_type: "PermitSingle",
          types: { PermitSingle: [{ name: "spender", type: "address" }] },
        },
      },
    });
    const root = track(scaffold({ "bad.json": manifest }));
    const res = runBuild(root);

    assert.notEqual(res.status, 0);
    // Validation message is on STDERR (process.exit(1) after console.error),
    // NOT on the thrown Error.message. Assert the stderr text.
    const combined = res.stderr + res.stdout;
    assert.match(combined, /verifying_contract/);
    assert.match(combined, /not in chain_to_addresses/);
    // no entry written
    assert.deepEqual(listTypedData(root), []);
  });

  it("(5) appends witness_type as a 4th filename segment when present", () => {
    // UniswapX-style Permit2-witness manifest: same (chain, vc, primary_type)
    // as a plain Permit2 sig, disambiguated by witness_type. The 4th segment
    // keeps the by-typed-data index file distinct.
    const manifest = permit2Manifest({
      match: {
        selector: "0x30f28b7a",
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: PERMIT2,
          primary_type: "PermitWitnessTransferFrom",
          witness_type: "ExclusiveDutchOrder",
          types: {
            PermitWitnessTransferFrom: [
              { name: "spender", type: "address" },
              { name: "witness", type: "ExclusiveDutchOrder" },
            ],
          },
        },
      },
    });
    const root = track(scaffold({ "witness.json": manifest }));
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    assert.deepEqual(listTypedData(root), [
      `1__${PERMIT2}__PermitWitnessTransferFrom__ExclusiveDutchOrder.json`,
    ]);

    // descriptor round-trips witness_type into the index entry's bundle.
    const entry = JSON.parse(
      readFileSync(
        join(
          typedDataDir(root),
          `1__${PERMIT2}__PermitWitnessTransferFrom__ExclusiveDutchOrder.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(entry.bundle.match.typed_data.witness_type, "ExclusiveDutchOrder");
  });

  it("(6) without witness_type the filename stays the byte-identical 3-segment form", () => {
    // Backward compat: a typed_data block with NO witness_type produces exactly
    // the pre-T1 3-segment filename.
    const root = track(scaffold({ "permitSingle.json": permit2Manifest() }));
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    assert.ok(listTypedData(root).includes(`1__${PERMIT2}__PermitSingle.json`));
    // No 4-segment variant leaked in.
    assert.equal(listTypedData(root).some((f) => f.split("__").length > 3), false);
  });

  it("(7) two manifests colliding on (chain, vc, primary_type) but differing in witness_type both emit (no overwrite)", () => {
    const manifestA = permit2Manifest({
      id: "uniswapx/test/orderA@1.0.0",
      match: {
        selector: "0x00000001",
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: PERMIT2,
          primary_type: "PermitWitnessTransferFrom",
          witness_type: "OrderA",
          types: {
            PermitWitnessTransferFrom: [{ name: "witness", type: "OrderA" }],
          },
        },
      },
    });
    const manifestB = permit2Manifest({
      id: "uniswapx/test/orderB@1.0.0",
      match: {
        selector: "0x00000002",
        chain_to_addresses: { "1": [PERMIT2] },
        typed_data: {
          domain_name: "Permit2",
          verifying_contract: PERMIT2,
          primary_type: "PermitWitnessTransferFrom",
          witness_type: "OrderB",
          types: {
            PermitWitnessTransferFrom: [{ name: "witness", type: "OrderB" }],
          },
        },
      },
    });
    const root = track(
      scaffold({ "orderA.json": manifestA, "orderB.json": manifestB }),
    );
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    assert.deepEqual(
      [...listTypedData(root)].sort(),
      [
        `1__${PERMIT2}__PermitWitnessTransferFrom__OrderA.json`,
        `1__${PERMIT2}__PermitWitnessTransferFrom__OrderB.json`,
      ].sort(),
    );
  });

  it("(8) rejects duplicate typed-data keys before overwrite", () => {
    const manifestA = permit2Manifest({ id: "uniswap/permit2/a@1.0.0" });
    const manifestB = permit2Manifest({ id: "uniswap/permit2/b@1.0.0" });
    const root = track(scaffold({ "a.json": manifestA, "b.json": manifestB }));
    const res = runBuild(root);

    assert.notEqual(res.status, 0);
    const combined = res.stderr + res.stdout;
    assert.match(combined, /duplicate typed-data index key/);
    assert.match(combined, /PermitSingle/);
  });

  it("(4) emits NO by-typed-data entry when a manifest has no typed_data", () => {
    const plain = {
      type: "adapter_action",
      id: "uniswap/v2-router-02/swap@1.0.0",
      schema_version: "3",
      match: {
        selector: "0x38ed1739",
        chain_to_addresses: { "1": ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d"] },
      },
      emit: { strategy: "single_emit" },
    };
    const root = track(scaffold({ "swap.json": plain }));
    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    // by-typed-data dir is created (wiped) but empty; by-callkey has the entry.
    assert.deepEqual(listTypedData(root), []);
    assert.equal(listCallkeys(root).length, 1);
  });
});

describe("build-index strict concrete callkey ownership", () => {
  it("rejects different bundle content at the same callkeys, even with the same bundle ID", () => {
    const manifest = erc20TransferManifest({
      match: {
        selector: "0xa9059cbb",
        chain_to_addresses: { "1": [ERC20_TOKEN, ERC20_TOKEN_2] },
      },
    });
    const root = track(scaffold({
      "a.json": manifest,
      "b.json": { ...manifest, emit: { strategy: "single_emit", body: { amount: "$args.amount" } } },
    }));

    const res = runBuild(root, ["--strict-callkeys"]);
    assert.notEqual(res.status, 0);
    const combined = res.stderr + res.stdout;
    assert.match(combined, /STRICT_CALLKEYS FAILED — 2 concrete callkey collision\(s\)/);
    for (const address of [ERC20_TOKEN, ERC20_TOKEN_2]) {
      assert.ok(combined.includes(`callkey collision: 1__${address}__0xa9059cbb.json`));
    }
    assert.ok(combined.includes("both manifests/a.json and manifests/b.json with different bundles"));
    assert.ok(!combined.includes("identical bundle"));
    // The CLI may have written partial files while collecting all collisions.
    // A nonzero exit is never a successful artifact, regardless of those files.
    assert.ok(!combined.includes("[build-index] done"));
  });

  it("accepts identical JCS bundle digests from distinct source files and keeps the first", () => {
    const manifest = erc20TransferManifest({
      match: {
        selector: "0xa9059cbb",
        chain_to_addresses: { "1": [ERC20_TOKEN] },
      },
    });
    // Different original bytes/property order still describe the same bundle.
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    const root = track(scaffold({ "a.json": manifest, "b.json": reordered }));
    assert.notEqual(
      readFileSync(join(root, "manifests/a.json"), "utf8"),
      readFileSync(join(root, "manifests/b.json"), "utf8"),
    );

    const res = runBuild(root, ["--strict-callkeys"]);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    const combined = res.stderr + res.stdout;
    assert.ok(combined.includes("identical bundle"));
    assert.doesNotMatch(combined, /callkey collision:|STRICT_CALLKEYS FAILED/);
    assert.deepEqual(listCallkeys(root), [`1__${ERC20_TOKEN}__0xa9059cbb.json`]);
    const entry = JSON.parse(
      readFileSync(join(callkeyDir(root), `1__${ERC20_TOKEN}__0xa9059cbb.json`), "utf8"),
    );
    assert.equal(entry.manifest_path, "manifests/a.json");
    assert.deepEqual(entry.bundle, manifest);
  });
});

describe("build-index token source expansion", () => {
  it("rejects sourced typed-data manifests instead of silently dropping typed-data routes", () => {
    const manifest = erc20TransferManifest({
      match: {
        selector: "0xd505accf",
        chain_to_addresses_source: "tokens:erc20",
        chain_ids: [1],
        typed_data: {
          domain_name: "USD Coin",
          verifying_contract: ERC20_TOKEN,
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
        },
      },
    });
    const root = track(scaffold({ "sourced-permit.json": manifest }));
    writeToken(root, 1, ERC20_TOKEN, "erc20", { symbol: "USDC" });

    const res = runBuild(root);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr + res.stdout, /chain_to_addresses_source \+ typed_data is unsupported/);
    assert.deepEqual(listTypedData(root), []);
  });

  it("expands tokens:erc20 into concrete callkeys backed by a shared bundle ref", () => {
    const root = track(scaffold({ "transfer.json": erc20TransferManifest() }));
    writeToken(root, 1, ERC20_TOKEN, "erc20", { symbol: "T20" });
    writeToken(root, 1, ERC721_TOKEN, "erc721", { symbol: "NFT" });

    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

    assert.deepEqual(listCallkeys(root), [`1__${ERC20_TOKEN}__0xa9059cbb.json`]);

    const entry = JSON.parse(
      readFileSync(join(callkeyDir(root), `1__${ERC20_TOKEN}__0xa9059cbb.json`), "utf8"),
    );
    assert.equal(entry.schema_version, "3-ref");
    assert.match(entry.bundle_ref, /^bundles\/0x[0-9a-f]{64}\.json$/);
    assert.equal(entry.context_ref, undefined);
    assert.equal(entry.bundle, undefined);
    const bundle = JSON.parse(readFileSync(join(root, entry.bundle_ref), "utf8"));
    assert.deepEqual(bundle.match.chain_to_addresses, { "1": [ERC20_TOKEN] });
    assert.equal("chain_to_addresses_source" in bundle.match, false);
    assert.equal("chain_ids" in bundle.match, false);
  });

  for (const order of ["source-first", "concrete-first"]) {
    it(`prunes concrete-owned callkeys out of sourced bundle fan-out in strict mode (${order})`, () => {
      const concreteTransfer = erc20TransferManifest({
        id: "compound-v3/comet/transfer@1.0.0",
        match: {
          selector: "0xa9059cbb",
          chain_to_addresses: { "1": [ERC20_TOKEN] },
        },
      });
      const root = track(
        scaffold({
          [order === "source-first" ? "a-standard-transfer.json" : "z-standard-transfer.json"]: erc20TransferManifest(),
          [order === "concrete-first" ? "a-compound-transfer.json" : "z-compound-transfer.json"]: concreteTransfer,
        }),
      );
      writeToken(root, 1, ERC20_TOKEN, "erc20", { symbol: "C20" });
      writeToken(root, 1, ERC20_TOKEN_2, "erc20", { symbol: "T20" });

      const res = runBuild(root, ["--strict-callkeys"]);
      assert.equal(res.status, 0, `stderr:\n${res.stderr}`);

      assert.deepEqual(
        [...listCallkeys(root)].sort(),
        [
          `1__${ERC20_TOKEN}__0xa9059cbb.json`,
          `1__${ERC20_TOKEN_2}__0xa9059cbb.json`,
        ].sort(),
      );

      const concreteEntry = JSON.parse(
        readFileSync(join(callkeyDir(root), `1__${ERC20_TOKEN}__0xa9059cbb.json`), "utf8"),
      );
      assert.equal(concreteEntry.bundle_id, "compound-v3/comet/transfer@1.0.0");

      const sourcedEntry = JSON.parse(
        readFileSync(join(callkeyDir(root), `1__${ERC20_TOKEN_2}__0xa9059cbb.json`), "utf8"),
      );
      assert.equal(sourcedEntry.schema_version, "3-ref");
      const sourcedBundle = JSON.parse(readFileSync(join(root, sourcedEntry.bundle_ref), "utf8"));
      assert.deepEqual(sourcedBundle.match.chain_to_addresses, {
        "1": [ERC20_TOKEN_2],
      });
    });
  }

  it("rejects tokens:erc20 when the requested chain has no token directory", () => {
    const root = track(scaffold({ "transfer.json": erc20TransferManifest() }));
    const res = runBuild(root);

    assert.notEqual(res.status, 0);
    const combined = res.stderr + res.stdout;
    assert.match(combined, /tokens\/1\/ does not exist/);
  });

  it("rejects token metadata whose chainId disagrees with its directory", () => {
    const root = track(scaffold({ "transfer.json": erc20TransferManifest() }));
    writeToken(root, 1, ERC20_TOKEN, "erc20", { chainId: 8453 });

    const res = runBuild(root);
    assert.notEqual(res.status, 0);
    const combined = res.stderr + res.stdout;
    assert.match(combined, /chainId field \(8453\) does not match directory \(1\)/);
  });
});

describe("build-index protocol source materialization", () => {
  it("emits a small route entry plus template/context refs for a sourced Curve pool", () => {
    const pool = "0x3333333333333333333333333333333333333333";
    const coin0 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const coin1 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const root = track(
      scaffold({
        "curve-source.json": {
          type: "adapter_action",
          id: "curve/stableswap-ng/source/test/exchange@1.0.0",
          schema_version: "3",
          match: {
            selector: "0x3df02124",
            chain_to_addresses_source: "curve:factory_stable_ng_2coin_mainnet",
            chain_ids: [1],
          },
          source_materialize: { kind: "per_address_context" },
          abi_fragment: {
            function_name: "exchange",
            abi: {
              type: "function",
              name: "exchange",
              inputs: [
                { name: "i", type: "int128" },
                { name: "j", type: "int128" },
                { name: "_dx", type: "uint256" },
                { name: "_min_dy", type: "uint256" },
              ],
            },
          },
          emit: {
            strategy: "single_emit",
            body: {
              token_in: {
                $match: "$args.i",
                $cases: {
                  "0": "$source.coins.0",
                  "1": "$source.coins.1",
                },
              },
            },
          },
        },
      }),
    );
    const surfaceDir = join(root, "surface", "curve");
    mkdirSync(surfaceDir, { recursive: true });
    writeFileSync(
      join(surfaceDir, "_pool_universe.json"),
      JSON.stringify(
        {
          protocol: "curve",
          source: "test",
          source_count: 1,
          candidates: [
            {
              chainId: 1,
              address: pool,
              decision: "cover",
              reason: "test",
              batch: "test",
              families: ["factory-stable-ng"],
              curve_id: "factory-stable-ng-0",
              name: "Test Pool",
              symbol: "TEST",
              lpTokenAddress: pool,
              coins: [coin0, coin1],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const res = runBuild(root);
    assert.equal(res.status, 0, `stderr:\n${res.stderr}`);
    assert.deepEqual(listCallkeys(root), [`1__${pool}__0x3df02124.json`]);

    const entry = JSON.parse(
      readFileSync(join(callkeyDir(root), `1__${pool}__0x3df02124.json`), "utf8"),
    );
    assert.equal(entry.schema_version, "3-ref");
    assert.match(entry.bundle_id, /^curve\/stableswap-ng\/source\/test\/exchange\/1-factory-stable-ng-0-33333333@1\.0\.0$/);
    assert.match(entry.bundle_ref, /^bundles\/0x[0-9a-f]{64}\.json$/);
    assert.equal(entry.context_ref, `contexts/curve/factory_stable_ng_2coin_mainnet/1/${pool}.json`);
    assert.equal(entry.bundle, undefined);

    const template = JSON.parse(readFileSync(join(root, entry.bundle_ref), "utf8"));
    assert.equal(template.match.chain_to_addresses_source, "curve:factory_stable_ng_2coin_mainnet");
    assert.deepEqual(template.source_materialize, { kind: "per_address_context" });
    assert.deepEqual(template.emit.body.token_in.$cases, {
      "0": "$source.coins.0",
      "1": "$source.coins.1",
    });

    const context = JSON.parse(readFileSync(join(root, entry.context_ref), "utf8"));
    assert.equal(context.schema_version, "3-source-context");
    assert.equal(context.chain_id, 1);
    assert.equal(context.address, pool);
    assert.deepEqual(context.context.coins, [coin0, coin1]);
    assert.equal(context.context.id_suffix, "1-factory-stable-ng-0-33333333");
  });
});

describe("manifest live-input regressions", () => {
  function manifestJsonFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...manifestJsonFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(full);
      }
    }
    return files;
  }

  function collectPoolMetaResources(
    value: unknown,
    out: { file: string; path: string; resource: Record<string, unknown> }[],
    file: string,
    pathParts: string[] = [],
  ): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const source = record.source as Record<string, unknown> | undefined;
    const resource = source?.resource as Record<string, unknown> | undefined;
    if (source?.kind === "registry_api" && resource?.kind === "pool_meta") {
      out.push({ file, path: pathParts.join("."), resource });
    }
    for (const [key, child] of Object.entries(record)) {
      collectPoolMetaResources(child, out, file, [...pathParts, key]);
    }
  }

  it("does not send any registry_api pool_meta lookup to the zero address", () => {
    const poolMeta: { file: string; path: string; resource: Record<string, unknown> }[] = [];
    for (const file of manifestJsonFiles(join(REGISTRY_V2_ROOT, "manifests"))) {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      collectPoolMetaResources(manifest, poolMeta, file);
    }

    assert.ok(poolMeta.length >= 5);
    for (const entry of poolMeta) {
      assert.notEqual(entry.resource.pool_addr, "0x0000000000000000000000000000000000000000", `${entry.file}:${entry.path}`);
    }
  });

  it("does not send Balancer V2 pool_meta lookups to the zero address", () => {
    const manifestPaths = [
      "manifests/balancer/v2/vault-swap@1.0.0.json",
      "manifests/balancer/v2/vault-batch-swap@1.0.0.json",
    ];

    for (const rel of manifestPaths) {
      const manifest = JSON.parse(readFileSync(join(REGISTRY_V2_ROOT, rel), "utf8"));
      const poolMeta: { file: string; path: string; resource: Record<string, unknown> }[] = [];
      collectPoolMetaResources(manifest, poolMeta, rel);

      assert.ok(poolMeta.length >= 1, rel);
      for (const entry of poolMeta) {
        const poolAddr = entry.resource.pool_addr as Record<string, unknown> | string | undefined;
        assert.notEqual(poolAddr, "0x0000000000000000000000000000000000000000", `${rel}:${entry.path}`);
        assert.equal((poolAddr as Record<string, unknown> | undefined)?.$fn, "balancer_pool_id_to_address", `${rel}:${entry.path}`);
      }
    }
  });
});
