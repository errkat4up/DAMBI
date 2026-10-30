import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inside, markIsolatedWorkspacePrepared, openIsolatedWorkspace } from "./isolated-workspace.mjs";

// Core + selected decoder source gate, not the final npm/Cargo/browser release gate.
// Build tools must already be installed; package dependencies are installed only
// in the disposable copy. No generated output or node_modules is copied in.
const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const manifest = JSON.parse(await readFile(new URL("./sdk-source-files.json", import.meta.url), "utf8"));
const forbidden = ["browser-extension", "crates/policy-server", "crates/policy-engine-wasm", "registryV2"];
const generated = new Set([".git", "target", "node_modules", "dist", "pkg", ".cache"]);
const runtimeTests = [
  "packages/core/tests/runtime.test.mjs",
  "packages/core/tests/check.test.mjs",
  "packages/core/tests/scam-bundle.test.mjs",
  "packages/core/tests/adapters/scam-pool-history.test.mjs",
  "packages/core/tests/adapters/scam-token-profile.test.mjs",
  "packages/core/tests/adapters/scam-fact-provider.test.mjs",
  "packages/core/tests/adapters/scam-analysis-probe.test.mjs",
  "packages/core/tests/adapters/scam-data-probe.test.mjs",
  "packages/core/tests/adapters/scam-sw-diagnostic.test.mjs",
  "packages/core/tests/adapters/policy-api.test.mjs",
  "packages/core/tests/adapters/policy-api-core.test.mjs",
  "packages/core/tests/adapters/evm-rpc.test.mjs",
  "packages/core/tests/adapters/fact-provider.test.mjs",
  "packages/core/tests/adapters/fact-provider-lifecycle.test.mjs",
  "packages/core/tests/adapters/fact-provider-core.test.mjs",
  "packages/core/tests/adapters/evm-fact-probe.test.mjs",
];
const keep = process.argv.includes("--keep");
const args = process.argv.slice(2);
const phase = args.includes("--ci-prepare") ? "prepare" : args.includes("--ci-verify") ? "verify" : "all";
if (args.some((arg) => !["--keep", "--ci-prepare", "--ci-verify"].includes(arg))
    || (args.includes("--ci-prepare") && args.includes("--ci-verify")) || (keep && phase !== "all")) {
  throw new Error("Usage: npm run sdk:verify:isolated -- [--keep | --ci-prepare | --ci-verify]");
}
if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js >=20 is required");

function sourcePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || isAbsolute(path)
      || path.split("/").some((part) => part === "" || part === "." || part === ".." || generated.has(part))
      || forbidden.some((entry) => path === entry || path.startsWith(`${entry}/`))) {
    throw new Error(`Invalid source-list path: ${path}`);
  }
  return path;
}

// Reject symlinks even inside a selected directory: the copy must consist of
// actual sources, never links to the original checkout or old build outputs.
async function copySource(from, to) {
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${from}`);
  if (stat.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (generated.has(name)) throw new Error(`Generated source-list entry: ${join(from, name)}`);
      await copySource(join(from, name), join(to, name));
    }
  } else if (stat.isFile()) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  } else {
    throw new Error(`Unsupported source entry: ${from}`);
  }
}

async function assertSourceParents(path) {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${current}`);
  }
}

const isolated = await openIsolatedWorkspace(root, phase);
const env = { ...process.env, CARGO_TARGET_DIR: join(isolated, "target"), CARGO_TERM_COLOR: "never" };
// Do not let caller overrides reuse an existing binary, JS preloader or compiler
// output. Normal Cargo registry downloads/cache and the installed toolchain are OK.
for (const key of Object.keys(env)) {
  if (key.startsWith("DAMBI_") || key.startsWith("npm_") || key.startsWith("NPM_") || key.startsWith("YARN_")) delete env[key];
}
for (const key of ["NODE_OPTIONS", "NODE_PATH", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_TARGET", "CARGO_BUILD_TARGET_DIR", "SKIP_WASM_BUILD"]) delete env[key];
env.DAMBI_SESSION_RUNNER = join(isolated, "target/debug/examples", process.platform === "win32" ? "session_runner.exe" : "session_runner");
const yarn = [join(isolated, ".yarn/releases/yarn-4.14.1.cjs")];

async function run(command, args, { capture = false } = {}) {
  console.log(`\n[isolated] ${command} ${args.join(" ")}`);
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: isolated, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", (chunk) => {
        if (!capture || stream === child.stderr) destination.write(chunk);
        if (stream === child.stdout) output += chunk.toString();
        else errors += chunk.toString();
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept(output);
      else reject(new Error(`${command} failed (${signal ?? code})${capture ? `\n${output}${errors}` : ""}`));
    });
  });
}

function lockedPackages(text) {
  return new Set(text.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap((block) => {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"\\n]+)"$`, "m"))?.[1];
    const source = field("source");
    return source ? [JSON.stringify([field("name"), field("version"), source, field("checksum")])] : [];
  }));
}

async function checkBoundary() {
  for (const path of forbidden) {
    try {
      await lstat(join(isolated, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Forbidden directory appeared in SDK copy: ${path}`);
  }
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(isolated, await realpath(path))) throw new Error(`External symlink: ${path}`);
      } else if (entry.isDirectory()) {
        // Compiler/cache internals are not SDK source or runtime assets.
        if (path !== join(isolated, "target") && path !== join(isolated, ".yarn/cache")) await visit(path);
      }
    }
  };
  await visit(isolated);
}

async function prepare() {
  for (const entry of manifest.copies) {
    const from = sourcePath(entry.from);
    const to = sourcePath(entry.to ?? from);
    await assertSourceParents(from);
    if (!inside(root, await realpath(join(root, from)))) throw new Error(`Source escapes checkout: ${from}`);
    await copySource(join(root, from), join(isolated, to));
  }
  await checkBoundary();
}

async function validateCargo({ prune }) {
  const toolchain = (await readFile(join(isolated, "rust-toolchain.toml"), "utf8")).match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"$/m)?.[1];
  if (!toolchain) throw new Error("An exact Rust toolchain version is required");
  env.RUSTUP_TOOLCHAIN = toolchain;

  // Only prune the seed lock's old workspace graph. --workspace preserves
  // dependency resolutions; the comparison below also rejects new versions.
  const originalPackages = lockedPackages(await readFile(join(root, "Cargo.lock"), "utf8"));
  if (prune) await run("cargo", ["update", "--workspace"]);
  for (const pkg of lockedPackages(await readFile(join(isolated, "Cargo.lock"), "utf8"))) {
    if (!originalPackages.has(pkg)) throw new Error(`Isolated Cargo resolution changed the pinned dependency: ${pkg}`);
  }
  const metadata = JSON.parse(await run("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], { capture: true }));
  for (const pkg of metadata.packages) {
    if (!inside(isolated, pkg.manifest_path)) throw new Error(`External Cargo manifest: ${pkg.manifest_path}`);
    for (const dep of pkg.dependencies) {
      if (dep.path && !inside(isolated, dep.path)) throw new Error(`External Cargo path dependency: ${dep.path}`);
    }
  }
}

async function verify() {
  await checkBoundary();
  const wasmPack = await run("wasm-pack", ["--version"], { capture: true });
  if (!/^wasm-pack 0\.14\.0\s*$/.test(wasmPack.trim())) throw new Error("wasm-pack 0.14.0 is required");
  await run(process.execPath, [...yarn, "install", "--immutable"]);
  const native = await run("cargo", ["test", "--locked", "-p", "dambi-core", "--lib", "--test", "session"]);
  if (!/test result: ok\. [1-9]\d* passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/.test(native)) {
    throw new Error("Native session must run nonempty tests with no ignored/filtered cases");
  }
  await run("cargo", ["build", "--locked", "-p", "dambi-core", "--example", "session_runner"]);
  await run(process.execPath, [...yarn, "core:typecheck"]);
  await run(process.execPath, [...yarn, "core:build"]);
  // The first build supplies the real WASM installation gate. Then reconstruct
  // the selected product additions and pool fixtures using only copied SDK
  // inputs, and package the reconstructed product before consumers load it.
  await run(process.execPath, ["scripts/sdk/verify-decoder-generation.mjs", "--install-product"]);
  await run(process.execPath, ["scripts/sdk/build-decoders.mjs"]);
  await run(process.execPath, [...yarn, "core:test:types"]);
  for (const file of runtimeTests) {
    const output = await run(process.execPath, ["--test", "--test-reporter=tap", file]);
    if (!/^# tests [1-9]\d*$/m.test(output)
        || !["fail", "cancelled", "skipped", "todo"].every((name) => new RegExp(`^# ${name} 0$`, "m").test(output))) {
      throw new Error(`${file} must run nonempty tests without skips or failures`);
    }
  }
  // Package the already verified isolated build once. The separate consumer
  // job installs this exact tarball; it does not rebuild WASM in another job.
  await mkdir(join(isolated, "artifacts"), { recursive: true });
  await run("npm", ["pack", "./packages/core", "--ignore-scripts", "--pack-destination", "artifacts"]);
  await checkBoundary();
}

let success = false;
try {
  console.log(`[isolated] ${manifest.scope}\n[isolated] ${isolated}`);
  if (phase !== "verify") await prepare();
  await validateCargo({ prune: phase !== "verify" });
  if (phase === "prepare") {
    await markIsolatedWorkspacePrepared(isolated);
    console.log("[isolated] Sources and pinned Cargo workspace prepared for dependency cache restore.");
  } else {
    await verify();
    console.log("\n[isolated] SDK source verification passed (Native + WASM + selected decoder generation + raw pool parity + types/runtime/check/adapters).");
  }
  success = true;
} finally {
  // CI's post-job rust-cache step still needs target and Cargo manifests.
  // GitHub-hosted runners clean RUNNER_TEMP after all post-job steps finish.
  if (phase !== "all") console.log(`[isolated] CI workspace retained for post-job dependency cache: ${isolated}`);
  else if (success && !keep) await rm(isolated, { recursive: true, force: true });
  else console.log(`[isolated] Copy retained for inspection: ${isolated}`);
}
