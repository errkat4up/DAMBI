import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const preparedMarker = ".sdk-isolated-prepared";

export function inside(base, path) {
  const rel = relative(base, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function openIsolatedWorkspace(root, phase, env = process.env) {
  root = await realpath(root);
  if (phase === "all") {
    const isolated = await mkdtemp(join(await realpath(tmpdir()), "dambi-sdk-isolated-"));
    if (inside(root, isolated)) throw new Error("The verification directory must be outside the checkout");
    return isolated;
  }
  if (!["prepare", "verify"].includes(phase) || env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP) {
    throw new Error("CI phases require GitHub Actions and RUNNER_TEMP");
  }
  // Stable across hosted runners so Cargo can reuse dependency fingerprints.
  // Sources are always freshly copied; only target is restored by rust-cache.
  const isolated = join(await realpath(env.RUNNER_TEMP), "dambi-sdk-isolated");
  if (inside(root, isolated) || inside(isolated, root)) {
    throw new Error("The verification directory must be outside the checkout");
  }
  if (phase === "prepare") {
    // Refuse an existing tree instead of deleting or reusing unknown contents.
    await mkdir(isolated);
  } else {
    const stat = await lstat(isolated);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid prepared SDK directory");
    if (await readFile(join(isolated, preparedMarker), "utf8") !== "ready\n") {
      throw new Error("SDK workspace preparation has not completed");
    }
    await rm(join(isolated, preparedMarker));
  }
  return isolated;
}

export async function markIsolatedWorkspacePrepared(isolated) {
  await writeFile(join(isolated, preparedMarker), "ready\n", { flag: "wx" });
}
