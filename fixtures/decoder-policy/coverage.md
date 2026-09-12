# Decoder 기준 시험 커버리지

**DEC-06c·DEC-06 검증 상태:** 구현·정적 검토·사용자 검증 완료. self·Call[]·callback이 요청별 깊이/노드 예산과 진단을 공유하며 미해석 구간은 Unknown으로 보존한다. 실행 근거는 [README 검증 기록](README.md#dec-06c--사용자-검증-완료-dec-06-완료)을 따른다. 아래 06a/06b는 기존 기준선의 범위 기록이며 DEC-07은 미착수다.

**DEC-06b 구현 당시 상태:** Call[] 연결 구현·정적 검토 완료, 사용자 실행 대기. 요청 43개 + 구조 6개 = **49개**, 기존 514개 포함 통합 **563개 정의**이며 통과 수가 아니다. DEC-06a는 검증·분리 커밋 완료, 06c는 별도 미구현이다. [06b 상세](#dec-06b--call-연결과-현재-한계).

**DEC-06a 최신 상태:** 성공 로그 `AsBmk6`에서 **self 48/48·통합 514/514 사용자 재실행 검증 완료**. 최초 실패 기록은 보존한다. DEC-05 기록 `56ece47`·06a 구현 `9923487`의 실제 분리 커밋과 성공 로그 입력 대응을 확인했다. 06b는 이번 별도 변경으로 진행하며 06c는 미구현이다. 상세 범위는 [DEC-06a](#dec-06a--self-multicall-연결과-현재-한계)를 따른다.

**DEC-05 최신 상태:** Single **85/85·당시 통합 358/358**에 이어 Batch **108/108·통합 466/466 사용자 실행 검증 완료**다. 저장 로그 입력 44개를 실행 HEAD `66af65c`의 작업 트리와 이후 구현 커밋 `1326fb5`에 구분해 대응했다. DEC-05는 **A안의 기존 v3 연결·진단·교정 설계 범위에서 완료**하며 nonce·입력 범위/형식·시간·v4 교정은 후속 항목으로 유지한다. 아래 DEC-01~04의 “현재/이번”·DEC-05 미진행 표현은 해당 과거 기록이다. Batch 근거는 [DEC-05b](#dec-05b--작성한-검사와-미결-계약), Single 근거는 [DEC-05a](#dec-05a--작성한-검사와-미결-계약)를 따른다.

**DEC-01/02의 과거 사용자 실행 기준 37개 통과(30 + 7) 기록을 유지하며, DEC-03도 사용자 실행 보고 기준 검증 완료다.** 새로 제공된 전체 로그에서 transfer 개별 21개와 통합 회귀 58개가 모두 통과했다. 두 실행 모두 실패·취소·건너뛰기·todo·suites는 0이며 `duration_ms`는 각각 `866.922333`, `635.086875`다. 에이전트의 독립 재실행 결과가 아니다. 04a는 사용자 제공 전체 로그 기준 typed permit **47/47 통과**(`duration_ms=801.277375`), 당시 통합 **105/105 통과**(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 이전 기록으로 채우지 않는다. 04a 사용자 실행 결과를 반영했고, 합의된 04b v4 DTO·strict validator·실행부·Rust/Node 회귀 시험을 별도 변경으로 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. SDK 전체 소스·빌드 독립화도 미완료다.

## 원본·설치 범위

| source ID | source 파일 (`registryV2/` 기준) | selector | 실제 원본 바이트 SHA-256 |
| --- | --- | --- | --- |
| `standard/erc20/approve@1.0.0` | `manifests/standard/erc20/approve@1.0.0.json` | `0x095ea7b3` | `0x0a51874b0d42a209e61a79083821338b67c3968c27bda6eea48fc8a78ad5047e` |
| `standard/erc20/transfer@1.0.0` | `manifests/standard/erc20/transfer@1.0.0.json` | `0xa9059cbb` | `0x47e37a1ada72a9fee9e4b8077b7000f0b1198a0219fa513d3ccb74def70ee925` |
| `standard/erc20/permit@1.0.0` | `manifests/standard/erc20/permit@1.0.0.json` | `0xd505accf` | `0x9e7337ae3ce7e1a80851652e39b2ac4fb264b5e8caf00a4c93193c6b93c76eb3` |
| `uniswap/permit2/permitSingle@1.0.0` | `manifests/uniswap/permit2/permitSingle@1.0.0.json` | `0x2b67b570` | `0x6657c04696e97d08aaa80cc842d3d7976df7515953e7506fa97e50bd2812e696` |
| `uniswap/permit2/permitBatch@1.0.0` | `manifests/uniswap/permit2/permitBatch@1.0.0.json` | `0x2a2d80d1` | `0x0343bc44659b2b1e7e184a39e7e17acd642ec52f2776adca963df4d8d3bd35ee` |

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

## DEC-05a — 작성한 검사와 미결 계약

**DEC-05a 저장 로그 확인:** `/private/tmp/dambi-dec05a-verify.JPtwLZ/`에서 Single **85/85 통과**(`duration_ms=728.833416`), 당시 통합 **358/358 통과**(`duration_ms=1055.562083`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. 실제 실행 HEAD는 전후 `60bb3d561b889594ce5837088d74f072de4fd6a2`이며 9개 미커밋 경로가 있던 worktree다. 이후 사용자 커밋 `66af65c6bbe0adb6f8fbb9941aac729ec330b801`과 **Batch 편집 전** 파일을 대조하여 로그 입력 41개가 모두 현재 파일·Git blob에 일치함을 확인했다. 전후 tracked patch도 바이트 동일하고 입력 41개·산출물 2개 사후 검사는 모두 OK다. Node v25.9.0/npm 11.12.1, UTC Single `2026-09-12T06:46:09Z–06:46:10Z`, 통합 `06:46:10Z–06:46:11Z`, verification/input hash/artifact hash exit는 모두 0이다. DEC-04의 같은 JS/WASM 쌍을 재빌드 없이 사용했고 현재 산출물 hash도 일치한다. 실행 HEAD와 이후 구현 커밋을 구분한다. 에이전트 재실행이 아니며 full EIP-712·서명·외부 nonce 검증이나 A안에서 별도로 남긴 계약 교정의 완료가 아니다. 상세 로그·hash는 [README](README.md#dec-05a-사용자-실행-기록--저장-로그-확인)에 기록했다.

**코드 작성·정적 검토 및 사용자 실행 검증 완료.** 새 [`permit2-single.cases.json`](permit2-single.cases.json)과 [`permit2-single.test.mjs`](permit2-single.test.mjs)은 실제 Single 원본을 사용한다. 요청은 normal 19, routing_miss 6, input_error 12, emit_error 26, legacy_diagnostic 14, compatibility 2인 **79개**, 구조 검사 6개를 더한 **85개 정의**다. 사용자 로그에서 Single **85/85** 및 당시 통합 기존 273개 + 신규 85개 = **358/358 통과**를 확인했다. 구조 검사에는 기존 USDC flat 회귀와 v4 Permit2 미지원 경계도 포함한다. 아래 정상·오류·관찰 검사는 사용자 실행에서 통과했다. 원래 정적 분석으로 설명한 raw 시간 한계는 별도 근거로 유지한다. nonce·폭·시간 관련 관찰은 정상 Permit2 입력으로 승인하거나 계약 문제를 해결했다는 뜻이 아니다.

**DEC-05a 정적 검토 기록:** 신규 시험/helper 2개의 `node --check`, README 신규 Bash 블록 2개의 `bash -n`, JSON 3개 파싱·unsafe integer literal 부재, 명령의 입력 41개 경로 존재를 확인했다. 고정 원본 8개의 hash가 일치하고 기존 시험 5개·fixture 4개·worker의 10파일은 HEAD와 바이트가 같다. decimal 경계 9개를 정확한 정수 거듭제곱으로 독립 검산했고 `git diff --check`·신규 파일 공백 검사도 이상 없다. DEC-04 저장 로그의 JS/WASM 쌍 및 Rust/빌드 입력 9개와 현재 hash가 일치한다. 이는 구문·원본·소스 대조이며 Registry 빌드·Native/WASM/Node 시험을 실행한 결과가 아니다.

| 설치 검사 | 작성한 요구값·구분 |
| --- | --- |
| 선택 | approve + USDC permit + Permit2 Single. `includePermit: true`, `includePermit2Single: true` |
| callkey | 9개: approve 4 + USDC permit 1 + Single 4 |
| typed index | 5개: mainnet USDC `Permit` 1 + 네 체인 Permit2 `PermitSingle` 4 |
| selector index | 0개. concrete 주소가 있으므로 selector fallback 생성 불허 |
| Single chain/contract | `1/10/8453/42161`, 각 `0x000000000022d473030f116ddee9f6b43ac78ba3`. token 목록을 이용해 재확장하지 않음 |
| 원본·bundle·설치 | source 바이트 SHA-256, 네 체인 typed/callkey 참조, inline bundle 원본 보존·동일 JCS digest, 실제 WASM install ID·typed decode ID |
| 기존 호출 | approve-only·transfer·EIP-2612 선택과 반환 구조 유지. worker typed 분기·실제 WASM·프로세스 격리 재사용 |

| 분류 | 작성한 입력·검사 | 해석 범위 |
| --- | --- | --- |
| 정상 객체 | 네 체인, `details.token/amount/expiration/nonce`, 공통 spender/sigDeadline, 객체 키 재배열 | body·meta 필드 대응. underlying token·Permit2 verifying contract·spender·submitter가 다른 역할이며 message owner를 새로 만들지 않음 |
| ABI 변환·회귀 | named object → ABI components 순서의 positional tuple, EIP-2612 flat message 유지 | Rust 기존 변환 경로를 실제 원본으로 연결. JS에 별도 decoder를 구현하지 않음 |
| 수량 경계 | amount `0`, 일반 값, `2^160−1`, `2^160` | 선언 범위 안의 변환과 `2^160` 허용 한계 관찰을 구분. decimal string·BigInt로 독립 검산 |
| expiration/nonce 경계 | `0`, 일반 값, `2^48−1`, `2^48` | `2^48`은 선언 폭 밖의 진단. Action에 들어간다는 이유로 유효한 Permit2 입력으로 세지 않음 |
| signed nonce 표현 | `255 → ["0x0",255]`, `256 → ["0x1",0]`, `513 → ["0x2",1]` | 원본 nonce·현재 tuple·LiveField source·ttl·synced_at을 각각 확인. 실제 체인 조회 결과 아님 |
| 필수 필드·형식 | 필드 누락, null, 잘못된 형식을 구분; 특히 nonce 누락/null/파싱 실패를 별도 관찰 | 다른 emit 필드 오류와 nonce의 zero fallback을 같은 정상 결과로 뭉치지 않음 |
| 시간 | 정상 안전 정수 sigDeadline의 body/meta 일치, 큰 sigDeadline의 별도 진단 | `u64` 표현 한계와 JS 안전 정수 한계를 구분하고 정밀도를 잃은 Number로 기대값 생성 금지 |
| 매칭·입력 오류 | 미등록 chain/contract/primary type과 매칭 후 malformed 요청 | lookup miss `no_typed_data_mapper`, DTO 오류 `invalid_input_json`, emit 오류 `build_action_body_failed` 구분 |
| 내부 호환 관찰 | positional details/내부 배열 형태 | 정상 EIP-712 object와 별도 분류. root 배열은 named meta lookup의 한계도 존재 |

기본 정상 요청은 다음과 같다. 아래 계약 진단의 최소 입력은 이 요청의 지정 필드 하나만 바꾼다. `nonce`는 서명 원문 값이고 외부 체인 상태가 아니다.

```json
{
  "chain_id": 1,
  "verifying_contract": "0x000000000022d473030f116ddee9f6b43ac78ba3",
  "primary_type": "PermitSingle",
  "domain_name": "Permit2",
  "message": {
    "details": {
      "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "amount": "1000000",
      "expiration": "1738003000",
      "nonce": "513"
    },
    "spender": "0x2222222222222222222222222222222222222222",
    "sigDeadline": "1738002000"
  },
  "submitter": "0x3333333333333333333333333333333333333333",
  "submitted_at": 1738000000
}
```

| 미결 계약·최소 변경 | 현재 소스의 정적 예상 | 의도한 계약과 최소 수정안·소비자 영향 |
| --- | --- | --- |
| nonce 모델: 기본 `details.nonce: "513"` | `action_builder.rs`의 `permit2_nonce_tuple_default`가 word/bit로 분해해 `["0x2",1]`로 직렬화. 원본 source는 `nonceBitmap(address,uint256)` | AllowanceTransfer는 owner/token/spender별 순차 uint48 nonce다. 별도 signed allowance nonce와 live allowance 조회 모델을 설계해야 하며 `Permit2SignAction`, sync args, transition의 bitmap 소비도 영향을 받음. manifest 함수 이름만 교체하면 해결되지 않음 |
| malformed: details에서 nonce 제거, `null`, `"bad"` | ABI 변환은 누락을 null로 채우고 U256 파싱 실패는 기본 tuple `["0x0",0]`으로 바뀔 수 있음 | 서명 nonce 필수 검증·fallback 제거 시 기존 v3 성공이 오류로 바뀜. 별도 검증 단계와 오류 우선순위를 합의한 뒤 최소 수정 |
| 폭: amount=`"1461501637330902918203684832716283019655932542976"` 또는 expiration/nonce=`"281474976710656"` | 각각 `2^160`, `2^48`. v3는 선언 `uint160/uint48` 폭을 검사하지 않아 출력 타입 범위에서 허용 예상. nonce `2^48`은 `["0x10000000000",0]` | 선언 범위 검증을 추가하면 기존 입력 허용 범위가 줄어듦. v3 일괄 변경보다 별도 Permit2 계약의 검증 범위를 결정 |
| u64 시간: sigDeadline=`"18446744073709551616"` | body Time은 `18446744073709551615`로 포화, meta는 파싱 실패 시 0. worker의 JSON.parse 후 body도 정확한 정수 표현을 잃음 | DEC-04와 같은 raw uint256 보존 + 안전한 Action/meta 투영 한도/오류 계약 필요. 공통 Time 또는 v3를 조용히 변경하지 않음 |
| JS 시간: sigDeadline=`"9007199254740993"` | Rust body/meta는 같은 u64를 JSON number로 출력하지만 JS가 정확한 값을 유지하지 못함 | `2^53−1` 초과 처리를 명시해야 함. rounded Number를 정확한 기대값으로 고정하지 않음 |
| v4 Permit2 | `typed_data_validation.rs` strict 지원은 USDC EIP-2612만 | owner가 없는 PermitSingle·중첩 types·nonce·시간을 포함한 별도 계약 확장 필요. 허용 ID만 추가하거나 v4 실패를 v3로 재시도하지 않음 |

위 진단의 관련 구현은 [`declarative_exports.rs`](../../crates/policy-engine-wasm/src/declarative_exports.rs), [`dto.rs`](../../crates/policy-engine-wasm/src/dto.rs), [`action_builder.rs`](../../crates/adapters/mappers/src/declarative/action_builder.rs), [`permit2_sign.rs`](../../crates/policy-server/asset-model/action/src/token/permit2_sign.rs)다. LiveField는 source `{kind: "onchain_view", chain: "eip155:<chain>", contract: Permit2, function: "nonceBitmap(address,uint256)", decoder_id: "permit2_nonce_bitmap"}`, `ttl: 12`, `synced_at: submitted_at`을 사용하고 confidence는 미설정으로 생략한다. source 표시는 RPC 실행이나 신선한 Fact의 증거가 아니다.

PermitSingle/PermitBatch는 AllowanceTransfer이며 순차 nonce를 사용한다. unordered nonce bitmap은 SignatureTransfer 개념이므로 현재 manifest/Action 모델과 프로토콜 의미의 차이를 미결로 남긴다. [AllowanceTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer), [SignatureTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer).

**결정 상태:** 사용자는 교정안 구체화 후 **A — 연결 시험·교정 설계만 마무리**를 선택했다. [구체 계약 교정안 A/B/C](../../docs/sdk-migration/decoder-design-plan.md#dec-05-계약-교정안-a안-확정bc-미구현-제안)는 baseline+설계(A, 확정), v4 입력 검증만 추가(B), 새 allowance Action/소비자까지 교정(C)으로 분리했다. 이번 범위의 미응답 질문은 없다. nonce·malformed·폭·시간·v4 교정은 별도 범위의 미결 문제로 남기며 B/C는 미구현 제안이다. Rust·manifest·worker·기존 273개 기대값은 변경하지 않았다. 실행 명령과 검증된 DEC-04 JS/WASM 재사용 근거는 [README](README.md#dec-05a-사용자-실행-기록--저장-로그-확인)에 있다.

## DEC-05b — 작성한 검사와 미결 계약

**DEC-05b 저장 로그 확인:** `/private/tmp/dambi-dec05b-verify.WCHZDj/`에서 Batch **108/108 통과**(`duration_ms=817.124708`), 기존 DEC-01~04의 273개와 Single 85개를 포함한 통합 **466/466 통과**(`duration_ms=1198.186625`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. 실제 실행 전후 HEAD는 `66af65c6bbe0adb6f8fbb9941aac729ec330b801`이며 Batch 관련 9개 미커밋 경로를 포함한 작업 트리다. 이후 구현 커밋 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`와 DEC-06a 편집 전 파일을 읽기 전용으로 대조하여 입력 **44개 모두 Git blob 및 당시 현재 파일과 일치**함을 확인했다. 실행 후 입력 44개와 JS/WASM 2개 검사도 모두 OK이며 전후 tracked patch·Git 상태·HEAD가 동일하다. Node v25.9.0/npm 11.12.1, UTC Batch `2026-09-12T07:10:27Z–07:10:28Z`, 통합 `07:10:28Z–07:10:30Z`, verification/input hash/artifact hash exit는 모두 0이다. 실제 Batch resolved JCS digest는 `0x161755caa54753a0064c023990f6af3a9698e45b74b414db1bb3a8946f45c0d5`다. 현재 JS/WASM hash는 검증된 DEC-04·Single의 동일 쌍과 일치한다. **DEC-05는 A안의 기존 v3 연결·진단·교정 설계 범위에서 검증 완료**이며 nonce·입력 범위/형식·시간·v4 런타임 교정은 기존 후속 항목이다. 실행 HEAD를 이후 구현 커밋으로 바꾸지 않으며 기록 갱신을 위해 빌드·시험을 재실행하지 않았다.

**코드 작성·정적 검토·사용자 실행 검증 완료.** 실제 [`permitBatch@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitBatch@1.0.0.json)을 연결하는 [`permit2-batch.cases.json`](permit2-batch.cases.json)과 [`permit2-batch.test.mjs`](permit2-batch.test.mjs)의 요청 분류는 normal 25, legacy_diagnostic 22, limit_boundary 1, limit_error 3, empty_observation 1, emit_error 37, input_error 8, routing_miss 5인 **102개**다. 구조 검사 6개를 더한 **108/108**, 기존 358개를 포함한 통합 **466/466**이 사용자 실행에서 통과했다. 아래 정상·오류·관찰 검사는 저장 로그로 확인했으며 raw 시간 포화 등 정적 분석의 한계는 별도 근거로 유지한다. 기존 Single fixture/test·기존 358개 기대값은 보존했다.

구조 검사 6개는 정확한 12/8/0 index·네 체인/JCS, 실제 ABI/emit 원본, BigInt 독립 검산·분류, key 재배열/역순/중복, 같은 프로세스의 Single/Batch 교대 9요청·설치 상태 4개의 프로세스 격리·등록된 primary type 교차 시 입력 오류, v4 Single/Batch unsupported guard다. 요청 경계에는 양쪽 원소 각각의 0/MAX/MAX+1·nonce 255/256/513/770, 64개 정상·65개 전체 오류·65개+첫 원소 오류의 한도 우선·64개+마지막 원소 오류의 전체 전파를 포함한다. 시간 `2^53+1`/`2^64`는 legacy diagnostic이다.

**DEC-05b 정적 검토 기록:** 신규 시험/helper 2개의 `node --check`, README 신규 Bash 블록 2개의 `bash -n`, JSON 3개 파싱·102개 case ID의 유일성·unsafe integer literal 부재를 확인했다. 명령의 입력 44개 경로가 존재하고 고정 원본 9개의 hash가 일치한다. decimal 경계 18개를 정수 거듭제곱으로 독립 검산했으며 기존 시험 6개·fixture 5개·worker의 12파일은 `66af65c`와 바이트가 같다. Rust·빌드 입력에 변경이 없고 현재 JS/WASM hash는 Single 저장 로그의 검증된 쌍과 일치한다. `git diff --check`와 신규 파일 공백 검사도 이상 없다. 별도 소스 검토에서 array_emit의 한도 검사 순서·전체 실패·v4 guard와 기대값을 대조했다. 이는 파일·구문·소스 대조이며 Registry 빌드나 Native/WASM/Node 시험 실행 결과가 아니다.

| 설치·원본 검사 | 요구값·근거 |
| --- | --- |
| 선택 | `includePermit2Single: true`, `includePermit2Batch: true`로 approve + Single + Batch. USDC permit은 이 조합에 포함하지 않음 |
| index 수 | callkey 12개(approve/Single/Batch 각 4), typed 8개(Single/Batch 각 4), selector 0개 |
| 주소·chain | 두 Permit2 manifest의 `1/10/8453/42161` concrete Permit2 주소 직접 선언 유지. USDC token 목록을 통한 Permit2 주소 확장 금지 |
| 실제 원본 | selection의 Batch 원본 바이트 SHA-256 확인, typed/callkey 참조·inline 원본 보존·JCS digest 확인 후 실제 WASM install |
| 변환 | `array_source: "$args.permitBatch[0]"`, 원소 `$inputs[0..3]`와 공통 `$args.permitBatch[1..2]`. ABI components 순서의 기존 Rust named→positional 변환 |
| 같은 프로세스의 primary type 분리 | Single/Batch 동시 설치·교대 요청에서 각 ID/Action. 설치 상태가 다른 경우에는 기존 worker의 별도 프로세스 유지 |
| 비교 원본 | Rust `ON_DISK` Batch 상수는 실제 파일과 다른 named emit·body nonce 누락이므로 이번 원본으로 사용하지 않음 |

| 분류 | 입력·작성한 검사 | 해석 범위 |
| --- | --- | --- |
| 정상 복수 원소 | 서로 다른 token·amount·expiration·nonce, 공통 spender·sigDeadline | 외부 Action 1개 아래 Multicall의 자식 ActionBody에 각 값 투영. 외부 meta 하나이고 자식에는 meta 없음 |
| 순서·중복 | 원소 역순·중복 token 및 객체 key 재배열 | 입력 순서대로 push하며 token 중복을 병합/삭제하지 않음. key 순서는 ABI tuple components 순서와 구분 |
| 주소 역할 | Permit2 verifying contract, underlying token별 chain/address, spender, submitter | message에 owner를 추가하지 않고 네 역할을 구분 |
| 수량·expiration·nonce | `0`, 일반 값, `2^160−1`/`2^48−1`, 범위 초과 `2^160`/`2^48`, 서로 다른 nonce와 word/bit 경계 | 정상 입력 변환과 선언 폭 미검사 진단 분리. decimal string·BigInt 독립 검산 |
| 필수 필드·형식 | 첫째·둘째 각각 token/amount/expiration/nonce 누락·null·잘못된 형식 | 다른 emit 오류의 전체 실패와 nonce zero fallback을 구분. 정상 자식을 임의로 남기지 않음 |
| details·원소 구조 | empty·누락/null/비배열, 잘못된 원소 타입 | empty Unknown과 array/child 오류를 구분. 정상 입력은 named EIP-712 object로 전달 |
| 한도 | 64개와 65개 | 64개는 외부 Action 하나 아래 64 child 요구. 65개는 명시적 전체 오류이며 조용한 자르기 없음 |
| 시간·LiveField | 정상 sigDeadline의 모든 child/외부 meta 일치, 큰 값의 별도 진단, 원소별 signed nonce/tuple/source/ttl/synced_at | source 표시와 실제 조회를 구분하고 unsafe JS 결과를 정확한 원문으로 취급하지 않음 |
| lookup·v4 | 미등록 chain/contract/primary type와 매칭 후 malformed 구분, installed Batch v4 unsupported guard | full types 검증을 수행했다고 하지 않으며 v4 실패 후 v3 retry 없음 |

### Batch 오류·한도와 관찰의 정적 근거

관련 경로는 [`declarative_exports.rs`](../../crates/policy-engine-wasm/src/declarative_exports.rs)의 typed reshape/array emit 분기와 [`action_builder.rs`](../../crates/adapters/mappers/src/declarative/action_builder.rs)의 `build_array_emit`·live nonce wrapping이다. 원소 수 검사 → 순서대로 child 생성 순서를 유지하고 실패 시 `data: null`인 오류 envelope를 반환하는 경로를 작성한 시험으로 확인한다. 아래 오류 검사는 저장된 사용자 실행에서 통과했다. raw 정수 정밀도·내부 포화 설명은 해당 정적 분석 근거와 구분한다.

| 최소 입력·조건 | 현재 예상 결과 | 계약·기대값 판단 |
| --- | --- | --- |
| 정상 message에서 `details: []` | Batch decoder ID·외부 Action 1개, body `{domain:"unknown", target:Permit2, chain:"eip155:1", calldata:"", value:"0x0"}`, 정상 외부 meta | 빈 배열을 정상 Multicall 완료나 정책 allow로 표현하지 않음 |
| details 누락/null/비배열 | `build_array_emit_failed`, `data: null`, message `array_emit array_source did not resolve to an array: $args.permitBatch[0]` | malformed와 empty의 의미 구분 |
| 정상 details 65개 | `build_array_emit_failed`, `data: null`, message `array_emit array_source $args.permitBatch[0] has 65 element(s), exceeding max_elements=64` | 64개 결과 보존이나 65번째 생략을 새로 도입하지 않음. 현행 오류 관찰이므로 새 한도 계약 결정은 불필요 |
| 첫째/둘째 token·amount·expiration 누락/null/불량 | `build_array_emit_failed`, message `serde from_value:` 시작, `data: null` | 앞서 생성할 수 있는 정상 child도 최종 부분 성공으로 반환하지 않음 |
| child 자체가 null/string/bool/number | `build_array_emit_failed`, `invalid arg path`/`indexed access on non-array` 계열 메시지, `data: null` | 현재 없는 element index/path 오류 필드를 임의로 추가하지 않음 |
| 첫째/둘째 nonce 누락/null/파싱 실패 | 해당 child의 tuple `["0x0",0]`으로 성공 가능, 다른 child 값·순서 유지 | **legacy diagnostic**이며 유효한 PermitBatch 입력으로 승인하지 않음 |
| 정상 Batch에 primary type만 `PermitSingle`로 변경 | Single이 설치돼 있으면 Single lookup 이후 입력 해석 오류 | 미등록 primary type 사례와 구분. lookup miss에는 별도의 미등록 이름 사용 |
| 설치된 Batch를 full-input v4로 요청 | `unsupported_typed_data_contract`, `data: null`, `installed typed-data contract is outside strict Permit support; detailed validation not performed` | types 상세 검증·암호 검증 전에 미지원. Batch 미설치는 `no_typed_data_mapper` |

각 nonce LiveField는 **signed nonce를 분해한** 현재 word/bit tuple과 `onchain_view`·해당 chain·Permit2 contract·`nonceBitmap(address,uint256)`·`permit2_nonce_bitmap`, `ttl:12`, `synced_at: submitted_at`으로 구성된다. 실제 체인 조회나 신선한 Fact가 아니다. AllowanceTransfer 순차 uint48 nonce와 SignatureTransfer bitmap 의미 차이는 A안의 별도 교정 대상으로 유지한다.

현재 v3는 `uint160/uint48` 폭을 검사하지 않아 초과값을 출력 타입 범위에서 수용할 수 있고 nonce `2^48`은 `["0x10000000000",0]`으로 표현된다. 큰 공통 sigDeadline은 모든 child에 적용되므로 JS 안전 정수 초과와 body u64 포화/외부 meta 0 문제도 전파될 수 있다. worker JSON.parse 이후의 값으로 raw 정수 정밀도를 복원했다고 주장하지 않는다. nonce·폭·시간·v4의 교정 설계와 B/C 제안은 [상세 계획](../../docs/sdk-migration/decoder-design-plan.md#dec-05-계약-교정안-a안-확정bc-미구현-제안)에 보존하며 이번에 다시 승인 질문하거나 런타임을 변경하지 않는다.

Batch **108/108·통합 466/466**의 실행 근거와 hash는 [README](README.md#dec-05b-사용자-실행-기록--저장-로그-확인)에 기록했다. 검증된 JS/WASM 쌍을 재사용했으며 DEC-05 완료 기록을 위해 재시험·재빌드를 요구하지 않는다. **DEC-05 A안 범위는 검증 완료**, nonce·범위/형식·시간·v4 교정 및 외부 nonce 조회·서명 검증·정책·Core·SDK 소스 이관은 기존 후속 범위다. D2 전체는 아직 미완료다.

## DEC-06a — self-multicall 연결과 현재 한계

**사용자 재실행 검증 완료:** `/private/tmp/dambi-dec06a-verify.AsBmk6/`에서 self **48/48 통과**(`duration_ms=860.220167`), 기존 466개를 포함한 통합 **514/514 통과**(`duration_ms=1337.026125`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. self는 UTC `2026-09-12T07:53:21Z–07:53:22Z`, 통합은 `07:53:22Z–07:53:24Z`이며 command/tee/hash/inventory/Git/final exit 모두 0이다. 실행 전후 HEAD는 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`, branch는 `feat/decoder`이고 **06a 관련 9개 미커밋 경로를 포함한 작업 트리**에서 실행했다. 이번 완료 기록 편집 전에 입력 **1356개 모두 현재 파일과 일치**, JS/WASM 2개 hash도 일치함을 확인했다. 입력·산출물·HEAD/branch/status·tracked/staged patch는 실행 전후 및 편집 전 작업 트리와 동일하다. 최초 실패 `kJih6u`는 아래 과거 기록으로 보존하며 성공 결과로 덮어쓰지 않는다. 에이전트가 빌드·시험을 재실행한 결과가 아니다.

**커밋 경계 확인 완료:** 사용자 커밋은 `1326fb5` → DEC-05 기록 `56ece474961ca72cea014b17e0060ad180a4b53a` → DEC-06a 구현·검증 기록 `99234877c8b72e1ea96cd8597e45e9c0e716d66d` 순서다. 첫 커밋은 네 문서만, 두 번째는 06a 관련 정확한 아홉 경로만 포함한다. DEC-05 기록 전용 patch를 `1326fb5` 원문에 메모리에서 적용한 네 결과가 `56ece47` Git blob과 바이트 동일함을 읽기 전용으로 확인했다. 성공 로그 `AsBmk6`의 **06a 구현 다섯 파일**(fixture·test·selection·helper·package)의 SHA-256도 `9923487` blob과 모두 일치한다. **06a 실제 실행 HEAD는 `1326fb5`의 미커밋 작업 트리이며 이후 구현 커밋은 `9923487`**이다. 06b 착수 전에 `feat/decoder`, HEAD `9923487`, 깨끗한 작업 트리·빈 index를 확인했으므로 커밋 선행 조건을 충족했다. 과거 DEC-05/06a 커밋 절차는 이미 완료해 다시 실행하지 않는다. 기록 확인을 위한 재빌드·재시험은 필요 없다.

**첫 사용자 실행 실패와 수정:** `/private/tmp/dambi-dec06a-verify.kJih6u/`의 self 결과는 **tests 48 / pass 0 / fail 48**, suites/cancelled/skipped/todo 모두 0, `duration_ms=659.926875`다. 모든 index를 `3-ref`로 가정한 공통 before hook(당시 `multicall-self.test.mjs:93`)에서 NFPM inline의 실제 `schema_version=undefined`와 기대 `"3-ref"`가 불일치했다. 최초 정적 검토에서 놓친 시험의 형식 가정이며 48개의 개별 ABI/Action 실패로 해석하지 않는다. 임시 Registry 빌드 후 index 검사에서 중단되어 실제 WASM 설치·route 요청은 시작하지 않았고, self exit 1로 통합도 미실행(`integrated.log` 없음)이다. 실행 전후 HEAD는 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`, branch는 `feat/decoder`, 관련 9개 미커밋 경로가 있었고 입력 1356개·JS/WASM·tracked/staged patch·HEAD/status가 전후 동일하다. 사후 입력 1356개 모두 OK이며 final/command exit=1, hash/inventory/Git record exit=0이다. 전체 UTC `2026-09-12T07:45:32Z–07:45:34Z`, self `07:45:33Z–07:45:34Z`다. Rust/빌드 입력 1279개는 검증된 `e487805`와 같고 현재 JS/WASM hash도 기록과 일치한다. 상세 도구·수정 전 파일 대응은 [README](README.md#dec-06a-첫-사용자-실행--공통-준비-훅-실패와-수정)에 보존한다.

**수정한 index 계약:** approve sourced callkey **4개는 `3-ref`**, NFPM concrete callkey **12개는 `schema_version`·`bundle_ref` 없이 `bundle`을 직접 담은 inline**이다. 별도 `bundles/` 파일은 approve **1개**이며 서로 다른 해석 bundle 객체·JCS digest **4개**와 구분한다. 실제 builder의 두 경로에 맞춰 exact key·형식·참조/원본·JCS 검사를 수정했다. 기대 Action·fixture·43요청+5구조=48개 및 통합514개 정의는 유지한다. **사용자 재실행 검증 완료**이며 기존 실패 기록과 DEC-05 기록 전용 patch를 보존한다. 같은 JS/WASM 쌍으로 self 48/48·통합 514/514가 통과했다. 완료 기록 갱신을 위한 재실행은 필요 없으며 실제 06a 커밋 `9923487`을 확인해 06b를 별도 변경으로 진행한다.

**사용자 재실행 검증 완료.** [`multicall-self.cases.json`](multicall-self.cases.json)의 요청 43개와 [`multicall-self.test.mjs`](multicall-self.test.mjs)의 구조 검사 5개, 합계 **48/48 통과**다. 기존 일곱 파일의 466개를 포함한 통합 **514/514 통과**도 확인했다. Rust·worker·기존 466개 기대값은 보존했다.

| 실제 원본 (`registryV2/` 기준) | selector | 원본 바이트 SHA-256 |
| --- | --- | --- |
| `manifests/uniswap/v3-nfpm/multicall@1.0.0.json` | `0xac9650d8` | `0xe19586381d2c72dbeda01b9ca30fc3af19296334c797bd75d18b012a226a6430` |
| `manifests/uniswap/v3-nfpm/mint@1.0.0.json` | `0x88316456` | `0xc19f0c9b64a296f0893b4594d71502c881074206c34329dbf9a3f38500b1b93c` |
| `manifests/uniswap/v3-nfpm/refundETH@1.0.0.json` | `0x12210e8a` | `0x2684b33185f8b5128582b1afca36fa5b7ff9ea8cdc691e6bc3879cdc12375f78` |

`includeNfpmSelf: true`는 기존 approve와 NFPM 세 원본을 선택한다. 원본 hash 검증 → 임시 `--strict-callkeys` Registry → inline/ref 해소·JCS digest → 실제 `declarative_install_v3_json` → worker의 기존 transaction branch를 연결했다. callkey는 **16개**(네 decoder × 네 체인), typed·selector index는 각각 **0개**다. sourced approve 4개는 `3-ref`, concrete NFPM 12개는 inline이며 별도 bundle 파일은 approve 1개다. 세 체인 `1/10/42161`의 공통 NFPM은 `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, Base `8453`은 `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`다. 원본 concrete 주소·대소문자를 유지하고 USDC token 목록으로 NFPM을 확장하지 않는다. helper 기본값·기존 반환 구조·원본 복사·실패 시 정리를 유지하며 명시 선택에만 `nfpmMulticallSource`, `nfpmMintSource`, `nfpmRefundEthSource`를 반환한다.

| bundle ID | 독립적으로 고정한 resolved JCS digest — 사용자 재실행에서 일치 확인 |
| --- | --- |
| `standard/erc20/approve@1.0.0` | `0x8de0f8e4eb676c1c1b45dc9ce1cddb0f59afd65fff573efe28c9d6dda4ac6167` |
| `uniswap/v3-nfpm/multicall@1.0.0` | `0xecbf4a7182dd70c319e7fc3dc14c6a1e1b9ce8194d07003a928c060d9e7038aa` |
| `uniswap/v3-nfpm/mint@1.0.0` | `0x050b2d17d2ace5d4c764cc8e58cdbb37e12623a63dc74c78b61ee0dad2bd5180` |
| `uniswap/v3-nfpm/refundETH@1.0.0` | `0xcf326802ca795bc517d46dfe993160da77cd48cdb30e4d337893d9bfe0a1e4c3` |

위 digest는 원본 객체와 approve의 기존 concrete 주소 확장 규칙을 정적 대조하여 고정한 기대값이다. 기대값을 builder나 WASM 결과에서 자동 생성하지 않았으며, 이번 사용자 재실행에서 실제 resolved bundle의 JCS 계산과 네 고정 digest의 일치 검사가 통과했다.

| 작성한 요청·구조 검사 | 기대 출력·구분 |
| --- | --- |
| mint/refundETH 단독, self의 mint-only/refund-only·mint+refund | 전체 Action/meta, decoder ID·token pair·desired/min 수량·signed tick·recipient |
| 순서 반전·반복, 깊이 2/3/4·서로 다른 중첩 가지 | 입력 순서와 반복을 보존하고 중첩 Multicall ActionBody 트리를 유지. 깊이 4 실패를 기대하지 않음 |
| 네 체인 refund, Base/다른 NFPM 주소 교차·USDC target | concrete callkey 범위만 일치. 잘못된 체인/주소 조합은 `no_declarative_v3_mapper` |
| 정상+미등록 selector, 역순, 전부 미등록, NFPM 안 ERC-20 approve | 미지원 child의 target=부모 NFPM·calldata·value=`0x0`인 Unknown 보존. 정상 approve로 바꾸거나 조용히 skip하지 않음 |
| 필요한 하위 bundle 전체/일부/미설치, 부모 미설치 | 이미 설치한 실제 원본만 해석. 미설치 mint/refund child는 Unknown, 부모 미설치는 최상위 lookup miss. 설치 조합마다 기존 worker의 별도 프로세스 |
| 같은 프로세스 정상·malformed·미지원·한도 오류 교대 | 오류 뒤 정상 전체 Action/meta와 반복 요청 결과가 섞이지 않는지 검사 |
| 빈 self 배열, 길이 0/1/3바이트 child | `build_multicall_failed`. 빈 배열·짧은 자식을 정상 완료나 단순 미지원 Unknown으로 바꾸지 않음 |
| mint selector-only·tuple 절단, malformed 첫째/마지막/중첩 child | 직접 mint는 `decode_failed`; self에서는 child index/selector가 포함된 `build_multicall_failed` 전체 오류. 정상 형제만 부분 성공으로 내보내지 않음 |
| 외부 bytes[] selector-only·offset/count/child offset/length 범위 밖·data 절단 | outer decode의 `decode_failed`. count 변형은 단일 child 배열의 count를 남은 3 words보다 큰 4로 고정. 잘못된 ABI와 정상 selector 미등록을 구분 |
| 정상 child 64개·65개 | 64개 전체 body 보존을 요구. 65개는 현행 `multicall child count 65 exceeds cap 64` 전체 오류 |
| 정상 mint/refund/outer/child 뒤 추가 바이트·word | 합의한 정상 ABI 뒤 추가 바이트 허용 유지 |

구조 검사 5개는 **정확한 index/JCS**, **mint ABI tuple 독립 검산**, **bytes[]/중첩·malformed 변형 검산**, **bundle 설치 조합**, **같은 프로세스 교대 요청**이다. `test()` 5회와 fixture 43개에 각각 한 번 등록하는 루프를 읽어 48개를 계산했다. 구조 검사 안의 추가 route 요청을 별도 통과 수로 더하지 않는다. 43개 fixture는 성공 envelope 기대 24개·오류 envelope 기대 19개다.

고정 mint ABI의 순서는 token0/token1/fee/tickLower/tickUpper/amount0Desired/amount1Desired/amount0Min/amount1Min/recipient/deadline이다. fee는 `3000`, signed tick은 `−887220/+887220`, desired는 `1000000/500`, min은 `900000/450`, deadline은 `1738002000`으로 독립 검산한다. bytes[]의 top offset `0x20`, 배열 원소 offset은 배열 count 다음 head를 기준으로 하며, mint+refund의 원소 offset `0x40/0x1e0`, length `356/4`와 zero padding을 검사한다. 기대 Action은 실제 WASM 출력에서 자동 저장하지 않는다.

**DEC-06a 최초 정적 검토 기록(첫 실행에서 index 형식 가정 누락 확인):** 새 test/helper의 `node --check`, JSON 파싱·43개 case ID 유일성·안전 정수 literal, 고정 원본/token 12개의 hash와 실제 NFPM ABI/emit·Rust Action 직렬화를 대조했다. 기존 일곱 test와 원본 case fixture·worker는 `1326fb5`와 바이트 동일하다. mint signed tick/수량과 bytes[] offset/length/padding·명확한 malformed count=4를 독립 검산했고 `git diff --check`에 문제가 없다. README의 새 Bash 블록은 `bash -n`, 내장 Python은 AST 파싱으로 구문만 검사했다. Registry·Native/WASM·Node 시험을 실행하거나 통과했다고 표시하지 않는다.

**출력 정보와 한계:** mint는 `amm/add_liquidity`·`params.kind=concentrated_mint`이며 `fee_tier_bp: 3000`은 현재 원본 fee를 그대로 담는다. 이름만 보고 basis point 단위로 변환하지 않는다. pool 주소는 로컬 CREATE2 계산값이며 존재·유동성 조회·mint 실행 성공의 증거가 아니다. `live_inputs.pool_state.value`의 `xy_constant`·zero reserve와 `current_price.value: "0"`은 현재 placeholder다. `onchain_view` source·ttl·synced_at을 붙였어도 RPC 조회가 수행된 값이 아니다. ABI의 deadline은 현재 Action에 투영되지 않는다. refundETH는 `token/refund_native`이며 recipient=submitter이고 calldata에 금액이 없어 amount 필드를 만들지 않는다. 부모 value를 환급 금액으로 복사하지 않는다.

최상위 Action의 meta 하나 아래에 자식 ActionBody가 들어간다. 내부 meta/decoder ID 전체 보존이나 완전한 원문 투영을 주장하지 않는다. self 자식 route는 value `"0"`을 받으며 실제 EVM `msg.value` 의미를 검증한 것으로 확대하지 않는다. 현재 Unknown·route DTO에 reason/path/complete/partial은 없으며 06a 기대값에 새 필드를 추가하지 않는다.

**깊이·후속 범위:** 실제 self manifest의 `max_depth: 3`을 `build_multicall_recurse_body`는 읽지 않는다. 자식마다 public route로 재진입하며 현재 직접 적용되는 제한은 단계별 자식 64개다. 작은 깊이 2/3/4의 현행 동작을 관찰하며 한도 구현 완료로 표시하지 않는다. TS의 self 사전 설치는 직계 selector만 검색하고 별도 `MAX_REENTER_DEPTH = 4`는 Call[]의 `installCallTree`에 적용된다. bundle을 모두 준비한 Node 시험은 호스트의 동적 발견·설치를 검증하지 않는다.

**06a 당시 후속 계획:** 06b Call[]는 **구현·정적 검토 완료, 사용자 실행 대기**다. 실제 Morpho Bundler3 원본의 to/data/value·approve/transfer·순서/미지원/malformed/empty/64·65를 별도 49개 정의로 작성했다. [06b 상세 기록](#dec-06b--call-연결과-현재-한계)을 따른다.

**06a 당시 후속 계획:** 06c는 **미구현·06b 사용자 검증 후 진행**한다. self·Call[] 재진입·callback 재귀 문맥과 제한 전달, callback 한도에서 내용을 생략하는 분기를 보완한다. **해석한 호출과 순서를 보존하고 남은 구간을 Unknown 및 한도 사유로 남긴다**는 사용자 결정은 확정돼 있다. 새 제한값·wire/진단 코드·호출 경로·decoder ID·complete/partial 및 기존 소비자 호환만 구체 입력/현재 결과/영향 파일/권장안과 함께 결정한다. 읽지 않은 내부 내용을 추측하지 않고 Permit2 Batch에 새 multicall 정책을 자동 적용하지 않는다. 06c까지 구현·사용자 검증을 마쳐야 DEC-06 전체 완료다.

## DEC-06b — Call[] 연결과 현재 한계

**06b 구현 당시 기록: 구현·정적 검토 완료, 사용자 실행 대기.** [`multicall-call-array.cases.json`](multicall-call-array.cases.json)의 요청 **43개**(성공 envelope 기대 25·오류 기대 18)와 [`multicall-call-array.test.mjs`](multicall-call-array.test.mjs)의 구조 **6개**로 **49개 정의**, 기존 514개 포함 통합 **563개 정의**다. 사용자 실행 전이므로 통과 수가 아니다. 06a 실제 구현 커밋 `9923487`과 성공 로그 입력을 먼저 확인했으며, 기존 여덟 test·일곱 case fixture·worker를 보존했다. 실제 빌드·시험은 [README 명령](README.md#dec-06b-사용자가-직접-실행할-검증-명령)으로 사용자가 수행한다.

| 실제 원본 | 고정 입력 |
| --- | --- |
| `registryV2/manifests/morpho/bundler3/1-multicall@1.0.0.json` | `id=morpho/bundler3/1-multicall@1.0.0`, selector `0x374f435d`, chain 1의 `0x6566194141eefa99af43bb5aa71460ca2dc90245` |
| 원본 바이트 SHA-256 | `0xd909edf6d2f1cf5eeb375042b5f61979b3cd1a1e0505a4fee9352b87d78b2a63` |
| ABI | `multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle)` |
| emit | `strategy=multicall_call_array`, `recurse_arg=bundle`, `max_depth=4` |
| 자식 실제 원본 | 기존 `standard/erc20/approve@1.0.0`·`transfer@1.0.0`. 소스·token fixture·기존 기대값 유지 |

`buildRegistry(selection, { includeTransfer: true, includeBundler3: true })`로 **approve + transfer + Bundler3**를 선택한다. 원본 hash 확인 → 임시 strict Registry → exact index 형식/key·inline/ref 해소·JCS 확인 → 실제 WASM 설치 → 기존 worker transaction route로 연결한다. 부모는 concrete chain 1 주소 하나이며 token 목록으로 확장하지 않는다. approve/transfer의 기존 token source 네 체인 확장은 보존한다. helper의 새 옵션은 기본 false, 명시 선택에만 `bundler3Source`를 반환하며 기존 반환·hash 검사·임시 정리를 유지한다.

| 산출물 기대값 | 정확한 구분 |
| --- | --- |
| callkey 9개 | approve `3-ref` 4 + transfer `3-ref` 4 + Bundler3 inline 1 |
| typed/selector/context | 각각 0개. concrete inline에 `schema_version`·`bundle_ref`를 요구하지 않음 |
| 서로 다른 bundle/JCS | 3개. `bundles/`의 별도 파일은 sourced approve/transfer **2개**뿐 |
| approve JCS | `0x8de0f8e4eb676c1c1b45dc9ce1cddb0f59afd65fff573efe28c9d6dda4ac6167` |
| transfer JCS | `0xa3441e0599fbc45dd73b0887bebe4f105f70bcf7c28fb4cd5a543cce9c0a5726` |
| Bundler3 JCS | `0xdcc2e2c6ba71e4edaaf61d26e7ef519f07bfcbd414b8ae367a71daaad4957e5b` |

위 JCS는 실제 원본·기존 주소 확장 규칙을 근거로 고정한 기대값이며 새 builder 실행에서 얻은 성공 산출물로 기록하지 않는다. 기대 Action 역시 WASM 출력에서 자동 생성하지 않는다.

| 요청·구조 범위 | 기대 출력과 의미 |
| --- | --- |
| approve-only·transfer-only·조합·역순·반복 | 부모와 다른 자식별 `to`의 실제 ERC-20 decoder를 사용하고 token·spender/recipient·수량·순서·중복 및 최상위 전체 Action/meta 대조 |
| 서로 다른 tuple 값 | `(to,data,value,skipRevert,callbackHash)` 각 인덱스의 의미를 분리. 부모 value `999`, 자식 `17/19`·`2^255+7`·`2^256−1`을 혼동하지 않음 |
| skipRevert/callbackHash 변형 | true·nonzero flag가 입력에 존재하고 정상 출력은 그대로임을 확인. 실제 EVM 실행·revert skip·callback 인증/실행을 검증했다고 하지 않음 |
| 알려진+미등록 target/selector, 역순·전부 미등록 | target·원문 data·원소별 value의 Unknown을 순서대로 보존. 오래된 “skip” note/doc comment를 기대값으로 사용하지 않음 |
| 0/1/2/3바이트 child, known-short-known | Call[] 경로는 Unknown 보존. self 경로의 짧은 child 전체 오류와 계약을 통일하지 않음 |
| empty·64개·65개 | empty와 65개는 `build_multicall_failed`; 64개는 전부 보존 요구. 현행 cap은 **입력 Call 개수**이며 전개 후 총 Action 수 cap이 아님. 65개 partial/한도 진단은 06c에서 별도 변경 |
| 첫 approve/마지막 transfer의 등록된 malformed, skipRevert false/true | `build_multicall_failed`·`leg #`·`decode_failed` 전파를 대조. true여도 decoder 오류를 숨기지 않음 |
| 외부 Call[] selector-only·head/offset table/tuple head 절단·array offset/count·tuple data offset/length·실제 data 절단 | `decode_failed`. 10개 malformed outer 변형은 작은 범위 밖 offset/length로 검산하며 큰 부하를 만들지 않음 |
| 정상 ABI 뒤 추가 바이트 | outer byte/word 및 approve byte/transfer word의 기존 허용 유지 |
| 부모 chain/address miss | 최상위 `no_declarative_v3_mapper`. 알려진 자식 selector의 ABI 오류와 구분 |
| 여섯 설치 상태 | all·parent-only·children-only·without-transfer·without-approve·empty-registry를 각각 별도 프로세스로 실행하도록 작성. 직접 자식 요청과 부모 요청의 성공/Unknown/miss 구분 |
| 같은 프로세스 교대 | 정상 → malformed → 동일 정상 → unsupported → 동일 정상 → 65개 오류 → 동일 정상. 상태가 섞이지 않는지 전체 Action/meta 비교 |

구조 검사 **6개**는 exact Registry/JCS, approve/transfer 고정 ABI·수량, Call[] tuple offset/length/padding·변형, value/flags/Unknown, 설치 조합, 같은 프로세스 교대다. 구조 검사 안의 direct/subset/교대 요청을 별도 시험 수로 더하지 않는다. 고정 child 수량은 approve `1234567`, transfer `2^200+12345`이며 spender와 recipient 역할을 구분한다. Call[] offset은 배열 count 뒤의 element head 기준이고 각 tuple의 `data` offset은 해당 tuple 시작 기준이다. 기본 두 호출의 element offset은 `0x40/0x160`, tuple data offset은 `0xa0`, child data length는 각각 `0x44`다. padding과 trailing byte 허용은 별도 검사한다.

**DEC-06b 정적 검토 기록:** 새 test/helper의 `node --check`, JSON 파싱·43개 case ID 유일성·안전 정수 literal을 확인했다. 원본 세 파일의 SHA-256/JCS 기대값, 기존 selection 항목과 baseline 16파일 보존, 고정 ABI literal·offset/length/padding·외부 malformed 10개·flag 변형의 출력 관계를 독립 대조했다. Rust·schema·Cargo·빌드 입력 1279개와 검증된 JS/WASM 쌍은 그대로다. README의 새 Bash 블록/독립 script는 `bash -n`, 내장 Python은 AST 파싱으로 구문만 확인했다. `git diff --check`에 문제가 없으며 빌드·시험은 실행하지 않았다.

**정적 근거와 기존 시험 대응:** 실제 [`build-index.ts`](../../registryV2/scripts/build-index.ts)의 sourced/ref·concrete/inline 분기, [`decode.rs`](../../crates/adapters/abi-resolver/src/decode.rs), [`action_builder.rs`](../../crates/adapters/mappers/src/declarative/action_builder.rs), [`declarative_exports.rs`](../../crates/policy-engine-wasm/src/declarative_exports.rs)의 `build_multicall_call_array_body`/`process_call_legs`, 실제 DTO/Action 직렬화를 대조했다. 기존 Rust의 Call[] 관련 시험에는 synthetic `foo` child와 이미 해석된 positional JSON 입력이 포함되며 실제 부모 source → Registry → outer ABI → WASM 연결의 대체 증거가 아니다. TS `declarative-route.test.ts`의 자식별 target/사전 설치 및 callback 사례는 mock installer/WASM 시험이다. 새 Node 시험은 필요한 실제 bundle을 미리 설치하므로 호스트의 동적 발견·설치까지 검증한 것으로 표시하지 않는다.

**출력 정보의 한계:** 최상위 Multicall Action/meta 하나 아래에 자식 ActionBody만 들어간다. known ERC-20 body에는 `Call.value`·skipRevert·callbackHash·내부 meta/decoder ID를 새 필드로 추가하지 않는다. Unknown에는 원소별 target/data/value가 남으며 calldata가 짧아도 금액을 삭제하지 않는다. 정적 코드 대조로 tuple `[2]`의 `Call.value`가 자식 route에 전달됨을 확인했고 출력에서 직접 값 보존을 검사하는 대상은 Unknown이다. 현재 approve/transfer는 native value를 소비하지 않으므로 이 시험으로 모든 known value 소비 경로를 보증하지 않는다. 이 보존은 실제 value 전송이나 계약 실행 성공의 증거가 아니다. skipRevert/callbackHash는 ABI 입력으로 파싱되지만 현재 `process_call_legs`가 읽어 검증하거나 오류 동작에 적용하지 않는다. callbackHash가 nonzero라는 사실만으로 callback 내용을 얻거나 인증한 것으로 설명하지 않는다.

**06b 당시의 06c 후속 범위:** manifest `max_depth: 4`는 `reenter(Call[])` callback 재귀에만 전달된다. 이 06b는 callback 재귀를 시험하지 않고 public route 재진입의 전역 깊이 제한·TS 사전 설치 한도·완전한 정보 보존이 구현됐다고 주장하지 않는다. 다음 단계는 요청별 재귀 문맥·서로 다른 경로의 한도 우회·callback 한도에서 내용 생략을 보완하고 **해석한 호출과 순서 보존 + 남은 구간 Unknown/한도 사유**라는 기존 사용자 결정을 구현하는 것이다. 새로운 제한값·정확한 wire/complete/partial·안정 진단 코드·경로/decoder ID·기존 소비자 호환은 구체 사례와 영향 파일을 근거로 확정한다. 현재 없는 진단을 06b 정상 기대값에 넣지 않고 읽지 않은 내부 내용을 추측하지 않으며 Permit2 Batch에 새 multicall 정책을 자동 적용하지 않는다. **06c까지 구현·사용자 검증을 마쳐야 DEC-06 전체 완료**다.

## DEC-06c — 달라진 지원 범위와 제한

**사용자 검증 완료. DEC-06 전체 완료.** 실제 Registry/WASM 연결, 재귀·한도 경계와 교대 요청, TS route→audit의 진단 전달 및 구형 응답의 필드 부재 보존을 사용자 실행으로 확인했다. 실행 수치·로그는 [README 검증 기록](README.md#dec-06c--사용자-검증-완료-dec-06-완료)을 따른다. 아래 지원 범위·한계는 유지하며 DEC-07은 미착수다.

- self 깊이 3과 Call[] 깊이 4를 요청 전체의 깊이 4·256개 노드 상한 아래에서 실제 적용한다. self/Call[]/callback 전환이 예산을 초기화하지 않는다. 각 배열 65번째부터는 오류 대신 원문 Unknown+`child_limit`로 보존하고 앞 64개 결과를 유지한다.
- 성공한 multicall/callback transaction에만 `decoding`의 complete/partial과 원본 경로·사유·decoder ID를 제공한다. 미등록·짧은 Call[] child·알려진 decoder의 Unknown도 partial이다. self의 짧은 child와 읽은 malformed ABI/emit/필수 해석 오류는 계속 전체 오류다.
- 실제 GA1 FlashLoan(reenter_only)·SupplyCollateral manifest의 outer ABI→route→callback 전개를 추가한다. 직접 callback route와 nested callback 모두 처리하며, 한도에서 callback 원문과 제공 호출의 target/value 문맥을 보존한다. raw callback 자체의 target/value를 추측하지 않는다.
- 기존 self `nested-depth-4`의 깊이 4 자식과 self/Call[] `children-65` 기대값이 승인 계약에 따라 바뀐다. 정상 multicall에도 complete 진단 객체를 검사하고 Unknown 진단은 설치 조합에 맞춰 검사한다. typed·Permit2 Batch 및 단순 transaction의 기존 응답은 유지한다.
- 256은 루트·callback 구간을 포함한 해석 노드 예산이다. ABI 전체 decode 메모리나 미해석 tail 출력 크기를 제한하지 않으며 기존 JSON 입력 4 MiB 경계는 그대로다. TS의 동적 bundle 발견/사전 설치 한도는 이 WASM 시험 범위 밖이다.
