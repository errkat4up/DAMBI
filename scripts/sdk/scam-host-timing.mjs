// Executed only by the manual CDP probe in one development extension worker.
// Keep this function self-contained so it can be installed without bundling it into the extension.
export function observeScamHost(scope, publish) {
  const { runtime, storage } = scope.chrome;
  const active = new Map();
  const ports = new Map();
  let ordinal = 0;
  const prefix = "scam:confirm:";

  function receive(message) {
    if (message?.data?.type !== "transaction" || message.data.bypassed ||
        typeof message.requestId !== "string" || !message.requestId) return;
    const started = scope.performance.now();
    const previous = active.get(message.requestId);
    const id = ++ordinal;
    publish({ event: "start", id });
    if (previous) {
      // Never assign the next publication to one of two indistinguishable starts.
      if (previous.id) publish({ event: "missing", id: previous.id, reason: "duplicate_request_id" });
      publish({ event: "missing", id, reason: "duplicate_request_id" });
      active.set(message.requestId, {});
      return;
    }
    active.set(message.requestId, { id, started });
  }

  function connect(port) {
    if (port.name !== "dambi-contentscript") return;
    const disconnect = () => {
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnect);
      ports.delete(port);
    };
    ports.set(port, disconnect);
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnect);
  }

  function changed(changes, area) {
    if (area !== "session") return;
    const published = scope.performance.now();
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(prefix) || !change.newValue) continue;
      const requestId = key.slice(prefix.length);
      const trial = active.get(requestId);
      if (!trial?.id) continue;
      active.delete(requestId);
      const record = change.newValue;
      const display = record.display;
      const report = display?.report;
      const durationMs = published - trial.started;
      const valid = record.requestId === requestId && Number.isSafeInteger(record.expiresAtMs)
        && record.expiresAtMs > Date.now() && Number.isFinite(durationMs) && durationMs >= 0
        && display?.version === 1 && display.holding === "unknown";
      if (valid && display.kind === "report" &&
          ["warn", "quiet", "insufficient", "not_applicable", "disabled", "not_configured"].includes(report?.status) &&
          report.scopeNotice === "patterns_only_no_sellability_guarantee" && Array.isArray(report.targets)) {
        publish({ event: "result", id: trial.id, kind: "report", status: report.status,
          reportedTargets: report.targets.length, durationMs });
      } else if (valid && display.kind === "unavailable") {
        publish({ event: "result", id: trial.id, kind: "unavailable", timedOut: display.reason === "timeout", durationMs });
      } else {
        publish({ event: "missing", id: trial.id, reason: "invalid_publication" });
      }
    }
  }

  runtime.onConnect.addListener(connect);
  storage.onChanged.addListener(changed);
  return () => {
    runtime.onConnect.removeListener(connect);
    storage.onChanged.removeListener(changed);
    for (const disconnect of ports.values()) disconnect();
    active.clear();
  };
}

/**
 * Equivalent ordinary unsigned-test-harness boundary, NOT the worker CDP
 * publication boundary above. requestHost must stop at the host's final reply,
 * before forwarding anything to a wallet. Never pass a wallet request promise.
 *
 * readFinalReply adapts the harness's existing receiver, returning
 * { requestId, verdict, workerLifetime }. It must return undefined for progress,
 * publication, transport acknowledgements and unobservable replies. No Chrome
 * wire-envelope layout is assumed here. workerLifetime is receiver provenance,
 * not a field to add to the production verdict stream.
 *
 * lifecycle is optional read-only harness observation:
 *   current(): { absent: true } | { lifetime: opaqueIdentity } | undefined
 *   subscribe(listener): unsubscribe
 * Notifications are { event: "activated", lifetime } for a freshly observed
 * activation, or { event: "disconnected", lifetime }. An initial enumeration
 * of an already-running worker is NOT an activation notification. The source
 * must cover the same worker as requestHost and deliver ordered observations.
 * Without this source, completion can still be observed but a worker-matched
 * duration and a cold classification cannot be established.
 *
 * All timestamps are sampled here on one monotonic clock. This measures reply
 * availability, not worker CPU time. A confirmation path can include user wait;
 * only an ordinary no-confirmation fixture excludes that wait. Missing popup
 * publication is never used to classify that fixture or its verdict.
 */
export async function measureScamHostRequest({ request, requestHost, readFinalReply,
  lifecycle, captureMs, now = () => performance.now() }) {
  if (typeof request?.requestId !== "string" || !request.requestId ||
      typeof requestHost !== "function" || typeof readFinalReply !== "function" ||
      !Number.isSafeInteger(captureMs) || captureMs < 1 || captureMs > 300_000) {
    throw Error("Specify an ordinary host request, final-reply receiver and bounded capture duration.");
  }
  const requestId = request.requestId;
  let started, initial, activation, ended = false, clockFailed = false;
  let lastTime = -Infinity, unsubscribe, timer, stop;
  const clock = () => {
    try {
      const value = now();
      if (!Number.isFinite(value) || value < 0 || value < lastTime) throw Error();
      lastTime = value;
      return value;
    } catch { clockFailed = true; return undefined; }
  };
  const base = { boundary: "ordinary_host_request_to_final_reply", clock: "harness_monotonic",
    cold: false };
  const missing = reason => ({ ...base, outcome: "missing", reason });
  const stopped = new Promise(resolve => { stop = resolve; });
  let lifetimeLost = false, lifecycleReliable = !!lifecycle;
  try {
    if (lifecycle) {
      try {
        unsubscribe = lifecycle.subscribe(event => {
          if (ended || started === undefined) return;
          if (event?.event === "activated" && event.lifetime != null) {
            // A second activation cannot lend a new worker's reply to this trial.
            if (activation || initial?.lifetime != null) {
              lifetimeLost = true;
              stop(missing("worker_lifetime_changed"));
            } else activation = { lifetime: event.lifetime, at: clock() };
          } else if (event?.event === "disconnected" && event.lifetime != null &&
              [initial?.lifetime, activation?.lifetime].includes(event.lifetime)) {
            lifetimeLost = true;
            stop(missing("worker_disconnected"));
          }
        });
        if (typeof unsubscribe !== "function") throw Error();
        initial = lifecycle.current();
      } catch { lifecycleReliable = false; }
    }
    started = clock();
    timer = setTimeout(() => stop(missing("final_reply_not_observed")), captureMs);
    // Invoke directly after the start observation, not after a debugger round
    // trip. Observation expiry never cancels or changes the ordinary request.
    const completion = (async () => {
      let reply;
      try { reply = await requestHost(request); }
      catch { return missing("host_request_failed"); }
      if (ended) return missing("final_reply_not_observed");
      const finished = clock();
      if (!clockFailed && finished - started >= captureMs) return missing("final_reply_not_observed");
      let final;
      try { final = readFinalReply(reply); }
      catch { return missing("final_reply_unobservable"); }
      if (!final || final.requestId !== requestId || !final.verdict ||
          typeof final.verdict !== "object" || Array.isArray(final.verdict) ||
          !["allow", "warn", "block"].includes(final.verdict.decision)) {
        return missing("final_reply_unobservable");
      }
      const result = { ...base, outcome: "completed", decision: final.verdict.decision };
      // Preserve actual completion even when timing provenance is missing.
      // Neither input, request IDs nor raw verdict payloads leave this boundary.
      if (clockFailed) return { ...result, missingStage: "monotonic_clock_unavailable" };
      const lifetime = initial?.lifetime ?? activation?.lifetime;
      if (!lifecycleReliable || lifetime == null || final.workerLifetime !== lifetime || lifetimeLost) {
        return { ...result, missingStage: "matched_worker_lifetime_unobserved" };
      }
      const cold = initial?.absent === true && initial?.lifetime == null &&
        activation?.lifetime === lifetime && activation.at >= started && activation.at <= finished;
      return { ...result, cold, durationMs: finished - started,
        ...(cold ? { activationObservedAfterMs: activation.at - started }
          : initial?.lifetime == null ? { missingStage: "worker_absent_at_request_start_unconfirmed" } : {}) };
    })();
    return await Promise.race([stopped, completion]);
  } finally {
    ended = true;
    clearTimeout(timer);
    try { unsubscribe?.(); } catch { /* Observation cleanup cannot alter a request. */ }
  }
}

export function collectScamHostTrials() {
  const trials = new Map();
  return {
    accept(row) {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) return;
      const { id, event } = row;
      if (event === "start" && !trials.has(id)) {
        trials.set(id, { id });
        return;
      }
      if (!trials.has(id) || trials.get(id).outcome) return;
      if (event === "missing" && ["invalid_publication", "duplicate_request_id"].includes(row.reason)) {
        trials.set(id, { id, outcome: "missing", reason: row.reason });
      }
      if (event !== "result" || !Number.isFinite(row.durationMs) || row.durationMs < 0) return;
      if (row.kind === "report" && ["warn", "quiet", "insufficient", "not_applicable", "disabled", "not_configured"].includes(row.status)
          && Number.isSafeInteger(row.reportedTargets) && row.reportedTargets >= 0) {
        trials.set(id, { id, outcome: "result", kind: "report", status: row.status,
          reportedTargets: row.reportedTargets, durationMs: row.durationMs });
      } else if (row.kind === "unavailable" && typeof row.timedOut === "boolean") {
        trials.set(id, { id, outcome: "result", kind: "unavailable", timedOut: row.timedOut, durationMs: row.durationMs });
      }
    },
    finish(endReason) {
      return [...trials.values()].map(row => row.outcome ? row : { ...row, outcome: "missing", reason: endReason });
    },
  };
}
