/**
 * `FactProvider` 포트 + 그 결과 타입 `FactResult`.
 *
 * R7: 포트는 코어가 **물어보는** 협력자다. 코어는 fact를 저장하지 않는다.
 */

import type { PlannedCall } from "../types/plan";

/**
 * 하나의 fact 조회 결과.
 *
 * **`FactProvider` 구현자(통합사)가 만들어 반환하는 타입**이므로, 나중에 필드를
 * 추가하면 모든 통합사 구현이 깨진다 → provenance 세 필드를 지금 넣는다 (R2).
 * 현재 확장 코드에는 provenance가 없다: WASM 경계의 `results`는
 * `Record<string, unknown>`(wasm-bridge.types.ts:140, `EvaluateActionInput`의
 * `results: BTreeMap<String, Value>`)로, unwrapped `$.result` payload만 담는다.
 */
export interface FactResult {
  /** 투영 후 값 (opaque). */
  value: unknown;

  /**
   * R2. 어느 provider / 엔드포인트에서 왔는지 (자유 문자열). 예:
   * `"policy-server:/evaluate"`, `"onchain:eip155:1:multicall3"`.
   */
  source: string;

  /**
   * R2. 결정론적 재현의 기준점. 십진 문자열(bigint 안전; 파이프라인 전역이
   * amount/leverage를 decimal string으로 나른다 — dto.rs:207-224). on-chain이
   * 아닌 fact(오라클 REST 등)에는 없을 수 있어 optional.
   */
  blockNumber?: string;

  /**
   * R2. 관측 시각 (Unix **milliseconds**). 캐시 히트 판별용. {@link
   * ../ports/clock#Clock}의 단위와 일치한다.
   */
  observedAt: number;
}

/**
 * 계획된 콜들을 실행해 `call_id → FactResult` 맵을 돌려주는 포트.
 *
 * 실패는 reject로 알린다 → 코어가 fail-closed 처리(필수 콜 누락 = SystemFail
 * → deny). 근거: `policy-rpc.ts:324-441` `dispatchCallsV2` — 실패한 콜을 결과
 * 맵에서 omit하며, omit된 필수 콜이 WASM에서 `__system__` deny를 만든다.
 */
export interface FactProvider {
  fetch(calls: readonly PlannedCall[]): Promise<Record<string, FactResult>>;
}
