/** Local trust only; response key IDs never select or add a verification key. */
export interface VerificationKey {
  readonly keyId: string;
  readonly role: "policy" | "decoder";
  /** Base64 DER SubjectPublicKeyInfo for ECDSA P-256. */
  readonly publicKeySpkiBase64: string;
}

export interface CoreTrust {
  readonly env: "staging" | "production";
  readonly profile: "default";
  /** At least one policy-role key required; decoder-role keys cannot verify policies. */
  readonly keys: readonly VerificationKey[];
}

/** Fixed local input, not a remote lookup port or the DEC-07 handoff index. */
export interface DecoderSnapshot {
  /**
   * SDK container JSON: { schema_version: 1, bundles: [resolved V3 bundle, ...] }.
   * Bundles are full resolved install inputs, not source manifests/index entries.
   * Container production/validation is implemented in later Core stages.
   */
  readonly artifact: string;
  /**
   * SHA-256 of the exact UTF-8 artifact bytes: 0x + 64 lowercase hex digits.
   * Pin this independently in trusted local config, not from an artifact's own
   * claimed digest. Per-bundle bundle_sha256 uses the existing Registry rules.
   */
  readonly expectedDigest: `0x${string}`;
}

/**
 * Runtime-validated finite safe integers. All fields are positive except skew,
 * which may be zero. Only maxBundleAgeSec has a default; other deployment values
 * must be explicit. Millisecond durations use the injected clock.
 */
export interface CoreLimits {
  /** Default 259200 (72 hours), including when expires_at is null. Duration in seconds. */
  readonly maxBundleAgeSec?: number;
  /** Tolerance for future policy issuance and future Fact observation, in ms. */
  readonly allowedClockSkewMs: number;
  /** Maximum UTF-8 byte length of signed policy payload B. */
  readonly maxPolicyBytes: number;
  /** Maximum UTF-8 byte length of the fixed Decoder container. */
  readonly maxDecoderBytes: number;
  /** Maximum UTF-8 byte length of the canonical request digest input. */
  readonly maxRequestBytes: number;
  /** Maximum UTF-8 JSON byte size of one FactBatch before projection. */
  readonly maxFactBytes: number;
  /** Maximum number of Fact calls in one plan, including all multicall children. */
  readonly maxPlanCalls: number;
  /** Handle lifetime in ms; this never extends the pinned snapshot's validity. */
  readonly planTtlMs: number;
  /** Maximum live unconsumed plans per Core instance. */
  readonly maxPendingPlans: number;
  /** Fact age limit in ms; cache hits must preserve the original observedAt. */
  readonly maxFactAgeMs: number;
  /** Provider fetch timeout in ms for check(). */
  readonly factTimeoutMs: number;
  /** Policy fetch timeout in ms for initialization and refreshPolicies(). */
  readonly policyTimeoutMs: number;
}
