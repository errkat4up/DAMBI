/**
 * `Clock` 포트 — 주입 가능한 시계 (R6).
 *
 * 골든 픽스처의 결정론을 위해 필요하다: `fixtures/baseline-verdicts.test.ts`가
 * `submitted_at`을 `1738000000`으로 고정하고(phase0-report.md:110-113),
 * `hl-order-to-action.ts:282-302`가 `submitted_at`을 wall-clock에서 파생한다.
 */

/**
 * 주입 가능한 시계. `CoreConfig.ports.clock`이 생략되면 코어는 `Date.now` 기반
 * 기본 구현을 쓴다.
 */
export interface Clock {
  /**
   * Unix epoch **milliseconds** (Q-A). `Date.now()`와 같은 단위 — JS 관용
   * (`Date.now`, `FactResult.observedAt`, `diagnostics.ts:45,98`)에 맞춘다.
   * 파이프라인의 `submitted_at`은 초 단위지만(hl-order-to-action.ts:288 "÷1000"),
   * 그 변환은 코어 내부 책임이다.
   */
  now(): number;
}
