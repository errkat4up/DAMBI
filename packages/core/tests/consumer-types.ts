/**
 * Compile against package exports after `core:build`, never against src paths.
 * @ts-expect-error cases must keep failing: unused directives fail this check.
 */
import {
  CoreError,
  createCore,
  type CallOptions,
  type CheckRequest,
  type CoreConfig,
  type CoreDiagnostic,
  type CoreErrorCode,
  type CoreHooks,
  type CorePlan,
  type DambiCore,
  type DecoderSnapshot,
  type FactBatch,
  type FactProvider,
  type FactResult,
  type PlannedCall,
  type PolicySource,
  type Ports,
  type SignedPolicyBundle,
  type UnsupportedRequest,
  type Verdict,
} from "@dambi/core";
import "@dambi/core/internal";
import { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";
import {
  AdapterError,
  createPolicyApiSource,
  createEvmFactProvider,
  createScamFactProvider,
  ScamDataError,
  type ScamFactProviderOptions,
  type ScamProviderMetrics,
  type ScamProviderDiagnostic,
  type ScamRpcDiagnostic,
  type AdapterErrorCode,
  type PolicyApiSourceOptions,
  type EvmFactProviderOptions,
  type EvmRpcEndpoint,
} from "@dambi/core/adapters";

const packagedSnapshot: DecoderSnapshot = decoderSnapshot;
const packagedBytes: number = decoderSnapshotInfo.bytes;
void [packagedSnapshot, packagedBytes];

const policyApiOptions: PolicyApiSourceOptions = {
  baseUrl: "https://policies.example",
  maxResponseBytes: 1_000_000,
  profile: "default",
  version: 42,
  headers: { authorization: "Bearer host-configured" },
  fetch: globalThis.fetch,
};
const policyApi: PolicySource = createPolicyApiSource(policyApiOptions);
const fetchedPolicy: Promise<SignedPolicyBundle> = policyApi.fetch({ signal: new AbortController().signal });
// @ts-expect-error Response size must be an explicit host decision.
createPolicyApiSource({ baseUrl: "https://policies.example" });
// @ts-expect-error Only the currently supported policy profile is accepted.
createPolicyApiSource({ ...policyApiOptions, profile: "custom" });
// @ts-expect-error Server version selection is a number, not an opaque string.
createPolicyApiSource({ ...policyApiOptions, version: "42" });
// @ts-expect-error HTTP headers contain string values.
createPolicyApiSource({ ...policyApiOptions, headers: { authorization: 42 } });
// @ts-expect-error The policy adapter belongs to its optional public subpath.
import { createPolicyApiSource as rootPolicyApi } from "@dambi/core";

function consumeAdapterError(error: AdapterError): void {
  const adapterCode: AdapterErrorCode = error.code;
  const httpStatus: number | undefined = error.status;
  // @ts-expect-error Error codes are stable adapter categories, not arbitrary strings.
  const invalidAdapterCode: AdapterErrorCode = "INVALID_SIGNATURE";
  // @ts-expect-error Consumers cannot rewrite the adapter's HTTP status.
  error.status = 200;
  void [adapterCode, httpStatus, invalidAdapterCode];
}
void [policyApi, fetchedPolicy, consumeAdapterError];

const rpcEndpoint: EvmRpcEndpoint = {
  rpcUrl: "https://rpc.example/v1/host-configured",
  headers: { authorization: "Bearer host-configured" },
};
const evmOptions: EvmFactProviderOptions = {
  chains: { "eip155:1": rpcEndpoint },
  maxResponseBytes: 16_384,
  fetch: globalThis.fetch,
  clock: { now: () => 1_800_000_000_000 },
};
const evmFact: FactProvider = createEvmFactProvider(evmOptions);
const evmBatch: Promise<FactBatch> = evmFact.fetch([], { planId: "plan", signal: new AbortController().signal });
const invalidFactRequest: AdapterErrorCode = "INVALID_REQUEST";
// @ts-expect-error The host must set the HTTP response limit.
createEvmFactProvider({ chains: evmOptions.chains });
// @ts-expect-error RPC endpoint headers must contain string values.
createEvmFactProvider({ ...evmOptions, chains: { "eip155:1": { rpcUrl: rpcEndpoint.rpcUrl, headers: { authorization: 42 } } } });
// @ts-expect-error The clock follows Core's Clock port rather than a function option.
createEvmFactProvider({ ...evmOptions, clock: Date.now });
// @ts-expect-error Direct Fact fetches must be bound to a plan ID.
evmFact.fetch([], { signal: new AbortController().signal });
// @ts-expect-error The EVM adapter belongs to its optional public subpath.
import { createEvmFactProvider as rootEvmFactProvider } from "@dambi/core";
void [evmFact, evmBatch, invalidFactRequest];

function scamAdapter(options: ScamFactProviderOptions): FactProvider {
  return createScamFactProvider({ ...options, policy: evmFact,
    rpc: { ...options.rpc, limits: { ...options.rpc.limits, minRequestIntervalMs: 75,
      maxRetryDelayMs: Math.max(30_000, options.rpc.limits.retryDelayMs) } },
    onMetrics(metrics: ScamProviderMetrics) {
      const outcome: "success" | "partial" | "failed" = metrics.outcome;
      // @ts-expect-error Diagnostic snapshots are read-only.
      metrics.requests = 0;
      if (metrics.preflight) {
        const minimumRequests: number = metrics.preflight.minimumRemainingRequests;
        const group: number | undefined = metrics.preflightGroup;
        // @ts-expect-error Preflight snapshots cannot be edited by observers.
        metrics.preflight.remainingRequestBudget = 0;
        void [minimumRequests, group];
      }
      const failure: ScamProviderDiagnostic | undefined = metrics.failure;
      if (failure) {
        const raw: ScamRpcDiagnostic = failure;
        const operation: "request" | "reference" | "pool_identity" | "pool_history" | "token_profile" | "result" | "final_recheck" | undefined = failure.operation;
        // @ts-expect-error Failure details are immutable snapshots too.
        failure.stage = "provider";
        // @ts-expect-error Remote messages and endpoint URLs are never diagnostic fields.
        const message = failure.message;
        void [raw, operation, message];
      }
      void outcome;
    } });
}
function invalidScamPacing(options: ScamFactProviderOptions): void {
  // @ts-expect-error Request pacing is a numeric duration, never an RPC provider label.
  createScamFactProvider({ ...options, rpc: { ...options.rpc, limits: { ...options.rpc.limits, minRequestIntervalMs: "75" } } });
  // @ts-expect-error Retry backoff caps are numeric durations too.
  createScamFactProvider({ ...options, rpc: { ...options.rpc, limits: { ...options.rpc.limits, maxRetryDelayMs: "30000" } } });
}
const scamDataFailure = new ScamDataError("reorg");
// @ts-expect-error Only sanitized advisory failure categories may cross the port.
new ScamDataError("arbitrary_remote_error");
// @ts-expect-error Provider failure reasons are immutable.
scamDataFailure.reason = "timeout";
void [scamAdapter, invalidScamPacing, scamDataFailure];

// @ts-expect-error Decoder lookup is not a public I/O port.
import type { DecoderSource } from "@dambi/core";
// @ts-expect-error Callers cannot inject arbitrary policies during evaluation.
import type { PolicySet } from "@dambi/core";
// @ts-expect-error Facts must be bound to a plan through FactBatch.
import type { FactMap } from "@dambi/core";

function knownRequest(req: CheckRequest): void {
  switch (req.kind) {
    case "transaction": {
      const chain: string = req.chainId;
      const data: string | undefined = req.data;
      void [chain, data];
      break;
    }
    case "typed_signature": {
      const chain: string = req.chainId;
      const typedData: unknown = req.typedData;
      void [chain, typedData];
      break;
    }
    case "untyped_signature": {
      const message: string = req.message;
      const from: string | undefined = req.from;
      void [message, from];
      break;
    }
    case "venue_order": {
      const from: string = req.from;
      const order: unknown = req.order;
      void [from, order];
      break;
    }
    default: {
      const exhaustive: never = req;
      void exhaustive;
    }
  }
}

const transaction: CheckRequest = {
  kind: "transaction",
  chainId: "eip155:1",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  data: "0x",
  value: "0",
};
const unsupported: UnsupportedRequest = { kind: "future_kind" };
// @ts-expect-error An unknown kind must not weaken known-request narrowing.
const invalidKnownRequest: CheckRequest = unsupported;

const signed: SignedPolicyBundle = {
  payload: '{"sequence":42}',
  signature: "fixture-signature",
  keyId: "telemetry-only",
};
const noTelemetry: SignedPolicyBundle = { payload: signed.payload, signature: signed.signature };
// @ts-expect-error The signature covers the original string, not a parsed object.
const parsedBundle: SignedPolicyBundle = { payload: { sequence: 42 }, signature: signed.signature };

// The provider returns a method response before Core applies output projection.
const balance: FactResult = {
  value: { balance: "0x64" },
  source: "fixture:portfolio.balance",
  observedAt: 1_800_000_000_000,
  blockNumber: "12345",
};
// @ts-expect-error Fact provenance must include a source.
const missingSource: FactResult = { value: {}, observedAt: 1_800_000_000_000 };
// @ts-expect-error Fact provenance must include observation time in milliseconds.
const missingObservation: FactResult = { value: {}, source: "fixture" };

const policy: PolicySource = {
  async fetch(options) {
    const signal: AbortSignal | undefined = options?.signal;
    void signal;
    return noTelemetry;
  },
};
const fact: FactProvider = {
  async fetch(calls, options) {
    const planned: readonly PlannedCall[] = calls;
    const signal: AbortSignal | undefined = options.signal;
    const results: Record<string, FactResult> = {};
    for (const call of planned) results[call.callId] = balance;
    void signal;
    return { planId: options.planId, results };
  },
};

function audit(verdict: Verdict): void {
  const diagnostics: readonly CoreDiagnostic[] = verdict.diagnostics;
  if (verdict.metadata.status === "available") {
    const digest: `0x${string}` = verdict.metadata.requestDigest;
    const policyVersion: string = verdict.metadata.policyVersion;
    const engineVersion: string = verdict.metadata.engineVersion;
    void [digest, policyVersion, engineVersion];
  } else {
    const reason:
      | "invalid_request"
      | "unsupported_request"
      | "untrusted_snapshot"
      | "engine_unavailable" = verdict.metadata.reason;
    // @ts-expect-error Unavailable metadata must not contain a fake digest.
    const digest = verdict.metadata.requestDigest;
    void [reason, digest];
  }
  void diagnostics;
}

const hooks: CoreHooks = {
  onPending(req) {
    const pending: CheckRequest | UnsupportedRequest = req;
    void pending;
  },
  onVerdict: audit,
  onDiagnostic(event) {
    const diagnostic: CoreDiagnostic = event;
    void diagnostic;
  },
};
const ports: Ports = { policy, fact };
const config: CoreConfig = {
  ports,
  decoderSnapshot: { artifact: "fixture-decoder-artifact", expectedDigest: "0x00" },
  trust: {
    env: "staging",
    profile: "default",
    keys: [{ keyId: "fixture-policy", role: "policy", publicKeySpkiBase64: "fixture-spki" }],
  },
  limits: {
    allowedClockSkewMs: 1_000,
    maxPolicyBytes: 1_000_000,
    maxDecoderBytes: 1_000_000,
    maxRequestBytes: 100_000,
    maxFactBytes: 1_000_000,
    maxPlanCalls: 64,
    planTtlMs: 30_000,
    maxPendingPlans: 16,
    maxFactAgeMs: 10_000,
    factTimeoutMs: 5_000,
    policyTimeoutMs: 5_000,
  },
  clock: { now: () => 1_800_000_000_000 },
  hooks,
  enforcement: "advisory",
};
// @ts-expect-error A decoder port is replaced by the fixed decoderSnapshot configuration.
const decoderPorts: Ports = { policy, fact, decoder: { load: async () => null } };
// @ts-expect-error Clock belongs to configuration, not the I/O port collection.
const clockPorts: Ports = { policy, fact, clock: { now: () => 0 } };

// @ts-expect-error Only Core can issue the nominally branded plan handle.
const forgedPlan: CorePlan = { planId: "invented", calls: [], expiresAt: 1_800_000_030_000 };
// @ts-expect-error A fact map without its plan ID cannot be evaluated.
const unboundFacts: FactBatch = { results: {} };

async function consume(): Promise<void> {
  const options: CallOptions = { signal: new AbortController().signal };
  const initialization: Promise<DambiCore> = createCore(config, options);
  // @ts-expect-error Initialization must finish before an instance can be used.
  const synchronousCore: DambiCore = createCore(config);
  const core = await initialization;
  const plan: CorePlan = await core.plan(transaction, options);
  const batch: FactBatch = await fact.fetch(plan.calls, { ...options, planId: plan.planId });
  const verdict: Verdict = core.evaluate(plan, batch);
  audit(verdict);
  audit(await core.check(transaction, options));
  audit(await core.check(unsupported, options));
  await core.refreshPolicies(options);
  core.dispose();

  // @ts-expect-error plan accepts only known request variants.
  await core.plan(unsupported);
  // @ts-expect-error The old request/policy/fact evaluate signature is removed.
  core.evaluate(transaction, [], {});
  // @ts-expect-error Callers cannot replace the plan's identity.
  plan.planId = "replacement";
  // @ts-expect-error Callers cannot replace the readonly call list.
  plan.calls.push({});
  // @ts-expect-error FactProvider requires plan binding in its options.
  await fact.fetch(plan.calls);
  void synchronousCore;
}

const scaffoldError = new CoreError("NOT_IMPLEMENTED", "fixture");
const errorCode: CoreErrorCode = scaffoldError.code;
// @ts-expect-error Consumers cannot rely on arbitrary engine error strings as codes.
const unstableCode: CoreErrorCode = "some internal engine error";
void [knownRequest, consume, config, errorCode, unstableCode];
