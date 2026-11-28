// Imported only by the opt-in comparison build's service worker.
import { createScamFactProvider, ScamDataError } from "@dambi/core/adapters";

const doc = "qa-scam-owner.html";
const channel = "dambi-qa-facts:";
const waiting = new Map();
let generation = 0;
let lifecycle = Promise.resolve();

function serialize(work) {
  const action = lifecycle.then(work);
  lifecycle = action.catch(() => {});
  return action;
}
async function hasOwner() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(doc)],
  });
  return contexts.length > 0;
}
export function invalidateComparisonScope() {
  generation++;
  void serialize(async () => {
    if (await hasOwner()) await chrome.offscreen.closeDocument();
  }).catch(() => {});
}
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(channel)) return;
  const sender = port.sender, id = port.name.slice(channel.length);
  if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(doc) || sender.tab || !waiting.has(id)) {
    port.disconnect();
    return;
  }
  waiting.get(id)(port);
});
function aborted() { return new DOMException("Request cancelled", "AbortError"); }
const transport = Symbol("comparison transport unavailable");
function traceOwner(path, method, epoch) {
  if (Object.getOwnPropertyDescriptor(globalThis, "__dambiObserveScamTiming")?.value === true) {
    console.debug("[Dambi] QA raw owner", path, method, epoch);
  }
}
function remote(scope, raw, method, calls, context, lifetime, version, onMetrics) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const signals = [context.signal, lifetime].filter(Boolean);
    let port, connectionTimer, done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(connectionTimer);
      waiting.delete(id);
      for (const signal of signals) signal.removeEventListener("abort", cancel);
      try { port?.disconnect(); } catch {}
      fn(value);
    };
    const cancel = () => finish(reject, aborted());
    const obsolete = () => version !== generation || signals.some((s) => s.aborted);
    if (obsolete()) return cancel();
    for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
    waiting.set(id, (incoming) => {
      if (done || obsolete()) { incoming.disconnect(); cancel(); return; }
      waiting.delete(id);
      port = incoming;
      clearTimeout(connectionTimer);
      port.onDisconnect.addListener(() => finish(reject, transport));
      port.onMessage.addListener((message) => {
        if (done || obsolete()) return cancel();
        if (message?.kind === "metric") {
          try { void Promise.resolve(onMetrics?.(message.metric)).catch(() => {}); } catch {}
        } else if (message?.kind === "complete") {
          traceOwner("worker", method, message.epoch);
          finish(resolve, message.batch);
        } else if (message?.kind === "failure") {
          traceOwner("worker", method, message.epoch);
          let error;
          try { error = new ScamDataError(message.reason); } catch { error = new Error("Provider unavailable"); }
          finish(reject, error);
        } else if (message?.kind === "lost") finish(reject, transport);
      });
      try {
        port.postMessage({ scope, raw, method, calls, planId: context.planId, timeoutMs: context.timeoutMs });
      } catch { finish(reject, transport); }
    });
    void serialize(async () => {
      if (done || obsolete()) return;
      if (!await hasOwner()) await chrome.offscreen.createDocument({
        url: doc, reasons: ["WORKERS"],
        justification: "Run the read-only history provider in a dedicated worker for the development comparison.",
      });
    }).then(async () => {
      if (done || obsolete()) return cancel();
      const answer = await chrome.runtime.sendMessage({ target: channel, id });
      if (!port && !done) {
        if (!answer?.accepted) finish(reject, transport);
        else connectionTimer = setTimeout(() => finish(reject, transport), 250);
      }
    }).catch(() => finish(reject, transport));
  });
}
export function createComparisonProvider(config, lifetime, options) {
  const direct = createScamFactProvider(options);
  const version = generation;
  lifetime.addEventListener("abort", () => {
    if (version === generation) invalidateComparisonScope();
  }, { once: true });
  // Bind all signed-source, user, factory, endpoint and budget settings.
  const scope = crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config)))
    .then((bytes) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join(""));
  async function run(method, calls, context) {
    if (method === "fetch" && !calls.some(c => c.method?.startsWith("scam."))) return direct.fetch(calls, context);
    try {
      return await remote(await scope, config.facts.scam, method, calls, context, lifetime, version, options.onMetrics);
    } catch (error) {
      if (error !== transport) throw error;
      if (lifetime.aborted || context.signal?.aborted || version !== generation) throw aborted();
      // Owner loss can fall back to the original provider in this Core's live budget.
      traceOwner("fallback", method);
      return direct[method](calls, context);
    }
  }
  return { fetch: (calls, context) => run("fetch", calls, context), prepare: (calls, context) => run("prepare", calls, context) };
}
