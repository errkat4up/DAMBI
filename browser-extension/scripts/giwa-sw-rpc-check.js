// SF0-2: paste into Dambi's Service Worker DevTools console, not a web page.
// Read-only, at most 3 sequential requests; no retries, UA overrides or storage writes.
// The 8-second diagnostic timeout is not the Scam Filter performance budget.
(async () => {
  if (typeof ServiceWorkerGlobalScope === "undefined" ||
      !(self instanceof ServiceWorkerGlobalScope) ||
      typeof chrome === "undefined" || !chrome.runtime?.id) {
    console.error("SF0-2: Dambi Service Worker 콘솔에서 실행해야 합니다.");
    return;
  }
  const manifest = chrome.runtime.getManifest();
  if (!/dambi/i.test(manifest.name)) {
    console.error("SF0-2: Dambi가 아닌 확장이므로 요청하지 않습니다.");
    return;
  }
  const endpoint = "https://sepolia-rpc.giwa.io/";
  const pair = "0xcaafb95fc292c10a526f03fa480407bb438dac67";
  const tx = "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9";
  const topics = [
    "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
    "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  ];
  const logBlock = "0x" + (39044394).toString(16);
  const probes = [
    ["eth_chainId", [], (r) => r === "0x164ce"],
    ["eth_call", [{ to: pair, data: "0x0902f1ac" }, "0x253effb"],
      (r) => typeof r === "string" && /^0x[0-9a-f]{192}$/i.test(r)],
    ["eth_getLogs", [{ address: pair, fromBlock: logBlock, toBlock: logBlock,
      topics: [topics] }], (r) => Array.isArray(r) && topics.every((topic) =>
      r.some((l) => l.address?.toLowerCase() === pair && l.transactionHash === tx &&
        l.blockNumber === logBlock && l.topics?.[0] === topic && l.removed !== true))],
  ];
  const report = {
    check: "SF0-2", at: new Date().toISOString(), endpoint,
    extension: { id: chrome.runtime.id, name: manifest.name, version: manifest.version },
    workerUrl: self.location.href, userAgent: navigator.userAgent,
    declaredHosts: manifest.host_permissions ?? [],
    csp: manifest.content_security_policy ?? null,
    grantedHostPermission: await chrome.permissions.contains({ origins: [endpoint + "*"] })
      .catch(() => "query_failed"),
    timeoutMs: 8000, results: [],
  };
  for (const [method, params, valid] of probes) {
    const id = report.results.length + 1;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), report.timeoutMs);
    const row = { method, status: "fail", httpStatus: null, stage: "network" };
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal, credentials: "omit", redirect: "error",
      });
      row.httpStatus = response.status;
      row.stage = "http";
      if (!response.ok) throw new Error("HTTP " + response.status);
      row.stage = "json";
      const data = await response.json();
      row.stage = "rpc";
      if (data.error) throw new Error(JSON.stringify(data.error));
      row.stage = "result";
      if (data.jsonrpc !== "2.0" || data.id !== id || !valid(data.result)) {
        throw new Error("Unexpected RPC result");
      }
      row.status = "pass";
      row.summary = method === "eth_getLogs" ? { logCount: data.result.length }
        : method === "eth_chainId" ? { chainId: 91342 } : { abiWords: 3 };
    } catch (error) {
      if (controller.signal.aborted) row.stage = "timeout";
      row.error = String(error?.message ?? error).slice(0, 240);
    } finally {
      clearTimeout(timer);
      row.durationMs = Math.round(performance.now() - started);
      report.results.push(row);
    }
    if (method === "eth_chainId" && row.status !== "pass") break;
  }
  report.passed = report.results.length === probes.length &&
    report.results.every((row) => row.status === "pass");
  console.log("SF0-2 " + JSON.stringify(report, null, 2));
})().catch((error) => console.error("SF0-2 setup:", String(error)));
