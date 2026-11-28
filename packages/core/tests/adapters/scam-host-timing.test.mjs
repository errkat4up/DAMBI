import assert from "node:assert/strict";
import test from "node:test";
import { collectScamHostTrials, observeScamHost } from "../../../../scripts/sdk/scam-host-timing.mjs";
import { probeScamHost } from "../../../../scripts/sdk/scam-host-timing-probe.mjs";

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
