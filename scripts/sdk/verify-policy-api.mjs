import { readFile } from "node:fs/promises";

// Manual live check only: no builds, signing, publishing, retries or CI auto-run.
// The config pins trust locally. Never derive keys or time from the API response.
class ProbeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function expiryDetails(bundle) {
  try {
    const { issued_at: issuedAt, expires_at: expiresAt } = JSON.parse(bundle.payload);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0
        || issuedAt > Number.MAX_SAFE_INTEGER - 259_200
        || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))) return undefined;
    const now = Date.now();
    const effectiveExpiry = Math.min(expiresAt ?? Infinity, issuedAt + 259_200);
    const utc = (seconds) => {
      const date = new Date(seconds * 1000);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    return {
      diagnosticOnly: true,
      issuedAtUtc: utc(issuedAt),
      expiresAtUtc: expiresAt === null ? null : utc(expiresAt),
      effectiveExpiryUtc: utc(effectiveExpiry),
      localClockUtc: new Date(now).toISOString(),
      ageHours: Math.round((now / 1000 - issuedAt) / 36) / 100,
      expiredBy: [
        ...(now / 1000 >= issuedAt + 259_200 ? ["maximum_age_72h"] : []),
        ...(expiresAt !== null && now / 1000 >= expiresAt ? ["explicit_expires_at"] : []),
      ],
    };
  } catch { return undefined; }
}

const report = { status: "failed", scope: "Node live policy API", phase: "config", http: [], checks: [] };
const hints = {
  POLICY_EXPIRED: "Compare policyTimeDiagnostic with your system clock, then ask the API publisher to confirm a fresh bundle and its republishing schedule. The default 72-hour limit is unchanged.",
  INVALID_SIGNATURE: "Confirm the configured policy public key with the API owner; the response cannot supply a trusted key.",
  POLICY_FETCH_FAILED: "Inspect the HTTP status below and confirm endpoint access. No old bundle is substituted.",
  TIMEOUT: "The policy API did not complete within the configured 10-second deadline.",
  ENGINE_ERROR: "Confirm the existing packaged Core WASM is available. No build is performed by this command.",
};
let core;
let CoreError;
let AdapterError;
let received;

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    throw new ProbeError("USAGE", "Use: npm run core:verify:policy-api -- --config fixtures/sdk/policy-api.staging.json");
  }
  let config;
  try {
    config = JSON.parse(await readFile(args[1], "utf8"));
    if (!config || Array.isArray(config) || typeof config !== "object"
        || Object.keys(config).some((key) => !["baseUrl", "maxResponseBytes", "trust"].includes(key))
        || !config.trust || !["staging", "production"].includes(config.trust.env)
        || config.trust.profile !== "default") throw new Error();
  } catch {
    throw new ProbeError("INVALID_CONFIG", "Use a local config with baseUrl, maxResponseBytes and explicit trust (env, profile, keys).");
  }

  report.phase = "load-package";
  const [runtime, adapters, decoders] = await Promise.all([
    import("@dambi/core"), import("@dambi/core/adapters"), import("@dambi/core/decoders"),
  ]);
  ({ CoreError } = runtime);
  ({ AdapterError } = adapters);
  const policy = adapters.createPolicyApiSource({
    baseUrl: config.baseUrl,
    maxResponseBytes: config.maxResponseBytes,
    profile: config.trust.profile,
    async fetch(url, init) {
      const response = await fetch(url, init);
      const exposed = (response.headers.get("access-control-expose-headers") ?? "")
        .split(",").map((value) => value.trim().toLowerCase());
      report.http.push({
        phase: report.phase,
        status: response.status,
        conditional: new Headers(init.headers).has("if-none-match"),
        etagPresent: response.headers.has("etag"),
        cors: {
          allowOrigin: response.headers.get("access-control-allow-origin"),
          exposeETag: exposed.includes("etag") || exposed.includes("*"),
        },
      });
      // Only the adapter consumes the body, preserving its byte limit and abort handling.
      return response;
    },
  });
  report.endpoint = new URL(config.baseUrl).origin;
  report.phase = "init";
  core = await runtime.createCore({
    decoderSnapshot: decoders.decoderSnapshot,
    trust: config.trust,
    enforcement: "advisory",
    limits: {
      maxPolicyBytes: 1_000_000, maxDecoderBytes: decoders.decoderSnapshotInfo.bytes,
      maxRequestBytes: 256_000, maxFactBytes: 1_000_000, maxPlanCalls: 64, maxPendingPlans: 16,
      allowedClockSkewMs: 60_000, planTtlMs: 60_000, maxFactAgeMs: 60_000,
      factTimeoutMs: 5_000, policyTimeoutMs: 10_000,
    },
    ports: {
      policy: { async fetch(options) { received = await policy.fetch(options); return received; } },
      fact: { async fetch() { throw new Error("The no-Fact probe must not fetch Facts."); } },
    },
  });

  // Decode a mainnet USDC unlimited approve and prove the deployed policy matches.
  // No wallet, signing or chain RPC is involved; this is a local policy evaluation.
  const request = {
    kind: "transaction", chainId: "eip155:1",
    from: "0x000000000000000000000000000000000000aaaa",
    to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    data: `0x095ea7b3${"bbbb".padStart(64, "0")}${"f".repeat(64)}`,
    value: "0",
  };
  for (const phase of ["init", "refresh"]) {
    report.phase = phase;
    if (phase === "refresh") await core.refreshPolicies();
    const plan = await core.plan(request);
    if (plan.calls.length !== 0) throw new ProbeError("POLICY_SMOKE_FAILED", "The approve probe unexpectedly requires Facts.");
    const verdict = core.evaluate(plan, { planId: plan.planId, results: {} });
    if (verdict.source !== "evaluated" || verdict.metadata.status !== "available"
        || !verdict.reasons.some((reason) => reason.policyId === "unlimited-approval-deny")) {
      throw new ProbeError("POLICY_SMOKE_FAILED", "The deployed policy did not evaluate the expected unlimited-approval rule.");
    }
    // Parse metadata only after this exact envelope has passed Core verification.
    const payload = JSON.parse(received.payload);
    report.checks.push({
      phase, policyVersion: verdict.metadata.policyVersion,
      issuedAt: payload.issued_at, expiresAt: payload.expires_at,
      effectiveExpiry: Math.min(payload.expires_at ?? Infinity, payload.issued_at + 259_200),
      decision: verdict.decision, matchedPolicy: "unlimited-approval-deny", factCalls: plan.calls.length,
    });
  }
  report.status = "passed";
  report.phase = "complete";
} catch (error) {
  const known = error instanceof ProbeError
    || (CoreError && error instanceof CoreError) || (AdapterError && error instanceof AdapterError);
  const code = known ? error.code : report.phase === "load-package" ? "PACKAGE_NOT_READY" : "PROBE_FAILED";
  report.error = {
    code,
    hint: error instanceof ProbeError ? error.message : hints[code]
      ?? (code === "PACKAGE_NOT_READY" ? "Use the current built workspace package, including its decoder and WASM assets." : "Confirm the configured environment and existing build; no response body or credentials are logged."),
  };
  // Failure diagnostics only; never promote a rejected envelope into a passed check.
  if (code === "POLICY_EXPIRED") report.policyTimeDiagnostic = expiryDetails(received);
  process.exitCode = 1;
} finally {
  core?.dispose();
  report.notes = ["CORS headers are observations from Node; browser consumption is checked in A3.",
    "Publisher scheduling is not verified by this two-request check."];
  console.log(JSON.stringify(report, null, 2));
}
