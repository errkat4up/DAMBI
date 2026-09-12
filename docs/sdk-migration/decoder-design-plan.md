# Dambi Decoder 상세 설계·구현 계획

**2026-09-12 DEC-05 최신 상태:** DEC-05a Permit2 Single은 **구현 완료, 사용자 실행 대기**다. 실제 원본의 v3 연결 fixture·시험, 명시적 builder 선택, 개별/통합 script와 문서를 작성했다. Rust·worker·기존 273개 기대값을 유지하고 검증된 DEC-04 JS/WASM을 재사용한다. DEC-05b Batch는 **미착수**이며 Single 실행 결과를 확인한 뒤 진행한다. 사용자는 교정안 구체화 후 **A — 연결 시험·교정 설계만 마무리**를 선택했다. nonce 모델·malformed fallback·uint160/uint48 폭·큰 시간 표현·v4 교정은 별도 범위의 미결 문제로 남긴다. v4는 여전히 USDC EIP-2612만 지원하며 Permit2 v3 성공을 full EIP-712 검증으로 표시하지 않는다. 상세 원본 대응·범위는 [DEC-05](#dec-05--permit2-single--batch--전체-계획-d2), 사용자 실행 명령은 [README](../../fixtures/decoder-policy/README.md#dec-05a-사용자가-직접-실행할-검증-명령)를 따른다.

이하 DEC-01~04의 “현재/이번”과 DEC-05 미진행 문구는 각 과거 기록의 시점이다. DEC-04 로그·273개 통과 기록·미제공 항목은 보존하고 새 실행 결과로 소급 대체하지 않는다. 이번에도 파일 읽기·수정·정적 검토만 허용하며 빌드·시험·설치·Git 변경 명령은 실행하지 않는다.

작성일: 2026-09-11 · 작업 브랜치: `feat/decoder`

설계의 코드 기준 및 DEC-01 사용자 보고 빌드 대상 HEAD: `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`. DEC-02 시작 시 실제 Git 상태는 `feat/decoder`, HEAD `3066f0c` (`test(decoder): verify real approve decoding baseline`), 작업 트리 깨끗함이다. DEC-01 구현과 **Rust 소스 직접 빌드 후 연결 시험 30개 통과를 사용자 실행 보고 기준으로 확인**한 기존 기록은 유지한다. 최초 시험과 재빌드 후 시험은 별도 기록이다. DEC-02 구현은 `26df736`에 커밋됐고, **사용자 실행 보고 기준으로 통합 37개 통과·검증 완료**다. DEC-01 회귀 30개와 DEC-02 정책 7개가 통과했으며 실패·취소·건너뛰기·todo는 모두 0이다. 에이전트는 빌드·시험을 직접 실행하지 않았다.

DEC-03 착수 시 실제 상태는 `feat/decoder`, HEAD `26df736b4d8f0073cfefccf70f68d3b243b016b5`이며 README·두 계획서에 남은 DEC-02 검증 완료 미커밋 변경 3개를 보존했다. **DEC-03은 사용자 실행 보고 기준 검증 완료**다. `npm run decoder:test:transfer`는 요청 18개와 구조 검사 3개, 합계 21개가 통과했고 `npm run decoder:test`는 기존 37개와 신규 21개, 합계 58개가 통과했다. 두 실행 모두 실패·취소·건너뛰기·todo는 0이다. 착수 HEAD는 실행 시점 HEAD의 증거로 사용하지 않는다.

DEC-04 착수 시 실제 상태는 `feat/decoder`, HEAD `b10271365ce06a944b5672d833545db42b243881`(DEC-03 커밋), 작업 트리 깨끗함이었다. 이는 착수 시점 조회이며, 04b 실행 HEAD는 아래 별도 로그로 확인했다. **04a 사용자 실행 47/47·당시 통합 105/105 통과를 네 문서에 반영했고, 네 계약 답변에 따라 04b v4 DTO·validator·export·Rust/Node 회귀를 작성했다. 04b 사용자 실행 로그·hash를 확인했으며 DEC-04 전체 검증 완료**다.

이번 DEC-04 작업에는 사용자 실행 제한이 아래 일반 진행 지침보다 우선한다. 코드·시험·문서 작성과 정적 검토까지만 수행하며 빌드·시험·의존성 설치와 Git add·commit·push·merge·reset·브랜치 변경은 실행하지 않는다. DEC 시험은 내부에서 Registry를 빌드하므로 직접 실행하지 않는다. 사용자용 준비·실행·커밋 명령과 결과 기록은 [README](../../fixtures/decoder-policy/README.md), 사례와 한계는 [coverage](../../fixtures/decoder-policy/coverage.md)를 따른다. 04a 사용자 실행 결과와 네 계약 답변을 반영하고 04b 실행부·회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. DEC-05로 자동 진행하지 않는다.

[전체 개발 계획](/Users/spu/SDKdambi/DAMBI/docs/sdk-migration/decoder-core-adapters-plan.md)의 D1·D2와 Decoder 산출물 인계 부분을 상세화한다. 단계 이름은 혼동을 피하기 위해 `DEC-*`를 사용한다. SDK 소스·빌드 독립화의 실제 이관 단계와 최종 완료 조건은 전체 계획 §2.1·§5·§7.1에 명시하며, 아래 §2.1에서 Decoder 작업과의 연결을 정리한다.

## 1. 목표와 확정된 결정

Decoder의 목표는 요청을 등록된 해석 규칙으로 읽어 기존 `Action` 구조와 해석 상태를 만드는 것이다. 정책 평가에 필요한 token·spender·recipient·amount·서명 범위·하위 호출을 빠뜨리거나 바꾸지 않아야 한다.

| 항목 | 결정 |
| --- | --- |
| 구현 순서 | approve → transfer → typed permit → multicall. 각각 작은 변경으로 진행 |
| 첫 작업 | 실제 approve manifest를 빌드해 원문 calldata부터 Action까지 검증 |
| ABI 뒤 추가 바이트 | **허용 유지.** 사용자 선택. 필수 인자 부족·해석 불가능과 구분해 시험 |
| multicall 탐색 한도 초과 | **해석한 호출을 보존하고 남은 구간은 Unknown + 한도 초과 사유로 표시.** 사용자 선택 |
| venue order·untyped signature | 별도 지원 결정 항목. 이번 단계에서 삭제하거나 지원 완료로 표시하지 않음 |
| 주소·체인 검사 | 입력 형식 및 해당 decoder의 매칭 범위만 검사. 미등록을 악성/위험으로 판정하지 않음 |
| 진행 단위 | 소단계 하나의 구현·시험·결과 보고 후 종료. 다음 단계를 한꺼번에 구현하지 않음 |
| 최종 SDK 독립성 | 패키지뿐 아니라 소스·시험·빌드·CI에서 기존 익스텐션/서버 경로 의존 제거. SDK 소스만으로 재빌드하는 검증을 필수로 수행 |

이 문서의 typed permit 세부 순서는 EIP-2612 → Permit2 Single → Permit2 Batch로 잡는다. witness 기반 주문과 프로토콜별 permit 변형은 coverage에 별도로 남긴다. 세 항목의 통과를 모든 typed signature 지원으로 표현하지 않는다.

## 2. 작업 경계

**이번에 다룬다:** Registry source manifest, 필요한 token fixture, 주소 확장·index 생성, ABI 해석, typed message 해석, emit → Action, multicall 전개, 디코더 오류와 부분 해석, 재현 가능한 시험·산출물 목록.

다음 항목은 기존 전체 계획에서 진행한다.

| 후속 책임 | 이 문서와의 접점 |
| --- | --- |
| Core의 `createCore/plan/evaluate/check` 구현 | 여기서 확인한 Action·오류·coverage를 입력 계약으로 전달 |
| 전역 Registry 상태의 인스턴스별 분리·Rust crate 추출 | 전체 계획 C2a. Decoder 시험을 회귀 기준으로 재사용 |
| 공통 Rust 타입/계산·schema 위치 및 workspace 분리 | 전체 계획 C2-0a·C2-0b·C2-0c. 서버 아래 공통 crate를 SDK 소유 경로로 이동 |
| 정책/Decoder 서명 검증, 키, 정책 Store, Fact Cache | Core 단계. Decoder 시험용 digest 확인은 서명 검증 완료가 아님 |
| API·RPC·인증·네트워크 어댑터 | 어댑터 단계. 이 시험의 필수 경로에 네트워크를 넣지 않음 |
| 정책 원본 이동·Cedar 규칙 및 severity 변경 | 전체 계획 D3. 여기서는 기존 정책 하나를 소비자 시험으로 재사용 |
| SDK snapshot 제품 범위·npm/Cargo 패키징 | 전체 계획 D4 및 패키징 단계. 시험용 소규모 Registry와 제품 지원 범위를 구분 |
| SDK 시험·빌드 경로 전환과 소스 독립성 검증 | 전체 계획 C2c·C5 및 §7.1. 이번 Decoder 기준 시험의 기존 경로 참조를 이관 후 제거 |

**기존 경로 사용은 이관 전 기준 시험에만 허용하는 임시 상태다.** DEC 단계에서는 기존 코드가 원래 동작하는지 확인하기 위해 기존 위치의 정책·타입·WASM 실행부를 사용할 수 있다. 이 시험은 Node + 실제 WASM으로 실행하며 새 `chrome.*`·DOM·확장 스토리지 의존을 추가하지 않는다.

**최종 SDK에는 이 임시 소스·빌드 의존도 남기지 않는다.** 필요한 코드와 데이터를 SDK 소유 위치로 이관하고, SDK 소스 복사본에 `browser-extension/`, `crates/policy-server/`, 기존 `crates/policy-engine-wasm/`이 없는 상태에서 빌드·시험·패키징을 통과해야 한다. 기존 파일을 참조한 Decoder 시험의 성공만으로 SDK 독립화를 완료했다고 표시하지 않는다.

### 2.1 임시 참조를 제거하는 시점과 완료 조건

| Decoder에서 현재 참고하는 것 | 이후 SDK 소유 위치·전환 단계 | 확인할 내용 |
| --- | --- | --- |
| 확장 경로의 Day-1 정책·baseline 정책 파일 | `policy-bundles/day1-safety/` 및 공유 fixture — D3 | 정책 fixture 생성·읽기가 확장 public/dashboard에 의존하지 않음 |
| 서버 아래 상태·Action·순수 transition crate | `crates/asset-model/{state,action,transition}/` — C2-0a | crate 이름·직렬화·기존 계산 의미를 유지하며 Cargo 의존 경로 수정 |
| SDK/서버가 섞인 Cargo workspace | SDK 소유 root workspace와 별도 API workspace — C2-0b | 서버 폴더가 없어도 SDK manifest/lockfile 해석 가능. `cargo -p`만으로 해결됐다고 하지 않음 |
| crate 밖 Cedar schema | `crates/policy-engine/schema/policy-schema/` — C2-0c | Rust 소스 패키지 내부에 원본 포함, include 경로 및 목록 시험 갱신 |
| 기존 Rust/WASM 시험의 seed·fixture·출력 | `fixtures/sdk/`, 각 crate의 `tests/fixtures/`, 임시 출력 — C2c | SDK 필수 사례를 유지하고 과거 폴더 읽기·생성 제거 |
| selector/typed 입력의 순수 함수 | `packages/core/src/internal/`의 해당 모듈 — C1·C5 | 기존 정규화 의미와 시험을 재사용하고 확장 모듈 전체 import 제거 |
| 기존 WASM export와 `pkg` 경로 | `crates/dambi-core/`, `crates/dambi-core-wasm/` 및 SDK WASM/glue — C2a·C2b·C5 | 동일 요청의 Action·진단 회귀 확인 후 시험 runner와 build 입력을 전환 |
| 기존 WASM artifact를 재사용하는 초기 CI | SDK 전용 소스 빌드·시험 job — C5 및 전체 계획 §7.1 | 기존 artifact·확장/server job 없이 새로 생성해서 검증 |

이관은 해당 단계에서 하나씩 수행한다. DEC-01에 전체 디렉터리 이동을 섞지 않는다. DEC 인계에는 각 임시 의존의 원본 경로·소비 함수/시험·이동 대상·제거 단계를 남기고, C5 종료 시 실제 실행에 필요한 임시 참조가 0인지 확인한다.

## 3. 실제 코드의 출발점

| 역할 | 현재 파일·함수 | 작업 방향 |
| --- | --- | --- |
| approve/transfer 해석 규칙 | [approve manifest](/Users/spu/SDKdambi/DAMBI/registryV2/manifests/standard/erc20/approve@1.0.0.json), [transfer manifest](/Users/spu/SDKdambi/DAMBI/registryV2/manifests/standard/erc20/transfer@1.0.0.json) | 원본을 실제 builder에 넣는다. 시험용으로 같은 규칙을 재작성하지 않음 |
| 주소 확장·index·digest | [build-index.ts](/Users/spu/SDKdambi/DAMBI/registryV2/scripts/build-index.ts): `resolveBundle`, `main` | `BUILD_INDEX_REGISTRY_ROOT`로 임시 Registry를 지정해 실행 |
| 설치·callkey/typed 매칭 | [declarative_exports.rs](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/src/declarative_exports.rs): `declarative_install_v3_json`, `declarative_route_request_v3_json`, `declarative_route_typed_data_v3_json` | 기존 실행 경로 재사용. 재현된 결함만 좁게 수정 |
| ABI 해석 | [bridge.rs](/Users/spu/SDKdambi/DAMBI/crates/adapters/abi-resolver/src/bridge.rs): `decode_with_json_abi`; [decode.rs](/Users/spu/SDKdambi/DAMBI/crates/adapters/abi-resolver/src/decode.rs): `decode_with_function` | selector·필수 인자·수치·추가 바이트의 동작을 구분 |
| 인자 JSON 변환 | [args_json.rs](/Users/spu/SDKdambi/DAMBI/crates/adapters/mappers/src/declarative/args_json.rs): `args_to_json` | 수량 정밀도와 tuple/array 구조 유지 |
| emit → Action | [action_builder.rs](/Users/spu/SDKdambi/DAMBI/crates/adapters/mappers/src/declarative/action_builder.rs): `build_action_body`, `build_array_emit` | 기존 Rust `ActionBody`를 사용. 별도 중간 표현(IR)을 새로 만들지 않음 |
| 현재 WASM 입출력 | [dto.rs](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/src/dto.rs): `DeclarativeRoute*Dto` | 기존 wire와 새 진단 요구사항의 차이를 명시 |
| 소비자 평가 시험 | [action_eval_exports.rs](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/src/action_eval_exports.rs): `plan_action_rpc_v2_json`, `evaluate_action_v2_json` | Decoder가 만든 Action을 그대로 전달해 정적 정책 한 경로 확인 |

현재 transaction 결과는 `ok/data.actions/data.decoder_id` envelope이며 오류에는 `error.kind/message`가 있다. `partial`, 진단 목록, bundle digest는 현재 결과 DTO에 있다고 가정하면 안 된다.

기존 [Rust route 시험](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_route.rs)에는 수작업 manifest와 실제 manifest를 읽는 사례가 혼재한다. [baseline-verdicts.test.ts](/Users/spu/SDKdambi/DAMBI/fixtures/baseline-verdicts.test.ts)는 이미 생성된 Action을 평가한다. 새 시험의 핵심은 **실제 source → 실제 builder → 실제 Decoder**를 연결하는 것이다.

### 3.1 기존 제품에서 실제로 호출하는 경로

2026-09-11 재검토에서 Rust 실행부뿐 아니라 TypeScript 호출자와 Registry API를 대조했다. 위의 주요 함수는 기존 제품이 실제로 호출하는 구현이다.

```text
transaction:
  orchestrator → tryDeclarativeRouteV3
    → selector 추출 → 해당 bundle 설치 → multicall 하위 bundle 사전 설치
    → WASM bridge → declarative_route_request_v3_json

typed signature:
  routeTypedData → domain/주소/type 이름 정규화 + witness 추출
    → typed-data bundle 설치 → WASM bridge
    → declarative_route_typed_data_v3_json
```

| 기존 코드·근거 | 이 계획에서 재사용·보강할 부분 |
| --- | --- |
| [orchestrator.ts:712](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/orchestrator.ts:712), [declarative-route.ts:406](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/adapter-loader/declarative-route.ts:406) | 기존 transaction 진입·설치·route 흐름을 기준으로 시험. 호스트 orchestration 전체를 SDK에 복사하지 않음 |
| [declarative-decode.ts:14](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/adapter-loader/declarative-decode.ts:14)의 `extractSelector` | 이미 있는 순수 selector 추출. TS ABI 엔진을 새로 구현하지 않음 |
| [sig-routing.ts:160](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/sig-routing.ts:160)의 `routeTypedData` | 기존 주소/chain/type 정규화와 witness 추출을 참고·재사용. 실제 request types와 manifest types 대조는 별도 보강 |
| [declarative-route.ts:292](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/adapter-loader/declarative-route.ts:292)의 `installCallTree`, `preinstallMulticallChildren` | 하위 decoder 발견·사전 설치는 이미 구현됨. Rust의 설치된 decoder를 통한 재귀 해석과 구분 |
| [declarative-adapter-loader.ts:469](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/adapter-loader/declarative-adapter-loader.ts:469) | API가 조립한 inline bundle을 parse → verify → install. hash와 설치에는 파서가 재구성한 일부 객체가 아닌 원본 bundle 사용 |
| [registry-api/server.ts:565](/Users/spu/SDKdambi/DAMBI/registry-api/src/server.ts:565)의 `materializeIfRefIndex` | `3-ref`를 실제 bundle로 해소하는 기존 구현. extension loader가 이 조립을 수행한다고 가정하지 않음 |
| [ActionBody 원본](/Users/spu/SDKdambi/DAMBI/crates/policy-server/asset-model/action/src/lib.rs:153) | 실제 타입 정의는 `policy-action`. `policy_transition::action`은 호환 re-export이므로 타입 검토 시 원본을 확인 |

`declarative-decode.ts`와 `bundle-schema.ts`는 순수 코드지만 `sig-routing.ts`는 순수 helper 외에 loader/WASM 의존도 가진다. 재사용은 함수의 의존성을 확인해 수행한다. `declarative-v3-cache.ts`의 확장 스토리지나 `v3-bundle-loader.ts`의 확장 asset 부팅 경로를 가져와야 Decoder가 작동하는 구조로 만들지 않는다.

### 3.2 이미 있는 시험과 새 작업의 차이

| 기존 시험 | 이미 확인하는 내용 | 이 계획에서 추가하는 내용 |
| --- | --- | --- |
| [t1_erc20_approve](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_route.rs:159) | 수작업 inline manifest의 approve 해석 | 실제 `approve@1.0.0` source의 token 확장 → builder → WASM. 기존 fixture는 `approve@2.0.0`, schema 2 형태여서 실제 source 시험과 다름 |
| [build-index token source 시험](/Users/spu/SDKdambi/DAMBI/registryV2/scripts/__tests__/build-index.test.ts:499) | 실제 builder의 주소 확장·참조 산출물 | 기존 임시 경로/환경 변수 방식을 참고해 WASM까지 연결. builder 자체를 재작성하지 않음 |
| [typed Single](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_typed_data_install.rs:164), [EIP-2612](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_typed_data_install.rs:303), [실제 Batch manifest](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_typed_data_install.rs:1080) | flat/tuple/array 해석이 이미 존재 | 실제 build 경계와 원문 요청의 필수 구조·정보 보존 검증 |
| [NFPM multicall·mint·refundETH](/Users/spu/SDKdambi/DAMBI/crates/policy-engine-wasm/tests/declarative_v3_route.rs:5050) | 실제 manifest를 사용한 하위 호출 해석 | 같은 사례를 회귀 기준으로 유지하고 실제 build/WASM 경계·한도 진단 추가 |
| [TS 사전 설치 시험](/Users/spu/SDKdambi/DAMBI/browser-extension/backend/service-worker/__tests__/declarative-route.test.ts:133) | mock installer/WASM으로 하위 bundle 발견·설치 확인 | 실제 WASM 해석 시험과 구분. 이 시험을 실제 ABI 해석의 증거로 사용하지 않음 |

따라서 approve/transfer/typed/multicall의 기본 기능은 재사용 대상이다. 새 작업은 연결 시험, 원문 정보 보존, malformed/miss 구분, 한도 초과 진단이다. 새 시험은 기존 시험을 대체하거나 통째로 복제하지 않고 빠진 경계를 추가한다.

## 4. 데이터 흐름과 계약

### 4.1 Registry는 세 형태를 구분한다

```text
source manifest + 명시적으로 선택한 token 파일
  → build-index --strict-callkeys
  → resolved bundle + by-callkey / by-typed-data / by-selector index
  → index 참조 해소 및 개별 bundle digest 확인
  → 기존 WASM에 resolved bundle 설치
  → 원문 요청 해석 → Action + 해석 상태
```

1. **Source:** `chain_to_addresses_source: "tokens:erc20"` 등 빌드 입력. 그대로 설치용 완성 번들로 사용하지 않는다.
2. **Resolved bundle:** source를 확장한 구체적인 규칙. approve/transfer는 선언된 1·10·8453·42161 체인의 token 주소로 확장한다.
3. **Index:** 조회 키의 결과이며, 다음 세 형태를 구분한다.

| 실제 index 형태 | 해소 방법·이번 사용 범위 |
| --- | --- |
| inline `bundle` | concrete callkey·typed-data·selector index의 완성 bundle을 그대로 사용. 이번 EIP-2612/Permit2/NFPM/Morpho가 해당 |
| `3-ref` + `bundle_ref` | 파일을 읽어 완성 bundle을 얻음. 이번 approve/transfer의 token source가 해당 |
| `3-ref` + `context_ref/materialization` | template와 context를 기존 규칙대로 조립. 이번에 선택한 manifest에는 필요하지 않으며, 범위를 넓힐 때 별도 검증 |

실제 조립 기준은 Registry API의 `materializeIfRefIndex`·`materializeSourceBundle`와 [materialization-parity.test.ts의 servedBundle](/Users/spu/SDKdambi/DAMBI/registry-api/src/__tests__/materialization-parity.test.ts:69)다. 시험 helper는 우선 필요한 inline/ref 두 경로만 다루고 같은 bundle 객체·digest가 나오는지 확인한다. API 서버 전체나 확장 loader를 가져와 실행하거나 새 context 조립 규칙을 발명하지 않는다.

현재 `bundle_sha256`는 **해석 완료된 개별 bundle의 JCS 정규화 결과에 대한 SHA-256**이다. 원본 manifest 파일의 hash, template 파일 hash, 전체 Registry root digest와 다르다. 아직 없는 원격 Registry root/ref를 만들어 API 계약으로 사용하지 않는다.

임시 Registry 입력 목록과 source hash를 고정한다. 제품 원본의 `chain_ids`를 줄여 시험을 쉽게 만들지 않는다. approve 첫 시험도 네 체인에 대해 실제 token 파일을 최소 한 개씩 명시적으로 선정한다. 전체 token 목록을 검증한 것으로 표시하지 않는다.

### 4.2 Transaction

기존 내부 입력을 우선 재사용한다.

```text
chain_id, to, selector, calldata, submitter, submitted_at
+ value, gas_limit, gas_price, nonce, block_timestamp
```

- `to`는 호출 대상 계약이다. approve의 spender, transfer의 recipient는 calldata 인자에서 나온다.
- 출력 token의 chain은 기존 `eip155:<id>` 표현을 유지한다. `amount: uint256`은 ABI → 문자열 → Rust U256 경로로 이동하며 JS `Number`를 거치지 않는다.
- 실제 JSON 출력은 Rust serde 형태가 기준이다. 예를 들어 manifest의 중첩 `token.erc20_approve`와 출력 body의 `action: "erc20_approve"`, `spender`, `amount` 형태를 혼동하지 않는다.
- 일반 호출의 selector는 calldata 첫 4바이트와 일치해야 한다. 현 코드는 입력 `selector`로 조회한 후 ABI에서 calldata selector를 검사한다. 서로 다른 경우를 재현하고, lookup 전 일치 검사를 추가하면 오류 분류가 바뀌는 범위까지 기록한다.
- 빈 calldata의 native transfer 분기는 기존 동작을 유지한다. approve 인자 누락 시험과 native transfer 시험을 섞지 않는다.
- 추가 바이트 허용을 유지하므로 모든 경로에 `decode_with_function_strict`를 일괄 적용하지 않는다. 인자 부족을 수용하는 사례가 재현되면 최소 길이·offset 검사와 추가 바이트 정책을 분리해 수정한다.

### 4.3 Typed permit

현재 매칭 키는 `(chain_id, verifying_contract, primary_type, witness_type?)`다. 주소만 정규화하고 타입 이름과 필드 순서는 의미를 보존한다.

기존 TypeScript의 `EIP712TypedData`는 이미 전체 domain/types/message를 받는다. `normalizeTypedDataPayload`, `parseDomainChainId`, 주소/type 이름 정규화, `extractWitnessType`도 존재한다. 다만 `routeTypedData`가 WASM으로 넘기는 DTO는 `message`와 축약 domain 필드이며 전체 `types`, `domain.version/salt`를 전달하지 않는다.

기존 `normalizeTypedDataPayload`는 JSON 문자열/객체 변환이고, `extractWitnessType`는 해당 필드 이름을 찾는 함수다. 전체 요청 schema/type graph 검증은 아니다. `bundle-schema.ts`의 manifest type 파싱 역시 실제 서명 요청의 types와 대조하는 검사가 아니다. DEC-04는 기존 정규화를 참고·재사용하고 **WASM 경계의 정보 손실 및 요청/manifest 대조**를 보강한다.

SDK용 Decoder 내부 계약은 다음 정보를 보존하는 방향으로 상세화한다. 이는 `@dambi/core` 공개 API를 이 단계에서 고정한다는 뜻이 아니다.

```text
requested_signer + submitter + submitted_at
typedData: { domain, types, primaryType, message }
→ 원본 필드 보존·기본 형식/routing-domain 충돌 검사 → lookup
→ 지원 manifest의 types/domain/message 검증
→ owner/requested_signer 요청 일관성·deadline 표현 범위 검사 → emit
```

- 원본 domain에서 chain/contract를 추출한다. 같은 정보를 바깥 필드로도 받는 호환 경로는 불일치를 검사한다.
- `types`의 이름·필드 순서·타입·참조 관계를 확인한다. 알려진 Permit의 owner·nonce처럼 emit에 직접 쓰이지 않는 필수 필드도 검사한다.
- 임의 `primaryType/witnessType` 주장만으로 다른 구조의 message를 정상 Permit으로 해석하지 않는다. witness는 실제 type graph에서 확인할 정보이며 별도 주문 지원은 후속 결정이다.
- manifest가 기대값으로 명시한 domain 항목과 요청 값을 대조한다. 선언되지 않은 version/salt의 정답을 만들어내지 않는다. 호환성을 바꾸는 domain 제약이 필요하면 DEC-04에서 재현 사례와 함께 질문한다.
- strict ERC-2612 Permit은 정규화한 owner와 요청자가 제공한 서명 대상 지갑 `requested_signer`가 일치해야 한다. submitter는 별도 제출 주체로서 달라도 허용한다. 모든 주소 원문을 유지하며 주소 일치는 실제 서명 검증이 아니다.
- 미등록 contract와 malformed owner가 함께 있으면 lookup의 미지원 결과가 먼저다. 이는 지원 범위 밖이라 상세 검증하지 않았다는 의미이며 검증 성공이 아니다. strict 실패·미지원 결과를 v3로 자동 재시도하지 않는다.
- permit 요청 해석은 이미 생성된 서명의 유효성 확인이나 체인상의 nonce/deadline 사용 가능성 확인과 다르다. 필요한 live input 선언은 보존하고 조회·신선도 판단은 Core/Fact 단계로 넘긴다.

### 4.4 Multicall과 부분 해석

| 종류 | 기존 처리 | 검증할 의미 |
| --- | --- | --- |
| self `multicall(bytes[])` | 같은 target으로 하위 calldata 재진입 | 순서·같은 계약의 selector·중첩 구조 |
| `Call[]` multicall | 자식별 target/data/value로 재진입 | 각 자식의 계약·금액을 서로 섞지 않음 |
| re-entry callback | manifest의 `reenter_callback_arg`에 따라 추가 전개 | 한도에 도달해도 미해석 구간과 사유 보존 |
| opcode stream | 별도 opcode 규칙 및 깊이 제한 | 기존 경로 회귀 확인. 모든 opcode 지원을 새로 약속하지 않음 |

미지원 자식은 현재도 `Unknown`으로 보존하는 경로가 있다. 이를 새로운 기능으로 다시 구현하지 않는다. 사용자가 선택한 한도 초과 처리에 맞춰 누락되는 콜백과 진단을 보강한다.

기존 제품은 Rust 해석 전에 TS에서 하위 bundle을 찾아 설치한다. `installCallTree`에는 별도의 `MAX_REENTER_DEPTH = 4`가 있고 한도에서 반환한다. 시험용 snapshot에 필요한 bundle을 미리 설치하고 Rust만 시험하면 이 **발견·사전 설치 단계**의 누락은 검증되지 않는다. DEC-06 결과에는 어느 단계의 제한인지 구분하고, SDK가 사전 설치한 snapshot을 쓸지 필요한 bundle을 찾아 설치할지는 Core/adapter 인계 항목으로 남긴다. 이를 누락한 채 제품의 multicall 전체 연결이 검증됐다고 표시하지 않는다.

**진단 계약 제안:** 기존 Action 결과에 해석 완전성(`complete/partial`)과 진단 목록을 추가하되, 정확한 wire 필드명은 DEC-06의 DTO 변경에서 확정한다. 진단에는 안정적인 코드·원본 호출 경로·decoder id(있는 경우)를 둔다. 예: `actions[1].callback[2]`, `depth_limit_exceeded`. 이 예시 코드는 아직 구현된 오류 코드가 아니다.

한도 때문에 내부를 읽지 못한 구간은 해당 구간의 target·원문 calldata·value를 담은 하나의 Unknown으로 보존할 수 있다. 내부 자식 개수나 내용을 추측해 생성하지 않는다. 순서와 부모 관계를 잃는 flattening이 발견되면 호출 경로를 함께 보존하도록 설계한다.

### 4.5 오류는 위험 판정이 아니다

| 분류 | 사례 | 처리 원칙 |
| --- | --- | --- |
| 입력 형식 오류 | 주소 문자열 파싱 실패, 잘못된 JSON/hex | 기존 `invalid_input_json`, `invalid_calldata` 등을 확인 |
| 매칭 없음 | 유효한 주소·체인이지만 설치된 규칙에 해당하지 않음 | transaction `no_declarative_v3_mapper`, typed `no_typed_data_mapper` |
| 알려진 형식 해석 실패 | approve 인자 부족, Permit 필수 필드 누락 | malformed/decode 오류. 단순 미지원으로 숨기지 않음 |
| 잘못된 해석 규칙 | ABI·emit 결함, unresolved placeholder | `invalid_bundle`, `decode_failed` 등 실제 원인을 보존 |
| 부분 해석 | 미지원 자식, 탐색 한도 초과 | 알려진 결과 + Unknown + 진단. complete로 표시하지 않음 |

주소가 0이거나 등록 목록에 없다는 이유로 Decoder에서 deny하지 않는다. NFT `setApprovalForAll`에는 기존 주소 비종속 매칭이 있으므로 모든 Decoder에 같은 주소 제한을 강제하지 않는다. 정식 안전성 판단과 최종 Allow/Warn/Deny 조합은 Core가 담당한다.

## 5. 새 시험 파일 설계

아래는 전체 시험의 목표 구조다. DEC-01의 `README.md`, `registry-selection.json`, `helpers/build-registry.mjs`, `helpers/wasm-worker.mjs`, `approve.cases.json`, `approve.test.mjs`와 DEC-02의 `approve-policy.test.mjs`·기존 worker의 선택적 정책 평가 경로는 구현 및 사용자 실행 보고 기준 검증을 완료했다. DEC-03의 `transfer.cases.json`, `transfer.test.mjs`, `coverage.md`와 selection/helper의 명시적 transfer 선택 확장도 구현 및 사용자 실행 보고 기준 검증을 완료했다. DEC-04a의 `typed-permit.cases.json`, `typed-permit.test.mjs`와 helper/worker 최소 확장은 사용자 실행 기준 47/47·당시 통합 105/105 통과했다. 04b strict fixture/test와 Rust validator/export도 사용자 실행 로그 기준 검증 완료다. DEC-05a의 `permit2-single.cases.json`, `permit2-single.test.mjs`는 구현 완료, 사용자 실행 대기다. `assertions.mjs`·Batch 및 DEC-06 이후 파일은 아직 작성하지 않았다.

```text
fixtures/decoder-policy/
  README.md                     # 준비·실행·실패 확인 방법
  coverage.md                   # source별 확인 범위와 미검증 범위
  registry-selection.json       # 실제 manifest/token 파일 경로·source hash
  helpers/
    build-registry.mjs          # 임시 디렉터리 + 실제 builder + index 해소
    wasm-worker.mjs             # 실제 WASM 초기화·설치·route·선택적 정책 평가
    assertions.mjs              # 정밀도·Action·진단 검증에 필요한 최소 공통 코드
  approve.cases.json
  approve.test.mjs
  approve-policy.test.mjs        # DEC-02 사용자 실행 보고 기준 검증 완료
  transfer.cases.json
  transfer.test.mjs
  typed-permit.cases.json
  typed-permit.test.mjs
  typed-permit-strict.cases.json
  typed-permit-strict.test.mjs    # DEC-04b 사용자 실행 168개 통과
  permit2-single.test.mjs
  permit2-batch.test.mjs
  multicall-self.test.mjs
  multicall-call-array.test.mjs
  multicall-limits.test.mjs
```

fixture에는 `id`, 실제 요청, 선택한 Registry source, 예상 decoder id, 예상 body/원문 필드, 예상 error kind 또는 진단을 둔다. 정책 시험의 `expectedPolicy`는 디코딩 기대값과 분리한다.

expected Action을 실제 decoder의 반환값으로 자동 생성해 정답으로 저장하지 않는다. approve/transfer의 calldata는 고정 hex 사례를 포함하고 spender/recipient와 32바이트 amount 위치를 독립적으로 검산한다. 예를 들어 approve 일반 수량 1,000,000의 출력 amount는 `0xf4240`이어야 한다.

현 Registry는 WASM의 전역 상태다. 서로 다른 설치·충돌 시나리오는 별도 Node 프로세스에서 실행해 상태를 격리한다. 시험 편의를 위해 전역 reset API나 Core 인스턴스 구조를 먼저 추가하지 않는다.

## 6. 구현 순서와 완료 조건

### DEC-01 — approve 실제 디코딩 기준선 · 전체 계획 D1 앞부분

**상태:** 구현 완료. **현재 Rust 소스 직접 빌드 후 연결 시험은 사용자 실행 보고 기준 30개 통과, 실패·취소·건너뛰기 각 0개**다. 실제 Registry builder → resolved bundle의 JCS digest 확인 → 실제 WASM 설치 → approve 디코딩·decoder ID·Action 검증 경로를 확인했다. 사용자 제공 실행 전후 HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`로 같고 Rust 소스·빌드 설정 변경은 표시되지 않았다. 도구 조회 결과는 Rust/Cargo 1.95.0, wasm-pack 0.14.0, Node 25.9.0, npm 11.12.1이다.

사용자 제공 빌드 성공 표식은 `build_success_utc=2026-09-11T06:57:10Z`이며, 해당 경로의 WASM SHA-256과 재시험 로그를 [README 검증 기록](../../fixtures/decoder-policy/README.md)에 기록했다. 재시험은 `2026-09-11T06:57:40Z` 시작, `2026-09-11T06:57:42Z` 성공 표식, `duration_ms=1290.958958`다. 최초 30개 통과(`duration_ms=2050.144875`)와 별도 실행이다. 이 보고를 기준으로 현재 소스 → 직접 WASM 빌드 → hash 확인 → 동일 경로의 WASM 연결 시험을 확인했으며 작성자가 직접 실행한 결과가 아니다.

빌드 시작 시각·상세 빌드 로그·전체 빌드 명령 출력·실제 임시 `CARGO_TARGET_DIR` 경로는 기록 보완 대기로 남긴다. 이 미제공 항목을 채우기 위해 빌드·시험을 다시 요구하지 않는다. 작성자의 소스/WASM 독립 재현은 미확인이며 DEC-01 커밋 `3066f0c` 자체를 그 증거로 삼지 않는다. DEC-02는 아래 별도 사용자 실행 결과로 완료를 확인했으며 SDK 소스·빌드 독립화는 미완료다.

**구현:** README/selection/helper/approve fixture·시험, root `package.json`의 `decoder:test` 스크립트. 기존 Rust 실행부를 재사용한다.

1. 실제 approve manifest와 네 체인의 최소 token 파일을 임시 Registry로 복사한다.
2. 실제 builder를 `--strict-callkeys`로 실행한다. 종료 코드가 0이 아니면 생성된 일부 파일도 시험 입력으로 소비하지 않는다.
3. index의 chain/address/selector와 bundle 참조를 확인하고 digest를 계산해 비교한다.
4. 실제 WASM에 bundle을 설치하고 calldata를 route한다.
5. decoder id, Action 개수, token chain/address, spender, amount를 검사한다.

**사례:** 0, 일반 수량, `2^160-1`, `2^256-1`, `2^256-2`; 주소 대소문자; 등록 조합의 miss; 비정상 hex; selector만 존재; 인자 일부 누락; selector 불일치; 정상 인자 뒤 추가 바이트.

**완료:** 성공·매칭 없음·malformed를 구분한다. 네 체인 주소 확장과 최소 정상 사례를 확인한다. 결과가 기대와 다르면 재현 fixture를 먼저 확보하며, 오동작을 기대값에 맞춰 통과시키지 않는다. 이 단계만 끝내고 보고한다.

### DEC-02 — approve 소비자 정책 연결 · 전체 계획 D1 뒷부분

**상태: 사용자 실행 보고 기준 검증 완료.** 구현 커밋은 `26df736`이며, 사용자 보고로 실제 Rust crate의 WASM 컴파일·최적화·`pkg` 생성 완료와 통합 시험 37개 통과를 확인했다. 사용자가 직접 계산한 JS/WASM SHA-256도 실행 로그와 일치했다고 보고했다. D1의 approve 디코딩·정책 연결 완료 조건을 충족했다. 이번 기록 갱신에서 에이전트는 빌드·시험·의존성 설치와 Git 변경 명령을 실행하지 않았다.

**수정:** 신규 `approve-policy.test.mjs`, 기존 `helpers/wasm-worker.mjs`의 선택적 `scenario.policyBundle` 평가 경로, README, 두 계획서, 루트 `package.json`의 시험 명령. DEC-01 입력과 `{ installations, results: [{ id, result }] }` 출력 계약 및 기존 30개 검사를 유지한다. DEC-02 요청에만 `plan/evaluation` 응답을 추가하며 신규 helper는 만들지 않는다. 기존 Rust 실행부, 정책 본문·manifest·severity는 변경하지 않는다.

- 실제 approve manifest → 기존 Registry builder → 실제 WASM 설치·디코딩 → `Action.body/meta` → 기존 `plan_action_rpc_v2_json`·`evaluate_action_v2_json`의 경로를 연결했다. `action`과 `meta`는 실제 디코더 반환값을 그대로 전달하며 DEC-01 expected Action이나 재구성한 token/spender/amount를 평가 입력으로 사용하지 않는다.
- `tx`는 원래 요청에서 `chain_id: eip155:<chain_id>`, `from: submitter`, `to: token contract`로 구성한다. planner에는 실제 manifest, evaluator에는 `bundles: [{ policy, manifest }]`와 외부 Fact 없는 `results: {}`를 전달한다.
- 입력은 `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/`의 실제 `policy.cedar`와 `manifest.json` 하나뿐이다. planner의 정상 응답과 `planned: []`, 실제 DTO의 `pass/warn/fail` 결과를 응답 전체 비교로 검사한다. warn 사례는 실제 `unlimited-approval-deny` 정책 ID와 severity `warn`을 확인하고 `__engine::*`, quarantine, `__system__` 오류 판정을 배제한다.
- Permit2 예외는 정책 원문에 선언된 spender와 대조하고 원문 calldata의 spender word를 바꿔 실제 디코더를 다시 통과시킨다. 이미 디코딩한 Action을 수정하지 않는다. 기대값은 고정 calldata의 독립적인 수량 분석과 정책 원문에 근거하며 실제 평가 결과로 자동 생성하지 않는다.

| 승인량 | spender | 해당 정책 하나의 기대 결과 |
| --- | --- | --- |
| `0` | 일반 spender | `pass` |
| 일반 승인량 | 일반 spender | `pass` |
| `2^160-1` | 일반 spender | `warn` |
| `2^256-1` | 일반 spender | `warn` |
| `2^256-2` | 일반 spender | `pass` |
| `2^160-1` | 정책의 Permit2 spender | `pass` |
| `2^256-1` | 정책의 Permit2 spender | `pass` |

DEC-02는 위 7개만 추가한다. 루트 `decoder:test`는 DEC-01 30개와 DEC-02 7개를 함께 포함하며 **사용자 실행 결과 37개 모두 통과**, 실패·취소·건너뛰기·todo는 모두 0이다. 개별 명령은 `decoder:test:approve`와 `decoder:test:approve-policy`다. 추가 체인·수량 조합이나 DEC-01 검사 복제는 포함하지 않는다.

확장 경로 정책은 D3 이관 전 기준 시험의 임시 입력이다. D3에서 공유 정책 원본으로 전환하고 C2c·C5에서 SDK 시험·실행 경로를 이관한다. 최종 SDK 의존 구조나 다른 정책을 포함한 제품 전체 판정으로 일반화하지 않는다.

**완료 조건 충족:** 사용자 실행으로 7개 정책 사례와 기존 DEC-01 회귀 시험이 통과했으며 결과를 [README](../../fixtures/decoder-policy/README.md)에 기록했다. `planned: []`, 빈 Fact 평가, 정확한 정책 ID·severity `warn`·origin `action` 검사를 포함한다. 정책 이름의 `deny`에 맞추려고 severity를 바꾸지 않는다. 향후 회귀 시험에서 예상과 다르면 기존 정책·Rust 실행부 수정으로 범위를 넓히지 않고 관련 파일·최소 입력·코드상 동작·기대와의 차이·선택지·영향·권장안을 보고한다. 실행 전 코드상 추정과 실제 재현은 구분한다.

### DEC-03 — transfer와 공통 transaction 오류 · 전체 계획 D2

**상태: 사용자 실행 보고 기준 검증 완료.** 실제 `standard/erc20/transfer@1.0.0`, selector `0xa9059cbb`의 기준 시험을 작성했고 사용자가 transfer 개별 21개와 통합 회귀 58개를 모두 통과했다. 기존 DEC-01/02 사용자 실행 기준 37개 통과 기록은 유지하며 이번 통합 실행에서도 기존 37개 회귀가 통과했다. 두 실행 모두 실패·취소·건너뛰기·todo는 0이다.

| 사용자 실행 명령 | tests / pass | suites / fail / cancelled / skipped / todo | duration_ms |
| --- | --- | --- | --- |
| `npm run decoder:test:transfer` | 21 / 21 | 0 / 0 / 0 / 0 / 0 | 866.922333 |
| `npm run decoder:test` | 58 / 58 | 0 / 0 / 0 / 0 / 0 | 635.086875 |

위 결과는 사용자가 제공한 실행 로그에 근거하며 에이전트의 독립 재실행 결과가 아니다. 이번 실행의 HEAD·시각·도구 버전·산출물 hash·재빌드 로그는 제공되지 않아 이전 단계 기록이나 착수 HEAD로 채우지 않는다. 이 세부 기록의 미제공은 DEC-03 검증 완료를 막지 않으며 이를 채우기 위한 재빌드·재시험은 요구하지 않는다.

**수정:** 신규 transfer fixture·시험·coverage, `registry-selection.json`, `helpers/build-registry.mjs`, 루트 `package.json`, README와 두 계획서, 총 9개 파일. `buildRegistry(selection)`의 approve 전용 기본 동작과 반환 계약을 유지하고 DEC-03에서만 `{ includeTransfer: true }`로 두 원본을 선택한다. 이때만 `transferSource`를 반환한다. 기존 approve/token 경로·바이트 hash를 보존하고 transfer 원본 SHA-256을 추가했다. 두 원본의 네 체인 범위와 token 파일을 그대로 사용하며 `--strict-callkeys`, 임시 경로·실패 정리, resolved bundle JCS 검증을 유지한다. DEC-03 당시에는 기존 approve fixture·두 시험 파일과 다중 bundle 설치를 지원하는 WASM worker를 수정하지 않았다.

- 정확히 8개 callkey(네 체인 × approve/transfer selector)의 manifest 경로·bundle ID·JCS digest 및 원본 필드 보존을 확인한 뒤 실제 WASM에 설치하도록 작성했다.
- 정상 요청 7개: 네 체인에 0·일반 `1,000,000`·`2^256-1`·혼합 대소문자를 배치하고 zero recipient, 1바이트·32바이트 trailing 호환성을 추가한다. `to = token`, `$args.to = recipient`, submitter를 서로 다르게 두며 body/meta 전체와 `spender` 부재, 기본 `is_router_egress: false` 생략을 검사한다. gas price의 Pyth source는 기존 stub이다.
- 오류 요청 11개: 정상 형식의 미등록 token·chain·selector, 잘못된 calldata hex, 필수 selector 누락·calldata 타입 오류, selector-only·잘린 recipient/amount word, 두 등록 selector와 calldata의 양방향 불일치를 구분한다. 일반 JSON·주소·숫자 파싱은 `invalid_input_json`, calldata hex는 `invalid_calldata`, lookup miss는 `no_declarative_v3_mapper`, 매칭 후 ABI 실패는 `decode_failed`를 유지한다.
- 구조 검사 3개: 실제 원본·8개 callkey·bundle, 고정 calldata word·`BigInt` 검산, 공동 설치 후 transfer/approve 교대 요청과 별도 approve-only 프로세스의 transfer miss. 기존 일반/MAX approve 두 사례를 재사용한다. WASM·ABI를 mock하지 않고 전역 Registry 초기화를 가정하지 않는다.

합계 **DEC-03 21개와 통합 58개 모두 사용자 실행으로 통과**했다. 정확한 case ID·기존 DEC-01 공통 오류 재사용 범위·미검증 영역은 [coverage](../../fixtures/decoder-policy/coverage.md)를 따른다. raw JSON 문법 오류는 기존 worker가 요청을 `JSON.stringify`해 전달하므로 이 fixture에서 직접 검증하지 않는다.

**정적 한계:** DTO의 selector는 길이/hex 검증 없는 `String`이다. 완전한 정상 transfer 요청에서 selector만 `"0x1"` 또는 `"0xzzzzzzzz"`로 바꾸면 코드상 lookup miss가 예상된다. 입력 형식 오류로 구분할 방향과 차이가 있으며 정상 미지원으로 표현하지 않는다. 실제 재현은 하지 않았다. [coverage의 최소 입력·관련 파일·영향·권장안](../../fixtures/decoder-policy/coverage.md#selector-문자열-형식-검사의-한계와-판단-항목)에 기록했다. 이번 작성 범위에는 runtime 변경이나 판단 대기가 없으며, 향후 형식 검증 도입으로 오류 우선순위·native 분기·기존 기대값·Rust/manifest·trailing 호환성을 바꿔야 하면 사용자에게 영향과 권장안을 제시해 질문한다.

**완료 조건 충족:** 사용자 실행으로 approve와 transfer 공동 설치 시 각 selector의 정확한 decoder ID·Action, 8개 callkey·JCS digest, 같은 WASM 프로세스의 교대 요청과 별도 approve-only 프로세스 격리까지 확인했다. 신규 21개와 기존 37개 회귀를 포함한 통합 58개가 통과했다. DEC-03 당시 transfer 정책 평가·typed permit·multicall·Core/API/RPC·서명 검증·소스 이관·CI는 추가하지 않았다. 현재 DEC-04 진행 상태는 다음 절에서 별도로 기록한다.

### DEC-04 — EIP-2612와 typed 입력 계약 · 전체 계획 D2

**DEC-04 상태: 사용자 실행 로그 기준 검증 완료.** 04a는 사용자 제공 로그 기준 개별 47/47 통과(`duration_ms=801.277375`), 당시 통합 105/105 통과(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 과거 값으로 채우지 않는다. 04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다.

| 단계 | 산출물 | 실행 검증 |
| --- | --- | --- |
| 04a | 실제 원본 typed index/JCS/WASM 연결 fixture·helper·worker·개별 명령 | 사용자 실행 47/47, 당시 통합 105/105 통과 |
| 04b | 별도 v4 DTO/export·순수 validator·실제 emit 연결·shared Rust/Node 회귀 | 사용자 Native 181개·새 WASM 빌드·Node strict 168개/기존 typed 47개/통합 273개 통과 |

#### 04a — 실제 원본과 기존 축약 경로의 기준 시험

원본은 `registryV2/manifests/standard/erc20/permit@1.0.0.json` 하나다. ID는 `standard/erc20/permit@1.0.0`, 실제 원본 바이트 SHA-256은 `0x9e7337ae3ce7e1a80851652e39b2ac4fb264b5e8caf00a4c93193c6b93c76eb3`다. source hash는 설치 bundle의 JCS digest와 구분한다. 원본의 직접 선언은 **chain 1 / USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` / selector `0xd505accf` / primary type `Permit` / domain name `USD Coin`**이며 token 목록으로 네 체인에 확장하지 않는다. `Permit`의 필드 배열은 owner/address → spender/address → value/uint256 → nonce/uint256 → deadline/uint256 순서다.

선택은 `buildRegistry(selection, { includePermit: true })`의 **approve + permit**이다. 기본 approve의 4개 callkey/typed index 없음과 `{ root, source, tokens, cleanup }` 반환은 유지한다. 기존 `{ includeTransfer: true }`도 8개 callkey/typed index 없음과 `transferSource` 반환을 유지한다. permit을 선택한 경우에만 `permitSource`를 더한다. 새 시험은 builder가 만들어야 할 정확한 **5개 callkey(approve 4 + permit 1), typed index 1개, selector index 0개**를 검사하도록 작성한다. 이 구조 검사는 04a 사용자 실행에서 통과했다.

- permit calldata index: `index/by-callkey/1__0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__0xd505accf.json`.
- permit typed index: `index/by-typed-data/1__0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__Permit.json`.
- 실제 builder 소스상 두 permit index는 **inline bundle**이다. 이를 기존 inline/`3-ref` helper로 해소하고 JCS digest와 동일 bundle·원본 보존을 검사한다. permit을 `3-ref`로 바꾸지 않으며 typed 시험의 설치 대상은 typed index에서 얻는다.
- 실제 원본 → 기존 `--strict-callkeys` builder → index·JCS 검증 → 실제 `declarative_install_v3_json` → `declarative_route_typed_data_v3_json` → decoder ID·Action·meta·오류 경계를 연결한다. source/임시 경로/실패 정리를 유지한다. `permit()` calldata 디코딩 성공으로 typed 서명 경로를 검증하지 않는다.
- worker는 요청 `{ id, kind: "typed", input }`에만 typed export를 호출한다. kind 생략/`transaction`은 기존 transaction 경로이고 DEC-02의 선택적 정책 평가는 그대로다. 설치 유무는 별도 Node 프로세스로 격리한다.

현재 [`DeclarativeRouteTypedDataV3InputDto`](../../crates/policy-engine-wasm/src/dto.rs)는 필수 `chain_id: u64`, `verifying_contract: String`, `primary_type: String`, `message: Value`, `submitter: String`, `submitted_at: u64`와 선택적 `domain_name: Option<String>`, `witness_type: Option<String>`을 받는다. `domain_name` 누락/null은 빈 문자열로 출력되며 필수 필드로 오인하지 않는다. 다음은 기존 축약 경로용 완전한 정상 입력 예시다.

```json
{
  "chain_id": 1,
  "verifying_contract": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "primary_type": "Permit",
  "domain_name": "USD Coin",
  "message": {
    "owner": "0x1111111111111111111111111111111111111111",
    "spender": "0x2222222222222222222222222222222222222222",
    "value": "1000000",
    "nonce": "7",
    "deadline": "1738002000"
  },
  "submitter": "0x3333333333333333333333333333333333333333",
  "submitted_at": 1738000000
}
```

기존 route는 submitter/verifying contract 주소 파싱 → typed key 조회 → ABI 기반 flat/wrap 변환 → emit → offchain meta 순서다. 실제 permit ABI에서 서명용 인자 owner/v/r/s를 필터링한 뒤 scalar가 여러 개 남으므로 **flat message**를 사용한다. 기존 Rust의 `typed_data_erc2612_permit_flat_unwrapped`는 DAI/synthetic `@2.0.0` fixture이므로 flat 규칙 참고 자료일 뿐, 이번 실제 USDC 원본의 대체물이 아니다.

작성 사례는 0·일반·uint256 MAX, 주소 대소문자와 token/spender/submitter 구분, 정상 형식의 미등록 chain/contract/primaryType/witness, 필수 DTO 누락·타입·주소·음수 오류, emit의 spender/value/deadline 누락·형식 오류와 message 배열을 포함한다. 수량 기대값은 고정 문자열과 `BigInt`로 독립 검산하고 실제 출력에서 생성하거나 큰 정수를 JS `Number`로 바꾸지 않는다. 작성한 요청은 정상 5개, 매칭 실패 4개, DTO 입력 오류 17개, emit 오류 11개, 현재 한계 관찰 7개로 44개이며 구조 검사 3개를 더해 47개 정의다. 정확한 case ID는 [coverage](../../fixtures/decoder-policy/coverage.md)가 기준이며 04a 사용자 실행에서 47개 모두 통과했다.

| 관찰 대상 | 기존 소스상 동작·04a에서 작성한 검사 | SDK 엄격 경로에서 요구할 동작 |
| --- | --- | --- |
| message.owner / message.nonce | emit이 읽지 않으므로 누락/형식 오류도 성공할 수 있음. `legacy_observation`으로 분리하며 정상 EIP-712 사례로 세지 않음 | owner 주소, signed nonce uint256 필수 검증. Action에 owner가 없다는 사실은 검증 증거가 아님 |
| domain_name | 매칭 키가 아니며 요청 값을 meta에 출력. mismatch/누락/null 허용 사례는 현재 한계 관찰 | 선언된 `USD Coin`의 존재·정확한 일치 검사. version/salt 정답을 새로 만들지 않음 |
| types / domain.version / domain.salt | DTO에 없음. 현재 축약 경로의 성공은 전체 서명 요청 검증이 아님 | 원본 보존, manifest type 대조와 선언 domain 제약 검사 |
| signed nonce / live nonce | `message.nonce = "7"`이어도 `Action.body.nonce.value = "0x0"` 예상. source=`onchain_view`, `nonces(address)`, decoder=`erc20_permit_nonce`, TTL=12, synced_at=제출 시각 | signed nonce 원문/정규화 값을 별도 보존. live nonce는 외부 조회 요청용 stub이며 체인상 현재 nonce나 신선한 Fact로 승격하지 않음 |
| offchain meta | `kind: "offchain_sig"`, 요청 name·chain·contract와 deadline. `version`/`salt`/`nonce_key`/`reenter_callback`의 None은 serde 규칙에 따라 생략 | 전체 원본은 별도 요청 문맥에 보존하며 기존 Action 필드로 투영 가능한 값만 정확히 전달 |

위 04a 시험의 정상·오류·legacy observation은 사용자 실행에서 통과했다. 아래 별도 deadline overflow 분석은 실행 재현하지 않았다. nonce 현재값·서명 복구/암호 검증·deadline 만료/실행 가능성·최종 allow/warn/deny는 04a에 추가하지 않는다. owner와 submitter의 동일성을 임의로 강제하지 않는다.

#### 04b — 기존 소비자 조사와 호환 경계

| 실제 소비자·시험 | 현재 계약과 유지할 내용 |
| --- | --- |
| [`sig-routing.ts`](../../browser-extension/backend/service-worker/sig-routing.ts)의 `routeTypedSignaturePayload` → `routeTypedData` | payload의 원본 object/JSON 문자열을 받아 주소를 소문자로 정규화하고 chain을 양의 안전 정수로 파싱한다. 타입 이름은 대소문자/colon을 보존하고 길이 1–128 및 route 이름 문자 검사를 사용한다. witness는 types[primaryType]의 `witness` 선언에서 추출. 전체 type 검증 함수는 아님 |
| [`sig-routing.test.ts`](../../browser-extension/backend/service-worker/__tests__/sig-routing.test.ts) | JSON 문자열, malformed chain/path key의 null, colon 타입명, witness 전달/생략, 설치 miss의 null, 설치/route 장애의 `TypedDataRouteError`를 확인. USDC 사례는 domain.name을 lookup에서 제외한다고 명시하며 mocked 결과 ID도 실제 원본과 다름. mock marshalling 시험을 실제 WASM·원본 검증으로 취급하지 않음 |
| [`wasm-bridge.ts`](../../browser-extension/backend/service-worker/wasm-bridge.ts)의 `DeclarativeRouteTypedDataV3Input` / `declarativeRouteTypedDataV3` | camelCase를 축약 snake_case DTO로 변환해 실제 v3 export 호출. types/version/salt는 버려짐. 성공은 actions/decoder_id, 오류는 nonthrowing envelope. 주석의 모든 fault→miss 설명과 달리 상위 `routeTypedData`는 WASM 오류를 throw함 |
| [`orchestrator.ts`](../../browser-extension/backend/service-worker/orchestrator.ts)의 `typedSignatureLifecycle` | 위 라우터의 actions와 decoderId를 받아 기존 plan/evaluate 흐름 및 audit에 사용. miss/fault를 구분하며 호스트 판정도 존재하므로 strict 오류를 v3에 넣으면 제품 동작이 바뀜 |
| [`lib.rs`](../../crates/policy-engine-wasm/src/lib.rs), 기존 typed Rust 시험 | v3 export 재공개 및 synthetic/실제 manifest 시험이 존재. 기존 축약 호출의 필수 types/domain 오류를 새로 만들지 않음 |

현재 Node fixture는 확장 `sig-routing.ts`·`wasm-bridge.ts`를 import하지 않는다. 새 strict 정규화/검증은 Rust 경계에 둔다. 기존 순수 helper의 의미를 대응표와 입력 사례로 검증하며 Chrome loader/storage를 Node에 끌어오지 않는다. `packages/core` 공개 API·소스 이관은 이번에 만들지 않는다.

#### 04b — 전체 입력·출력 계약 (네 계약 답변 수신·반영 완료)

**사용자 결정:** 기존 v3 축약 DTO/export는 그대로 두고 별도 v4 full-input export를 추가한다. 서명 대상 지갑의 입력 이름은 `requested_signer`로 명확히 한다. 이하 `declarative_route_typed_data_v4_json`, `DeclarativeRouteTypedDataV4InputDto`의 세부 구조는 네 답변에서 합의한 의미를 구체화해 구현했다. 에이전트가 선택한 필드 배치·오류 이름을 사용자가 직접 선택한 것으로 기록하지 않는다. `v4`는 입력 계약의 버전이며 Registry manifest/index schema는 기존 v3 그대로다. strict 실패와 미지원 결과를 v3로 자동 재호출하지 않는다. full 입력 예시:

```json
{
  "requested_signer": "0x1111111111111111111111111111111111111111",
  "submitter": "0x3333333333333333333333333333333333333333",
  "submitted_at": 1738000000,
  "typed_data": {
    "domain": {
      "name": "USD Coin",
      "version": "example-version",
      "chainId": "0x1",
      "verifyingContract": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000001"
    },
    "types": {
      "Permit": [
        { "name": "owner", "type": "address" },
        { "name": "spender", "type": "address" },
        { "name": "value", "type": "uint256" },
        { "name": "nonce", "type": "uint256" },
        { "name": "deadline", "type": "uint256" }
      ]
    },
    "primaryType": "Permit",
    "message": {
      "owner": "0x1111111111111111111111111111111111111111",
      "spender": "0x2222222222222222222222222222222222222222",
      "value": "1000000",
      "nonce": "7",
      "deadline": "1738002000"
    }
  },
  "routing": {
    "chain_id": 1,
    "verifying_contract": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "primary_type": "Permit"
  }
}
```

`example-version`와 salt는 **보존을 설명하는 값**이며 실제 USDC의 올바른 domain이나 서명 가능성을 주장하지 않는다. 원본 manifest는 version/salt를 선언하지 않는다. EIP712Domain 선언을 types에 포함하는 입력도 보존하며, 존재할 때 그 필드의 선언 타입과 실제 domain 값을 검증한다. manifest에 없는 EIP712Domain 필드 배열의 정답을 임의로 추가하지 않는다.

- `requested_signer`는 요청자가 제공한 서명 대상 지갑 주소이며 서명 복구로 확인한 주소가 아니다. strict ERC-2612 Permit에서는 정규화 owner와 requested_signer의 일치를 **요청 일관성 조건**으로 검사하고 불일치하면 명시적 오류를 반환한다. `submitter`는 별도 제출 주체이며 owner와 달라도 허용해 대리 제출을 지원한다. submitter는 선택 필드이며 생략 시 정규화 문맥에서 requested_signer를 사용한다. 원본 문맥은 각 주소 원문과 생략 여부까지 보존한다. 기존 Action.meta.submitter에는 정규화 submitter, 제출 시각에는 명시적 `submitted_at`을 넣는다. strict Rust 경계에서 현재 시각을 암묵적으로 생성하지 않는다.
- `typed_data`는 원본 객체 또는 원본 JSON 문자열을 받는 명시적인 union이다. 문자열이면 원문을 `request.original.typed_data_json`에 유지하고 한 번 파싱한다. 입력 envelope의 `typed_data_json`은 예약 필드로 거절하여 원문 덮어쓰기를 막는다. object 입력은 이미 호출자에서 파싱된 값이므로 이전 공백/키 순서/이미 잃은 숫자 비트를 복원했다고 주장하지 않는다. JSON 밖 bigint는 받지 않으며 호스트는 큰 정수를 문자열로 전달한다.
- 성공 결과는 기존 `data.actions`, `data.decoder_id`에 strict 전용 `data.request`를 더한다. `request.original`은 requested_signer/submitter/submitted_at과 domain/types/primaryType/message 원문 객체를 보존한다. 외부 `routing`의 원문 값과 각 필드의 존재 여부도 `request.original.routing`에 보존하여 생략된 필드를 기본값으로 채우거나 원문의 hex/대소문자를 덮어쓰지 않는다. 문자열 입력이면 `request.original.typed_data_json`도 보존한다. `request.routing`에는 추출·정규화한 chain/contract/primaryType과 검증된 선택 witness를 따로 둔다. raw domain 주소나 hex chain을 소문자/숫자로 덮어쓰지 않는다.
- `request.validated`에는 정규화한 owner/requested_signer/submitter, uint256 decimal string인 `signed_nonce`, `deadline_seconds`를 둔다. 이 이름은 입력 형식·요청 일관성 검사를 통과했다는 뜻이며 서명이 유효하다는 뜻이 아니다. 성공 결과에도 **실제 서명 미검증 상태**를 명시한다. 구현한 표시 위치는 `data.request.validation.signature_verification: "not_performed"`다. signed nonce는 `Action.body.nonce` 외부 조회 필드와 별개이며 Action body에 owner/nonce를 덮어쓰지 않는다. 실패 시에도 호출자는 원본 입력을 유지하고 오류 경로로 연결한다.
- `routing`은 선택적 대조 입력이다. domain에서 chain/contract를 추출하고, 둘 다 있으면 정규화 뒤 일치해야 한다. 바깥 primary_type과 typed_data.primaryType도 정확히 일치해야 한다. 바깥 witness_type만 믿지 않으며 type graph에서 얻은 값과 대조한다. 어느 값을 우선해 충돌을 숨기지 않는다.
- strict meta의 domain은 기존 `Eip712Domain` 필드를 재사용해 name/version/salt를 보존한다. chain/contract는 정규화 값이다. 기존 None 생략 규칙을 유지한다. 공통 Action/Time의 wire 변경 없이 요청 원문 문맥을 별도로 반환한다.

#### 04b — 검증 순서·오류의 구체적인 차이

아래 **기본 입력 형식/routing-domain 충돌 → lookup → 지원 manifest의 types/domain/message → owner/requested_signer 요청 일관성·deadline 표현 범위 → emit** 순서는 사용자 답변으로 확정했다. 미등록 contract와 malformed owner가 함께 있으면 미지원이 우선이다. 미지원은 **지원 범위 밖이므로 상세 검증하지 않음**이며 검증 성공이나 유효한 서명 판정이 아니다. 지원하는 Permit은 상세 검증을 모두 통과해야 성공한다. 아래 오류 코드와 선택적 점 표기 `error.path`를 구현했다. strict 실패·미지원 결과를 축약 v3 경로로 자동 재시도하지 않는다.

1. 기존 입력 크기 검사 후 envelope와 원본 JSON을 파싱한다. domain/types/message의 객체 여부, primaryType의 문자열 여부, requested_signer/submitter 주소, submitted_at 정수·안전 범위를 확인한다. 필수 객체 누락/배열/null·잘못된 envelope 주소는 입력 오류다. message.owner 등 상세 필드 검증은 지원 여부를 확인한 뒤 수행한다. submitted_at은 `0..9007199254740991`의 정수 JSON number로 제한했다.
2. domain chain/contract와 primaryType을 추출한다. chain은 기존 TS 의미대로 양의 안전 정수 number 또는 온전한 decimal/`0x` hex 문자열로 받되 계산은 BigInt/u64로 하고 손실을 거절한다. `"1-mainnet"`, `"0x1g"`는 오류이며 1로 잘라 쓰지 않는다. 기존 TS가 거절하는 `0X` prefix도 새 경로에서 몰래 허용하지 않는다. 주소는 기존 TS routing helper와 같은 `0x` + 40 hex 문자열을 요구하고 소문자로 정규화한다. zero address는 형식상 허용하며 checksum/새 주소 안전성 기준을 추가하지 않는다. 기존 Rust가 더 느슨한 주소 표현을 받을 수 있는 v3와의 차이는 strict wire 형식 제한으로 명시한다. type 이름은 정확한 대소문자와 기존 route 문자/길이 규칙을 보존한다.
3. 선택적 외부 routing 값을 같은 방식으로 파싱한 뒤 domain과 대조한다. 예: domain.chainId=`"0x1"`, routing.chain_id=`10`이면 `typed_routing_mismatch`이며 lookup을 하지 않는다.
4. 설치된 typed bridge를 조회한다. 기본 형식과 충돌 검사를 통과한 미등록 chain/contract/primaryType은 `no_typed_data_mapper`를 반환한다. message.owner가 malformed여도 이 단계에서는 미지원이 우선이며 해당 message를 상세 검증하지 않는다. 04b에서 지원하지 않는 다른 설치된 typed 계약은 `unsupported_typed_data_contract`로 구분하고 Permit2 구현을 섞지 않는다. 두 미지원 모두 검증 성공이 아니다.
5. 매칭된 manifest의 typed 타입과 domain 선언을 읽는다. manifest 자체의 선언 결함은 `invalid_bundle`이다. 요청 primaryType의 정의와 도달 가능한 type graph를 확인한다. 필드 이름 중복·누락 참조·잘못된 scalar/array 타입을 `invalid_typed_data`로 거절한다. 이어 manifest가 도달 가능한 각 struct의 **이름, 필드 배열 순서, 필드 이름, 정확한 타입과 참조 관계**를 대조한다. 실제 Permit은 위 다섯 필드의 flat graph이므로 `uint`/`uint128` 대체, owner/spender 순서 교환, 추가 필드, 다른 struct 참조를 허용하지 않는다. 필요 없는 타입 정의는 원문에 보존하되 Permit 지원 범위를 확장하는 근거로 쓰지 않는다.
6. manifest가 명시한 domain 항목을 대조한다. 이 원본에서는 chain/address 매칭 및 `name === "USD Coin"`가 제약이다. 이름의 대소문자/공백을 임의 보정하지 않는다. version은 문자열, salt는 bytes32 형식을 확인하고 원문을 보존하며, 실제 원본이 선언하지 않은 특정 version/salt 값과 비교하지 않는다. type graph의 EIP712Domain 선언이 있으면 실제 domain과 타입이 맞는지 검사한다.
7. 모든 필수 message 값을 검증한다. owner/spender는 주소, value/nonce/deadline은 `0..2^256-1`의 정수다. 문자열은 `[0-9]+` decimal 또는 `0x` 뒤 한 자리 이상의 hex만 허용하고, 빈 문자열/빈 `0x`/공백/지수 표현을 거절한다. 안전 정수 JSON number도 정확히 읽고 정규화한 수치는 문자열로 보존한다. 직접 JSON의 소수점/지수 number 표기는 반올림을 피하기 위해 거절한다(호스트 객체의 정수는 JSON.stringify에서 정수 표기로 전달된다). 원문에 보존하는 추가 numeric leaf도 signed 안전 정수 JSON 표기만 허용하며 그 밖의 숫자는 문자열로 전달한다. 기존 U256 parser의 느슨한 입력 수용과 strict 어휘 규칙의 차이를 회귀 표에 남긴다. 누락/null/bool/배열/분수/음수/범위 초과를 거절한다. 객체 키 나열 순서는 무관하지만 `types.Permit`의 배열 순서는 서명 구조의 일부이므로 정렬해서 통과시키지 않는다. 알려진 Permit message의 선언 밖 추가 필드는 strict 입력 오류다. 지원 domain에서도 표준 필드 밖의 값은 거절하며, EIP712Domain 선언이 있으면 실제 domain 필드 집합·타입과 대조한다. 오류는 원문을 반환하지 않으므로 호출자가 보존한다.
8. 형식 검증을 마친 owner와 requested_signer를 같은 주소 규칙으로 정규화해 요청 일관성을 검사한다. 대소문자만 다르면 일치하며 원본 주소는 각각 유지한다. 서로 다른 주소면 명시적 오류를 반환한다. 오류 이름은 `typed_requested_signer_mismatch`, path는 `typed_data.message.owner`, 대조 대상은 `requested_signer`다. submitter와의 일치를 요구하지 않는다. 이어 아래 합의한 deadline 표현 범위를 검사한다. 주소 일치를 실제 서명 검증으로 취급하지 않으며 결과에 미검증 상태를 표시한다.
9. 기존 flat/wrap·emit을 재사용한다. strict에서 정규화한 deadline 하나로 body와 meta를 구성하며 두 값이 다르면 내부 오류다. emit에 필요한 필드는 모두 검증된 상태이므로 이 이후 builder 실패는 malformed와 구분한 `typed_interpretation_failed`로 원인과 decoder ID를 보존한다.

| 최소 변경 입력 (위 full 예시 기준) | 구현한 strict 결과·오류명 | 기존 축약 경로와 차이·회귀 목적 |
| --- | --- | --- |
| types를 생략 | `invalid_typed_data`, path=`typed_data.types` | v3에는 필수 types를 새로 요구하지 않음 |
| owner 누락 / nonce=`"-1"` / value=`2^256` 문자열 | `invalid_typed_data`, 해당 message 필드 path | owner/nonce는 현재 emit에 안 쓰여 성공할 수 있음 |
| Permit 첫 두 필드 순서 교환 / value 타입=`uint128` | `invalid_typed_data`, 해당 types 필드 path | v3는 요청 types를 받지 않음 |
| Permit.owner 타입=`MissingOwner`, 해당 정의 없음 | `invalid_typed_data`, 누락 참조 path | ABI wrap 규칙은 요청 type graph 검증이 아님 |
| domain.name=`"Other Token"` | `typed_domain_mismatch` | v3는 요청 name을 출력하므로 의도적인 strict 의미 변경 |
| domain.chainId=1 / routing.chain_id=10 | `typed_routing_mismatch` | v3는 중복 전체 domain을 받지 않음 |
| 정상 envelope·미등록 primaryType=`OtherPermit` | `no_typed_data_mapper` | lookup miss이며 악성·deny·유효한 서명 판정이 아님 |
| owner=`"bad-owner"` + domain/routing contract 모두 정상 형식의 미등록 주소 | 미지원 우선. 코드 `no_typed_data_mapper` | 상세 owner 검증을 수행하지 않았음을 명시. 검증 성공으로 표시하거나 v3로 자동 재시도하지 않음 |
| 지원 Permit의 owner=`"bad-owner"` | 명시적 형식 오류. 코드 `invalid_typed_data`, path=`typed_data.message.owner` | 등록/지원된 Permit은 상세 필드 검증 수행 |
| owner=`"0x4444444444444444444444444444444444444444"`, requested_signer는 기존 값 | 명시적 요청 일관성 오류. 코드 `typed_requested_signer_mismatch`, path=`typed_data.message.owner`, 대조 필드=`requested_signer` | 오류는 제공된 요청 주소 불일치이며 서명 복구 실패가 아님 |
| owner와 requested_signer를 같은 hex 주소의 서로 다른 대소문자로 제공 | 정규화 후 일치하여 다른 조건도 유효하면 성공. 각 원문 주소 보존 | 성공에도 `signature_verification: "not_performed"` 표시를 검사 |
| owner=requested_signer, submitter는 예시처럼 다른 정상 주소 | 다른 조건도 유효하면 성공, 별도 submitter 보존·Action.meta 반영 | 대리 제출 허용. owner와 submitter의 일치를 요구하지 않음 |
| 정상 문자열 version / 정상 bytes32 salt를 다른 값으로 변경 | 다른 조건도 유효하면 성공, 원문 보존 | manifest가 선언하지 않은 특정 version/salt 기대값을 만들지 않음 |
| 지원 Permit의 version을 number / salt를 bytes32가 아닌 문자열로 변경 | 명시적 형식 오류. 코드 `invalid_typed_data`, 해당 domain 필드 path | 보존만으로 검증을 생략하지 않음 |
| strict 형식 오류·주소 불일치·미지원 각 결과 | 원래 strict 결과를 유지하고 v3 호출 0회 | 기존 v3 단독 호출의 행동은 유지하되 자동 fallback 금지 |
| 검증된 Permit인데 emit 구조 결함 | `invalid_bundle` 또는 `typed_interpretation_failed` | 내부 해석 결함을 지원 없음으로 숨기지 않음 |

strict 오류는 `error.kind/message`에 필드 `path`를 선택적으로 추가하는 별도 JSON envelope를 사용한다. 기존 v3 오류 envelope는 유지한다. 위 코드들은 정책 판정이 아니라 입력·지원·내부 오류 분류다.

#### 04b — deadline 정밀도 판단 (정적 검토, 재현 미실행)

최소 입력은 위 **04a 축약 예시의 message.deadline만 `"18446744073709551616"` (`2^64`)으로 교체**한 요청이다. [`action_builder.rs`](../../crates/adapters/mappers/src/declarative/action_builder.rs)의 `coerce_decimal_string_to_u64`는 trim한 decimal 문자열의 u64 parse 실패를 `u64::MAX`로 포화시킨다. [`declarative_exports.rs`](../../crates/policy-engine-wasm/src/declarative_exports.rs)의 `message_u64`는 원문 parse 실패를 None으로 반환하고 meta는 `unwrap_or(0)`를 사용한다. 따라서 **코드상 body.deadline=`2^64-1`, meta.deadline=`0`이 예상**된다. 실행으로 재현한 결과가 아니며 04a의 올바른 성공 기대값으로 고정하지 않는다. 공백 있는 decimal 문자열도 두 파서의 trim 차이 때문에 별도 검토 대상이다.

[`Time`](../../crates/policy-server/asset-model/state/src/primitives/time.rs)은 u64이고 JSON number로 직렬화한다. Time 상한 `18446744073709551615`와 JS 안전 정수 상한 `9007199254740991`은 다르다. 예를 들어 `9007199254740993`은 u64 안에 있어도 일반 JS JSON.parse에서 정확히 보존되지 않는다. deadline가 uint256 범위라는 사실이 Action·meta의 시간 표현 가능성을 보장하지 않는다.

**사용자 결정 A 확정:** raw deadline의 uint256 값을 보존하고 기존 Action/meta의 JSON number 형식을 유지한다. strict deadline은 `0..9007199254740991`만 무손실 투영하고 JS 안전 정수 범위 초과를 명시적 오류로 거절한다. 포화·0 대체·반올림된 성공은 허용하지 않는다. 오류 이름은 구현에서 `typed_deadline_out_of_range`로 정했다. `submitted_at`에도 같은 안전 범위를 적용하고 초과를 `invalid_typed_data`로 분류한다. 이 세부 구현 선택을 사용자가 오류 이름까지 직접 선택한 것으로 기록하지 않는다. 이는 uint256 자체가 malformed라는 뜻이 아니라 **현재 결과 계약의 표현 한계**다. `0`, `2^53-1`, `2^53`, `2^53+1`, `2^64-1`, `2^64`, `2^256-1`, `2^256`을 문자열/number별로 구분한 04b 시험을 작성한다. JS에서 이미 unsafe number로 받은 값도 거절한다.

선택하지 않은 대안은 strict 전용 lossless 결과에서 Action/meta의 시간 필드를 decimal string으로 표현하는 것이다. `2^64-1`까지는 내부 Time와 변환 가능하지만 그 이상은 기존 Action을 그대로 생성할 수 없으므로 별도 typed 결과 모델 또는 표현 불가 상태가 더 필요하다. raw uint256을 별도 필드에 붙이는 것만으로 포화된 Action을 정확하다고 만들 수 없다. 따라서 이는 SDK 소비자와 planner 입력의 변환까지 합의해야 할 별도 확대안이며 공통 Time 일괄 변경으로 처리하지 않는다. deadline의 만료 여부나 실제 체인 실행 가능성은 두 안 모두 판단하지 않는다.

#### 04b — 계약 결정 네 묶음

| 결정 | 사용자 확정 내용 | 구현 설계·호환 영향 |
| --- | --- | --- |
| 입력 보존·진입점 — **A 확정** | 사용자 선택: 기존 v3 축약 DTO 유지 + 별도 full-input v4 export. original/routing/validated 세부 구조는 의미를 구체화한 구현 선택 | v3 mode/version union은 선택하지 않음. 기존 호스트의 축약 경로 유지 |
| deadline 표현·JS 정밀도 — **A 확정** | 사용자 선택: raw uint256 보존, 기존 Action/meta 형식 유지, strict deadline의 `2^53-1` 초과 명시적 오류 거절. 오류 이름·submitted_at 세부는 위 구현 선택 | strict 전용 문자열 시간 wire는 선택하지 않음. 공통 Time 일괄 변경 없음 |
| owner·requested_signer·submitter 관계 — **확정** | requested_signer는 요청자가 제공한 서명 대상 지갑. strict ERC-2612에서 정규화 owner와의 요청 일관성을 검사하고 불일치를 명시적 오류로 반환. submitter는 별도 보존하며 달라도 허용 | 각 주소 원문 유지. 일치해도 실제 서명 미검증 상태 표시. 오류 이름과 결과 표시 필드 배치는 위 구현 선택 |
| domain 제약·오류 우선순위 — **확정** | 기본 형식/routing-domain 충돌 → lookup → 지원 manifest의 types/domain/message → owner/requested_signer 일관성·deadline 표현 → emit. 선언 name/chain/contract/types 대조, version/salt는 원본 보존·형식 검사만 | 미등록 contract+malformed owner는 미지원 우선이며 상세 검증하지 않았다는 의미. 지원 Permit은 상세 검증. v3 유지, strict 실패·미지원의 v3 자동 fallback 금지 |

04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. 미응답 계약 항목은 없다. 구체적 필드 배치·오류명·submitted_at 범위는 확정된 의미 안에서 구현한 세부 선택이다.

#### 04b — 변경 파일·검증·분리 커밋 경계

| 변경 파일·관련 회귀 | 구체적인 역할·호환 영향 |
| --- | --- |
| `crates/policy-engine-wasm/src/dto.rs` | full DTO와 strict 결과·진단 타입 추가. v3 DTO의 필수 필드·기본값 유지 |
| `crates/policy-engine-wasm/src/declarative_exports.rs` | strict 입력 검증·원문/정규화 분리·선언 types/domain 대조·owner/requested_signer 요청 일관성·대리 submitter 허용·실제 서명 미검증 표시, 검증된 동일 deadline 투영, 합의한 오류 우선순위와 기존 emit 재사용. 기존 v3 함수의 오류/의미 유지, strict 실패·미지원의 자동 fallback 없음 |
| `crates/policy-engine-wasm/src/typed_data_validation.rs` (신규) | 순수 Rust의 prepare/validate_manifest. 기본 형식·routing, 반복형 type graph 검증, 지원 domain/message·주체·안전 시간 검사 |
| `crates/policy-engine-wasm/src/lib.rs` | 별도 strict export 재공개. generated pkg는 직접 편집하지 않고 재빌드 |
| `crates/policy-engine-wasm/tests/declarative_v3_typed_data_strict.rs` (신규) | 실제 permit 원본을 설치해 full 정상/필수 필드/형식·범위/graph·order/domain·routing 충돌/시간 경계, owner/requested_signer 불일치·대소문자 일치·submitter 차이 허용·서명 미검증 표시·원문 보존, 미등록 contract+malformed owner의 미지원 우선 및 지원 Permit 상세 오류 검사. 파일명의 v3는 Registry schema 회귀를 뜻함 |
| 기존 `declarative_v3_typed_data_install.rs`, `declarative_v3_route.rs` | v3 typed·transaction 호환 회귀. synthetic 과거 사례를 실제 USDC 기준선 대체물로 바꾸지 않음 |
| `fixtures/decoder-policy/typed-permit-strict.cases.json`, `typed-permit-strict.test.mjs`, `helpers/wasm-worker.mjs`, root `package.json` | strict 요청 kind를 별도로 추가하고 실제 새 WASM export에 연결. 위 계약·오류 우선순위와 strict 실패·미지원 시 v3 자동 호출 없음 검사. 04a characterization과 기존 58개를 유지한 회귀 |
| README·coverage·두 계획서 | 04a 실행 결과와 선택한 04b 계약을 반영. 04b 구현/검증 결과를 별도 기록하고 알려지지 않은 hash/HEAD/시각을 과거 값으로 채우지 않음 |

순수 validator를 `src/typed_data_validation.rs`로 분리했다. 기존 `action_builder.rs`의 포화 변환·공통 Time·v3 route와 확장 소비자는 유지한다. strict만 검증된 flat 인자를 실제 emitter에 전달하고 body/meta deadline 일치를 확인한다. SDK Core API·확장 loader 이관은 후속 단계다.

Node strict는 shared fixture 요청 163개 + 구조 검사 5개 = 168개를 작성했고, 기존 네 파일의 105개를 유지한 통합 정의는 273개다. 저장 로그에서 strict 168/168·통합 273/273 모두 통과했다. Native strict integration은 같은 JSON fixture와 raw JSON/내부 emit 결함/설치된 다른 typed 계약/v3 호환 사례를 검사한다.

04b 정적 검토: 수정/관련 JS 4개 `node --check`, 설치된 Rust formatter의 새 코드 형식·5개 Rust 파일 구문 확인, 문서 shell 블록 8개 `bash -n`, JSON·고정 수량·주소·원본 7개 hash 대조, 기존 v3 함수의 바이트 동일성 및 04a patch 경계를 확인했다. `git diff --check`와 신규 파일 공백 검사도 문제없다. 이는 구현 당시 에이전트의 정적 검토 기록이다. 에이전트는 Rust 컴파일·Registry/WASM/Node 시험을 직접 실행하지 않았으며, 후속 사용자 실행 로그의 성공은 아래 별도 기록으로 확인했다.

**완료된 사용자 실행 순서:** Native strict integration → 기존 typed install·transaction route·route helper 회귀 → 새 WASM 직접 빌드 → strict 개별·기존 typed 개별·전체 Node 시험. 빌드 실패 시 과거 pkg로 진행하지 않는다. 도구 준비·로그/hash 기록·정확한 명령은 [README](../../fixtures/decoder-policy/README.md#사용자가-직접-실행할-준비빌드시험-명령)를 따른다. 에이전트는 빌드·시험·설치·Git 변경 명령을 실행하지 않는다.

04b 재개 시 04a 10개 파일이 HEAD `b102713` 위에 미커밋 상태여서 patch로 경계를 보존했다. 이후 사용자 커밋 04a `593ea16`과 04b `e487805`로 실제 분리됐다. 기존 커밋을 다시 만들거나 patch를 다시 적용하지 않는다. 현재 검증 완료 기록은 문서 네 파일에만 추가하며 생성물·로그는 커밋하지 않는다.

DEC-05 자동 진행, transaction selector 개선, Permit2/multicall/Core/네트워크·정책/암호 검증/소스 이관/CI 확대는 포함하지 않는다. 현재 04b 사용자 실행 검증까지 확인하여 DEC-04 완료로 기록한다. D2·SDK 전체 완료와는 구분한다.

#### 04b — 저장 로그 확인·완료 기록

사용자 실행 로그 `/private/tmp/dambi-dec04b-verify.OepBZF/`를 읽어 다음 결과를 확인했다. 에이전트의 재실행이 아니다.

| 검증 | 실제 통과 | 실행 시간 |
| --- | --- | --- |
| Native strict / typed install / route / helpers | 7 / 7 / 138 / 29개 (합계 181개) | 0.05 / 0.01 / 0.07 / 0.01s |
| Node strict | 168/168 | 943.529416ms |
| Node 기존 typed | 47/47 | 514.873041ms |
| Node 통합 | 273/273 | 901.401958ms |

각 Native 실패·ignored·measured는 0이다. helpers의 66개 filtered out은 지정한 모듈 외 시험이며 통과 수에 넣지 않는다. Node 세 실행은 suites·fail·cancelled·skipped·todo 모두 0이다. `timeline.log`의 Native 시작은 `2026-09-11T10:09:50Z`, 새 WASM 빌드는 `10:10:27Z–10:11:21Z`, Node는 `10:11:21Z–10:11:24Z`이고 세 그룹 모두 exit=0이다. 개별 시험별 timestamp는 기록되지 않았다.

실행 HEAD는 전후 `b10271365ce06a944b5672d833545db42b243881`이며 DEC-04 미커밋 변경을 포함한 worktree에서 검증했다. 이후 04a `593ea166421b3cff7bdc6f2fa0704143f64bd389`와 04b `e487805bdb86451a6c9688f7b2dcce399cc13892`로 분리 커밋됐다. 전후 tracked patch·Git 상태가 같고, 로그에 기록한 입력 24개는 현재 파일과 `e487805`의 Git blob에 모두 일치한다. 추적된 11개 경로 patch도 해당 커밋 diff와 일치한다. 현재 JS/WASM 2개 hash도 기록값과 같으며 로그의 사후 검사는 입력 24개·산출물 2개 모두 OK다. 실행 HEAD를 현재 커밋으로 대체하지 않는다.

실제 도구는 Rust/Cargo 1.95.0, wasm-pack 0.14.0, Node v25.9.0, npm 11.12.1이며 `CARGO_TARGET_DIR=/tmp/dambi-dec04b-verify.OepBZF/target`, release opt-level=z를 사용했다. 상세 빌드 명령·두 산출물 SHA-256·비차단 빌드 안내는 [README](../../fixtures/decoder-policy/README.md#dec-04b-실행-기록--저장-로그-확인dec-04-완료)의 별도 실행 기록에 보존한다. **04a/04b 구현·분리 커밋·사용자 실행 검증을 완료하여 DEC-04 완료**로 기록한다. D2 전체·SDK 전체 독립화는 미완료이며 DEC-05로 자동 진행하지 않는다. 이번 네 문서 갱신에 재시험은 필요하지 않다.

### DEC-05 — Permit2 Single → Batch · 전체 계획 D2

**05a: 구현 완료, 사용자 실행 대기.** 실제 [`registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json)의 바이트 SHA-256 `0x6657c04696e97d08aaa80cc842d3d7976df7515953e7506fa97e50bd2812e696`를 selection에 고정했다. approve + USDC permit + Single을 `includePermit: true, includePermit2Single: true`로 선택한다. 기존 builder 기본값·선택별 반환 구조·원본 hash 검사·실패 시 임시 정리를 유지하며 Single 선택 때만 `permit2SingleSource`를 더한다. worker의 기존 typed 분기와 실제 WASM v3 경로를 재사용한다. Rust/manifest 변경은 없다.

선택된 실제 원본 → `--strict-callkeys` Registry builder → typed index 참조 해소 → resolved bundle JCS digest → 실제 `declarative_install_v3_json` → `declarative_route_typed_data_v3_json`을 연결하도록 작성했다. callkey는 9개(approve 4 + USDC 1 + Single 4), typed index는 5개(USDC 1 + Single 4), selector index는 0개다. Permit2 두 실제 manifest는 체인 `1/10/8453/42161`의 구체 주소 `0x000000000022d473030f116ddee9f6b43ac78ba3`를 직접 선언한다. USDC token 목록은 approve 확장용이며 Permit2 주소를 확장하지 않는다.

| 실제 파일 / 기존 Rust 상수 | 정적 대조한 차이·새 시험의 원본 선택 |
| --- | --- |
| 실제 Single `permitSingle@1.0.0.json` | `adapter_action`, schema 3, `@1.0.0`, 네 체인, 완전한 `PermitSingle`/`PermitDetails` 선언. emit은 `$args.permitSingle[0][0..3]`, `[1]`, `[2]`의 positional 경로로 token/amount/expiration/**nonce**·spender/sigDeadline 전달 |
| Rust `PERMIT2_PERMIT_SINGLE_V3` | [`declarative_v3_typed_data_install.rs`](../../crates/policy-engine-wasm/tests/declarative_v3_typed_data_install.rs)의 synthetic JSON literal. `adapter_function`, schema 2, `@2.0.0`, chain 1만, `PermitDetails` 정의 없음. named emit 경로이며 body nonce 없음. 실제 파일을 읽는 시험이 아님 |
| 실제 Batch `permitBatch@1.0.0.json` | 같은 schema 3·네 체인·완전한 types. `array_source: "$args.permitBatch[0]"`, `$inputs[0..3]`로 token/amount/expiration/**nonce**, 공통 spender/sigDeadline은 `$args.permitBatch[1..2]` |
| Rust `PERMIT2_PERMIT_BATCH_V3` | Single synthetic와 같은 schema 2·`@2.0.0`·chain 1 및 type 정의 차이. named emit·body nonce 누락 |
| Rust `PERMIT2_PERMIT_BATCH_ON_DISK_V3` | 이름과 “verbatim” 주석이 있어도 `include_str!`가 아닌 JSON literal. header/types/chains는 현재 원본과 같지만 `array_source: "$args.permitBatch.details"`, `$inputs.token` 등의 named emit과 body nonce 누락으로 실제 원본 바이트/의미와 다름 |

`build_typed_data_args_json`은 이미 emit의 positional root 참조를 감지하고 ABI components 순서로 named object를 tuple로 변환한다. 누락 component는 null이다. 객체 key 삽입 순서와 무관한 변환, EIP-2612 flat 경로 보존, 내부 positional 호환 입력을 검사한다. Single message에는 owner가 없으며 token·Permit2 verifying contract·spender·submitter를 구분한다. 수량/nonce/expiration의 `0`·일반·선언 MAX·MAX+1, nonce `255/256/513`, 필수 필드의 누락/null/잘못된 형식, 정상/큰 sigDeadline, lookup miss와 매칭 후 입력 오류를 정상·관찰·오류별로 나눴다. decimal string·BigInt로 기대값을 독립 검산하고 JS Number로 큰 정수 기대값을 만들지 않는다. 자세한 최소 입력·기대값·관련 소스는 [coverage의 미결 계약](../../fixtures/decoder-policy/coverage.md#dec-05a--작성한-검사와-미결-계약)을 따른다.

**nonce 계약 진단:** 실제 mapper는 signed U256 nonce를 `(word=floor(n/256), bit=n%256)`로 나눠 `LiveField<(U256,u8)>`에 넣는다. `513`의 현재 표현은 `["0x2",1]`이고 source는 `onchain_view`·해당 chain·Permit2 contract·`nonceBitmap(address,uint256)`·`permit2_nonce_bitmap`, ttl은 12, synced_at은 submitted_at이다. 서명 원문을 분해한 값으로 실제 조회값이나 단순 zero stub이 아니다. PermitSingle/PermitBatch AllowanceTransfer는 owner/token/spender별 순차 uint48 nonce이고 unordered bitmap은 SignatureTransfer다. [AllowanceTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer), [SignatureTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer).

nonce 누락/null/파싱 실패가 `["0x0",0]`으로 fallback할 수 있고 v3 변환은 `uint160/uint48` 선언 폭을 검사하지 않는다. `sigDeadline = "18446744073709551616"`은 body의 u64 MAX 포화와 meta 0으로 갈라지고, u64 안의 `"9007199254740993"`도 JSON→JS 단계에서 정밀도가 손실된다. DEC-04 strict의 원문 보존/JS 안전 투영 계약과 연관된 미결 문제다. 이 값들을 정상 Permit2 계약으로 고정하지 않는다.

**현재 결정:** 사용자는 교정안 구체화 후 **A — 연결 시험·교정 설계만 마무리**를 선택했다. 이번 범위는 확정됐고 런타임 계약 교정은 별도 범위로 남긴다. nonce 교정은 `Permit2SignAction`뿐 아니라 sync args·transition의 bitmap 소비에 영향을 준다. malformed/폭 거절은 기존 성공을 오류로 바꾸므로 구체 오류와 호환성 범위를 결정해야 한다. 아래 B/C는 미구현 제안이며 향후 별도 범위를 선택하면 필요한 최소 구현과 새 Rust/WASM 검증 절차를 다시 명시한다. v4 strict는 현재 USDC EIP-2612만 지원하며 ID만 추가하거나 실패 시 v3로 재시도하지 않는다.

#### DEC-05 계약 교정안 (A안 확정·B/C 미구현 제안)

사용자의 요청에 따라 교정안을 구체화했고 사용자가 **A를 선택**했다. 이번에는 v3 Single 연결 시험·진단과 교정 설계를 마무리한다. 아래 B/C의 Action tag·조회 decoder·오류 이름·새 지원 범위는 미구현 제안이며 확정 계약이 아니다. Rust·원본 manifest·worker·소비자를 변경하지 않는다.

| 선택지 | 구체 변경 범위 | 해결하는 문제·남는 문제 | 권장·검증 영향 |
| --- | --- | --- | --- |
| **A — 현재 baseline + 교정 설계 (사용자 확정)** | 실제 v3 Single 연결/진단 85개와 이 설계를 유지하고 사용자 실행 검증 | 실제 원본 연결과 현행 동작을 확인. nonce 모델·fallback·선언 폭·시간·v4 Permit2 미지원은 명시적 미결 | **사용자 선택 완료.** 검증된 JS/WASM 재사용, Single → 통합 358개 정의. 런타임 계약 교정은 별도 범위로 남김 |
| **B — v4 Single 입력 검증** | 기존 v3/USDC를 보존하고 별도 Permit2 full validator·원문/request 문맥·오류·시간 투영 검증 추가. emit 결과는 기존 `permit2_sign_allowance` | malformed nonce fallback·uint160/48 초과·시간 표현을 새 v4 입력에서 거절. **Action nonce bitmap/source/freshness 모델은 그대로이므로 의미 교정은 미완료** | 입력 검증까지만 해결하려는 선택. Rust 변경 후 Native → 새 WASM → 새 strict Single → 기존 통합 검증 필요. 기존 273개 기대값은 유지 |
| **C — v4 + 버전이 명시된 allowance Action·소비자 교정** | B에 새 `permit2_sign_allowance_v2` Action, signed/current nonce 분리, owner/Permit2 명시, sync args·transition·projection·직렬화 소비자 대응 추가 | AllowanceTransfer 의미와 조회 전 상태를 교정. 실제 RPC 연결·서명 검증은 여전히 별도이며 수행된 것처럼 표시하지 않음 | 의미 교정의 완성안이지만 Action wire와 소비자 변경 범위가 큼. 명시 선택 후 관련 Native/직렬화/소비자 및 새 WASM 회귀 필요 |

향후 별도 범위로 B 또는 C를 선택하면 현재 신규 Single 시험의 “v4는 unsupported” guard는 의도적으로 달라진다. **이번 85개에 포함된 해당 guard만 승인된 지원 경계에 맞춰 갱신**하고 새 v4 정상/오류 회귀를 별도로 추가한다. DEC-01~04 기존 273개와 v3 Single 진단을 strict 입력에 맞춰 바꾸지 않는다. 어떤 선택에서도 v4 실패 후 v3 자동 재시도는 없다.

**B/C의 입력·검증 순서 제안:** DEC-04의 full-input DTO·원문 보존·routing/domain 충돌 검사를 재사용한 뒤 lookup한다. 정상 형식의 미등록 조합은 상세 message가 malformed여도 lookup miss를 유지한다. 매칭된 PermitSingle에서 실제 manifest의 `PermitSingle(details: PermitDetails, spender: address, sigDeadline: uint256)`과 `PermitDetails(token: address, amount: uint160, expiration: uint48, nonce: uint48)`를 type 이름·필드 배열 순서·타입까지 대조한다. message/details는 객체를 요구하고 누락/null/잘못된 형식과 추가 `owner` 필드를 거절한다. owner는 signed message에 넣지 않는다.

숫자는 `[0-9]+` decimal string, 비어 있지 않은 `0x` hex 또는 JS 안전 정수 Number만 받고 원문과 정규화 decimal 값을 각각 보존한다. amount≤`2^160−1`, expiration/nonce≤`2^48−1`, sigDeadline≤`2^256−1`을 먼저 검증한 뒤 sigDeadline≤`2^53−1`의 출력 투영 한도를 적용한다. 유효한 정수 어휘와 선언 폭 초과를 다른 오류로 구분한다. body/meta의 deadline은 하나의 검증된 정규값으로 만들고 일치 여부를 재검사한다. expiration/nonce는 uint48 자체가 JS 안전 범위 안이다.

Permit2 domain은 `name: "Permit2"`, chainId, verifyingContract 세 필드를 정확히 대조하며 version/salt가 없는 계약을 제안한다. `types.EIP712Domain`이 있으면 같은 세 필드의 선언을 대조한다. 이는 현재 USDC v4의 version/salt 원문 보존 호환을 바꾸는 규칙이 아니다. 근거는 Permit2가 name·chainId·verifyingContract로 domain type hash를 정의한 [공식 EIP712.sol](https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol)이다.

`requested_signer`가 allowance owner의 출처이며 `request.validated.owner_source: "requested_signer"`로 명시하는 안이다. submitter 기본값은 requested_signer이고 명시적으로 다른 submitter도 허용한다. message owner 일치 검사는 만들지 않는다. `nonce_lookup`과 `signature_verification`은 `"not_performed"`로 남긴다. 주소가 같다는 이유로 실제 서명을 검증했다고 표시하지 않는다.

| 입력/내부 문제 | 제안 오류 계약 | 현재 구현과의 구분 |
| --- | --- | --- |
| 필수 필드 누락/null/bool/배열/비정수/음수/어휘 오류/extra field | 기존 `invalid_typed_data`와 정확한 `typed_data.message.details.nonce` 등의 path 재사용 | v3 fallback을 바꾸지 않고 새 v4 Permit2에서 거절 |
| amount/expiration/nonce/sigDeadline의 선언 uintN 초과 | **신규 제안** `typed_integer_out_of_range`, 필드 path와 message에 선언 폭 기재 | 현재 발생하는 오류가 아님. envelope에 `declared_bits` 필드는 추가하지 않는 최소안 |
| uint256 안이지만 sigDeadline이 JS 안전 투영 한도 초과 | 기존 `typed_deadline_out_of_range`를 Permit2 path로 확장 | raw 정수를 먼저 보존하며 포화/반올림 정상 완료 금지 |
| domain 값·허용 필드 불일치 | 기존 `typed_domain_mismatch` 확장 | types 구조/선언 불일치는 `invalid_typed_data` 유지 |
| validator 정규값과 최종 Action identity/nonce/source/deadline 불일치 | 기존 `typed_interpretation_failed` 재사용 | 출력 소비 전 검사. 새 source 표시를 조회 성공으로 승격하지 않음 |

**C의 Action 출력 예시 제안:** 기존 tag와 구조를 변경하지 않고 새 `permit2_sign_allowance_v2`를 opt-in strict projection에 사용한다. 수량은 기존 U256 hex 표현을 유지하고 signed_nonce는 검증된 uint48 decimal string으로 고정하는 안이다. 아래 객체는 body 예시이며 meta에는 별도 submitter·submitted_at·offchain_sig domain/deadline을 둔다.

```json
{
  "domain": "token",
  "action": "permit2_sign_allowance_v2",
  "owner": "0x1111111111111111111111111111111111111111",
  "permit2": "0x000000000022d473030f116ddee9f6b43ac78ba3",
  "token": {"key": {"standard": "erc20", "chain": "eip155:1", "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}},
  "spender": "0x2222222222222222222222222222222222222222",
  "amount": "0xf4240",
  "expires_at": 1738003000,
  "sig_deadline": 1738002000,
  "signed_nonce": "513",
  "current_nonce": {
    "status": "not_queried",
    "source": {
      "kind": "onchain_view",
      "chain": "eip155:1",
      "contract": "0x000000000022d473030f116ddee9f6b43ac78ba3",
      "function": "allowance(address,address,address)",
      "decoder_id": "permit2_allowance_nonce"
    },
    "ttl": 12
  }
}
```

current_nonce는 Action 전용 tagged enum을 제안한다. `not_queried`에는 **value와 synced_at이 없으며**, 실제 조회를 연결한 후 fetched 상태에만 `LiveField<U256>`를 넣는다. fetched scalar도 **uint48 범위 검증**을 통과해야 하며 저장 타입 U256의 폭을 프로토콜 허용 폭으로 간주하지 않는다. 공통 `LiveField`의 계약은 변경하지 않는다. 조회 argument는 owner/token/spender이고 결과의 allowance nonce scalar를 사용한다. `permit2_allowance_nonce` decoder는 아직 구현되지 않은 명칭 제안이며 실제 조회 전에는 nonce 비교·nonce mismatch 판정·신선도 주장을 하지 않는다. signed nonce를 bitmap 좌표로 바꾸거나 submitted_at을 실제 조회 시각으로 쓰지 않는다.

| 변경 대상 | B | C에서 추가되는 소비자 영향 |
| --- | --- | --- |
| `crates/policy-engine-wasm/src/typed_data_validation.rs`, `dto.rs`, `declarative_exports.rs` | Permit2 validator 분기, 검증 문맥/오류, 안전 투영 및 해석 결과 대조 | 새 Action projection 연결·owner/Permit2/signed/current nonce 전달 |
| `crates/policy-engine-wasm/tests/` 및 새 strict Single fixture/Node 시험 | 기존 USDC/v3를 유지한 별도 full PermitSingle 정상·오류·우선순위 회귀 | 새 tag/필드/조회 전 상태·직렬화 회귀 추가 |
| `crates/policy-server/asset-model/action/src/token/permit2_sign.rs` 및 Action enum/export | 변경 없음 | 기존 타입/tag를 보존하고 새 모델·tag 등록; Action 역직렬화·생성 TS/enum 소비자 영향 확인 |
| `crates/adapters/mappers/src/declarative/action_builder.rs` | 기존 v3 경로 변경 없음; v4 검증 후 현재 emit 재사용 | 새 명시 projection 경로만 연결. 기존 blanket nonce tuple fallback 변경 금지 |
| `crates/policy-server/asset-model/state/src/pending/{kind.rs,nonce.rs}`, `crates/policy-server/asset-model/transition/src/effect/token.rs` | 현재 의미 유지, 미교정으로 문서화 | owner/token/spender/chain/Permit2를 포함하는 nonce key·pending ID와 scalar nonce effect. 기존 SignatureTransfer bitmap 경로 유지 |
| `crates/policy-server/sync/src/actions/args.rs`, `crates/policy-server/sync/src/runtime/orchestrator.rs`, 같은 sync crate의 `live/walker.rs`·`sources/fetchers/decoder.rs` | 변경 없음 | allowance 조회 args·scalar 결과·최초 미조회 상태 처리. signed nonce를 조회값으로 덮어쓰지 않음 |
| `crates/policy-engine/src/lowering_v2/token/permit2_sign_allowance.rs`, `schema/policy-schema/actions/token/permit2_sign_allowance.cedarschema`, schema action enum·등록부 | 변경 없음 | 새 Action lowering/schema 및 기존 allowance 정책의 catalog/trigger 규칙 적용 범위를 함께 대응해 정책 누락 방지. 정책 severity 변경은 포함하지 않음 |
| `crates/policy-server/server/src/write_handlers.rs`, `browser-extension/backend/service-worker/permit-report.ts`, `browser-extension/backend/service-worker/dambi-auth/client.ts` | 변경 없음 | 수집/보고/인증 소비자의 새 버전 명시 분기 |

단순히 manifest ID를 `@2`로 올리는 것만으로 호환성을 보존할 수 없다. 현재 typed bridge는 chain/contract/primary type/witness key로 등록하므로 같은 key의 새 manifest가 기존 entry를 덮어쓸 수 있다. 별도 Registry namespace를 필수로 추가하는 대신 **명시 v4 projection 분기와 새 Action tag**를 우선 검토한다. 실제 registry 형식/선택 변경이 필요해지면 그 추가 범위도 승인 대상에 포함한다.

현재 README 명령은 **A의 Rust 무변경 상태**에만 해당한다. B/C 선택으로 소스를 수정하면 Native 회귀 → 새 WASM 빌드 → 새 개별 시험 → 기존 포함 통합 시험 순서와 입력/산출물 대응 로그 명령을 변경 후 파일 목록에 맞춰 다시 제공한다. 새 원본/Action을 기존 baseline에 조용히 덮어씌우지 않는다.

**05b: 미착수.** 실제 [`permitBatch@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitBatch@1.0.0.json)은 원본 대응만 읽었다. Single 사용자 실행 로그 확인 이후 별도 fixture/test/script로 복수 원소의 서로 다른 token/amount/expiration/nonce, 순서·역순·중복 token 보존, 공통 spender/sigDeadline, 첫째·둘째 필수 필드 누락, empty/비배열/64·65 경계와 같은 WASM 프로세스의 Single/Batch 구분을 작성한다. 출력은 최상위 Action 하나 아래 Multicall의 자식 ActionBody 구조다. 현재 empty typed Batch는 Unknown이고 일부 오류는 전체 실패로 전파될 수 있다. 정상 원소만 남기거나 empty를 complete로 처리하거나 65번째 이후를 조용히 생략하지 않는다. 새로운 한도 계약이 필요하면 DEC-06 진단 계획과 함께 질문한다.

**완료 조건과 현재 한계:** Single과 Batch의 코드 작성·사용자 실행 결과를 각각 기록한다. 이번에는 Single 실행 결과가 없고 DEC-05 전체는 미완료다. 새 요청 79개(normal 19, routing_miss 6, input_error 12, emit_error 26, legacy_diagnostic 14, compatibility 2) + 구조 검사 6개인 85개를 작성했다. 기존 다섯 Node 시험 파일의 273개 기대값을 유지하고 실제 작성한 Single만 더한 통합은 358개 정의다. 이 수는 실행 통과 수가 아니다. 외부 nonce 조회·서명 유효성·정책 판정·witness/SignatureTransfer 기능·venue·Core·SDK 소스 이관은 미구현이다. 현재 원본과 실제 WASM의 연결 성공을 full EIP-712 검증이나 SDK 독립화 완료로 확대하지 않는다.

### DEC-06 — multicall 종류별 전개와 진단 · 전체 계획 D2

**06a self:** 실제 Uniswap V3 NFPM의 multicall·mint·refundETH 규칙으로 시작한다. self-multicall 내부 target은 NFPM이므로 일반 ERC20 approve를 넣어 정상 승인 Action을 기대하지 않는다. 순서·중첩·미지원 자식 보존을 확인한다.

**06b Call[]:** 실제 `registryV2/manifests/morpho/bundler3/1-multicall@1.0.0.json`과 자식별 token target의 approve/transfer로 시작한다. 각 `to/data/value`, 알려진+미지원 자식, 전부 미지원, malformed 자식을 구분한다. 이 시험은 bundler 실행 성공을 시뮬레이션한다는 뜻이 아니다.

**06c 진단/한도:** `process_call_legs`와 각 multicall builder의 전달 문맥을 점검한다. 사용자 결정에 따라 한도 초과에서 이미 해석한 호출은 보존하고 나머지는 Unknown+사유로 반환한다. Decoder 결과 DTO와 이 결과를 읽는 기존 소비자의 호환성을 이 변경에서 확인한다.

- 현재 경로별 최대 자식 수 64는 64/65 경계 시험으로 확인한다. 새 기본값으로 임의 교체하지 않는다.
- 기존 TS 사전 설치 시험과 Rust 해석 시험을 함께 대응시킨다. 이번 fixture에 미리 설치한 bundle 목록을 명시하고, 미설치 때문에 발생한 miss와 decoder 자체의 미지원 결과를 구분한다.
- 깊이는 현재 manifest/runtime 설정을 기준으로 경계 전·경계·초과를 시험한다. 서로 다른 재귀 경로가 제한을 우회하는지도 확인한다.
- 깊이·전체 노드 수·입력량을 함께 제한할 필요가 생기면 실제 크기/시간 사례와 제안 값을 보고한 뒤 제품 제한값을 확정한다. 임의의 큰 부하 시험으로 작업 환경을 소모하지 않는다.
- self 경로의 자식 value는 현재 0으로 전달된다. 부모 value 복사가 맞다고 일반화하지 않는다. 프로토콜별 의미를 확인하고 변경이 필요하면 사례를 제시해 질문한다.
- 기존 빈 self/Call[] 오류와 빈 typed batch Unknown 동작은 각각 회귀 시험으로 남긴다. 통일하려면 별도 의미 변경으로 다룬다.

**완료:** 한도 초과의 미해석 구간이 사라지지 않고 complete로 표시되지 않는다. 정상 형제 호출은 유지한다. malformed 자식을 근거 없이 단순 미지원으로 바꾸지 않는다. 최종 warn/deny 규칙은 구현하지 않는다.

### DEC-07 — Decoder 인계물 고정 · 전체 계획 D2 및 D4의 Decoder 부분

**수정:** coverage/README/선택 목록, 필요한 최소 산출물 검증 스크립트·CI 단계. 정책 payload 계약이나 Core 실행부를 함께 작성하지 않는다.

- source id/version/hash → 빌드 옵션 → resolved bundle digest → index key → 확인한 case ID를 연결한다.
- 동일 입력을 두 임시 디렉터리에서 빌드해 정렬된 index와 정규화 bundle이 같은지 확인한다. 경과 시간·임시 경로 같은 진단 출력은 artifact와 분리한다.
- concrete callkey 충돌은 strict 모드에서 실패해야 한다. source 기반 일반 규칙보다 concrete 전용 규칙을 우선하는 기존 동작과 충돌을 구분한다.
- Core 인계 목록에 원문 요청, Action, decoder id, 개별 bundle digest, 해석 상태/진단, 필요한 live-input 선언을 넣는다. 현재 route가 반환하지 않는 digest는 설치한 artifact 목록에서 연결하며 원격 Registry root라고 부르지 않는다.
- fixture는 실제 코드가 확인한 범위만 표시한다. 재현 가능한 시험용 artifact와 npm에 실을 제품 snapshot은 다른 산출물이다.
- source/token/고정 자료·생성기 파일의 목록을 D4와 공유해 SDK 소스 복사본만으로 snapshot을 재생성할 수 있게 한다. 확장 기본 bundle이나 로컬 생성 index를 원본 대신 사용하지 않는다.
- 이 문서 §2.1의 임시 경로 의존 목록을 README/인계 자료에 기록한다. 읽기뿐 아니라 fixture/asset 쓰기도 포함한다. 후속 C2c·C5에서 기존 runner를 SDK 전용 runner로 바꿀 때 유지할 필수 case ID를 연결한다.

**완료:** 다른 개발자가 확장 실행 없이 동일 시험을 재현할 수 있고 Core 담당이 결과·미해석 부분·데이터 출처·남은 임시 경로 의존을 구분할 수 있다. 기존 ABI/mapper/typed/multicall 회귀 시험 중 변경한 경로의 검사도 통과해야 한다. 이는 Decoder 인계 완료이며, SDK 소스·빌드 독립화 완료는 C2c·C5와 전체 계획 §7.1의 검증으로 별도 확인한다.

## 7. 빌드·검증 명령 설계

아래 작업 디렉터리는 `/Users/spu/SDKdambi/DAMBI`다. **작성자가 실행한 명령이 아니라 단계별 실행 안내**다. DEC-01/02/03의 기존 사용자 실행 기록과 DEC-04a의 준비·개별/통합 시험·명시적 파일 커밋 명령은 [README](../../fixtures/decoder-policy/README.md)를 따른다. 저장소 핀은 Rust 1.95.0·Yarn 4.14.1이며 Node는 기존 Core 요구사항인 20 이상을 사용한다. WASM 도구 버전은 현재 CI의 wasm-pack 0.14.0과 맞춘다. 설정상 버전과 실제 사용한 버전은 구분해 기록한다.

아래 `policy-engine-wasm` 빌드·시험 명령은 **이관 전 Decoder 기준선용**이다. 최종 SDK의 필수 명령으로 남기지 않으며 C5에서 `dambi-core-wasm`과 SDK 스크립트로 교체한다.

```sh
cd /Users/spu/SDKdambi/DAMBI
node --version
rustc --version
wasm-pack --version
```

Node 시험은 내장 `node:test`를 사용한다. `registryV2`는 root workspace에 포함되어 있지 않으며, 의존성이 없을 때만 `npm ci --prefix registryV2`로 별도 lockfile에 따라 준비한다. 사용자는 이미 이 설치의 성공을 보고했다. 새 Vitest 설치나 확장 실행을 필수로 추가하지 않는다.

DEC-03/04a는 Rust 빌드 입력을 바꾸지 않아 기존 검증된 JS/WASM 쌍을 조건부 재사용했다. **04b는 Rust 변경 후 새 WASM 직접 빌드를 완료했다**. 아래 명령은 당시 성공한 절차의 기록이며 재실행 요청이 아니다. README의 `DEC04B_VERIFY` Bash 블록은 Native 회귀 → 직접 wasm-pack 빌드 → strict 개별·기존 typed 개별·전체 Node 시험 순서를 실패 시 중단 조건과 함께 제공한다. `scripts/wasm-build.sh`의 확장 폴더 복사·정리 작업은 이 절차에 필요하지 않다.

DEC-01 30개, DEC-02 통합 37개, DEC-03 통합 58개 사용자 통과 기록을 유지한다. 04a는 사용자 제공 로그 기준 개별 47/47 통과(`duration_ms=801.277375`), 당시 통합 105/105 통과(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 과거 값으로 채우지 않는다. 현재 통합 명령에는 기존 네 파일을 유지하며 새 strict 파일을 추가했다. Node 시험 내부 Registry 빌드도 사용자가 실행한다.

builder helper는 `execFile`의 구조화된 인수로 `registryV2/node_modules/.bin/tsx`와 실제 `build-index.ts`, `--strict-callkeys`를 실행한다. 환경 변수 `BUILD_INDEX_REGISTRY_ROOT`에 임시 입력 경로를 전달한다. 테스트가 실제 `registryV2/index`를 지우거나 RPC를 호출하지 않도록 선택한 로컬 source만 포함한다.

Rust 구현을 변경한 단계에서는 해당 패키지/시험을 실행한다. 아래는 범위별 명령이며 모든 소단계마다 전부 반복한다는 뜻이 아니다.

```sh
cargo test --locked -p abi-resolver
cargo test --locked -p mappers
cargo test --locked -p policy-engine-wasm --test declarative_v3_route
cargo test --locked -p policy-engine-wasm --test declarative_v3_typed_data_install
cargo fmt --all -- --check
```

route 내부 unit test를 수정하면 해당 test 이름으로 추가 실행한다. Native 시험만으로 WASM 경계까지 검증했다고 하지 않으며, 변경한 Rust의 WASM을 다시 빌드해 Node fixture를 확인한다. 초기 Decoder CI는 기존 WASM artifact를 재사용할 수 있지만 이는 독립 빌드의 증거가 아니다. C5에서 SDK 전용 source build로 전환하고 최종 독립성 CI는 기존 artifact를 내려받지 않는다.

현재 `registryV2`의 `check:manifest`는 체크아웃에 없는 `crates/integration-tests` harness를 호출하므로 새 clone의 완료 조건으로 사용하지 않는다. harness가 없다는 이유로 해당 검증을 성공으로 처리하지도 않는다.

### 7.1 SDK 전환 후 재검증

전체 계획의 신규 `sdk:verify:isolated`에서 다음을 확인한다. 이 명령과 검증은 아직 구현·실행되지 않았다.

1. 추적되는 SDK 소스·설정·lockfile·정적 원본·필수 fixture만 임시 디렉터리에 복사한다. 과거 익스텐션/서버/기존 WASM crate와 `dist/pkg/target/node_modules`를 가져오지 않는다.
2. 실제 SDK workspace manifest를 그대로 사용한다. 검사할 때만 서버 member를 지우거나 원본 저장소를 symlink로 연결해 성공시키지 않는다.
3. 고정한 의존성을 설치하고 정적 원본에서 asset 및 실제 WASM을 새로 빌드한다. 위 DEC 사례를 이관한 SDK runner로 실행한다. 필수 fixture 부재나 시험 skip은 실패다.
4. 실제 npm tarball과 Rust 소스 패키지를 검증한다. 원본 저장소 밖 소비자의 실행까지 확인한다.
5. 시작과 종료 모두 과거 폴더가 없고 생성되지 않았는지 확인한다. 기존 경로에서 파일을 읽거나 그 경로에 fixture/WASM을 다시 쓰면 실패다.

SDK와 무관한 과거 코드 설명 링크가 문서에 남는 것과 실제 소스·빌드 의존은 구분한다. 기존 폴더의 코드를 가져와야 빌드되거나 시험되는 구조는 허용하지 않는다.

## 8. 발견 사항과 질문하는 기준

다음은 **소스에서 확인한 사항**이다. 개별 실패 입력을 새 빌드에서 재현한 결과와 구분한다.

| 확인한 사항 | 처리 단계·판단 기준 |
| --- | --- |
| ABI 기본 decode는 추가 바이트를 허용 | 사용자 결정 완료: 호환성 유지. DEC-01/03에서 고정 |
| TS transaction/typed 라우터는 일부 형식 오류를 miss/null로 처리 | malformed/miss 분리는 기존 동작을 그대로 보존하는 작업이 아님. DEC-03/04에서 입력별 변경 전후를 명시 |
| typed DTO에 전체 types/domain이 없음 | DEC-04에서 입력 계약 차이와 기존 호출자 영향을 먼저 제시 |
| callback 깊이 한도에서 전개를 생략하는 분기 | 사용자 결정 완료: Unknown+사유 보존. DEC-06에서 재현 후 수정 |
| TS 하위 bundle 사전 설치에도 별도 재귀 한도가 있음 | Rust 한도 보강만으로 전체 경로 완료라고 하지 않음. DEC-06에서 의존 bundle 목록과 후속 인계 항목 기록 |
| self-multicall 자식 value를 0으로 전달 | DEC-06에서 프로토콜 근거 확인. 금액 해석을 바꾸기 전 질문 |
| 일부 주석은 “single_emit only”, “unknown skipped”라고 쓰지만 실제 코드와 다름 | 관련 단계에서 별도 작은 주석 수정. 주석만 보고 기능을 새로 만들지 않음 |
| transaction gas price metadata에 Pyth source stub 사용 | 실제 Oracle 조회 결과로 취급하지 않음. DEC 시험은 provenance를 안전성 증거로 사용하지 않고 Core에 수정 필요 인계 |
| 일부 정수는 `uint<=64` 변환에서 JSON number 사용 | Rust 값과 JS 경계에서 `2^53` 초과 정밀도 검증. wire 타입 변경이 필요하면 호환성 영향을 제시해 질문 |
| builder는 기존 산출물을 지우고 에러 전 일부 파일을 만들 수 있음 | 임시 경로에서만 실행하고 종료 실패 시 전체 시험 산출물을 사용하지 않음 |
| 전체 Registry 일부 source에는 RPC/cache 해소 경로가 있음 | 전체 빌드를 오프라인 시험이라고 부르지 않음. 네트워크 source가 필요한 대상은 입력 고정 방법부터 결정 |
| runtime 설치는 기존 bridge/bundle을 교체할 수 있음 | 충돌·동일 id 재설치·오래된 route 잔존을 시험. snapshot 활성화/상태 격리 자체는 Core 단계 |

구현 중 아래 경우에는 **영향받는 단계의 의미 변경을 멈추고 질문한다.** 독립적인 읽기·재현 시험은 계속할 수 있다.

1. 실제 manifest의 의미와 기존 Action이 달라 token·spender·recipient·금액·value·호출 순서를 바꿔야 하는 경우.
2. 정책 severity, 지원 chain/contract 범위, typed domain 제약 등 제품 동작을 정해야 하는 경우.
3. 요청 정보가 현재 DTO/Action 타입에서 손실되어 외부 wire 타입이나 기존 호출자 호환성을 바꿔야 하는 경우.
4. 더 엄격한 제한값, 새 네트워크 소스, 기존에 없는 계약/ABI를 도입해야 하는 경우.
5. 계획 범위를 넘어 다른 프로토콜·Core·어댑터를 먼저 고쳐야 완료할 수 있는 경우.

질문에는 **단계·관련 파일, 최소 입력, 기대/실제 결과, 선택지와 영향, 권장안**을 함께 제시한다. 컴파일 오류의 국소 수정, 경로 수정, 명확한 기존 계약 위반의 회귀 시험은 통상 작업으로 처리하되 결과에 기록한다. 도구 설치/네트워크가 막히면 실패 원인과 미검증 범위를 밝힌다. 테스트 삭제·검사 완화·기대값 덮어쓰기로 통과시키지 않는다.

## 9. 단계별 보고와 현재 상태

각 소단계 보고에는 다음을 남긴다.

- 이번 단계와 변경 파일·함수.
- 동작 변화 또는 기존 동작 유지 근거.
- 실행한 시험과 실제 결과. 실행하지 못한 검증은 별도 표시.
- 결정이 필요한 사항과 다음 소단계.
- 로컬 변경/커밋 상태. GitHub push·main 반영·패키지 발행은 별도 작업.
- 이관 작업이면 남은 임시 경로 의존과 SDK 소스 독립성 검증 상태.

| 항목 | 현재 상태·근거 |
| --- | --- |
| DEC-01 구현 및 연결 시험 | 구현 완료, 커밋 `3066f0c`. 당시 소스 재빌드 후 사용자 제공 `npm run decoder:test` 로그 기준 30개 통과, 실패·취소·건너뛰기 각 0개. 시험 시작 `2026-09-11T06:57:40Z`, 성공 표식 `2026-09-11T06:57:42Z`, `duration_ms=1290.958958`. 당시 명령은 DEC-01 단독이며 작성자가 직접 실행한 결과가 아님 |
| DEC-01 소스·WASM 기록 | 기존 사용자 실행 보고 기록 유지. 전후 HEAD `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`·Git 상태, 도구 버전, 직접 빌드 성공 표식 `2026-09-11T06:57:10Z`, WASM SHA-256과 동일 경로의 WASM 재시험 결과를 함께 기록. 당시 미제공 세부 기록은 그대로 유지하며 DEC-02 값으로 사용하지 않음 |
| DEC-02 빌드·산출물 기록 | 사용자 보고로 실제 Rust WASM 컴파일·최적화·pkg 생성 완료, 현재 JS/WASM의 직접 계산 SHA-256과 실행 로그 일치 확인. 원본 hash 값·실행 시점 HEAD·도구 버전·시각 등 이번 요약에 없는 값은 임의 기입하지 않음. 에이전트 독립 재현은 미수행 |
| DEC-02 및 D1 | 구현 커밋 `26df736`. 사용자 실행 보고 기준 검증 완료. 통합 37개 통과(DEC-01 회귀 30개 + DEC-02 정책 7개), 실패·취소·건너뛰기·todo 모두 0. 정적 정책의 실제 planner/evaluator 연결과 정확한 정책 판정 검사 통과 |
| DEC-03 작성·정적 검토 | 코드 작성 완료. 실제 source·Rust 직렬화·오류 순서와 fixture의 고정 ABI word를 읽어 대조. 기존 37개 시험/fixture/worker와 Rust·빌드 입력 변경 없음. 신규 18개 요청 + 3개 구조 검사, 합계 21개 |
| DEC-03·통합 회귀 실행 | 사용자 실행 보고 기준 검증 완료. transfer 21/21 통과(`duration_ms=866.922333`), 통합 58/58 통과(`duration_ms=635.086875`). 각 실행의 suites·fail·cancelled·skipped·todo는 모두 0. 공동 설치·8개 callkey·JCS digest·프로세스 격리와 기존 37개 회귀 확인. 실행 HEAD·시각·도구 버전·산출물 hash·재빌드 로그 미제공 |
| DEC-04a 작성·정적 검토 | 실제 permit 원본·approve+permit 선택·5 callkey/1 typed 기대 검사·실제 typed WASM 경로 시험 작성. 요청 44개 + 구조 3개 = 47개 정의. 04a 사용자 실행 47개 통과 |
| DEC-04a 실행 | 04a는 사용자 제공 로그 기준 개별 47/47 통과(`duration_ms=801.277375`), 당시 통합 105/105 통과(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 과거 값으로 채우지 않는다. |
| DEC-04b·DEC-04 전체 | 네 계약 답변 반영·v4 구현·04a/04b 분리 커밋·사용자 실행 로그 검증 완료. Native 181개, Node strict 168개/기존 typed 47개/통합 273개 통과. DEC-04 완료 |
| DEC-05a Permit2 Single | 구현 완료, 사용자 실행 대기. A 범위 확정: v3 연결·기존 한계 진단·교정 설계. 런타임 교정은 별도 범위 |
| DEC-05b Batch·DEC-06/07·소스 이관 | 미착수. Single 사용자 실행 결과 확인 후 Batch 진행 |
| SDK 전체 소스·빌드 독립화 | 미완료. 기존 WASM 실행부와 서버 아래 공통 타입 등 임시 의존이 남음. C2c·C5 및 전체 계획 §7.1 검증 필요 |

04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. 기존 DEC-01/02/03 사용자 통과 기록(30/37/58)과 미제공 항목을 보존하고 04a 47/105 통과 결과를 네 문서에 반영했다. 에이전트는 빌드·시험·설치·Git 변경 명령을 실행하지 않았다. 현재 DEC-05a는 **구현 완료, 사용자 실행 대기**이며 사용자가 **A — 연결 시험·교정 설계만 마무리**를 선택해 이번 범위는 확정됐다. B/C 런타임 계약 교정은 별도 범위의 미구현 제안이다. DEC-05b·SDK 전체 소스·빌드 독립화는 미완료다.
