# Dambi Decoder 상세 설계·구현 계획

작성일: 2026-09-11 · 작업 브랜치: `feat/decoder`

설계의 코드 기준 및 DEC-01 사용자 보고 빌드 대상 HEAD: `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`. DEC-02 시작 시 실제 Git 상태는 `feat/decoder`, HEAD `3066f0c` (`test(decoder): verify real approve decoding baseline`), 작업 트리 깨끗함이다. DEC-01 구현과 **Rust 소스 직접 빌드 후 연결 시험 30개 통과를 사용자 실행 보고 기준으로 확인**한 기존 기록은 유지한다. 최초 시험과 재빌드 후 시험은 별도 기록이다. DEC-02는 **코드 작성 완료·실행 검증 대기**이며 작성자는 빌드·시험을 실행하지 않았다. DEC-01 커밋 존재는 현재 WASM의 소스 일치나 작성자의 독립 재현을 증명하지 않는다.

이번 DEC-02 작업에는 사용자 실행 제한이 아래 일반 진행 지침보다 우선한다. 코드·시험·문서 작성과 정적 검토까지만 수행하며 빌드·시험·의존성 설치와 Git add·commit·push·merge·reset·브랜치 변경은 실행하지 않는다. DEC 시험은 내부에서 Registry를 빌드하므로 직접 실행하지 않는다. 사용자용 준비·실행 명령과 결과 기록 항목은 [DEC-01/02 README](../../fixtures/decoder-policy/README.md)를 따른다. DEC-03으로 자동 진행하지 않는다.

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
signer + submitted_at
typedData: { domain, types, primaryType, message }
→ 원본 필드 보존 → routing 값 추출 → manifest의 type 계약 확인 → emit
```

- 원본 domain에서 chain/contract를 추출한다. 같은 정보를 바깥 필드로도 받는 호환 경로는 불일치를 검사한다.
- `types`의 이름·필드 순서·타입·참조 관계를 확인한다. 알려진 Permit의 owner·nonce처럼 emit에 직접 쓰이지 않는 필수 필드도 검사한다.
- 임의 `primaryType/witnessType` 주장만으로 다른 구조의 message를 정상 Permit으로 해석하지 않는다. witness는 실제 type graph에서 확인할 정보이며 별도 주문 지원은 후속 결정이다.
- manifest가 기대값으로 명시한 domain 항목과 요청 값을 대조한다. 선언되지 않은 version/salt의 정답을 만들어내지 않는다. 호환성을 바꾸는 domain 제약이 필요하면 DEC-04에서 재현 사례와 함께 질문한다.
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

아래는 전체 시험의 목표 구조다. DEC-01의 `README.md`, `registry-selection.json`, `helpers/build-registry.mjs`, `helpers/wasm-worker.mjs`, `approve.cases.json`, `approve.test.mjs`와 DEC-02의 `approve-policy.test.mjs`·기존 worker의 선택적 정책 평가 경로는 코드 작성이 완료됐다. DEC-02 실행 검증과 나머지 후속 단계 파일 작성은 아직 남아 있다.

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
  approve-policy.test.mjs        # DEC-02 코드 작성 완료·실행 검증 대기
  transfer.cases.json
  transfer.test.mjs
  typed-permit.cases.json
  typed-permit.test.mjs
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

빌드 시작 시각·상세 빌드 로그·전체 빌드 명령 출력·실제 임시 `CARGO_TARGET_DIR` 경로는 기록 보완 대기로 남긴다. 이 미제공 항목을 채우기 위해 빌드·시험을 다시 요구하지 않는다. 작성자의 소스/WASM 독립 재현은 미확인이며 DEC-01 커밋 `3066f0c` 자체를 그 증거로 삼지 않는다. DEC-02와 SDK 소스·빌드 독립화 완료를 뜻하지 않는다.

**구현:** README/selection/helper/approve fixture·시험, root `package.json`의 `decoder:test` 스크립트. 기존 Rust 실행부를 재사용한다.

1. 실제 approve manifest와 네 체인의 최소 token 파일을 임시 Registry로 복사한다.
2. 실제 builder를 `--strict-callkeys`로 실행한다. 종료 코드가 0이 아니면 생성된 일부 파일도 시험 입력으로 소비하지 않는다.
3. index의 chain/address/selector와 bundle 참조를 확인하고 digest를 계산해 비교한다.
4. 실제 WASM에 bundle을 설치하고 calldata를 route한다.
5. decoder id, Action 개수, token chain/address, spender, amount를 검사한다.

**사례:** 0, 일반 수량, `2^160-1`, `2^256-1`, `2^256-2`; 주소 대소문자; 등록 조합의 miss; 비정상 hex; selector만 존재; 인자 일부 누락; selector 불일치; 정상 인자 뒤 추가 바이트.

**완료:** 성공·매칭 없음·malformed를 구분한다. 네 체인 주소 확장과 최소 정상 사례를 확인한다. 결과가 기대와 다르면 재현 fixture를 먼저 확보하며, 오동작을 기대값에 맞춰 통과시키지 않는다. 이 단계만 끝내고 보고한다.

### DEC-02 — approve 소비자 정책 연결 · 전체 계획 D1 뒷부분

**상태: 코드 작성 완료·실행 검증 대기.** 빌드·시험·의존성 설치와 Git 변경 명령은 실행하지 않았다. 실행 성공이나 D1 전체 완료를 뜻하지 않는다.

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

DEC-02는 위 7개만 추가한다. 루트 `decoder:test`는 DEC-01 30개와 DEC-02 7개를 함께 포함하며 합계 37개는 **작성된 시험의 의도된 수이지 실행 결과가 아니다**. 개별 명령은 `decoder:test:approve`와 `decoder:test:approve-policy`다. 추가 체인·수량 조합이나 DEC-01 검사 복제는 포함하지 않는다.

확장 경로 정책은 D3 이관 전 기준 시험의 임시 입력이다. D3에서 공유 정책 원본으로 전환하고 C2c·C5에서 SDK 시험·실행 경로를 이관한다. 최종 SDK 의존 구조나 다른 정책을 포함한 제품 전체 판정으로 일반화하지 않는다.

**완료 조건:** 사용자 실행으로 7개 정책 사례와 기존 DEC-01 회귀 시험이 통과하고 결과 기록을 갱신해야 한다. 적용 정책 ID와 `@severity("warn")`의 기존 결과를 유지하며 정책 이름의 `deny`에 맞추려고 severity를 바꾸지 않는다. 예상과 다르면 기존 정책·Rust 실행부 수정으로 범위를 넓히지 않고 관련 파일·최소 입력·코드상 동작·기대와의 차이·선택지·영향·권장안을 보고한다. 실행 전 코드상 추정과 실제 재현은 구분한다.

### DEC-03 — transfer와 공통 transaction 오류 · 전체 계획 D2

**수정:** transfer fixture·시험·coverage. 결함이 재현된 경우에만 ABI/route 함수와 해당 Rust 회귀 시험을 별도 변경한다.

- 실제 transfer manifest를 같은 빌드 경로에 추가한다.
- `tx.to = token`, `$args.to = recipient`가 분리되는지 확인한다. approve의 spender가 남거나 token이 recipient로 바뀌지 않아야 한다.
- 0·일반·MAX amount, recipient 정규화, miss·malformed·추가 바이트 사례를 확인한다.
- malformed와 미지원이 섞이는 selector/입력 길이 검사는 명시적으로 분류한다. 기존 다른 ABI 호출의 trailing-byte 호환성도 유지한다.

**완료:** approve와 transfer를 함께 설치해도 각 selector가 정확한 Action을 만든다. 형식상 유효한 zero-address 수신자도 해석 결과를 유지하며, 위험 여부는 정책에 남긴다.

### DEC-04 — EIP-2612와 typed 입력 계약 · 전체 계획 D2

**04a 기준선:** 실제 `standard/erc20/permit@1.0.0.json`을 빌드해 현재 축약 DTO 경로를 재현한다. 이 manifest가 선언한 mainnet·USDC·Permit 범위를 그대로 기록한다. `permit()` calldata와 서명 전 typed request는 서로 다른 입력 시험이다.

**04b 계약 보강:** `dto.rs`, typed route와 관련 helper, 새 typed Rust 회귀 시험. 전체 domain/types/message 보존과 type 검사를 별도 변경으로 진행한다. 기존 호출자는 축약 DTO를 사용하므로, 호환 경로와 SDK용 엄격 경로를 구분해 설계안을 먼저 보고한다. 기존 입력을 갑자기 필수 필드 누락으로 만들거나, 축약 입력도 엄격 검증됐다고 표시하지 않는다.

기존 `sig-routing.ts`의 정규화·witness 추출과 해당 시험을 먼저 대응시킨다. 새 SDK 정규화 규칙을 별도로 만들어 기존 입력과 달라지게 하지 않는다. 현재 TS에서 형식 오류가 miss로 바뀌는 경우를 malformed로 구분하는 작업은 의도적인 동작 차이로 기록한다.

**사례:** owner/spender/value/nonce/deadline 정상·누락·형식 오류, 잘못된 field type/order, primaryType 불일치, domain/name/version/salt 보존, 바깥 routing 값과 domain의 충돌, type graph 참조 누락, 정수 범위·정밀도.

**완료:** emit에 쓰이는 필드뿐 아니라 알려진 서명 종류의 필수 구조를 검사한다. nonce의 체인상 현재값이나 deadline의 실제 사용 가능성을 확인했다고 주장하지 않는다. 표현 범위를 넘는 deadline을 0으로 바꿔 성공시키는 등의 사례가 재현되면 타입 변경 판단 항목으로 보고한다.

### DEC-05 — Permit2 Single → Batch · 전체 계획 D2

**05a:** 실제 `uniswap/permit2/permitSingle@1.0.0.json`과 `build_typed_data_args_json` 경로. token/spender/amount/expiration/nonce/sigDeadline을 검사하고 `uint160/uint48` 경계, 객체 키 순서 변화, flat/tuple 변환을 확인한다.

**05b:** 실제 `permitBatch@1.0.0.json` 및 `array_emit`. 서로 다른 token/amount의 순서, 공통 spender/deadline, 일부 원소의 필수 필드 누락을 확인한다. 현재 빈 typed batch는 Unknown이므로 empty를 complete한 정상 동작으로 자동 바꾸지 않는다.

**수정:** 각 fixture·시험과 필요한 mapper helper만. witness·venue 주문 기능 확대를 섞지 않는다.

**완료:** Single과 Batch를 별도 결과로 보고한다. 하나가 통과했다고 다른 하나를 완료로 표시하지 않는다. 외부 nonce 조회는 미연결 상태임을 명시한다.

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

아래 작업 디렉터리는 `/Users/spu/SDKdambi/DAMBI`다. **작성자가 실행한 명령이 아니라 단계별 실행 안내**다. DEC-01의 기존 기록과 DEC-02의 소스 상태·도구 버전·빌드·SHA-256·시험·결과 기록 순서는 [README](../../fixtures/decoder-policy/README.md)를 따른다. 저장소 핀은 Rust 1.95.0·Yarn 4.14.1이며 Node는 기존 Core 요구사항인 20 이상을 사용한다. WASM 도구 버전은 현재 CI와 맞춘다. 설정상 버전과 실제 사용한 버전은 구분해 기록한다.

아래 `policy-engine-wasm` 빌드·시험 명령은 **이관 전 Decoder 기준선용**이다. 최종 SDK의 필수 명령으로 남기지 않으며 C5에서 `dambi-core-wasm`과 SDK 스크립트로 교체한다.

```sh
cd /Users/spu/SDKdambi/DAMBI
node --version
rustc --version
wasm-pack --version
```

Node 시험은 내장 `node:test`를 사용한다. `registryV2`는 root workspace에 포함되어 있지 않으며, 의존성이 없을 때만 `npm ci --prefix registryV2`로 별도 lockfile에 따라 준비한다. 사용자는 이미 이 설치의 성공을 보고했다. 새 Vitest 설치나 확장 실행을 필수로 추가하지 않는다.

```sh
CARGO_PROFILE_RELEASE_OPT_LEVEL=z wasm-pack build crates/policy-engine-wasm \
  --target web --release --out-dir pkg --out-name policy_engine_wasm
```

`scripts/wasm-build.sh`는 산출물을 확장 경로에 복사하므로 이 시험의 필수 빌드 명령으로 사용하지 않는다. 직접 빌드 시 license/NOTICE 처리 등 기존 스크립트와의 차이가 실제 오류로 나타나면 해당 준비 단계만 보완한다.

DEC-01 검증 당시 `npm run decoder:test`는 `approve.test.mjs`만 실행했다. DEC-02 변경 후 이 명령은 DEC-01과 DEC-02를 모두 실행한다. **시험 내부에서 임시 Registry를 실제로 빌드**하며 WASM은 미리 직접 빌드한 파일을 사용한다. 이번 작업에서는 아래 명령을 실행하지 않았다. 둘을 함께 실행하거나 필요 시 개별 명령을 선택한다.

```sh
npm run decoder:test
# DEC-01만 실행
npm run decoder:test:approve
# DEC-02만 실행
npm run decoder:test:approve-policy
```

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
| Rust 소스와 WASM 산출물 일치 | DEC-01 사용자 실행 보고 기준 확인 기록 유지. 동일한 전후 HEAD `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`·Git 상태, 도구 버전, 직접 빌드 성공 표식 `2026-09-11T06:57:10Z`, WASM SHA-256과 동일 경로의 WASM 재시험 결과를 함께 기록. 빌드 시작 시각·상세 빌드 로그·전체 빌드 명령 출력·실제 임시 `CARGO_TARGET_DIR` 경로는 기록 보완 대기. 작성자의 독립 재현 및 DEC-02의 실행 검증은 미확인; 커밋 존재는 소스 일치 증거가 아님 |
| DEC-02 | 코드 작성 완료·실행 검증 대기. 실제 디코딩 결과를 기존 정적 정책 planner/evaluator에 연결하는 7개 사례 작성, 실행하지 않음 |
| DEC-03부터 DEC-07·소스 이관 | 미착수 |
| SDK 전체 소스·빌드 독립화 | 미완료. 기존 WASM 실행부와 서버 아래 공통 타입 등 임시 의존이 남음. C2c·C5 및 전체 계획 §7.1 검증 필요 |

현재 작업은 DEC-02 코드·시험·문서 작성과 정적 검토까지다. DEC-01의 사용자 제공 소스 직접 빌드·WASM SHA-256·재시험 기록과 미확인 항목을 유지한다. 작성자는 빌드·시험·의존성 설치·Git add·commit을 실행하지 않았다. DEC-02 실행 검증과 기록 갱신은 대기 중이며 DEC-03으로 자동 진행하지 않는다.
