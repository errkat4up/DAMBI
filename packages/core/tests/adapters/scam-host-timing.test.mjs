import assert from "node:assert/strict";
import test from "node:test";
import { collectScamHostTrials, observeScamHost } from "../../../../scripts/sdk/scam-host-timing.mjs";
import { probeScamHost, measureScamHostRequest } from "../../../../scripts/sdk/scam-host-timing-probe.mjs";

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

// Equivalent ordinary unsigned host harness, not a claimed Chrome wire schema.
// Its receiver resolves only the requestId-matched final host response. Wallet
// forwarding is deliberately outside this boundary; no popup/storage observer
// participates. Lifetime metadata belongs to the harness, not to the verdict.
function ordinaryHost({ absent = false, observable = true } = {}) {
  const changes = event();
  let time = 10, lifetime = absent ? undefined : "worker-1", receiver;
  let resolveReply, requested, subscriptions = 0;
  const input = { requestId: "private-request", data: { type: "transaction", bypassed: false,
    transaction: { to: "unsigned-test-destination", value: "0" } } };
  const lifecycle = {
    current: () => lifetime === undefined ? { absent: true } : { lifetime },
    subscribe(fn) {
      subscriptions++;
      changes.addListener(fn);
      return () => { subscriptions--; changes.removeListener(fn); };
    },
  };
  const options = { request: input, captureMs: 100, now: () => time, lifecycle,
    requestHost(request) {
      requested = request;
      return new Promise(resolve => {
        resolveReply = resolve;
        receiver = reply => {
          if (reply.requestId === request.requestId) resolve({ reply, lifetime });
        };
      });
    },
    readFinalReply(observed) {
      if (!observable) return undefined;
      return { requestId: observed.reply.requestId, verdict: observed.reply.result,
        workerLifetime: observed.lifetime };
    },
  };
  return { options, input, get requested() { return requested; },
    get subscriptions() { return subscriptions; },
    activate(at, next = "worker-2") {
      time = at; lifetime = next;
      changes.fire({ event: "activated", lifetime });
    },
    disconnect(at) {
      time = at;
      changes.fire({ event: "disconnected", lifetime });
      lifetime = undefined;
    },
    reply(at, requestId = input.requestId) {
      time = at;
      receiver({ requestId, result: { decision: "allow", scam: { status: "quiet" }, private: "SECRET" } });
    },
    acknowledge(at) { time = at; resolveReply({ reply: { requestId: input.requestId }, lifetime }); },
  };
}

test("ordinary no-confirmation completion uses the matched final reply without a window or wallet processing", async () => {
  const host = ordinaryHost();
  const pending = measureScamHostRequest(host.options);
  assert.equal(host.requested, host.input, "The ordinary unsigned input is passed unchanged");
  host.reply(15, "unrelated-request");
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "An unrelated final reply cannot complete the request");
  host.reply(35);
  const result = await pending;
  assert.deepEqual(result, { boundary: "ordinary_host_request_to_final_reply", clock: "harness_monotonic",
    cold: false, outcome: "completed", decision: "allow", durationMs: 25 });
  assert.equal(host.subscriptions, 0);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private-request|unsigned-test-destination/);
});

test("unobservable, acknowledged and late host replies remain missing rather than no-window verdicts", async () => {
  const hidden = ordinaryHost({ observable: false });
  const hiddenPending = measureScamHostRequest(hidden.options);
  hidden.reply(20);
  const hiddenResult = await hiddenPending;
  assert.equal(hiddenResult.reason, "final_reply_unobservable");
  assert.equal(hiddenResult.durationMs, undefined);

  const acknowledged = ordinaryHost();
  const ackPending = measureScamHostRequest(acknowledged.options);
  acknowledged.acknowledge(20);
  assert.equal((await ackPending).reason, "final_reply_unobservable");

  const late = ordinaryHost();
  const latePending = measureScamHostRequest({ ...late.options, captureMs: 1 });
  const expired = await latePending;
  assert.equal(expired.reason, "final_reply_not_observed");
  assert.equal(expired.durationMs, undefined);
  late.reply(50);
  await Promise.resolve();
  assert.equal(expired.outcome, "missing", "A late real verdict cannot rewrite an expired observation");
  assert.equal(late.subscriptions, 0);

  const noLifetime = ordinaryHost();
  const unqualified = measureScamHostRequest({ ...noLifetime.options, lifecycle: undefined });
  noLifetime.reply(20);
  const completed = await unqualified;
  assert.equal(completed.outcome, "completed", "Missing lifecycle evidence does not erase a genuine verdict");
  assert.equal(completed.missingStage, "matched_worker_lifetime_unobserved");
  assert.equal(completed.durationMs, undefined);
  assert.equal(completed.cold, false);
});

test("controlled cold start includes pre-activation time only with absent-at-start and matched fresh lifetime", async () => {
  const host = ordinaryHost({ absent: true });
  const pending = measureScamHostRequest(host.options);
  host.activate(30);
  host.reply(70);
  assert.deepEqual(await pending, { boundary: "ordinary_host_request_to_final_reply", clock: "harness_monotonic",
    cold: true, outcome: "completed", decision: "allow", durationMs: 60, activationObservedAfterMs: 20 });

  const unknown = ordinaryHost({ absent: true });
  unknown.options.lifecycle.current = () => undefined;
  const unknownPending = measureScamHostRequest(unknown.options);
  unknown.activate(30);
  unknown.reply(70);
  const result = await unknownPending;
  assert.equal(result.cold, false);
  assert.equal(result.missingStage, "worker_absent_at_request_start_unconfirmed");

  const lost = ordinaryHost({ absent: true });
  const lostPending = measureScamHostRequest(lost.options);
  lost.activate(20);
  lost.disconnect(25);
  lost.activate(30, "replacement-worker");
  lost.reply(40);
  const disconnected = await lostPending;
  assert.equal(disconnected.reason, "worker_disconnected");
  assert.equal(disconnected.durationMs, undefined);
  assert.equal(disconnected.cold, false);
  assert.equal(lost.subscriptions, 0);
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
