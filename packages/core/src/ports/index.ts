/**
 * 포트 배럴. 코어가 물어보는 협력자 인터페이스 모음 (R7).
 * `core.ts`의 `CoreConfig.ports`가 이걸 요구한다.
 */

export type { PolicySource, SignedPolicyBundle } from "./policy";
export type { FactProvider, FactResult } from "./fact";
export type { DecoderSource } from "./decoder";
export type { Clock } from "./clock";
