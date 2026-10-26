/**
 * Shared Scam Filter contracts. Only the subset exported by index.ts is public;
 * algorithm linking and future bundle transport remain separate integration work.
 * Algorithm specification revision 0.2 retains numeric wire contractVersion 1;
 * the enclosing SDK contract/bundle schema is independently versioned "0.1".
 * Safe-integer/range/address/binding checks and all algorithm code remain runtime
 * work. No algorithm identity, default thresholds or warm-up size is invented.
 */
import type { FactResult } from "../ports/fact.js";
import type { FactBatch, PlannedCall, CorePlan } from "./plan.js";
import type { Verdict } from "./verdict.js";
import type { CoreConfig, DambiCore, Ports } from "../core.js";
import type { PolicySource } from "../ports/policy.js";
import type { CallOptions } from "./options.js";

export type Address = `0x${string}`; // Exactly 20 bytes after validation.
export type Digest = `0x${string}`; // Exactly 32 bytes; hash domain is explicit.
export type DecimalInteger = string; // Canonical unsigned decimal, no exponent.
export type DurationSec = number; // Finite safe integer; positivity is field-specific.
export type UnixMs = number; // Finite nonnegative safe integer, NOT seconds.
export type Bps = number; // Finite positive safe integer; 10,000 bps = 100%.
export type AlgorithmHashScheme = "sha256-jcs-scam-v1";
export type JsonValue = null | boolean | number | string | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type Metric = "price_quote_per_token" | "quote_reserve";
export type AdminEventKind = "owner_changed" | "proxy_upgraded" | "admin_changed"
  | "paused" | "unpaused";

interface RuleBase {
  readonly id: string;
  readonly enabled: boolean;
  readonly lookbackSec: DurationSec; // 0 < X1 <= 86,400; never silently shortened.
}
export type RuleSpec =
  | (RuleBase & {
      readonly kind: "change_count";
      readonly metric: Metric;
      readonly direction: "up" | "down" | "either";
      /** Neither mode is supported until the actual algorithm declares it. */
      readonly changeMode: "step" | "cumulative";
      readonly thresholdBps: Bps;
      readonly count: number;
    })
  | (RuleBase & {
      readonly kind: "switch_density";
      readonly metric: Metric;
      readonly windowSec: DurationSec; // 0 < X2 <= X1.
      readonly reversalBps: Bps;
      readonly switchKind: "direction_reversal"; // Both peak and trough confirmations.
      readonly count: number;
    })
  | (RuleBase & {
      readonly kind: "window_drop";
      readonly metric: "quote_reserve";
      readonly windowSec: DurationSec;
      readonly dropBps: Bps; // <= 10,000; upward thresholds have a different range.
    })
  | (RuleBase & {
      readonly kind: "event_count";
      readonly eventKinds: readonly AdminEventKind[];
      readonly count: number;
    });
export type RuleOverride<T extends RuleSpec = RuleSpec> = T extends RuleSpec
  ? Pick<T, "id" | "kind"> & Partial<Omit<T, "id" | "kind">> : never;
export interface ScamSettings {
  readonly enabled: boolean;
  readonly presetId: string;
  readonly overrides: readonly RuleOverride[];
  readonly additionalRules: readonly RuleSpec[];
  readonly locale: string;
}

/** Source-contract compatibility name. */
export type ScamSettingsDraft = ScamSettings;

export interface Subject {
  readonly chainId: number;
  readonly token: Address;
  readonly pool: Address;
  readonly factory: Address;
  readonly quoteToken: Address;
  readonly venue: "uniswap_v2";
  readonly actionPaths: readonly string[];
}
export interface BlockReference {
  readonly number: DecimalInteger;
  readonly hash: Digest;
  readonly timestampMs: UnixMs;
}
export interface FixedReference {
  readonly block: BlockReference;
  readonly requiredConfirmDepth: number;
  readonly checkedHead: BlockReference;
  readonly observedConfirmDepth: number;
}
/** Provider-declared consistency checks, not cryptographic source verification.
 * The built-in RPC provider supports both history modes with number_recheck;
 * block_hash_canonical is reserved for explicit later support.
 */
export type HistoryVerification = "all_event_headers" | "rpc_anchor";
export type StateBinding = "number_recheck" | "block_hash_canonical";
export type VerificationTimeSource = "header" | "rpc_log";
export interface MethodVerification {
  readonly version: 1;
  readonly history: HistoryVerification;
  readonly stateBinding: StateBinding;
  /** Unique, nonempty source kinds in the raw evidence supplied to this method.
   * Header rechecking does not erase an RPC log timestamp's original source.
   */
  readonly timeSources: readonly VerificationTimeSource[];
  readonly reuse: "none" | "interval_cache";
  /** Earliest/latest original collection time, never refreshed by a cache hit.
   * With reuse=none these cannot predate the enclosing Fact.observedAt.
   */
  readonly rawObservedAt: { readonly fromMs: UnixMs; readonly toMs: UnixMs };
  /** Wall-clock time after final checks; must not precede Fact.observedAt. */
  readonly verifiedAt: UnixMs;
}
export type AnalysisVerification =
  | { readonly status: "legacy_unspecified" }
  | {
      readonly status: "declared";
      readonly poolHistory: MethodVerification;
      readonly tokenProfile: MethodVerification;
    };
export interface MissingInterval {
  /** Proposed coverage convention: (fromMs, toMs], in actual Unix ms. */
  readonly fromMs: UnixMs;
  readonly toMs: UnixMs;
  readonly reason: "rpc_error" | "timeout" | "reorg" | "unavailable_history";
}
export interface UnavailableField {
  readonly field: string;
  readonly reason: string; // Unsupported/unretrievable is not an observed zero.
}
export interface DataCoverage {
  readonly fromBlock: DecimalInteger;
  readonly fromMs: UnixMs;
  readonly toMs: UnixMs;
  readonly missing: readonly MissingInterval[];
  readonly unavailable: readonly UnavailableField[];
}
export type PoolAge =
  | {
      readonly kind: "exact";
      readonly ageSec: DurationSec;
      readonly evidence: {
        readonly kind: "factory_pair_created";
        readonly factory: Address;
        readonly createdAt: BlockReference;
        readonly transactionHash: Digest;
        readonly logIndex: number;
      };
    }
  | {
      readonly kind: "lower_bound";
      readonly ageLowerBoundSec: DurationSec;
      readonly evidence: {
        readonly kind: "historical_code_presence";
        readonly checkedAt: BlockReference;
        readonly identityVerified: true;
        readonly nonRecreationSupportId: string;
      };
    }
  | { readonly kind: "unknown"; readonly reasons: readonly string[] };
// First Mint may describe activity start, never the PoolAge creation evidence.

export interface EffectivePreset {
  readonly id: string;
  readonly rules: readonly RuleSpec[];
  readonly bucketMs: number;
  readonly gridOriginMs: UnixMs;
  readonly warmupSec: DurationSec;
  readonly maxDataAgeSec: DurationSec;
}
export interface CandidateSelection {
  readonly ageThresholdSec: DurationSec; // X is shared by both candidates.
  readonly unknownAge: "new_provisional_insufficient";
}
export interface AlgorithmIdentity {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: 1; // Algorithm wire version, NOT SDK schema "0.1".
}
export type AlgorithmAvailability =
  | { readonly state: "connected"; readonly identity: AlgorithmIdentity }
  | { readonly state: "unavailable" }
  | {
      readonly state: "incompatible";
      /** Diagnostic only: incompatible wire versions cannot become trusted identity. */
      readonly observedIdentity?: { readonly id: string; readonly version: string; readonly contractVersion: number };
    };
export interface PinnedScamContext {
  readonly contractVersion: "0.1";
  readonly candidates: { readonly newMarket: EffectivePreset; readonly established: EffectivePreset };
  readonly selection: CandidateSelection;
  /** Hash of both effective candidates + selection under the SDK hash domain. */
  readonly settingsHash: Digest;
  readonly settingsHashScheme: AlgorithmHashScheme;
  readonly customized: boolean;
  readonly bundleSequence: DecimalInteger;
  readonly bundleDigest: Digest;
  readonly algorithm: AlgorithmAvailability;
}

interface ScamCallParams {
  readonly subject: Subject;
  /** Provider obtains one reference for this plan+chain+group before either method. */
  readonly referenceGroupId: string;
  readonly confirmDepth: number;
  readonly dataSchema: string;
  readonly builderVersion: string;
}
export interface PoolHistoryParams extends ScamCallParams {
  /** Union requirements from BOTH frozen candidates, not an extra follow-up plan. */
  readonly lookbackSec: DurationSec;
  readonly warmupSec: DurationSec;
  readonly metrics: readonly Metric[];
  readonly candidateResolutions: readonly { readonly bucketMs: number; readonly gridOriginMs: UnixMs }[];
}
export interface TokenProfileParams extends ScamCallParams {
  readonly ageThresholdSec: DurationSec;
  readonly ageSearchMaxLookbackSec: DurationSec;
  readonly maxAgeSearchCalls: number;
  readonly eventLookbackSec: DurationSec;
  readonly eventKinds: readonly AdminEventKind[];
}
type ScamCall<M extends string, P> = Omit<PlannedCall, "method" | "params" | "outputs" | "optional"> & {
  readonly method: M;
  readonly params: P;
  readonly outputs: readonly [];
  readonly optional: true; // NOT error isolation. Dedicated validation is mandatory.
};
export type PlannedScamCall = ScamCall<"scam.pool_history", PoolHistoryParams>
  | ScamCall<"scam.token_profile", TokenProfileParams>;

interface MethodValueMeta {
  readonly schema: string;
  readonly builderVersion: string;
  readonly subject: Subject;
  readonly referenceGroupId: string;
  readonly reference: FixedReference;
  readonly coverage: DataCoverage;
  /** Absent only for legacy providers; absence does not claim any check mode.
   * If present, both method values must declare compatible verification.
   */
  readonly verification?: MethodVerification;
}
export interface PoolHistoryValue<THistory = PoolHistory> extends MethodValueMeta {
  readonly method: "scam.pool_history";
  /** One entry per distinct frozen candidate grid, built from the same raw
   * query/reference. Select one only after age resolution; never resample it.
   * The algorithm still receives a single selected PoolHistory. */
  readonly histories: readonly {
    readonly gridOriginMs: UnixMs;
    readonly history: THistory; // history.bucketMs + gridOriginMs identifies the grid.
  }[];
}
export interface TokenProfileValue<TEvents = readonly AdminEvent[]> extends MethodValueMeta {
  readonly method: "scam.token_profile";
  readonly age: PoolAge;
  readonly searchedRanges: readonly DataCoverage[];
  readonly events: TEvents;
  readonly activityStart?: { readonly kind: "verified_first_mint"; readonly block: BlockReference };
}

/** Algorithm input intervals; transport-level provenance stays in DataCoverage. */
export interface SnapshotInterval {
  readonly fromMs: UnixMs;
  readonly toMs: UnixMs;
}
export interface PoolSnapshot {
  readonly tMs: UnixMs;
  readonly reserveQuote: DecimalInteger; // Zero is a valid observed reserve.
  readonly reserveToken: DecimalInteger; // Zero invalidates price, not the sample.
  readonly decimalsQuote: number;
  readonly decimalsToken: number;
}
export interface PoolHistory {
  readonly schema: "scam.pool_history/1";
  readonly builderVersion: string;
  readonly fromMs: UnixMs; // Includes required warm-up before the counting horizon.
  readonly bucketMs: number; // Positive, fixed interval; no extra off-grid point at T.
  readonly points: readonly PoolSnapshot[];
  readonly missing: readonly SnapshotInterval[];
  readonly warmup: { readonly fromMs: UnixMs; readonly complete: boolean };
}
export interface AdminEvent {
  readonly tMs: UnixMs;
  readonly kind: AdminEventKind;
}
export interface TokenProfile {
  readonly schema: "scam.token_profile/1";
  readonly poolCreatedMs?: UnixMs;
  /** Verified pool-age lower bound at asOf, not a creation timestamp or Mint age. */
  readonly ageLowerBoundMs?: number;
  readonly adminEvents: readonly AdminEvent[];
  readonly missing: readonly SnapshotInterval[];
}
/** Pure algorithm wire input. SDK metadata is retained in AnalysisBinding instead
 * of being echoed through the algorithm. Rules are frozen, active and validated. */
export interface AnalysisRequest {
  readonly subject: {
    readonly chainId: number;
    readonly pool: Address;
    readonly token: Address;
    readonly quote: Address;
    readonly venue: "uniswap_v2";
  };
  readonly asOf: { readonly block: DecimalInteger; readonly blockHash: Digest; readonly tMs: UnixMs };
  readonly rules: readonly RuleSpec[];
  readonly poolHistory: PoolHistory;
  readonly tokenProfile: TokenProfile;
}
export type AlgorithmRuleReason = "partial_coverage" | "warmup_incomplete"
  | "no_usable_segment" | "resolution_too_coarse" | "metric_unavailable";
export interface AlgorithmRuleResult {
  readonly ruleId: string;
  readonly outcome: RuleState;
  readonly reason?: AlgorithmRuleReason;
  readonly observed?: number;
  readonly threshold: number;
  /** Counting/evidence window is (startMs, endMs]. For R2 choose maximum count,
   * then the greatest endMs on ties; this is not necessarily the first hit. */
  readonly window?: { readonly startMs: UnixMs; readonly endMs: UnixMs };
  readonly events?: readonly { readonly tMs: UnixMs; readonly kind: string }[];
  readonly coverageBps: number; // Integer in [0, 10,000], unlike a positive threshold.
  readonly warmupComplete: boolean;
}
export interface ScamAnalysis {
  readonly algorithmId: string;
  readonly algorithmVersion: string;
  readonly contractVersion: 1;
  readonly analysisMode: "real" | "stub";
  readonly binding: {
    readonly chainId: number;
    readonly pool: Address;
    readonly asOfBlock: DecimalInteger;
    readonly asOfBlockHash: Digest;
    readonly rulesHash: Digest;
  };
  readonly rules: readonly AlgorithmRuleResult[];
}
/** All limits are finite positive safe integers, supplied by the SDK adapter.
 * Limits must be checked before allocation and during work; a timer cannot
 * interrupt a synchronous Native/WASM call. Units are defined by the module. */
export interface AlgorithmLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPoints: number;
  readonly maxRules: number;
  readonly maxEvidenceEventsPerRule: number;
  readonly maxWorkUnits: number;
}
export interface AlgorithmRuleRequirements {
  readonly minimumWarmupMs: number; // Nonnegative; supplied by actual algorithm.
  readonly requiresInitialState: boolean;
}
export type AlgorithmSupport =
  | { readonly supported: true; readonly requirements: AlgorithmRuleRequirements }
  | { readonly supported: false; readonly reason: string };
export type AlgorithmError = "invalid_input" | "unsupported_rule" | "resource_limit"
  | "work_budget_exhausted"; // SDK maps this to timeout; module never reads a clock.
export type AlgorithmModuleResult =
  | { readonly ok: true; readonly analysis: ScamAnalysis }
  | { readonly ok: false; readonly error: AlgorithmError };
/** Language-neutral shape of the team's Rust library interface, not a JS module
 * loader. Native and wasm32-unknown-unknown must use the same pure bounded code.
 * No network, wall clock, SDK policy calls, async service or fallback algorithm. */
export interface AlgorithmModulePort {
  readonly identity: AlgorithmIdentity;
  /** Registration metadata; the adapter rejects output with a different mode. */
  readonly analysisMode: "real" | "stub";
  readonly supportedLimits: AlgorithmLimits;
  /** Nonempty description/ID of the deterministic counter, bound to identity.version. */
  readonly workUnit: string;
  supports(rule: RuleSpec): AlgorithmSupport;
  analyze(request: AnalysisRequest, limits: AlgorithmLimits): AlgorithmModuleResult;
}
/**
 * Same planId/callId/FactResult envelope accepted by FactProvider.fetch(). Values
 * stay unknown until independent size/schema/subject/reference validation. Never
 * pass this batch to existing policy-fact validation, projection or Cedar.
 */
export interface ScamFactBatch extends FactBatch {
  readonly results: Readonly<Record<string, FactResult>>;
}

export type ScamFailureReason = "algorithm_unavailable" | "algorithm_incompatible"
  | "invalid_algorithm_output" | "scam_results_missing" | "invalid_scam_input"
  | "subject_unresolved" | "subject_mismatch" | "reference_mismatch" | "reorg"
  | "bundle_unavailable" | "bundle_invalid" | "data_missing" | "field_unavailable"
  | "initial_state_unknown" | "age_unknown" | "market_too_young" | "stale_data"
  | "unsupported_resolution" | "resource_limit" | "no_time_budget" | "timeout";
export type RuleState = "fired" | "clear" | "incomplete" | "not_evaluable";
export interface RuleResult {
  readonly ruleId: string;
  readonly state: RuleState;
  readonly coverage: DataCoverage;
  readonly initialState: "satisfied" | "unsatisfied" | "not_required";
  readonly reasons: readonly ScamFailureReason[];
  /** Structured JSON only; precise observations are strings, never NaN/Infinity. */
  readonly evidence: JsonValue;
}
export interface AnalysisBinding {
  readonly planId: string;
  readonly subject: Subject;
  readonly reference: FixedReference;
  /** New Core results explicitly identify declared or legacy provenance.
   * Omission in an older binding also means legacy_unspecified.
   */
  readonly verification?: AnalysisVerification;
  readonly settingsHash: Digest;
  readonly settingsHashScheme: AlgorithmHashScheme;
  readonly bundleSequence: DecimalInteger;
  readonly selectedPreset: "newMarket" | "established";
  readonly selectionReason: "exact_young" | "exact_mature" | "lower_bound_mature" | "age_unknown";
  readonly effectiveSettingsHash: Digest;
  readonly algorithm: AlgorithmIdentity;
  readonly builderVersion: string;
  readonly fromMs: UnixMs;
  readonly toMs: UnixMs;
  readonly bucketMs: number;
  readonly gridOriginMs: UnixMs;
  readonly warmupSec: DurationSec;
}
export interface AlgorithmCapabilities {
  readonly identity: AlgorithmIdentity;
  readonly ruleKinds: readonly RuleSpec["kind"][];
  readonly changeModes: readonly ("step" | "cumulative")[];
  readonly inputSchema: "scam.pool_history/1";
  readonly profileSchema: "scam.token_profile/1";
  readonly outputContractVersion: 1;
  readonly supportedLimits: AlgorithmLimits;
  readonly workUnit: string;
}
export interface AlgorithmInput<TInput = AnalysisRequest> {
  readonly binding: AnalysisBinding;
  readonly payload: TInput;
  /** Validated provider provenance, not reconstructed from the slim request. */
  readonly coverage: { readonly poolHistory: DataCoverage; readonly tokenProfile: DataCoverage };
  readonly limits: AlgorithmLimits;
  /** The SDK owns elapsed-time checks. This value is NOT passed to the pure module. */
  readonly deadlineMs: UnixMs;
}
export type AlgorithmOutput<TOutput = ScamAnalysis> =
  | { readonly ok: true; readonly binding: AnalysisBinding; readonly rules: readonly RuleResult[]; readonly payload: TOutput }
  | { readonly ok: false; readonly reason: ScamFailureReason };
/** SDK-owned adapter; it binds the smaller AlgorithmModulePort output to the
 * pinned SDK context and maps algorithm outcomes/reasons to SDK RuleResult. */
export interface AlgorithmPort<TInput = AnalysisRequest, TOutput = ScamAnalysis> {
  readonly capabilities: AlgorithmCapabilities;
  readonly analysisMode: "real" | "stub";
  supports(rule: RuleSpec): AlgorithmSupport;
  /** Synchronous in-process call. Missing module never auto-stubs. */
  analyze(input: AlgorithmInput<TInput>): AlgorithmOutput<TOutput>;
}

export interface TargetReport {
  readonly subject: Subject;
  readonly status: "warn" | "quiet" | "insufficient" | "not_applicable";
  readonly reasons: readonly string[];
  readonly age?: PoolAge;
  readonly rules: readonly RuleResult[];
  readonly binding?: AnalysisBinding; // Only when actually established, not placeholders.
  readonly analysisMode?: "real" | "stub";
}
export type ScamReportStatus = "not_configured" | "disabled" | "not_applicable"
  | "insufficient" | "quiet" | "warn";
export type ScamFeaturePresence =
  | { readonly state: "not_configured" }
  | { readonly state: "disabled"; readonly reason: "user_disabled" | "no_active_rules" }
  | { readonly state: "enabled" };
export interface ScamReport {
  readonly status: ScamReportStatus;
  readonly reasons: readonly string[];
  readonly targets: readonly TargetReport[];
  /** Always disclose scope: no sellability/honeypot guarantee, quiet != safety. */
  readonly scopeNotice: "patterns_only_no_sellability_guarantee";
  readonly pinned?: PinnedScamContext;
}

export interface SignedScamBundle {
  readonly payload: string; // Verify original UTF-8, never parse/re-serialize first.
  readonly signature: string; // Padded Base64 P1363 r||s, ECDSA P-256/SHA-256.
  readonly keyId?: string; // Telemetry only, NEVER a key selector or added trust.
}
export interface LocalScamTrust {
  readonly env: "staging" | "production";
  readonly profile: string;
  readonly keys: readonly {
    readonly keyId: string;
    readonly role: "scam";
    readonly publicKeySpkiBase64: string;
  }[];
}
export interface ScamBundlePayloadDraft {
  readonly kind: "scam_bundle";
  readonly schema: "0.1";
  readonly sequence: DecimalInteger;
  readonly issuedAtMs: UnixMs;
  readonly expiresAtMs: UnixMs;
  readonly env: "staging" | "production";
  readonly profile: string;
  readonly compatibility: {
    readonly engineRange: string;
    readonly builderRange: string;
    readonly contractVersion: "0.1";
    readonly algorithm: AlgorithmIdentity | null;
  };
  readonly support: readonly {
    readonly chainId: number;
    readonly venue: "uniswap_v2";
    readonly factories: readonly Address[];
    readonly quoteTokens: readonly Address[];
    readonly exemptTokens: readonly Address[];
    readonly allowedBucketMs: readonly number[];
    readonly confirmDepth: number;
  }[];
  readonly presets: readonly {
    readonly id: string;
    readonly purpose: "default" | "demo";
    readonly selection: CandidateSelection;
    readonly newMarket: EffectivePreset;
    readonly established: EffectivePreset;
  }[];
  readonly templates: Readonly<Record<string, string>>;
  readonly model: null;
}

// Handoff compatibility aliases. Runtime surfaces are exported separately;
// signed bundle transport/refresh remains future work. Handles stay single-use.
export type CorePlanScamDraft = CorePlan & { readonly scamCalls: readonly PlannedScamCall[] };
export type VerdictScamDraft = Verdict & { readonly scam?: ScamReport };
export interface EvaluateScamDraft {
  /** Third arg is queried method values, NOT host-generated algorithm decisions. */
  (plan: CorePlan, policyFacts: FactBatch, scamFacts?: ScamFactBatch): VerdictScamDraft;
}
export interface ScamPolicySourceDraft extends PolicySource {
  /** Same source object, independent request and validation channel. */
  fetchScam?(options?: CallOptions): Promise<SignedScamBundle>;
}
export interface ScamLimits {
  readonly scamTimeoutMs: number;
  readonly scamEvalReserveMs: number;
  readonly maxBundleBytes: number;
  readonly maxResultBytes: number;
  readonly maxCalls: number;
  readonly maxTargets: number;
  readonly maxRules: number;
  readonly maxLogs: number;
  readonly maxPoints: number;
  /** Logical work-unit accounting is supplied and enforced by the actual module. */
  readonly maxAlgorithmWorkUnits: number;
}
export interface ScamConfig {
  readonly settings: ScamSettings;
  readonly trust: LocalScamTrust;
  readonly limits: ScamLimits;
  // Rust module linking is an internal integration step, not a Python service URL.
}
/** Source-contract compatibility names. */
export type ScamLimitsDraft = ScamLimits;
export type ScamConfigDraft = ScamConfig;
export type CoreConfigScamDraft = Omit<CoreConfig, "ports"> & {
  readonly ports: Omit<Ports, "policy"> & { readonly policy: ScamPolicySourceDraft };
  readonly scam?: ScamConfigDraft;
};
export type DambiCoreScamDraft = Omit<DambiCore, "plan" | "evaluate" | "check"> & {
  check(...args: Parameters<DambiCore["check"]>): Promise<VerdictScamDraft>;
  plan(...args: Parameters<DambiCore["plan"]>): Promise<CorePlanScamDraft>;
  evaluate: EvaluateScamDraft;
  setScamSettings(settings: ScamSettingsDraft): void;
  refreshScam(options?: CallOptions): Promise<void>;
};
/** Internal wire proposal; copy/parse/size errors use this dedicated channel,
 * never evaluate_check.failure, policy FactBatch or a fabricated empty success. */
export type NativeScamInputDraft =
  | { readonly status: "not_configured" }
  | { readonly status: "data"; readonly batch: ScamFactBatch }
  | { readonly status: "unavailable"; readonly reason: ScamFailureReason };
export interface NativeScamDeadlineDraft {
  /** Internal-only number from min(Dplan, pinned policy.valid_until_ms()).
   * Not a caller-controlled deadline, not a new public CorePlan field. */
  readonly policyPlanDeadlineMs: UnixMs;
}
/** Runtime separately tightens to earliest policy Fact observedAt + maxFactAgeMs
 * as results arrive, then applies scamTimeoutMs and evaluation reserve. Optional
 * policy Facts that will be submitted count too; never extend the deadline.
 * Caller cancellation/dispose and existing policy fail_closed remain unchanged. */
