#!/usr/bin/env node
// Development-only diagnostic bundle. It is never added to the extension's
// production entry, manifest or packaged background worker.
const fs = require("node:fs");
const path = require("node:path");
const webpack = require("webpack");

const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const entry = path.join(__dirname, "scam-sw-probe.mjs");
const adapterEntry = path.join(repoRoot, "packages/core/dist/adapters/index.js");
const outputPath = path.join(extensionRoot, "dist/diagnostics");
const outputName = "scam-sw-probe.js";

for (const required of [entry, adapterEntry]) {
  if (!fs.existsSync(required)) {
    console.error(`[scam-sw-probe] Missing ${path.relative(repoRoot, required)}.`);
    if (required === adapterEntry) {
      console.error("Build the Core TypeScript adapters first: yarn workspace @dambi/core exec tsc -p tsconfig.build.json");
    }
    process.exit(1);
  }
}

const compiler = webpack({
  mode: "production",
  context: repoRoot,
  target: "webworker",
  entry,
  // No eval-based source maps: this is pasted into an extension Service Worker.
  devtool: false,
  output: {
    path: outputPath,
    filename: outputName,
    clean: false,
    iife: true,
    globalObject: "globalThis",
    publicPath: "",
    chunkLoading: false,
    workerChunkLoading: false,
  },
  resolve: {
    // Use the current workspace adapter output, not a separately installed SDK.
    alias: { "@dambi/core/adapters$": adapterEntry },
    extensions: [".mjs", ".js", ".json"],
  },
  node: false,
  optimization: {
    minimize: false,
    splitChunks: false,
    runtimeChunk: false,
    emitOnErrors: false,
  },
  plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
  performance: false,
});

compiler.run((error, stats) => {
  compiler.close((closeError) => {
    if (error || closeError) {
      console.error(`[scam-sw-probe] Build failed: ${(error || closeError).message}`);
      process.exitCode = 1;
      return;
    }
    if (!stats || stats.hasErrors()) {
      console.error(stats?.toString({ all: false, errors: true, errorDetails: false }) || "[scam-sw-probe] No build result.");
      process.exitCode = 1;
      return;
    }
    if (stats.hasWarnings()) console.warn(stats.toString({ all: false, warnings: true }));
    console.log(`[scam-sw-probe] Wrote ${path.relative(repoRoot, path.join(outputPath, outputName))}`);
    console.log("Paste this development-only bundle into the Dambi Service Worker DevTools console.");
  });
});
