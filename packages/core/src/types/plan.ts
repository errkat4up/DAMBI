/**
 * 계획(plan) 단계의 타입 — 코어가 fact를 얻으려고 호스트에 넘기는 콜, 그리고
 * 판정 입력으로 받는 정책 묶음 / fact 맵.
 */

import type { FactResult } from "../ports/fact";

/**
 * 코어가 "이 콜을 실행해서 결과를 달라"고 호스트에 넘기는 하나의 계획된 콜.
 *
 * **"실행할 트랜잭션"이 아니다** — 정책이 요구하는 fact enrichment RPC 콜이다
 * (예: `oracle.usd_value`). 근거: `wasm-bridge.types.ts:103-115`
 * `PlannedCallV2Dto`, `action_eval_exports.rs:184-193` `PlannedCallDto`,
 * `planning_v2.rs:32-46` `PlannedCallV2` — 세 곳이 일치한다.
 * (A단계 초안의 `{ callId, chainId, to, data }`는 `callId` 말고 전부 틀렸다.)
 */
export interface PlannedCall {
  /** 이 콜을 발생시킨 manifest의 id. */
  manifestId: string;
  /**
   * 안정적 콜 id — `"<manifest_id>::<spec_id>"`. 호스트는 결과를 이 키로 돌려준다
   * ({@link FactMap}의 키).
   */
  callId: string;
  /** 원격 메서드 이름 (opaque). 예: `"oracle.usd_value"`. */
  method: string;
  /**
   * 해석된 파라미터 (셀렉터 치환 완료). Q-C: opaque하게 둔다 — Rust 쪽
   * `params: Value`(planning_v2.rs:40)라 객체로 못박을 수 없고, `FactProvider`
   * 구현자는 이 값을 그대로 원격 콜에 전달만 한다.
   */
  params: unknown;
  /** `$.result` 기준 출력 투영 규칙 (opaque, Q-C). */
  outputs: readonly unknown[];
  /**
   * `true`면 결과 누락이 이 콜을 건너뛰게 하고, `false`(필수)면 결과 누락이
   * SystemFail → fail-closed deny를 만든다 (planning_v2.rs:43-45,
   * policy-rpc.ts:319-322).
   */
  optional: boolean;
}

/**
 * 코어가 판정에 쓰는 정책 묶음. **지금은 좁히지 않는다.** 실제 형태는
 * `{ policy: string; manifest: unknown }[]` (resolve.ts:12-18 `ResolvedBundle`,
 * `action_eval_exports.rs:141-144` `BundleInput`)이지만, `manifest`가 opaque하고
 * 그 스키마(`ManifestV2`)가 다음 작업(private `@dambi/policy-ir`)에서 정해진다.
 * 지금 좁히면 그 작업이 곧 breaking change가 된다.
 */
export type PolicySet = unknown;

/**
 * `call_id → FactResult` 맵. 근거: `EvaluateActionInput.results`
 * (`action_eval_exports.rs:167` — `BTreeMap<String, Value>`).
 */
export type FactMap = Record<string, FactResult>;
