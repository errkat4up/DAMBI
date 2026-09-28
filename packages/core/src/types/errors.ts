/** Stable categories; messages carry details and are not a machine-readable API. */
export type CoreErrorCode =
  | "NOT_IMPLEMENTED"
  | "INVALID_CONFIG"
  | "DISPOSED"
  | "ABORTED"
  | "TIMEOUT"
  | "POLICY_FETCH_FAILED"
  | "INVALID_POLICY_BUNDLE"
  | "INVALID_SIGNATURE"
  | "UNSUPPORTED_REGISTRY_REF"
  | "POLICY_SCOPE_MISMATCH"
  | "POLICY_EXPIRED"
  | "POLICY_SEQUENCE_REJECTED"
  | "INVALID_DECODER_SNAPSHOT"
  | "DECODER_INTEGRITY_MISMATCH"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_REQUEST"
  | "LIMIT_EXCEEDED"
  | "INVALID_PLAN"
  | "PLAN_CONSUMED"
  | "PLAN_EXPIRED"
  | "ENGINE_ERROR";

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

/** Verdict/hook diagnostics are distinct from errors thrown by direct APIs. */
export type CoreDiagnosticCode =
  | "invalid_request"
  | "unsupported_request"
  | "partial_decode"
  | "no_matching_policy"
  | "bundle_quarantined"
  | "fact_fetch_failed"
  | "fact_plan_mismatch"
  | "unknown_fact_call"
  | "required_fact_missing"
  | "invalid_fact"
  | "fact_stale"
  | "projection_failed"
  | "trust_expired"
  | "limit_exceeded"
  | "engine_error"
  | "aborted"
  | "timeout"
  | "hook_error"
  | "audit_metadata_unavailable";

export interface CoreDiagnostic {
  readonly code: CoreDiagnosticCode;
  readonly message: string;
  /** Optional context for a specific tree node or Fact; not a trust assertion. */
  readonly callId?: string;
  /** Root is []; children are zero-based indexes in the decoded call tree. */
  readonly nodePath?: readonly number[];
}
