#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConsumerFixture } from "./consumer-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const toolsRequire = createRequire(new URL("./consumer-tools/package.json", import.meta.url));
const args = process.argv.slice(2);
let suppliedTarball;
let nodeOnly = false;
let browserOnly = false;
let keep = false;
for (let at = 0; at < args.length; at++) {
  if (args[at] === "--tarball" && args[at + 1] && !suppliedTarball) suppliedTarball = resolve(args[++at]);
  else if (args[at] === "--node-only" && !browserOnly) nodeOnly = true;
  else if (args[at] === "--browser-only" && !nodeOnly) browserOnly = true;
  else if (args[at] === "--keep") keep = true;
  else throw new Error("Usage: node scripts/sdk/verify-consumers.mjs [--tarball package.tgz] [--node-only | --browser-only] [--keep]");
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

// The consumer receives recorded inputs and a signed advisory configuration.
// Its decoder, WASM and planner all come from the installed tarball.
async function giwaPlanningFixture() {
  const evidence = JSON.parse(await readFile(join(root, "fixtures/sdk/giwa-sf0/rpc-evidence.json"), "utf8"));
  const requestFor = (hash) => {
    const tx = evidence.queries.find(({ request }) =>
      request.method === "eth_getTransactionByHash" && request.params[0] === hash)?.response.result;
    assert.equal(tx?.hash, hash);
    return { kind: "transaction", chainId: `eip155:${BigInt(tx.chainId)}`, from: tx.from,
      to: tx.to, value: BigInt(tx.value).toString(), data: tx.input };
  };
  const swap = evidence.observations.swap;
  const chainId = Number(evidence.chainId);
  const [quoteToken, token] = swap.path;
  const candidate = { rules: [{ id: "r1", enabled: true, kind: "change_count", metric: "price_quote_per_token",
    lookbackSec: 3600, direction: "either", changeMode: "cumulative", thresholdBps: 500, count: 3 }],
    bucketMs: 1000, gridOriginMs: 0, warmupSec: 86_400, maxDataAgeSec: 30 };
  const presetId = "giwa-consumer";
  const now = Date.now();
  const payload = JSON.stringify({ kind: "scam_bundle", schema: "0.1", sequence: "1",
    issuedAtMs: now - 1000, expiresAtMs: now + 7_200_000, env: "staging", profile: "default",
    compatibility: { engineRange: "*", builderRange: "dambi-v2/2", contractVersion: "0.1",
      algorithm: { id: "dambi.scam.window-rules", version: "0.2.0", contractVersion: 2 } },
    support: [{ chainId, venue: "uniswap_v2", factories: [swap.factory], quoteTokens: [quoteToken],
      exemptTokens: [quoteToken], allowedBucketMs: [1000], confirmDepth: 2 }],
    presets: [{ id: presetId, purpose: "demo",
      selection: { ageThresholdSec: 3600, unknownAge: "new_provisional_insufficient" },
      newMarket: { ...candidate, id: "new" }, established: { ...candidate, id: "established" } }],
    templates: {}, model: null });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signature = sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    request: requestFor("0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9"),
    unrelated: requestFor("0x55f28ca8295e4526361edfc735b3eedb69052051591c52d98fac06b278ef3578"),
    subject: { chainId, venue: "uniswap_v2", factory: swap.factory, pool: swap.pool, token, quoteToken },
    bundle: { payload, signature },
    config: { settings: { enabled: true, presetId, overrides: [], additionalRules: [], locale: "ko" },
      trust: { env: "staging", profile: "default", keys: [{ role: "scam", keyId: "consumer", publicKeySpkiBase64 }] },
      limits: { scamTimeoutMs: 2500, scamEvalReserveMs: 200, maxBundleBytes: 100_000,
        maxResultBytes: 1_000_000, maxCalls: 4, maxTargets: 1, maxRules: 4, maxLogs: 1000,
        maxPoints: 20_000, maxAlgorithmWorkUnits: 100_000_000 } },
  };
}

async function run(command, arguments_, cwd) {
  const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-1_000_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1_000_000); });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} failed (${code}):\n${stdout.trim()}\n${stderr.trim()}`);
  return stdout;
}

async function staticServer(directory, imports, connectOrigins) {
  directory = await realpath(directory);
  // Keep local requests on Chromium's normal network path. Playwright routing
  // auto-fulfills OPTIONS preflights, which would bypass the CORS fixture.
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    `connect-src 'self' ${connectOrigins.join(" ")}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join("; ");
  const assets = [];
  const errors = [];
  const mime = {
    ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  };
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("Content-Security-Policy", contentSecurityPolicy);
      assert.equal(req.method, "GET");
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      if (pathname === "/__consumer.html") {
        res.writeHead(200, { "Content-Type": mime[".html"] });
        res.end(`<!doctype html><meta charset="utf-8"><title>Installed SDK consumer</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">window.consumerReady = import("/consumer-cases.mjs");</script>`);
        return;
      }
      if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      const path = resolve(directory, `.${pathname}`);
      if (!inside(directory, path) || !mime[extname(path)]) { res.writeHead(404); res.end(); return; }
      const canonical = await realpath(path);
      assert.ok(inside(directory, canonical), "Browser assets must come from the isolated installed consumer");
      const bytes = await readFile(canonical);
      assets.push(pathname);
      res.writeHead(200, { "Content-Type": mime[extname(path)], "Cache-Control": "no-store" });
      res.end(bytes);
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("Consumer fixture asset failure");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`, assets,
    async close() {
      const closed = new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
      server.closeAllConnections();
      await closed;
      assert.deepEqual(errors, [], "isolated consumer asset serving must succeed");
    },
  };
}

const temporary = await mkdtemp(join(tmpdir(), "dambi-consumer-"));
let passedGroups = 0;
const passed = (target) => (name) => {
  passedGroups++;
  process.stdout.write(`✔ ${target}: ${name}\n`);
};
try {
  const canonicalTemp = await realpath(temporary);
  assert.ok(!inside(await realpath(root), canonicalTemp), "Consumer must be outside the repository");
  // Missing pinned tools are actionable failures; this runner never installs
  // tooling, downloads Chromium or silently skips the browser target.
  let tsc;
  let chromium;
  try {
    if (!browserOnly) tsc = toolsRequire.resolve("typescript/lib/tsc.js");
    if (!nodeOnly) ({ chromium } = toolsRequire("playwright"));
  } catch {
    throw new Error("Install consumer tooling first: npm ci --prefix scripts/sdk/consumer-tools (and install its Chromium for browser checks).");
  }

  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  // Copy public example sources only, never incidental local credential files.
  for (const name of ["package.json", "tsconfig.json", "consumer-types.ts", "client.mjs", "check-timing.mjs", "node.mjs", "browser.mjs", "index.html"]) {
    await cp(join(root, "examples/sdk-adapters", name), join(consumer, name));
  }
  await cp(new URL("./consumer-cases.mjs", import.meta.url), join(consumer, "consumer-cases.mjs"));
  let tarball = suppliedTarball;
  if (!tarball) {
    // Pack already-built output only. The user/CI controls when builds run.
    const output = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], join(root, "packages/core"));
    const packed = JSON.parse(output);
    assert.equal(packed.length, 1, "Exactly one Core tarball is expected");
    tarball = join(temporary, packed[0].filename);
  }
  assert.ok((await lstat(tarball)).isFile(), "A local Core tarball is required");
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], consumer);

  const installed = join(consumer, "node_modules/@dambi/core");
  assert.equal((await lstat(installed)).isSymbolicLink(), false, "Package must not be a workspace link");
  const installedPath = await realpath(installed);
  assert.equal(installedPath, join(canonicalTemp, "consumer/node_modules/@dambi/core"), "Installed package must remain inside the consumer");
  const packageInfo = JSON.parse(await readFile(join(installedPath, "package.json"), "utf8"));
  assert.equal(packageInfo.name, "@dambi/core");
  const imports = {};
  const giwa = await giwaPlanningFixture();
  for (const name of ["@dambi/core", "@dambi/core/adapters", "@dambi/core/decoders"]) {
    const subpath = name === "@dambi/core" ? "." : `.${name.slice("@dambi/core".length)}`;
    const exported = packageInfo.exports[subpath]?.import;
    assert.ok(typeof exported === "string" && exported.startsWith("./"), `${name} needs a public ESM export`);
    const entry = await realpath(join(installedPath, exported));
    assert.ok(inside(installedPath, entry), `${name} must resolve within the installed tarball`);
    imports[name] = `/${relative(await realpath(consumer), entry).split(sep).join("/")}`;
  }
  if (!browserOnly) {
    const cases = await import(pathToFileURL(join(consumer, "consumer-cases.mjs")).href);
    await run(process.execPath, [tsc, "-p", join(consumer, "tsconfig.json")], consumer);
    passed("types")("standalone public Core, decoder and adapter declarations resolve from the installed tarball");

    const nodeFixture = await createConsumerFixture();
    try {
      await cases.runConsumerCases({ settings: nodeFixture.settings, giwa, control: nodeFixture.control, passed: passed("Node") });
      await nodeFixture.control("reset", { policy: "day1" });
      const settingsPath = join(temporary, "node-settings.json");
      const requestPath = join(temporary, "node-request.json");
      await writeFile(settingsPath, JSON.stringify(nodeFixture.settings), { mode: 0o600 });
      await writeFile(requestPath, JSON.stringify(cases.consumerRequests.approve), { mode: 0o600 });
      const commandVerdict = JSON.parse(await run(process.execPath,
        [join(consumer, "node.mjs"), "--config", settingsPath, "--request", requestPath], consumer));
      assert.equal(commandVerdict.decision, "warn");
      assert.equal(commandVerdict.source, "evaluated");
      assert.ok(commandVerdict.reasons.some((reason) => reason.policyId === "unlimited-approval-deny"));
      assert.equal((await nodeFixture.control("inspect")).rpcRequests.length, 0);
      passed("Node")("documented CLI reads explicit config/request and returns the evaluated verdict");
    } finally { await nodeFixture.close(); }
  }

  if (!nodeOnly) {
    const fixture = await createConsumerFixture();
    let assets;
    let browser;
    try {
      assets = await staticServer(consumer, imports, fixture.origins);
      fixture.setBrowserOrigin(assets.origin);
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: "block" });
      const allowed = new Set([assets.origin, ...fixture.origins]);
      const blocked = [];
      // Observe without intercepting; the page's CSP restricts network access.
      context.on("request", (request) => {
        if (!allowed.has(new URL(request.url()).origin)) blocked.push(request.url());
      });
      await context.addInitScript(() => {
        window.consumerCspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.consumerCspViolations.push(event.effectiveDirective);
        });
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.exposeFunction("consumerControl", fixture.control);
      await page.exposeFunction("consumerPassed", passed("Chromium"));
      await page.goto(`${assets.origin}/__consumer.html`);
      await page.waitForFunction(() => window.consumerReady !== undefined);
      await page.evaluate(async ({ settings, giwa }) => {
        const { runConsumerCases } = await window.consumerReady;
        await runConsumerCases({
          settings, giwa, browser: true,
          control: (action, value) => window.consumerControl(action, value),
          passed: (name) => window.consumerPassed(name),
        });
      }, { settings: fixture.settings, giwa });
      assert.deepEqual(await page.evaluate(() => window.consumerCspViolations), [],
        "CORS cases must not fail because of the local network CSP");
      const approveRequest = await page.evaluate(async () => (await window.consumerReady).consumerRequests.approve);
      await fixture.control("reset", { policy: "day1" });
      await page.goto(`${assets.origin}/index.html`);
      await page.waitForFunction(() => document.querySelector("#settings").value.length > 0);
      const beforeClick = await fixture.control("inspect");
      assert.equal(beforeClick.policyRequests.length, 0, "Example UI must wait for an explicit Check");
      assert.equal(beforeClick.rpcRequests.length, 0, "Example UI must not start RPC on page load");
      await page.locator("#settings").fill(JSON.stringify(fixture.settings));
      await page.locator("#request").fill(JSON.stringify(approveRequest));
      await page.locator("#check").click();
      await page.waitForFunction(() => {
        try { return JSON.parse(document.querySelector("#result").textContent).source === "evaluated"; }
        catch { return false; }
      });
      const displayed = JSON.parse(await page.locator("#result").textContent());
      assert.equal(displayed.decision, "warn");
      assert.ok(displayed.reasons.some((reason) => reason.policyId === "unlimited-approval-deny"));
      assert.equal(await page.locator("#check").isEnabled(), true);
      assert.equal(await page.locator("#cancel").isDisabled(), true);
      assert.equal((await fixture.control("inspect")).rpcRequests.length, 0);
      passed("Chromium")("documented browser UI waits for Check, renders the verdict and restores controls");
      assert.deepEqual(await page.evaluate(() => window.consumerCspViolations), [], "Example UI must satisfy the local network CSP");
      assert.deepEqual(blocked, [], "Consumer browser must never contact external services");
      assert.deepEqual(pageErrors, [], "Browser module execution must succeed");
      assert.ok(assets.assets.some((path) => path.startsWith("/node_modules/@dambi/core/") && path.endsWith(".wasm")),
        "Browser must fetch the installed package's actual WASM asset");
    } finally {
      try { await browser?.close(); }
      finally {
        try { await assets?.close(); }
        finally { await fixture.close(); }
      }
    }
  }
  const scope = browserOnly ? "Chromium only (Node + types not rerun)"
    : nodeOnly ? "Node + types only (browser pending)" : "Node + Chromium + types";
  process.stdout.write(`[consumer] ${passedGroups} groups passed; ${scope}; actual installed Core ${packageInfo.version}.\n`);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`[consumer] FAILED: ${error.stack ?? error.message}\n`);
} finally {
  if (keep) process.stdout.write(`[consumer] retained ${temporary}\n`);
  else await rm(temporary, { recursive: true, force: true });
}
