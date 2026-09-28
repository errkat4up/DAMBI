import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const fixtureBackend = process.env.DAMBI_FIXTURE_BACKEND ?? "wasm";
if (!["native", "wasm"].includes(fixtureBackend)) {
  throw new Error(`Unknown DAMBI_FIXTURE_BACKEND: ${fixtureBackend}`);
}

// Relative overrides resolve from the repository root, independently of cwd.
export const nativeFixtureBinary = process.env.DAMBI_CORE_FIXTURE_BIN
  ? resolve(repoRoot, process.env.DAMBI_CORE_FIXTURE_BIN)
  : join(repoRoot, "target/debug/examples", `fixture_runner${process.platform === "win32" ? ".exe" : ""}`);

// Tests only use an explicitly prepared backend; they never build or fall back.
export async function assertFixtureBackend() {
  if (fixtureBackend === "native") {
    await access(nativeFixtureBinary, constants.X_OK).catch((cause) => {
      throw new Error(
        `Native fixture runner unavailable: ${nativeFixtureBinary}; run cargo build --locked -p dambi-core --example fixture_runner first, or set DAMBI_CORE_FIXTURE_BIN to the built executable.`,
        { cause },
      );
    });
    return;
  }
  for (const name of ["policy_engine_wasm.js", "policy_engine_wasm_bg.wasm"]) {
    await access(join(repoRoot, "crates/policy-engine-wasm/pkg", name)).catch((cause) => {
      throw new Error(`Missing ${name}; build the paired legacy JS/WASM first.`, { cause });
    });
  }
}

export function runNativeFixture(mode, payload) {
  if (fixtureBackend !== "native") throw new Error("Native fixture backend was not selected");
  if (!["decoder", "policy"].includes(mode)) throw new Error(`Unknown native fixture mode: ${mode}`);
  try {
    const stdout = execFileSync(nativeFixtureBinary, [mode], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`Native ${mode} fixture failed.\n${cause.stderr ?? ""}\n${cause.message}`, { cause });
  }
}
