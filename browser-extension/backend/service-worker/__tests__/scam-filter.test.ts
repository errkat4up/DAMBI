// @vitest-environment node
// Worker lifecycle tests need native AbortSignal/EventTarget, not a DOM window.
// happy-dom subclasses AbortSignal, so its immediate prototype has no aborted getter.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallOptions, CheckRequest, CorePlan, DambiCore, ScamReport, Verdict } from "@dambi/core";
import type { ScamFactProvider } from "@dambi/core/adapters";
import { RequestType, type Message, type TransactionPayload } from "@lib/types";
import { createScamHost } from "../scam-filter";

// These tests inject readConfig/open into createScamHost. Importing the module
// must not load the extension-only polyfill or silently use real host storage.
vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: { get: () => { throw new Error("Host tests must inject readConfig"); } },
      onChanged: { addListener: () => { throw new Error("Host tests use an isolated instance"); } },
    },
  },
}));

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const report: ScamReport = {
  status: "insufficient", reasons: ["algorithm_unavailable"], targets: [],
  scopeNotice: "patterns_only_no_sellability_guarantee",
};
const verdict = { scam: report } as Verdict;
function message(): Message & { data: TransactionPayload } {
  return { requestId: "scam-request", data: { type: RequestType.TRANSACTION, chainId: 1, hostname: "dapp.example",
    transaction: { from: FROM, to: TO, data: "0x1234", value: "0x2a" } } };
}

// Adapter construction is replaced by open() in these host lifecycle tests.
// These placeholders are never installed as keys or sent to an endpoint.
function config() {
  return { version: 1, mode: "local-demo",
    policy: { source: { baseUrl: "http://localhost:8000" }, trust: { env: "staging", keys: [{}] }, limits: {} },
    scam: { source: { baseUrl: "http://localhost:8000", env: "staging" }, config: {
      trust: { env: "staging", keys: [{}] }, settings: { presetId: "explicit-demo" }, limits: {},
    } }, facts: { policy: {}, scam: { rpc: {} } },
  };
}

function runtime() {
  const core = {
    check: vi.fn<(request: CheckRequest, options?: CallOptions) => Promise<Verdict>>(async () => verdict),
    plan: vi.fn<(request: CheckRequest, options?: CallOptions) => Promise<CorePlan>>(),
    evaluate: vi.fn(() => verdict),
    dispose: vi.fn(), setScamSettings: vi.fn(), refreshPolicies: vi.fn(), refreshScam: vi.fn(),
  } satisfies DambiCore;
  const provider = { fetch: vi.fn(), prepare: vi.fn(async () => undefined) } satisfies ScamFactProvider;
  return { core, provider };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

describe("optional Scam Filter host", () => {
  it("does no SDK work when local configuration is absent", async () => {
    const open = vi.fn();
    const host = createScamHost({ readConfig: async () => undefined, open });
    host.warm();
    expect(await host.begin(message()).promise).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports invalid local configuration and initialization failure separately", async () => {
    const invalid = createScamHost({ readConfig: async () => null, open: vi.fn() });
    expect(await invalid.begin(message()).promise).toMatchObject({ kind: "unavailable", reason: "invalid_configuration" });
    const open = vi.fn().mockRejectedValueOnce(new Error("unreachable source")).mockResolvedValueOnce(runtime());
    const failed = createScamHost({ readConfig: async () => config(), open });
    expect(await failed.begin(message()).promise).toMatchObject({ kind: "unavailable", reason: "initialization_failed" });
    expect(await failed.begin(message()).promise).toMatchObject({ kind: "report" });
    expect(open).toHaveBeenCalledTimes(2);
    failed.invalidate();
  });

  it("copies the original request before awaits and returns only the SDK scam report", async () => {
    const sdk = runtime();
    const open = vi.fn(async () => sdk);
    const host = createScamHost({ readConfig: async () => config(), open });
    const input = message();
    const check = host.begin(input);
    input.data.transaction.data = "0xffff";
    input.data.chainId = 2;
    expect(await check.promise).toEqual({ version: 1, kind: "report", report, holding: "unknown" });
    expect(sdk.core.check).toHaveBeenCalledWith({ kind: "transaction", chainId: "eip155:1", from: FROM, to: TO, data: "0x1234", value: "42" }, { signal: expect.any(AbortSignal) });
    await host.begin(message()).promise;
    expect(open).toHaveBeenCalledTimes(1);
    expect(input.data.transaction.value).toBe("0x2a");
    host.invalidate();
  });

  it("does not invent a missing signer or convert an unsupported venue request", async () => {
    const sdk = runtime();
    const host = createScamHost({ readConfig: async () => config(), open: async () => sdk });
    const missing = message();
    delete missing.data.transaction.from;
    expect(await host.begin(missing).promise).toMatchObject({ kind: "unavailable", reason: "invalid_request" });
    const venue: Message = { requestId: "venue", data: { type: RequestType.VENUE_ORDER, hostname: "venue.example", chainId: 0,
      venue: "hyperliquid", endpoint: "https://venue.example/exchange", hlAction: { kind: "unknown", actionType: "other" } } };
    expect(await host.begin(venue).promise).toMatchObject({ kind: "unavailable", reason: "unsupported_request" });
    expect(sdk.core.check).not.toHaveBeenCalled();
    host.invalidate();
  });

  it("includes storage reading in the deadline and rejects completions ahead of a delayed timer", async () => {
    vi.useFakeTimers();
    const reading = deferred<unknown>();
    const open = vi.fn(async () => runtime());
    const host = createScamHost({ readConfig: () => reading.promise, open });
    const checking = host.begin(message());
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await checking.promise).toMatchObject({ reason: "timeout" });
    reading.resolve(config());
    await flush();
    expect(open).not.toHaveBeenCalled();

    const lateInit = runtime();
    const initializing = createScamHost({ readConfig: async () => config(), open: async () => {
      vi.setSystemTime(Date.now() + 2_501);
      return lateInit;
    } });
    expect(await initializing.begin(message()).promise).toMatchObject({ reason: "timeout" });
    expect(lateInit.core.check).not.toHaveBeenCalled();
    initializing.invalidate();

    const lateCheck = runtime();
    lateCheck.core.check.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 2_501);
      return verdict;
    });
    const checkingLate = createScamHost({ readConfig: async () => config(), open: async () => lateCheck });
    expect(await checkingLate.begin(message()).promise).toMatchObject({ reason: "timeout" });
    expect(lateCheck.core.check.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    checkingLate.invalidate();
  });

  it("cancels one caller without cancelling another caller or their shared instance", async () => {
    const sdk = runtime();
    const replies = [deferred<Verdict>(), deferred<Verdict>()];
    sdk.core.check.mockImplementationOnce(() => replies[0]!.promise).mockImplementationOnce(() => replies[1]!.promise);
    const open = vi.fn(async () => sdk);
    const host = createScamHost({ readConfig: async () => config(), open });
    const first = host.begin(message());
    const second = host.begin(message());
    await flush();
    expect(sdk.core.check).toHaveBeenCalledTimes(2);
    first.cancel();
    expect(await first.promise).toMatchObject({ reason: "aborted" });
    expect(sdk.core.check.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(sdk.core.check.mock.calls[1]![1]!.signal!.aborted).toBe(false);
    replies[0]!.resolve(verdict); // A late result cannot replace the cancelled display.
    replies[1]!.resolve(verdict);
    expect(await second.promise).toMatchObject({ kind: "report", report });
    expect(await first.promise).toMatchObject({ reason: "aborted" });
    expect(sdk.core.dispose).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    host.invalidate();
  });

  it("invalidates in-flight checks and disposes the old instance on configuration replacement", async () => {
    const old = runtime(), next = runtime();
    const pending = deferred<Verdict>();
    old.core.check.mockReturnValue(pending.promise);
    const open = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    const host = createScamHost({ readConfig: async () => config(), open });
    const checking = host.begin(message());
    await flush();
    host.invalidate();
    expect(await checking.promise).toMatchObject({ reason: "aborted" });
    expect(old.core.dispose).toHaveBeenCalledTimes(1);
    pending.resolve(verdict);
    expect(await host.begin(message()).promise).toMatchObject({ kind: "report" });
    expect(open).toHaveBeenCalledTimes(2);
    host.invalidate();
  });

  it("warms only explicit requests, consumes preparation handles, and checks with a fresh request", async () => {
    const sdk = runtime();
    const calls = [{ callId: "scam-call", method: "scam.pool_history" }];
    const plan = { planId: "prepare-only", calls: [], scamCalls: calls, expiresAt: Date.now() + 60_000 } as unknown as CorePlan;
    sdk.core.plan.mockResolvedValue(plan);
    const settings = { ...config(), prepare: [{ kind: "transaction", chainId: "eip155:1", from: FROM, to: TO, data: "0x1234" }] };
    const host = createScamHost({ readConfig: async () => settings, open: async () => sdk });
    host.warm();
    await flush();
    expect(sdk.core.evaluate).toHaveBeenCalledWith(plan, { planId: "prepare-only", results: {} });
    expect(sdk.provider.prepare).toHaveBeenCalledWith(calls, { planId: "prepare-only", signal: expect.any(AbortSignal), timeoutMs: 60_000 });
    expect(sdk.core.check).not.toHaveBeenCalled();
    await host.begin(message()).promise;
    expect(sdk.core.check).toHaveBeenCalledTimes(1);
    host.invalidate();
  });

  it("does not prepare market data when the SDK has no scam calls", async () => {
    const sdk = runtime();
    sdk.core.plan.mockResolvedValue({ planId: "no-algorithm", calls: [], scamCalls: [], expiresAt: Date.now() + 60_000 } as unknown as CorePlan);
    const host = createScamHost({ readConfig: async () => ({ ...config(), prepare: [{ kind: "transaction", chainId: "eip155:1", from: FROM }] }), open: async () => sdk });
    host.warm();
    await flush();
    expect(sdk.provider.prepare).not.toHaveBeenCalled();
    host.invalidate();
  });
});
