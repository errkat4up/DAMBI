import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const crate = new URL("crates/dambi-core-wasm/", root);
const output = new URL("packages/core/dist/runtime/wasm/", root);

// The package build runs tsc first: its clean step must not remove staged WASM.
await access(new URL("packages/core/dist/index.js", root));
const build = spawnSync("wasm-pack", [
  "build", fileURLToPath(crate), "--target", "web", "--release",
  "--out-dir", "pkg", "--out-name", "dambi_core_wasm", "--locked",
], {
  cwd: fileURLToPath(root),
  env: { ...process.env, CARGO_PROFILE_RELEASE_OPT_LEVEL: "z" },
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) {
  throw new Error(`Core WASM build failed (${build.signal ?? build.status})`);
}

await mkdir(output, { recursive: true });
for (const name of ["dambi_core_wasm.js", "dambi_core_wasm_bg.wasm"]) {
  await copyFile(new URL(`pkg/${name}`, crate), new URL(name, output));
}
