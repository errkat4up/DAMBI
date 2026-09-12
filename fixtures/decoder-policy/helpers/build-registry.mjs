import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const registryRoot = join(repoRoot, "registryV2");
const execFileAsync = promisify(execFile);

export function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function inside(root, relativePath) {
  assert.equal(typeof relativePath, "string");
  const path = resolve(root, relativePath);
  assert.ok(path.startsWith(`${resolve(root)}${sep}`), `Path escapes registry: ${relativePath}`);
  return path;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Copies the checked original bytes, never a rewritten source manifest.
async function copyPinnedFile(root, selected) {
  const bytes = await readFile(inside(registryRoot, selected.path));
  assert.equal(sha256(bytes), selected.sha256, `Source changed: ${selected.path}`);
  const target = inside(root, selected.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return JSON.parse(bytes.toString("utf8"));
}

// Existing callers remain approve-only; later fixtures explicitly opt in.
export async function buildRegistry(selection, {
  includeTransfer = false, includePermit = false, includePermit2Single = false,
  includePermit2Batch = false, includeNfpmSelf = false,
} = {}) {
  assert.equal(typeof includeTransfer, "boolean");
  assert.equal(typeof includePermit, "boolean");
  assert.equal(typeof includePermit2Single, "boolean");
  assert.equal(typeof includePermit2Batch, "boolean");
  assert.equal(typeof includeNfpmSelf, "boolean");
  const tsx = join(registryRoot, "node_modules/.bin/tsx");
  await access(tsx).catch(() => {
    throw new Error("Registry dependencies missing; run npm ci --prefix registryV2 first.");
  });
  const root = await mkdtemp(join(tmpdir(), "dambi-dec-01-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const source = await copyPinnedFile(root, selection.manifest);
    assert.equal(source.id, "standard/erc20/approve@1.0.0");
    assert.equal(source.match.chain_to_addresses_source, "tokens:erc20");
    assert.deepEqual(source.match.chain_ids, [1, 10, 8453, 42161]);
    let transferSource;
    if (includeTransfer) {
      transferSource = await copyPinnedFile(root, selection.transfer_manifest);
      assert.equal(transferSource.id, "standard/erc20/transfer@1.0.0");
      assert.equal(transferSource.match.selector, "0xa9059cbb");
      assert.equal(transferSource.match.chain_to_addresses_source, "tokens:erc20");
      assert.deepEqual(transferSource.match.chain_ids, source.match.chain_ids);
    }
    let permitSource;
    if (includePermit) {
      permitSource = await copyPinnedFile(root, selection.permit_manifest);
      assert.equal(permitSource.id, "standard/erc20/permit@1.0.0");
      assert.equal(permitSource.match.selector, "0xd505accf");
      assert.equal(permitSource.match.chain_to_addresses_source, undefined);
      assert.equal(permitSource.match.chain_ids, undefined);
      assert.deepEqual(permitSource.match.chain_to_addresses, {
        "1": ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
      });
      assert.deepEqual(permitSource.match.typed_data, {
        domain_name: "USD Coin",
        verifying_contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
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
    }
    let permit2SingleSource;
    if (includePermit2Single) {
      permit2SingleSource = await copyPinnedFile(root, selection.permit2_single_manifest);
      assert.equal(permit2SingleSource.id, "uniswap/permit2/permitSingle@1.0.0");
      assert.equal(permit2SingleSource.match.selector, "0x2b67b570");
      // Permit2 has concrete deployment addresses; token files only expand the
      // existing approve/transfer manifests, never this typed-data registry.
      assert.equal(permit2SingleSource.match.chain_to_addresses_source, undefined);
      assert.equal(permit2SingleSource.match.chain_ids, undefined);
      const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
      assert.deepEqual(permit2SingleSource.match.chain_to_addresses, {
        "1": [permit2], "10": [permit2], "8453": [permit2], "42161": [permit2],
      });
      assert.deepEqual(permit2SingleSource.match.typed_data, {
        domain_name: "Permit2",
        verifying_contract: permit2,
        primary_type: "PermitSingle",
        types: {
          PermitSingle: [
            { name: "details", type: "PermitDetails" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
          PermitDetails: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
          ],
        },
      });
    }
    let permit2BatchSource;
    if (includePermit2Batch) {
      permit2BatchSource = await copyPinnedFile(root, selection.permit2_batch_manifest);
      assert.equal(permit2BatchSource.id, "uniswap/permit2/permitBatch@1.0.0");
      assert.equal(permit2BatchSource.match.selector, "0x2a2d80d1");
      assert.equal(permit2BatchSource.match.chain_to_addresses_source, undefined);
      assert.equal(permit2BatchSource.match.chain_ids, undefined);
      const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
      assert.deepEqual(permit2BatchSource.match.chain_to_addresses, {
        "1": [permit2], "10": [permit2], "8453": [permit2], "42161": [permit2],
      });
      assert.deepEqual(permit2BatchSource.match.typed_data, {
        domain_name: "Permit2",
        verifying_contract: permit2,
        primary_type: "PermitBatch",
        types: {
          PermitBatch: [
            { name: "details", type: "PermitDetails[]" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
          PermitDetails: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
          ],
        },
      });
    }
    const nfpmSources = {};
    if (includeNfpmSelf) {
      for (const [key, selected, id, selector] of [
        ["nfpmMulticallSource", selection.nfpm_multicall_manifest, "multicall", "0xac9650d8"],
        ["nfpmMintSource", selection.nfpm_mint_manifest, "mint", "0x88316456"],
        ["nfpmRefundEthSource", selection.nfpm_refund_eth_manifest, "refundETH", "0x12210e8a"],
      ]) {
        const nfpm = await copyPinnedFile(root, selected);
        assert.equal(nfpm.id, `uniswap/v3-nfpm/${id}@1.0.0`);
        assert.deepEqual(nfpm.match, {
          selector,
          // Concrete source bytes and address casing remain unchanged. Token
          // fixtures expand approve only; Base has its own NFPM deployment.
          chain_to_addresses: {
            "1": ["0xC36442b4a4522E871399CD717aBDD847Ab11FE88"],
            "10": ["0xC36442b4a4522E871399CD717aBDD847Ab11FE88"],
            "42161": ["0xC36442b4a4522E871399CD717aBDD847Ab11FE88"],
            "8453": ["0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"],
          },
        });
        nfpmSources[key] = nfpm;
      }
    }
    assert.equal(selection.tokens.length, 4, "DEC-01 pins one token per chain");
    const tokens = [];
    for (const selected of selection.tokens) {
      const token = await copyPinnedFile(root, selected);
      assert.equal(token.erc_kind, "erc20");
      assert.equal(token.chainId, selected.chain_id);
      assert.equal(token.address, selected.address);
      assert.equal(selected.path, `tokens/${selected.chain_id}/${selected.address}.json`);
      tokens.push(token);
    }
    assert.deepEqual(tokens.map((token) => token.chainId).sort((a, b) => a - b), source.match.chain_ids);
    // build-index resolves its root from this env var, not from cwd. It may
    // write partial output before exiting nonzero; only success returns root.
    try {
      await execFileAsync(tsx, [join(registryRoot, "scripts/build-index.ts"), "--strict-callkeys"], {
        cwd: registryRoot,
        env: { ...process.env, BUILD_INDEX_REGISTRY_ROOT: root },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`${includeNfpmSelf ? "DEC-06a" : includePermit2Batch ? "DEC-05b" : includePermit2Single ? "DEC-05a" : includePermit ? "DEC-04a" : includeTransfer ? "DEC-03" : "DEC-01"} Registry build failed; all output is discarded.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
    }
    return {
      root, source, tokens, cleanup,
      ...(includeTransfer ? { transferSource } : {}),
      ...(includePermit ? { permitSource } : {}),
      ...(includePermit2Single ? { permit2SingleSource } : {}),
      ...(includePermit2Batch ? { permit2BatchSource } : {}),
      ...nfpmSources,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Minimal subset of registry-api/src/server.ts:materializeIfRefIndex.
// DEC-01 uses bundle_ref without source-context materialization. The original
// resolved object is hashed and installed, without a parser projection.
export async function resolveIndexBundle(root, entry) {
  assert.equal(entry.matched, true);
  assert.equal(entry.context_ref, undefined, "DEC-01 does not materialize source contexts");
  assert.equal(entry.materialization, undefined, "DEC-01 does not materialize source contexts");
  let bundle;
  if (entry.schema_version === "3-ref") {
    assert.equal(entry.bundle, undefined);
    assert.match(entry.bundle_ref, /^bundles\/0x[0-9a-f]{64}\.json$/);
    bundle = await readJson(inside(root, entry.bundle_ref));
  } else {
    assert.equal(entry.schema_version, undefined, "Unsupported index format");
    assert.equal(entry.bundle_ref, undefined);
    bundle = entry.bundle;
  }
  assert.ok(bundle && typeof bundle === "object" && !Array.isArray(bundle));
  assert.equal(bundle.id, entry.bundle_id);
  assert.match(entry.bundle_sha256, /^0x[0-9a-f]{64}$/);
  // canonicalize@3 is ESM-only with an import-only export. Load the pinned
  // Registry installation directly; require()/require.resolve() cannot load it.
  const { default: canonicalize } = await import("../../../registryV2/node_modules/canonicalize/lib/canonicalize.js");
  const canonical = canonicalize(bundle);
  assert.equal(typeof canonical, "string");
  assert.equal(sha256(canonical), entry.bundle_sha256, "Resolved bundle JCS digest mismatch");
  if (entry.schema_version === "3-ref") {
    assert.equal(entry.bundle_ref, `bundles/${entry.bundle_sha256}.json`);
  }
  return bundle;
}
