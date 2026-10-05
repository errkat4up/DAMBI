/**
 * republish-policy-bundle — re-sign the current policy set with a fresh
 * `issued_at` and the next sequence, straight into the bucket. Runs as the
 * `policy-republisher` Cloud Run job on a Cloud Scheduler trigger
 * (scripts/deploy/deploy-policy-republisher.sh).
 *
 * Why: Core rejects a policy bundle older than `maxBundleAgeSec` (72h default)
 * even when `expires_at` is null, so a bundle published once goes fail-closed
 * three days later. A daily run keeps `latest.json` well inside that window.
 *
 * Once this job runs, the BUCKET is authoritative for the sequence, not the
 * repo's policy-bundles/<profile>/sequence counter. publish-index.sh therefore
 * no longer rsyncs policy-bundles/; a repo-side publish would roll latest.json
 * back to an old sequence that Core rejects as a downgrade.
 *
 * Steps (fail-closed: any error leaves the live latest.json untouched):
 *   1. read gs://<bucket>/policy-bundles/<profile>/latest.json → sequence N, env
 *   2. publishPolicyBundle() into a temp dir seeded with counter N → N+1
 *   3. upload <N+1>.json with ifGenerationMatch=0 (immutable; a concurrent run
 *      that took N+1 first makes this one fail instead of overwriting)
 *   4. overwrite latest.json with the same bytes
 *
 * Auth: Cloud Run metadata server token; locally, GCS_ACCESS_TOKEN
 * (`GCS_ACCESS_TOKEN=$(gcloud auth print-access-token)`).
 * Key:  POLICY_SIGNING_KEY_PATH (Secret Manager volume in the job).
 *
 *   npx tsx scripts/republish-policy-bundle.ts [--profile default] [--set day1-safety] [--dry-run]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishPolicyBundle, type BundlePayload, type SignedPolicyBundle } from "./publish-policy-bundle.js";

const BUCKET = process.env.REGISTRY_BUCKET ?? "dambi-registry-v3-unseo";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

async function accessToken(): Promise<string> {
  if (process.env.GCS_ACCESS_TOKEN) return process.env.GCS_ACCESS_TOKEN.trim();
  const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status} (set GCS_ACCESS_TOKEN outside GCP)`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function readObject(token: string, name: string): Promise<string> {
  const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`read gs://${BUCKET}/${name}: HTTP ${res.status}`);
  return res.text();
}

async function writeObject(token: string, name: string, body: string, ifAbsent: boolean): Promise<void> {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", name);
  if (ifAbsent) url.searchParams.set("ifGenerationMatch", "0");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  if (res.status === 412) throw new Error(`gs://${BUCKET}/${name} already exists — another run took this sequence`);
  if (!res.ok) throw new Error(`write gs://${BUCKET}/${name}: HTTP ${res.status} ${await res.text()}`);
}

export async function republish(opts: { profile: string; set: string; dryRun: boolean; log: (m: string) => void }) {
  const token = await accessToken();
  const prefix = `policy-bundles/${opts.profile}`;
  const current = JSON.parse(await readObject(token, `${prefix}/latest.json`)) as SignedPolicyBundle;
  const live = JSON.parse(current.payload) as BundlePayload;
  if (!Number.isSafeInteger(live.sequence) || live.sequence < 1) {
    throw new Error(`live latest.json has invalid sequence ${String(live.sequence)}`);
  }

  const outRoot = mkdtempSync(join(tmpdir(), "policy-republish-"));
  try {
    mkdirSync(join(outRoot, opts.profile));
    writeFileSync(join(outRoot, opts.profile, "sequence"), `${live.sequence}\n`, "utf8");
    const result = await publishPolicyBundle({
      set: opts.set,
      profile: opts.profile,
      env: live.env,
      outRoot,
      log: opts.log,
    });
    if (result.signed.key_id !== current.key_id) {
      throw new Error(`signing key changed: live ${current.key_id}, job ${result.signed.key_id} — hosts pin the key`);
    }
    const bytes = readFileSync(join(outRoot, opts.profile, `${result.sequence}.json`), "utf8");
    if (opts.dryRun) {
      opts.log(`[republish-policy-bundle] dry-run: would publish sequence ${result.sequence} (live ${live.sequence})`);
      return result;
    }
    await writeObject(token, `${prefix}/${result.sequence}.json`, bytes, true);
    await writeObject(token, `${prefix}/latest.json`, bytes, false);
    opts.log(
      `[republish-policy-bundle] gs://${BUCKET}/${prefix}: sequence ${live.sequence} → ${result.sequence}, issued_at=${result.payload.issued_at}`,
    );
    return result;
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): { profile: string; set: string; dryRun: boolean } {
  const out = { profile: "default", set: "day1-safety", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--set") out.set = argv[++i] ?? out.set;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  republish({ ...parseArgs(process.argv.slice(2)), log: (m) => console.error(m) }).catch((e) => {
    console.error(`[republish-policy-bundle] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
