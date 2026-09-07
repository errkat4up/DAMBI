/**
 * 코어의 진입 계약: `CoreConfig` / `Ports` / `CoreHooks` / `DambiCore` /
 * `createCore` 시그니처.
 *
 * 판정 로직 구현은 없다 — 기존 로직(`orchestrator.ts` 등)을 옮겨오는 다음
 * 작업의 몫이고, 여기서 새로 쓰면 두 벌이 생겨 어느 쪽이 진짜인지 알 수 없게
 * 된다.
 *
 * **"런타임 코드 0줄" 규칙의 유일한 예외: `createCore`는 던지는 스텁으로 둔다.**
 * `export declare function`으로 두면 tsc emit 경로에서는 런타임 `SyntaxError`,
 * esbuild/tsup 경로에서는 **에러 없이 빈 번들**(ESM 0 B, `createCore = undefined`)을
 * 만든다 — 빌드가 초록불인데 패키지가 비어 있어 아무도 모른다 (B단계 재검증에서
 * 확인). 발행 대상 패키지의 공개 함수는 스텁이라도 본문이 있어야 한다. 본문은
 * 즉시 throw 한 줄뿐이며 판정 로직이 아니다.
 */

import type { CheckRequest, UnsupportedRequest } from "./types/request";
import type { Verdict } from "./types/verdict";
import type { PlannedCall, PolicySet, FactMap } from "./types/plan";
import type { PolicySource } from "./ports/policy";
import type { FactProvider } from "./ports/fact";
import type { DecoderSource } from "./ports/decoder";
import type { Clock } from "./ports/clock";

/**
 * R7. 포트 = 코어가 **물어보는** 곳. 코어는 아무것도 저장하지 않는다 — 저장은
 * 호스트가 {@link CoreHooks}에서 한다.
 */
export interface Ports {
  policy: PolicySource;
  fact: FactProvider;
  decoder: DecoderSource;
  /** R6. 생략 시 코어가 `Date.now` 기반 기본 구현을 쓴다. */
  clock?: Clock;
}

/**
 * R7. 훅 = 코어가 **알려주는** 곳. 저장은 호스트가 여기서 한다.
 *
 * 근거: `orchestrator.ts:110-137` `onRiskyVerdict`(fire-and-forget, 결정 흐름을
 * 건드리지 않음), `:207` `onAwaitingUser`. 확장은 badge / notify / storage를 이
 * 자리에서 한다 (phase0-report.md:26-31의 host 파일들).
 */
export interface CoreHooks {
  /**
   * 판정을 시작한 요청을 호스트에 알린다. 파라미터는 `check()`와 같은
   * `CheckRequest | UnsupportedRequest`다 — 미지원 `kind`도 코어가 warn 판정으로
   * 처리하므로(R1) 그에 대한 `onVerdict`가 발생하는데, `onPending`이 알려진
   * kind만 받으면 호스트 감사 로그에 "warn 판정은 있으나 대상이 없는" 구멍이
   * 생긴다. 두 훅은 대칭이어야 로그가 완결된다. (확장은 비-wallet-action을
   * `decideMessage` 진입 전에 걸러 이 문제가 없었다 — index.ts:224-226.)
   */
  onPending?(req: CheckRequest | UnsupportedRequest): void | Promise<void>;
  onVerdict?(verdict: Verdict): void | Promise<void>;
  onAwaitingUser?(): void;
  /** 진단 이벤트. 형태는 아직 정하지 않는다 (opaque). */
  onDiagnostic?(event: unknown): void;
}

/**
 * `createCore`에 넘기는 설정 객체 (Q-D).
 *
 * 위치 인자도, `Ports` 필드도 아닌 이유:
 *  - `Ports`는 R7 정의상 "코어가 물어보는 협력자"인데 `enforcement`는 협력자가
 *    아니라 **배포 형태에 대한 정적 선언**이다. `Ports`에 넣으면 그 의미가
 *    흐려진다.
 *  - 위치 인자(`createCore(ports, hooks?, options?)`)는 옵션이 늘 때마다 시그니처
 *    가 또 는다.
 *
 * `enforcement`가 **필수(optional 아님)**인 것이 핵심이다 — 기본값을 주면
 * 통합사가 모른 채 한쪽(advisory)을 쓰게 되는데, R3이 막으려는 게 정확히 그
 * 상황이다. 타입이 강제로 물어보게 만든다.
 */
export interface CoreConfig {
  ports: Ports;
  hooks?: CoreHooks;
  /**
   * R3. 프록시(자문) 배포면 `"advisory"`, 지갑 통합(집행) 배포면 `"enforcing"`.
   * 코어는 이 값을 모든 {@link Verdict}의 `enforcement`에 그대로 싣는다.
   */
  enforcement: "advisory" | "enforcing";
}

/**
 * 코어 인스턴스. 판정은 3단계 = plan + fact 조회 + evaluate이며, 한 방에 도는
 * {@link DambiCore.check}와 단계별 진입점을 모두 노출한다.
 */
export interface DambiCore {
  /**
   * 한 방에: 계획 → fact 조회(포트) → 평가. 미지원 `kind`({@link
   * UnsupportedRequest})를 받으면 throw하지 않고 warn 판정을 돌려준다 (R1).
   */
  check(req: CheckRequest | UnsupportedRequest): Promise<Verdict>;
  /** 이 요청에 필요한 계획된 콜만. 호스트가 직접 dispatch하고 싶을 때. */
  plan(req: CheckRequest, policies: PolicySet): Promise<readonly PlannedCall[]>;
  /** 이미 모은 fact로 동기 평가. */
  evaluate(req: CheckRequest, policies: PolicySet, facts: FactMap): Verdict;
}

/**
 * 0.0.1은 타입 골격만 있는 스캐폴드다. 판정 구현은 다음(추출) 작업에서 들어온다.
 * 그때까지 호출하면 아래 메시지로 즉시 throw한다 — 빈 번들이 조용히 나가지
 * 않도록 (파일 상단 주석 참조). 이 본문은 "런타임 코드 0줄" 규칙의 명시적
 * 예외이며 판정 로직이 아니다.
 */
const NOT_IMPLEMENTED =
  "@dambi/core 0.0.1 is a scaffold — implementation lands in the extraction step.";

export function createCore(_config: CoreConfig): DambiCore {
  throw new Error(NOT_IMPLEMENTED);
}
