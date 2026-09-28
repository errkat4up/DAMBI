import type { FactResult } from "../ports/fact.js";

/** A read-only Fact enrichment call, never a transaction to submit. */
export interface PlannedCall {
  readonly manifestId: string;
  /**
   * Opaque, unique within the whole plan, including repeated multicall children.
   * Do not derive it from manifest/spec IDs; return it unchanged in FactBatch.
   */
  readonly callId: string;
  readonly method: string;
  /** Resolved method parameters. */
  readonly params: unknown;
  /** Projection rules applied by Core to FactResult.value, never by the provider. */
  readonly outputs: readonly unknown[];
  /** Missing optional data retains the manifest's existing optional semantics. */
  readonly optional: boolean;
}

declare const corePlanBrand: unique symbol;

/**
 * Issued by one Core instance. Type branding prevents accidental construction,
 * not hostile casts/JS: runtime identity and authoritative copies live in Core.
 * A copied/serialized object is not a valid handle. Each valid handle is consumed
 * once even if Fact validation fails; callers cannot replace pinned inputs.
 */
export interface CorePlan {
  readonly [corePlanBrand]: true;
  readonly planId: string;
  readonly calls: readonly PlannedCall[];
  /** Plan TTL deadline in Unix ms. Snapshot validity is checked independently. */
  readonly expiresAt: number;
}

export interface FactBatch {
  readonly planId: string;
  /** Exact plan-issued callId keys. Core validates unknown and missing results. */
  readonly results: Readonly<Record<string, FactResult>>;
}
