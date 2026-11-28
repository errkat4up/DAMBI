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

// Install only in the isolated content-script world of a controlled local dApp.
// Its synthetic dApp dispatches this marker immediately before ethereum.request.
// Arm one request in one document; finish or dispose the observer before the next trial.
// Observe the native port without consuming, altering or synthesizing its messages.
export function observeScamHostGate(scope, markEvent, publish) {
  const { runtime } = scope.chrome;
  const original = runtime.connect;
  let trial, observedPort;
  const awaitingPost = new Set();
  const emit = row => { try { publish(row); } catch { /* Observer only. */ } };
  function release() {
    observedPort?.();
    observedPort = undefined;
    for (const restore of awaitingPost) restore();
    awaitingPost.clear();
    trial = undefined;
  }
  function missing(reason) { release(); emit({ event: "missing", reason }); }
  function begin() {
    if (trial) { missing("ambiguous_request"); return; }
    trial = { start: scope.performance.now(), awaited: false };
    emit({ event: "started" });
  }
  function connect(...args) {
    const port = Reflect.apply(original, this, args);
    if (!trial || port.name !== "dambi-contentscript") return port;
    const owner = trial;
    const post = port.postMessage;
    const restore = () => { if (port.postMessage === onPost) port.postMessage = post; };
    // Ignore unrelated advisory and bypass traffic. Bind a real id only when the
    // content script sends its normal transaction on this particular native port.
    function onPost(message, ...rest) {
      restore();
      awaitingPost.delete(restore);
      if (trial === owner && message?.data?.type === "transaction" && !message.data.bypassed &&
          typeof message.requestId === "string" && message.requestId) {
        if (observedPort) missing("ambiguous_request");
        else {
          const id = message.requestId;
          function onReply(reply) {
            if (trial !== owner || reply?.requestId !== id) return;
            if (reply.kind === "awaiting-user") { trial.awaited = true; return; }
            if (reply.kind !== undefined || typeof reply.data !== "boolean") return;
            if (reply.rejection !== undefined && (reply.data ||
                !["user_cancelled", "policy_denied", "unavailable"].includes(reply.rejection))) {
              missing("invalid_final_reply"); return;
            }
            const durationMs = scope.performance.now() - trial.start;
            const row = { event: "final", gate: reply.data ? "forward_permitted" : "forward_denied",
              ...(reply.rejection ? { rejection: reply.rejection } : {}),
              observedAwaitingUser: trial.awaited, durationMs };
            release();
            emit(row);
          }
          const disconnected = () => missing("port_disconnected");
          port.onMessage.addListener(onReply);
          port.onDisconnect.addListener(disconnected);
          observedPort = () => {
            port.onMessage.removeListener(onReply);
            port.onDisconnect.removeListener(disconnected);
          };
        }
      }
      return Reflect.apply(post, this, [message, ...rest]);
    }
    try { port.postMessage = onPost; awaitingPost.add(restore); }
    catch { missing("port_unobservable"); }
    return port;
  }
  runtime.connect = connect;
  scope.document.addEventListener(markEvent, begin);
  return () => {
    scope.document.removeEventListener(markEvent, begin);
    if (runtime.connect === connect) runtime.connect = original;
    release();
  };
}

// The controlled dApp starts an ordinary request. Its real id is generated by
// the production proxy after that start. The isolated observer matches the
// genuine final reply on the very port that carried the id; neither is exported.
// Lifecycle comes from observation of this extension in one browser profile.
// Report cold only after a positively stopped/absent worker and a unique fresh
// activation in event order. The elapsed time is sampled in the document alone.
export async function measureScamHostRequest({ startRequest, subscribeGate, lifecycle, captureMs }) {
  if (typeof startRequest !== "function" || typeof subscribeGate !== "function" ||
      !Number.isSafeInteger(captureMs) || captureMs < 1 || captureMs > 300_000) {
    throw Error("Specify the local dApp trigger, content-port observer and bounded capture duration.");
  }
  const base = { boundary: "dapp_request_to_content_port_final_reply", clock: "document_performance_now", cold: false };
  const missing = reason => ({ ...base, outcome: "missing", reason });
  const current = () => { try { return lifecycle?.current(); } catch { return undefined; } };
  let stop, initial, activation, started = false, issued = false, settled = false;
  let unsubscribeGate, unsubscribeLife, timer, deadline, activeBeforeMarker = false;
  const done = new Promise(resolve => { stop = result => { settled = true; resolve(result); }; });
  try {
    function lifecycleChanged(change) {
      if (!issued || settled || change?.lifetime == null) return;
      if (change.event === "activated") {
        if (initial?.lifetime != null || activation != null) { stop(missing("worker_lifetime_changed")); return; }
        activation = change.lifetime;
        activeBeforeMarker = !started;
      } else if (change.event === "disconnected" &&
          (change.lifetime === initial?.lifetime || change.lifetime === activation)) {
        stop(missing("worker_disconnected"));
      }
    }
    try { unsubscribeLife = lifecycle?.subscribe(lifecycleChanged); } catch { /* Incomplete lifetime evidence. */ }
    unsubscribeGate = subscribeGate(row => {
      if (!issued || settled || !row) return;
      if (performance.now() >= deadline) { stop(missing("final_reply_not_observed")); return; }
      if (row.event === "started") {
        if (started) stop(missing("ambiguous_request"));
        started = true;
        return;
      }
      if (row.event === "missing") {
        stop(missing(["port_disconnected", "port_unobservable", "ambiguous_request", "invalid_final_reply"].includes(row.reason)
          ? row.reason : "final_reply_unobservable"));
        return;
      }
      if (!started || row.event !== "final" ||
          !["forward_permitted", "forward_denied"].includes(row.gate) ||
          typeof row.observedAwaitingUser !== "boolean" || !Number.isFinite(row.durationMs) ||
          row.durationMs < 0 || row.durationMs >= captureMs) return;
      if (row.rejection !== undefined && (row.gate !== "forward_denied" ||
          !["user_cancelled", "policy_denied", "unavailable"].includes(row.rejection))) return;
      const result = { ...base, outcome: "completed", gate: row.gate,
        ...(row.rejection ? { rejection: row.rejection } : {}), observedAwaitingUser: row.observedAwaitingUser };
      const lifetime = initial?.lifetime ?? activation;
      if (lifetime == null || current()?.lifetime !== lifetime || typeof unsubscribeLife !== "function") {
        stop({ ...result, missingStage: "matched_worker_lifetime_unobserved" }); return;
      }
      const cold = initial?.absent === true && initial?.lifetime == null && !activeBeforeMarker;
      stop({ ...result, cold, durationMs: row.durationMs,
        ...(initial?.lifetime == null && !cold ? { missingStage: "worker_absent_at_request_start_unconfirmed" } : {}) });
    });
    initial = current();
    deadline = performance.now() + captureMs;
    timer = setTimeout(() => stop(missing("final_reply_not_observed")), captureMs);
    issued = true;
    try { Promise.resolve(startRequest()).catch(() => { if (!settled) stop(missing("host_request_failed")); }); }
    catch { stop(missing("host_request_failed")); }
    return await done;
  } finally {
    clearTimeout(timer);
    unsubscribeGate?.();
    unsubscribeLife?.();
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
