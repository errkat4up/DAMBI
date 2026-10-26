import type { CallOptions } from "../types/options.js";
import type { SignedScamBundle } from "../types/scam.js";
import { AdapterError } from "./errors.js";
import { createSignedBundleHttpSource, type SignedBundleHttpOptions } from "./signed-bundle-http.js";

export interface ScamBundleApiSourceOptions extends SignedBundleHttpOptions {
  /** API origin only. HTTPS, or loopback HTTP for local development. */
  readonly baseUrl: string;
  /** Whole HTTP wrapper limit, separate from the Core's signed payload limit. */
  readonly maxResponseBytes: number;
  /** Routing scope only; the Core independently verifies its local trust scope. */
  readonly env: "staging" | "production";
  /** Lowercase ASCII slug, defaults to "default". */
  readonly profile?: string;
  /** Omit for latest. Canonical decimal string preserves integers beyond 2^53. */
  readonly sequence?: string;
}

export interface ScamBundleApiSource {
  /** Returns original signed bytes. No keys or trust are obtained from the server. */
  fetchScam(options?: CallOptions): Promise<SignedScamBundle>;
}

/** A separate HTTP cache; compose its fetchScam with an existing PolicySource. */
export function createScamBundleApiSource(options: ScamBundleApiSourceOptions): ScamBundleApiSource {
  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const { env, profile = "default", sequence } = options;
    if (!["staging", "production"].includes(env) || typeof profile !== "string"
        || !/^[a-z0-9-]{1,128}(?![\s\S])/.test(profile)
        || sequence !== undefined && (typeof sequence !== "string"
          || !/^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(sequence))) throw new Error();
    const query: [string, string][] = [["env", env], ["profile", profile]];
    if (sequence !== undefined) query.push(["sequence", sequence]);
    const source = createSignedBundleHttpSource(options, { pathname: "/v1/scam-bundle", query });
    return Object.freeze({ fetchScam: source.fetch });
  } catch {
    throw new AdapterError("INVALID_CONFIG", "Scam bundle API source configuration is invalid.");
  }
}
