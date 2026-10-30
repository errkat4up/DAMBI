import { describe, expect, it } from "vitest";
import type { ScamReport, TargetReport } from "@dambi/core";
import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";
import {
  readStoredScamDisplay,
  renderScamCard,
  unavailableScamDisplay,
} from "./scam-card";

const ADDRESS = `0x${"11".repeat(20)}` as const;
const HASH = `0x${"22".repeat(32)}` as const;
const NOW = 1_800_000_000_000;

function report(status: ScamReport["status"] = "insufficient"): ScamReport {
  return { status, reasons: [], targets: [], scopeNotice: "patterns_only_no_sellability_guarantee" };
}
function target(): TargetReport {
  const subject = {
    chainId: 1, token: ADDRESS, pool: ADDRESS, factory: ADDRESS,
    quoteToken: ADDRESS, venue: "uniswap_v2" as const, actionPaths: ["0"],
  };
  const block = { number: "123", hash: HASH, timestampMs: NOW };
  return {
    subject, status: "warn", reasons: [], analysisMode: "stub",
    binding: {
      planId: "plan-1", subject,
      reference: { block, checkedHead: block, requiredConfirmDepth: 1, observedConfirmDepth: 1 },
      settingsHash: HASH, settingsHashScheme: "sha256-jcs-scam-v1",
      bundleSequence: "1", selectedPreset: "established", selectionReason: "exact_mature",
      effectiveSettingsHash: HASH,
      algorithm: { id: "fixture", version: "1", contractVersion: 2 },
      builderVersion: "1", fromMs: NOW - 60_000, toMs: NOW,
      bucketMs: 1_000, gridOriginMs: 0, warmupSec: 1,
    },
    rules: [{
      ruleId: "rule-1", state: "fired", initialState: "unsatisfied", reasons: ["data_missing"],
      coverage: {
        fromBlock: "100", fromMs: NOW - 60_000, toMs: NOW,
        missing: [{ fromMs: NOW - 20_000, toMs: NOW - 10_000, reason: "timeout" }],
        unavailable: [{ field: "adminEvents", reason: "unsupported" }],
      },
      evidence: { observed: 7, threshold: 3, coverageBps: 5_000, events: [{ tMs: NOW, kind: "fixture" }] },
    }],
  };
}

describe("Scam confirmation card", () => {
  it.each([
    ["warn", "주의 패턴 감지"], ["quiet", "설정한 패턴 미감지"],
    ["insufficient", "검사 불충분"], ["disabled", "검사 꺼짐"],
    ["not_applicable", "검사 대상 아님"], ["not_configured", "검사 미구성"],
  ] as const)("shows %s without suppressing the scope notice", (status, copy) => {
    const card = renderScamCard({ version: 1, kind: "report", report: report(status), holding: "unknown" });
    expect(card.querySelector(".scam-status")?.textContent).toBe(copy);
    expect(card.textContent).toContain(SCAM_SCOPE_NOTICE);
    expect(card.textContent).toContain("보유 여부: 미확인");
    expect(card.textContent).toContain("기준 블록·시간이 없습니다");
  });

  it("discloses stub mode, actual observations, coverage gaps, initial state and reference", () => {
    const card = renderScamCard({ version: 1, kind: "report", holding: "unknown", report: { ...report("warn"), targets: [target()] } });
    expect(card.querySelector(".scam-test-mode")?.textContent).toContain("실제 탐지 결과가 아닙니다");
    expect(card.textContent).toContain("관측 7 · 기준 3");
    expect(card.textContent).toContain("초기 상태: 미충족");
    expect(card.textContent).toContain("누락 구간 1개 · 조회 불가 필드 1개");
    expect(card.textContent).toContain("알고리즘 Coverage: 50%");
    expect(card.textContent).toContain("기준 블록: 123");
    expect(card.textContent).toContain(new Date(NOW).toISOString());
    expect(card.textContent).toContain(HASH);
  });

  it("renders arbitrary evidence as bounded text and explicitly identifies omitted content", () => {
    const sample = target();
    const longEvidence = "<img src=x onerror=alert(1)>" + "x".repeat(5_000);
    const card = renderScamCard({
      version: 1, kind: "report", holding: "unknown",
      report: { ...report("warn"), targets: [{ ...sample, rules: [{ ...sample.rules[0]!, evidence: { observed: longEvidence } }] }] },
    });
    expect(card.querySelector("img")).toBeNull();
    // Target metadata also has <pre> blocks; inspect the rule evidence itself.
    const evidence = card.querySelector(".scam-rule .scam-evidence");
    expect(evidence).not.toBeNull();
    const text = evidence?.querySelector("pre")?.textContent;
    expect(text?.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(evidence?.textContent).toContain("원결과의 나머지 근거는 이 화면에 표시되지 않습니다");
  });

  it("uses a distinct host state for missing, stale, mismatched or malformed session data", () => {
    const display = { version: 1, kind: "report", holding: "unknown", report: report() };
    const stored = { requestId: "request-1", expiresAtMs: NOW + 60_000, display };
    expect(readStoredScamDisplay(stored, "request-1", NOW)).toEqual(display);
    const fullDisplay = { ...display, report: { ...report("warn"), targets: [target()] } };
    expect(readStoredScamDisplay({ ...stored, display: fullDisplay }, "request-1", NOW)).toEqual(fullDisplay);
    for (const invalid of [
      undefined, { ...stored, requestId: "another" }, { ...stored, expiresAtMs: NOW },
      { ...stored, expiresAtMs: Number.POSITIVE_INFINITY },
      { ...stored, display: { ...display, version: 2 } },
      { ...stored, display: { ...display, report: { ...report(), targets: [{}] } } },
    ]) {
      expect(readStoredScamDisplay(invalid, "request-1", NOW)).toEqual(unavailableScamDisplay());
    }
    const card = renderScamCard(unavailableScamDisplay());
    expect(card.textContent).toContain("host_error");
    expect(card.textContent).toContain("SDK의 검사 판정이 아닙니다");
    expect(card.textContent).toContain(SCAM_SCOPE_NOTICE);
  });
});
