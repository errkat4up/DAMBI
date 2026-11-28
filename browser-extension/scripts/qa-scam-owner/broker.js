// The offscreen document accepts invitations exclusively from the installed MV3 worker.
const prefix = "dambi-qa-facts:";
const jobs = new Map();
let active;
function stop() {
  active?.worker.terminate();
  active = undefined;
  for (const { port } of jobs.values()) {
    try { port.postMessage({ kind: "lost" }); } catch {}
  }
  jobs.clear();
}
function owner(scope) {
  if (active?.scope === scope) return active.worker;
  if (active) stop();
  const worker = new Worker("js/qa-scam-provider.js");
  active = { scope, worker };
  worker.onerror = () => { if (active?.worker === worker) stop(); };
  worker.onmessage = ({ data }) => {
    if (active?.worker !== worker) return;
    const current = jobs.get(data.id);
    if (!current) return;
    if (data.kind !== "metric") jobs.delete(data.id);
    try { current.port.postMessage(data); } catch { worker.postMessage({ cancel: data.id }); }
  };
  return worker;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== prefix || sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL("js/background.js") || typeof message.id !== "string") return;
  const id = message.id;
  const port = chrome.runtime.connect({ name: prefix + id });
  let submitted = false, worker;
  port.onDisconnect.addListener(() => {
    if (jobs.get(id)?.port !== port) return;
    jobs.delete(id);
    worker?.postMessage({ cancel: id });
  });
  port.onMessage.addListener((job) => {
    if (submitted) return;
    submitted = true;
    try {
      worker = owner(job.scope);
      jobs.set(id, { port });
      worker.postMessage({ id, ...job });
    } catch {
      jobs.delete(id);
      port.postMessage({ kind: "lost" });
    }
  });
  reply({ accepted: true });
});
