import type { CallOptions } from "../types/options.js";
import type { SignedScamBundle } from "../types/scam.js";

/** RPC trust is configured locally and is independent of the policy signing key.
 * All fields refer to one exact safe/finalized block, never an implicit latest.
 * Numbers are nonnegative JS-safe integers; version and chainId are positive.
 */
export interface RegistryObservation {
  readonly status: "active" | "revoked";
  readonly chainId: number;
  readonly registryAddress: `0x${string}`;
  readonly env: "staging" | "production";
  readonly profile: string;
  readonly version: number;
  /** SHA-256 of the original signed UTF-8 B bytes, not reserialized JSON. */
  readonly payloadDigest: `0x${string}`;
  readonly finality: "safe" | "finalized";
  readonly blockNumber: number;
  readonly blockHash: `0x${string}`;
  /** Header timestamp in Unix seconds. */
  readonly blockTimestamp: number;
  /** Completion of a fresh RPC observation in Unix milliseconds. */
  readonly observedAtMs: number;
}

export type RegistryPolicyState = RegistryObservation | { readonly status: "unavailable" };

export interface SignedPolicyBundle {
  /** Original signed B string. Verify UTF-8 bytes without parse/re-serialization. */
  readonly payload: string;
  /** Padded Base64, 64-byte P1363 r||s; locally fixed ECDSA P-256/SHA-256. */
  readonly signature: string;
  /** API key_id mapped to camelCase; telemetry only, never a trust key selector. */
  readonly keyId?: string;
  /** Required in Registry mode. Revoked/unavailable responses may use empty
   * payload/signature strings: they are state observations, not signed bodies.
   * Never translate an RPC failure into revoked. Re-query state on every fetch,
   * including initialization; only the signed body may be transport-cached.
   */
  readonly registryState?: RegistryPolicyState;
}

export interface PolicySource {
  /** Returns unmodified signed content; Core performs verification. */
  fetch(options?: CallOptions): Promise<SignedPolicyBundle>;
  /** Optional independent channel; only locally configured scam-role keys can authenticate it. */
  fetchScam?(options?: CallOptions): Promise<SignedScamBundle>;
}
