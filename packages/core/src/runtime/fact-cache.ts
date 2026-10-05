import type { FactResult } from "../ports/fact.js";
import type { CoreLimits } from "../types/config.js";
import type { FactBatch, PlannedCall } from "../types/plan.js";
import { copyJson, field, freezeTree, record } from "./json.js";

interface Entry {
  readonly result: FactResult;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/** The input is already a private JSON copy, so no host accessors run here. */
function sortedJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) parts.push(sortedJson(value[index]));
    return `[${parts.join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object).sort()) {
    parts.push(`${JSON.stringify(key)}:${sortedJson(object[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/** Instance-local raw responses; policy projection remains Native Core's job. */
export class FactCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxAge: number;
  readonly #skew: number;
  #bytes = 0;
  #lastNow: number | undefined;

  constructor(limits: CoreLimits) {
    // Copy primitive limits rather than retaining a caller-owned config object.
    this.#maxEntries = limits.maxPlanCalls;
    this.#maxBytes = limits.maxFactBytes;
    this.#maxAge = limits.maxFactAgeMs;
    this.#skew = limits.allowedClockSkewMs;
  }

  get(chainId: string, call: PlannedCall, now: number): FactResult | undefined {
    if (!this.#observe(now)) return undefined;
    this.#prune(now);
    try {
      const key = this.#key(chainId, call);
      if (key === undefined) return undefined;
      const entry = this.#entries.get(key);
      if (!entry) return undefined;
      // Successful reuse updates recency, never the response's observedAt.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.result;
    } catch {
      // Caching is optional and must not replace normal provider validation.
      return undefined;
    }
  }

  put(chainId: string, calls: readonly PlannedCall[], batch: FactBatch, now: number): void {
    if (!this.#observe(now)) return;
    this.#prune(now);
    try {
      if (calls.length > this.#maxEntries) return;
      const copied = record(copyJson(batch, "INVALID_REQUEST", this.#maxBytes), "INVALID_REQUEST");
      if (Object.keys(copied).some((key) => key !== "planId" && key !== "results")
          || typeof copied.planId !== "string" || !copied.planId) return;
      const results = record(copied.results, "INVALID_REQUEST");
      for (const call of calls) {
        // Native silently skips failed optional projections, so an evaluated
        // verdict alone cannot prove that their raw response was usable. Only
        // required calls with outputs establish that evidence; output.required
        // is a legacy flag and does not control v2 projection failure behavior.
        if (call.optional !== false || call.outputs.length === 0) continue;
        const key = this.#key(chainId, call);
        if (key === undefined) continue;
        const value = results[call.callId];
        if (!this.#validResult(value, now)) continue;
        const previous = this.#entries.get(key);
        // Concurrent checks may complete in reverse order. Keep the newer fact.
        if (previous && previous.result.observedAt > value.observedAt) continue;
        const json = JSON.stringify(value);
        const keyBytes = encoder.encode(key).byteLength;
        const resultBytes = encoder.encode(json).byteLength;
        if (keyBytes > this.#maxBytes || resultBytes > this.#maxBytes - keyBytes) continue;
        const bytes = keyBytes + resultBytes;
        const result = freezeTree(JSON.parse(json) as FactResult);
        this.#remove(key);
        while (this.#entries.size >= this.#maxEntries || bytes > this.#maxBytes - this.#bytes) {
          const oldest = this.#entries.keys().next().value;
          if (oldest === undefined) break;
          this.#remove(oldest);
        }
        this.#entries.set(key, { result, bytes });
        this.#bytes += bytes;
      }
    } catch {
      // Invalid/missing responses remain misses; never manufacture a value.
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#lastNow = undefined;
  }

  #key(chainId: string, call: PlannedCall): string | undefined {
    if (typeof chainId !== "string" || !chainId) return undefined;
    const source = record(call, "INVALID_REQUEST");
    const method = field(source, "method", true, "INVALID_REQUEST");
    if (typeof method !== "string" || !method) return undefined;
    const params = field(source, "params", true, "INVALID_REQUEST");
    // Include all parameters, including block selectors, without projection.
    return sortedJson(copyJson([chainId, method, params], "INVALID_REQUEST", this.#maxBytes));
  }

  #observe(now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0) { this.clear(); return false; }
    if (this.#lastNow !== undefined && now < this.#lastNow) {
      this.clear();
      this.#lastNow = now;
      return false;
    }
    this.#lastNow = now;
    return true;
  }

  #fresh(observedAt: number, now: number): boolean {
    return Number.isSafeInteger(observedAt) && observedAt >= 0
      && observedAt - now <= this.#skew && now - observedAt <= this.#maxAge;
  }

  #validResult(value: unknown, now: number): value is FactResult {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    if (Object.keys(result).some((key) => !["value", "source", "observedAt", "blockNumber"].includes(key))
        || !Object.hasOwn(result, "value") || result.value === null
        || typeof result.source !== "string" || !result.source.trim()
        || typeof result.observedAt !== "number" || !this.#fresh(result.observedAt, now)) return false;
    if (Object.hasOwn(result, "blockNumber")
        && (typeof result.blockNumber !== "string" || !/^[0-9]+$/.test(result.blockNumber))) return false;
    const raw = result.value;
    // RPC envelopes and explicit method errors are not successful raw responses.
    return !(typeof raw === "object" && raw !== null
      && (Object.hasOwn(raw, "error") || Object.hasOwn(raw, "jsonrpc")));
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (!this.#fresh(entry.result.observedAt, now)) this.#remove(key);
    }
  }

  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) { this.#bytes -= entry.bytes; this.#entries.delete(key); }
  }
}
