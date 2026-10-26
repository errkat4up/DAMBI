import { createProbeSession, readProbeConfig } from "./scam-data-probe-session.mjs";

// Manual host diagnostic only. No transaction hooks, persistent storage or
// keep-alive. Installing the console API does not create a provider or make I/O.
export function installScamSwProbe(scope, createProvider) {
  const reject = (message) => { throw new Error(`AH5-2: ${message}`); };
  if (typeof scope?.ServiceWorkerGlobalScope !== "function"
      || !(scope instanceof scope.ServiceWorkerGlobalScope)
      || !scope.chrome?.runtime?.id) reject("Use the Dambi extension Service Worker console.");
  const manifest = scope.chrome.runtime.getManifest();
  const url = new URL(scope.location.href);
  if (!/dambi/i.test(manifest.name) || url.protocol !== "chrome-extension:"
      || url.hostname !== scope.chrome.runtime.id) reject("Use the Dambi extension Service Worker console.");
  if (Object.hasOwn(scope, "dambiScamProbe")) reject("Already installed; the existing session is retained. Reload the extension for a new worker.");

  const host = Object.freeze({
    check: "AH5-2", workerSessionId: scope.crypto.randomUUID(),
    extension: Object.freeze({ id: scope.chrome.runtime.id, name: manifest.name, version: manifest.version }),
    workerUrl: url.href,
  });
  let session;
  const requireSession = () => session ?? reject("Call dambiScamProbe.start() first.");
  const api = Object.freeze({
    start(env = {}) {
      if (session) reject("Session already started; this worker keeps the same provider.");
      try {
        const config = readProbeConfig({ SCAM_HISTORY_VERIFICATION: "rpc_anchor", SCAM_HISTORY_CACHE: "1",
          SCAM_PREPARE_TIMEOUT_MS: "60000", SCAM_TIMEOUT_MS: "2500", SCAM_REPEATS: "3", ...env });
        session = createProbeSession(config, createProvider);
      } catch { reject("Invalid or unavailable diagnostic configuration; values omitted."); }
      return api.report();
    },
    prepare() { return requireSession().prepare(); },
    fetch() { return requireSession().fetch(); },
    report() {
      return { ...host, started: !!session, ...(session ? { data: session.report() } : {}),
        hostLimitations: [
          "Manual provider diagnostic in the extension worker; not the product signing path or full analysis performance.",
          "DevTools may affect worker lifetime. Extension reload verifies worker recreation, not natural idle suspension.",
          "A new worker ID alone does not prove a cold fetch. Check the new worker's first unprepared history reuse separately.",
        ] };
    },
  });
  // Re-pasting or deleting a console variable must not silently reset the cache.
  Object.defineProperty(scope, "dambiScamProbe", { value: api, writable: false, configurable: false });
  return api;
}
