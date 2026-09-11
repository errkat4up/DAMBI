# Decoder 기준 시험 커버리지

**DEC-01/02의 과거 사용자 실행 기준 37개 통과(30 + 7) 기록을 유지하며, DEC-03도 사용자 실행 보고 기준 검증 완료다.** 새로 제공된 전체 로그에서 transfer 개별 21개와 통합 회귀 58개가 모두 통과했다. 두 실행 모두 실패·취소·건너뛰기·todo·suites는 0이며 `duration_ms`는 각각 `866.922333`, `635.086875`다. 에이전트의 독립 재실행 결과가 아니다. DEC-04는 미착수이고 SDK 전체 소스·빌드 독립화는 미완료다.

## 원본·설치 범위

| source ID | source 파일 (`registryV2/` 기준) | selector | 실제 원본 바이트 SHA-256 |
| --- | --- | --- | --- |
| `standard/erc20/approve@1.0.0` | `manifests/standard/erc20/approve@1.0.0.json` | `0x095ea7b3` | `0x0a51874b0d42a209e61a79083821338b67c3968c27bda6eea48fc8a78ad5047e` |
| `standard/erc20/transfer@1.0.0` | `manifests/standard/erc20/transfer@1.0.0.json` | `0xa9059cbb` | `0x47e37a1ada72a9fee9e4b8077b7000f0b1198a0219fa513d3ccb74def70ee925` |

두 원본은 모두 `chain_ids: [1, 10, 8453, 42161]`, `chain_to_addresses_source: "tokens:erc20"`를 유지한다. `registry-selection.json`의 기존 approve/token 경로·hash는 보존하고 transfer 선택만 추가했다.

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

DEC-01 30개 + DEC-02 7개는 사용자 실행 보고 기준으로 모두 통과했다. 이번 helper·npm 명령 변경 후의 통합 58개 로그에서도 기존 37개가 모두 통과했다. 과거 37개 실행 기록은 보존하며 새 회귀 실행과 구분한다.

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

## 미검증 범위와 결과 갱신

DEC-03 실제 Registry 생성·resolved JCS digest 확인·실제 WASM 설치/디코딩과 통합 회귀는 사용자 실행 로그 기준 검증 완료다. 구체적인 resolved digest 문자열·JS/WASM hash·실행 HEAD·시각 등 로그에 없는 값은 미제공으로 유지한다. 이번 시험은 WASM 재빌드를 수행하지 않으며 별도 빌드나 산출물 hash 확인까지 입증한 것으로 확대하지 않는다. transfer 정책 평가, typed permit, multicall, Core 공개 API, API/RPC 어댑터, 서명 검증, 소스 디렉터리 이관, CI 개편은 이번에 구현하거나 검증하지 않았다. 실제 token 배포·체인 상태·잔액·전송 성공·recipient 위험성도 이 시험에서 판단하지 않는다.

worker는 요청 객체를 `JSON.stringify`로 WASM에 전달하므로 **raw JSON 문법 오류 문자열은 DEC-01/03 fixture에서 직접 시험하지 않는다.** `invalid_input_json` 중 기존 주소·숫자 파싱과 이번 필드 누락·잘못된 타입 사례가 확인 대상이다. JSON 구문 파서의 현재 오류 분류는 소스 검토 근거이며 이 fixture의 실행 검증으로 일반화하지 않는다.

이 시험은 기존 `registryV2` builder/의존성과 `crates/policy-engine-wasm/pkg`, 서버 아래 공통 Action 타입, DEC-02의 확장 경로 정책을 재사용하는 기준 시험이다. 임시 경로 목록과 제거 단계는 [README](README.md#남아-있는-임시-경로-의존), SDK 소스·빌드 독립화 완료 조건은 [전체 계획](../../docs/sdk-migration/decoder-core-adapters-plan.md)에 남긴다. 기존 WASM을 이용한 기준 시험의 통과만으로 SDK 독립화를 완료로 표시하지 않는다.

사용자 실행 명령과 필요한 경우의 준비·직접 WASM 빌드, 명시적 9개 파일 커밋 안내는 [README](README.md#사용자가-직접-실행할-준비빌드시험-명령)를 따른다. 이번 Rust·빌드 입력은 바꾸지 않았으므로 기존 검증된 같은 빌드의 JS/WASM 쌍은 재사용할 수 있다. `npm run decoder:test:transfer`와 `npm run decoder:test`는 내부에서 Registry를 빌드하므로 에이전트가 실행하지 않았다.

사용자가 제공한 개별 21개·통합 58개 통과 결과를 README·이 coverage·두 계획서에 함께 반영했다. DEC-03의 실행 HEAD·시각·도구 버전·hash는 이번 로그에 미포함이며 임의로 채우지 않는다. 이 메타데이터의 부재 때문에 DEC-03 검증 완료를 대기로 되돌리거나 재실행을 요구하지 않는다. 착수 HEAD `26df736b4d8f0073cfefccf70f68d3b243b016b5`와 과거 DEC-01/02 실행 메타데이터를 새 실행 기록으로 복사하지 않는다. DEC-01/02의 37개 통과 기록과 미제공 항목은 보존한다.
