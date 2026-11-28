const test = globalThis.test ?? require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { for (const fn of listeners) fn(...args); } };
}
function port(name) {
  return { name, onMessage: event(), onDisconnect: event(), replies: [], postMessage(data) { this.replies.push(structuredClone(data)); } };
}
function broker({ workerAvailable = true } = {}) {
  const runtime = { id: "comparison", getURL: (f) => "chrome-extension://comparison/" + f, onMessage: event() };
  const ports = new Map(), workers = [];
  runtime.connect = ({ name }) => {
    const p = port(name); ports.set(name, p); return p;
  };
  class Worker {
    messages = []; stopped = false;
    constructor() { if (!workerAvailable) throw new Error("Worker unavailable"); workers.push(this); }
    postMessage(data) { this.messages.push(structuredClone(data)); }
    terminate() { this.stopped = true; }
    send(data) { this.onmessage({ data }); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "broker.js"), "utf8"), { chrome: { runtime }, Worker });
  const prefix = "dambi-qa-facts:";
  const sw = { id: runtime.id, url: runtime.getURL("js/background.js") };
  function invite(id, sender = sw) {
    let accepted = false;
    runtime.onMessage.fire({ target: prefix, id }, sender, (answer) => { accepted = answer.accepted; });
    assert.equal(accepted, ports.has(prefix + id));
    return ports.get(prefix + id);
  }
  return { invite, workers, sw };
}
test("only the extension background worker can invite the offscreen provider", () => {
  const { invite, sw } = broker();
  for (const sender of [{ ...sw, tab: { id: 9 } }, { ...sw, url: "https://dapp.test/" },
      { ...sw, url: "chrome-extension://comparison/options.html" }, { ...sw, id: "other" }]) {
    assert.equal(invite("untrusted", sender), undefined);
  }
  assert.ok(invite("background"));
});
test("concurrent plan IDs have distinct ports; cancel and scope replacement discard late Facts", () => {
  const { invite, workers } = broker();
  const a = invite("a"), b = invite("b"); const common = { scope: "A", method: "fetch", planId: "p1" };
  a.onMessage.fire(common); b.onMessage.fire(common);
  assert.equal(workers.length, 1);
  const old = workers[0];
  a.onDisconnect.fire();
  assert.deepEqual(old.messages.at(-1), { cancel: "a" });
  old.send({ id: "a", kind: "complete", batch: { obsolete: true } });
  old.send({ id: "b", kind: "complete", batch: { current: true } });
  assert.equal(a.replies.length, 0);
  assert.deepEqual(b.replies.map(r => r.batch), [{ current: true }]);
  const c = invite("c"), d = invite("d");
  c.onMessage.fire(common); d.onMessage.fire({ ...common, scope: "B" });
  assert.equal(old.stopped, true); assert.equal(workers.length, 2);
  assert.deepEqual(c.replies, [{ kind: "lost" }]);
  old.send({ id: "d", kind: "complete", batch: { stale: true } });
  assert.equal(d.replies.length, 0);
  workers[1].send({ id: "d", kind: "complete", batch: { newScope: true } });
  assert.deepEqual(d.replies.map(r => r.batch), [{ newScope: true }]);
});

test("broker reports synchronous worker startup failure as transport loss", () => {
  const { invite } = broker({ workerAvailable: false });
  const p = invite("start");
  p.onMessage.fire({ scope: "A", method: "fetch", planId: "p1" });
  assert.deepEqual(p.replies, [{ kind: "lost" }]);
});

// Execute the actual bridge and broker together. Only Chrome transport, Worker
// and the adapter import are substituted. These are boundary regressions, not
// evidence of a complete SDK/browser/wallet run.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("expected lifecycle boundary was not reached");
}
function comparison({ workerAvailable = true, directResult, directError } = {}) {
  const crypto = require("node:crypto");
  const workers = [], pairs = [], invocations = [], constructions = [];
  let attempts = 0, documentOpen = false;
  const runtime = {
    id: "comparison", getURL: f => "chrome-extension://comparison/" + f,
    onConnect: event(), onMessage: event(),
    async getContexts() { return documentOpen ? [{}] : []; },
  };
  function pair(name, sender) {
    let closed = false;
    const a = { name, sender, onMessage: event(), onDisconnect: event() };
    const b = { name, onMessage: event(), onDisconnect: event() };
    for (const [from, to] of [[a, b], [b, a]]) {
      from.postMessage = data => {
        if (closed) throw new Error("Disconnected port");
        const copy = structuredClone(data);
        queueMicrotask(() => { if (!closed) to.onMessage.fire(copy); });
      };
      from.disconnect = () => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => { a.onDisconnect.fire(); b.onDisconnect.fire(); });
      };
    }
    const result = { bridge: a, broker: b, closed: () => closed };
    pairs.push(result);
    return result;
  }
  runtime.connect = ({ name }) => {
    const p = pair(name, { id: runtime.id, url: runtime.getURL("qa-scam-owner.html") });
    // Chrome delivers onConnect after the inviting listener has installed its
    // port listeners; messages cross asynchronously and are cloned.
    queueMicrotask(() => runtime.onConnect.fire(p.bridge));
    return p.broker;
  };
  runtime.sendMessage = async message => {
    let answer;
    runtime.onMessage.fire(message, {
      id: runtime.id, url: runtime.getURL("js/background.js"),
    }, value => { answer = value; });
    return answer;
  };
  class Worker {
    messages = []; stopped = false;
    constructor() {
      attempts++;
      if (!workerAvailable) throw new Error("Injected Worker constructor failure");
      workers.push(this);
    }
    postMessage(data) { this.messages.push(structuredClone(data)); }
    terminate() { this.stopped = true; }
    send(data) { this.onmessage({ data }); }
    lose() { this.onerror(new Error("Injected worker loss")); }
  }
  const chrome = { runtime, offscreen: {
    async createDocument(options) {
      assert.deepEqual(Array.from(options.reasons), ["WORKERS"]);
      documentOpen = true;
    },
    async closeDocument() {
      documentOpen = false;
      for (const p of pairs) p.bridge.disconnect();
      for (const w of workers) w.terminate();
    },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "broker.js"), "utf8"), { chrome, Worker });
  const direct = Object.fromEntries(["fetch", "prepare"].map(method => [method, (calls, context) => {
    invocations.push({ method, calls, context });
    if (directError) throw directError;
    return directResult;
  }]));
  class ScamDataError extends Error {
    constructor(reason) { super("Provider failure"); this.reason = reason; }
  }
  const source = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
  const seam = 'import { createScamFactProvider, ScamDataError } from "@dambi/core/adapters";';
  assert.equal(source.split(seam).length, 2, "adapter import seam must remain unique");
  const sandbox = {
    chrome, AbortController, DOMException, TextEncoder, setTimeout, clearTimeout,
    crypto: {
      randomUUID: crypto.randomUUID,
      subtle: { digest: async (_algorithm, bytes) => crypto.createHash("sha256").update(bytes).digest() },
    },
    createScamFactProvider(options) { constructions.push(options); return direct; },
    ScamDataError,
  };
  vm.runInNewContext(source.replace(seam, "").replace(/export function /g, "function ") +
    "\nglobalThis.api = { createComparisonProvider, invalidateComparisonScope };", sandbox);
  const lifetime = new AbortController(), request = new AbortController();
  const options = { policy: { fetch() { throw new Error("not used by this test"); } } };
  const provider = sandbox.api.createComparisonProvider({ facts: { scam: { rpc: {} } } }, lifetime.signal, options);
  assert.equal(constructions.length, 1);
  assert.equal(constructions[0], options);
  const calls = [{ callId: "history", method: "scam.pool_history", params: { chainId: "eip155:91342" } }];
  const context = { planId: "original-plan", signal: request.signal, timeoutMs: 1731 };
  return {
    provider, calls, context, lifetime, request, workers, pairs, invocations,
    attempts: () => attempts, invalidate: sandbox.api.invalidateComparisonScope,
    async submitted() { await until(() => workers[0]?.messages.some(m => m.method)); },
    start(method) { return provider[method](calls, context); },
    assertDirect(method) {
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].method, method);
      assert.equal(invocations[0].calls, calls);
      assert.equal(invocations[0].context, context);
      assert.equal(invocations[0].context.planId, "original-plan");
      assert.equal(invocations[0].context.signal, request.signal);
      assert.equal(invocations[0].context.timeoutMs, 1731);
    },
  };
}

for (const method of ["fetch", "prepare"]) {
  for (const fault of ["constructor", "worker-error", "disconnect"]) {
    test(`bridge ${method}: ${fault} calls the ordinary provider exactly once and returns its result`, async () => {
      const result = method === "prepare" ? undefined : {
        planId: "original-plan", results: { history: { source: "ordinary-provider" } },
      };
      const h = comparison({ workerAvailable: fault !== "constructor", directResult: result });
      const pending = h.start(method);
      if (fault !== "constructor") {
        await h.submitted();
        const job = h.workers[0].messages.find(m => m.method);
        assert.equal(job.method, method);
        assert.deepEqual(job.calls, h.calls);
        assert.equal(job.planId, h.context.planId);
        assert.equal(job.timeoutMs, h.context.timeoutMs);
        if (fault === "worker-error") h.workers[0].lose();
        else h.pairs[0].broker.disconnect();
        h.workers[0].send({ id: job.id, kind: "complete", batch: { late: true } });
      }
      assert.equal(await pending, result);
      await flush();
      h.assertDirect(method);
      assert.equal(h.attempts(), 1);
      assert.ok(h.pairs.every(p => p.closed()));
    });
  }

  test(`bridge ${method}: ordinary-provider failure is propagated without retry`, async () => {
    const error = new Error("cold source failed");
    const h = comparison({ workerAvailable: false, directError: error });
    await assert.rejects(h.start(method), value => value === error);
    h.assertDirect(method);
  });

  for (const cancellation of ["request", "lifetime", "generation"]) {
    const cancel = h => cancellation === "generation" ? h.invalidate() : h[cancellation].abort();
    test(`bridge ${method}: ${cancellation} before startup prevents fallback`, async () => {
      const h = comparison({ workerAvailable: false });
      const pending = h.start(method);
      const rejected = assert.rejects(pending, { name: "AbortError" });
      cancel(h);
      await rejected;
      await flush();
      assert.equal(h.attempts(), 0);
      assert.equal(h.invocations.length, 0);
    });

    for (const lossFirst of [false, true]) {
      test(`bridge ${method}: ${cancellation} cancels connected work (loss first: ${lossFirst})`, async () => {
        const h = comparison();
        const pending = h.start(method);
        let delivered = 0;
        pending.then(() => delivered++, () => {});
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await h.submitted();
        const worker = h.workers[0], job = worker.messages.find(m => m.method);
        if (lossFirst) worker.lose();
        cancel(h);
        if (!lossFirst) worker.lose();
        await rejected;
        worker.send({ id: job.id, kind: "complete", batch: { obsolete: true } });
        await flush();
        assert.equal(h.invocations.length, 0);
        assert.equal(delivered, 0);
        assert.ok(h.pairs.every(p => p.closed()));
      });
    }

    for (const lateFailure of [false, true]) {
      test(`bridge ${method}: ${cancellation} discards an in-flight cold ${lateFailure ? "failure" : "result"}`, async () => {
        const cold = deferred();
        const h = comparison({ workerAvailable: false, directResult: cold.promise });
        const pending = h.start(method);
        let delivered = 0;
        pending.then(() => delivered++, () => {});
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await until(() => h.invocations.length === 1);
        h.assertDirect(method);
        cancel(h);
        // Cancellation must settle even if the original provider ignores its
        // signal or only the generation, not the request signal, changed.
        await rejected;
        if (lateFailure) cold.reject(new Error("late cold failure"));
        else cold.resolve({ obsolete: true });
        await flush();
        h.assertDirect(method);
        assert.equal(delivered, 0);
      });
    }
  }
}

test("bridge preserves worker provider failures instead of treating them as owner loss", async () => {
  const h = comparison();
  const pending = h.start("fetch");
  const rejected = assert.rejects(pending, error => error.reason === "unavailable");
  await h.submitted();
  const job = h.workers[0].messages.find(m => m.method);
  h.workers[0].send({ id: job.id, kind: "failure", reason: "unavailable" });
  await rejected;
  assert.equal(h.invocations.length, 0);
});

/*
 * Browser acceptance remains a separate, unperformed gate; these VM tests do
 * not establish SDK completeness, confirmation behavior or wallet forwarding.
 * For the immutable comparison ZIP, inject faults in the offscreen document's
 * isolated DevTools context, never via a web-page message or a new permission:
 * - Before its first request, replace that context's Worker constructor with a
 *   throwing constructor; reload the offscreen context to restore it.
 * - For connected loss, wrap that context's Worker constructor, retain the
 *   created worker, and terminate it plus dispatch an error event after the
 *   first posted job. Termination alone does not dispatch Worker.onerror.
 * Exercise the normal wallet-request entry, not a synthetic bridge invocation.
 * Compare against the exact fdd5d20b65bb91dce38f41717acf5bd1993a17b0 artifact
 * under independent partial approval #224. Record artifact hashes, fault and
 * fallback observations, whole-request SDK-ready time and complete SDK output,
 * confirmation content, reject/cancel behavior, and unchanged forwarding to a
 * non-broadcasting test wallet. No real-chain writes are authorized.
 * Include fresh and retained-worker conditions separately. A performance win
 * is not guaranteed; conclusions must be conditional on the measured lifecycle.
 * Browser observations must be collected separately, not inferred from this
 * suite or represented as product deployment / S2b 300-request evidence.
 */
