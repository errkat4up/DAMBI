/** D4-1 SDK draft only; not exported from @dambi/core or agreed with an API server. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Decimal non-negative integer text. Pattern/range checks are not expressed by TypeScript. */
export type SequenceDecimal = string;

/** Integer Unix seconds in the JS safe-integer range; operational limits are still undecided. */
export type UnixSeconds = number;

/** Structural wire skeleton, not the full ManifestV2/Cedar validation contract. */
export interface ManifestWireV2 {
  id: string;
  schema_version: 2;
  trigger?: { [key: string]: JsonValue };
  policy_rpc?: { [key: string]: JsonValue }[];
  custom_context?: { [key: string]: JsonValue };
}

export interface PolicyEntryDraft {
  id: string;
  policy: string;
  manifest: ManifestWireV2;
}

export interface PolicyPayloadDraftV1 {
  schema_version: 1;
  policies: PolicyEntryDraft[];
  sequence: SequenceDecimal;
  issued_at: UnixSeconds;
  /** Null does not bypass Core's future maximum-age checks. */
  expires_at: UnixSeconds | null;
  env: string;
  profile: string;
  registry_ref: null;
}

export interface PolicyEnvelopeDraftV1 {
  /** Original B JSON text. Signature input = UTF-8(payload), without JCS or reserialization. */
  payload: string;
  sig: {
    /** Proposed fixed algorithm; never accept algorithm negotiation from an untrusted envelope. */
    alg: "ECDSA_P256_SHA256";
    /** Lookup only among host-configured policy keys. Never creates trust by itself. */
    key_id: string;
    /** Padded Base64 encoding of the 64-byte IEEE P1363 signature. */
    sig_b64: string;
  };
}

/** Local trust configuration, not a field supplied by the policy/decoder response. */
export interface VerificationKeyDraft {
  key_id: string;
  role: "policy" | "decoder";
  public_key_spki_b64: string;
}
