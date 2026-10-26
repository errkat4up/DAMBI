import type { NativeCoreConstructor } from "../bridge.js";

// Source-only declaration: build-wasm.mjs stages the generated JS/WASM after tsc.
// This private module is never a host-supplied runtime or a package export.
export const WasmCore: NativeCoreConstructor;
export default function initWasm(input: {
  module_or_path: URL | Uint8Array;
}): Promise<unknown>;
