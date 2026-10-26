// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";
import webpack, { type Configuration, type Stats } from "webpack";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

function bundle(config: Configuration): Promise<Stats> {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) reject(error || closeError);
        else if (!stats || stats.hasErrors()) {
          reject(new Error(stats?.toString({ all: false, errors: true }) ?? "Missing webpack stats"));
        } else resolve(stats);
      });
    });
  });
}

it("bundles the real Core JS into a classic worker and leaves WASM initialization lazy", async () => {
  // Requires built Core JS/WASM; existing production artifacts may be reused.
  const configs = require("../../../webpack/webpack.common.js") as Configuration[];
  const sw = configs.find((config) => config.name === "sw");
  expect(sw).toBeDefined();
  if (!sw) throw new Error("Missing extension worker configuration");

  const temporary = await mkdtemp(join(tmpdir(), "dambi-core-worker-"));
  try {
    const entry = join(temporary, "entry.mjs");
    await writeFile(entry, [
      'import { createCore } from "@dambi/core";',
      "globalThis.createCore = createCore;",
    ].join("\n"));
    const stats = await bundle({
      ...sw,
      name: "core-wasm-smoke",
      dependencies: [],
      mode: "production",
      entry,
      output: { ...sw.output, path: temporary, filename: "background.js", clean: false },
      plugins: [],
      devtool: false,
      optimization: { minimize: false },
      performance: false,
    });
    const assets = stats.toJson({ all: false, assets: true }).assets?.map(({ name }) => name) ?? [];
    // The old URL-based dynamic import emitted the generated JS as an extra
    // asset and failed only when createCore first ran inside a classic MV3 SW.
    expect(assets.filter((name) => name.endsWith(".js"))).toEqual(["background.js"]);
    expect(assets.filter((name) => name.endsWith(".wasm"))).toHaveLength(1);

    const initialize = vi.fn(() => { throw new Error("WASM initialized while registering the worker"); });
    const worker: Record<string, unknown> = {
      URL, TextDecoder, TextEncoder,
      // node:vm omits these Web APIs. Core captures the platform abort getter
      // and EventTarget methods at module registration, as a real worker permits.
      AbortSignal, AbortController, EventTarget,
      location: { href: "chrome-extension://core-smoke/js/background.js" },
      fetch: initialize,
      WebAssembly: { instantiate: initialize, instantiateStreaming: initialize },
    };
    worker.self = worker;
    // A classic worker has no document, Node process or ESM module loader.
    runInNewContext(await readFile(join(temporary, "background.js"), "utf8"), worker);
    expect(worker.createCore).toBeTypeOf("function");
    expect(initialize).not.toHaveBeenCalled();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
