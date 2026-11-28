// Manual S2b component measurement (Node 22+). Start the isolated extension worker first,
// then run: node scripts/sdk/scam-host-timing-probe.mjs http://127.0.0.1:9222 EXTENSION_ID 30000
// After "ready", open a fresh test dApp tab and issue its ordinary unsigned test-wallet request.
// Windowless outcomes lack this publication boundary. A worker that exits ends its capture.
// Startup before the port, UI render and user choice are outside this measurement.
// This worker-only connection cannot observe the content-script final receiver or
// request start before worker activation. Those remain named missing stages, not
// inferred no-window completions or cold samples. measureScamHostRequest provides
// a separate ordinary unsigned-harness boundary where those signals are available;
// it does not make this CDP capture a whole-host measurement. S2b remains pending.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { collectScamHostTrials, observeScamHost } from "./scam-host-timing.mjs";
export { measureScamHostRequest, observeScamHostGate } from "./scam-host-timing.mjs";

export async function probeScamHost(endpoint, extensionId, durationMs, onReady = () => {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !/^[a-p]{32}$/.test(extensionId) || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) {
    throw Error("Specify a loopback HTTP debug endpoint, extension ID, and capture duration of 1–300000 ms.");
  }
  const res = await fetch(new URL("/json/list", url), { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw Error("Could not list local browser targets.");
  const workers = (await res.json()).filter(target => target.type === "service_worker" &&
    target.url === "chrome-extension://" + extensionId + "/js/background.js");
  if (workers.length !== 1) throw Error("Expected one running DAMBI extension worker.");
  const wsUrl = new URL(workers[0].webSocketDebuggerUrl);
  if (wsUrl.protocol !== "ws:" || wsUrl.host !== url.host || wsUrl.username || wsUrl.password) {
    throw Error("Unexpected browser debug transport.");
  }
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const capture = collectScamHostTrials();
  const binding = "__dambiS2b" + randomUUID().replaceAll("-", "");
  let sequence = 0;
  let timeout;
  let workerDisconnected = false;
  let disconnect;
  const stopped = new Promise(resolve => {
    disconnect = () => {
      workerDisconnected = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(Error("Worker disconnected."));
      }
      pending.clear();
      resolve("worker_disconnected");
    };
    socket.addEventListener("close", disconnect, { once: true });
  });
  socket.onmessage = ({ data }) => {
    if (workerDisconnected) return;
    const msg = JSON.parse(data);
    // A terminated MV3 worker can retain its debugger socket until much later.
    if (msg.method === "Inspector.targetCrashed" || msg.method === "Inspector.detached") {
      disconnect();
      return;
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params.name === binding) {
      try { capture.accept(JSON.parse(msg.params.payload)); } catch { /* Ignore invalid binding messages. */ }
    } else if (pending.has(msg.id)) {
      const request = pending.get(msg.id);
      clearTimeout(request.timer);
      pending.delete(msg.id);
      if (msg.error || msg.result?.exceptionDetails) request.reject(Error("Worker diagnostic command failed."));
      else request.resolve(msg.result);
    }
  };
  function send(method, params) {
    if (workerDisconnected || socket.readyState !== WebSocket.OPEN) return Promise.reject(Error("Worker disconnected."));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Local debugger command timed out."));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  let observer, handshakeTimer;
  try {
    await new Promise((resolve, reject) => {
      handshakeTimer = setTimeout(() => reject(Error("Local debugger did not open.")), 5_000);
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(Error("Local debugger unavailable.")), { once: true });
    });
    clearTimeout(handshakeTimer);
    await send("Runtime.enable", {});
    await send("Runtime.addBinding", { name: binding });
    observer = (await send("Runtime.evaluate", {
      expression: "(" + observeScamHost.toString() + ")(globalThis, row => globalThis." + binding + "(JSON.stringify(row)))",
    })).result.objectId;
    if (!observer) throw Error("Diagnostic observer unavailable.");
    onReady();
    const stoppedBecause = await Promise.race([stopped, new Promise(resolve => {
      timeout = setTimeout(() => resolve("duration_elapsed"), durationMs);
    })]);
    return { boundary: "worker_port_receive_to_review_publication", clock: "worker_performance_now",
      missingStages: ["request_start_before_worker_activation", "request_matched_final_reply"],
      stoppedBecause, trials: capture.finish(stoppedBecause === "duration_elapsed" ? "publication_not_observed" : stoppedBecause) };
  } finally {
    clearTimeout(handshakeTimer);
    clearTimeout(timeout);
    if (observer && !workerDisconnected && socket.readyState === WebSocket.OPEN) {
      await send("Runtime.callFunctionOn", { objectId: observer, functionDeclaration: "function () { this(); }" })
        .finally(() => send("Runtime.removeBinding", { name: binding }))
        .catch(() => { /* A worker can terminate during cleanup. */ });
    }
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [endpoint, extensionId, duration] = process.argv.slice(2);
    const result = await probeScamHost(endpoint, extensionId, Number(duration), () => console.error("ready"));
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error("Could not capture this local development worker. Check endpoint, extension ID and duration.");
    process.exitCode = 1;
  }
}
