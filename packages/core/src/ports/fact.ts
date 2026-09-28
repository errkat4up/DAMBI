import type { FactBatch, PlannedCall } from "../types/plan.js";
import type { CallOptions } from "../types/options.js";

export interface FactResult {
  /**
   * JSON-compatible method response before projection, e.g. { balance: "0x64" }.
   * Not a JSON-RPC envelope, ABI word or already projected scalar. Providers
   * validate method-specific encoding (e.g. canonical U256 for balances).
   */
  readonly value: unknown;
  /** Provider/endpoint label, not proof of authenticity. */
  readonly source: string;
  /** Decimal integer string; optional for off-chain data. */
  readonly blockNumber?: string;
  /** Unix milliseconds; preserve the original observation time on cache hits. */
  readonly observedAt: number;
}

export interface FactProvider {
  /**
   * Return results keyed by the exact opaque callId. Omit unavailable calls;
   * Core decides required/optional behavior from its pinned manifest. Reject
   * whole-fetch failures. Never manufacture a zero value on failure.
   */
  fetch(
    calls: readonly PlannedCall[],
    options: CallOptions & { readonly planId: string },
  ): Promise<FactBatch>;
}
