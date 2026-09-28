/**
 * Internal v0.1 policy wire types aligned with registry-api/openapi.yaml and
 * registryV2/scripts/publish-policy-bundle.ts. Not exported from @dambi/core.
 * WireV1 names identify this supported contract; no payload version field is sent.
 * The companion fixture schema deliberately rejects unknown outer fields.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON integer in 1..Number.MAX_SAFE_INTEGER. Runtime checks enforce the range. */
export type Sequence = number;

/** Non-negative integer Unix seconds in the JS safe-integer range. */
export type UnixSeconds = number;

/** Structural wire skeleton, not the full ManifestV2/Cedar validation contract. */
export interface ManifestWireV2 {
  id: string;
  schema_version: 2;
  trigger?: { [key: string]: JsonValue };
  policy_rpc?: { [key: string]: JsonValue }[];
  custom_context?: { [key: string]: JsonValue };
}

export interface PolicyEntryWireV1 {
  id: string;
  policy: string;
  manifest: ManifestWireV2;
}

export interface PolicyPayloadWireV1 {
  policies: PolicyEntryWireV1[];
  sequence: Sequence;
  issued_at: UnixSeconds;
  /** Null does not bypass Core's future maximum-age checks. */
  expires_at: UnixSeconds | null;
  env: "staging" | "production";
  /** Non-empty string structurally; v0.1 expects default in semantic validation. */
  profile: string;
  /** Non-null strings are structurally valid but semantically unsupported in v0.1. */
  registry_ref: string | null;
}

export interface PolicyEnvelopeWireV1 {
  /** Original B JSON text. Signature input = UTF-8(payload), without JCS or reserialization. */
  payload: string;
  /** Padded Base64 of 64-byte P1363 r||s; verification fixes ECDSA P-256/SHA-256 locally. */
  signature: string;
  /** Optional telemetry only, including empty strings. Never selects a verification key. */
  key_id?: string;
}

/** Local trust configuration, not a field supplied by the policy/decoder response. */
export interface VerificationKeyConfig {
  /** Local key label; unrelated to selecting trust from response telemetry. */
  key_id: string;
  role: "policy" | "decoder";
  public_key_spki_b64: string;
}
