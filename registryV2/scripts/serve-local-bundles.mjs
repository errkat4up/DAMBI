#!/usr/bin/env node
/**
 * serve-local-bundles — local, read-only stand-in for the two bundle routes of
 * registry-api, for trying the Scam Filter against bundles signed on this
 * machine. It serves files as they are; it signs nothing and reaches no bucket.
 *
 *   GET /v1/scam-bundle?env=<staging|production>&profile=<slug>[&sequence=<n>]
 *       → <scam root>/scam-bundles/<env>/<profile>/<sequence|latest>.json
 *   GET /v1/bundle?profile=<slug>[&version=<n>]
 *       → <policy root>/policy-bundles/<profile>/<version|latest>.json
 *
 * Same path rules as registry-api/src/server.ts. Anything else is 404; only GET.
 * Listens on loopback only.
 *
 *   node scripts/serve-local-bundles.mjs --scam-root ~/dambi-local-bundles
 *   node scripts/serve-local-bundles.mjs --scam-root <dir> --policy-root <dir> --port 8788
 *
 * --policy-root defaults to this registry (registryV2/, i.e. the committed
 * policy-bundles/default/latest.json). --port defaults to 8788, which the
 * extension's development manifest already has host permission for.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = /^[a-z0-9-]{1,128}$/;
const NUMBER = /^(?:0|[1-9][0-9]{0,77})$/;

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--scam-root", "--policy-root", "--port"].includes(argv[i]) || argv[i + 1] === undefined) {
      throw new Error("usage: serve-local-bundles.mjs --scam-root <dir> [--policy-root <dir>] [--port <n>]");
    }
    args.set(argv[i], argv[i + 1]);
  }
  if (!args.has("--scam-root")) throw new Error("--scam-root is required");
  const port = Number(args.get("--port") ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid --port");
  return { scamRoot: resolve(args.get("--scam-root")), policyRoot: resolve(args.get("--policy-root") ?? REGISTRY_ROOT), port };
}

/** Map a request to a file, or null. Every path segment is validated; nothing is taken verbatim. */
export function fileFor(url, roots) {
  const one = (name) => (url.searchParams.getAll(name).length === 1 ? url.searchParams.get(name) : null);
  if (url.pathname === "/v1/scam-bundle") {
    const allowed = new Set(["env", "profile", "sequence"]);
    if (![...url.searchParams.keys()].every((key) => allowed.has(key) && url.searchParams.getAll(key).length === 1)) return null;
    const env = one("env"), profile = one("profile") ?? "default", sequence = one("sequence");
    if (!["staging", "production"].includes(env) || !SLUG.test(profile) || (sequence !== null && !NUMBER.test(sequence))) return null;
    return join(roots.scamRoot, "scam-bundles", env, profile, `${sequence ?? "latest"}.json`);
  }
  if (url.pathname === "/v1/bundle") {
    const profile = url.searchParams.get("profile") ?? "default", version = url.searchParams.get("version");
    if (!SLUG.test(profile) || (version !== null && !NUMBER.test(version))) return null;
    return join(roots.policyRoot, "policy-bundles", profile, `${version ?? "latest"}.json`);
  }
  return null;
}

export function createBundleServer(roots, log = () => {}) {
  return createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "access-control-allow-origin": "*", "cache-control": "no-store", ...headers });
      response.end(body);
      log(`${request.method} ${request.url} → ${status}`);
    };
    const json = (status, code) => send(status, JSON.stringify({ ok: false, error: { code } }), { "content-type": "application/json" });
    if (request.method !== "GET") return json(405, "method_not_allowed");
    let url;
    try { url = new URL(request.url ?? "/", "http://localhost"); } catch { return json(404, "not_found"); }
    const file = fileFor(url, roots);
    if (!file) return json(404, "not_found");
    let bytes;
    try { bytes = await readFile(file); } catch { return json(404, "not_found"); }
    const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
    if (request.headers["if-none-match"] === etag) return send(304, undefined, { etag });
    return send(200, bytes, { "content-type": "application/json", etag });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { port, ...roots } = parseArgs(process.argv.slice(2));
    createBundleServer(roots, (line) => console.log(line)).listen(port, "127.0.0.1", () => {
      console.log(`serving local bundles on http://127.0.0.1:${port}`);
      console.log(`  scam   ← ${join(roots.scamRoot, "scam-bundles")}`);
      console.log(`  policy ← ${join(roots.policyRoot, "policy-bundles")}`);
    });
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
}
