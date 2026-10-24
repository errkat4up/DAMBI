import { CoreError } from "../types/errors.js";
import type { CorePlan, FactBatch, PlannedCall } from "../types/plan.js";
import type { CallOptions } from "../types/options.js";
import type { NativeScamInputDraft, ScamFailureReason, ScamLimits } from "../types/scam.js";
import { checkAbort, startOperation, type PendingOperation } from "./io.js";
import { copyJson, field, freezeTree, record } from "./json.js";

const unavailable = (reason: ScamFailureReason): NativeScamInputDraft => ({ status: "unavailable", reason });

/** The advisory copy boundary must never send a failure into policy Facts. */
export function copyScamFacts(input: unknown, limits?: ScamLimits): NativeScamInputDraft {
  if (limits === undefined) return { status: "not_configured" };
  if (input === undefined) return unavailable("scam_results_missing");
  try {
    const batch = copyJson(input, "INVALID_REQUEST", limits.maxResultBytes);
    return { status: "data", batch: batch as FactBatch };
  } catch (error) {
    return unavailable(error instanceof CoreError && error.code === "LIMIT_EXCEEDED"
      ? "resource_limit" : "invalid_scam_input");
  }
}

/** Undefined means a usable deadline cannot be established, not infinite life. */
function factDeadline(batch: unknown, maxAgeMs: number, requireFacts: boolean): number | undefined {
  try {
    const results = record(field(record(batch, "INVALID_REQUEST"), "results", true, "INVALID_REQUEST"), "INVALID_REQUEST");
    const names = Object.keys(results);
    if (!names.length) return requireFacts ? undefined : Number.MAX_SAFE_INTEGER;
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const name of names) {
      const item = record(field(results, name, true, "INVALID_REQUEST"), "INVALID_REQUEST");
      const observedAt = field(item, "observedAt", true, "INVALID_REQUEST");
      if (typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt < 0) return undefined;
      earliest = Math.min(earliest, Math.min(Number.MAX_SAFE_INTEGER, observedAt + maxAgeMs));
    }
    return earliest;
  } catch {
    return undefined;
  }
}

export interface ScamOperation {
  readonly promise: Promise<NativeScamInputDraft>;
  readonly operation?: PendingOperation<NativeScamInputDraft>;
  readonly result: NativeScamInputDraft | undefined;
  /** Called once the complete policy batch (including optional/cache facts) exists. */
  policyReady(batch: unknown): void;
  cancel(reason: ScamFailureReason): void;
}

function immediate(value: NativeScamInputDraft): ScamOperation {
  return { promise: Promise.resolve(value), result: value, policyReady() {}, cancel() {} };
}

/** Independent advisory operation. Policy I/O and its timeout remain untouched. */
export function beginScamOperation(
  plan: CorePlan,
  policyPlanDeadlineMs: number | undefined,
  limits: ScamLimits,
  maxFactAgeMs: number,
  now: () => number,
  fetchFacts: (calls: readonly PlannedCall[], options: CallOptions & { planId: string }) => Promise<FactBatch>,
  knownPolicyFacts: FactBatch,
  signal?: AbortSignal,
): ScamOperation {
  const calls = plan.scamCalls ?? [];
  if (!calls.length) return immediate(unavailable("scam_results_missing"));
  const started = now();
  const ownDeadline = Math.min(Number.MAX_SAFE_INTEGER, started + limits.scamTimeoutMs);
  if (policyPlanDeadlineMs === undefined) return immediate(unavailable("no_time_budget"));
  let authorityDeadline = Math.min(plan.expiresAt, policyPlanDeadlineMs);
  const cachedDeadline = factDeadline(knownPolicyFacts, maxFactAgeMs, false);
  if (cachedDeadline === undefined) return immediate(unavailable("no_time_budget"));
  authorityDeadline = Math.min(authorityDeadline, cachedDeadline);
  let deadline = Math.min(ownDeadline, authorityDeadline - limits.scamEvalReserveMs);
  let failureReason: ScamFailureReason = deadline < ownDeadline ? "no_time_budget" : "timeout";
  if (deadline <= started) return immediate(unavailable("no_time_budget"));

  let result: NativeScamInputDraft | undefined;
  let settled = false;
  let tightenedTimer: ReturnType<typeof setTimeout> | undefined;
  const operation = startOperation(async (internal) => {
    const received = await fetchFacts(freezeTree(calls), { planId: plan.planId, signal: internal });
    checkAbort(internal);
    const copied = copyScamFacts(received, limits);
    checkAbort(internal);
    const completed = now();
    if (completed < started || completed >= deadline) return unavailable(failureReason);
    return copied;
  }, deadline - started, signal);

  const cancel = (reason: ScamFailureReason): void => {
    if (settled) return;
    failureReason = reason;
    operation.cancel(new CoreError("TIMEOUT", "The advisory analysis deadline has elapsed."));
  };
  const armTightened = (remaining: number): void => {
    const delay = Math.min(remaining, 2_147_483_647);
    tightenedTimer = setTimeout(() => {
      if (settled) return;
      if (remaining > delay) armTightened(remaining - delay);
      else cancel("no_time_budget");
    }, delay);
  };
  const promise = operation.promise.then(
    (value) => value,
    (error: unknown) => unavailable(error instanceof CoreError && error.code === "TIMEOUT"
      ? failureReason : "data_missing"),
  ).then((value) => {
    settled = true;
    if (tightenedTimer !== undefined) clearTimeout(tightenedTimer);
    result = value;
    return value;
  });

  return {
    promise,
    operation,
    get result() { return result; },
    cancel,
    policyReady(batch) {
      if (settled) return;
      const actualDeadline = factDeadline(batch, maxFactAgeMs, plan.calls.length > 0);
      if (actualDeadline === undefined) { cancel("no_time_budget"); return; }
      const nextDeadline = Math.min(deadline, actualDeadline - limits.scamEvalReserveMs);
      const current = now();
      if (current < started) { cancel("no_time_budget"); return; }
      if (nextDeadline <= current) {
        cancel(nextDeadline < ownDeadline ? "no_time_budget" : "timeout");
        return;
      }
      if (nextDeadline < deadline) {
        deadline = nextDeadline;
        failureReason = "no_time_budget";
        if (tightenedTimer !== undefined) clearTimeout(tightenedTimer);
        armTightened(nextDeadline - current);
      }
    },
  };
}
