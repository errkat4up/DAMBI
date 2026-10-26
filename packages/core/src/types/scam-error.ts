/** Explicit, sanitized provider failures for the advisory channel only. */
export type ScamDataFailure = "reorg" | "resource_limit" | "timeout"
  | "subject_mismatch" | "invalid_scam_input" | "data_missing";

const reasons: readonly string[] = Object.freeze([
  "reorg", "resource_limit", "timeout", "subject_mismatch", "invalid_scam_input", "data_missing",
]);

/** Never attach remote messages, endpoint URLs or arbitrary failure metadata. */
export class ScamDataError extends Error {
  readonly reason: ScamDataFailure;

  constructor(reason: ScamDataFailure) {
    if (typeof reason !== "string" || !reasons.includes(reason)) {
      throw new TypeError("Scam data failure reason is invalid.");
    }
    super(`Scam data is unavailable: ${reason}.`);
    this.name = "ScamDataError";
    this.reason = reason;
    Object.defineProperty(this, "reason", { writable: false, configurable: false });
  }
}
