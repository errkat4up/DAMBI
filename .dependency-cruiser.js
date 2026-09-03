const path = require("node:path");

/**
 * Dependency-cruiser configuration for the Phase 0 SDK-boundary measurement.
 * Keep TypeScript path aliases aligned with browser-extension/tsconfig.json.
 */
module.exports = {
  forbidden: [],
  options: {
    doNotFollow: { path: "node_modules" },
    baseDir: path.join(__dirname, "browser-extension"),
    tsConfig: { fileName: path.join(__dirname, "browser-extension/tsconfig.json") },
    webpackConfig: {
      fileName: path.join(__dirname, "browser-extension/webpack/webpack.common.js"),
      env: { TARGET_BROWSER: "chrome" },
    },
  },
};
