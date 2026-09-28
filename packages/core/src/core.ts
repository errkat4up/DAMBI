/** Public contracts and the instance-owned Rust/WASM runtime entry point. */
import type { CheckRequest, UnsupportedRequest } from "./types/request.js";
import type { Verdict } from "./types/verdict.js";
import type { CorePlan, FactBatch } from "./types/plan.js";
import type { CallOptions } from "./types/options.js";
import type { CoreLimits, CoreTrust, DecoderSnapshot } from "./types/config.js";
import type { CoreDiagnostic } from "./types/errors.js";
import { initializeCore } from "./runtime/core-runtime.js";
import type { PolicySource } from "./ports/policy.js";
import type { FactProvider } from "./ports/fact.js";
import type { Clock } from "./ports/clock.js";

/** External I/O only. Core owns its snapshots, plans and in-memory cache. */
export interface Ports {
  readonly policy: PolicySource;
  readonly fact: FactProvider;
}

/** Host notifications. Hook failures must not change a verdict or skip validation. */
export interface CoreHooks {
  onPending?(req: CheckRequest | UnsupportedRequest): void | Promise<void>;
  /** Receives the same snapshot-bound metadata as the returned verdict. */
  onVerdict?(verdict: Verdict): void | Promise<void>;
  onAwaitingUser?(): void;
  onDiagnostic?(event: CoreDiagnostic): void;
}

export interface CoreConfig {
  readonly ports: Ports;
  readonly decoderSnapshot: DecoderSnapshot;
  readonly trust: CoreTrust;
  readonly limits: CoreLimits;
  /** Defaults to Date.now; Unix milliseconds. */
  readonly clock?: Clock;
  readonly hooks?: CoreHooks;
  /** Host deployment declaration; Core does not submit or block transactions. */
  readonly enforcement: "advisory" | "enforcing";
}

export interface DambiCore {
  /**
   * Plan → provider → evaluate. Unsupported kinds warn; malformed known requests,
   * required Fact failures, cancellation and timeouts deny + fail_closed.
   * Calling a disposed instance rejects with CoreError.
   */
  check(req: CheckRequest | UnsupportedRequest, options?: CallOptions): Promise<Verdict>;
  /** Pins request, decoded action, snapshots and required calls inside Core. */
  plan(req: CheckRequest, options?: CallOptions): Promise<CorePlan>;
  /**
   * Consumes a valid handle once, including when Fact validation fails. Invalid,
   * foreign, reused or TTL-expired handles throw CoreError. A valid handle with bad
   * Facts or expired trust returns deny + fail_closed. Retry with a new plan.
   */
  evaluate(plan: CorePlan, facts: FactBatch): Verdict;
  /** Validates fully before atomic replacement; failure preserves current state. */
  refreshPolicies(options?: CallOptions): Promise<void>;
  /** Idempotent; cancels I/O and releases plans, cache and WASM resources. */
  dispose(): void;
}

/**
 * Returns only a fully authenticated and initialized instance. Failures release
 * partial state; plan/evaluate are available while check orchestration awaits C6.
 */
export async function createCore(
  config: CoreConfig,
  options?: CallOptions,
): Promise<DambiCore> {
  return initializeCore(config, options);
}
