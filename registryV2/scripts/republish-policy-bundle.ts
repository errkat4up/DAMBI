/**
 * republish-policy-bundle — keep the signed policy bundle behind `GET /v1/bundle`
 * fresh. Runs as two Cloud Run jobs on Cloud Scheduler triggers
 * (scripts/deploy/deploy-policy-republisher.sh): a daily re-sign and an hourly
 * age check. Also the manual tool for both.
 *
 * Why: Core rejects a policy bundle older than `maxBundleAgeSec` (72h default)
 * even when `expires_at` is null, so a bundle published once goes fail-closed
 * three days later (POLICY_EXPIRED).
 *
 * Modes
 *   (default)       re-sign the LIVE payload: same `policies`, env, profile and
 *                   registry_ref, a new `issued_at` and the next sequence. The
 *                   job image carries no policy source, so the approved content
 *                   is whatever is live and cannot drift with the image.
 *   --from-source   intentional content change: sign policy-bundles/<--set>/
 *                   from this checkout instead (manual, reviewed publish).
 *   --check         no write: read the public API's latest bundle and exit 1
 *                   if it is older than --max-age-hours (default 48).
 *
 * Bucket protocol (the bucket is authoritative for the sequence, not the repo's
 * policy-bundles/<profile>/sequence counter — publish-index.sh never touches
 * policy-bundles/):
 *   1. next = max(latest.json sequence, every <n>.json present) + 1, so a run
 *      that died after writing <n>.json but before latest.json never reuses n.
 *   2. <next>.json is created with ifGenerationMatch=0 (immutable). Losing that
 *      race to a concurrent run moves on to the following number.
 *   3. latest.json is replaced only if it still has the generation read in
 *      step 1 (no lost update), and only by a higher sequence (no regression).
 *      If another run already advanced it to >= next, this run stops cleanly.
 *   Every step is retried a bounded number of times; any error exits non-zero
 *   so the job retries and alerting sees the failure.
 *
 * Auth: Cloud Run metadata server token; locally GCS_ACCESS_TOKEN
 * (`GCS_ACCESS_TOKEN=$(gcloud auth print-access-token)`).
 * Key:  POLICY_SIGNING_KEY_PATH (Secret Manager volume in the job). The signing
 *       key id must equal the live one: hosts pin it.
 *
 *   npx tsx scripts/republish-policy-bundle.ts [--profile default] [--dry-run]
 *   npx tsx scripts/republish-policy-bundle.ts --from-source --set day1-safety
 *   npx tsx scripts/republish-policy-bundle.ts --check [--max-age-hours 48]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPolicies,
  MAX_SEQUENCE,
  signPayload,
  type BundlePayload,
  type SignedPolicyBundle,
} from "./publish-policy-bundle.js";

const BUCKET = process.env.REGISTRY_BUCKET ?? "dambi-registry-v3-unseo";
const PUBLIC_API = process.env.REGISTRY_API_URL ?? "https://registry-api-v3-428885534408.asia-northeast1.run.app";
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const ATTEMPTS = 5;

type Log = (msg: string) => void;

// ---- GCS (JSON API) -----------------------------------------------------------

async function accessToken(): Promise<string> {
  if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN.trim();
  const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status} (set GCS_ACCESS_TOKEN outside GCP)`);
  return ((await res.json()) as { access_token: string }).access_token;
}

class PreconditionFailed extends Error {}

async function gcs(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (res.status === 412) throw new PreconditionFailed(`${init.method ?? "GET"} ${url}: precondition failed`);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

const objectUrl = (name: string) =>
  `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`;

/** Object bytes plus the generation they were read at. */
async function readObject(token: string, name: string): Promise<{ text: string; generation: string }> {
  const res = await gcs(token, `${objectUrl(name)}?alt=media`);
  const generation = res.headers.get("x-goog-generation");
  if (!generation) throw new Error(`gs://${BUCKET}/${name}: no generation header`);
  return { text: await res.text(), generation };
}

/** Highest <n>.json sequence present under the profile prefix (0 when none). */
async function highestVersionObject(token: string, prefix: string): Promise<number> {
  let max = 0;
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`);
    url.searchParams.set("prefix", `${prefix}/`);
    url.searchParams.set("fields", "items(name),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = (await (await gcs(token, url.toString())).json()) as { items?: { name: string }[]; nextPageToken?: string };
    for (const { name } of page.items ?? []) {
      const m = /\/([1-9][0-9]*)\.json$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return max;
}

async function writeObject(token: string, name: string, body: string, ifGenerationMatch: string): Promise<void> {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", name);
  url.searchParams.set("ifGenerationMatch", ifGenerationMatch);
  await gcs(token, url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

// ---- republish ----------------------------------------------------------------

function parseLive(text: string): { signed: SignedPolicyBundle; payload: BundlePayload } {
  const signed = JSON.parse(text) as SignedPolicyBundle;
  const payload = JSON.parse(signed.payload) as BundlePayload;
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
    throw new Error(`live latest.json has invalid sequence ${String(payload.sequence)}`);
  }
  return { signed, payload };
}

export interface RepublishOptions {
  profile: string;
  /** sign this checkout's policy set instead of the live policies */
  fromSource?: string;
  dryRun: boolean;
  log: Log;
}

export async function republish(opts: RepublishOptions): Promise<{ sequence: number; issuedAt: number } | null> {
  const token = await accessToken();
  const prefix = `policy-bundles/${opts.profile}`;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const latest = await readObject(token, `${prefix}/latest.json`);
    const live = parseLive(latest.text);
    let next = Math.max(live.payload.sequence, await highestVersionObject(token, prefix)) + 1;
    if (next > MAX_SEQUENCE) throw new Error("sequence would exceed safe-integer range");

    const policies = opts.fromSource ? loadPolicies(REPO_ROOT, opts.fromSource) : live.payload.policies;
    const issuedAt = Math.floor(Date.now() / 1000);
    const sign = async (sequence: number) => {
      const signed = await signPayload({ ...live.payload, policies, sequence, issued_at: issuedAt }, {});
      if (signed.key_id !== live.signed.key_id) {
        throw new Error(`signing key changed: live ${live.signed.key_id}, this run ${signed.key_id} — hosts pin the key`);
      }
      return `${JSON.stringify(signed)}\n`;
    };

    if (opts.dryRun) {
      await sign(next);
      opts.log(`[republish] dry-run: would publish ${prefix} sequence ${next} (live ${live.payload.sequence}, ${policies.length} policies${opts.fromSource ? ` from ${opts.fromSource}` : ", live content"})`);
      return null;
    }

    // Immutable version file; a concurrent run holding `next` pushes us on.
    let bytes = "";
    for (;; next++) {
      bytes = await sign(next);
      try {
        await writeObject(token, `${prefix}/${next}.json`, bytes, "0");
        break;
      } catch (error) {
        if (!(error instanceof PreconditionFailed) || next - live.payload.sequence > ATTEMPTS) throw error;
        opts.log(`[republish] ${prefix}/${next}.json already exists, trying ${next + 1}`);
      }
    }

    // Pointer: only from the generation we read, so a newer latest is never replaced.
    try {
      await writeObject(token, `${prefix}/latest.json`, bytes, latest.generation);
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      const current = parseLive((await readObject(token, `${prefix}/latest.json`)).text).payload.sequence;
      if (current >= next) {
        opts.log(`[republish] latest.json already at sequence ${current} (>= ${next}); nothing to do`);
        return { sequence: current, issuedAt };
      }
      opts.log(`[republish] latest.json changed underneath (now ${current}); retry ${attempt}/${ATTEMPTS}`);
      continue;
    }
    opts.log(`[republish] gs://${BUCKET}/${prefix}: sequence ${live.payload.sequence} → ${next}, issued_at=${issuedAt}`);
    return { sequence: next, issuedAt };
  }
  throw new Error(`gave up after ${ATTEMPTS} attempts: latest.json kept changing`);
}

// ---- check --------------------------------------------------------------------

/** Age of the bundle the public API serves; throws when it is too old. */
export async function check(profile: string, maxAgeHours: number, log: Log): Promise<void> {
  const res = await fetch(`${PUBLIC_API}/v1/bundle?profile=${encodeURIComponent(profile)}`, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`GET /v1/bundle: HTTP ${res.status}`);
  const { payload } = parseLive(await res.text());
  const ageHours = (Date.now() / 1000 - payload.issued_at) / 3600;
  const summary = `sequence ${payload.sequence}, issued ${new Date(payload.issued_at * 1000).toISOString()}, age ${ageHours.toFixed(1)}h`;
  if (ageHours > maxAgeHours) throw new Error(`public bundle is stale: ${summary} (limit ${maxAgeHours}h)`);
  log(`[check] ok: ${summary} (limit ${maxAgeHours}h)`);
}

// ---- CLI ----------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out = { profile: "default", fromSource: undefined as string | undefined, set: "day1-safety",
    dryRun: false, check: false, maxAgeHours: 48 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--check") out.check = true;
    else if (a === "--from-source") out.fromSource = "";
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--set") out.set = argv[++i] ?? out.set;
    else if (a === "--max-age-hours") out.maxAgeHours = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.fromSource !== undefined) out.fromSource = out.set;
  if (!(out.maxAgeHours > 0)) throw new Error("--max-age-hours must be positive");
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const log: Log = (m) => console.error(m);
  const args = parseArgs(process.argv.slice(2));
  const run = args.check
    ? check(args.profile, args.maxAgeHours, log)
    : republish({ profile: args.profile, fromSource: args.fromSource, dryRun: args.dryRun, log });
  run.catch((e) => {
    console.error(`[republish-policy-bundle] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
