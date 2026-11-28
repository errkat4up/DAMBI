import assert from "node:assert/strict";
import test from "node:test";
import { collectScamHostTrials, observeScamHost } from "../../../../scripts/sdk/scam-host-timing.mjs";
import { probeScamHost, measureScamHostRequest, observeScamHostGate } from "../../../../scripts/sdk/scam-host-timing-probe.mjs";

const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire: (...args) => { for (const fn of listeners) fn(...args); } };
};

function worker(capture) {
  let time = 0;
  const onConnect = event(), onChanged = event();
  const stop = observeScamHost({ chrome: { runtime: { onConnect }, storage: { onChanged } },
    performance: { now: () => time } }, row => capture.accept(row));
  const port = { name: "dambi-contentscript", onMessage: event(), onDisconnect: event() };
  onConnect.fire(port);
  return {
    start(id, at, bypassed = false) {
      time = at;
      port.onMessage.fire({ requestId: id, data: { type: "transaction", hostname: "private.test", bypassed } });
    },
    publish(id, at, display, recordId = id) {
      time = at;
      onChanged.fire({ ["scam:confirm:" + id]: { newValue: { requestId: recordId, expiresAtMs: Date.now() + 60_000,
        display: { version: 1, holding: "unknown", ...display } } } }, "session");
    }, stop,
  };
}
const warning = { kind: "report", report: { status: "warn", scopeNotice: "patterns_only_no_sellability_guarantee",
  targets: [{ subject: { token: "private-address" } }] } };

function ordinaryHost({ absent = false } = {}) {
  const doc = new EventTarget(), rows = event(), changes = event();
  let time = 0, lifetime = absent ? undefined : "first", counter = 0;
  const ports = [];
  const native = () => {
    const port = { name: "dambi-contentscript", sent: [], onMessage: event(), onDisconnect: event(),
      postMessage(message) { this.sent.push(message); } };
    ports.push(port);
    return port;
  };
  const runtime = { connect: native };
  const cleanup = observeScamHostGate({ chrome: { runtime }, performance: { now: () => time }, document: doc },
    "start", row => rows.fire(row));
  function send(bypassed = false) {
    const port = runtime.connect({ name: "dambi-contentscript" });
    port.postMessage({ requestId: "private-" + ++counter, data: { type: "transaction", bypassed } });
    return port;
  }
  const options = { captureMs: 100, startRequest() { doc.dispatchEvent(new Event("start")); send(); },
    subscribeGate(fn) { rows.addListener(fn); return () => rows.removeListener(fn); },
    lifecycle: { current: () => lifetime ? { lifetime } : { absent: true },
      subscribe(fn) { changes.addListener(fn); return () => changes.removeListener(fn); } } };
  return { options, ports, send, runtime, native, cleanup,
    activate(next) { lifetime = next; changes.fire({ event: "activated", lifetime }); },
    disconnect() { changes.fire({ event: "disconnected", lifetime }); lifetime = undefined; },
    reply(port, offset, fields) { time = offset; port.onMessage.fire({ requestId: port.sent[0].requestId, ...fields }); },
  };
}

test("normal dApp timing ends on its own port and generated id; an approved warning grants forwarding without claiming a policy allow", async (t) => {
  const host = ordinaryHost(); t.after(host.cleanup);
  const pending = measureScamHostRequest(host.options);
  const [port] = host.ports;
  const observation = host.send(true);
  observation.onMessage.fire({ requestId: port.sent[0].requestId, data: false });
  host.reply(port, 8, { requestId: "unrelated", data: false });
  host.reply(port, 12, { kind: "awaiting-user" });
  host.reply(port, 20, { kind: "ack", data: true });
  host.reply(port, 30, { data: true, secret: "private payload" });
  const result = await pending;
  assert.deepEqual(result, { boundary: "dapp_request_to_content_port_final_reply", clock: "document_performance_now",
    cold: false, outcome: "completed", gate: "forward_permitted", observedAwaitingUser: true, durationMs: 30 });
  assert.doesNotMatch(JSON.stringify(result), /private|quiet|allow/);
  assert.deepEqual(port.sent, [{ requestId: "private-1", data: { type: "transaction", bypassed: false } }]);
  host.cleanup();
  assert.equal(host.runtime.connect, host.native);
});

test("a marked request from a stopped worker needs a fresh matched lifetime; a lost port or worker has no duration", async (t) => {
  const cold = ordinaryHost({ absent: true }); t.after(cold.cleanup);
  const result = measureScamHostRequest(cold.options);
  cold.activate("second");
  cold.reply(cold.ports[0], 40, { data: false, rejection: "policy_denied" });
  assert.deepEqual(await result, { boundary: "dapp_request_to_content_port_final_reply", clock: "document_performance_now",
    cold: true, outcome: "completed", gate: "forward_denied", rejection: "policy_denied", observedAwaitingUser: false, durationMs: 40 });

  const early = ordinaryHost({ absent: true }); t.after(early.cleanup);
  const before = measureScamHostRequest({ ...early.options, startRequest() {
    early.activate("already-awake"); early.options.startRequest();
  } });
  early.reply(early.ports[0], 25, { data: true });
  const unconfirmed = await before;
  assert.equal(unconfirmed.cold, false);
  assert.equal(unconfirmed.missingStage, "worker_absent_at_request_start_unconfirmed");

  for (const reason of ["worker_disconnected", "worker_lifetime_changed", "port_disconnected", "ambiguous_request", "invalid_final_reply"]) {
    const host = ordinaryHost({ absent: true }); t.after(host.cleanup);
    const pending = measureScamHostRequest(host.options);
    host.activate("second");
    if (reason === "worker_disconnected") host.disconnect();
    if (reason === "worker_lifetime_changed") host.activate("replacement");
    if (reason === "port_disconnected") host.ports[0].onDisconnect.fire();
    if (reason === "ambiguous_request") host.send();
    if (reason === "invalid_final_reply") host.reply(host.ports[0], 10, { data: true, rejection: "policy_denied" });
    host.reply(host.ports[0], 20, { data: true });
    const missing = await pending;
    assert.equal(missing.reason, reason);
    assert.equal(missing.durationMs, undefined);
  }
});

test("a genuine result does not acquire timing from an unproven worker or a reply after expiry", async (t) => {
  const host = ordinaryHost(); t.after(host.cleanup);
  const partial = measureScamHostRequest({ ...host.options, lifecycle: undefined });
  host.reply(host.ports[0], 15, { data: true });
  assert.deepEqual(await partial, { boundary: "dapp_request_to_content_port_final_reply", clock: "document_performance_now",
    cold: false, outcome: "completed", gate: "forward_permitted", observedAwaitingUser: false,
    missingStage: "matched_worker_lifetime_unobserved" });

  const stalled = ordinaryHost(); t.after(stalled.cleanup);
  const pending = measureScamHostRequest({ ...stalled.options, captureMs: 1 });
  const missing = await pending;
  stalled.reply(stalled.ports[0], 20, { data: true });
  assert.equal(missing.reason, "final_reply_not_observed");
  assert.equal(missing.durationMs, undefined);
});

test("measures concurrent confirmations on their own worker clock without logging input or user response times", () => {
  const capture = collectScamHostTrials(), w = worker(capture);
  w.start("private-a", 80);
  w.start("private-b", 95);
  w.start("private-observation", 99, true);
  w.publish("private-b", 125, { kind: "unavailable", reason: "timeout" });
  w.publish("private-a", 700, warning);
  w.publish("private-observation", 1000, warning);
  w.stop();
  w.start("ignored", 1100);
  assert.deepEqual(capture.finish("publication_not_observed"), [
    { id: 1, outcome: "result", kind: "report", status: "warn", reportedTargets: 1, durationMs: 620 },
    { id: 2, outcome: "result", kind: "unavailable", timedOut: true, durationMs: 30 },
  ]);
});

test("missing publication, ambiguous IDs, mismatched records and worker loss never provide a duration", () => {
  const capture = collectScamHostTrials(), w = worker(capture);
  w.start("unpublished", 1);
  w.start("duplicate", 2); w.start("duplicate", 3); w.publish("duplicate", 5, warning);
  w.start("actual", 10); w.publish("actual", 30, warning, "unrelated");
  assert.deepEqual(capture.finish("worker_disconnected").map(row => [row.reason, row.durationMs]), [
    ["worker_disconnected", undefined], ["duplicate_request_id", undefined],
    ["duplicate_request_id", undefined], ["invalid_publication", undefined],
  ]);
  w.stop();
  const fresh = collectScamHostTrials(), afterRestart = worker(fresh);
  afterRestart.publish("unpublished", 2, warning);
  assert.deepEqual(fresh.finish("publication_not_observed"), []);
});

test("remote debug transports are refused before retrieving browser targets", async () => {
  for (const endpoint of ["https://example.com", "http://example.com:9222", "http://user@127.0.0.1:9222"]) {
    await assert.rejects(probeScamHost(endpoint, "a".repeat(32), 100), /loopback/);
  }
});

test("a worker inspector termination ends pending trials before the debug socket closes", async t => {
  const id = "a".repeat(32);
  const worker = { type: "service_worker", url: "chrome-extension://" + id + "/js/background.js",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/worker" };
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => [worker] }));
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "WebSocket", original);
    else delete globalThis.WebSocket;
  });
  let socket;
  class DebugSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    commands = [];
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    emit(message) { this.onmessage({ data: JSON.stringify(message) }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      this.commands.push(method);
      if (method === "Runtime.addBinding") this.binding = params.name;
      this.emit({ id, result: method === "Runtime.evaluate" ? { result: { objectId: "observer" } } : {} });
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: DebugSocket });
  for (const method of ["Inspector.targetCrashed", "Inspector.detached"]) {
    const result = await probeScamHost("http://127.0.0.1:9222", id, 30, () => {
      socket.emit({ method: "Runtime.bindingCalled", params: { name: socket.binding, payload: '{"event":"start","id":1}' } });
      socket.emit({ method });
    });
    assert.equal(result.stoppedBecause, "worker_disconnected");
    assert.deepEqual(result.trials, [{ id: 1, outcome: "missing", reason: "worker_disconnected" }]);
    assert.deepEqual(socket.commands, ["Runtime.enable", "Runtime.addBinding", "Runtime.evaluate"]);
  }
});
