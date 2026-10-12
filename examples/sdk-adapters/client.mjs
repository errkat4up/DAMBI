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
