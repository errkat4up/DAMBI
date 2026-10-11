import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Use the same pinned Rust JCS implementation as Core. This helper never
 * builds a binary or falls back to Registry dependencies or cached output. */
export function nativeCanonicalize(value, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const input = JSON.stringify(value);
  if (typeof input !== "string") throw new Error("canonicalization requires a JSON value");
  const binary = process.env.DAMBI_SESSION_RUNNER
    ? resolve(process.env.DAMBI_SESSION_RUNNER)
    : resolve(repoRoot, "target/debug/examples", process.platform === "win32" ? "session_runner.exe" : "session_runner");
  return execFileSync(binary, ["--canonicalize"], {
    input, encoding: "utf8", cwd: repoRoot, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  });
}
