// This worker owns the actual raw source and its in-memory verified intervals.
// Each fetch still builds new Facts, with fresh reference and canonical checks.
import { createScamFactProvider, ScamDataError } from "@dambi/core/adapters";
const work = new Map();
const epoch = crypto.randomUUID();
let provider;
self.onmessage = async ({ data }) => {
  if (data.cancel) { work.get(data.cancel)?.abort(); return; }
  const { id, raw, method, calls, planId, timeoutMs } = data;
  if (work.has(id) || !["fetch", "prepare"].includes(method)) return;
  const controller = new AbortController();
  work.set(id, controller);
  try {
    provider ??= createScamFactProvider({
      ...raw,
      policy: { fetch: () => { throw new Error("Unexpected policy request"); } },
      onMetrics(metric) {
        // The SDK's diagnostic callback has no request ID. Never attribute
        // an overlapping observation to another operation.
        if (work.size === 1) self.postMessage({ id: work.keys().next().value, kind: "metric", metric });
      },
    });
    const batch = await provider[method](calls, { planId, signal: controller.signal, timeoutMs });
    if (!controller.signal.aborted) self.postMessage({ id, epoch, kind: "complete", batch });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, epoch, kind: "failure", reason: error instanceof ScamDataError ? error.reason : undefined });
  } finally { work.delete(id); }
};
