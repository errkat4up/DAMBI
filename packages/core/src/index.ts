/**
 * `@dambi/core` 공개 표면. **여기서 export하는 것만 공개다** (R8). 확신이 없는
 * 타입은 여기 두지 않는다 — 한 번 공개하면 되돌리는 게 breaking change다.
 *
 * 대시보드 전용 표면은 `./internal`에 따로 둔다 (지금은 비어 있음).
 */

export type { CheckRequest, UnsupportedRequest } from "./types/request";
export type { Verdict, MatchedPolicy } from "./types/verdict";
export type { PlannedCall, PolicySet, FactMap } from "./types/plan";

export type { Ports, CoreHooks, CoreConfig, DambiCore } from "./core";
export { createCore } from "./core";

export type {
  PolicySource,
  SignedPolicyBundle,
  FactProvider,
  FactResult,
  DecoderSource,
  Clock,
} from "./ports/index";
