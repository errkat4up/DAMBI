/**
 * SF5-1 local publisher. No network, key generation, policy key fallback or upload.
 * Input is a complete scam bundle draft, including its explicit sequence and times.
 * Output: scam-bundles/<env>/<profile>/<sequence>.json and latest.json.
 * The wrapper preserves the exact JCS bytes signed with P-256/SHA-256/P1363.
 * Core remains authoritative for rule validation, compatibility and installed trust.
 *
 * SCAM_SIGNING_KEY_PATH=/explicit/scam.hex SCAM_SIGNING_KEY_ID=scam-staging-1 \
 *   npm run publish:scam-bundle -- --input draft.json --env staging --profile default
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { p256 } from "@noble/curves/nist.js";

type Env = "staging" | "production";
type ObjectValue = Record<string, unknown>;
const PROFILE = /^[a-z0-9-]{1,128}(?![\s\S])/;
const SEQUENCE = /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/;
const MAX_SEQUENCE = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}(?![\s\S])/;
const TOP_FIELDS = new Set(["kind", "schema", "sequence", "issuedAtMs", "expiresAtMs", "env", "profile",
  "compatibility", "support", "presets", "templates", "model"]);
const REGISTRY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PublishScamBundleOptions {
  readonly input: unknown;
  readonly env: Env;
  readonly profile: string;
  /** Explicit scam-only private scalar file (64 hex digits, optional 0x prefix). */
  readonly signingKeyPath: string;
  /** Metadata only. Consumers select keys from their own local scam trust. */
  readonly keyId: string;
  /** Registry root; files go under its scam-bundles directory. */
  readonly outRoot?: string;
  readonly nowMs?: number;
  readonly dryRun?: boolean;
}

function object(value: unknown, name: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${name}`);
  return value as ObjectValue;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function addresses(value: unknown, minimum: number): boolean {
  return Array.isArray(value) && value.length >= minimum && value.every((v) => typeof v === "string" && ADDRESS.test(v));
}

/** Publishing checks do not run or reimplement the separately supplied algorithm. */
export function validateScamBundleDraft(input: unknown, env: Env, profile: string, nowMs: number): ObjectValue {
  const bundle = object(input, "scam bundle");
  if (!["staging", "production"].includes(env) || typeof profile !== "string" || !PROFILE.test(profile) || !integer(nowMs)
      || Object.keys(bundle).some((key) => !TOP_FIELDS.has(key))
      || bundle.kind !== "scam_bundle" || bundle.schema !== "0.1"
      || bundle.env !== env || bundle.profile !== profile
      || typeof bundle.sequence !== "string" || !SEQUENCE.test(bundle.sequence) || BigInt(bundle.sequence) > MAX_SEQUENCE
      || !integer(bundle.issuedAtMs) || !integer(bundle.expiresAtMs)
      || bundle.issuedAtMs > nowMs || nowMs >= bundle.expiresAtMs
      || bundle.issuedAtMs >= bundle.expiresAtMs || bundle.model !== null) {
    throw new Error("invalid scam bundle scope, sequence, validity or model");
  }
  const compatibility = object(bundle.compatibility, "compatibility");
  if (!text(compatibility.engineRange) || !text(compatibility.builderRange)
      || compatibility.contractVersion !== "0.1") throw new Error("invalid compatibility");
  if (compatibility.algorithm !== null) {
    const algorithm = object(compatibility.algorithm, "algorithm identity");
    if (!text(algorithm.id) || !text(algorithm.version) || algorithm.contractVersion !== 2) {
      throw new Error("invalid algorithm identity");
    }
  }
  if (!Array.isArray(bundle.support) || bundle.support.length === 0) throw new Error("missing support");
  const chains = new Set<number>();
  for (const value of bundle.support) {
    const support = object(value, "support");
    if (!integer(support.chainId, 1) || chains.has(support.chainId) || support.venue !== "uniswap_v2"
        || !addresses(support.factories, 1) || !addresses(support.quoteTokens, 1) || !addresses(support.exemptTokens, 0)
        || !Array.isArray(support.allowedBucketMs) || support.allowedBucketMs.length === 0
        || !support.allowedBucketMs.every((v) => integer(v, 1)) || !integer(support.confirmDepth)) {
      throw new Error("invalid support scope");
    }
    chains.add(support.chainId);
  }
  if (!Array.isArray(bundle.presets) || bundle.presets.length === 0) throw new Error("missing presets");
  const presetIds = new Set<string>();
  for (const value of bundle.presets) {
    const preset = object(value, "preset");
    const selection = object(preset.selection, "preset selection");
    if (!text(preset.id) || presetIds.has(preset.id) || !["default", "demo"].includes(String(preset.purpose))
        || !integer(selection.ageThresholdSec, 1) || selection.ageThresholdSec > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
        || selection.unknownAge !== "new_provisional_insufficient") throw new Error("invalid preset selection");
    presetIds.add(preset.id);
    for (const candidate of [preset.newMarket, preset.established]) {
      const effective = object(candidate, "effective preset");
      if (!text(effective.id) || !Array.isArray(effective.rules) || effective.rules.length === 0
          || !integer(effective.bucketMs, 1) || !integer(effective.gridOriginMs)
          || !integer(effective.warmupSec) || !integer(effective.maxDataAgeSec, 1)) throw new Error("invalid effective preset");
    }
  }
  if (!Object.values(object(bundle.templates, "templates")).every((v) => typeof v === "string")) {
    throw new Error("invalid templates");
  }
  return bundle;
}

function readScamKey(path: string): Uint8Array {
  if (!text(path)) throw new Error("SCAM_SIGNING_KEY_PATH must explicitly select a scam signing key");
  const hex = readFileSync(resolve(path), "utf8").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("scam signing key must contain exactly 32 hex bytes");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function checkPrevious(dir: string, env: Env, profile: string, sequence: string): void {
  if (existsSync(join(dir, `${sequence}.json`))) throw new Error("immutable scam sequence already exists; choose a new sequence");
  const latest = join(dir, "latest.json");
  if (!existsSync(latest)) return;
  const wrapper = object(JSON.parse(readFileSync(latest, "utf8")), "previous wrapper");
  if (typeof wrapper.payload !== "string") throw new Error("invalid previous payload");
  const previous = object(JSON.parse(wrapper.payload), "previous payload");
  if (previous.kind !== "scam_bundle" || previous.env !== env || previous.profile !== profile
      || typeof previous.sequence !== "string" || !SEQUENCE.test(previous.sequence) || BigInt(previous.sequence) > MAX_SEQUENCE) {
    throw new Error("invalid previous scam scope or sequence");
  }
  if (BigInt(sequence) <= BigInt(previous.sequence)) throw new Error("scam latest sequence cannot move backwards or repeat");
}

export function publishScamBundle(opts: PublishScamBundleOptions) {
  const bundle = validateScamBundleDraft(opts.input, opts.env, opts.profile, opts.nowMs ?? Date.now());
  if (!text(opts.keyId) || !/^[a-zA-Z0-9._-]{1,128}(?![\s\S])/.test(opts.keyId)) {
    throw new Error("SCAM_SIGNING_KEY_ID is required");
  }
  // JCS and noble's P1363 signing match sign-bundles/publish-policy-bundle; keys do not.
  const payload = canonicalize(bundle);
  if (typeof payload !== "string") throw new Error("scam payload canonicalization failed");
  const digest = createHash("sha256").update(payload, "utf8").digest();
  const signature = Buffer.from(p256.sign(digest, readScamKey(opts.signingKeyPath), { prehash: false })).toString("base64");
  const signed = { payload, signature, key_id: opts.keyId };
  const bytes = JSON.stringify(signed) + "\n";
  const sequence = bundle.sequence as string;
  const dir = join(resolve(opts.outRoot ?? REGISTRY_ROOT), "scam-bundles", opts.env, opts.profile);
  const written: string[] = [];
  if (opts.dryRun) checkPrevious(dir, opts.env, opts.profile, sequence);
  else {
    mkdirSync(dir, { recursive: true });
    // Serialize local writers so their latest pointer cannot race backwards.
    // A stale lock after process termination needs operator inspection; never steal it.
    const lockPath = join(dir, ".publish.lock");
    const lock = openSync(lockPath, "wx");
    const temporary = join(dir, `.latest.${process.pid}.tmp`);
    try {
      checkPrevious(dir, opts.env, opts.profile, sequence);
      const immutable = join(dir, `${sequence}.json`);
      writeFileSync(immutable, bytes, { encoding: "utf8", flag: "wx" });
      written.push(immutable);
      writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, join(dir, "latest.json"));
      written.push(join(dir, "latest.json"));
    } finally {
      rmSync(temporary, { force: true });
      closeSync(lock);
      rmSync(lockPath);
    }
  }
  return { sequence, signed, written };
}

function main(argv: string[]): void {
  const args = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--dry-run") { dryRun = true; continue; }
    if (!["--input", "--env", "--profile", "--out"].includes(key) || args.has(key)
        || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("invalid publisher arguments");
    args.set(key, argv[++index]);
  }
  const env = args.get("--env");
  if (!args.get("--input") || (env !== "staging" && env !== "production")) {
    throw new Error("--input and --env staging|production are required");
  }
  const result = publishScamBundle({
    input: JSON.parse(readFileSync(resolve(args.get("--input")!), "utf8")),
    env, profile: args.get("--profile") ?? "default", outRoot: args.get("--out"), dryRun,
    signingKeyPath: process.env.SCAM_SIGNING_KEY_PATH ?? "", keyId: process.env.SCAM_SIGNING_KEY_ID ?? "",
  });
  console.log(JSON.stringify({ sequence: result.sequence, keyId: result.signed.key_id, dryRun, written: result.written }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`[publish-scam-bundle] FAILED: ${error instanceof Error ? error.message : "publish failed"}`);
    process.exitCode = 1;
  }
}
