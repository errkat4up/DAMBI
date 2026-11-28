import { beforeEach, expect, it, vi } from "vitest";
import { auditAppend, auditRead, pendingDelete, pendingGet, pendingPut } from "../storage";
import type { AuditEntry, PendingRequest } from "../storage";

const storage = vi.hoisted(() => {
  function area() {
    const values = new Map<string, unknown>();
    return {
      values,
      get: async (key: string) => ({ [key]: structuredClone(values.get(key)) }),
      set: vi.fn(async (entries: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
      }),
    };
  }
  return { session: area(), local: area() };
});
vi.mock("webextension-polyfill", () => ({ default: { storage } }));

function transaction(requestId: string, from: string): PendingRequest {
  return { requestId, hostname: "wallet.example", type: "transaction", bypassed: false,
    envelope: { from }, enqueuedAtMs: 1 };
}

const first = transaction("account-a:1", "0x" + "11".repeat(20));
const second = transaction("account-b:1", "0x" + "22".repeat(20));
function decision(request: PendingRequest): AuditEntry {
  return { requestId: request.requestId, hostname: request.hostname, type: request.type,
    bypassed: false, verdict: "pass", matchedPolicies: [], decidedAtMs: 2 };
}

beforeEach(() => {
  storage.local.values.clear();
  storage.session.values.clear();
});

it("retains both pending requests from concurrent accounts and removes only completed requests", async () => {
  await Promise.all([pendingPut(first), pendingPut(second)]);
  expect(await pendingGet(first.requestId)).toEqual(first);
  expect(await pendingGet(second.requestId)).toEqual(second);

  const next = { ...first, requestId: "account-a:2" };
  await Promise.all([pendingDelete(first.requestId), pendingPut(next)]);
  expect(await pendingGet(first.requestId)).toBeUndefined();
  expect(await pendingGet(next.requestId)).toEqual(next);
  expect(await pendingGet(second.requestId)).toEqual(second);

  await Promise.all([pendingDelete(second.requestId), pendingDelete(next.requestId)]);
  expect(storage.session.values.get("requests:pending")).toEqual({});
});

it("retains both audit decisions from concurrent accounts", async () => {
  const approved = decision(first);
  const denied: AuditEntry = { ...decision(second), verdict: "fail" };
  await Promise.all([auditAppend(approved), auditAppend(denied)]);
  expect(await auditRead()).toEqual([approved, denied]);
});

it("reports a failed audit write and still persists the next account's entry", async () => {
  storage.local.set.mockRejectedValueOnce(new Error("Storage write failed"));
  const rejected = auditAppend(decision(first));
  const next = auditAppend(decision(second));
  await expect(rejected).rejects.toThrow("Storage write failed");
  await next;
  expect(await auditRead()).toEqual([decision(second)]);
});
