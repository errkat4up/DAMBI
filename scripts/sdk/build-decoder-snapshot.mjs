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
 *         SDK source isolation supplies selected local inputs without registryV2/.
 *         scripts/sdk/build-decoders.mjs embeds the committed product copy as
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
 * `--add-manifest manifests/...json` instead extends an existing pinned snapshot
 * without reading index/ or fetching pool data. This is a checked incremental
 * addition, not regeneration from the original Registry inputs. It preserves
 * every existing bundle and requires the whole candidate to install: no bundle
 * is dropped and --no-verify is forbidden in this mode.
 *
 * `--selection ../fixtures/sdk/pool-materialization/selection.json` builds the
 * explicitly pinned template/context inputs into a separate regression artifact.
 * It never reads index/, invokes resolvers or changes the packaged full snapshot.
 * All selected bundles must pass the Core gate; missing inputs are fatal.
 *
 * Registry CLI: npm run build:decoder-snapshot (inside registryV2/).
 * SDK CLI: node scripts/sdk/build-decoder-snapshot.mjs --selection <selection.json>.
 * The SDK CLI requires the built Native session_runner, whose --canonicalize
 * mode uses the same pinned JCS library as Core; it never builds prerequisites.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializeSelectedDecoder } from "./materialize-decoder.mjs";
import { nativeCanonicalize } from "./native-canonicalize.mjs";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** One generator shared by Registry and isolated SDK verification. The Registry
 * injects its JS JCS implementation; the SDK uses the already-pinned Native JCS.
 * Neither canonicalization nor repo paths are process-global mutable state. */
export function createDecoderSnapshotBuilder({ canonicalize, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const REPO_ROOT = resolve(repoRoot);
  const REGISTRY_ROOT = join(REPO_ROOT, "registryV2");
  const CORE_ENTRY = join(REPO_ROOT, "packages", "core", "dist", "index.js");
  const canonicalizer = canonicalize ?? ((value) => nativeCanonicalize(value, { repoRoot: REPO_ROOT }));

  const INDEX_DIRS = ["by-callkey", "by-typed-data", "by-selector"];
  const NAME_RE = /^[a-z0-9-]+$/;
  const BUNDLE_REF_RE = /^bundles\/0x[0-9a-f]{64}\.json$/;

  async function canonical(value) {
    const out = await canonicalizer(value);
    if (typeof out !== "string") throw new Error("canonicalization failed");
    return out;
  }

  function sha256(text) {
    return `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
  }

  function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  // ---- input ------------------------------------------------------------------

  /** Resolve one index entry to its bundle and verify the index digest. */
  async function resolveEntry(root, path, entry) {
    if (entry.matched !== true) throw new Error(`${path}: unmatched index entry`);
    let bundle;
    if (entry.schema_version === "3-ref") {
      if (entry.bundle !== undefined || !entry.bundle_ref || !BUNDLE_REF_RE.test(entry.bundle_ref)) {
        throw new Error(`${path}: malformed 3-ref entry`);
      }
      bundle = readJson(join(root, entry.bundle_ref));
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

  function hasSourceTemplate(value) {
    if (typeof value === "string") return value === "$source" || value.startsWith("$source.");
    if (Array.isArray(value)) return value.some(hasSourceTemplate);
    if (value && typeof value === "object") return Object.values(value).some(hasSourceTemplate);
    return false;
  }

  /** Context entries point a per-pool id at a shared template bundle, so they are
   *  excluded before resolution: the template's id never matches the entry's. */
  function needsContext(entry) {
    return entry.context_ref !== undefined || entry.materialization !== undefined;
  }

  /** Why Core cannot install this bundle as-is, or null when it can. */
  function exclusionReason(bundle) {
    if ("chain_to_addresses_source" in bundle.match) {
      return "routes come from match.chain_to_addresses_source";
    }
    if (hasSourceTemplate(bundle)) return "unresolved $source template";
    return null;
  }

  /** Collect every distinct bundle the Registry index routes to, split into
   *  installable bundles and exclusions. One id must always resolve to the same
   *  bundle; a conflict means the Registry is inconsistent and nothing is built. */
  async function collectBundles(root) {
    const seen = new Map();
    const contextIds = new Set();
    for (const dir of INDEX_DIRS) {
      const base = join(root, "index", dir);
      for (const name of readdirSync(base).filter((n) => n.endsWith(".json")).sort()) {
        const path = `index/${dir}/${name}`;
        const entry = readJson(join(base, name));
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
    const bundles = [];
    const excluded = {};
    for (const id of [...new Set([...seen.keys(), ...contextIds])].sort()) {
      const reason = contextIds.has(id)
        ? "index entry requires source context materialization"
        : exclusionReason(seen.get(id).bundle);
      if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
      else bundles.push(seen.get(id).bundle);
    }
    if (bundles.length === 0) throw new Error("no installable bundles");
    return { bundles, excluded };
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function checkedBundle(value, label) {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || !isRecord(value.match)) {
      throw new Error(`${label}: expected a resolved bundle with id and match`);
    }
    return value;
  }

  /** Verify the saved pair before preserving its bundles and exclusion history. */
  function readSavedSnapshot(dir, name) {
    const artifact = readFileSync(join(dir, "snapshot.json"), "utf8");
    const meta = readJson(join(dir, "snapshot.meta.json"));
    const snapshot = JSON.parse(artifact);
    if (!isRecord(snapshot) || snapshot.schema_version !== 1 || !Array.isArray(snapshot.bundles)
      || Object.keys(snapshot).some((key) => key !== "schema_version" && key !== "bundles")) {
      throw new Error(`${dir}: unsupported saved snapshot format`);
    }
    if (!isRecord(meta) || meta.name !== name || meta.schema_version !== 1
      || meta.digest !== sha256(artifact) || meta.bytes !== Buffer.byteLength(artifact, "utf8")
      || meta.bundle_count !== snapshot.bundles.length) {
      throw new Error(`${dir}: saved snapshot metadata does not match its artifact`);
    }
    if (!isRecord(meta.excluded)
      || Object.values(meta.excluded).some((count) => !Number.isSafeInteger(count) || count < 0)
      || meta.excluded_count !== Object.values(meta.excluded).reduce((a, b) => a + b, 0)
      || (meta.rejected_by_core !== null && (!Array.isArray(meta.rejected_by_core)
        || meta.rejected_by_core.some((entry) => !isRecord(entry) || typeof entry.id !== "string" || typeof entry.error !== "string")))) {
      throw new Error(`${dir}: malformed saved exclusion metadata`);
    }
    const bundles = snapshot.bundles.map((value, i) => checkedBundle(value, `${dir}/bundles/${i}`));
    const ids = new Set(bundles.map(({ id }) => id));
    if (bundles.length === 0 || ids.size !== bundles.length) {
      throw new Error(`${dir}: saved snapshot has no bundles or duplicate bundle ids`);
    }
    return { bundles, meta };
  }

  function manifestPath(root, path) {
    const parts = path.split("/");
    if (!/^manifests\/(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.json$/.test(path)
      || parts.some((part) => part === "." || part === "..")) {
      throw new Error(`manifest must be a normalized Registry-relative path under manifests/: ${path}`);
    }
    const base = realpathSync(join(root, "manifests"));
    const resolved = realpathSync(join(root, path));
    const within = relative(base, resolved);
    if (isAbsolute(within) || within.split(sep).some((part) => part === "..")) {
      throw new Error(`manifest escapes manifests/: ${path}`);
    }
    return resolved;
  }

  async function addManifests(
    root,
    existing,
    paths,
  ) {
    const byId = new Map(existing.map((bundle) => [bundle.id, bundle]));
    const selectedIds = new Set();
    for (const path of paths) {
      const bundle = checkedBundle(readJson(manifestPath(root, path)), path);
      const reason = exclusionReason(bundle);
      if (reason) throw new Error(`${path}: ${reason}; only resolved manifests can be added`);
      const previous = byId.get(bundle.id);
      if (previous && await canonical(previous) !== await canonical(bundle)) {
        throw new Error(`${path}: ${bundle.id} already exists with different contents`);
      }
      byId.set(bundle.id, previous ?? bundle);
      selectedIds.add(bundle.id);
    }
    return {
      bundles: [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      selectedIds,
    };
  }

  /** Read only explicit local inputs. No resolver, RPC, index or cache fallback. */
  function selectedInputPath(base, value) {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.json$/.test(value)
      || value.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`selection input must be a normalized relative JSON path: ${String(value)}`);
    }
    const path = realpathSync(join(base, value));
    const within = relative(realpathSync(base), path);
    if (isAbsolute(within) || within.split(sep).includes("..")) {
      throw new Error(`selection input escapes its directory: ${value}`);
    }
    return path;
  }

  async function collectSelectedBundles(selectionFile) {
    const selection = readJson(selectionFile);
    if (!isRecord(selection) || selection.schema_version !== 1 || selection.purpose !== "regression-only"
      || !Array.isArray(selection.entries) || selection.entries.length === 0
      || Object.keys(selection).some((key) => !["schema_version", "purpose", "entries"].includes(key))) {
      throw new Error("selection must declare schema_version 1, regression-only purpose and nonempty entries");
    }
    const base = dirname(selectionFile);
    const byId = new Map();
    const routes = new Set();
    const inputs = [];
    for (const entry of selection.entries) {
      if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "template" && key !== "context")) {
        throw new Error("selection entry must contain only template and context paths");
      }
      const template = readJson(selectedInputPath(base, entry.template));
      const context = readJson(selectedInputPath(base, entry.context));
      const bundle = checkedBundle(materializeSelectedDecoder(template, context), String(entry.template));
      if (byId.has(bundle.id)) throw new Error(`duplicate selected bundle id: ${bundle.id}`);
      // The strict materializer produces exactly one chain/address route.
      const addresses = bundle.match.chain_to_addresses;
      const [[chain, targets]] = Object.entries(addresses);
      const route = `${chain}:${targets[0]}:${String(bundle.match.selector).toLowerCase()}`;
      if (routes.has(route)) throw new Error(`conflicting selected route: ${route}`);
      routes.add(route);
      byId.set(bundle.id, bundle);
      inputs.push({ id: bundle.id, template: entry.template, context: entry.context,
        bundle_sha256: sha256(await canonical(bundle)) });
    }
    inputs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      bundles: inputs.map(({ id }) => byId.get(id)),
      selection: { purpose: "regression-only", route_count: routes.size, inputs },
    };
  }

  // ---- Core gate --------------------------------------------------------------

  /** A config whose only real input is the decoder artifact: shared day1-safety
   *  policies signed by a key that exists for this one process. */
  async function gateConfig(artifact) {
    const { loadPolicyBundle } = createRequire(import.meta.url)(
      join(REPO_ROOT, "scripts", "sdk", "policy-bundle.cjs"),
    );
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
    bundles,
    log,
    strict = false,
  ) {
    if (!existsSync(CORE_ENTRY)) {
      throw new Error(`${CORE_ENTRY} missing — run \`npm run core:build\`${strict ? "" : " or pass --no-verify"}`);
    }
    const { createCore } = (await import(pathToFileURL(CORE_ENTRY).href));
    const rejected = [];
    let kept = bundles;
    for (;;) {
      const artifact = await canonical({ schema_version: 1, bundles: kept });
      try {
        (await createCore(await gateConfig(artifact))).dispose();
        return { bundles: kept, artifact, rejected };
      } catch (error) {
        if (strict) throw error;
        const e = error;
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

  async function buildDecoderSnapshot(opts = {}) {
    const log = opts.log ?? (() => {});
    const selected = opts.selectionFile !== undefined;
    const name = opts.name ?? (selected ? "pools-preview" : "full");
    if (!NAME_RE.test(name)) throw new Error(`name must match ${NAME_RE}: "${name}"`);
    const root = opts.registryRoot ?? REGISTRY_ROOT;
    const productRoot = join(REPO_ROOT, "packages", "core", "decoder-snapshots");
    const dir = resolve(opts.outRoot ?? (selected ? join(dirname(opts.selectionFile), "generated") : productRoot), name);
    const extending = (opts.addManifests?.length ?? 0) > 0;
    if (extending && opts.verify === false) throw new Error("--add-manifest requires the Core gate; --no-verify is not allowed");
    if (selected && extending) throw new Error("--selection cannot be combined with --add-manifest");
    if (selected && opts.verify === false) throw new Error("--selection requires the Core gate; --no-verify is not allowed");
    if (selected) {
      const withinProduct = relative(productRoot, dir);
      if (!isAbsolute(withinProduct) && !withinProduct.split(sep).includes("..")) {
        throw new Error("regression-only selection cannot write a packaged decoder snapshot");
      }
      const previousMetaPath = join(dir, "snapshot.meta.json");
      if (existsSync(previousMetaPath) && readJson(previousMetaPath).selection?.purpose !== "regression-only") {
        throw new Error("regression-only selection cannot replace an existing product snapshot");
      }
    }

    let bundles;
    let excluded;
    let previousMeta;
    let selectedIds = new Set();
    let selection;
    if (selected) {
      ({ bundles, selection } = await collectSelectedBundles(opts.selectionFile));
      excluded = {};
    } else if (extending) {
      const saved = readSavedSnapshot(dir, name);
      previousMeta = saved.meta;
      excluded = saved.meta.excluded;
      ({ bundles, selectedIds } = await addManifests(root, saved.bundles, opts.addManifests));
    } else {
      ({ bundles, excluded } = await collectBundles(root));
    }
    let artifact;
    let rejected = null;
    if (opts.verify ?? true) {
      ({ bundles, artifact, rejected } = await coreGate(bundles, log, extending || selected));
      if (previousMeta) {
        rejected = (previousMeta.rejected_by_core ?? []).filter(({ id }) => !selectedIds.has(id));
      }
      rejected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } else {
      artifact = await canonical({ schema_version: 1, bundles });
    }
    const meta = {
      name,
      schema_version: 1,
      digest: sha256(artifact),
      bytes: Buffer.byteLength(artifact, "utf8"),
      bundle_count: bundles.length,
      excluded_count: Object.values(excluded).reduce((a, b) => a + b, 0),
      excluded,
      rejected_by_core: rejected,
      ...(selection ? { selection } : {}),
    };

    const written = [];
    if (!opts.dryRun) {
      mkdirSync(dir, { recursive: true });
      // Stage both files after validation; each rename replaces one complete file.
      // Readers check the digest, so an interrupted pair replacement fails closed.
      const staging = mkdtempSync(join(dir, ".snapshot-"));
      try {
        writeFileSync(join(staging, "snapshot.json"), artifact, "utf8");
        writeFileSync(join(staging, "snapshot.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        renameSync(join(staging, "snapshot.json"), join(dir, "snapshot.json"));
        renameSync(join(staging, "snapshot.meta.json"), join(dir, "snapshot.meta.json"));
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      written.push(join(dir, "snapshot.json"), join(dir, "snapshot.meta.json"));
    }
    log(
      `[build-decoder-snapshot] name=${name} bundles=${meta.bundle_count} excluded=${meta.excluded_count} rejected_by_core=${rejected?.length ?? "skipped"} bytes=${meta.bytes} digest=${meta.digest}${opts.dryRun ? " (dry-run, nothing written)" : ""}`,
    );
    return { artifact, meta, written };
  }

  return { buildDecoderSnapshot, collectSelectedBundles, collectBundles };
}

export const { buildDecoderSnapshot, collectSelectedBundles, collectBundles } = createDecoderSnapshotBuilder();

// ---- CLI --------------------------------------------------------------------

export function parseDecoderSnapshotArgs(argv) {
  const out = { dryRun: false, verify: true, addManifests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-verify") out.verify = false;
    else if (a === "--name" || a === "--add-manifest" || a === "--selection") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${a} requires a value`);
      if (a === "--name") out.name = value;
      else if (a === "--selection") out.selectionFile = resolve(value);
      else out.addManifests.push(value);
    }
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Run either entry point through the same argument parser and builder. */
export async function runDecoderSnapshotCli(builder, argv = process.argv.slice(2)) {
  const args = parseDecoderSnapshotArgs(argv);
  return builder.buildDecoderSnapshot({ ...args, log: (message) => console.error(message) });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDecoderSnapshotCli({ buildDecoderSnapshot }).catch((error) => {
    console.error(`[build-decoder-snapshot] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
