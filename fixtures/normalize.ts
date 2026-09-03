/**
 * Canonicalize verdict snapshots without hiding policy-relevant values.
 *
 * The engine envelope is currently deterministic.  These keys are retained
 * here solely for a future host wrapper that attaches diagnostic timing; no
 * action, block, nonce, or submitted-at field is removed.
 */
const DIAGNOSTIC_TIME_FIELDS = new Set([
  "durationMs",
  "duration_ms",
  "elapsedMs",
  "elapsed_ms",
  "evaluatedAt",
  "evaluated_at",
  "decidedAtMs",
  "decided_at_ms",
  "observedAt",
  "observed_at",
]);

/** Recursively sort JSON-object keys and omit diagnostic-only timing fields. */
export function normalizeVerdictOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVerdictOutput);

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => !DIAGNOSTIC_TIME_FIELDS.has(key))
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeVerdictOutput(record[key])]),
    );
  }

  return value;
}

/** Produce stable, readable fixture output. */
export function stableVerdictJson(value: unknown): string {
  return `${JSON.stringify(normalizeVerdictOutput(value), null, 2)}\n`;
}
