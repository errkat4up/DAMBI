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
