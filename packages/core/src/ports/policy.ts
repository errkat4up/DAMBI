import type { CallOptions } from "../types/options.js";

export interface SignedPolicyBundle {
  /** Original signed B string. Verify UTF-8 bytes without parse/re-serialization. */
  readonly payload: string;
  /** Padded Base64, 64-byte P1363 r||s; locally fixed ECDSA P-256/SHA-256. */
  readonly signature: string;
  /** API key_id mapped to camelCase; telemetry only, never a trust key selector. */
  readonly keyId?: string;
}

export interface PolicySource {
  /** Returns unmodified signed content; Core performs verification. */
  fetch(options?: CallOptions): Promise<SignedPolicyBundle>;
}
