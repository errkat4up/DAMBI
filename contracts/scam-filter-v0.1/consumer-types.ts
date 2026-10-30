/**
 * Shared SF1/SF3 contract compile cases. No runtime/algorithm invocation.
 * `noEmit` is required; do not execute this file.
 * @ts-expect-error must be consumed, or the user's typecheck must fail.
 */
import type { CoreConfig, DambiCore } from "../../packages/core/src/core.js";
import type { CorePlan, FactBatch, PlannedCall } from "../../packages/core/src/types/plan.js";
import type { FactProvider } from "../../packages/core/src/ports/fact.js";
import type { Verdict } from "../../packages/core/src/types/verdict.js";
import type {
  AlgorithmIdentity, AlgorithmInput, AlgorithmLimits, AlgorithmModulePort,
  AlgorithmPort, AlgorithmRuleResult, AnalysisRequest, CoreConfigScamDraft, CorePlanScamDraft, DataCoverage,
  DambiCoreScamDraft, EvaluateScamDraft, FixedReference, LocalScamTrust,
  NativeScamInputDraft, PlannedScamCall, PoolAge, PoolHistory, PoolHistoryValue, PoolSnapshot, RuleResult,
  RuleSpec, ScamAnalysis, ScamFactBatch, ScamFeaturePresence, ScamReport, SignedScamBundle,
  Subject, TokenProfile, TokenProfileValue, VerdictScamDraft,
} from "./types.js";

const r1: RuleSpec = {
  id: "price-up", kind: "change_count", enabled: false, lookbackSec: 3600,
  metric: "price_quote_per_token", direction: "up", changeMode: "step", thresholdBps: 1000, count: 3,
};
const r2: RuleSpec = {
  id: "reversals", kind: "switch_density", enabled: false, lookbackSec: 3600,
  metric: "price_quote_per_token", windowSec: 5, reversalBps: 500, switchKind: "direction_reversal", count: 2,
};
const auxiliary: readonly RuleSpec[] = [
  { id: "liquidity", kind: "window_drop", enabled: false, lookbackSec: 3600, metric: "quote_reserve", windowSec: 60, dropBps: 5000 },
  { id: "admin", kind: "event_count", enabled: false, lookbackSec: 3600, eventKinds: ["proxy_upgraded"], count: 1 },
];
// @ts-expect-error R2 cannot omit its window even if R1 supplies a count.
const missingWindow: RuleSpec = { id: "invalid", kind: "switch_density", enabled: true, lookbackSec: 3600, metric: "quote_reserve", reversalBps: 100, switchKind: "direction_reversal", count: 2 };
// @ts-expect-error Rule type cannot use policy deny severity or a free-form kind.
const policyRule: RuleSpec = { id: "invalid", kind: "deny", enabled: true, lookbackSec: 3600 };
// @ts-expect-error Duration is numeric seconds, not a unit-bearing string.
const textDuration: RuleSpec = { ...r1, lookbackSec: "24h" };
// @ts-expect-error R2 does not accept R1's thresholdBps parameter.
const wrongThreshold: RuleSpec = { ...r2, thresholdBps: 500 };
// @ts-expect-error MVP event_count counts the whole X1 horizon; X2 is not supported.
const eventWindow: RuleSpec = { id: "admin", kind: "event_count", enabled: false, lookbackSec: 3600, eventKinds: ["paused"], count: 1, windowSec: 60 };
// @ts-expect-error Unknown administrative event kinds are not accepted inputs.
const inventedEvent: RuleSpec = { id: "admin", kind: "event_count", enabled: false, lookbackSec: 3600, eventKinds: ["fixture-only-event"], count: 1 };

// Addresses, timestamps and numbers here are type examples, not RPC evidence.
const subject: Subject = {
  chainId: 91342, venue: "uniswap_v2", actionPaths: ["actions/0"],
  token: "0x1111111111111111111111111111111111111111",
  pool: "0x2222222222222222222222222222222222222222",
  factory: "0x3333333333333333333333333333333333333333",
  quoteToken: "0x4200000000000000000000000000000000000006",
};
const reference: FixedReference = {
  block: { number: "123", hash: "0x" + "a".repeat(64) as `0x${string}`, timestampMs: 1800000000000 },
  checkedHead: { number: "125", hash: "0x" + "b".repeat(64) as `0x${string}`, timestampMs: 1800000002000 },
  requiredConfirmDepth: 2, observedConfirmDepth: 2,
};
const coverage: DataCoverage = {
  fromBlock: "100", fromMs: 1799999980000, toMs: reference.block.timestampMs,
  missing: [], unavailable: [],
};
const params = { subject, referenceGroupId: "same-plan-chain-group", confirmDepth: 2, dataSchema: "fixture-only", builderVersion: "unagreed-example" };
const historyCall: PlannedScamCall = {
  manifestId: "scam:history", callId: "opaque-1", method: "scam.pool_history", outputs: [], optional: true,
  params: { ...params, lookbackSec: 3600, warmupSec: 60, metrics: ["price_quote_per_token"], candidateResolutions: [{ bucketMs: 1000, gridOriginMs: 0 }] },
};
const profileCall: PlannedScamCall = {
  manifestId: "scam:profile", callId: "opaque-2", method: "scam.token_profile", outputs: [], optional: true,
  params: { ...params, ageThresholdSec: 86400, ageSearchMaxLookbackSec: 86400, maxAgeSearchCalls: 12, eventLookbackSec: 3600, eventKinds: [] },
};
const compatibleCalls: readonly PlannedCall[] = [historyCall, profileCall];
// @ts-expect-error Only the two proposed method names are valid scam calls.
const wrongMethod: PlannedScamCall = { ...historyCall, method: "scam.balance" };
// @ts-expect-error Scam values never use policy projection rules.
const projected: PlannedScamCall = { ...historyCall, outputs: [{ path: "price" }] };
// @ts-expect-error A scam call must not become a required policy fact.
const requiredFact: PlannedScamCall = { ...historyCall, optional: false };

const meta = { schema: params.dataSchema, builderVersion: params.builderVersion, subject, referenceGroupId: params.referenceGroupId, reference, coverage };
const snapshot: PoolSnapshot = {
  tMs: coverage.fromMs, reserveQuote: "1000000000000000000", reserveToken: "2000000000000000000",
  decimalsQuote: 18, decimalsToken: 18,
};
const normalizedHistory: PoolHistory = {
  schema: "scam.pool_history/1", builderVersion: "type-example-only", fromMs: coverage.fromMs,
  bucketMs: 1000, points: [snapshot, { ...snapshot, tMs: snapshot.tMs + 1000, reserveQuote: "0" }],
  missing: [], warmup: { fromMs: coverage.fromMs, complete: true },
};
const history: PoolHistoryValue = { ...meta, method: "scam.pool_history", histories: [{ gridOriginMs: 0, history: normalizedHistory }] };
// @ts-expect-error A grid result must identify its origin before candidate selection.
const ambiguousGrid: PoolHistoryValue["histories"][number] = { history: normalizedHistory };
const profile: TokenProfileValue = {
  ...meta, method: "scam.token_profile", age: { kind: "unknown", reasons: ["historical_state_unavailable"] }, searchedRanges: [], events: [],
};
const normalizedProfile: TokenProfile = { schema: "scam.token_profile/1", adminEvents: profile.events, missing: [{ fromMs: coverage.fromMs, toMs: coverage.toMs }] };
// @ts-expect-error Raw reserves preserve integer precision as decimal strings.
const numericReserve: PoolSnapshot = { ...snapshot, reserveQuote: 0 };
// @ts-expect-error Cumulative trade counts were removed from algorithm wire v1.
const removedSwapCounts: PoolHistory = { ...normalizedHistory, swapCounts: [] };
const request: AnalysisRequest = {
  subject: { chainId: subject.chainId, pool: subject.pool, token: subject.token, quote: subject.quoteToken, venue: subject.venue },
  asOf: { block: reference.block.number, blockHash: reference.block.hash, tMs: reference.block.timestampMs },
  rules: [{ ...r1, enabled: true }, { ...r2, enabled: true }], poolHistory: normalizedHistory, tokenProfile: normalizedProfile,
};
const limits: AlgorithmLimits = { maxInputBytes: 1024, maxOutputBytes: 1024, maxPoints: 10, maxRules: 2, maxEvidenceEventsPerRule: 8, maxWorkUnits: 100 };
// @ts-expect-error A synchronous pure module must have a bounded work budget.
const missingWorkLimit: AlgorithmLimits = { maxInputBytes: 1024, maxOutputBytes: 1024, maxPoints: 10, maxRules: 2, maxEvidenceEventsPerRule: 8 };
const algorithmRule: AlgorithmRuleResult = {
  ruleId: r2.id, outcome: "fired", observed: 2, threshold: 2,
  window: { startMs: coverage.fromMs, endMs: coverage.fromMs + 5000 },
  events: [{ tMs: coverage.fromMs + 1000, kind: "peak" }, { tMs: coverage.fromMs + 2000, kind: "trough" }],
  coverageBps: 10000, warmupComplete: true,
};
const analysis: ScamAnalysis = {
  algorithmId: "type-example-not-installed", algorithmVersion: "unreleased-example", contractVersion: 2, analysisMode: "real",
  binding: { chainId: subject.chainId, pool: subject.pool, asOfBlock: reference.block.number, asOfBlockHash: reference.block.hash, rulesHash: reference.block.hash },
  rules: [algorithmRule],
};
// @ts-expect-error Algorithm wire version 1 is distinct from the SDK envelope "0.1".
const mixedVersion: AlgorithmIdentity = { id: "example", version: "example", contractVersion: "0.1" };
// @ts-expect-error Algorithm output uses outcome; SDK state is added by the adapter.
const rawSdkState: AlgorithmRuleResult = { ...algorithmRule, state: "fired" };
// @ts-expect-error Pure algorithm bindings do not accept the SDK's plan ID.
const leakedSdkBinding: ScamAnalysis["binding"] = { ...analysis.binding, planId: "opaque-plan" };
const scamFacts: ScamFactBatch = { planId: "opaque-plan", results: {
  [historyCall.callId]: { value: history, source: "fixture-only", observedAt: 1800000003000, blockNumber: "123" },
  [profileCall.callId]: { value: profile, source: "fixture-only", observedAt: 1800000003000, blockNumber: "123" },
} };
const providerEnvelope: FactBatch = scamFacts; // Structural transport reuse, NOT validation reuse.
const unknownAge: PoolAge = { kind: "unknown", reasons: ["timeout"] };
// @ts-expect-error Unknown is not a fabricated exact zero age.
const inventedAge: PoolAge = { kind: "unknown", reasons: ["timeout"], ageSec: 0 };
// @ts-expect-error First Mint is not pool-creation evidence.
const mintAsCreation: Extract<PoolAge, { kind: "exact" }>["evidence"] = { kind: "first_mint", factory: subject.factory, createdAt: reference.block, transactionHash: reference.block.hash, logIndex: 0 };
// @ts-expect-error Block numbers preserve precision as decimal strings.
const numericBlock: FixedReference = { ...reference, block: { ...reference.block, number: 123 } };

const presence: readonly ScamFeaturePresence[] = [
  { state: "not_configured" }, { state: "disabled", reason: "user_disabled" },
  { state: "disabled", reason: "no_active_rules" }, { state: "enabled" },
];
const ruleResults: readonly RuleResult[] = [
  { ruleId: "r1", state: "clear", coverage, initialState: "satisfied", reasons: [], evidence: null },
  { ruleId: "r1", state: "fired", coverage, initialState: "satisfied", reasons: [], evidence: { count: 3 } },
  { ruleId: "r1", state: "incomplete", coverage, initialState: "unsatisfied", reasons: ["initial_state_unknown"], evidence: null },
  { ruleId: "r1", state: "not_evaluable", coverage, initialState: "not_required", reasons: ["field_unavailable"], evidence: null },
];
const missingAlgorithm: ScamReport = {
  status: "insufficient", reasons: ["algorithm_unavailable"], targets: [], scopeNotice: "patterns_only_no_sellability_guarantee",
};
const notConfigured: ScamReport = {
  status: "not_configured", reasons: [], targets: [], scopeNotice: "patterns_only_no_sellability_guarantee",
};
// @ts-expect-error Scam reports are not policy allow/deny decisions.
const automaticDeny: ScamReport = { ...missingAlgorithm, status: "deny" };
// @ts-expect-error Rule states distinguish failure from clear and do not use quiet.
const invalidRuleState: RuleResult = { ...ruleResults[0], state: "quiet" };
const unavailableInput: NativeScamInputDraft = { status: "unavailable", reason: "invalid_scam_input" };
// @ts-expect-error Policy fail_closed is not a scam-only failure reason.
const wrongFailureChannel: NativeScamInputDraft = { status: "unavailable", reason: "fail_closed" };

const signed: SignedScamBundle = { payload: "original JSON text placeholder", signature: "encoding-checked-separately" };
const signedWithTelemetry: SignedScamBundle = { ...signed, keyId: "not-a-key-selector" };
// @ts-expect-error Signed bytes must not be replaced by a parsed object.
const parsedPayload: SignedScamBundle = { ...signed, payload: { kind: "scam_bundle" } };
// @ts-expect-error Policy keys cannot substitute for the local scam role.
const policyKey: LocalScamTrust["keys"][number] = { keyId: "local", role: "policy", publicKeySpkiBase64: "example" };
// @ts-expect-error The provisional sync port does not silently become an async service.
const asynchronousAlgorithm: AlgorithmPort["analyze"] = async () => ({ ok: false, reason: "algorithm_unavailable" });
// @ts-expect-error The actual algorithm module is synchronous too, not a Python API.
const asynchronousModule: AlgorithmModulePort["analyze"] = async () => ({ ok: true, analysis });

function moduleCompatibility(module: AlgorithmModulePort, adapter: AlgorithmPort, input: AlgorithmInput): void {
  const registeredMode: "real" | "stub" = module.analysisMode;
  const historyCoverage: DataCoverage = input.coverage.poolHistory;
  const { coverage: _coverage, ...withoutCoverage } = input;
  // @ts-expect-error SDK provenance must not be reconstructed from algorithm output.
  const missingCoverage: AlgorithmInput = withoutCoverage;
  void [registeredMode, historyCoverage, missingCoverage];
  const support = module.supports(r2);
  if (support.supported) {
    const minimumWarmupMs: number = support.requirements.minimumWarmupMs;
    void minimumWarmupMs;
  }
  const pureResult = module.analyze(request, limits);
  const sdkResult = adapter.analyze(input);
  if (pureResult.ok && sdkResult.ok) {
    const slimResult: ScamAnalysis = pureResult.analysis;
    const wrappedResult: ScamAnalysis = sdkResult.payload;
    const planId: string = sdkResult.binding.planId;
    void [slimResult, wrappedResult, planId];
  }
}

function compatibility(
  legacy: DambiCore, legacyConfig: CoreConfig, plan: CorePlan, policyFacts: FactBatch,
  future: DambiCoreScamDraft, futurePlan: CorePlanScamDraft, futureEvaluate: EvaluateScamDraft,
  provider: FactProvider,
): void {
  const unchangedConfig: CoreConfigScamDraft = legacyConfig; // No scam config remains a valid future input.
  const unchangedCore: DambiCore = future;
  const unchangedPlan: CorePlan = futurePlan;
  const oldVerdict: Verdict = legacy.evaluate(plan, policyFacts);
  const noScam: VerdictScamDraft = futureEvaluate(plan, policyFacts); // Preserve synchronous evaluation.
  const withScam: VerdictScamDraft = futureEvaluate(futurePlan, policyFacts, scamFacts);
  const providerReuse: Promise<FactBatch> = provider.fetch(compatibleCalls, { planId: futurePlan.planId });
  // @ts-expect-error Settings updates require a complete validated settings object.
  legacy.setScamSettings({ enabled: false });
  const publicScamCalls: readonly PlannedScamCall[] | undefined = plan.scamCalls;
  const publicScamVerdict: Verdict = legacy.evaluate(plan, policyFacts, scamFacts);
  legacy.setScamSettings({ enabled: false, presetId: "demo", overrides: [], additionalRules: [], locale: "ko" });
  // @ts-expect-error Scam config requires settings, trust and bounded limits.
  const notYetEnabled: CoreConfig = { ...legacyConfig, scam: { enabled: true } };
  void [unchangedConfig, unchangedCore, unchangedPlan, oldVerdict, noScam, withScam, providerReuse, publicScamCalls, publicScamVerdict, notYetEnabled];
}
void [r1, r2, auxiliary, missingWindow, policyRule, textDuration, wrongThreshold, eventWindow, inventedEvent, wrongMethod, projected, requiredFact,
  numericReserve, removedSwapCounts, ambiguousGrid, missingWorkLimit, mixedVersion, rawSdkState, leakedSdkBinding,
  providerEnvelope, unknownAge, inventedAge, mintAsCreation, numericBlock, presence, ruleResults, missingAlgorithm,
  notConfigured, automaticDeny, invalidRuleState, unavailableInput, wrongFailureChannel, signedWithTelemetry,
  parsedPayload, policyKey, asynchronousAlgorithm, asynchronousModule, moduleCompatibility, compatibility];
