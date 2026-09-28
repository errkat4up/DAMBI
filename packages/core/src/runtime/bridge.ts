import { CoreError, type CoreErrorCode } from "../types/errors.js";
import type { PlannedCall } from "../types/plan.js";

/** Internal generated-WASM boundary; never exposed as a host injection option. */
export interface NativeCore {
  plan(requestJson: string, nowMs: number): string;
  evaluate(planId: string, factsJson: string, nowMs: number): string;
  begin_refresh(): string;
  commit_refresh(ticket: number, policyJson: string, nowMs: number): string;
  cancel_refresh(ticket: number): string;
  dispose(): void;
  free(): void;
}

export interface NativeCoreConstructor {
  new(configJson: string, policyJson: string, nowMs: number): NativeCore;
}

export interface NativePlan {
  planId: string;
  calls: readonly PlannedCall[];
  expiresAt: number;
}

const codes = new Set<CoreErrorCode>([
  "NOT_IMPLEMENTED", "INVALID_CONFIG", "DISPOSED", "ABORTED", "TIMEOUT",
  "POLICY_FETCH_FAILED", "INVALID_POLICY_BUNDLE", "INVALID_SIGNATURE",
  "UNSUPPORTED_REGISTRY_REF", "POLICY_SCOPE_MISMATCH", "POLICY_EXPIRED",
  "POLICY_SEQUENCE_REJECTED", "INVALID_DECODER_SNAPSHOT", "DECODER_INTEGRITY_MISMATCH",
  "INVALID_REQUEST", "UNSUPPORTED_REQUEST", "LIMIT_EXCEEDED", "INVALID_PLAN",
  "PLAN_CONSUMED", "PLAN_EXPIRED", "ENGINE_ERROR",
]);

function fromData(value: unknown): CoreError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = value as { code?: unknown; message?: unknown };
  if (typeof data.code !== "string" || !codes.has(data.code as CoreErrorCode)
      || typeof data.message !== "string") return undefined;
  return new CoreError(data.code as CoreErrorCode, data.message);
}

export function nativeError(error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  if (typeof error === "string") {
    try {
      const parsed: unknown = JSON.parse(error);
      const direct = fromData(parsed);
      if (direct) return direct;
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const nested = fromData(parsed.error);
        if (nested) return nested;
      }
    } catch { /* A trap or malformed error is an engine failure. */ }
  }
  return new CoreError("ENGINE_ERROR", "The Core engine could not complete the operation.");
}

export function invoke<T>(operation: () => string): T {
  try {
    const envelope: unknown = JSON.parse(operation());
    if (typeof envelope !== "object" || envelope === null || !("ok" in envelope)) {
      throw new CoreError("ENGINE_ERROR", "The Core engine returned an invalid response.");
    }
    if (envelope.ok === true && "data" in envelope) return envelope.data as T;
    if (envelope.ok === false && "error" in envelope) {
      throw fromData(envelope.error)
        ?? new CoreError("ENGINE_ERROR", "The Core engine returned an invalid error.");
    }
    throw new CoreError("ENGINE_ERROR", "The Core engine returned an invalid response.");
  } catch (error) {
    throw nativeError(error);
  }
}

/** Both cleanup operations are attempted; disposal must remain idempotent. */
export function release(native: NativeCore): void {
  try { native.dispose(); } catch { /* Still release the WASM allocation. */ }
  try { native.free(); } catch { /* Already released/trapped resources cannot be reused. */ }
}
