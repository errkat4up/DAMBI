import type { RuleResult, ScamReport, ScamReportStatus, TargetReport } from "@dambi/core";
import { SCAM_SCOPE_NOTICE } from "@lib/scam-display";
import type { ScamDisplay, ScamHostFailure } from "@lib/scam-display";

const STATUS_COPY: Record<ScamReportStatus, string> = {
  warn: "주의 패턴 감지",
  quiet: "설정한 패턴 미감지",
  insufficient: "검사 불충분",
  disabled: "검사 꺼짐",
  not_applicable: "검사 대상 아님",
  not_configured: "검사 미구성",
};
const RULE_COPY: Record<RuleResult["state"], string> = {
  fired: "패턴 감지",
  clear: "패턴 미감지",
  incomplete: "검사 불완전",
  not_evaluable: "평가 불가",
};
const INITIAL_COPY: Record<RuleResult["initialState"], string> = {
  satisfied: "충족",
  unsatisfied: "미충족",
  not_required: "필요 없음",
};
const REASON_COPY: Record<string, string> = {
  initializing: "검사 준비 중",
  initialization_failed: "검사 초기화 실패",
  invalid_configuration: "검사 설정 오류",
  timeout: "검사 시간 초과",
  invalid_request: "요청 형식 오류",
  unsupported_request: "지원하지 않는 요청",
  host_error: "확장 프로그램에서 검사 정보를 읽지 못했습니다",
  aborted: "검사 중단",
  report_missing: "SDK 검사 결과 없음",
  algorithm_unavailable: "분석 모듈 미연결",
  algorithm_incompatible: "분석 모듈 호환 불가",
  invalid_algorithm_output: "분석 결과 검증 실패",
  scam_results_missing: "검사 자료 없음",
  invalid_scam_input: "검사 입력 검증 실패",
  subject_unresolved: "검사 대상 확인 불가",
  subject_mismatch: "검사 대상 불일치",
  reference_mismatch: "기준 블록 불일치",
  reorg: "체인 재구성 감지",
  bundle_unavailable: "검사 규칙 번들 없음",
  bundle_invalid: "검사 규칙 번들 검증 실패",
  data_missing: "자료 누락",
  field_unavailable: "필요한 필드 조회 불가",
  initial_state_unknown: "초기 상태 확인 불가",
  history_unverified: "블록 단위 원본 이력 확인 불가",
  age_unknown: "풀 나이 확인 불가",
  market_too_young: "관찰 기간 부족",
  stale_data: "자료 유효 시간 초과",
  unsupported_resolution: "지원하지 않는 관찰 간격",
  resource_limit: "검사 자원 한도 초과",
  no_time_budget: "검사에 필요한 시간 부족",
  user_disabled: "사용자가 검사를 껐습니다",
  no_active_rules: "활성 규칙 없음",
};
const HOST_REASONS = new Set([
  "initializing", "initialization_failed", "invalid_configuration", "timeout",
  "invalid_request", "unsupported_request", "host_error", "aborted", "report_missing",
]);
const MAX_TARGETS = 8;
const MAX_RULES = 16;
const MAX_JSON_CHARS = 4_096;
const MAX_TEXT_CHARS = 600;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isReport(value: unknown): value is ScamReport {
  if (!record(value) || typeof value.status !== "string" ||
      !Object.hasOwn(STATUS_COPY, value.status) || !strings(value.reasons) ||
      value.scopeNotice !== "patterns_only_no_sellability_guarantee" || !Array.isArray(value.targets)) return false;
  return value.targets.every((target: unknown) => {
    if (!record(target) || !record(target.subject) ||
        !Number.isSafeInteger(target.subject.chainId) ||
        typeof target.subject.token !== "string" || typeof target.subject.pool !== "string" ||
        !["warn", "quiet", "insufficient", "not_applicable"].includes(String(target.status)) ||
        !strings(target.reasons) || !Array.isArray(target.rules) ||
        (target.analysisMode !== undefined && target.analysisMode !== "real" && target.analysisMode !== "stub")) return false;
    if (target.binding !== undefined) {
      if (!record(target.binding) || !record(target.binding.reference) ||
          !record(target.binding.reference.block)) return false;
      const block = target.binding.reference.block;
      if (typeof block.number !== "string" || typeof block.hash !== "string" ||
          typeof block.timestampMs !== "number" || !Number.isSafeInteger(block.timestampMs) || block.timestampMs < 0) return false;
    }
    return target.rules.every((rule: unknown) => record(rule) &&
      typeof rule.ruleId === "string" && typeof rule.state === "string" && Object.hasOwn(RULE_COPY, rule.state) &&
      typeof rule.initialState === "string" && Object.hasOwn(INITIAL_COPY, rule.initialState) &&
      strings(rule.reasons) && Object.hasOwn(rule, "evidence") && record(rule.coverage) &&
      Array.isArray(rule.coverage.missing) && Array.isArray(rule.coverage.unavailable));
  });
}

export function unavailableScamDisplay(): ScamDisplay {
  return { version: 1, kind: "unavailable", reason: "host_error", holding: "unknown" };
}

/** The host owns SDK validation; this checks the session/display boundary only. */
export function readStoredScamDisplay(value: unknown, requestId: string, nowMs: number): ScamDisplay {
  if (!requestId || !record(value) || value.requestId !== requestId ||
      typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs <= nowMs || !record(value.display)) return unavailableScamDisplay();
  const display = value.display;
  if (display.version !== 1 || display.holding !== "unknown") return unavailableScamDisplay();
  if (display.kind === "report" && isReport(display.report)) {
    return { version: 1, kind: "report", report: display.report, holding: "unknown" };
  }
  if (display.kind === "unavailable" && typeof display.reason === "string" && HOST_REASONS.has(display.reason)) {
    return { version: 1, kind: "unavailable", holding: "unknown", reason: display.reason as ScamHostFailure };
  }
  return unavailableScamDisplay();
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function clipped(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}… [표시 길이 제한으로 생략]` : text;
}
function time(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "정보 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "정보 없음" : date.toISOString();
}
function reasons(values: readonly string[]): string {
  if (values.length === 0) return "보고된 사유 없음";
  return clipped(values.map((reason) => REASON_COPY[reason] ? `${REASON_COPY[reason]} (${reason})` : reason).join(" · "));
}
function omission(container: HTMLElement, omitted: number, unit: string): void {
  if (omitted > 0) container.appendChild(node("p", "scam-note", `화면 표시 제한으로 ${unit} ${omitted}개를 생략했습니다.`));
}
function jsonDetails(label: string, value: unknown): HTMLElement {
  const details = node("details", "scam-evidence");
  details.appendChild(node("summary", "", label));
  let json: string;
  try { json = JSON.stringify(value, null, 2) ?? "제공된 근거 없음"; }
  catch { json = "근거를 표시하지 못했습니다."; }
  const truncated = json.length > MAX_JSON_CHARS;
  details.appendChild(node("pre", "", truncated ? json.slice(0, MAX_JSON_CHARS) : json));
  if (truncated) details.appendChild(node("p", "scam-note", `화면 표시 제한으로 JSON 근거를 ${MAX_JSON_CHARS}자까지만 표시합니다. 원결과의 나머지 근거는 이 화면에 표시되지 않습니다.`));
  return details;
}
function renderRule(rule: RuleResult): HTMLElement {
  const item = node("article", `scam-rule scam-rule-${rule.state}`);
  item.appendChild(node("h4", "", `${clipped(rule.ruleId)} · ${RULE_COPY[rule.state]}`));
  item.appendChild(node("p", "scam-meta", `초기 상태: ${INITIAL_COPY[rule.initialState]}`));
  item.appendChild(node("p", "scam-meta", `관찰 범위 (UTC): ${time(rule.coverage.fromMs)} ~ ${time(rule.coverage.toMs)}`));
  item.appendChild(node("p", "scam-meta", `Coverage: 누락 구간 ${rule.coverage.missing.length}개 · 조회 불가 필드 ${rule.coverage.unavailable.length}개`));
  item.appendChild(node("p", "scam-meta", reasons(rule.reasons)));
  if (record(rule.evidence)) {
    const evidence = rule.evidence;
    const scalar = (value: unknown): string => typeof value === "number" || typeof value === "string" ? clipped(String(value)) : "정보 없음";
    item.appendChild(node("p", "scam-meta", `근거 값: 관측 ${scalar(evidence.observed)} · 기준 ${scalar(evidence.threshold)}`));
    if (typeof evidence.coverageBps === "number" && Number.isInteger(evidence.coverageBps) && evidence.coverageBps >= 0 && evidence.coverageBps <= 10_000) {
      item.appendChild(node("p", "scam-meta", `알고리즘 Coverage: ${evidence.coverageBps / 100}% (자료 누락·초기 상태는 별도 확인)`));
    }
  }
  item.appendChild(jsonDetails("근거 및 Coverage 상세", { evidence: rule.evidence, coverage: rule.coverage }));
  return item;
}
function renderTarget(target: TargetReport): HTMLElement {
  const item = node("section", "scam-target");
  item.appendChild(node("h3", "", `대상 · ${STATUS_COPY[target.status]}`));
  item.appendChild(node("p", "scam-meta", `Chain ${target.subject.chainId} · Token ${clipped(target.subject.token)}`));
  item.appendChild(node("p", "scam-meta", `Pool ${clipped(target.subject.pool)}`));
  item.appendChild(node("p", "scam-meta", `분석 모드: ${target.analysisMode ?? "정보 없음"}`));
  item.appendChild(node("p", "scam-meta", reasons(target.reasons)));
  const block = target.binding?.reference?.block;
  item.appendChild(node("p", "scam-meta", block
    ? `기준 블록: ${clipped(String(block.number))} · 시간 (UTC): ${time(block.timestampMs)}`
    : "기준 블록·시간: 정보 없음"));
  if (block) item.appendChild(node("p", "scam-meta", `블록 해시: ${clipped(String(block.hash))}`));
  if (target.binding) item.appendChild(jsonDetails("분석 설정·버전·자료 기준", target.binding));
  item.appendChild(jsonDetails("검사 대상과 요청 경로", target.subject));
  if (target.rules.length === 0) item.appendChild(node("p", "scam-note", "보고된 규칙 결과가 없습니다."));
  for (const rule of target.rules.slice(0, MAX_RULES)) item.appendChild(renderRule(rule));
  omission(item, target.rules.length - MAX_RULES, "규칙");
  return item;
}

export function renderScamLoading(): HTMLElement {
  const card = node("section", "scam-card");
  card.lang = "ko";
  card.setAttribute("aria-label", "Scam Filter");
  card.appendChild(node("h2", "scam-title", "Scam Filter"));
  card.appendChild(node("p", "scam-status", "검사 정보 불러오는 중"));
  card.appendChild(node("p", "scam-note", "보유 여부: 미확인 (unknown)"));
  card.appendChild(node("p", "scam-scope", SCAM_SCOPE_NOTICE));
  return card;
}

export function renderScamCard(display: ScamDisplay): HTMLElement {
  const card = node("section", `scam-card scam-${display.kind === "report" ? display.report.status : "unavailable"}`);
  card.lang = "ko";
  card.setAttribute("aria-label", "Scam Filter");
  card.appendChild(node("h2", "scam-title", "Scam Filter"));
  if (display.kind === "report" && display.report.targets.some((target) => target.analysisMode === "stub")) {
    card.appendChild(node("p", "scam-test-mode", "시험 모드 (stub) — 실제 탐지 결과가 아닙니다."));
  }
  card.appendChild(node("p", "scam-status", display.kind === "report" ? STATUS_COPY[display.report.status] : "검사 정보 확인 불가"));
  card.appendChild(node("p", "scam-note", "보유 여부: 미확인 (unknown)"));
  card.appendChild(node("p", "scam-scope", SCAM_SCOPE_NOTICE));
  if (display.kind === "unavailable") {
    card.appendChild(node("p", "scam-meta", `${REASON_COPY[display.reason]} (${display.reason})`));
    card.appendChild(node("p", "scam-note", "확장 프로그램의 표시 상태이며 SDK의 검사 판정이 아닙니다."));
    card.appendChild(node("p", "scam-meta", "기준 블록·시간: 정보 없음"));
  } else {
    if (display.report.status === "quiet") {
      card.appendChild(node("p", "scam-note", "활성화된 검사 항목에서 경고 조건이 발견되지 않았습니다."));
    }
    card.appendChild(node("p", "scam-meta", reasons(display.report.reasons)));
    if (display.report.targets.length === 0) card.appendChild(node("p", "scam-note", "보고된 검사 대상·규칙·기준 블록·시간이 없습니다."));
    for (const target of display.report.targets.slice(0, MAX_TARGETS)) card.appendChild(renderTarget(target));
    omission(card, display.report.targets.length - MAX_TARGETS, "검사 대상");
  }
  return card;
}
