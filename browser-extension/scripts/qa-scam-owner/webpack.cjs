// Invoke from browser-extension after preparing its normal CI WASM, SDK and defaults.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
module.exports = () => {
  if (process.env.TARGET_BROWSER !== "chrome" || process.env.DAMBI_STRIP_CONSOLE === "1" ||
      (process.env.DAMBI_EXTENSION_DIST_TARGET && process.env.DAMBI_EXTENSION_DIST_TARGET !== "chrome")) {
    throw new Error("This comparison requires the ordinary development Chrome artifact.");
  }
  const input = fs.realpathSync(process.env.QA_SCAM_OWNER_INPUT);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "dambi-qa-scam-owner-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(input, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || manifest.background.service_worker !== "js/background.js" ||
      manifest.permissions.includes("offscreen")) throw new Error("Unexpected comparison baseline.");
  fs.cpSync(input, output, { recursive: true });
  manifest.permissions.push("offscreen");
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(output, "qa-scam-owner.html"), '<!doctype html><meta charset="utf-8"><script defer src="js/qa-scam-broker.js"></script>');
  const sw = require("../../webpack/webpack.prod").find(config => config.name === "sw");
  const host = path.resolve(__dirname, "../../backend/service-worker/scam-filter.ts");
  const config = {
    ...sw, name: "qa-scam-owner", dependencies: [],
    entry: { ...sw.entry, "qa-scam-provider": path.join(__dirname, "provider.js"), "qa-scam-broker": path.join(__dirname, "broker.js") },
    output: { ...sw.output, path: output, clean: false },
    module: { ...sw.module, rules: [...sw.module.rules, { include: host, enforce: "post", use: path.join(__dirname, "wire-loader.cjs") }] },
  };
  console.log("Chrome QA comparison output:", output);
  return config;
};
