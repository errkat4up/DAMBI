import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

// Manual read-only probe. The locally signed test policy is never published;
// the transaction is decoded/evaluated locally and is never signed or submitted.
class ProbeError extends Error {
  constructor(code, hint) { super(hint); this.code = code; }
}
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const address = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(value);
const requireCheck = (condition, code, hint) => { if (!condition) throw new ProbeError(code, hint); };
const report = {
  status: "failed", scope: "Node Core + EVM RPC", phase: "config", policySource: "local-test-fixture",
  rpc: { adapter: { eth_chainId: 0, eth_blockNumber: 0, eth_call: 0 }, comparison: { eth_chainId: 0, eth_call: 0 } },
  http: [],
};
const hints = {
  INVALID_CONFIG: "Use an explicit local config with a valid HTTPS RPC endpoint, Ethereum mainnet chain, addresses, byte limit and timeout.",
  NETWORK_ERROR: "Confirm RPC reachability and access. Redirects and retries are disabled.",
  HTTP_ERROR: "Confirm RPC access and rate limits using the HTTP status in this report.",
  RESPONSE_TOO_LARGE: "The RPC response exceeded the configured byte limit.",
  INVALID_RESPONSE: "The RPC response did not satisfy the expected chain, JSON-RPC or ABI contract.",
  RPC_ERROR: "The RPC endpoint rejected a read request; no missing balance is replaced with zero.",
  TIMEOUT: "The probe did not complete within the configured global deadline.",
  PACKAGE_NOT_READY: "Build the current workspace Core package with its decoder and WASM assets before running this command.",
};
let core, deadline, timer, CoreError, AdapterError;

try {
  const args = process.argv.slice(2);
  requireCheck(args.length === 2 && args[0] === "--config" && args[1], "USAGE",
    "Use: npm run core:verify:evm-fact -- --config <local-config.json>");
  let config;
  try {
    config = JSON.parse(await readFile(args[1], "utf8"));
    if (!record(config) || Object.keys(config).some((key) => ![
      "chainId", "rpcUrl", "headers", "owner", "token", "maxResponseBytes", "timeoutMs",
    ].includes(key)) || config.chainId !== "eip155:1" || typeof config.rpcUrl !== "string"
        || !address(config.owner) || !address(config.token)
        || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1
        || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000
        || (config.headers !== undefined && (!record(config.headers)
          || Object.values(config.headers).some((value) => typeof value !== "string")))) throw new Error();
  } catch { throw new ProbeError("INVALID_CONFIG", hints.INVALID_CONFIG); }

  report.phase = "load-package";
  const [runtime, adapters, decoders, transport, fixture] = await Promise.all([
    import("@dambi/core"), import("@dambi/core/adapters"), import("@dambi/core/decoders"),
    import("../../packages/core/dist/adapters/http.js"), import("./balance-policy-fixture.mjs"),
  ]);
  ({ CoreError } = runtime);
  ({ AdapterError } = adapters);
  const requests = [];
  const provider = adapters.createEvmFactProvider({
    chains: { [config.chainId]: { rpcUrl: config.rpcUrl, headers: config.headers } },
    maxResponseBytes: config.maxResponseBytes,
    async fetch(url, init) {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (Object.hasOwn(report.rpc.adapter, request.method)) report.rpc.adapter[request.method]++;
      const response = await fetch(url, init);
      report.http.push({ phase: "adapter", method: request.method, status: response.status });
      return response;
    },
  });
  const hostname = new URL(config.rpcUrl).hostname;
  report.connection = hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname)
    ? "loopback-fixture" : "remote-rpc";
  deadline = new AbortController();
  timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  const signal = deadline.signal;
  const local = await fixture.createBalancePolicyFixture();
  const captures = [];
  let factFailure;
  report.phase = "init";
  core = await runtime.createCore({
    decoderSnapshot: decoders.decoderSnapshot, trust: local.trust, enforcement: "advisory",
    limits: {
      allowedClockSkewMs: 5_000, maxPolicyBytes: 1_000_000, maxDecoderBytes: decoders.decoderSnapshotInfo.bytes,
      maxRequestBytes: 100_000, maxFactBytes: 100_000, maxPlanCalls: 8, maxPendingPlans: 4,
      planTtlMs: Math.max(60_000, config.timeoutMs), maxFactAgeMs: Math.max(60_000, config.timeoutMs),
      factTimeoutMs: config.timeoutMs, policyTimeoutMs: config.timeoutMs,
    },
    ports: {
      policy: { async fetch() { return local.policy; } },
      fact: { async fetch(calls, options) {
        const capture = { calls: structuredClone(calls), planId: options.planId, startedAt: Date.now() };
        captures.push(capture);
        try {
          const batch = await provider.fetch(calls, options);
          capture.batch = structuredClone(batch);
          capture.completedAt = Date.now();
          return batch;
        } catch (error) { factFailure = error; throw error; }
      } },
    },
  }, { signal });
  report.phase = "check";
  const verdict = await core.check(fixture.makeTransferRequest({ owner: config.owner, token: config.token }), { signal });
  if (signal.aborted || verdict.diagnostics.some(({ code }) => code === "timeout")) {
    throw new ProbeError("TIMEOUT", hints.TIMEOUT);
  }
  if (factFailure) throw factFailure;
  const checkFact = (condition) => requireCheck(condition, "FACT_CHECK_FAILED",
    "Core must plan one optional ERC-20 balance call and retain its exact successful Fact and policy decision.");
  checkFact(captures.length === 1 && captures[0].calls.length === 1);
  const capture = captures[0];
  const call = capture.calls[0];
  checkFact(call.manifestId === local.policyId && call.method === "portfolio.balance" && call.optional === true
    && call.params.chain_id === config.chainId && call.params.owner.toLowerCase() === config.owner.toLowerCase()
    && call.params.asset.key.standard === "erc20" && call.params.asset.key.chain === config.chainId
    && call.params.asset.key.address.toLowerCase() === config.token.toLowerCase()
    && isDeepStrictEqual(call.outputs, [{ kind: "context", field: "balance", type: "String", from: "$.result.balance", required: false }]));
  checkFact(capture.batch?.planId === capture.planId && typeof capture.planId === "string"
    && capture.planId.length > 0 && Object.keys(capture.batch.results).length === 1
    && Object.hasOwn(capture.batch.results, call.callId));
  const fact = capture.batch.results[call.callId];
  checkFact(record(fact.value) && Object.keys(fact.value).length === 1
    && typeof fact.value.balance === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})(?![\s\S])/.test(fact.value.balance)
    && typeof fact.blockNumber === "string" && /^(?:0|[1-9][0-9]*)(?![\s\S])/.test(fact.blockNumber)
    && fact.source === "onchain:eip155:1:eth_call" && Number.isSafeInteger(fact.observedAt)
    && fact.observedAt >= capture.startedAt && fact.observedAt <= capture.completedAt
    && isDeepStrictEqual(verdict.facts, [fact]));
  const expectedWarning = fact.value.balance === "0x64";
  checkFact(verdict.source === "evaluated" && verdict.metadata.status === "available"
    && verdict.diagnostics.length === 0 && verdict.decision === (expectedWarning ? "warn" : "allow")
    && (expectedWarning ? verdict.reasons.length === 1 && verdict.reasons[0].policyId === local.policyId
      : verdict.reasons.length === 0));

  // Independent ABI encoding/response parsing: reuse only bounded HTTP reading,
  // not the adapter's JSON-RPC or balance codec under verification.
  const block = `0x${BigInt(fact.blockNumber).toString(16)}`;
  const transaction = { to: config.token.toLowerCase(), data: `0x70a08231${config.owner.slice(2).toLowerCase().padStart(64, "0")}` };
  checkFact(requests.length === 3 && requests[0].method === "eth_chainId" && requests[1].method === "eth_blockNumber"
    && requests[2].method === "eth_call" && isDeepStrictEqual(requests[2].params, [transaction, block]));
  report.phase = "compare";
  const headers = new Headers(config.headers);
  headers.set("accept", "application/json"); headers.set("content-type", "application/json");
  const checkComparison = (condition) => requireCheck(condition, "RPC_COMPARISON_FAILED",
    "The independent read must return mainnet and the identical 32-byte balance at the Fact's explicit block.");
  async function direct(method, params) {
    const id = `probe-comparison:${method}`;
    report.rpc.comparison[method]++;
    const response = await transport.fetchText(async (url, init) => {
      const received = await fetch(url, init);
      report.http.push({ phase: "comparison", method, status: received.status });
      return received;
    }, config.rpcUrl, {
      method: "POST", headers: new Headers(headers), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error", credentials: "omit", cache: "no-store",
    }, config.maxResponseBytes, signal);
    let envelope;
    try { envelope = JSON.parse(response.text); } catch { checkComparison(false); }
    checkComparison(record(envelope) && envelope.jsonrpc === "2.0" && envelope.id === id
      && Object.hasOwn(envelope, "result") && !Object.hasOwn(envelope, "error"));
    return envelope.result;
  }
  const chain = await direct("eth_chainId", []);
  checkComparison(typeof chain === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(chain) && BigInt(chain) === 1n);
  const word = await direct("eth_call", [transaction, block]);
  checkComparison(typeof word === "string" && /^0x[0-9a-fA-F]{64}(?![\s\S])/.test(word) && BigInt(word) === BigInt(fact.value.balance));
  if (signal.aborted) throw new ProbeError("TIMEOUT", hints.TIMEOUT);
  report.fact = { chainId: config.chainId, blockNumber: fact.blockNumber, balance: fact.value.balance,
    observedAt: fact.observedAt, source: fact.source };
  report.decision = verdict.decision;
  report.matchedPolicy = expectedWarning ? local.policyId : null;
  report.status = "passed";
  report.phase = "complete";
} catch (error) {
  const known = error instanceof ProbeError || (CoreError && error instanceof CoreError)
    || (AdapterError && error instanceof AdapterError);
  const code = deadline?.signal.aborted ? "TIMEOUT" : known ? error.code
    : report.phase === "load-package" ? "PACKAGE_NOT_READY" : "PROBE_FAILED";
  report.error = { code, hint: code === "TIMEOUT" ? hints.TIMEOUT
    : error instanceof ProbeError ? error.message : hints[code]
      ?? "Confirm the local config and current built package. Endpoint, credentials and response contents are omitted." };
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  core?.dispose();
  report.notes = ["RPC reads disclose the queried owner and token to the configured provider.",
    "Same-block agreement checks consistency; it does not authenticate RPC data or prove block finality.",
    "This command evaluates a local test policy; it does not verify the policy API or browser consumption."];
  console.log(JSON.stringify(report, null, 2));
}
