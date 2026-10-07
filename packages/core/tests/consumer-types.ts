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

const packagedSnapshot: DecoderSnapshot = decoderSnapshot;
const packagedBytes: number = decoderSnapshotInfo.bytes;
void [packagedSnapshot, packagedBytes];

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
