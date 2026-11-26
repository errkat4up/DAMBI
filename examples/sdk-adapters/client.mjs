import { createCore } from "@dambi/core";
import { decoderSnapshot } from "@dambi/core/decoders";
import { createEvmFactProvider, createPolicyApiSource } from "@dambi/core/adapters";

/**
 * @typedef {object} AdapterSettings
 * @property {Pick<import("@dambi/core/adapters").PolicyApiSourceOptions, "baseUrl" | "maxResponseBytes" | "headers">} policy
 * @property {Pick<import("@dambi/core/adapters").EvmFactProviderOptions, "chains" | "maxResponseBytes">} fact
 * @property {import("@dambi/core").CoreTrust} trust
 * @property {import("@dambi/core").CoreLimits} limits
 * @property {import("@dambi/core").CoreConfig["enforcement"]} enforcement
 */

/**
 * Both hosts use the installed package's public exports and owned WASM.
 * URLs, trusted public keys and deployment limits belong to the caller.
 * @param {AdapterSettings} settings
 * @param {import("@dambi/core").CallOptions} [options]
 * @returns {Promise<import("@dambi/core").DambiCore>}
 */
/**
 * Consumer presentation, not a replacement Core decision or enforcement rule.
 * Keep the original verdict alongside this summary: an independent deny must
 * remain visible even when another part of evaluation is incomplete.
 *
 * No automatic signing is authorized by this example. `reviewEligible` only
 * identifies results eligible for the host's separate signing review.
 */
export function describeCheck(verdict) {
  const codes = new Set((verdict?.diagnostics ?? []).map(({ code }) => code));
  const requiredFactFailure = verdict?.source === "fail_closed"
    && ["required_fact_missing", "projection_failed", "invalid_fact", "fact_plan_mismatch",
      "fact_fetch_failed", "timeout"].some((code) => codes.has(code));
  const partial = codes.has("partial_decode");
  const unsupported = codes.has("unsupported_request");
  const unmatched = codes.has("no_matching_policy");
  const failed = verdict?.source !== "evaluated";
  const status = requiredFactFailure ? "fact_evaluation_failed"
    : failed ? "evaluation_failed"
      : unsupported ? "unsupported_request"
        : partial ? "partial_interpretation"
          : unmatched ? "policy_unmatched"
            : "evaluated";
  return {
    status,
    decision: verdict?.decision,
    source: verdict?.source,
    enforcement: verdict?.enforcement,
    partial,
    policyUnmatched: unmatched,
    reviewEligible: status === "evaluated" && verdict?.decision === "allow"
      && codes.size === 0,
    signingAuthorized: false,
  };
}

export async function createAdapterCore(settings, options) {
  const policy = createPolicyApiSource({
    baseUrl: settings.policy.baseUrl,
    maxResponseBytes: settings.policy.maxResponseBytes,
    headers: settings.policy.headers,
  });
  const fact = createEvmFactProvider({
    chains: settings.fact.chains,
    maxResponseBytes: settings.fact.maxResponseBytes,
  });
  return createCore({
    decoderSnapshot,
    ports: { policy, fact },
    trust: settings.trust,
    limits: settings.limits,
    enforcement: settings.enforcement,
  }, options);
}
