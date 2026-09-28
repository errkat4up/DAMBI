# Core 정책 wire 계약 — C1-1 API 정합화

이 디렉터리는 Core에 넘길 정책 원문과 오류 사례를 고정한다. [타입](types.ts)·[JSON Schema](policy-wire.schema.json)는 `3f0ad6b`의 [Registry API 계약](../../registry-api/openapi.yaml)과 [정책 발행기](../../registryV2/scripts/publish-policy-bundle.ts)에 맞춘 내부 wire 계약이다. **C1 공개 계약·소비자 검증 완료**다. 실제 Core 실행부는 후속 단계다.

## API 구조와 서명 바이트

HTTP envelope는 `{ payload: string, signature: string, key_id?: string }`다. 발행기는 JCS로 만든 JSON 문자열을 `payload`에 넣고 **그 문자열의 UTF-8 바이트**에 서명한다. 수신 측은 B 원문을 그대로 검증하며 재직렬화하거나 다시 JCS로 정규화하지 않는다. 같은 객체라도 공백·키 순서·이스케이프가 바뀌면 다른 서명 입력이다. 객체 형태의 payload와 과거 `sig` 중첩 wrapper는 현재 구조가 아니다.

| payload 필드 | 현재 API 기준 |
| --- | --- |
| `policies` | 비어 있지 않은 `{ id, policy, manifest }[]`. 정상 예시는 D3 공유 원본의 Day-1 정책 5개를 사용 |
| `sequence` | JSON 정수 `1..9007199254740991`. 문자열·0·소수·상한 초과를 거절하며 같은 env/profile 범위에서 수치 비교 |
| `issued_at` | 음이 아닌 Unix 초 정수, JS 안전 정수 범위 |
| `expires_at` | 필수 정수 또는 `null`. 현재 발행기는 null. 숫자일 때 issued_at 이후인지와 실제 만료 여부는 C3에서 검사 |
| `env` | `staging` 또는 `production`. 로컬 기대 환경과의 일치는 C3 의미 검증 |
| `profile` | v0.1은 `default`. 구조상 문자열이더라도 지원 범위·기대 profile 검사는 C3가 담당 |
| `registry_ref` | v0.1은 필수 `null`. 문자열은 구조상 수용하고 C3의 `UNSUPPORTED_REGISTRY_REF`로 분리하여 거절 |

일곱 필드는 모두 필수다. payload 최상위 `schema_version`은 없으며 **manifest의 `schema_version: 2`는 유지**한다. 타입 이름의 `WireV1`은 지원 계약을 식별하는 내부 이름이며 wire에 version 필드를 추가하지 않는다.

서명은 ECDSA P-256/SHA-256, IEEE P1363 `r || s` **64바이트**, 패딩 포함 표준 Base64다. 알고리즘은 로컬에서 고정하며 응답 `alg`로 선택하지 않는다. `key_id`는 선택적 telemetry다. 누락·빈 값·알 수 없는 값·decoder 키 이름이어도 올바른 policy 키의 서명을 무효화하거나 다른 검증 키를 선택하지 않는다. 반대로 decoder 키로 서명한 뒤 policy 키 ID를 붙여도 정책용 신뢰를 얻지 못한다.

정책 최대 나이는 [ADR](../../docs/decisions/0001-cloud-split.md)의 v0.1 시작값 **72시간(259200초)**이다. `expires_at: null`도 이 제한을 우회하지 않는다. 이 디렉터리는 고정 시계의 의미 검증용 입력을 준비하며 실제 만료·재생 방지 판정은 C3/C4에서 구현한다. fixture의 시간·sequence·시험 키는 운영값이 아니다.

## 연결 범위

| 경계 | 현재 상태 |
| --- | --- |
| [Registry API](../../registry-api/src/server.ts) | `GET /v1/bundle` 구현·OpenAPI·publisher를 wire 근거로 사용. 운영 서버 호출·통합 검증은 이번 범위 밖 |
| [Core PolicySource](../../packages/core/src/ports/policy.ts) | `payload: string`, `signature`, `keyId?` 공개 계약 반영. A1은 HTTP key_id를 SDK keyId로 매핑할 수 있으나 B 내부는 변경하지 않음. 실행부는 scaffold |
| 정책 발행기 | 현재 기본 경로가 D3 이전의 확장 폴더를 가리키는 문제는 API 담당 후속 작업. 이번에 발행기를 수정하거나 실행하지 않음 |
| Decoder | 별도 역할 키·JCS 서명 경로 유지. 이 계약 정합화로 Decoder 지원 범위나 정책 severity를 변경하지 않음 |

운영 키·교체 정책·clock skew·크기 한도는 구현된 wire 형식과 구분한다. 신뢰는 로컬 policy/decoder 역할 설정에만 두고, 이 디렉터리의 공개 시험 키를 SDK 기본값으로 사용하지 않는다.

## 검증 경계와 사용자 실행

[구조 helper](helpers/structure.mjs)는 이 Schema에 사용한 키워드만 평가하는 fixture 전용 코드이며 지원하지 않는 Schema 확장은 실패시킨다. SDK가 지원하는 v0.1 필드 밖의 envelope·payload·policy·manifest 필드는 엄격하게 거절한다. 이는 일반 OpenAPI 검증기가 아니며 API의 추가 필드 전체를 지원한다는 뜻도 아니다. manifest는 `id`·`schema_version: 2` 및 선택 필드의 외형만 검사하고 전체 ManifestV2·trigger·Fact·Cedar 의미는 후속 Core가 검증한다.

[정상 envelope](examples/day1.envelope.json)는 D3 원본의 내용·순서를 보존하고 publisher와 같은 JCS 형식으로 작성한 고정 예시다. [시험 전용 키](examples/test-only-keys.json)로 새 B를 서명했다. [사례 생성 코드](fixtures.mjs)는 정상/구조/의미/parser/암호 사례를 구성한다. 의미·parser 오류는 올바르게 재서명해 C3가 의도한 오류에 도달하게 한다. 서명에 사용한 키 역할은 fixture 자체 메타데이터로 추적하며 응답 key_id로 선택하지 않는다.

시험은 실제 wrapper·필수 필드·sequence 경계·env enum·원문 변조·키 ID와 신뢰 분리를 검사한다. 중복 ID·manifest ID 불일치·시간·scope·rollback·non-null Registry ref는 구조/참조 서명이 통과해야 하는 **C3 의미 검증 인계 사례**다. `expected_core_error`는 후속 기대 사유이며 지금 Core가 그 오류를 검출한다는 뜻이 아니다. fixture helper의 JSON.parse는 중복 키 등을 허용하므로 C3 보안 경계가 아니다. **이 명령의 통과는 Core parser·암호 구현·정책 판정 또는 운영 API 통합 완료를 뜻하지 않는다.**

```sh
cd /Users/spu/SDKdambi/DAMBI
npm run contract:test
```

위 시험은 사용자 검증을 마쳤다. 관련 fixture 변경이 없으면 반복하지 않는다. Node 내장 모듈만 사용하며 Registry 설치·WASM 빌드·정책 재발행은 필요 없다. wire `types.ts`는 C1-3의 `core:test:types`에 함께 포함했다. 공개 SDK의 빌드·소비자 검증 순서는 [패키지 README](../../packages/core/README.md#development-checks)를 따른다.

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

2026-09-28 C1 완료: `feat/core@3f0ad6b` 이후 정책 wire·fixture, 공개 SDK 타입·async scaffold, 소비자 검사·CI·workspace를 반영했다. 사용자 제공 로그: **계약 43 통과·0 실패, scaffold 2 통과·0 실패**. 실행 검증은 사용자가 수행했으며 정적 검토도 완료했다. 남은 작업은 Core Rust/WASM 실행부(C2~C6), API publisher 경로 수정, D4-2/3 제품 범위·재현 생성이다.

아래는 변경 전 D4-1 초안의 과거 실행 기록이며 현재 C1-1 계약의 통과 기록이 아니다.

2026-09-13, `40a268c` 이후 미커밋 D3 변경에 이어 작성한 `contracts/core-v1/`·루트 `contract:test`·계획서의 D4-1 초안은 **사용자 제공 실행 로그 기준 검증 완료**다. `contract:test` **36/36 통과**, suites·실패·취소·건너뛰기·todo 각 0, `duration_ms=169.940167`을 확인했다. 공통 4개와 fixture 32개(정상 2·구조 오류 20·의미 오류 6·parser 1·암호/키 역할 3)의 구조·참조 서명 검사 결과이며 실제 API 합의나 C3 Core 검증 완료를 뜻하지 않는다. 기존 MJS 구문·코드·Schema 정적 검토 기록을 유지한다. 이번 기록 갱신에서 빌드·시험·설치·커밋·푸시는 실행하지 않았다. 남은 항목은 실제 API 계약 합의, D4-2 제품 범위 결정, D4-3 재현 생성과 C3 Core 검증 구현이다.

D4-2는 원본·인계 목록·coverage와 대조한 제품 선택안을 작성했으며 사용자 범위 결정 대기다. 이 단계에서는 JSON 선택안과 문서만 추가·수정했고 실행 시험은 추가하거나 재실행하지 않았다. 제품 범위 확정 및 D4-3 재현 생성 완료로 표시하지 않는다.
