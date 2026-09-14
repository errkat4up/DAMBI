/**
 * publish-policy-bundle — assemble, sign and write ONE policy bundle for
 * `GET /v1/bundle` (registry-api). Contract: docs/decisions/0001-cloud-split.md
 * and registry-api/openapi.yaml (`BundlePayload`, `SignedPolicyBundle`).
 *
 * Input:  browser-extension/default-bundles/<set>/policies/<id>/{policy.cedar,manifest.json}
 * Output: policy-bundles/<profile>/<sequence>.json  (immutable — never rewritten)
 *         policy-bundles/<profile>/latest.json      (same bytes; mutable pointer)
 *         policy-bundles/<profile>/sequence         (counter, bumped by 1)
 *
 * Each output is `{ payload, signature, key_id }` where `payload` is the RFC 8785
 * JCS text of the BundlePayload — the exact signed bytes — and `signature` is
 * base64 P1363 r||s of ECDSA P-256 over SHA-256(payload). Same pipeline as
 * sign-bundles.ts, different key: policy bundles never share the decoder key.
 *
 * The sequence counter is a repo-committed file rather than a bucket listing so
 * a publish is reviewable in a PR and works offline. A rollback is a new,
 * higher sequence carrying the old content — content is never mutated in place.
 *
 * Modes (BUNDLE_SIGNING_MODE):
 *   local (default) — POLICY_SIGNING_KEY_PATH or scripts/deploy/keys/dev-policy-signing-key.hex
 *   kms             — POLICY_KMS_KEY_NAME (crypto key VERSION). Not provisioned yet:
 *                     the bundle contract moves on-chain in full later, so the KMS
 *                     key is deliberately deferred (ADR 0001, 2026-09-09).
 *
 *   npm run publish:policy-bundle                       # env=staging, profile=default
 *   npm run publish:policy-bundle -- --env production
 *   npm run publish:policy-bundle -- --set day1-safety --profile default --dry-run
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist.js";
import { derToP1363 } from "./sign-bundles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(REGISTRY_ROOT, "..");
const DEFAULT_POLICY_SETS = resolve(REPO_ROOT, "browser-extension", "default-bundles");

export const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const PROFILE_RE = /^[a-z0-9-]+$/;
const ENVS = ["staging", "production"] as const;
type Env = (typeof ENVS)[number];

export interface PolicyEntry {
  id: string;
  policy: string;
  manifest: Record<string, unknown>;
}

export interface BundlePayload {
  policies: PolicyEntry[];
  sequence: number;
  issued_at: number;
  expires_at: number | null;
  env: Env;
  profile: string;
  registry_ref: string | null;
}

export interface SignedPolicyBundle {
  payload: string;
  signature: string;
  key_id: string;
}

export interface PublishOptions {
  /** directory holding <id>/{policy.cedar,manifest.json} */
  policiesDir: string;
  /** directory holding <profile>/ — defaults to registryV2/policy-bundles */
  outRoot?: string;
  profile?: string;
  env?: Env;
  issuedAt?: number;
  mode?: "local" | "kms";
  privKeyHex?: string;
  kmsKeyName?: string;
  keyId?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface PublishResult {
  sequence: number;
  payload: BundlePayload;
  signed: SignedPolicyBundle;
  written: string[];
}

// ---- input ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read every <id>/{policy.cedar,manifest.json} pair; enforce the BundlePayload
 *  invariants the SDK will check (non-empty, unique ids, id === manifest.id,
 *  non-empty manifest) here so a bad bundle never gets signed. */
export function loadPolicies(policiesDir: string): PolicyEntry[] {
  if (!existsSync(policiesDir)) {
    throw new Error(`policies dir not found: ${policiesDir}`);
  }
  const entries: PolicyEntry[] = [];
  const seen = new Set<string>();
  const dirs = readdirSync(policiesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const id of dirs) {
    const dir = join(policiesDir, id);
    const cedarPath = join(dir, "policy.cedar");
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(cedarPath) || !existsSync(manifestPath)) {
      throw new Error(`policy ${id}: missing policy.cedar or manifest.json`);
    }
    const policy = readFileSync(cedarPath, "utf8");
    if (policy.trim().length === 0) throw new Error(`policy ${id}: empty policy.cedar`);
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(manifest) || Object.keys(manifest).length === 0) {
      throw new Error(`policy ${id}: manifest must be a non-empty object`);
    }
    if (manifest.id !== id) {
      throw new Error(`policy ${id}: manifest.id (${String(manifest.id)}) !== directory name`);
    }
    if (seen.has(id)) throw new Error(`policy ${id}: duplicate id`);
    seen.add(id);
    entries.push({ id, policy, manifest });
  }
  if (entries.length === 0) throw new Error(`no policies under ${policiesDir}`);
  return entries;
}

// ---- sequence counter ---------------------------------------------------------

export function readSequence(counterPath: string): number {
  if (!existsSync(counterPath)) return 0;
  const raw = readFileSync(counterPath, "utf8").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`sequence counter ${counterPath} is not a non-negative integer: "${raw}"`);
  }
  const n = Number(raw);
  if (n > MAX_SEQUENCE) throw new Error(`sequence counter exceeds safe-integer range`);
  return n;
}

// ---- signing ----------------------------------------------------------------

type CanonicalizeFn = (value: unknown) => string | undefined;
async function canonical(value: unknown): Promise<string> {
  const mod = (await import("canonicalize")) as { default: CanonicalizeFn };
  const out = mod.default(value);
  if (typeof out !== "string") throw new Error("payload canonicalization failed");
  return out;
}

function privKeyBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error("policy signing key must be 32-byte hex (64 chars)");
  }
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function readLocalKey(): string {
  const path =
    process.env.POLICY_SIGNING_KEY_PATH ??
    join(REGISTRY_ROOT, "scripts", "deploy", "keys", "dev-policy-signing-key.hex");
  if (!existsSync(path)) {
    throw new Error(
      `local policy signing key not found at ${path}. Generate one with: npm run gen-signing-key -- --policy`,
    );
  }
  return readFileSync(path, "utf8");
}

function localKeyId(priv: Uint8Array): string {
  const pub = p256.getPublicKey(priv, false);
  return "policy-local-" + createHash("sha256").update(pub).digest("hex").slice(0, 12);
}

async function signDigest(
  digest: Uint8Array,
  opts: PublishOptions,
): Promise<{ sig: Uint8Array; keyId: string }> {
  const mode = opts.mode ?? (process.env.BUNDLE_SIGNING_MODE === "kms" ? "kms" : "local");
  if (mode === "local") {
    const priv = privKeyBytes(opts.privKeyHex ?? readLocalKey());
    return {
      sig: p256.sign(digest, priv, { prehash: false }),
      keyId: opts.keyId ?? localKeyId(priv),
    };
  }
  const keyName = opts.kmsKeyName ?? process.env.POLICY_KMS_KEY_NAME;
  if (!keyName) throw new Error("kms mode requires POLICY_KMS_KEY_NAME (key version resource name)");
  const { KeyManagementServiceClient } = await import("@google-cloud/kms");
  const client = new KeyManagementServiceClient();
  const [resp] = await client.asymmetricSign({ name: keyName, digest: { sha256: Buffer.from(digest) } });
  if (!resp.signature) throw new Error(`KMS returned no signature for ${keyName}`);
  return { sig: derToP1363(Uint8Array.from(resp.signature as Buffer)), keyId: opts.keyId ?? keyName };
}

/** Sign a BundlePayload → `{payload: <JCS text>, signature, key_id}`. Exported so
 *  a verifier test can round-trip it without touching the filesystem. */
export async function signPayload(
  payload: BundlePayload,
  opts: PublishOptions,
): Promise<SignedPolicyBundle> {
  const text = await canonical(payload);
  const digest = Uint8Array.from(createHash("sha256").update(text, "utf8").digest());
  const { sig, keyId } = await signDigest(digest, opts);
  return {
    payload: text,
    signature: Buffer.from(sig).toString("base64"),
    key_id: keyId,
  };
}

// ---- main -------------------------------------------------------------------

export async function publishPolicyBundle(opts: PublishOptions): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const profile = opts.profile ?? "default";
  const env = opts.env ?? "staging";
  if (!PROFILE_RE.test(profile)) throw new Error(`profile must match ${PROFILE_RE}: "${profile}"`);
  if (!ENVS.includes(env)) throw new Error(`env must be one of ${ENVS.join("|")}: "${env}"`);

  const outRoot = opts.outRoot ?? join(REGISTRY_ROOT, "policy-bundles");
  const profileDir = join(outRoot, profile);
  const counterPath = join(profileDir, "sequence");

  const policies = loadPolicies(opts.policiesDir);
  const previous = readSequence(counterPath);
  const sequence = previous + 1;
  if (sequence > MAX_SEQUENCE) throw new Error("sequence would exceed safe-integer range");
  const versionPath = join(profileDir, `${sequence}.json`);
  if (existsSync(versionPath)) {
    throw new Error(`${versionPath} already exists — sequence ${sequence} was issued; counter is behind`);
  }

  const payload: BundlePayload = {
    policies,
    sequence,
    issued_at: opts.issuedAt ?? Math.floor(Date.now() / 1000),
    expires_at: null,
    env,
    profile,
    registry_ref: null,
  };
  const signed = await signPayload(payload, opts);
  const bytes = JSON.stringify(signed) + "\n";

  const written: string[] = [];
  if (!opts.dryRun) {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(versionPath, bytes, "utf8");
    writeFileSync(join(profileDir, "latest.json"), bytes, "utf8");
    writeFileSync(counterPath, `${sequence}\n`, "utf8");
    written.push(versionPath, join(profileDir, "latest.json"), counterPath);
  }
  log(
    `[publish-policy-bundle] profile=${profile} env=${env} sequence=${sequence} policies=${policies.length} key_id=${signed.key_id}${opts.dryRun ? " (dry-run, nothing written)" : ""}`,
  );
  return { sequence, payload, signed, written };
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv: string[]): { set: string; profile: string; env: Env; dryRun: boolean } {
  const out = { set: "day1-safety", profile: "default", env: "staging" as Env, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--set") out.set = argv[++i] ?? out.set;
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--env") out.env = (argv[++i] ?? out.env) as Env;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  publishPolicyBundle({
    policiesDir: join(DEFAULT_POLICY_SETS, args.set, "policies"),
    profile: args.profile,
    env: args.env,
    dryRun: args.dryRun,
    log: (m) => console.error(m),
  }).catch((e) => {
    console.error(`[publish-policy-bundle] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
