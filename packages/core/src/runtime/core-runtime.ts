import type { CoreConfig, DambiCore } from "../core.js";
import type { CoreLimits } from "../types/config.js";
import { CoreError } from "../types/errors.js";
import type { CallOptions } from "../types/options.js";
import type { CorePlan, FactBatch } from "../types/plan.js";
import type { CheckRequest, UnsupportedRequest } from "../types/request.js";
import type { Verdict } from "../types/verdict.js";
import type { SignedPolicyBundle } from "../ports/policy.js";
import { invoke, nativeError, release, type NativeCore, type NativePlan } from "./bridge.js";
import { checkAbort, signalFrom, startOperation, type PendingOperation } from "./io.js";
import { copyJson, field, freezeTree, record, requestJson, textBytes } from "./json.js";
import { loadWasm } from "./wasm-loader.js";

interface OwnedConfig {
  readonly nativeJson: string;
  readonly limits: CoreLimits;
  readonly now: () => number;
  readonly fetchPolicy: (options: CallOptions) => Promise<SignedPolicyBundle>;
}

const limitNames = [
  "allowedClockSkewMs", "maxPolicyBytes", "maxDecoderBytes", "maxRequestBytes",
  "maxFactBytes", "maxPlanCalls", "planTtlMs", "maxPendingPlans",
  "maxFactAgeMs", "factTimeoutMs", "policyTimeoutMs",
] as const;

/** Capture port/clock methods once while preserving their original receiver. */
function method(receiver: unknown, name: string): (...args: unknown[]) => unknown {
  if ((typeof receiver !== "object" || receiver === null) && typeof receiver !== "function") {
    throw new CoreError("INVALID_CONFIG", "A configured port or clock is missing.");
  }
  let owner: object | null = receiver as object;
  for (let depth = 0; owner !== null && depth < 128; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new CoreError("INVALID_CONFIG", "Ports and clocks require callable data methods.");
      }
      const fn = descriptor.value as (...args: unknown[]) => unknown;
      return (...args) => Reflect.apply(fn, receiver, args);
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  throw new CoreError("INVALID_CONFIG", "A configured port or clock method is missing.");
}

function ownConfig(input: CoreConfig): OwnedConfig {
  try {
    const source = record(input, "INVALID_CONFIG");
    const rawLimits = record(field(source, "limits", true, "INVALID_CONFIG"), "INVALID_CONFIG");
    const selectedLimits: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of [...limitNames, "maxBundleAgeSec"] as const) {
      const value = field(rawLimits, name, name !== "maxBundleAgeSec", "INVALID_CONFIG");
      if (value === undefined) continue;
      const minimum = name === "allowedClockSkewMs" ? 0 : 1;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new CoreError("INVALID_CONFIG", "Limits must be valid safe-integer durations or sizes.");
      }
      selectedLimits[name] = value;
    }
    const limits = selectedLimits as unknown as CoreLimits;
    const decoder = record(field(source, "decoderSnapshot", true, "INVALID_CONFIG"), "INVALID_CONFIG");
    const artifact = field(decoder, "artifact", true, "INVALID_CONFIG");
    if (typeof artifact !== "string") throw new CoreError("INVALID_CONFIG", "Decoder artifact must be a string.");
    textBytes(artifact, "INVALID_DECODER_SNAPSHOT", limits.maxDecoderBytes);
    const nativeConfig = {
      decoderSnapshot: {
        artifact,
        expectedDigest: field(decoder, "expectedDigest", true, "INVALID_CONFIG"),
      },
      trust: field(source, "trust", true, "INVALID_CONFIG"),
      limits: selectedLimits,
      enforcement: field(source, "enforcement", true, "INVALID_CONFIG"),
    };
    const nativeJson = JSON.stringify(copyJson(nativeConfig, "INVALID_CONFIG", Number.MAX_SAFE_INTEGER));
    const ports = record(field(source, "ports", true, "INVALID_CONFIG"), "INVALID_CONFIG");
    const fetch = method(field(ports, "policy", true, "INVALID_CONFIG"), "fetch");
    method(field(ports, "fact", true, "INVALID_CONFIG"), "fetch");
    const clock = field(source, "clock", false, "INVALID_CONFIG");
    const getNow = clock === undefined ? Date.now : method(clock, "now");
    return {
      nativeJson,
      limits: Object.freeze(limits),
      now: () => {
        let now: unknown;
        try { now = getNow(); } catch { throw new CoreError("INVALID_CONFIG", "The configured clock failed."); }
        if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
          throw new CoreError("INVALID_CONFIG", "Clock must return non-negative safe-integer milliseconds.");
        }
        return now;
      },
      fetchPolicy: async (options) => {
        try { return await fetch(options) as SignedPolicyBundle; }
        catch { throw new CoreError("POLICY_FETCH_FAILED", "The policy source could not return a bundle."); }
      },
    };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_CONFIG", "Core configuration could not be copied safely.");
  }
}

function policyJson(input: SignedPolicyBundle, maxBytes: number): string {
  try {
    const source = record(input, "INVALID_POLICY_BUNDLE");
    const payload = field(source, "payload", true, "INVALID_POLICY_BUNDLE");
    const signature = field(source, "signature", true, "INVALID_POLICY_BUNDLE");
    const keyId = field(source, "keyId", false, "INVALID_POLICY_BUNDLE");
    if (typeof payload !== "string" || typeof signature !== "string"
        || (keyId !== undefined && typeof keyId !== "string")) {
      throw new CoreError("INVALID_POLICY_BUNDLE", "Policy payload, signature and key ID must be strings.");
    }
    textBytes(payload, "INVALID_POLICY_BUNDLE", maxBytes);
    const selected = keyId === undefined ? { payload, signature } : { payload, signature, keyId };
    return JSON.stringify(copyJson(selected, "INVALID_POLICY_BUNDLE", Number.MAX_SAFE_INTEGER));
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_POLICY_BUNDLE", "Policy data could not be copied safely.");
  }
}

interface HandleState {
  readonly planId: string;
  readonly expiresAt: number;
  status: "active" | "consumed" | "expired";
}

class CoreRuntime implements DambiCore {
  #disposed = false;
  readonly #handles = new WeakMap<object, HandleState>();
  #refresh: PendingOperation<string> | undefined;

  readonly #native: NativeCore;
  readonly #config: OwnedConfig;

  constructor(native: NativeCore, config: OwnedConfig) {
    this.#native = native;
    this.#config = config;
  }

  #live(): void {
    if (this.#disposed) throw new CoreError("DISPOSED", "The Core instance has been disposed.");
  }

  async plan(request: CheckRequest, options?: CallOptions): Promise<CorePlan> {
    this.#live();
    const signal = signalFrom(options);
    checkAbort(signal);
    const copied = requestJson(request, this.#config.limits.maxRequestBytes);
    const now = this.#config.now();
    // Host input proxies and clocks may reenter the instance.
    this.#live();
    checkAbort(signal);
    const data = invoke<NativePlan>(() => this.#native.plan(copied, now));
    if (typeof data !== "object" || data === null || typeof data.planId !== "string"
        || !data.planId || !Array.isArray(data.calls)
        || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now) {
      throw new CoreError("ENGINE_ERROR", "The Core engine returned an invalid plan.");
    }
    const handle = freezeTree(data) as unknown as CorePlan;
    this.#handles.set(handle, { planId: data.planId, expiresAt: data.expiresAt, status: "active" });
    return handle;
  }

  evaluate(plan: CorePlan, facts: FactBatch): Verdict {
    this.#live();
    const handle = typeof plan === "object" && plan !== null ? this.#handles.get(plan) : undefined;
    if (!handle) throw new CoreError("INVALID_PLAN", "This instance did not issue that plan object.");
    if (handle.status === "consumed") throw new CoreError("PLAN_CONSUMED", "The plan has already been consumed.");
    if (handle.status === "expired") throw new CoreError("PLAN_EXPIRED", "The plan TTL has expired.");
    const now = this.#config.now();
    this.#live();
    if (now >= handle.expiresAt) {
      handle.status = "expired";
      throw new CoreError("PLAN_EXPIRED", "The plan TTL has expired.");
    }
    // Consume before examining host Facts, including objects that reenter Core.
    handle.status = "consumed";
    let copied = "null";
    let copyFailure: CoreError | undefined;
    try {
      copied = JSON.stringify(copyJson(facts, "INVALID_REQUEST", this.#config.limits.maxFactBytes));
    } catch (error) {
      copyFailure = error instanceof CoreError ? error
        : new CoreError("INVALID_REQUEST", "Facts could not be copied safely.");
    }
    this.#live();
    // Native consumes its authoritative handle before validating this sentinel,
    // preserving pinned audit metadata even for non-JSON host Facts.
    const verdict = invoke<Verdict>(() => this.#native.evaluate(handle.planId, copied, now));
    if (copyFailure && (verdict.source !== "fail_closed" || verdict.decision !== "deny")) {
      throw new CoreError("ENGINE_ERROR", "The Core engine did not reject invalid Facts.");
    }
    if (copyFailure && verdict.source === "fail_closed") {
      const code = copyFailure.code === "LIMIT_EXCEEDED" ? "limit_exceeded" : "invalid_fact";
      verdict.diagnostics = [
        { code, message: copyFailure.message },
        ...verdict.diagnostics.filter((diagnostic) => diagnostic.code !== code),
      ];
    }
    return verdict;
  }

  async refreshPolicies(options?: CallOptions): Promise<void> {
    this.#live();
    const signal = signalFrom(options);
    checkAbort(signal);
    this.#live();
    const ticket = invoke<number>(() => this.#native.begin_refresh());
    if (!Number.isSafeInteger(ticket) || ticket < 1) {
      throw new CoreError("ENGINE_ERROR", "The Core engine returned an invalid refresh ticket.");
    }
    const previous = this.#refresh;
    const operation = startOperation(async (internal) => {
      const bundle = await this.#config.fetchPolicy({ signal: internal });
      checkAbort(internal);
      return policyJson(bundle, this.#config.limits.maxPolicyBytes);
    }, this.#config.limits.policyTimeoutMs, signal);
    this.#refresh = operation;
    previous?.cancel(new CoreError("ABORTED", "A newer policy refresh superseded this operation."));
    try {
      const policy = await operation.promise;
      this.#live();
      checkAbort(signal);
      const now = this.#config.now();
      this.#live();
      checkAbort(signal);
      invoke<unknown>(() => this.#native.commit_refresh(ticket, policy, now));
    } finally {
      if (this.#refresh === operation) this.#refresh = undefined;
      if (!this.#disposed) {
        // Finished/superseded tickets report ABORTED and cannot cancel a newer one.
        try { invoke<unknown>(() => this.#native.cancel_refresh(ticket)); } catch { /* Already finished. */ }
      }
    }
  }

  async check(_request: CheckRequest | UnsupportedRequest, _options?: CallOptions): Promise<Verdict> {
    this.#live();
    throw new CoreError("NOT_IMPLEMENTED", "check() orchestration is introduced in C6; use plan() and evaluate().");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#refresh?.cancel(new CoreError("DISPOSED", "The Core instance has been disposed."));
    this.#refresh = undefined;
    release(this.#native);
  }
}

export async function initializeCore(input: CoreConfig, options?: CallOptions): Promise<DambiCore> {
  const config = ownConfig(input);
  const signal = signalFrom(options);
  checkAbort(signal);
  const operation = startOperation(async (internal) => {
    const [module, policy] = await Promise.all([
      loadWasm(),
      config.fetchPolicy({ signal: internal })
        .then((bundle) => {
          checkAbort(internal);
          return policyJson(bundle, config.limits.maxPolicyBytes);
        }),
    ]);
    return { module, policy };
  }, config.limits.policyTimeoutMs, signal);
  const ready = await operation.promise;
  checkAbort(signal);
  let native: NativeCore | undefined;
  try {
    native = new ready.module.WasmCore(config.nativeJson, ready.policy, config.now());
    checkAbort(signal);
    return new CoreRuntime(native, config);
  } catch (error) {
    if (native) release(native);
    throw nativeError(error);
  }
}
