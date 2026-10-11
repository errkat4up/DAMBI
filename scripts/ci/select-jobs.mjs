import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const JOBS = ["rust", "rust-server", "wasm", "extension", "registry-api", "core"];
const dependencyFiles = new Set([
  "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "yarn.lock",
  "pnpm-lock.yaml", "rust-toolchain.toml", "rust-toolchain",
]);

function full(reason) {
  return { jobs: Object.fromEntries(JOBS.map((job) => [job, true])), reason };
}

export function selectJobs(changes) {
  const selected = new Set();
  for (const { status, path } of changes) {
    if (!["A", "M", "D", "T"].includes(status) || !path || path.startsWith("/")
        || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      return full("Unrecognized change record");
    }
    if (path.startsWith(".github/") || path.startsWith("scripts/ci/")
        || path.startsWith(".gitleaks") || dependencyFiles.has(basename(path))) {
      return full("CI configuration or dependencies changed");
    }
    // Markdown content needs no rebuild, but deleting/renaming a required SDK
    // README or coverage file can break packaging and must still be checked.
    if (path.endsWith(".md")) {
      if (status === "A" || status === "M") continue;
      return full("Documentation removed or file type changed");
    }
    if (path.startsWith("packages/core/")) selected.add("core");
    else if (path.startsWith("registry-api/")) selected.add("registry-api");
    else if (path.startsWith("browser-extension/")) selected.add("extension");
    else if (path.startsWith("crates/policy-server/")) {
      selected.add("rust-server");
      // copy-method-catalog.js also validates this server source in the extension.
      if (path === "crates/policy-server/server/src/handler.rs") selected.add("extension");
    } else {
      // Shared Rust, Registry, fixtures, SDK scripts and new/unmapped areas may
      // affect several consumers. Narrow these only after checking dependencies.
      return full("Shared source or unmapped path changed");
    }
  }
  // The extension downloads the WASM artifact produced in this same run.
  if (selected.has("extension")) selected.add("wasm");
  return {
    jobs: Object.fromEntries(JOBS.map((job) => [job, selected.has(job)])),
    reason: selected.size ? "Jobs affected by changed paths" : "Only documentation content or no changed files",
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function planForEvent(eventName, event, { cwd = process.cwd() } = {}) {
  if (!["push", "pull_request"].includes(eventName)) return full("Manual or unsupported event: full verification");
  if (event?.forced) return full("Forced push: full verification");
  const base = eventName === "pull_request" ? event?.pull_request?.base?.sha : event?.before;
  const head = eventName === "pull_request" ? event?.pull_request?.head?.sha : event?.after;
  const validSha = (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha) && !/^0+$/.test(sha);
  if (!validSha(base) || !validSha(head)) return full("Missing or invalid comparison commits");
  try {
    const start = eventName === "pull_request" ? git(cwd, ["merge-base", base, head]).trim() : base;
    // NUL delimiters preserve unusual filenames. Disabling rename detection
    // selects both the deleted source and added destination, across job areas.
    const diff = git(cwd, ["diff", "--name-status", "--no-renames", "-z", start, head, "--"]);
    const fields = diff.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("Incomplete Git diff");
    const changes = [];
    for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
    return selectJobs(changes);
  } catch {
    return full("Comparison unavailable: full verification");
  }
}

async function main() {
  let plan;
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    plan = planForEvent(process.env.GITHUB_EVENT_NAME, event);
  } catch {
    plan = full("Event metadata unavailable: full verification");
  }
  const enabled = JOBS.filter((job) => plan.jobs[job]);
  console.log(`${plan.reason}: ${enabled.join(", ") || "no build jobs"}. Secret scanning always runs.`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, JOBS.map((job) => `${job}=${plan.jobs[job]}\n`).join(""));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `CI selection: ${plan.reason}.\n\nBuild jobs: ${enabled.join(", ") || "none"}. Secret scanning always runs.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
