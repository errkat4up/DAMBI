import Browser from "webextension-polyfill";
import { createCore, type CheckRequest, type CoreLimits, type CoreTrust, type DambiCore, type ScamConfig } from "@dambi/core";
import { decoderSnapshot } from "@dambi/core/decoders";
import {
  createPolicyApiSource, createScamBundleApiSource, createEvmFactProvider, createScamFactProvider,
  type PolicyApiSourceOptions, type ScamBundleApiSourceOptions, type EvmFactProviderOptions,
  type ScamFactProviderOptions, type ScamFactProvider,
} from "@dambi/core/adapters";
import { RequestType, type Message } from "@lib/types";
import type { ScamDisplay } from "@lib/scam-display";

export const SCAM_HOST_CONFIG_KEY = "scam-filter:host-config";
const CHECK_TIMEOUT_MS = 2_500;
const PREPARE_TIMEOUT_MS = 60_000;
type UnavailableReason = Extract<ScamDisplay, { kind: "unavailable" }>["reason"];
type JsonPolicySource = Omit<PolicyApiSourceOptions, "fetch">;
type JsonScamSource = Omit<ScamBundleApiSourceOptions, "fetch">;
type JsonPolicyFacts = Omit<EvmFactProviderOptions, "fetch" | "clock">;
type JsonScamFacts = Omit<ScamFactProviderOptions, "policy" | "onMetrics" | "rpc"> & {
  readonly rpc: Omit<ScamFactProviderOptions["rpc"], "fetch" | "clock">;
};

/** Explicit local/demo deployment input. No embedded keys, endpoints or fixtures. */
export interface ScamHostConfig {
  readonly version: 1;
  readonly mode: "local-demo";
  readonly policy: { readonly source: JsonPolicySource; readonly trust: CoreTrust; readonly limits: CoreLimits };
  readonly scam: { readonly source: JsonScamSource; readonly config: ScamConfig };
  readonly facts: { readonly policy: JsonPolicyFacts; readonly scam: JsonScamFacts };
  readonly prepare?: readonly CheckRequest[];
}

interface HostRuntime { readonly core: DambiCore; readonly provider: ScamFactProvider }
interface HostDependencies {
  readConfig(): Promise<unknown>;
  open?(config: ScamHostConfig, signal: AbortSignal): Promise<HostRuntime>;
}
interface Session {
  readonly fingerprint: string;
  readonly config: ScamHostConfig;
  readonly controller: AbortController;
  readonly callers: Set<AbortController>;
  readonly ready: Promise<HostRuntime>;
  runtime?: HostRuntime;
  preparation?: AbortController;
  preparationStarted: boolean;
}

class HostFailure extends Error {
  constructor(readonly reason: UnavailableReason) { super(reason); }
}
const unavailable = (reason: UnavailableReason): ScamDisplay => ({ version: 1, kind: "unavailable", reason, holding: "unknown" });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

function copyJson<T>(value: T): T {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "function" || typeof item === "bigint" || typeof item === "symbol"
        || typeof item === "number" && !Number.isFinite(item)) throw new Error("Not JSON");
    return item;
  });
  if (!json || json.length > 1_000_000) throw new Error("Invalid JSON size");
  return JSON.parse(json) as T;
}

function configuration(raw: unknown): ScamHostConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = copyJson(raw);
    if (!record(value) || value.version !== 1 || value.mode !== "local-demo"
        || !record(value.policy) || !record(value.policy.source) || !record(value.policy.trust) || !record(value.policy.limits)
        || !record(value.scam) || !record(value.scam.source) || !record(value.scam.config)
        || !record(value.scam.config.trust) || !record(value.scam.config.settings) || !record(value.scam.config.limits)
        || !record(value.facts) || !record(value.facts.policy) || !record(value.facts.scam) || !record(value.facts.scam.rpc)) throw new Error();
    // A local/demo host cannot accidentally opt a production trust scope into a demo.
    if (value.policy.trust.env !== "staging" || value.scam.config.trust.env !== "staging"
        || value.scam.source.env !== "staging"
        || typeof value.policy.source.baseUrl !== "string" || typeof value.scam.source.baseUrl !== "string"
        || !Array.isArray(value.policy.trust.keys) || !value.policy.trust.keys.length
        || !Array.isArray(value.scam.config.trust.keys) || !value.scam.config.trust.keys.length
        || typeof value.scam.config.settings.presetId !== "string" || !value.scam.config.settings.presetId
        || value.prepare !== undefined && (!Array.isArray(value.prepare) || value.prepare.length > 16)) throw new Error();
    // Storage is a JSON configuration surface, never a runtime/provider injection surface.
    for (const options of [value.policy.source, value.scam.source, value.facts.policy, value.facts.scam.rpc]) {
      if ("fetch" in options || "clock" in options) throw new Error();
    }
    if ("policy" in value.facts.scam || "onMetrics" in value.facts.scam) throw new Error();
    return value as unknown as ScamHostConfig;
  } catch { throw new HostFailure("invalid_configuration"); }
}

function requestForMessage(message: Message): CheckRequest {
  const data = message.data;
  if (data.type === RequestType.TRANSACTION) {
    const tx = data.transaction;
    if (!Number.isSafeInteger(data.chainId) || data.chainId <= 0 || !address(tx.from)
        || tx.to !== undefined && !address(tx.to)
        || tx.data !== undefined && (typeof tx.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data))) {
      throw new HostFailure("invalid_request");
    }
    let value: string | undefined;
    if (tx.value !== undefined) {
      if (typeof tx.value !== "string" || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(tx.value)) throw new HostFailure("invalid_request");
      value = BigInt(tx.value).toString(10);
    }
    return { kind: "transaction", chainId: `eip155:${data.chainId}`, from: tx.from,
      ...(tx.to === undefined ? {} : { to: tx.to }), ...(tx.data === undefined ? {} : { data: tx.data }),
      ...(value === undefined ? {} : { value }) };
  }
  if (data.type === RequestType.TYPED_SIGNATURE) {
    if (!Number.isSafeInteger(data.chainId) || data.chainId <= 0 || !address(data.address) || data.typedData === undefined) {
      throw new HostFailure("invalid_request");
    }
    return { kind: "typed_signature", chainId: `eip155:${data.chainId}`, from: data.address, typedData: data.typedData };
  }
  if (data.type === RequestType.UNTYPED_SIGNATURE) {
    if (typeof data.message !== "string") throw new HostFailure("invalid_request");
    return { kind: "untyped_signature", message: data.message };
  }
  // Venue messages do not carry a reliable signer. Do not manufacture one.
  throw new HostFailure("unsupported_request");
}

async function openHost(config: ScamHostConfig, signal: AbortSignal): Promise<HostRuntime> {
  const policy = createPolicyApiSource(config.policy.source);
  const scam = createScamBundleApiSource(config.scam.source);
  const provider = createScamFactProvider({ ...config.facts.scam, policy: createEvmFactProvider(config.facts.policy) });
  const core = await createCore({ decoderSnapshot, enforcement: "advisory",
    trust: config.policy.trust, limits: config.policy.limits, scam: config.scam.config,
    ports: { policy: { fetch: (options) => policy.fetch(options), fetchScam: (options) => scam.fetchScam(options) }, fact: provider },
  }, { signal });
  return { core, provider };
}

function initializationFailure(error: unknown): HostFailure {
  if (error instanceof HostFailure) return error;
  const code = record(error) ? error.code : undefined;
  return new HostFailure(code === "INVALID_CONFIG" ? "invalid_configuration" : "initialization_failed");
}

/** Instance factory keeps cancellation/config replacement testable without RPC. */
export function createScamHost(dependencies: HostDependencies) {
  let session: Session | undefined;
  let revision = 0;

  function invalidate(): void {
    revision += 1;
    const old = session;
    session = undefined;
    if (!old) return;
    old.controller.abort();
    old.preparation?.abort();
    for (const caller of old.callers) caller.abort();
    old.runtime?.core.dispose();
  }

  async function select(signal?: AbortSignal, deadline?: number): Promise<Session | undefined> {
    const startedRevision = revision;
    const raw = await dependencies.readConfig();
    if (signal?.aborted || startedRevision !== revision) throw new HostFailure("aborted");
    if (deadline !== undefined && Date.now() >= deadline) throw new HostFailure("timeout");
    let config: ScamHostConfig | undefined;
    try { config = configuration(raw); } catch (error) { invalidate(); throw error; }
    if (!config) { if (session) invalidate(); return undefined; }
    const fingerprint = JSON.stringify(config);
    if (session?.fingerprint === fingerprint) return session;
    if (session) invalidate();
    const controller = new AbortController();
    const current: Session = {
      fingerprint, config, controller, callers: new Set(), preparationStarted: false,
      ready: Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new HostFailure("aborted");
        return (dependencies.open ?? openHost)(config, controller.signal);
      }).then((runtime) => {
        if (controller.signal.aborted) { runtime.core.dispose(); throw new HostFailure("aborted"); }
        current.runtime = runtime;
        return runtime;
      }).catch((error: unknown) => {
        // Keep this attempt's failure for every caller already awaiting it.
        // A later request may retry; an old attempt cannot evict its replacement.
        if (session === current) session = undefined;
        throw initializationFailure(error);
      }),
    };
    session = current;
    // A malformed/unsupported caller can finish before initialization settles.
    void current.ready.catch(() => {});
    return current;
  }

  async function prepare(current: Session, runtime: HostRuntime): Promise<void> {
    if (current.preparationStarted || current.controller.signal.aborted || current.callers.size) return;
    current.preparationStarted = true;
    const controller = new AbortController();
    current.preparation = controller;
    for (const request of current.config.prepare ?? []) {
      if (controller.signal.aborted || current.controller.signal.aborted) break;
      try {
        const plan = await runtime.core.plan(copyJson(request), { signal: controller.signal });
        const calls = plan.scamCalls ?? [];
        // Core has no release-plan API. Consume this preparation-only handle with
        // missing Facts and discard its verdict; it never authorizes a signature.
        // Consume before a potentially long prepare, so it cannot hold a slot/TTL.
        runtime.core.evaluate(plan, { planId: plan.planId, results: {} });
        if (calls.length && !controller.signal.aborted) {
          await runtime.provider.prepare(calls, { planId: plan.planId, signal: controller.signal, timeoutMs: PREPARE_TIMEOUT_MS });
        }
      } catch { /* Preparation never becomes a successful analysis or blocks signing. */ }
    }
  }

  function warm(): void {
    void (async () => {
      const current = await select();
      if (current) await prepare(current, await current.ready);
    })().catch(() => { /* A later live request may retry initialization once. */ });
  }

  function begin(message: Message): { promise: Promise<ScamDisplay | undefined>; cancel(): void } {
    const startedAt = Date.now();
    const deadline = startedAt + CHECK_TIMEOUT_MS;
    const controller = new AbortController();
    let owned: Message | undefined;
    try { owned = copyJson(message); } catch { /* Report only when the feature is configured. */ }
    let attached: Session | undefined;
    let settled = false;
    let resolve!: (display: ScamDisplay | undefined) => void;
    const promise = new Promise<ScamDisplay | undefined>((done) => { resolve = done; });
    const finish = (display: ScamDisplay | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      attached?.callers.delete(controller);
      resolve(display);
    };
    const onAbort = (): void => finish(unavailable("aborted"));
    const timeout = (): void => { finish(unavailable("timeout")); controller.abort(); };
    const expired = (): boolean => {
      if (Date.now() < deadline) return false;
      timeout();
      return true;
    };
    const timer = setTimeout(timeout, Math.max(0, deadline - Date.now()));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      attached = await select(controller.signal, deadline);
      if (controller.signal.aborted || expired()) return;
      if (!attached) { finish(undefined); return; }
      attached.callers.add(controller);
      attached.preparation?.abort();
      if (!owned) throw new HostFailure("invalid_request");
      let request: CheckRequest;
      try { request = requestForMessage(owned); }
      catch (error) { throw error instanceof HostFailure ? error : new HostFailure("invalid_request"); }
      const runtime = await attached.ready;
      if (controller.signal.aborted || expired()) return;
      const result = await runtime.core.check(request, { signal: controller.signal });
      // Synchronous WASM cannot be preempted by a timer; reject a late result
      // even when its promise microtask runs before the queued timer callback.
      if (controller.signal.aborted || expired()) return;
      finish(result.scam ? { version: 1, kind: "report", report: result.scam, holding: "unknown" } : unavailable("report_missing"));
    })().catch((error: unknown) => {
      if (!controller.signal.aborted && !expired()) finish(unavailable(error instanceof HostFailure ? error.reason : "host_error"));
    });
    return { promise, cancel: () => controller.abort() };
  }
  return { warm, begin, invalidate };
}

const host = createScamHost({ readConfig: async () => (await Browser.storage.local.get(SCAM_HOST_CONFIG_KEY))[SCAM_HOST_CONFIG_KEY] });
let listening = false;
function listenForConfiguration(): void {
  if (listening) return;
  listening = true;
  Browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(SCAM_HOST_CONFIG_KEY in changes)) return;
    host.invalidate();
    host.warm();
  });
}
export function warmScamHost(): void { listenForConfiguration(); host.warm(); }
export function beginScamCheck(message: Message): ReturnType<typeof host.begin> { listenForConfiguration(); return host.begin(message); }
