/** Only this entry point is the public SDK surface. */
export { createCore } from "./core.js";
export { CoreError } from "./types/errors.js";
export type { Ports, CoreHooks, CoreConfig, DambiCore } from "./core.js";
export type { CallOptions } from "./types/options.js";
export type { CoreTrust, CoreLimits, VerificationKey, DecoderSnapshot } from "./types/config.js";
export type { CoreErrorCode, CoreDiagnosticCode, CoreDiagnostic } from "./types/errors.js";
export type { CheckRequest, UnsupportedRequest } from "./types/request.js";
export type { Verdict, VerdictMetadata, MatchedPolicy } from "./types/verdict.js";
export type { CorePlan, PlannedCall, FactBatch } from "./types/plan.js";
export type { PolicySource, SignedPolicyBundle, FactProvider, FactResult, Clock } from "./ports/index.js";
export type {
  ScamConfig, ScamSettings, ScamLimits, LocalScamTrust, RuleSpec, RuleOverride,
  SignedScamBundle, ScamBundlePayloadDraft,
  PlannedScamCall, ScamFactBatch, ScamReport, ScamReportStatus, TargetReport,
  RuleResult, ScamFailureReason, PoolHistoryValue, TokenProfileValue,
  DataCoverage, FixedReference, Subject, PoolAge,
  HistoryVerification, StateBinding, VerificationTimeSource, MethodVerification, AnalysisVerification,
} from "./types/scam.js";
