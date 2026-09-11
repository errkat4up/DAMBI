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

// Existing callers remain approve-only; DEC-03 explicitly adds transfer.
export async function buildRegistry(selection, { includeTransfer = false } = {}) {
  assert.equal(typeof includeTransfer, "boolean");
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
      throw new Error(`${includeTransfer ? "DEC-03" : "DEC-01"} Registry build failed; all output is discarded.\n${error.stderr ?? ""}\n${error.message}`, { cause: error });
    }
    return { root, source, tokens, cleanup, ...(includeTransfer ? { transferSource } : {}) };
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
