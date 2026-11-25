/**
 * Pool-backdoor decision. Pure: no I/O, no clock.
 *
 * The input shape mirrors `PoolBackdoorObservation` in the Rust draft
 * (`crates/scam-filter` `backdoor.rs`, camelCase on the wire) so the decision
 * can move to the SDK later without reshaping what the host collects.
 *
 * | deployer call | control call        | outcome         |
 * |---------------|---------------------|-----------------|
 * | succeeded     | refused             | `fired`         |
 * | refused       | refused / succeeded | `clear`         |
 * | succeeded     | succeeded           | `incomplete`    |
 * | any call unavailable, pool balance 0 or unreadable | | `incomplete` |
 * | deployer unknown                    |               | `not_evaluable` |
 *
 * This is the definition validated in the experiments. Do not change it
 * without re-running them.
 */

/** What the host saw for one simulated call. */
export type CallObservation =
  /** Did not revert and returned nothing or a non-zero word. */
  | "succeeded"
  /** The node reported a revert, or the call returned `false`. */
  | "refused"
  /** Not observed: transport error, rate limit, node-side timeout. Never a refusal. */
  | "unavailable";

/** Raw observations for one pool at one reference block. */
export interface PoolBackdoorObservation {
  /** Sender of the pair-creation transaction. `null` without creation evidence. */
  readonly deployer: string | null;
  /** Address used for the control call. */
  readonly control: string;
  /** `token.balanceOf(pair)` as a decimal string. `null` when it could not be read. */
  readonly poolTokenBalance: string | null;
  readonly deployerCall: CallObservation;
  readonly controlCall: CallObservation;
}

export type BackdoorOutcome = "fired" | "clear" | "incomplete" | "not_evaluable";

export type BackdoorReason =
  | "no_creation_evidence"
  | "deployer_is_control"
  | "balance_unavailable"
  | "pool_empty"
  | "call_unavailable"
  | "control_also_succeeds";

export interface BackdoorFinding {
  readonly outcome: BackdoorOutcome;
  readonly reason?: BackdoorReason;
}

/** `true` for a positive decimal integer, `false` for zero, `null` if it is not one. */
function positiveDecimal(s: string): boolean | null {
  if (!/^[0-9]+$/.test(s)) return null;
  return /[1-9]/.test(s);
}

/**
 * Never returns `fired` unless both calls were observed, the pool holds
 * tokens, the deployer succeeded and the control address was refused.
 */
export function evaluatePoolBackdoor(obs: PoolBackdoorObservation): BackdoorFinding {
  if (obs.deployer === null) {
    return { outcome: "not_evaluable", reason: "no_creation_evidence" };
  }
  if (obs.deployer.toLowerCase() === obs.control.toLowerCase()) {
    return { outcome: "incomplete", reason: "deployer_is_control" };
  }
  const positive =
    obs.poolTokenBalance === null ? null : positiveDecimal(obs.poolTokenBalance);
  if (positive === null) return { outcome: "incomplete", reason: "balance_unavailable" };
  if (!positive) return { outcome: "incomplete", reason: "pool_empty" };

  const { deployerCall: dep, controlCall: ctl } = obs;
  if (dep === "unavailable" || ctl === "unavailable") {
    return { outcome: "incomplete", reason: "call_unavailable" };
  }
  if (dep === "succeeded" && ctl === "succeeded") {
    return { outcome: "incomplete", reason: "control_also_succeeds" };
  }
  if (dep === "succeeded") return { outcome: "fired" };
  return { outcome: "clear" };
}

/** The three results the extension acts on. Only `flagged` is ever shown. */
export type BackdoorResult = "flagged" | "clear" | "undetermined";

export function backdoorResult(finding: BackdoorFinding): BackdoorResult {
  if (finding.outcome === "fired") return "flagged";
  if (finding.outcome === "clear") return "clear";
  return "undetermined";
}
