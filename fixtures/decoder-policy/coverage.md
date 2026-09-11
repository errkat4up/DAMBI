# Decoder 기준 시험 커버리지

**DEC-01/02의 과거 사용자 실행 기준 37개 통과(30 + 7) 기록을 유지하며, DEC-03도 사용자 실행 보고 기준 검증 완료다.** 새로 제공된 전체 로그에서 transfer 개별 21개와 통합 회귀 58개가 모두 통과했다. 두 실행 모두 실패·취소·건너뛰기·todo·suites는 0이며 `duration_ms`는 각각 `866.922333`, `635.086875`다. 에이전트의 독립 재실행 결과가 아니다. 04a는 사용자 제공 전체 로그 기준 typed permit **47/47 통과**(`duration_ms=801.277375`), 당시 통합 **105/105 통과**(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 이전 기록으로 채우지 않는다. 04a 사용자 실행 결과를 반영했고, 합의된 04b v4 DTO·strict validator·실행부·Rust/Node 회귀 시험을 별도 변경으로 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. SDK 전체 소스·빌드 독립화도 미완료다.

## 원본·설치 범위

| source ID | source 파일 (`registryV2/` 기준) | selector | 실제 원본 바이트 SHA-256 |
| --- | --- | --- | --- |
| `standard/erc20/approve@1.0.0` | `manifests/standard/erc20/approve@1.0.0.json` | `0x095ea7b3` | `0x0a51874b0d42a209e61a79083821338b67c3968c27bda6eea48fc8a78ad5047e` |
| `standard/erc20/transfer@1.0.0` | `manifests/standard/erc20/transfer@1.0.0.json` | `0xa9059cbb` | `0x47e37a1ada72a9fee9e4b8077b7000f0b1198a0219fa513d3ccb74def70ee925` |
| `standard/erc20/permit@1.0.0` | `manifests/standard/erc20/permit@1.0.0.json` | `0xd505accf` | `0x9e7337ae3ce7e1a80851652e39b2ac4fb264b5e8caf00a4c93193c6b93c76eb3` |

approve·transfer 두 원본은 모두 `chain_ids: [1, 10, 8453, 42161]`, `chain_to_addresses_source: "tokens:erc20"`를 유지한다. DEC-03은 기존 approve/token 경로·hash를 보존하고 transfer 선택을 추가했다. DEC-04a는 permit 선택만 더한다. permit은 `chain_to_addresses`에 mainnet USDC 한 주소를 직접 선언하며 네 체인으로 확장하지 않는다.

| chain | 선택한 token contract (`tokens/<chain>/<address>.json`) |
| --- | --- |
| `eip155:1` | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| `eip155:10` | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` |
| `eip155:8453` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| `eip155:42161` | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` |

`buildRegistry(selection)`은 approve만 빌드하고 기존 반환 객체 `{ root, source, tokens, cleanup }`와 정확히 4개 callkey를 유지한다. DEC-03에서만 `buildRegistry(selection, { includeTransfer: true })`를 호출해 `selection.transfer_manifest`를 복사하고 반환값에 `transferSource`를 더한다. DEC-03은 정확히 8개 callkey(4개 체인 × 2개 selector)의 manifest 경로·bundle ID·resolved bundle JCS digest를 검사한다. 원본 바이트 hash와 resolved bundle의 JCS hash는 다른 값이다. 사용자 시험에서 실제 builder와 JCS digest 검사가 통과했다. 생성된 digest의 구체적인 문자열은 로그에 출력되지 않았으므로 임의로 채우지 않는다.

실제 strict builder는 선택한 manifest/token 입력과 Registry 생성물을 임시 경로에 두며 원본 manifest를 재작성하지 않는다. builder 코드·`node_modules`·공유 함수 허용 목록은 기존 저장소 경로에서 읽는다. `--strict-callkeys`, `BUILD_INDEX_REGISTRY_ROOT`, 실패 시 전체 임시 경로 정리와 실제 `3-ref` 해소·JCS 검사는 유지한다. Registry 전체 token 목록·root digest·서명·배포 상태를 검증한 것으로 일반화하지 않는다.

## DEC-03 요청 사례 — 18개 사용자 실행 통과

정상 7개에서 요청 `to`는 token contract, calldata 첫 ABI 인자 `to`는 recipient, `submitter`는 제출자다. 세 주소를 구분해 token/recipient/submitter 필드 혼동을 검출한다. 기대 body는 실제 Rust의 `domain: "token"`, `action: "erc20_transfer"`, `token.key.{standard,chain,address}`, `recipient`, U256 최소 길이 hex 문자열 `amount`를 사용한다. `spender`가 없어야 한다. `is_router_egress: false`는 기본값 생략 규칙에 따라 기대 객체에 넣지 않는다.

| case ID | 확인 대상 | 기대 결과 |
| --- | --- | --- |
| `chain-1-normal` | 체인 1, 수량 `1,000,000` | transfer Action, amount `"0xf4240"` |
| `chain-10-zero` | 체인 10, transfer 수량 `0` | transfer Action, amount `"0x0"`. 승인 취소나 정책 판정으로 해석하지 않음 |
| `chain-8453-uint256-max` | 체인 8453, 수량 `2^256-1` | transfer Action, 64개의 `f`인 U256 hex 문자열. 무제한 승인 판정과 무관 |
| `chain-42161-mixed-case` | 체인 42161, token·recipient·submitter 혼합 대소문자, 수량 `1,000,000` | 주소 소문자 정규화 및 정확한 body/meta |
| `zero-recipient` | calldata의 recipient가 zero address | 정상 transfer Action. 악성·위험·차단 판정 없음 |
| `trailing-one-byte` | 정상 ABI 인자 뒤 1바이트 | 동일 transfer Action, 기존 추가 바이트 호환성 유지 |
| `trailing-full-word` | 정상 ABI 인자 뒤 32바이트 word | 동일 transfer Action, 기존 추가 바이트 호환성 유지 |
| `unregistered-token` | 정상 형식이나 선택된 Registry에 없는 token | `no_declarative_v3_mapper` |
| `unregistered-chain` | 정상 형식이나 설치 범위에 없는 chain | `no_declarative_v3_mapper` |
| `unregistered-selector-with-transfer-calldata` | 정상 transfer calldata, 정상 형식의 미등록 조회 selector | ABI 해석보다 lookup miss가 먼저: `no_declarative_v3_mapper` |
| `invalid-calldata-hex` | calldata의 잘못된 hex 문자 | `invalid_calldata` |
| `missing-selector` | 필수 selector 필드 누락 | DTO 역직렬화 실패: `invalid_input_json` |
| `invalid-calldata-type` | calldata가 문자열이 아닌 타입 | DTO 역직렬화 실패: `invalid_input_json` |
| `selector-only` | `0xa9059cbb` 4바이트만 존재 | 등록 decoder의 필수 ABI 인자 부족: `decode_failed` |
| `partial-recipient-word` | recipient word가 잘림 | `decode_failed` |
| `partial-amount-word` | amount word가 잘림 | `decode_failed` |
| `transfer-lookup-approve-calldata` | 등록 transfer 조회 selector, approve calldata selector | transfer lookup 후 ABI 해석에서 `decode_failed` |
| `approve-lookup-transfer-calldata` | 등록 approve 조회 selector, transfer calldata selector | approve lookup 후 ABI 해석에서 `decode_failed` |

고정 calldata의 selector·주소 word·amount word와 추가 바이트를 독립적으로 검산한다. 수량은 `BigInt`와 문자열만 사용하며 JS `Number`를 거치지 않는다. 기대값을 실제 디코더 반환값으로 자동 생성하지 않는다. 성공 envelope, decoder ID, Action 개수, body와 meta 전체를 비교한다. gas price의 Pyth source metadata는 기존 실행부 stub이며 실제 Oracle 조회·검증된 provenance가 아니다.

## DEC-03 구조 검사 — 3개 사용자 실행 통과

| 검사 | 확인 대상 |
| --- | --- |
| 실제 두 manifest → 8개 callkey → resolved bundle | selector마다 올바른 ID·source 경로·JCS digest. 각 bundle의 네 체인 주소 확장과 ABI·emit 등 원본 필드 보존. 검증한 bundle만 실제 WASM에 설치 |
| 고정 calldata와 U256의 독립 검산 | selector·recipient word·amount word·추가 바이트의 고정값, 0·일반·MAX 수량 정밀도, 서로 다른 token/recipient/submitter |
| 공동 설치·교대 디코딩과 설치 상태 격리 | 같은 프로세스에서 두 bundle 설치 후 transfer → approve → transfer → approve → transfer의 decoder ID·Action body/meta 전체 검사. approve 일반/MAX 두 기존 사례 재사용. 별도 approve-only Node 프로세스에서는 transfer miss |

기존 `helpers/wasm-worker.mjs`를 수정 없이 재사용한다. 서로 다른 설치 상태마다 Node 프로세스를 분리하며 전역 Registry 초기화를 가정하지 않는다. ABI/WASM을 mock하지 않는다. 위 구조 검사 3개와 요청 18개를 합친 **DEC-03 21개가 사용자 실행으로 모두 통과**했다. 기존 37개를 포함한 **통합 회귀 58개도 모두 통과**했으며 공동 설치와 교대 디코딩의 DEC-03 완료 조건을 충족했다.

## DEC-01/02에서 유지하는 공통·정책 범위

| 기존 시험 | 이미 사용자 실행으로 확인한 내용 | DEC-03과의 관계 |
| --- | --- | --- |
| DEC-01 정상 approve | 네 체인, 0·일반·`2^160-1`·`2^256-1`·`2^256-2`, 대소문자·zero spender | approve 기대값과 시험 파일 유지. 교대 요청에는 기존 일반/MAX 두 사례만 재사용 |
| DEC-01 공통 입력 오류 | `invalid-to-address`, `invalid-submitter-address`, `invalid-chain-negative`, `invalid-chain-string` → `invalid_input_json` | 공통 주소·u64 parser 사례를 transfer 조합별로 복제하지 않음 |
| DEC-01 calldata 형식 | `invalid-hex-character`, `invalid-hex-odd-length` → `invalid_calldata` | transfer에는 잘못된 hex 문자 한 사례만 추가, 홀수 길이의 공통 검사는 기존 시험 유지 |
| DEC-01 매칭 범위 | 미등록 token·chain·selector 및 등록 chain/token의 잘못된 조합 | transfer 고유 selector 매칭과 두 decoder 공동 설치의 miss를 추가 |
| DEC-01 ABI·조회 순서 | selector-only, amount word 누락/잘림, 등록·미등록 lookup 불일치, 1바이트·word trailing 허용 | transfer recipient/amount word 및 두 등록 selector의 교차 불일치 추가 |
| DEC-01 연결·격리 | 정확히 4개 callkey, inline/ref 해소·tampered digest 거절·context 조립 거절, bundle 설치/미설치 프로세스 격리 | helper 기본 동작·반환 계약 유지. DEC-03에서만 명시 선택해 8개 callkey 검사 |
| DEC-02 실제 approve 정책 7개 | 실제 디코딩 Action → planner `planned: []` → 빈 Fact 평가, 정확한 `unlimited-approval-deny` ID·severity `warn`·origin `action`, pass/warn DTO | 정책 원본·기존 시험·worker 유지. transfer 정책 평가는 추가하지 않음 |

DEC-01 30개 + DEC-02 7개는 사용자 실행 보고 기준으로 모두 통과했다. DEC-03 helper·npm 명령 변경 후의 사용자 통합 58개 로그에서도 기존 37개가 모두 통과했다. 과거 37개 실행 기록은 보존하며 새 회귀 실행과 구분한다.

## selector 문자열 형식 검사의 한계와 판단 항목

이 항목은 **현재 소스의 정적 검토 결과**다. 아래 malformed selector 문자열 사례는 이번 사용자 시험에 포함되지 않아 실행으로 재현한 결과가 아니며 정상 미지원 계약으로 분류하지 않는다.

| 항목 | 코드상 내용 |
| --- | --- |
| 관련 DTO | [`dto.rs:199`](../../crates/policy-engine-wasm/src/dto.rs#L199)의 `DeclarativeRouteRequestV3InputDto.selector`는 `String`. `0x` + 8개 hex 주석과 별도로 길이·hex 검증은 없음 |
| 현재 실행 순서 | [`declarative_exports.rs:495`](../../crates/policy-engine-wasm/src/declarative_exports.rs#L495)의 calldata hex 파싱 → 빈 calldata/native 분기 → selector 소문자 변환 → callkey/selector bridge 조회 → ABI 해석 |
| 최소 입력 | `transfer.cases.json`의 `defaults`와 `chain-1-normal.input`을 병합한 완전한 요청에서 `selector`만 `"0x1"` 또는 `"0xzzzzzzzz"`로 변경. 그 외 필드와 정상 transfer calldata는 유지 |
| 현재 코드상 결과 | 문자열 역직렬화와 정상 calldata hex 파싱 후 해당 selector key를 찾지 못해 `no_declarative_v3_mapper` 예상. lookup에서 실패하므로 ABI selector 검사는 도달하지 않음 |
| 원하는 형식 분류와 차이 | selector 자체가 잘못된 형식이면 입력 오류 `invalid_input_json`로 구분하는 방향과 다름. 이것은 정상 형식의 미등록 selector와 다른 한계 |
| 변경 영향 | Rust DTO/route 검증 추가 시 lookup 우선순위와 오류 분류가 바뀜. 잘못된 selector + 잘못된 calldata의 우선 오류, 빈 calldata `0x`의 native sentinel 경로, 기존 호출자·DEC-01/02 기대값 영향을 먼저 검토해야 함. Rust/WASM 재빌드와 회귀 시험 필요 |
| 권장안·현재 판단 | DEC-03은 현재 오류 분류를 유지하고 이 한계를 기록한다. 형식 검증 도입은 별도 의미 변경으로 최소 입력·예상 분류·호환성 영향을 제시해 사용자 결정 후 진행. 현재 fixture 작성에 필요한 runtime 변경이나 판단 대기는 없음 |

selector 필드 **누락·비문자열 타입**은 `String` 역직렬화에서 거절되므로 위 **문자열의 내용 형식** 한계와 구분한다. DEC-03의 `missing-selector`는 전자를 확인한다. 실제 JSON·주소·숫자 파싱 실패는 `invalid_input_json`, calldata hex 실패는 `invalid_calldata`, 정상 형식의 매칭 실패는 `no_declarative_v3_mapper`, 매칭 후 ABI selector/인자 해석 실패는 `decode_failed`라는 현재 분류를 유지한다.

빈 calldata `0x`는 native transfer 분기로 들어가므로 ERC-20 인자 누락 사례로 사용하지 않는다. lookup 전 selector/calldata 일치 검사나 strict ABI trailing-byte 거절을 추가하지 않는다. 실행 결과가 기대와 다르거나 오류 분류·기존 DEC-01/02 기대값·Rust·원본 manifest·추가 바이트 호환성 변경이 필요하면 관련 파일·최소 입력·실제 결과와 정적 예상의 차이·변경 영향·권장안을 제시해 사용자에게 질문하고 해당 의미 변경을 보류한다.

## DEC-03 미검증 범위와 결과 갱신

DEC-03 실제 Registry 생성·resolved JCS digest 확인·실제 WASM 설치/디코딩과 통합 회귀는 사용자 실행 로그 기준 검증 완료다. 구체적인 resolved digest 문자열·JS/WASM hash·실행 HEAD·시각 등 로그에 없는 값은 미제공으로 유지한다. 이번 시험은 WASM 재빌드를 수행하지 않으며 별도 빌드나 산출물 hash 확인까지 입증한 것으로 확대하지 않는다. transfer 정책 평가, typed permit, multicall, Core 공개 API, API/RPC 어댑터, 서명 검증, 소스 디렉터리 이관, CI 개편은 이번에 구현하거나 검증하지 않았다. 실제 token 배포·체인 상태·잔액·전송 성공·recipient 위험성도 이 시험에서 판단하지 않는다.

worker는 요청 객체를 `JSON.stringify`로 WASM에 전달하므로 **raw JSON 문법 오류 문자열은 DEC-01/03 fixture에서 직접 시험하지 않는다.** `invalid_input_json` 중 기존 주소·숫자 파싱과 이번 필드 누락·잘못된 타입 사례가 확인 대상이다. JSON 구문 파서의 현재 오류 분류는 소스 검토 근거이며 이 fixture의 실행 검증으로 일반화하지 않는다.

이 시험은 기존 `registryV2` builder/의존성과 `crates/policy-engine-wasm/pkg`, 서버 아래 공통 Action 타입, DEC-02의 확장 경로 정책을 재사용하는 기준 시험이다. 임시 경로 목록과 제거 단계는 [README](README.md#남아-있는-임시-경로-의존), SDK 소스·빌드 독립화 완료 조건은 [전체 계획](../../docs/sdk-migration/decoder-core-adapters-plan.md)에 남긴다. 기존 WASM을 이용한 기준 시험의 통과만으로 SDK 독립화를 완료로 표시하지 않는다.

DEC-04 사용자 실행 기록·준비·직접 WASM 빌드·시험과 문서 커밋 안내는 [README](README.md#사용자가-직접-실행할-준비빌드시험-명령)를 따른다. 04a 당시 Rust·빌드 입력은 바꾸지 않아 검증된 같은 빌드의 JS/WASM 쌍을 재사용할 수 있었다. 04b는 Rust 변경 후 새 WASM을 직접 빌드했고 사용자 실행 로그에서 성공을 확인했다. `npm run decoder:test:transfer`와 `npm run decoder:test`는 내부에서 Registry를 빌드하므로 에이전트가 실행하지 않았다.

사용자가 제공한 개별 21개·통합 58개 통과 결과를 README·이 coverage·두 계획서에 함께 반영했다. DEC-03의 실행 HEAD·시각·도구 버전·hash는 이번 로그에 미포함이며 임의로 채우지 않는다. 이 메타데이터의 부재 때문에 DEC-03 검증 완료를 대기로 되돌리거나 재실행을 요구하지 않는다. 착수 HEAD `26df736b4d8f0073cfefccf70f68d3b243b016b5`와 과거 DEC-01/02 실행 메타데이터를 새 실행 기록으로 복사하지 않는다. DEC-01/02의 37개 통과 기록과 미제공 항목은 보존한다.


## DEC-04a — 작성 범위와 사용자 실행 통과

착수 상태는 `feat/decoder`, HEAD `b10271365ce06a944b5672d833545db42b243881`, 작업 트리 깨끗함이었다. 기존 58개 시험 파일·fixture는 변경하지 않는다. 에이전트는 빌드·시험을 실행하지 않았다. 04a는 사용자 제공 전체 로그 기준 typed permit **47/47 통과**(`duration_ms=801.277375`), 당시 통합 **105/105 통과**(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 이전 기록으로 채우지 않는다.

선택 구성은 `buildRegistry(selection, { includePermit: true })`, 즉 approve + 실제 USDC permit이다. 기존 기본 호출과 `{ includeTransfer: true }`의 반환 계약을 유지하고 permit 선택에만 `permitSource`를 더한다.

| 생성물 검사 요구값 | 정확한 내용 | 근거·검증 상태 |
| --- | --- | --- |
| by-callkey 5개 | 기존 네 체인 approve 4개 + `1__0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__0xd505accf.json` | 04a 사용자 실행에서 구조 검사 통과 |
| by-typed-data 1개 | `1__0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__Permit.json` | typed index에서 permit bundle 해소·JCS 확인 후 설치 |
| by-selector 0개 | 주소가 구체적으로 선언/해소되어 selector fallback 없음 | 추가 index가 생겨도 시험 실패 |
| permit index 형식 | calldata/typed 모두 inline, 동일 bundle·JCS digest | 원본을 3-ref로 재작성하지 않음 |
| 기존 회귀의 설치 구성 | approve-only 4 callkey/typed 없음, approve+transfer 8 callkey/typed 없음 | 기존 세 시험 파일·58개를 통합 명령 앞부분에 그대로 유지 |

typed primary type `Permit`, domain name `USD Coin`, 선언 배열 `owner/address → spender/address → value/uint256 → nonce/uint256 → deadline/uint256`를 실제 원본과 대조한다. source SHA-256은 원본 바이트로 계산했으며 resolved bundle JCS digest와 다르다. 구체적인 resolved digest 값은 로그에 미제공이며 임의 기입하지 않는다.

새 `typed-permit.cases.json`과 `typed-permit.test.mjs`는 요청 44개와 구조 검사 3개, **47개를 작성**했다. 그룹별 요청 수는 normal 5, routing_miss 4, input_error 17, emit_error 11, legacy_observation 7이다. 04a 사용자 실행에서 47개 모두 통과했다. 정확한 case ID는 [fixture](typed-permit.cases.json)에 고정한다.

| 분류 | 사례·검사 | 04a 사용자 실행에서 확인한 결과 | SDK 엄격 계약 요구 |
| --- | --- | --- | --- |
| 정상 입력 해석 | 실제 mainnet USDC, value 0·일반·uint256 MAX, 혼합 대소문자, 안전 범위 number deadline | 정확한 decoder ID·body·offchain_sig meta | 동일 구조를 full-input 검증 후 해석 |
| routing miss | 정상 형식의 미등록 chain/contract/primaryType/witnessType | `no_typed_data_mapper` | malformed와 지원 범위 밖을 분리 |
| DTO 입력 오류 | 필수 필드 누락·잘못된 타입, 주소 형식·음수 u64 | `invalid_input_json` | 구조·형식 오류 유지, 안정적인 필드 진단 추가 |
| emit 입력 오류 | spender/value/deadline 누락·형식 오류와 message 배열 | `build_action_body_failed` | 알려진 Permit 필드 오류는 emit 이전 malformed로 분류 |
| legacy observation | owner/nonce 누락·형식 오류, domain_name 불일치·누락/null | emit에 쓰이지 않거나 표시용 필드여서 현재 성공할 수 있음 | 올바른 정상 입력으로 인정하지 않음. 필수 message 및 선언 domain 제약 검사 필요 |
| 구조·설치 상태 | exact indexes·bundle/JCS, 고정 수량 독립 검산, 설치·미설치·approve-only 프로세스 | 실제 typed export 결과와 설치 ID 대조 | source→Registry→WASM 연결 증거로 유지 |

수량의 고정 decimal/hex 문자열과 `BigInt`를 독립 비교하며 큰 정수를 JS `Number`로 바꾸지 않는다. body의 `domain: "token"`, `action: "erc20_permit"`, token contract·spender·amount·deadline·nonce LiveField와 전체 meta를 검사한다. 기본값인 domain `version`/`salt`, `nonce_key`, `reenter_callback`, LiveField `confidence`의 생략은 Rust 직렬화를 따른다.

`message.nonce`는 서명 요청 원본이다. 현재 Action의 nonce는 `live_inputs.nonce`로 주입된 외부 조회용 stub `value: "0x0"`, source `{ kind: "onchain_view", chain: "eip155:1", contract: USDC, function: "nonces(address)", decoder_id: "erc20_permit_nonce" }`, TTL 12, `synced_at = submitted_at`이다. 실제 조회나 검증된 chain nonce가 아니다. owner는 현재 body에 없어 검증 완료로 볼 수 없으며 submitter와 동일성 규칙을 추가하지 않는다.

## DEC-04 한계 — 실행된 관찰과 정적 deadline 분석의 차이

| 관련 코드·최소 입력 | 기존 동작·검증 근거 | 영향·04b 판단 |
| --- | --- | --- |
| `dto.rs`의 `DeclarativeRouteTypedDataV3InputDto`: 전체 domain/types 없음 | owner·nonce 등 emit 비소비 필드를 완전 검증하지 않음 | 기존 축약 호환 경로 유지 + 별도 full-input 계약 필요 |
| 정상 defaults에서 owner 또는 nonce만 누락/잘못된 값 | 04a legacy observation 통과: flat message emit은 spender/value/deadline만 사용 | fixture의 `legacy_observation`은 정상 EIP-712 계약이 아닌 검증 공백 기록 |
| 같은 정상 defaults에서 `domain_name: "Other Token"` | typed key에 name 없음, `Action.meta.nature.domain.name`에 요청값 반영 | manifest name 제약을 검증했다는 증거 아님. 04b strict에만 선언 제약 검사 추가, 사용자 실행 통과 |
| 같은 정상 defaults에서 `message.deadline: "18446744073709551616"` (`2^64`) | `action_builder.rs`의 `coerce_decimal_string_to_u64`는 parse 실패를 `u64::MAX`로 변환; `declarative_exports.rs`의 `message_u64`/meta는 실패 시 0 | 같은 요청에 body/meta 시간이 달라질 수 있음. **정적 검토 전용**, 성공 기대값 고정·공통 Time 변경 없음 |
| `Time`은 투명 `u64`, JSON number로 직렬화; JS 안전 정수는 `2^53-1` | u64 범위 안이어도 JS parse 후 정밀도 손실 가능 | 사용자 확정: raw uint256 deadline 보존 + JS 안전 투영 한도 초과 명시적 오류. 기존 Action/meta 유지 |

위 deadline 최소 입력은 `typed-permit.cases.json`의 defaults를 완전한 요청으로 사용하고 deadline 필드 하나만 교체한다. 나머지 owner/spender/value/nonce·routing·submitter·submitted_at을 유지한다. 런타임 재현 시험에 이 overflow를 넣지 않았으므로 body MAX/meta 0을 실측값으로 기록하지 않는다. `Time`의 u64 표현 한도와 JS JSON 정밀도 한도를 하나로 취급하지 않는다.

04b 설계는 [상세 계획 DEC-04](../../docs/sdk-migration/decoder-design-plan.md#dec-04--eip-2612와-typed-입력-계약--전체-계획-d2)에 입력 예시·검증 순서·오류·변경 파일·호환 영향·네 계약의 확정 답변을 기록한다. 원본 `domain/types/primaryType/message` 및 requested_signer/submitter·시각을 보존하고 원본과 routing 정규화 값을 구분한다. 요청 `types`의 필드 배열 순서는 의미가 있으며 JSON 객체 키 순서와 다르다. 기존 `sig-routing.ts`·시험·WASM bridge 소비자는 조사 대상으로만 읽고 Chrome runtime을 Node 시험에 import하지 않는다.

## DEC-04b 확정 계약·작성한 회귀

`requested_signer`는 서명 대상 지갑이다. strict ERC-2612 Permit에서 각 주소 원본을 유지하고, 정규화한 owner와 requested_signer의 일치를 **요청 일관성 조건**으로 검사한다. 불일치는 명시적 오류로 반환한다. submitter는 별도 제출 주체로 보존하고 owner와 달라도 허용해 대리 제출을 지원한다. 주소가 같더라도 **실제 서명은 미검증 상태**임을 명시한다.

확정 검증 순서는 **기본 입력 형식·routing/domain 충돌 → lookup → 지원 manifest의 types/domain/message → owner/requested_signer 일관성·deadline 표현 범위 → emit**이다. manifest가 선언한 name/chain/contract/types를 대조하고 version/salt는 원본 보존·형식 검사만 한다. 미선언 기대값은 추가하지 않는다. strict 실패·미지원 모두 v3 자동 재시도를 금지하며 기존 v3 의미는 유지한다.

| 04b 작성한 회귀 입력·조건 | 구현한 계약(사용자 실행 통과) |
| --- | --- |
| 정상 full Permit, owner/requested_signer 주소 대소문자만 다름 | 정규화 후 일치하여 요청 일관성 조건 충족. 원본은 각각 유지하고 실제 서명은 미검증으로 표시 |
| 지원하는 Permit, owner/requested_signer가 서로 다른 유효 주소 | 요청 일관성 불일치를 명시적 오류로 반환. 서명이 암호학적으로 잘못됐다고 단정하지 않음 |
| 지원하는 정상 Permit, owner/requested_signer 일치 + 다른 submitter | 별도 제출 주체를 유지하며 대리 제출 허용 |
| 미등록 contract + 잘못된 owner | lookup의 미지원 우선. **지원 범위 밖이므로 상세 검증하지 않았음**이며 검증 성공이 아님 |
| 지원하는 Permit의 message/types/domain 형식·불일치 | 상세 검증을 모두 수행하고 명시적 오류로 반환. 뒤의 주체 일관성·deadline 표현 검사보다 선행 |
| strict 실패 또는 미지원 | v3 자동 재시도 없음. 오류 우선순위와 상세 검증 미수행 의미를 회귀로 고정 |

위 계약을 별도 v4 validator/export와 shared Rust/Node fixture로 구현했다. 기존 04a 축약 DTO의 정상·오류·legacy observation 기대값은 유지한다. nonce는 여전히 signed nonce와 외부 조회 nonce를 구분하며 서명 복구·체인 조회·최종 정책 판정은 포함하지 않는다.

## DEC-04 상태·후속 검증

- **04a:** 사용자 typed permit 47/47, 당시 통합 105/105 통과. 위에 기록한 실행 메타데이터 미제공 항목과 기존 30/37/58 통과 이력 유지.
- **04b:** 별도 v4 full-input DTO·순수 validator·실제 emit 연결, worker `typed_strict`, shared fixture와 Rust/Node 회귀 작성. Node 요청 163개+구조 5개=168개, 기존 105개를 보존한 통합 정의 273개. 저장된 사용자 로그에서 strict 168/168·통합 273/273 통과를 확인했다.
- **DEC-04 전체:** 검증 완료. Native 시험 → 새 WASM 빌드 → strict 개별·기존 typed 개별·전체 Node 회귀가 모두 성공했다.

strict fixture는 정상 20, 기본 입력 49, message 46, domain 8, deadline 표현 5, 주체 일관성 1, routing 9, lookup miss 5, 우선순위 5, types 12, 원문 보존 3개 요청을 작성했다. 누락/형식/uint256 범위, `2^53-1`/`2^53`/`2^64`/`2^256` 경계, 원본 object·JSON string과 생략 보존, version/salt, 잘못된 field type/order/reference/cycle, unknown+malformed 우선순위, 대리 submitter와 v3 독립 호출을 검사한다. 수량 기대값은 문자열과 BigInt로 독립 검산한다. Native 추가 시험은 raw JSON 오류/정밀도, 다른 설치 typed bundle의 미지원, manifest/emit 내부 결함을 검사한다.

04b 정적 검토: 수정/관련 JS 4개 `node --check`, 설치된 Rust formatter의 새 코드 형식·5개 Rust 파일 구문 확인, 문서 shell 블록 8개 `bash -n`, JSON·고정 수량·주소·원본 7개 hash 대조, 기존 v3 함수의 바이트 동일성 및 04a patch 경계를 확인했다. `git diff --check`와 신규 파일 공백 검사도 문제없다. 이는 구현 당시 에이전트의 정적 검토 기록이다. 에이전트는 Rust 컴파일·Registry/WASM/Node 시험을 직접 실행하지 않았으며, 후속 사용자 실행 로그의 성공은 아래 별도 기록으로 확인했다.

## DEC-04b 저장 로그 확인·완료 기록

사용자 실행 로그 `/private/tmp/dambi-dec04b-verify.OepBZF/`를 읽어 다음 결과를 확인했다. 에이전트의 재실행이 아니다.

| 검증 | 실제 통과 | 실행 시간 |
| --- | --- | --- |
| Native strict / typed install / route / helpers | 7 / 7 / 138 / 29개 (합계 181개) | 0.05 / 0.01 / 0.07 / 0.01s |
| Node strict | 168/168 | 943.529416ms |
| Node 기존 typed | 47/47 | 514.873041ms |
| Node 통합 | 273/273 | 901.401958ms |

각 Native 실패·ignored·measured는 0이다. helpers의 66개 filtered out은 지정한 모듈 외 시험이며 통과 수에 넣지 않는다. Node 세 실행은 suites·fail·cancelled·skipped·todo 모두 0이다. `timeline.log`의 Native 시작은 `2026-09-11T10:09:50Z`, 새 WASM 빌드는 `10:10:27Z–10:11:21Z`, Node는 `10:11:21Z–10:11:24Z`이고 세 그룹 모두 exit=0이다. 개별 시험별 timestamp는 기록되지 않았다.

실행 HEAD는 전후 `b10271365ce06a944b5672d833545db42b243881`이며 DEC-04 미커밋 변경을 포함한 worktree에서 검증했다. 이후 04a `593ea166421b3cff7bdc6f2fa0704143f64bd389`와 04b `e487805bdb86451a6c9688f7b2dcce399cc13892`로 분리 커밋됐다. 전후 tracked patch·Git 상태가 같고, 로그에 기록한 입력 24개는 현재 파일과 `e487805`의 Git blob에 모두 일치한다. 추적된 11개 경로 patch도 해당 커밋 diff와 일치한다. 현재 JS/WASM 2개 hash도 기록값과 같으며 로그의 사후 검사는 입력 24개·산출물 2개 모두 OK다. 실행 HEAD를 현재 커밋으로 대체하지 않는다.

실제 도구는 Rust/Cargo 1.95.0, wasm-pack 0.14.0, Node v25.9.0, npm 11.12.1이며 `CARGO_TARGET_DIR=/tmp/dambi-dec04b-verify.OepBZF/target`, release opt-level=z를 사용했다. 상세 빌드 명령·두 산출물 SHA-256·비차단 빌드 안내는 [README](README.md#dec-04b-실행-기록--저장-로그-확인dec-04-완료)의 별도 실행 기록에 보존한다. **04a/04b 구현·분리 커밋·사용자 실행 검증을 완료하여 DEC-04 완료**로 기록한다. D2 전체·SDK 전체 독립화는 미완료이며 DEC-05로 자동 진행하지 않는다. 이번 네 문서 갱신에 재시험은 필요하지 않다.

상세 DTO·오류 계약은 [설계](../../docs/sdk-migration/decoder-design-plan.md#04b--전체-입력출력-계약-네-계약-답변-수신반영-완료), 실행·분리 커밋 명령은 [README](README.md#사용자가-직접-실행할-준비빌드시험-명령)를 따른다. 04b에서 Rust를 변경했으므로 과거 pkg로 새 strict 회귀를 실행하지 않는다. 이번 저장 로그의 결과를 네 문서에 함께 반영했다. 과거 04a 실행의 미제공 항목을 새 04b 값으로 소급 보충하지 않는다.

서명 복구·암호 검증, 체인상 nonce 유효성, deadline의 실제 사용 가능성, 정책 allow/warn/deny, Permit2·multicall·selector 오류 개선·Core·네트워크 어댑터·소스 이관·CI는 구현/검증하지 않았다. DEC-05로 자동 진행하지 않는다.
