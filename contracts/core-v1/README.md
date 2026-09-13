# Core 정책 wire 계약 — D4-1 SDK 초안

이 디렉터리는 Core에 넘길 정책 원문과 오류 사례를 고정한다. [타입](types.ts)·[JSON Schema](policy-wire.schema.json)는 **SDK 제안**이며 실제 서버와 합의된 API 또는 현재 `@dambi/core` 공개 타입이 아니다. 기존 런타임·정책 판정은 변경하지 않는다.

## 제안한 구조와 서명 바이트

Envelope는 `{ payload: string, sig: { alg, key_id, sig_b64 } }`다. `payload`는 B 방식 JSON 문자열이며, 서명 입력은 **그 문자열의 원래 UTF-8 바이트**다. 파싱한 객체를 재직렬화하거나 JCS로 정규화한 바이트를 사용하지 않는다. 같은 객체라도 공백·키 순서·이스케이프가 바뀌면 다른 서명 입력이다. 객체 형태의 payload는 구조 오류다.

| payload 필드 | SDK 초안 |
| --- | --- |
| `schema_version` | 정수 `1` |
| `policies` | 비어 있지 않은 `{ id, policy, manifest }[]`. 정상 예시는 D3 공유 원본의 Day-1 정책 5개를 사용 |
| `sequence` | 음이 아닌 정수의 십진 문자열. `"0"` 또는 선행 0 없는 숫자열, 같은 `env/profile` 범위에서 수치 비교 |
| `issued_at` | 음이 아닌 Unix 초 정수, JS 안전 정수 범위 |
| `expires_at` | 같은 단위의 정수 또는 `null`. `null`이어도 향후 Core의 최대 경과 시간 검사는 적용 |
| `env`, `profile` | 비어 있지 않은 문자열. 허용 값·운영 범위는 API 합의 대상 |
| `registry_ref` | 필수 `null`. 존재하지 않는 원격 Registry root/ref를 만들지 않음 |

알고리즘 제안은 `ECDSA_P256_SHA256`로 고정한다. `sig_b64`는 IEEE P1363 `r || s` **64바이트**의 패딩 포함 표준 Base64다. 알고리즘·운영 키·교체 정책·시간 허용 오차·최대 경과 시간·sequence 상한은 실제 API와 Core 계약에서 확정해야 한다. fixture의 시각·sequence·시험 키는 운영값이 아니다.

키 역할은 응답에 선언하는 신뢰 근거가 아니라 **호스트가 설정한 로컬 신뢰 목록**의 `policy`/`decoder` 구분이다. `key_id`는 정책용 목록 안에서만 키를 찾는 식별자이며, 미등록 키나 decoder용 키로 정책을 승인하지 않는다. 내장 decoder artifact의 신뢰 경로와 외부 decoder 서명은 별도로 다룬다. 정책 원문 서명, 개별 decoder bundle의 JCS digest, snapshot 전체의 로컬 digest도 각각 구분한다.

## 기존 코드와의 차이

아래는 저장소 소스 대조이며 운영 서버 호출 결과가 아니다.

| 확인한 코드 | 현재 동작과 D4 초안의 차이 |
| --- | --- |
| [Core PolicySource](../../packages/core/src/ports/policy.ts) | `payload: unknown`, `signature`, `keyId?`와 JCS 설명을 사용한다. 이번 `payload: string`·중첩 `sig` 제안은 C1/C3에서 별도로 연결해야 함 |
| [Registry API](../../registry-api/src/server.ts) | decoder index/bundle/context와 detached signature 객체를 제공하는 경로다. 정책 B 문자열 envelope 배포 계약의 근거로 사용하지 않음 |
| [기존 decoder 서명 검증](../../browser-extension/backend/service-worker/adapter-loader/bundle-verify.ts) | bundle JCS 바이트와 build-time 고정 키를 사용하며 응답 `alg/key_id`는 telemetry다. 정책 B 원문·정책용 로컬 키 목록과 구분 |
| [현재 정책 CRUD 클라이언트](../../browser-extension/dashboard/src/server-api/policies.ts) | 서버 정책 CRUD가 확장 로컬 저장소로 이동했다고 명시한다. 새 서명 정책 fetch endpoint의 합의 또는 구현 증거가 아님 |

따라서 endpoint·인증 헤더·envelope 필드명·알고리즘 표기·운영 키와 제한값은 API 담당과 대조할 항목으로 남긴다. 과거 백업 계약이나 확인되지 않은 “API 담당의 7개 필드”를 확정 요구사항으로 사용하지 않는다.

## 검증 경계와 사용자 실행

[구조 helper](helpers/structure.mjs)는 이 Schema에 사용한 키워드만 평가하는 fixture 전용 코드이며 지원하지 않는 Schema 확장은 실패시킨다. envelope 검사 후 B 문자열을 파싱해 payload 구조를 별도로 검사한다. manifest는 `id`·`schema_version: 2` 및 선택 필드의 외형만 검사하며 전체 ManifestV2·trigger·Fact 선언·Cedar 의미 검증은 후속 엔진/Core 작업이다.

[정상 envelope](examples/day1.envelope.json)는 D3 원본을 담은 고정 예시이며 [시험 전용 키](examples/test-only-keys.json)는 공개 개발 자료다. 운영 키나 SDK 기본 신뢰 키로 사용하지 않는다. [사례 생성 코드](fixtures.mjs)는 정상 예시와 오류 입력을 독립적으로 구성한다. 의미·parser 오류 사례는 올바른 정책 키로 서명해 향후 C3가 의도한 오류를 분리해서 검사할 수 있게 한다.

시험 사례는 필수 필드·빈 manifest·타입/버전·비-null Registry ref 등의 구조 오류, 중복 ID·manifest ID 불일치·시간 관계 등의 의미 오류, 원문 변조·잘못된 키 역할 등의 암호 오류를 구분한다. `expected_core_error`는 후속 C3의 기대 사유이며 현재 Core 오류 코드가 아니다. Node crypto 참조 검증은 fixture 서명과 원문 바이트 대응을 확인하며 **Core 서명 검증 구현의 완료를 뜻하지 않는다**. 구조 helper의 `JSON.parse`가 허용하는 중복 JSON 키·숫자/Unicode 처리와 운영 trust 연결·재생 방지·최종 의미 검증·runtime 적용은 C3에서 엄격히 검증한다.

```sh
cd /Users/spu/SDKdambi/DAMBI
npm run contract:test
```

이 명령은 계약 구조와 Node crypto 참조 검증용이며 사용자 실행으로 통과했다. 재현용으로 보존하며 기록 갱신을 위한 재시험·재빌드는 필요 없다.

## D4-2 제품 선택안·D4-3 후속 작업

[선택안](snapshot-selection.proposal.json)은 기존 DEC-07의 11개 source key와 approve/transfer 확장용 USDC 4개를 명시한다. **상태는 `proposed`, 결정은 미확정**이며 런타임 설정이나 승인된 생성 입력이 아니다. 정책 원본 5개와 현재 severity는 유지한다. 권장안의 요청 범위는 다음과 같다.

| 요청 | 선택안 | 검증 한계 |
| --- | --- | --- |
| approve·transfer | 체인 1/10/8453/42161의 선택 USDC 대상 | 다른 ERC-20 대상은 별도 선정. 이 token 목록은 Permit2 내부 token·NFPM pair·Morpho market token의 허용 목록이 아님 |
| USDC Permit | mainnet의 strict v4. 기존 v3는 회귀 자료로 유지 | strict 실패 후 v3 fallback 없음. 입력 일관성 검증이며 사용자 서명·onchain nonce 검증은 아님 |
| Permit2 Single/Batch | 네 체인의 기존 v3 해석 경로, 알려진 한계 명시 | strict 미지원. nonce·malformed fallback·정수 범위·큰 시간 표현 교정은 후속 |
| NFPM | 네 체인 concrete 주소의 multicall·mint·refundETH | pool 상태·가격 placeholder, 실제 EVM 실행 미검증 |
| Morpho | mainnet Bundler3·GA1 FlashLoan/SupplyCollateral | callback 인증·실행 보장 아님. SupplyCollateral live 입력은 skeleton이며 보강은 후속 |
| Day-1 정책 | 5개 원본·Action→판정 사례 유지 | 전체 원문 요청→판정은 미검증. raw approve 연결만 기존 DEC-02 근거 보유 |

스왑 원문 경로·추가 ERC-20 대상/체인·Permit2 strict는 후속으로 둔다. permit 계열 calldata index의 존재만으로 transaction 지원을 승인하지 않는다. D4-3은 산출물 포함 목록과 지원 요청 목록을 구분하고, Core의 경로 제한 연결은 후속 구현에서 확인해야 한다.

Day-1 정책의 외부 Fact는 0개지만 swap·Permit2 시험은 합성 Action 입력부터 시작한다. [DEC-07 인계](../../fixtures/decoder-policy/handoff-index.json)의 `live_inputs_ref: null`도 live 입력 부재를 보장하지 않는다. NFPM mint는 중첩 `live_inputs`를 선언하고 현재 값은 placeholder다. [정책 입력 한계](../../fixtures/sdk/README.md)와 [Decoder coverage](../../fixtures/decoder-policy/coverage.md)를 따른다. 생성 입력 고정·제품용 생성 진입점·정렬/digest·확장/서버/cache 없는 재현 생성은 D4-3에 남는다.

## 결과 기록

2026-09-13, `40a268c` 이후 미커밋 D3 변경에 이어 작성한 `contracts/core-v1/`·루트 `contract:test`·계획서의 D4-1 초안은 **사용자 제공 실행 로그 기준 검증 완료**다. `contract:test` **36/36 통과**, suites·실패·취소·건너뛰기·todo 각 0, `duration_ms=169.940167`을 확인했다. 공통 4개와 fixture 32개(정상 2·구조 오류 20·의미 오류 6·parser 1·암호/키 역할 3)의 구조·참조 서명 검사 결과이며 실제 API 합의나 C3 Core 검증 완료를 뜻하지 않는다. 기존 MJS 구문·코드·Schema 정적 검토 기록을 유지한다. 이번 기록 갱신에서 빌드·시험·설치·커밋·푸시는 실행하지 않았다. 남은 항목은 실제 API 계약 합의, D4-2 제품 범위 결정, D4-3 재현 생성과 C3 Core 검증 구현이다.

D4-2는 원본·인계 목록·coverage와 대조한 제품 선택안을 작성했으며 사용자 범위 결정 대기다. 이 단계에서는 JSON 선택안과 문서만 추가·수정했고 실행 시험은 추가하거나 재실행하지 않았다. 제품 범위 확정 및 D4-3 재현 생성 완료로 표시하지 않는다.
