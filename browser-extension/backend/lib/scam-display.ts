import type { ScamReport } from "@dambi/core";

/** Host transport status is separate from the SDK's analysis result. */
export type ScamHostFailure = "initializing" | "initialization_failed" | "invalid_configuration"
  | "timeout" | "invalid_request" | "unsupported_request" | "host_error" | "aborted" | "report_missing";

export type ScamDisplay =
  | { readonly version: 1; readonly kind: "report"; readonly report: ScamReport; readonly holding: "unknown" }
  | { readonly version: 1; readonly kind: "unavailable"; readonly reason: ScamHostFailure; readonly holding: "unknown" };

export const SCAM_SCOPE_NOTICE = "매도 제한형 스캠은 검사 범위에 포함되지 않습니다. 경고 미발견은 자산의 안전성이나 매도 가능성을 보장하지 않습니다.";

/** A report is delivered to its confirmation page, never embedded in its URL. */
export const scamConfirmKey = (requestId: string): string => `scam:confirm:${requestId}`;

export interface StoredScamDisplay {
  readonly requestId: string;
  readonly expiresAtMs: number;
  readonly display: ScamDisplay;
}
