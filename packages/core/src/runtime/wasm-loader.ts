import type { NativeCoreConstructor } from "./bridge.js";

export interface WasmModule {
  WasmCore: NativeCoreConstructor;
}

interface GeneratedModule extends WasmModule {
  default(input: { module_or_path: URL | Uint8Array }): Promise<unknown>;
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
  const moduleUrl = new URL("./wasm/dambi_core_wasm.js", import.meta.url);
  const binaryUrl = new URL("./wasm/dambi_core_wasm_bg.wasm", import.meta.url);
  // URL imports keep the generated module private and require no generated
  // sources or Node type declarations during the TypeScript build.
  const module: GeneratedModule = await import(/* webpackIgnore: true */ moduleUrl.href);
  let bytesOrUrl: URL | Uint8Array = binaryUrl;
  const processLike = (globalThis as {
    process?: { versions?: { node?: string } };
  }).process;
  if (binaryUrl.protocol === "file:" && processLike?.versions?.node) {
    const fsModule = "node:fs/promises";
    const fs: { readFile(path: URL): Promise<Uint8Array> } = await import(fsModule);
    bytesOrUrl = await fs.readFile(binaryUrl);
  }
  await module.default({ module_or_path: bytesOrUrl });
  if (typeof module.WasmCore !== "function") {
    throw new Error("The packaged Core WASM module does not export WasmCore");
  }
  return { WasmCore: module.WasmCore };
}
