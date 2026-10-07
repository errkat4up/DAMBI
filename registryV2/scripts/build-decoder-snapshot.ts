/**
 * build-decoder-snapshot — assemble ONE pinned decoder snapshot for
 * `CoreConfig.decoderSnapshot` (@dambi/core). Contract: packages/core/README.md
 * ("Local configuration") and crates/dambi-core/src/snapshot/decoder.rs.
 *
 * Input:  registryV2/index/{by-callkey,by-typed-data,by-selector}/ — every matched
 *         entry, inline (`bundle`) or 3-ref (`bundle_ref` → bundles/<sha>.json).
 *         Each resolved bundle is re-checked against its index `bundle_sha256`
 *         (JCS), the same rule as fixtures/decoder-policy/helpers/build-registry.mjs.
 * Output: packages/core/decoder-snapshots/<name>/snapshot.json — the artifact, exact bytes
 *         packages/core/decoder-snapshots/<name>/snapshot.meta.json — digest, counts, exclusions
 *         The output lives in the SDK package, not here: the SDK source isolation
 *         check (scripts/sdk/verify-isolated.mjs) forbids reading registryV2/, and
 *         scripts/sdk/build-decoders.mjs embeds this committed copy as
 *         `@dambi/core/decoders`.
 *
 * The artifact is RFC 8785 JCS text of `{schema_version: 1, bundles}` with bundles
 * sorted by id, so the same Registry input always yields the same bytes and the
 * same `expectedDigest` (`0x` + lowercase SHA-256 of those UTF-8 bytes). There is
 * no signature: hosts trust the snapshot by pinning that digest locally. Nothing
 * time-dependent is written, so a rebuild with no Registry change is a no-op diff.
 *
 * Core installs only fully resolved bundles. Source-based bundles
 * (`match.chain_to_addresses_source` or `$source.*` templates) need per-pool
 * context materialization, which Core rejects; they are excluded and listed in
 * the meta file by reason rather than silently dropped.
 *
 * Core gate (default on): the artifact is loaded into the built @dambi/core
 * (packages/core/dist — run `npm run core:build` first) with the shared
 * day1-safety policies signed by a throwaway key. A bundle Core rejects is
 * dropped and named in `rejected_by_core`, then the load repeats until the exact
 * final bytes install. `--no-verify` skips the gate (nothing proves the result
 * loads, so use it only for inspection).
 *
 *   npm run build:decoder-snapshot                    # name=full
 *   npm run build:decoder-snapshot -- --name full --dry-run
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(REGISTRY_ROOT, "..");
const CORE_ENTRY = join(REPO_ROOT, "packages", "core", "dist", "index.js");

const INDEX_DIRS = ["by-callkey", "by-typed-data", "by-selector"] as const;
const NAME_RE = /^[a-z0-9-]+$/;
const BUNDLE_REF_RE = /^bundles\/0x[0-9a-f]{64}\.json$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bundle = { id: string; match: Record<string, Json> } & Record<string, Json>;

interface IndexEntry {
  matched: boolean;
  schema_version?: string;
  bundle_id: string;
  bundle_sha256: string;
  bundle?: Bundle;
  bundle_ref?: string;
  context_ref?: string;
  materialization?: unknown;
}

export interface SnapshotMeta {
  name: string;
  schema_version: 1;
  digest: string;
  bytes: number;
  bundle_count: number;
  excluded_count: number;
  /** excluded index bundle ids per reason; ids alone run to tens of thousands */
  excluded: Record<string, number>;
  /** bundles Core refused to install, by id; null when the gate was skipped */
  rejected_by_core: { id: string; error: string }[] | null;
}

export interface BuildOptions {
  name?: string;
  /** Registry root holding index/ and bundles/ — defaults to registryV2/ */
  registryRoot?: string;
  /** directory holding <name>/ — defaults to packages/core/decoder-snapshots */
  outRoot?: string;
  dryRun?: boolean;
  /** load the result into @dambi/core and drop bundles it rejects (default true) */
  verify?: boolean;
  log?: (msg: string) => void;
}

export interface BuildResult {
  artifact: string;
  meta: SnapshotMeta;
  written: string[];
}

type CanonicalizeFn = (v: unknown) => string | undefined;

async function canonical(value: unknown): Promise<string> {
  const mod = (await import("canonicalize")) as { default: CanonicalizeFn };
  const out = mod.default(value);
  if (typeof out !== "string") throw new Error("canonicalization failed");
  return out;
}

function sha256(text: string): string {
  return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---- input ------------------------------------------------------------------

/** Resolve one index entry to its bundle and verify the index digest. */
async function resolveEntry(root: string, path: string, entry: IndexEntry): Promise<Bundle> {
  if (entry.matched !== true) throw new Error(`${path}: unmatched index entry`);
  let bundle: Bundle | undefined;
  if (entry.schema_version === "3-ref") {
    if (entry.bundle !== undefined || !entry.bundle_ref || !BUNDLE_REF_RE.test(entry.bundle_ref)) {
      throw new Error(`${path}: malformed 3-ref entry`);
    }
    bundle = readJson<Bundle>(join(root, entry.bundle_ref));
  } else {
    if (entry.schema_version !== undefined || entry.bundle_ref !== undefined) {
      throw new Error(`${path}: unsupported index format`);
    }
    bundle = entry.bundle;
  }
  if (!bundle || typeof bundle !== "object" || bundle.id !== entry.bundle_id) {
    throw new Error(`${path}: bundle id does not match ${entry.bundle_id}`);
  }
  if (sha256(await canonical(bundle)) !== entry.bundle_sha256) {
    throw new Error(`${path}: resolved bundle JCS digest mismatch`);
  }
  return bundle;
}

function hasSourceTemplate(value: Json): boolean {
  if (typeof value === "string") return value === "$source" || value.startsWith("$source.");
  if (Array.isArray(value)) return value.some(hasSourceTemplate);
  if (value && typeof value === "object") return Object.values(value).some(hasSourceTemplate);
  return false;
}

/** Context entries point a per-pool id at a shared template bundle, so they are
 *  excluded before resolution: the template's id never matches the entry's. */
function needsContext(entry: IndexEntry): boolean {
  return entry.context_ref !== undefined || entry.materialization !== undefined;
}

/** Why Core cannot install this bundle as-is, or null when it can. */
function exclusionReason(bundle: Bundle): string | null {
  if ("chain_to_addresses_source" in bundle.match) {
    return "routes come from match.chain_to_addresses_source";
  }
  if (hasSourceTemplate(bundle)) return "unresolved $source template";
  return null;
}

/** Collect every distinct bundle the Registry index routes to, split into
 *  installable bundles and exclusions. One id must always resolve to the same
 *  bundle; a conflict means the Registry is inconsistent and nothing is built. */
export async function collectBundles(root: string): Promise<{ bundles: Bundle[]; excluded: Record<string, number> }> {
  const seen = new Map<string, { digest: string; bundle: Bundle }>();
  const contextIds = new Set<string>();
  for (const dir of INDEX_DIRS) {
    const base = join(root, "index", dir);
    for (const name of readdirSync(base).filter((n) => n.endsWith(".json")).sort()) {
      const path = `index/${dir}/${name}`;
      const entry = readJson<IndexEntry>(join(base, name));
      if (needsContext(entry)) {
        contextIds.add(entry.bundle_id);
        continue;
      }
      const previous = seen.get(entry.bundle_id);
      if (previous?.digest === entry.bundle_sha256) continue;
      if (previous) throw new Error(`${path}: ${entry.bundle_id} resolves to more than one bundle`);
      const bundle = await resolveEntry(root, path, entry);
      seen.set(entry.bundle_id, { digest: entry.bundle_sha256, bundle });
    }
  }
  const bundles: Bundle[] = [];
  const excluded: Record<string, number> = {};
  for (const id of [...new Set([...seen.keys(), ...contextIds])].sort()) {
    const reason = contextIds.has(id)
      ? "index entry requires source context materialization"
      : exclusionReason(seen.get(id)!.bundle);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else bundles.push(seen.get(id)!.bundle);
  }
  if (bundles.length === 0) throw new Error("no installable bundles");
  return { bundles, excluded };
}

// ---- Core gate --------------------------------------------------------------

interface CoreModule {
  createCore(config: unknown): Promise<{ dispose(): void }>;
}

interface PolicyBundleLoader {
  loadPolicyBundle(repoRoot: string, bundleName?: string): unknown[];
}

/** A config whose only real input is the decoder artifact: shared day1-safety
 *  policies signed by a key that exists for this one process. */
async function gateConfig(artifact: string): Promise<unknown> {
  const { loadPolicyBundle } = createRequire(import.meta.url)(
    join(REPO_ROOT, "scripts", "sdk", "policy-bundle.cjs"),
  ) as PolicyBundleLoader;
  const now = Date.now();
  const payload = await canonical({
    policies: loadPolicyBundle(REPO_ROOT, "day1-safety"),
    sequence: 1,
    issued_at: Math.floor(now / 1000),
    expires_at: null,
    env: "staging",
    profile: "default",
    registry_ref: null,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signature = sign("sha256", Buffer.from(payload, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const bytes = Buffer.byteLength(artifact, "utf8");
  return {
    decoderSnapshot: { artifact, expectedDigest: sha256(artifact) },
    trust: {
      env: "staging",
      profile: "default",
      keys: [{
        keyId: "decoder-snapshot-gate",
        role: "policy",
        publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }],
    },
    enforcement: "advisory",
    clock: { now: () => now },
    limits: {
      allowedClockSkewMs: 0, maxPolicyBytes: Buffer.byteLength(payload, "utf8"), maxDecoderBytes: bytes,
      maxRequestBytes: 1, maxFactBytes: 1, maxPlanCalls: 1, planTtlMs: 1, maxPendingPlans: 1,
      maxFactAgeMs: 1, factTimeoutMs: 1, policyTimeoutMs: 60_000,
    },
    ports: {
      policy: { fetch: async () => ({ payload, signature: signature.toString("base64"), keyId: "decoder-snapshot-gate" }) },
      fact: { fetch: async () => { throw new Error("no facts in the snapshot gate"); } },
    },
  };
}

/** Install the bundles in Core, dropping each one it names as invalid, until the
 *  exact artifact installs. Any other failure (limits, policy, engine) throws. */
async function coreGate(
  bundles: Bundle[],
  log: (msg: string) => void,
): Promise<{ bundles: Bundle[]; artifact: string; rejected: { id: string; error: string }[] }> {
  if (!existsSync(CORE_ENTRY)) {
    throw new Error(`${CORE_ENTRY} missing — run \`npm run core:build\` or pass --no-verify`);
  }
  const { createCore } = (await import(pathToFileURL(CORE_ENTRY).href)) as CoreModule;
  const rejected: { id: string; error: string }[] = [];
  let kept = bundles;
  for (;;) {
    const artifact = await canonical({ schema_version: 1, bundles: kept });
    try {
      (await createCore(await gateConfig(artifact))).dispose();
      return { bundles: kept, artifact, rejected };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const at = e.code === "INVALID_DECODER_SNAPSHOT" ? /^\$\/bundles\/(\d+)(.*)$/.exec(e.message ?? "") : null;
      const index = at ? Number(at[1]) : -1;
      if (!at || index >= kept.length) throw error;
      const { id } = kept[index];
      rejected.push({ id, error: at[2].replace(/^\/?/, "") });
      log(`[build-decoder-snapshot] Core rejected ${id}: ${at[2]}`);
      kept = kept.filter((_, i) => i !== index);
      if (kept.length === 0) throw new Error("Core rejected every bundle");
    }
  }
}

// ---- main -------------------------------------------------------------------

export async function buildDecoderSnapshot(opts: BuildOptions = {}): Promise<BuildResult> {
  const log = opts.log ?? (() => {});
  const name = opts.name ?? "full";
  if (!NAME_RE.test(name)) throw new Error(`name must match ${NAME_RE}: "${name}"`);
  const root = opts.registryRoot ?? REGISTRY_ROOT;

  const collected = await collectBundles(root);
  const { excluded } = collected;
  let { bundles } = collected;
  let artifact: string;
  let rejected: { id: string; error: string }[] | null = null;
  if (opts.verify ?? true) {
    ({ bundles, artifact, rejected } = await coreGate(bundles, log));
    rejected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    artifact = await canonical({ schema_version: 1, bundles });
  }
  const meta: SnapshotMeta = {
    name,
    schema_version: 1,
    digest: sha256(artifact),
    bytes: Buffer.byteLength(artifact, "utf8"),
    bundle_count: bundles.length,
    excluded_count: Object.values(excluded).reduce((a, b) => a + b, 0),
    excluded,
    rejected_by_core: rejected,
  };

  const written: string[] = [];
  if (!opts.dryRun) {
    const dir = join(opts.outRoot ?? join(REPO_ROOT, "packages", "core", "decoder-snapshots"), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "snapshot.json"), artifact, "utf8");
    writeFileSync(join(dir, "snapshot.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    written.push(join(dir, "snapshot.json"), join(dir, "snapshot.meta.json"));
  }
  log(
    `[build-decoder-snapshot] name=${name} bundles=${meta.bundle_count} excluded=${meta.excluded_count} rejected_by_core=${rejected?.length ?? "skipped"} bytes=${meta.bytes} digest=${meta.digest}${opts.dryRun ? " (dry-run, nothing written)" : ""}`,
  );
  return { artifact, meta, written };
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv: string[]): { name: string; dryRun: boolean; verify: boolean } {
  const out = { name: "full", dryRun: false, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-verify") out.verify = false;
    else if (a === "--name") out.name = argv[++i] ?? out.name;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  buildDecoderSnapshot({ name: args.name, dryRun: args.dryRun, verify: args.verify, log: (m) => console.error(m) }).catch((e) => {
    console.error(`[build-decoder-snapshot] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
