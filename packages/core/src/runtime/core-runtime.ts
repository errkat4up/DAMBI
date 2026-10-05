import type { CoreConfig, DambiCore } from "../core.js";
import type { CoreLimits } from "../types/config.js";
import { CoreError, type CoreDiagnostic, type CoreDiagnosticCode } from "../types/errors.js";
import type { CallOptions } from "../types/options.js";
import type { CorePlan, FactBatch, PlannedCall } from "../types/plan.js";
import type { CheckRequest, UnsupportedRequest } from "../types/request.js";
import type { Verdict, VerdictMetadata } from "../types/verdict.js";
import type { SignedPolicyBundle } from "../ports/policy.js";
import type { FactResult } from "../ports/fact.js";
import { invoke, nativeError, release, type NativeCore, type NativePlan } from "./bridge.js";
import { checkAbort, signalFrom, startOperation, type PendingOperation } from "./io.js";
import { copyJson, field, freezeTree, record, requestJson, textBytes } from "./json.js";
import { loadWasm } from "./wasm-loader.js";
import { FactCache } from "./fact-cache.js";
import { captureHooks, type HookDispatcher } from "./hooks.js";

interface OwnedConfig {
  readonly nativeJson: string;
  readonly limits: CoreLimits;
  readonly now: () => number;
  readonly fetchPolicy: (options: CallOptions) => Promise<SignedPolicyBundle>;
  readonly fetchFacts: (calls: readonly PlannedCall[], options: CallOptions & { planId: string }) => Promise<FactBatch>;
  readonly hooks: HookDispatcher;
  readonly enforcement: Verdict["enforcement"];
}

class FactFetchFailure extends CoreError {
  constructor() { super("ENGINE_ERROR", "The Fact provider could not return a batch."); }
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
    const fetchFacts = method(field(ports, "fact", true, "INVALID_CONFIG"), "fetch");
    const clock = field(source, "clock", false, "INVALID_CONFIG");
    const getNow = clock === undefined ? Date.now : method(clock, "now");
    return {
      nativeJson,
      limits: Object.freeze(limits),
      hooks: captureHooks(field(source, "hooks", false, "INVALID_CONFIG")),
      enforcement: nativeConfig.enforcement as Verdict["enforcement"],
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
      fetchFacts: async (calls, options) => {
        try { return await fetchFacts(calls, options) as FactBatch; }
        catch { throw new FactFetchFailure(); }
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
  readonly createdAt: number;
  readonly metadata: NativePlan["metadata"];
  status: "active" | "consumed" | "expired";
}

function mergeFacts(
  plan: CorePlan, requested: readonly PlannedCall[], cached: Record<string, FactResult>, received: unknown,
): unknown {
  if (typeof received !== "object" || received === null || Array.isArray(received)) return received;
  const source = received as Record<string, unknown>;
  if (source.planId !== plan.planId || typeof source.results !== "object"
      || source.results === null || Array.isArray(source.results)) return received;
  const returned = source.results as Record<string, unknown>;
  const requestedIds = new Set(requested.map((call) => call.callId));
  // A response cannot overwrite a cache hit for a call that was not fetched.
  for (const call of plan.calls) {
    if (!requestedIds.has(call.callId) && Object.hasOwn(returned, call.callId)) {
      throw new CoreError("INVALID_REQUEST", "Fact provider returned a call that was not requested.");
    }
  }
  // Preserve every provider field/unknown call for authoritative Native checks.
  return { ...source, results: Object.assign(Object.create(null), cached, returned) };
}

function checkFailure(error: unknown): string {
  if (error instanceof FactFetchFailure) return "fact_fetch_failed";
  if (error instanceof CoreError) {
    switch (error.code) {
      case "ABORTED": return "aborted";
      case "TIMEOUT": return "timeout";
      case "LIMIT_EXCEEDED": return "limit_exceeded";
      case "INVALID_REQUEST": return "invalid_fact";
    }
  }
  return "engine_error";
}

function failedVerdict(error: unknown, enforcement: Verdict["enforcement"], metadata?: VerdictMetadata): Verdict {
  const failure = error instanceof CoreError ? error : nativeError(error);
  let code: CoreDiagnosticCode = "engine_error";
  let reason: "invalid_request" | "unsupported_request" | "untrusted_snapshot" | "engine_unavailable" = "engine_unavailable";
  switch (failure.code) {
    case "UNSUPPORTED_REQUEST": code = "unsupported_request"; reason = "unsupported_request"; break;
    case "INVALID_REQUEST": code = "invalid_request"; reason = "invalid_request"; break;
    case "ABORTED": code = "aborted"; break;
    case "TIMEOUT": case "PLAN_EXPIRED": code = "timeout"; break;
    case "LIMIT_EXCEEDED": code = "limit_exceeded"; break;
    case "POLICY_EXPIRED": case "INVALID_SIGNATURE": case "INVALID_POLICY_BUNDLE":
      code = "trust_expired"; reason = "untrusted_snapshot"; break;
  }
  const unsupported = code === "unsupported_request";
  const auditMetadata: VerdictMetadata = metadata ?? { status: "unavailable", reason };
  const diagnostics: CoreDiagnostic[] = [{ code, message: failure.message }];
  if (auditMetadata.status === "unavailable") {
    diagnostics.push({
      code: "audit_metadata_unavailable",
      message: `Audit metadata is unavailable: ${auditMetadata.reason}.`,
    });
  }
  return {
    decision: unsupported ? "warn" : "deny", source: unsupported ? "evaluated" : "fail_closed", enforcement,
    reasons: [{ policyId: `__engine::${code}`, reason: failure.message,
      severity: unsupported ? "warn" : "deny", origin: "engine_error" }],
    facts: [], diagnostics,
    metadata: auditMetadata,
  };
}

class CoreRuntime implements DambiCore {
  #disposed = false;
  readonly #handles = new WeakMap<object, HandleState>();
  #refresh: PendingOperation<string> | undefined;
  readonly #checks = new Set<PendingOperation<unknown>>();
  readonly #cache: FactCache;
  #cacheEpoch = 0;

  readonly #native: NativeCore;
  readonly #config: OwnedConfig;

  constructor(native: NativeCore, config: OwnedConfig) {
    this.#native = native;
    this.#config = config;
    this.#cache = new FactCache(config.limits);
  }

  #live(): void {
    if (this.#disposed) throw new CoreError("DISPOSED", "The Core instance has been disposed.");
  }

  async plan(request: CheckRequest, options?: CallOptions): Promise<CorePlan> {
    this.#live();
    const signal = signalFrom(options);
    checkAbort(signal);
    const copied = requestJson(request, this.#config.limits.maxRequestBytes);
    return this.#plan(copied, signal);
  }

  #plan(copied: string, signal?: AbortSignal): CorePlan {
    const now = this.#config.now();
    // Host input proxies and clocks may reenter the instance.
    this.#live();
    checkAbort(signal);
    const data = invoke<NativePlan>(() => this.#native.plan(copied, now));
    if (typeof data !== "object" || data === null || typeof data.planId !== "string"
        || !data.planId || !Array.isArray(data.calls)
        || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now
        || data.metadata?.status !== "available" || !/^0x[0-9a-f]{64}$/.test(data.metadata.requestDigest)
        || typeof data.metadata.policyVersion !== "string" || typeof data.metadata.engineVersion !== "string") {
      throw new CoreError("ENGINE_ERROR", "The Core engine returned an invalid plan.");
    }
    const handle = freezeTree({ planId: data.planId, calls: data.calls, expiresAt: data.expiresAt }) as unknown as CorePlan;
    // Keep only the engine-issued audit fields after Native evicts an expired
    // plan. They are private and can only annotate a fail-closed check result.
    this.#handles.set(handle, { planId: data.planId, expiresAt: data.expiresAt, createdAt: now,
      metadata: freezeTree(data.metadata), status: "active" });
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
    return this.#publish(verdict);
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
      this.#cacheEpoch++;
      this.#cache.clear();
    } finally {
      if (this.#refresh === operation) this.#refresh = undefined;
      if (!this.#disposed) {
        // Finished/superseded tickets report ABORTED and cannot cancel a newer one.
        try { invoke<unknown>(() => this.#native.cancel_refresh(ticket)); } catch { /* Already finished. */ }
      }
    }
  }

  async check(request: CheckRequest | UnsupportedRequest, options?: CallOptions): Promise<Verdict> {
    this.#live();
    let plan: CorePlan | undefined;
    let batch: unknown;
    let verdict: Verdict;
    try {
      const signal = signalFrom(options);
      checkAbort(signal);
      const copied = requestJson(request, this.#config.limits.maxRequestBytes, true);
      const ownedRequest = JSON.parse(copied) as CheckRequest | UnsupportedRequest;
      this.#config.hooks.pending(ownedRequest);
      this.#live();
      checkAbort(signal);
      plan = this.#plan(copied, signal);
      const epoch = this.#cacheEpoch;
      // Supported native routes always have an explicit chainId. The copied
      // request, rather than host mutations during fetch, defines cache scope.
      const chain = (ownedRequest as { chainId: string }).chainId;
      const results: Record<string, FactResult> = Object.create(null) as Record<string, FactResult>;
      const missing: PlannedCall[] = [];
      const now = this.#config.now();
      this.#live();
      for (const call of plan.calls) {
        const cached = this.#cache.get(chain, call, now);
        if (cached) results[call.callId] = cached;
        else missing.push(call);
      }
      batch = { planId: plan.planId, results };
      if (missing.length) {
        const planId = plan.planId;
        const operation = startOperation(async (internal) => {
          const received = await this.#config.fetchFacts(freezeTree(missing), { planId, signal: internal });
          checkAbort(internal);
          return copyJson(received, "INVALID_REQUEST", this.#config.limits.maxFactBytes);
        }, Math.min(this.#config.limits.factTimeoutMs, Math.max(1, plan.expiresAt - now)), signal);
        this.#checks.add(operation);
        let received: unknown;
        try { received = await operation.promise; }
        finally { this.#checks.delete(operation); }
        this.#live();
        checkAbort(signal);
        batch = mergeFacts(plan, missing, results, received);
      }
      checkAbort(signal);
      const evaluatedAt = this.#config.now();
      this.#live();
      checkAbort(signal);
      // Enforce the combined batch limit too, including cache hits.
      batch = copyJson(batch, "INVALID_REQUEST", this.#config.limits.maxFactBytes);
      verdict = this.#evaluateCheck(plan, batch, evaluatedAt, "");
      if (verdict.source === "evaluated" && epoch === this.#cacheEpoch) {
        this.#cache.put(chain, plan.calls, batch as FactBatch, evaluatedAt);
      }
    } catch (error) {
      this.#live(); // A disposed instance rejects, including in-flight checks.
      const handle = plan && this.#handles.get(plan);
      if (plan && handle?.status === "active") {
        let now = handle.createdAt;
        try { now = this.#config.now(); } catch { /* Fail closed using pinned audit data. */ }
        this.#live();
        try {
          verdict = this.#evaluateCheck(plan, batch ?? { planId: plan.planId, results: {} }, now, checkFailure(error));
        } catch (finishError) {
          this.#live();
          verdict = failedVerdict(finishError, this.#config.enforcement, handle.metadata);
        }
      } else {
        verdict = failedVerdict(error, this.#config.enforcement, handle?.metadata);
      }
    }
    return this.#publish(verdict);
  }

  #evaluateCheck(plan: CorePlan, batch: unknown, now: number, failure: string): Verdict {
    const handle = this.#handles.get(plan);
    if (!handle || handle.status !== "active") throw new CoreError("INVALID_PLAN", "Check plan is no longer active.");
    handle.status = "consumed";
    try {
      return invoke<Verdict>(() => this.#native.evaluate_check(handle.planId, JSON.stringify(batch), now, failure));
    } catch (error) {
      // Native's bounded tombstones may already have aged out as other plans
      // begin. The private handle still proves this check's original deadline.
      if (now >= handle.expiresAt && error instanceof CoreError
          && (error.code === "INVALID_PLAN" || error.code === "PLAN_EXPIRED")) {
        return failedVerdict(new CoreError("PLAN_EXPIRED", "The check plan TTL has expired."),
          this.#config.enforcement, handle.metadata);
      }
      throw error;
    }
  }

  #publish(verdict: Verdict): Verdict {
    for (const event of verdict.diagnostics) this.#config.hooks.diagnostic(event);
    this.#config.hooks.verdict(verdict);
    if (verdict.decision === "warn") this.#config.hooks.awaitingUser();
    return verdict;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#refresh?.cancel(new CoreError("DISPOSED", "The Core instance has been disposed."));
    this.#refresh = undefined;
    for (const operation of this.#checks) operation.cancel(new CoreError("DISPOSED", "The Core instance has been disposed."));
    this.#checks.clear();
    this.#cache.clear();
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
