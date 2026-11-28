import { describe, it, expect, vi } from "vitest";
import type Browser from "webextension-polyfill";

import { createVerdictReceiver } from "../verdict-channel";
import { sendToPortAndAwaitDecision, sendToPortAndAwaitResponse } from "../messages";
import { RequestType } from "../types";

const KEY = "dambi-test-verdict-port";

function runtimePort() {
  const messages = new Set<(message: any) => void>();
  const disconnects = new Set<() => void>();
  const postMessage = vi.fn();
  const port = {
    postMessage,
    onMessage: {
      addListener: (fn: (message: any) => void) => messages.add(fn),
      removeListener: (fn: (message: any) => void) => messages.delete(fn),
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnects.add(fn),
      removeListener: (fn: () => void) => disconnects.delete(fn),
    },
  } as unknown as Browser.Runtime.Port;
  return {
    port, postMessage, messages, disconnects,
    emit: (message: unknown) => messages.forEach((fn) => fn(message)),
    disconnect: () => disconnects.forEach((fn) => fn()),
  };
}

const payload = {
  type: RequestType.UNTYPED_SIGNATURE,
  hostname: "app.example",
  message: "sign me",
} as const;

describe("runtime decision hop", () => {
  it("preserves the original confirmation ID and forwards only its awaiting-user and decision", async () => {
    const hop = runtimePort();
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);
    let awaiting = 0;
    const result = r.awaitDecision("original", {
      phase1Ms: 100, phase2Ms: 500,
      onAwaitingUser: () => { awaiting++; },
    });
    const decision = sendToPortAndAwaitDecision(hop.port, payload, {
      requestId: "original",
      onAwaitingUser: () => ch.port1.postMessage({ requestId: "original", kind: "awaiting-user" }),
    });
    expect(hop.postMessage).toHaveBeenCalledWith({ requestId: "original", data: payload });
    hop.emit(null);
    hop.emit({ requestId: "other", kind: "awaiting-user" });
    hop.emit({ requestId: "other", data: true });
    hop.emit({ requestId: "original", kind: "awaiting-user" });
    await vi.waitFor(() => expect(awaiting).toBe(1));
    hop.emit({ requestId: "original", data: false, rejection: "user_cancelled" });
    ch.port1.postMessage(await decision);
    expect(await result).toEqual({ requestId: "original", data: false, rejection: "user_cancelled" });
    expect(hop.messages.size).toBe(0);
    expect(hop.disconnects.size).toBe(0);
    ch.port1.close();
    ch.port2.close();
  });

  it("retains boolean callers and fails closed on malformed data", async () => {
    for (const data of [true, false, "true", 1, null]) {
      const hop = runtimePort();
      const pending = sendToPortAndAwaitResponse(hop.port, payload);
      const { requestId } = hop.postMessage.mock.calls[0][0];
      hop.emit({ requestId, data });
      expect(await pending).toBe(data === true);
    }
  });

  it("reports transport failure and both deadlines as unavailable, cleaning up listeners", async () => {
    vi.useFakeTimers();
    try {
      for (const failure of ["write", "disconnect", "timeout", "user-timeout"]) {
        const hop = runtimePort();
        if (failure === "write") hop.postMessage.mockImplementation(() => { throw new Error("disconnected"); });
        const pending = sendToPortAndAwaitDecision(hop.port, payload, { requestId: failure });
        if (failure === "disconnect") hop.disconnect();
        if (failure === "user-timeout") {
          hop.emit({ requestId: failure, kind: "awaiting-user" });
          await vi.advanceTimersByTimeAsync(300_000);
        } else if (failure === "timeout") {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(await pending).toEqual({ requestId: failure, data: false, rejection: "unavailable" });
        expect(hop.messages.size).toBe(0);
        expect(hop.disconnects.size).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Simulate the ISOLATED content script transferring its reader port to the
 * MAIN world: a `message` event on `window` carrying the init marker + the port.
 */
function dispatchPortInit(port: MessagePort, key = KEY): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { [key]: true },
      ports: [port],
      source: window,
    } as MessageEventInit),
  );
}

describe("verdict-channel receiver (C1 — page cannot forge a verdict)", () => {
  it.each([
    [{ data: true }, { data: true }],
    [{ data: false }, { data: false, rejection: "unavailable" }],
    [{ data: false, rejection: "user_cancelled" }, { data: false, rejection: "user_cancelled" }],
    [{ data: false, rejection: "policy_denied" }, { data: false, rejection: "policy_denied" }],
    [{ data: false, rejection: "unavailable" }, { data: false, rejection: "unavailable" }],
    [{ data: false, rejection: "other" }, { data: false, rejection: "unavailable" }],
    [{ data: false, rejection: {} }, { data: false, rejection: "unavailable" }],
    [{ data: "true", rejection: "user_cancelled" }, { data: false, rejection: "unavailable" }],
    [{ data: 1 }, { data: false, rejection: "unavailable" }],
    [{ data: true, rejection: "user_cancelled" }, { data: false, rejection: "unavailable" }],
  ])("normalizes authenticated decision %j", async (wire, expected) => {
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);
    const pending = r.awaitDecision("rich", { phase1Ms: 500, phase2Ms: 1000 });
    ch.port1.postMessage({ requestId: "rich", ...wire });
    expect(await pending).toEqual({ requestId: "rich", ...expected });
    ch.port1.close();
    ch.port2.close();
  });

  it("reports unavailable without a port and does not borrow another request's cancellation", async () => {
    const r = createVerdictReceiver(KEY);
    expect(await r.awaitDecision("no-port", { phase1Ms: 20, phase2Ms: 40 }))
      .toEqual({ requestId: "no-port", data: false, rejection: "unavailable" });
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);
    const a = r.awaitDecision("A", { phase1Ms: 100, phase2Ms: 200 });
    const b = r.awaitDecision("B", { phase1Ms: 100, phase2Ms: 200 });
    ch.port1.postMessage({ requestId: "A", data: false, rejection: "user_cancelled" });
    ch.port1.postMessage({ requestId: "B", data: false, rejection: "policy_denied" });
    expect(await a).toEqual({ requestId: "A", data: false, rejection: "user_cancelled" });
    expect(await b).toEqual({ requestId: "B", data: false, rejection: "policy_denied" });
    ch.port1.close();
    ch.port2.close();
  });
  it("fail-closes (false) when no authenticated port is ever transferred", async () => {
    const r = createVerdictReceiver(KEY);
    const v = await r.awaitVerdict("rid", { phase1Ms: 20, phase2Ms: 40 });
    expect(v).toBe(false);
  });

  it("resolves the verdict delivered over the authenticated port", async () => {
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);

    const p = r.awaitVerdict("rid", { phase1Ms: 500, phase2Ms: 1000 });
    ch.port1.postMessage({ requestId: "rid", data: true });
    expect(await p).toBe(true);
  });

  it("IGNORES a verdict forged on the window bus — only the entangled port resolves", async () => {
    const r = createVerdictReceiver(KEY);
    const genuine = new MessageChannel();
    dispatchPortInit(genuine.port2);

    const p = r.awaitVerdict("rid", { phase1Ms: 60, phase2Ms: 120 });
    // Page forgery attempts over the same window the MAIN proxy lives in:
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { requestId: "rid", data: true },
        source: window,
      } as MessageEventInit),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { [KEY]: true, requestId: "rid", data: true },
        source: window,
      } as MessageEventInit),
    );
    // The genuine writer port (held by ISOLATED) stays silent → the gate must
    // time out to a fail-closed `false`, NEVER the forged `true`.
    expect(await p).toBe(false);
  });

  it("first-init-wins: a later (page-supplied) port cannot replace the channel", async () => {
    const r = createVerdictReceiver(KEY);
    const genuine = new MessageChannel();
    dispatchPortInit(genuine.port2);
    const pageCh = new MessageChannel();
    dispatchPortInit(pageCh.port2); // second init — must be ignored

    const p = r.awaitVerdict("rid", { phase1Ms: 80, phase2Ms: 160 });
    pageCh.port1.postMessage({ requestId: "rid", data: true }); // page's port — ignored
    expect(await p).toBe(false);
  });

  it("forwards `false` (deny) delivered over the authenticated port", async () => {
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);

    const p = r.awaitVerdict("rid", { phase1Ms: 500, phase2Ms: 1000 });
    ch.port1.postMessage({ requestId: "rid", data: false });
    expect(await p).toBe(false);
  });

  it("`awaiting-user` over the port extends the deadline past phase1", async () => {
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);

    let awaitingSeen = false;
    const p = r.awaitVerdict("rid", {
      phase1Ms: 30,
      phase2Ms: 400,
      onAwaitingUser: () => {
        awaitingSeen = true;
      },
    });
    ch.port1.postMessage({ requestId: "rid", kind: "awaiting-user" });
    await new Promise((res) => setTimeout(res, 60)); // past phase1, within phase2
    ch.port1.postMessage({ requestId: "rid", data: true });

    expect(await p).toBe(true);
    expect(awaitingSeen).toBe(true);
  });

  it("only matches the verdict for the awaited requestId", async () => {
    const r = createVerdictReceiver(KEY);
    const ch = new MessageChannel();
    dispatchPortInit(ch.port2);

    const p = r.awaitVerdict("rid-A", { phase1Ms: 80, phase2Ms: 160 });
    ch.port1.postMessage({ requestId: "rid-OTHER", data: true }); // not ours
    expect(await p).toBe(false); // times out fail-closed, unaffected by other rid
  });
});
