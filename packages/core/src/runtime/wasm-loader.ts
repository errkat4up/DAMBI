import type { NativeCoreConstructor } from "./bridge.js";
import initWasm, { WasmCore } from "./wasm/dambi_core_wasm.js";

export interface WasmModule {
  WasmCore: NativeCoreConstructor;
}

let pending: Promise<WasmModule> | undefined;

/** Load the JS/WASM pair staged inside this package by its own build. */
export function loadWasm(): Promise<WasmModule> {
  pending ??= initialize().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function initialize(): Promise<WasmModule> {
  const binaryUrl = new URL("./wasm/dambi_core_wasm_bg.wasm", import.meta.url);
  // The generated JS is a static dependency so classic MV3 workers can bundle
  // it at installation time. The WASM binary is still initialized on first use.
  let bytesOrUrl: URL | Uint8Array = binaryUrl;
  const processLike = (globalThis as {
    process?: { versions?: { node?: string } };
  }).process;
  if (binaryUrl.protocol === "file:" && processLike?.versions?.node) {
    const fsModule = "node:fs/promises";
    const fs: { readFile(path: URL): Promise<Uint8Array> } = await import(/* webpackIgnore: true */ fsModule);
    bytesOrUrl = await fs.readFile(binaryUrl);
  }
  await initWasm({ module_or_path: bytesOrUrl });
  if (typeof WasmCore !== "function") {
    throw new Error("The packaged Core WASM module does not export WasmCore");
  }
  return { WasmCore };
}
