/**
 * `CheckRequest` — 통합사(외부 지갑사)가 코어에 "이 액션을 서명 직전에 판정해
 * 달라"고 넘기는 요청. 이 파일의 타입은 통합사와의 계약이므로, 한 번 발행하면
 * 필드를 바꾸는 게 breaking change다.
 *
 * 확장 내부 wire 페이로드(`browser-extension/backend/lib/types.ts`)를 그대로
 * 베끼지 않았다. 확장 wire는 `RequestType` enum + `hostname` / `bypassed` 같은
 * 확장 전송 계층 필드를 싣지만, 코어 계약은 "통합사가 자연스럽게 줄 수 있는
 * 최소 입력"만 받는다. 필드 매핑 근거는 각 variant 주석에 있다.
 */

/**
 * 판정 요청. **닫힌 판별 유니온(discriminated union)** — 알려진 네 variant만
 * 담는다. 알려진 variant는 `browser-extension/backend/lib/types.ts:3-13`의
 * `RequestType` 중 판정 대상인 `WALLET_ACTION_TYPES`(transaction / typed-sig /
 * untyped-sig / venue-order)에 대응한다. `execution-report`는 판정 요청이 아니라
 * 사후 보고이므로 제외했다 (`index.ts:216-219` — verdict 파이프라인 진입 전에
 * return).
 *
 * **R1(open union)은 타입이 아니라 함수 파라미터 위치에서 표현한다.** A단계
 * 초안은 `| { kind: string }`을 유니온에 넣었으나, 그러면 판별 유니온 narrowing이
 * 깨진다 — `{ ...; chainId: string } | { kind: string }`에서 `req.chainId`는
 * `if`/`switch`로도 좁혀지지 않고 `TS2339`가 난다 (B단계 재검증에서 실제 파일로
 * 재현). 대신 {@link UnsupportedRequest}를 별도로 두고, 그걸 받는 것은
 * `createCore(...).check(req: CheckRequest | UnsupportedRequest)`의 파라미터
 * 유니온이다. 미지원 `kind`는 throw가 아니라 warn 판정으로 떨어진다 (R1) —
 * ERC-4337 / EIP-7702 / EIP-5792가 나중에 additive로 들어오고, 지금 그것들을
 * 구현할 필요가 없다.
 *
 * `chainId`는 CAIP-2 문자열(`"eip155:1"`). 확장 내부 페이로드는
 * `chainId: number`(types.ts:17,30,154)를 쓰지만, 판정 파이프라인 경계
 * (`TxInput` — `action_eval_exports.rs:76-82`, `wasm-bridge.types.ts:31-41`,
 * `policy-rpc.ts:22`)는 CAIP-2 string이다. 코어는 파이프라인 경계와 같은 표현을
 * 쓴다.
 */
export type CheckRequest =
  | {
      kind: "transaction";
      /** CAIP-2 (`"eip155:1"`). */
      chainId: string;
      /**
       * 서명자 주소. 지갑 통합 경로에서는 항상 알 수 있어 필수로 둔다.
       * 확장 프록시 경로는 `TransactionPayload.transaction.from`이 optional이라
       * (types.ts:21) dApp이 생략하면 확장 어댑터가 채우지 못한다 — B단계 보고
       * "CheckRequest.from 확인" 항목 참조.
       */
      from: string;
      to?: string;
      /** `"0x"`-prefixed calldata. */
      data?: string;
      /** `msg.value`, 십진 문자열. */
      value?: string;
    }
  | {
      kind: "typed_signature";
      /** CAIP-2. */
      chainId: string;
      /** 서명자 주소. `TypedSignaturePayload.address`(types.ts:33)에 대응. */
      from: string;
      /**
       * EIP-712 payload. 코어는 디코더 포트가 결과를 낼 때까지 opaque하게
       * 나른다 (`wasm-bridge.ts` 타입드데이터 라우트도 `message: unknown`).
       */
      typedData: unknown;
    }
  | {
      kind: "untyped_signature";
      /**
       * 서명자 주소 — optional (Q-B). 확장 `UntypedSignaturePayload`는 `chainId`
       * 도 `from`도 싣지 않는다 (types.ts:37-42) — `personal_sign`은 off-chain이고
       * 계정이 불명일 수 있다. 지갑 통합 경로가 알면 채워 보낸다.
       */
      from?: string;
      /** `personal_sign` 원문 메시지. */
      message: string;
    }
  | {
      kind: "venue_order";
      /**
       * 정산/베뉴 체인 힌트 — optional. 순수 off-chain 베뉴(Hyperliquid)는
       * CAIP-2로 표현할 수 없는 `chainId: 0`을 쓴다 (types.ts:153). 코어 계약은
       * 그 경우를 "체인 없음"(생략)으로 표현한다.
       */
      chainId?: string;
      /**
       * 서명 주체. `VenueOrderPayload`에는 이 필드가 없고 호스트가
       * `master ?? fallbackSubmitter`로 합성한다 (orchestrator.ts:925) — B단계
       * 보고 "CheckRequest.from 확인" 항목 참조.
       */
      from: string;
      /**
       * 파싱된 베뉴 액션 (`VenueActionWire` 상당). 코어는 opaque하게 나른다.
       */
      order: unknown;
    };

/**
 * 미지원/미래 `kind`. `createCore(...).check()`와 `CoreHooks.onPending`이
 * `CheckRequest | UnsupportedRequest`로 이걸 받으며, 코어는 warn 판정으로
 * 떨어뜨린다 (R1). {@link CheckRequest}의 유니온에 `| { kind: string }`으로
 * 섞으면 판별 narrowing이 깨지므로(위 주석 참조) 별도 타입으로 둔다.
 */
export interface UnsupportedRequest {
  kind: string;
}
