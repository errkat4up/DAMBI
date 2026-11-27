// Copied beside the public example into the isolated consumer before execution.
// This module runs unchanged under Node and Chromium; no workspace imports.
import { createAdapterCore } from "./client.mjs";
import { createCore } from "@dambi/core";
import { createPolicyApiSource } from "@dambi/core/adapters";
import { decoderSnapshot } from "@dambi/core/decoders";

const OWNER = "0x000000000000000000000000000000000000aaaa";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const transfer = {
  kind: "transaction", chainId: "eip155:1", from: OWNER, to: TOKEN, value: "0",
  data: `0xa9059cbb${"bbbb".padStart(64, "0")}${"64".padStart(64, "0")}`,
};
const approve = {
  ...transfer, data: `0x095ea7b3${OWNER.slice(2).padStart(64, "0")}${"f".repeat(64)}`,
};
export const consumerRequests = { approve, transfer };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected),
  `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const failClosed = (verdict, code) => {
  equal(verdict.decision, "deny", "failure decision");
  equal(verdict.source, "fail_closed", "failure source");
  check(verdict.diagnostics.some((item) => item.code === code), `Missing failure diagnostic ${code}`);
};

export async function runConsumerCases({ settings, giwa, control, browser = false, passed }) {
  await control("reset", { policy: "day1" });
  let core = await createAdapterCore(settings);
  try {
    const verdict = await core.check(approve);
    equal(verdict.decision, "warn", "Day-1 unlimited approve decision");
    equal(verdict.source, "evaluated", "Day-1 evaluation source");
    check(verdict.reasons.some((reason) => reason.policyId === "unlimited-approval-deny"), "Original Day-1 policy must match");
    equal(verdict.facts, [], "No-Fact approve");
    await core.refreshPolicies();
    const seen = await control("inspect");
    equal(seen.rpcRequests.length, 0, "No-Fact approve must not contact configured RPC");
    equal(seen.policyRequests.map((item) => item.status), [200, 304], "exposed ETag revalidation");
    if (browser) check(seen.preflights.some((item) => item.kind === "policy" && item.headers.includes("if-none-match")),
      "Cross-origin conditional request must pass an If-None-Match preflight");
    await passed("signed Day-1 HTTP policy + packaged decoder/WASM; no-Fact approve and exposed ETag 304");
  } finally { core.dispose(); }

  const policy = createPolicyApiSource(settings.policy);
  let giwaFactFetches = 0;
  core = await createCore({ decoderSnapshot, trust: settings.trust, limits: settings.limits,
    enforcement: settings.enforcement, scam: giwa.config, ports: {
      policy: { fetch: (options) => policy.fetch(options), fetchScam: async () => giwa.bundle },
      fact: { async fetch() {
        giwaFactFetches++;
        throw new Error("GIWA planning and unsupported inputs must not fetch Facts");
      } },
    } });
  try {
    const plan = await core.plan(giwa.request);
    equal(plan.scamCalls.map((call) => call.method), ["scam.pool_history", "scam.token_profile"], "GIWA swap calls");
    for (const call of plan.scamCalls) {
      for (const [field, value] of Object.entries(giwa.subject)) {
        equal(call.params.subject[field], value, `GIWA ${call.method} subject.${field}`);
      }
    }
    let unrelatedCode;
    try { await core.plan(giwa.unrelated); } catch (error) { unrelatedCode = error.code; }
    equal(unrelatedCode, "UNSUPPORTED_REQUEST", "Recorded launchpad request must stay outside product coverage");
    equal(giwa.boundaries.map(({ id }) => id), [
      "other-output-token", "reverse-path", "multihop", "empty-path", "single-token-path",
      "truncated-address", "missing-address-word", "selector-only",
    ], "shared GIWA boundary corpus");
    const encodePath = (path) => {
      equal(BigInt(`0x${giwa.request.data.slice(74, 138)}`).toString(), "128", "recorded ABI path offset");
      for (const address of path) check(/^0x[0-9a-f]{40}$/.test(address), "boundary token address");
      return giwa.request.data.slice(0, 10 + 4 * 64)
        + path.length.toString(16).padStart(64, "0")
        + path.map((address) => address.slice(2).padStart(64, "0")).join("");
    };
    equal(encodePath([giwa.subject.quoteToken, giwa.subject.token]), giwa.request.data,
      "boundary encoder reproduces recorded positive calldata");
    for (const entry of giwa.boundaries) {
      const data = entry.expected === "unknown" ? encodePath(entry.path)
        : entry.keepBytes === undefined ? giwa.request.data.slice(0, -entry.truncateBytes * 2)
          : giwa.request.data.slice(0, 2 + entry.keepBytes * 2);
      const request = { ...giwa.request, data };
      equal(request.chainId, "eip155:91342", `${entry.id} chain`);
      equal(request.to, giwa.request.to, `${entry.id} router`);
      equal(data.slice(0, 10), "0x7ff36ab5", `${entry.id} selector`);
      check(data !== giwa.request.data, `${entry.id} must mutate the raw input`);
      if (entry.expected === "unknown") {
        // These inputs match the installed manifest but not its supported path.
        // They must remain plannable Unknown actions, not ordinary swaps, and
        // cannot inherit the positive request's fixed pool/factory route.
        const unsupportedPlan = await core.plan(request);
        equal(unsupportedPlan.scamCalls, [], `${entry.id}: no scam target, including the recorded pool`);
        equal(unsupportedPlan.calls, [], `${entry.id}: no policy Facts`);
        const verdict = await core.evaluate(unsupportedPlan, { planId: unsupportedPlan.planId, results: {} });
        equal(verdict.decision, "warn", `${entry.id}: Unknown warning`);
        check(verdict.source !== "fail_closed", `${entry.id}: valid ABI must not become a decoding error`);
        check(verdict.reasons.some((reason) => reason.policyId === "unknown-blind-sign-warning"),
          `${entry.id}: original Unknown policy must explain unsupported decoding`);
        const automatic = await core.check(request);
        equal(automatic.decision, "warn", `${entry.id}: automatic Unknown warning`);
        check(automatic.reasons.some((reason) => reason.policyId === "unknown-blind-sign-warning"),
          `${entry.id}: check must preserve the Unknown warning`);
      } else {
        equal(entry.expected, "malformed", `${entry.id}: fixture expectation`);
        let malformedError;
        let unexpectedPlan;
        try { unexpectedPlan = await core.plan(request); } catch (error) { malformedError = error; }
        // Assert no calls even before rejecting an accidentally issued plan.
        if (unexpectedPlan) equal(unexpectedPlan.scamCalls, [], `${entry.id}: malformed input leaked a scam target`);
        check(!unexpectedPlan && typeof malformedError?.code === "string", `${entry.id}: malformed ABI must reject plan`);
        check(malformedError.code !== "UNSUPPORTED_REQUEST", `${entry.id}: known malformed ABI is not an unmatched route`);
        const verdict = await core.check(request);
        equal(verdict.decision, "deny", `${entry.id}: malformed check decision`);
        equal(verdict.source, "fail_closed", `${entry.id}: malformed check source`);
        check(verdict.diagnostics.length > 0, `${entry.id}: malformed check needs an explicit diagnostic`);
      }
      equal(giwaFactFetches, 0, `${entry.id}: neither policy nor scam provider may be called`);
    }
    await passed("packaged GIWA decoder plans the recorded pool only; all path defaults and truncated ABI remain explicit and produce no scam calls");
  } finally { core.dispose(); }

  await control("reset", { policy: "optional" });
  core = await createAdapterCore(settings);
  try {
    const began = Date.now();
    const verdict = await core.check(transfer);
    equal(verdict.decision, "warn", "full balance transfer decision");
    equal(verdict.source, "evaluated", "full balance transfer evaluation source");
    check(verdict.reasons.some((reason) => reason.policyId === "transfer-full-balance-sweep"), "Original catalog policy must match");
    equal(verdict.facts.length, 1, "projected Fact count");
    const fact = verdict.facts[0];
    equal(fact.value, { balance: "0x64" }, "U256 balance projection");
    equal(fact.blockNumber, "20000000", "pinned block");
    equal(fact.source, "onchain:eip155:1:eth_call", "Fact provenance");
    check(Number.isSafeInteger(fact.observedAt) && fact.observedAt >= began && fact.observedAt <= Date.now(), "actual observation time");
    const seen = await control("inspect");
    equal(seen.rpcRequests.map((item) => item.method), ["eth_chainId", "eth_blockNumber", "eth_call"], "RPC read sequence");
    if (browser) check(seen.preflights.some((item) => item.kind === "rpc" && item.headers.includes("content-type")),
      "Cross-origin JSON RPC must pass a Content-Type preflight");
    await passed("both HTTP ports project a pinned balance Fact into the original catalog policy");
  } finally { core.dispose(); }

  await control("reset", { policy: "required", rpcMode: "revert" });
  core = await createAdapterCore(settings);
  try {
    failClosed(await core.check(transfer), "required_fact_missing");
    await control("mode", "outage");
    failClosed(await core.check(transfer), "fact_fetch_failed");
    await control("mode", "balance");
    const held = await control("hold");
    const controller = new AbortController();
    const pending = core.check(transfer, { signal: controller.signal });
    await control("waitHeld", held);
    controller.abort();
    failClosed(await pending, "aborted");
    await control("waitClosed", held);
    const before = (await control("inspect")).rpcRequests.length;
    const recovered = await core.check(transfer);
    equal(recovered.decision, "warn", "recovered required Fact decision");
    equal(recovered.facts.length, 1, "recovered required Fact");
    equal((await control("inspect")).rpcRequests.length, before + 3, "failed or cancelled work must not seed the cache");
    await passed("required Fact omissions/outages fail closed; observed pending HTTP aborts and recovers");
  } finally { core.dispose(); }

  if (browser) {
    await control("reset", { policy: "day1", exposeEtag: false });
    core = await createAdapterCore(settings);
    try {
      await core.refreshPolicies();
      const seen = await control("inspect");
      equal(seen.policyRequests, [{ conditional: null, status: 200 }, { conditional: null, status: 200 }],
        "Unexposed ETag must use ordinary 200 responses");
    } finally { core.dispose(); }

    await control("reset", { policy: "day1", policyCors: false });
    let rejected;
    try { core = await createAdapterCore(settings); core.dispose(); }
    catch (error) { rejected = error.code; }
    equal(rejected, "POLICY_FETCH_FAILED", "CORS-blocked policy must reject initialization");
    equal((await control("inspect")).rpcRequests.length, 0, "Blocked policy cannot silently fall back or run Facts");

    await control("reset", { policy: "required", rpcCors: false });
    core = await createAdapterCore(settings);
    try {
      failClosed(await core.check(transfer), "fact_fetch_failed");
      const seen = await control("inspect");
      check(seen.preflights.some((item) => item.kind === "rpc"), "Blocked RPC must attempt the real browser preflight");
      equal(seen.rpcRequests.length, 0, "CORS denial must block RPC POST instead of falling back");
    } finally { core.dispose(); }
    await passed("browser hidden ETag uses 200; policy and RPC CORS denial cannot silently fall back");
  }
  equal((await control("inspect")).errors, [], "HTTP fixture assertions");
}
