/**
 * @typedef {object} CheckTimingMeasurement
 * @property {"completed" | "rejected"} outcome Promise settlement, not analysis success.
 * @property {number} checkDurationMs
 * @property {2500} targetBudgetMs A latency comparison, not a performance acceptance flag.
 * @property {boolean} withinBudget Does not establish complete coverage or a real algorithm.
 * @property {import("@dambi/core").Verdict["decision"]} [decision]
 * @property {import("@dambi/core").Verdict["source"]} [source]
 * @property {import("@dambi/core").ScamReport["status"]} [scamStatus]
 * @property {readonly ("real" | "stub")[]} [analysisModes] Only modes declared by returned targets.
 */

/**
 * Host-side measurement of the complete core.check call, including its plan,
 * policy/scam Fact fetching, evaluation and synchronous notifications. Starts
 * immediately before calling check and ends when its promise resolves or rejects.
 * Initialization, prepare, this measurement callback and later rendering/UI are
 * excluded. Core's asynchronous notifications are not awaited by check.
 *
 * The original verdict/error is preserved. The observer receives one immutable,
 * allowlisted summary without requests, addresses, remote errors or endpoint URLs.
 * Its promise is not awaited and its failures cannot replace the check outcome.
 * @param {Pick<import("@dambi/core").DambiCore, "check">} core
 * @param {Parameters<import("@dambi/core").DambiCore["check"]>[0]} request
 * @param {import("@dambi/core").CallOptions | undefined} options
 * @param {(measurement: Readonly<CheckTimingMeasurement>) => void | Promise<void>} onMeasurement
 * @returns {Promise<import("@dambi/core").Verdict>}
 */
export async function checkWithTiming(core, request, options, onMeasurement) {
  /** @type {import("@dambi/core").Verdict | undefined} */
  let verdict;
  /** @type {"completed" | "rejected"} */
  let outcome = "rejected";
  const started = performance.now();
  try {
    verdict = await core.check(request, options);
    outcome = "completed";
    return verdict;
  } finally {
    const checkDurationMs = Math.max(0, performance.now() - started);
    /** @type {CheckTimingMeasurement} */
    const measurement = { outcome, checkDurationMs, targetBudgetMs: 2500, withinBudget: checkDurationMs <= 2500 };
    if (outcome === "completed") {
      try {
        const decision = verdict?.decision;
        if (decision === "allow" || decision === "warn" || decision === "deny") measurement.decision = decision;
        const source = verdict?.source;
        if (source === "evaluated" || source === "fail_closed") measurement.source = source;
        const scam = verdict?.scam;
        const status = scam?.status;
        if (status === "not_configured" || status === "disabled" || status === "not_applicable"
            || status === "insufficient" || status === "quiet" || status === "warn") measurement.scamStatus = status;
        /** @type {Set<"real" | "stub">} */
        const modes = new Set();
        for (const target of scam?.targets ?? []) {
          const mode = target.analysisMode;
          if (mode === "real" || mode === "stub") modes.add(mode);
        }
        measurement.analysisModes = Object.freeze([...modes]);
      } catch { /* A malformed summary must not change the original verdict. */ }
    }
    try {
      void Promise.resolve(onMeasurement(Object.freeze(measurement))).catch(() => {});
    } catch { /* Measurement observers are notification-only. */ }
  }
}
