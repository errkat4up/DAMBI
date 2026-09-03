/**
 * `Verdict` — 코어가 하나의 `CheckRequest`에 대해 돌려주는 판정 결과. 감사 로그의
 * 사후 재현 가능성이 이 타입의 설계 목표다 (R4).
 */

import type { FactResult } from "../ports/fact";

/**
 * 판정 결과. 3-state.
 *
 * `decision` 어휘: 공개 계약은 `"allow" | "warn" | "deny"`를 쓴다. WASM JSON
 * 경계의 wire 어휘는 `"pass" | "warn" | "fail"`이지만(dto.rs:128-134
 * `#[serde(rename_all="snake_case")]`, wasm-bridge.types.ts:3 `VERDICT_KINDS`),
 * 공개 계약이 내부 wire와 같을 이유가 없고 여기서는 같으면 안 된다:
 *
 *   - `{ decision: "fail", source: "evaluated" }`   → 정책이 거부
 *   - `{ decision: "fail", source: "fail_closed" }` → 평가 실패로 닫음
 *
 * 보안 제품에서 "fail"은 "검사가 실패했다"로 읽히는데 그게 정확히 `fail_closed`의
 * 뜻이라, `decision` 한 필드만으로는 정책 거부와 엔진 고장이 구분되지 않는다.
 * `"deny" + "fail_closed"`는 "거부됨, 이유는 fail-closed"로 읽혀 충돌이 없다.
 * (감사 레코드도 이미 `verdict.kind`와 `verdictSource`를 나란히 두 필드로
 * 기록한다 — orchestrator.ts:453-459 — 두 축이 직교해야 한다는 방증.)
 * 코어 내부 매핑은 한 줄: `pass→allow` / `warn→warn` / `fail→deny`.
 * `CedarDecision::Allow/Deny`(engine.rs:297-310)와의 혼동 위험은 없다 — 그 enum은
 * `policy-engine` crate 내부에만 있고 `@dambi/core`는 WASM JSON 경계만 본다.
 */
export interface Verdict {
  decision: "allow" | "warn" | "deny";

  /**
   * R3. "실제로 평가된 판정"인지 "평가 실패로 닫은 판정"인지. 확장 코드의
   * `VerdictSource`(orchestrator.ts:147 — `"declarative-v2" | "fail_closed"`)와
   * 같은 구분이며, 파이프라인 내부 이름 `"declarative-v2"`를 공개 계약에서는
   * `"evaluated"`로 탈-내부화한 것이다.
   */
  source: "evaluated" | "fail_closed";

  /**
   * R3. 프록시(자문) 경로인지 지갑 통합(집행) 경로인지. 현재 확장 코드에는 이
   * 필드가 없다 — 확장은 항상 프록시 경로라 구분이 불필요했다. SDK에서는 통합사가
   * advisory 판정을 집행으로 오해하면 안 되므로 넣는다. 값은 코어 생성 시
   * `CoreConfig.enforcement`로 정적 선언되며, 코어가 모든 verdict에 그대로 싣는다.
   */
  enforcement: "advisory" | "enforcing";

  /** 판정을 유발한 정책들. `allow`면 빈 배열. */
  reasons: readonly MatchedPolicy[];

  /**
   * R4. 판정에 쓰인 fact. 감사 로그에 판정을 남겨도, 이게 없으면 "이 주소는
   * 안전"이 어느 블록 기준이었는지 알 수 없어 사후 재현이 불가능하다. 현재
   * 확장 코드에는 verdict에 fact가 실리지 않는다 (wire의 `results`는 소비 후
   * 버려진다).
   */
  facts: readonly FactResult[];
}

/**
 * 매칭된 정책 하나. `Verdict.reasons`의 원소.
 * 근거: `dto.rs:136-142` `MatchedPolicyDto`, `wasm-bridge.types.ts:173-178`.
 */
export interface MatchedPolicy {
  /**
   * Cedar `@id`. 엔진이 합성한 항목은 `__system__` / `__engine::*` / `__venue::*`
   * (policy-rpc.ts:510,535-538).
   */
  policyId: string;

  /**
   * `@reason(...)` annotation. wire는 `string | null`이다 — `dto.rs:139`
   * `Option<String>`, `wasm-bridge.types.ts:175` `string | null`,
   * `requireNullableString`. (A단계 초안의 `reason: string`은 틀렸다.)
   */
  reason: string | null;

  /**
   * 값 집합은 정확히 `"warn" | "deny"` 두 개 — `wasm-bridge.types.ts:4`
   * `POLICY_SEVERITIES = ["deny","warn"]`, `verdict.rs:82-87`
   * `enum Severity { Deny, Warn }`, `action_eval_exports.rs:689-692`.
   * 이건 정책 저작 어휘(정책이 `@severity("deny")`로 스스로 선언)라
   * `decision`의 탈-내부화 대상이 아니다 — wire 값 그대로 노출한다.
   */
  severity: "warn" | "deny";

  /**
   * 값 집합: `"action" | "tx" | "engine_error"` — `wasm-bridge.types.ts:5`
   * `POLICY_REQUEST_ORIGINS`. Rust `PolicyRequestOrigin`은 `Action`/`Tx`뿐이지만
   * (verdict.rs:94-99) WASM 경계가 합성 fail에 `"engine_error"`를 추가로 emit
   * 한다 (action_eval_exports.rs:716). `formatAuditMatched`가 이 값으로 합성
   * 항목을 식별한다 (policy-rpc.ts:535-538). (A단계 초안의 `origin: string`은
   * 과하게 열려 있었고, 초안 verdict.ts에는 필드 자체가 빠져 있었다.)
   */
  origin: "action" | "tx" | "engine_error";
}
