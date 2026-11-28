const { test } = require("node:test");
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

test("synchronous worker startup failure releases the request to the ordinary provider", () => {
  const { invite } = broker({ workerAvailable: false });
  const p = invite("start");
  p.onMessage.fire({ scope: "A", method: "fetch", planId: "p1" });
  assert.deepEqual(p.replies, [{ kind: "lost" }]);
});
