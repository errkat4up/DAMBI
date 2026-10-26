import type { PolicySource } from "../ports/policy.js";
import { AdapterError } from "./errors.js";
import { createSignedBundleHttpSource, type SignedBundleHttpOptions } from "./signed-bundle-http.js";

export interface PolicyApiSourceOptions extends SignedBundleHttpOptions {
  /** API origin only. HTTPS, or loopback HTTP for local development. */
  readonly baseUrl: string;
  /** Limit for the entire HTTP wrapper, distinct from Core's payload limit. */
  readonly maxResponseBytes: number;
  readonly profile?: "default";
  /** Server sequence selection; not an additional Core trust constraint. */
  readonly version?: number;
}

/** Transport cache only. Core rechecks signature, expiry and sequence on every fetch. */
export function createPolicyApiSource(options: PolicyApiSourceOptions): PolicySource {
  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const { profile = "default", version } = options;
    if (profile !== "default" || version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error();
    const query: [string, string][] = [["profile", profile]];
    if (version !== undefined) query.push(["version", String(version)]);
    return createSignedBundleHttpSource(options, { pathname: "/v1/bundle", query });
  } catch {
    throw new AdapterError("INVALID_CONFIG", "Policy API source configuration is invalid.");
  }
}
