import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scamConfirmKey } from "@lib/scam-display";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_key: string): Promise<Record<string, unknown>> => ({})),
  set: vi.fn(async (_value: Record<string, unknown>) => undefined),
  remove: vi.fn(async (_key: string) => undefined),
  sendMessage: vi.fn(async (_message: unknown) => undefined),
}));
vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: { getURL: (path: string) => `chrome-extension://dambi/${path}`, sendMessage: mocks.sendMessage },
    storage: { session: { get: mocks.get, set: mocks.set, remove: mocks.remove } },
  },
}));

async function openConfirm(kind: string, review = false, scam = false): Promise<void> {
  const params = new URLSearchParams({ requestId: "request-1", verdict: JSON.stringify({ kind }) });
  if (review) params.set("review", "1");
  if (scam) params.set("scam", "1");
  window.history.replaceState(null, "", `/confirm.html?${params}`);
  document.body.innerHTML = '<main id="root"></main>';
  await import("./index");
}

describe("confirmation review controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({});
    mocks.remove.mockResolvedValue(undefined);
    vi.spyOn(window, "close").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["pass", true, "Continue"], ["pass", false, null],
    ["warn", true, "Trust and proceed"], ["fail", true, null],
    ["invalid", true, null],
  ] as const)("keeps approval scoped to %s / review=%s", async (kind, review, label) => {
    await openConfirm(kind, review);
    expect(document.querySelector(".btn-approve")?.textContent ?? null).toBe(label);
    if (kind === "fail" || kind === "invalid") expect(document.querySelector(".btn-cancel")?.textContent).toBe("Close");
  });

  it("renders controls before session reading finishes and preserves cancellation", async () => {
    const key = scamConfirmKey("request-1");
    let finishRead!: (stored: Record<string, unknown>) => void;
    const delayedRead = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
    mocks.get.mockImplementation(async (requestedKey) => requestedKey === key
      ? delayedRead
      : { "requests:pending-decisions": { "request-1": { status: "awaiting" } } });
    await openConfirm("pass", true, true);
    expect(document.querySelector(".scam-status")?.textContent).toBe("검사 정보 불러오는 중");
    expect(document.querySelector(".btn-approve")?.textContent).toBe("Continue");
    expect((document.querySelector(".btn-approve") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector(".btn-cancel") as HTMLButtonElement).disabled).toBe(false);
    (document.querySelector(".btn-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith({ type: "dambi:verdict-decision", requestId: "request-1", ok: false }));
    expect(mocks.set).toHaveBeenCalledWith({ "requests:pending-decisions": { "request-1": { status: "decided", ok: false } } });
    finishRead({});
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(key));
  });

  it("shows a host error when reading fails and cleans up the per-request payload", async () => {
    mocks.get.mockRejectedValue(new Error("session unavailable"));
    await openConfirm("fail", true, true);
    await vi.waitFor(() => expect(document.querySelector(".scam-card")?.textContent).toContain("host_error"));
    expect(document.querySelector(".btn-approve")).toBeNull();
    expect(document.querySelector(".btn-cancel")).not.toBeNull();
    expect(mocks.remove).toHaveBeenCalledWith(scamConfirmKey("request-1"));
  });

  it("loads its SDK report and records an explicit pass review approval", async () => {
    const key = scamConfirmKey("request-1");
    mocks.get.mockImplementation(async (requestedKey) => requestedKey === key ? {
      [key]: {
        requestId: "request-1", expiresAtMs: Date.now() + 60_000,
        display: { version: 1, kind: "report", holding: "unknown", report: {
          status: "insufficient", reasons: ["algorithm_unavailable"], targets: [],
          scopeNotice: "patterns_only_no_sellability_guarantee",
        } },
      },
    } : { "requests:pending-decisions": { "request-1": { status: "awaiting" } } });
    await openConfirm("pass", true, true);
    await vi.waitFor(() => {
      expect(document.querySelector(".scam-status")?.textContent).toBe("검사 불충분");
      expect((document.querySelector(".btn-approve") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(document.querySelector(".headline")?.textContent).toBe("서명 전 검사 결과");
    expect(document.querySelector(".guard.pass")).toBeNull();
    (document.querySelector(".btn-approve") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith({ type: "dambi:verdict-decision", requestId: "request-1", ok: true }));
    expect(mocks.set).toHaveBeenCalledWith({ "requests:pending-decisions": { "request-1": { status: "decided", ok: true } } });
    expect(mocks.remove).toHaveBeenCalledWith(key);
  });
});
