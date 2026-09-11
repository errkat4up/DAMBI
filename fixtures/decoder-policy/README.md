# DEC-01/02: 실제 ERC-20 approve 디코딩·정책 연결 기준 시험

이 디렉터리는 SDK 이관 전의 **DEC-01/02 기준 시험(baseline)** 이다. 실제 Registry source를 실제 builder로 확장하고 기존 WASM에 설치한 뒤, 고정된 원문 approve calldata를 Action까지 해석한다. DEC-02는 이 디코딩 결과를 기존 planner/evaluator에 전달해 실제 Cedar 정책 하나를 평가한다. **DEC-02 상태: 코드 작성 완료·실행 검증 대기.** DEC-03은 미착수다.

DEC-01 구현 및 연결 시험은 **사용자 실행 보고 기준으로 30개 통과**했다. 실패·취소·건너뛰기는 모두 0개다. 최초 시험에 이어 현재 Rust 소스에서 직접 WASM을 빌드한 뒤 실행한 시험도 같은 결과로 통과했다. 실제 Registry builder → resolved bundle digest 확인 → 실제 WASM 설치·approve 디코딩 경로가 시험되었다. 두 결과 모두 사용자가 제공한 출력이며, 문서를 정리한 에이전트가 실행한 결과가 아니다.

**DEC-01 당시 Rust 소스 → 직접 빌드한 WASM → 해당 산출물의 연결 시험 통과를 사용자 보고 기준으로 확인했다.** 근거는 안내한 절차의 실행 완료 보고, 전후 HEAD·Git 변경 목록, 도구 버전 조회, 빌드 성공 표식·시각, WASM SHA-256, 뒤이어 실행한 테스트 출력과 시각이다. 상세 빌드 로그·전체 빌드 명령 출력·실제 임시 target 경로·빌드 시작 시각은 미제공으로 기록 보완을 기다린다. 에이전트가 별도로 재빌드하여 소스와 산출물의 일치를 독립 재현한 것은 아니다. DEC-02 실행 검증과 SDK 전체 소스·빌드 독립화는 완료되지 않았다. 이번 작업에서는 빌드·테스트·설치·Git add/commit/push/merge/reset·브랜치 변경을 실행하지 않는다. 이 사용자 제한은 계획서의 자동 검증·커밋 지침보다 우선한다.

## 검증 기록

DEC-01 문서 정리 시점에 Git을 읽어 확인한 브랜치는 `feat/decoder`, HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`였다. 당시 Git 상태상 `crates/`의 Rust 소스, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`, `schema/`, `scripts/wasm-build.sh`, `.github/workflows/ci.yml`에 미커밋 변경은 없었다. 전체 작업 트리는 `package.json` 수정과 DEC-01 fixture·두 계획서의 미추적 파일 때문에 변경된 상태였고 스테이징된 변경은 없었다. 이는 **당시 소스 상태의 확인**이며, 빌드 출처가 없던 최초 시험의 WASM 상태를 소급해 증명하지 않는다. 재빌드 후 검증은 아래 별도 사용자 기록을 따른다.

2026-09-11 DEC-02 착수 시 직접 읽은 Git 상태는 `feat/decoder`, HEAD `3066f0c` (`test(decoder): verify real approve decoding baseline`), 작업 트리 깨끗함, `origin/feat/decoder`보다 1커밋 앞섬이다. DEC-01 커밋의 존재는 WASM과 소스의 일치 검증을 추가로 증명하지 않는다. 기존 사용자 실행 기록의 HEAD와 미확인 항목을 현재 HEAD로 덮어쓰지 않는다.

아래 두 실행 기록은 별개로 유지한다. 확인 대기 칸은 실제 결과가 제공된 뒤 채우며, 저장소에 선언된 권장 버전이나 예상 통과 수를 실행 결과로 복사하지 않는다.

| 기록 항목 | 기존 사용자 실행 보고 | 현재 Rust 소스 재빌드 후 검증 |
| --- | --- | --- |
| 실행자·근거 | 사용자 제공 터미널 출력 | 사용자 제공 도구 조회·절차 전후 Git 출력·빌드 성공 표식·`shasum` 출력·재빌드 후 전체 테스트 출력. 상세 빌드 로그는 확인 대기 |
| 빌드 대상 브랜치·소스 HEAD | 확인 대기 | 준비 시 브랜치 `feat/decoder`; 절차 전후 HEAD `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615` 동일. 안내한 현재 소스 재빌드 절차의 사용자 실행 보고 기준 |
| 빌드 전후 미커밋 변경 목록·diff | 확인 대기 | 전후 Git 변경 목록 동일: `package.json` 수정, 두 계획서와 DEC-01 fixture 6개 미추적. Rust 소스·빌드 설정 변경은 목록에 없음. 파일 내용의 전후 diff는 확인 대기 |
| 실제 Rust toolchain·rustc·Cargo 버전 | 확인 대기 | 사용자 조회: `1.95.0-aarch64-apple-darwin` (`RUSTUP_TOOLCHAIN` override), `rustc 1.95.0 (59807616e 2026-04-14)`, `cargo 1.95.0 (f2d3ce0bd 2026-03-21)` |
| 실제 wasm-pack·Node·npm 버전 | 확인 대기 | 사용자 조회: wasm-pack `0.14.0`, Node `v25.9.0`, npm `11.12.1` |
| 실제 빌드 명령·환경 옵션·종료 코드 | 확인 대기 | `RUSTUP_TOOLCHAIN=1.95.0` 설정 및 안내한 2번 빌드의 `build_success_utc` 표식 보고. 상세 명령·나머지 환경 옵션·별도 종료 코드 출력은 확인 대기 |
| 빌드 시작·종료 시각(UTC) | 확인 대기 | 시작: 확인 대기. 성공 표식: **`2026-09-11T06:57:10Z`** |
| 생성 WASM 경로·SHA-256 | 확인 대기 | `crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm` — **`1eb49d624365f942ce911ab3aeba8a063556857436faca9097676f6f226d9dbd`** (사용자의 `shasum -a 256` 출력) |
| 실제 테스트 명령 | `npm run decoder:test` | `npm run decoder:test && date -u '+test_success_utc=%Y-%m-%dT%H:%M:%SZ'` |
| 테스트 시작·종료 시각(UTC)·종료 코드 | 확인 대기 | 시작 **`2026-09-11T06:57:40Z`**, 성공 **`2026-09-11T06:57:42Z`**. `&&` 뒤 성공 시각이 출력되어 테스트 종료 코드 0 확인 |
| 전체 / 통과 / 실패 / 취소 / 건너뛰기 | **30 / 30 / 0 / 0 / 0** | **30 / 30 / 0 / 0 / 0** (재빌드 후 사용자 출력) |
| 테스트 출력의 실행 시간 | `duration_ms: 2050.144875` | `duration_ms: 1290.958958` |
| 소스 → 빌드 → 동일 WASM으로 시험 연결 | 최초 시험의 빌드 출처는 미확인 | **사용자 실행 보고 기준 확인.** 에이전트 독립 재빌드·시험은 미수행 |

사용자 제공 `rustc --version --verbose`의 상세 값은 commit hash `59807616e1fa2540724bfbac14d7976d7e4a3860`, commit date `2026-04-14`, host `aarch64-apple-darwin`, release `1.95.0`, LLVM `22.1.2`다. 재빌드 후 시험 결과는 새로 제공된 전체 출력에서 기록했으며, 최초 30개 통과를 복사한 것이 아니다. 새 출력의 `suites`와 `todo`도 각각 0이다.

기존 `pkg`의 수정 시각이나 파일 hash만으로 새 빌드를 증명하지 않는다. 이번 확인은 사용자가 보고한 소스 상태·도구 버전·직접 빌드 성공·WASM hash·후속 시험을 함께 근거로 한다. 남은 기록 항목은 미제공 상태를 보존하며 임의의 시작 시각이나 로그를 채우지 않는다.

### DEC-02 실행 기록 — 검증 대기

| 기록 항목 | 상태 |
| --- | --- |
| 구현·정적 검토 | 코드 작성 완료. 실제 DTO·정책 원문과 연결 코드를 대조했으며 Rust/정책 수정 필요 징후는 발견하지 않음 |
| 실행자·소스 HEAD·전후 변경 diff | 실행 검증 대기. 착수 HEAD `3066f0c`는 실행 기록이 아님 |
| 실제 도구 버전·빌드 명령·환경·임시 target·시각·종료 상태 | 실행 검증 대기 |
| 생성 JS/WASM 경로·SHA-256·시험 전후 동일성 | 실행 검증 대기 |
| 실제 시험 명령·시각·종료 코드·전체/통과/실패/취소/건너뛰기 | 실행 검증 대기. 작성된 시험 수는 DEC-01 30개 + DEC-02 7개 = 37개이며 실행 결과가 아님 |
| 7개 실제 정책 판정·planner `planned: []`·빈 Fact 평가 | 실행 검증 대기 |

새 실행 결과는 이 DEC-02 기록에 추가한다. DEC-01의 두 과거 실행과 미제공 항목은 그대로 유지한다.

## 파일과 실행 경로

| 파일 | 역할 |
| --- | --- |
| `registry-selection.json` | 실제 manifest 및 네 체인의 token 파일을 명시하고 원본 바이트의 SHA-256을 고정 |
| `approve.cases.json` | 고정 raw calldata, 입력 필드, 독립적으로 작성한 기대 decoder ID/Action/error kind |
| `approve.test.mjs` | Node 내장 `node:test`로 source·index·bundle·WASM 결과를 검사 |
| `approve-policy.test.mjs` | DEC-01의 원문 입력을 재사용해 7개 실제 approve 정책 판정 및 planner/평가 DTO 검사 |
| `helpers/build-registry.mjs` | 원본 복사, 실제 builder 실행, inline/`3-ref` 해소 및 JCS digest 검사 |
| `helpers/wasm-worker.mjs` | 별도 Node 프로세스에서 실제 WASM 초기화·bundle 설치·요청 디코딩. 선택적 `policyBundle`이 있을 때 실제 planner/evaluator까지 연결 |
| 루트 `package.json` | `decoder:test`로 DEC-01/02 모두 실행, 개별 실행 명령도 제공 |

```text
registryV2/manifests/standard/erc20/approve@1.0.0.json
  + registry-selection.json이 선정한 실제 token 파일
  → 원본 바이트 hash 확인 및 임시 Registry 복사
  → BUILD_INDEX_REGISTRY_ROOT=<임시 경로>
  → 실제 build-index.ts --strict-callkeys
  → 생성 index의 chain/to/selector 및 bundle 참조 확인
  → resolved bundle의 JCS SHA-256 확인
  → 실제 WASM declarative_install_v3_json
  → 원문 calldata를 declarative_route_request_v3_json에 전달
  → decoder ID 및 Action/error kind 검증
  → DEC-02: 실제 Action.body/meta + 원래 요청의 tx
  → 실제 manifest로 plan_action_rpc_v2_json → planned: [] 검사
  → 실제 Cedar/manifest + results: {}로 evaluate_action_v2_json
  → pass/warn/fail DTO와 정확한 matched 정책 정보 검사
```

helper는 `mkdtemp`로 만든 Registry에 원본 파일을 그대로 복사한다. source manifest의 `chain_ids`를 다시 쓰거나 임의로 축소하지 않는다. 실제 builder를 `execFile`의 구조화된 인수로 호출하며, `BUILD_INDEX_REGISTRY_ROOT`가 임시 입력·출력 경로를 지정한다. builder가 실패·시간 초과하면 임시 산출물 전체를 폐기하고 예외를 전달한다. 일부 생성된 index/bundle을 WASM 입력으로 계속 소비하지 않는다. 정상 실행 후에도 시험이 임시 파일을 정리한다.

## 선정한 원본과 digest 의미

실제 approve source의 선언은 `chain_to_addresses_source: "tokens:erc20"`, `chain_ids: [1, 10, 8453, 42161]`이다. 네 체인의 실제 USDC token 파일을 각각 하나씩 선택한다. 정확한 입력 목록과 바이트 hash는 `registry-selection.json`이 기준이다.

| chain ID | `registryV2/` 기준 token 파일 |
| --- | --- |
| 1 | `tokens/1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.json` |
| 10 | `tokens/10/0x0b2c639c533813f4aa9d7837caf62653d097ff85.json` |
| 8453 | `tokens/8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.json` |
| 42161 | `tokens/42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831.json` |

이 선택은 네 체인의 주소 확장과 최소 정상 사례를 위한 시험 입력이다. 전체 Registry token 목록, 체인의 실제 존재 여부, 계약 배포 상태 또는 최종 SDK 지원 범위를 검증했다는 뜻이 아니다. source hash가 달라지면 먼저 원본 변경을 검토하고 selection을 명시적으로 갱신한다. 실행 결과에서 기대값이나 hash를 자동 재생성하지 않는다.

서로 다른 hash의 의미를 구분한다.

| 값 | 검사 대상 |
| --- | --- |
| selection의 `sha256` | manifest/token **원본 파일 바이트**의 SHA-256. 공백 변경도 감지 |
| index의 `bundle_sha256` | **해소 완료된 bundle 객체**를 JCS(RFC 8785)로 정규화한 문자열의 SHA-256 |
| `bundle_ref` 파일명 | `bundles/<bundle_sha256>.json`과의 일치 |

digest 검사는 index가 지시하는 resolved bundle의 일관성을 검증한다. 개별 index 파일 전체의 서명, Registry 전체 root digest, 발행자 인증 또는 공급망 서명을 검증하는 기능은 아니다.

기존 `registry-api/src/server.ts`의 `materializeIfRefIndex`를 참고해 이번에 필요한 두 형태만 해소한다. inline index는 `bundle`을 사용하고, `schema_version: "3-ref"`는 `bundle_ref` 파일을 읽는다. 현재 approve token source는 후자다. builder가 사용하는 기존 `canonicalize` 의존성을 재사용하며, bundle을 별도 타입으로 투영하거나 emit 규칙을 다시 작성하지 않는다. `context_ref`/`materialization`이 있는 source-context 조립은 지원하지 않고 명시적으로 거절한다. 해당 경로가 필요해지면 기존 `materializeSourceBundle`과의 동일성을 별도 검토해야 한다.

## DEC-01 기대값과 오류 구분

고정 calldata에서 selector, spender의 32바이트 word, uint256 amount 위치를 독립적으로 확인한다. 수량 검산에는 `BigInt`와 문자열을 사용하며 JS `Number`로 변환하지 않는다. 기대 Action을 decoder 반환값에서 만들지 않는다. 기존 `args_to_json`은 uint256을 decimal string으로 전달하고, 최종 Rust U256 JSON 직렬화는 최소 길이 hex 문자열을 출력한다. 예를 들어 0은 `"0x0"`, 1,000,000은 `"0xf4240"`이다.

manifest의 중첩 `token.erc20_approve`와 실제 Action body의 평탄화된 `domain`, `action`, `token`, `spender`, `amount`를 구분한다. token은 호출 대상 `to`, spender는 calldata 인자이고 출력 주소는 소문자다. token chain은 `eip155:<chain_id>`를 유지한다. 설치 결과와 디코딩 결과의 ID는 모두 `standard/erc20/approve@1.0.0`이어야 한다.

27개 요청 사례와 3개 연결·fixture 검사를 작성했다(총 30개 Node test). 시험 사례는 다음을 포함한다.

- 네 체인의 정상 approve, 승인량 0·일반 수량·`2^160-1`·`2^256-1`·`2^256-2`.
- 주소 대소문자 정규화 및 token/spender의 구분.
- 설치된 decoder의 등록 조합에 없는 정상 형식의 요청.
- 잘못된 주소·chain 표현, 비정상 hex, selector만 존재, 인자 일부 누락.
- 입력 selector와 calldata selector 불일치의 두 방향.
- 정상 ABI 인자 뒤 추가 바이트를 붙여도 동일 Action을 얻는 기존 호환성.
- bundle을 설치한 프로세스와 설치하지 않은 프로세스의 상태 분리.

| 구분 | 기존 결과 및 의미 |
| --- | --- |
| 주소 파싱 실패 / `chain_id: u64` 역직렬화 실패 | `invalid_input_json`: 입력 형식 오류 |
| 비정상 calldata hex | `invalid_calldata`: 입력 바이트 형식 오류 |
| 정상 형식의 미등록 `(chain, to, selector)` | `no_declarative_v3_mapper`: 설치된 decoder의 매칭 범위 밖 |
| 매칭된 approve의 selector-only / 부족한 ABI 인자 | `decode_failed`: 알려진 호출의 해석 실패 |
| 입력 selector=approve, calldata selector=다른 값 | approve lookup 후 ABI selector 검사에서 `decode_failed` |
| 입력 selector=미등록 값, calldata selector=approve | ABI 해석 전 lookup에서 `no_declarative_v3_mapper` |
| 정상 ABI 인자 뒤 추가 바이트 | 허용. 기본 `decode_with_function`의 `validate=false` 유지 |

selector 불일치의 두 오류는 현재의 lookup 우선순위를 고정한다. lookup 전 일치 검사를 추가하면 오류 분류가 달라지므로 이 단계에서 추가하지 않는다. selector-only는 4바이트 calldata이며 빈 calldata의 native-transfer 분기와 다르다. 인자 누락 거절과 추가 바이트 허용은 최초 시험과 현재 소스 재빌드 후 시험의 사용자 출력에서 모두 통과했다. 코드에서는 Alloy의 최소 word 검사와 permissive ABI decode가 각각 이 동작에 대응한다.

형식 검사, decoder 매칭, 위험 판정은 별개다. 미등록 주소·체인을 악성으로 판단하거나 allow/warn/deny 정책을 추가하지 않는다. 이번 필수 사례에서 Rust 변경이 필요한 차이는 정적 검토 및 사용자 실행 보고에서 발견하지 않았다. 현재 소스의 재빌드·시험 결과가 기대와 다르면 fixture를 유지하고 관련 최소 입력·현재 결과·기대 차이·수정 선택지를 정리한 뒤 범위 변경을 판단한다.

서로 다른 설치 시나리오는 각기 새 Node 프로세스로 실행한다. 기존 WASM의 전역 `DECLARATIVE_V3_STATE`와 module cache를 공유하지 않으며, 격리를 위해 reset API나 Core 인스턴스 구현을 추가하지 않는다. 디코더·WASM은 mock하지 않는다.

Action meta의 gas price에는 기존 실행부가 만든 Pyth source stub이 포함된다. 시험은 현재 직렬화 형식을 확인하며, 이 값을 실제 Oracle 조회나 검증된 provenance의 증거로 사용하지 않는다.

## DEC-02 정책 입력·기대값·오류 구분

정책 원본은 `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/{policy.cedar,manifest.json}`이다. 파일을 그대로 읽어 사용하며 본문·manifest·severity는 변경하지 않는다. 이름에 `deny`가 있어도 실제 annotation은 `@severity("warn")`이다. 정책은 `context.amount`가 정확히 40개 또는 64개의 `f`인 U256 hex 문자열일 때, spender가 원문 allowlist의 Permit2 주소 `0x000000000022d473030f116ddee9f6b43ac78ba3`가 아니면 경고한다. 시험에 고정한 주소를 해당 Cedar set literal과 대조한다.

| DEC-01 원문 입력 | spender | 승인량의 독립 검산 | 기대 DTO `kind` |
| --- | --- | --- | --- |
| `amount-zero` | 일반 spender | `0` | `pass` |
| `amount-normal` | 일반 spender | `1,000,000` | `pass` |
| `amount-uint160-max` | 일반 spender | `2^160-1` | `warn` |
| `amount-uint256-max` | 일반 spender | `2^256-1` | `warn` |
| `amount-uint256-max-minus-one` | 일반 spender | `2^256-2` | `pass` |
| `amount-uint160-max`의 spender word만 교체 | 정책에 선언된 Permit2 | `2^160-1` | `pass` |
| `amount-uint256-max`의 spender word만 교체 | 정책에 선언된 Permit2 | `2^256-1` | `pass` |

일반 spender는 DEC-01 원문 입력의 `0x00000000000000000000000000000000deadbeef`다. 체인 1의 기존 5개 입력만 재사용하고 Permit2 예외 2개를 추가한다. Registry source의 네 체인 선언은 그대로 빌드하지만 정책 시험의 불필요한 체인·수량 조합과 DEC-01의 30개 검사는 복제하지 않는다.

기대 판정은 위 정책의 정확한 동등 비교와 예외 조건을 읽고 명시했으며, 수량은 원문 calldata의 두 번째 ABI word를 `BigInt`로 독립 검산한다. 실제 평가 결과를 정답 파일에 저장하거나 DEC-01 fixture의 `expected` Action을 평가 입력으로 사용하지 않는다. Permit2 사례는 **원문 calldata의 첫 번째 ABI word만 교체**하고 selector·amount 바이트 보존을 확인한 뒤 실제 디코더를 다시 통과한다. 이미 디코딩된 Action은 수정하지 않는다.

worker는 실제 디코딩 결과에서 `action: decoded.body`, `meta: decoded.meta`를 그대로 전달한다. `tx`는 원래 요청의 `chain_id`를 `eip155:<chain_id>` 문자열로 표현하고, `from: input.submitter`, `to: input.to`로 구성한다. token·spender·amount를 새 평가용 객체로 재작성하지 않는다. 기존 `action_eval_exports.rs`의 `plan_action_rpc_v2_json`에는 `manifests: [manifest]`, `evaluate_action_v2_json`에는 `bundles: [{ policy, manifest }]`, `results: {}`를 전달한다. 별도 평가 로직·mock·Fact provider는 없다.

각 사례는 planner의 전체 성공 envelope와 `data.planned: []`를 검사한다. evaluator의 성공 envelope만으로는 판정 성공을 알 수 없으므로 `dto.rs`의 실제 `pass/warn/fail` 표현을 사용한다. pass는 `{ kind: "pass" }`, warn은 다음 전체 DTO와 일치해야 한다.

```json
{
  "kind": "warn",
  "matched": [{
    "policy_id": "unlimited-approval-deny",
    "reason": null,
    "severity": "warn",
    "origin": "action"
  }]
}
```

정확한 `matched` 비교는 엔진 오류 `__engine::*`, `__engine::quarantine::*`, `__system__`, schema 오류 판정과 여분의 정책 match를 모두 배제한다. 빈 계획만으로 정책 trigger가 적용됐다고 간주하지 않으며, 두 일반 spender 경고 사례가 실제 정책 ID로 판정되는지도 검사한다. manifest에 외부 RPC 항목이 없고 기존 approve lowering이 수량을 최소 길이 hex 문자열로 전달하는 것은 코드상 확인했다. 이 연결과 7개 판정의 실제 성공은 **실행 검증 대기**다. 불일치가 나오면 기대값을 유지하고 최소 입력·코드상 동작·실제 결과·수정 선택지를 정리한다.

`helpers/wasm-worker.mjs`는 선택적 `policyBundle`이 없으면 DEC-01의 기존 입력과 `{ installations, results: [{ id, result }] }` 출력을 유지한다. DEC-02에서만 결과 항목에 `plan`, `evaluation` 응답을 추가한다. 기존 `approve.test.mjs`, `approve.cases.json`, `registry-selection.json`, `helpers/build-registry.mjs`는 수정하지 않았다.

## 남아 있는 임시 경로 의존

이 시험은 최종 SDK 소유 구조나 독립 빌드 완료 증거가 아니다. 아래 경로는 이관 전 기준 시험을 위한 의존이며, 이번에 이동하지 않는다.

| 원본 경로 | 현재 소비 함수/시험 | 향후 대상과 제거 단계 |
| --- | --- | --- |
| `registryV2/manifests/`, `registryV2/tokens/`, `registryV2/scripts/build-index.ts` | `buildRegistry`, `approve.test.mjs`의 실제 주소 확장·index 검사 | Decoder 원본/빌드 소유권은 유지하며, SDK 배포 입력은 D4 고정 snapshot으로 명시. DEC-07 인계 및 C5 독립 빌드에서 경로 목록 확인 |
| `registryV2/node_modules/{tsx,canonicalize}` | 실제 TypeScript builder 실행과 `resolveIndexBundle`의 JCS | 현재 Registry lockfile로 설치. D4/C5에서 SDK 소스·빌드 입력으로 필요한 부분을 명시하고 이전 설치물 재사용 제거 |
| `crates/adapters/mappers/src/declarative/fn_whitelist.json` | 실제 builder가 스크립트 위치 기준으로 읽는 `$fn` 허용 목록. approve가 `$fn`을 쓰지 않아도 파일을 읽음 | SDK 소유 `crates/adapters/mappers/`의 공유 원본으로 포함, DEC-07 인계·C5 독립 소스 빌드에서 검증 |
| `crates/policy-engine-wasm/src/declarative_exports.rs`, `crates/policy-engine-wasm/pkg/` | worker의 두 실제 WASM export와 생성 JS/WASM import | `crates/dambi-core/src/decode/`, `crates/dambi-core-wasm/`, SDK WASM/glue. C2a·C2b 이관 후 C5에 runner/build 경로 교체 |
| `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/` | `approve-policy.test.mjs`가 읽는 실제 Cedar/manifest. 이관 전 기준 시험의 임시 입력 | D3에서 `policy-bundles/day1-safety/` 및 공유 fixture로 이관한 뒤 시험 입력 경로 교체. 최종 SDK 의존 구조가 아님 |
| `crates/policy-engine-wasm/src/action_eval_exports.rs`, `src/dto.rs` | worker가 호출하는 실제 planner/evaluator 및 판정 계약 | C2a·C2b·C5에서 SDK 실행부/WASM 경계로 이관하며 DEC-02 회귀 사례 유지 |
| `crates/adapters/abi-resolver/src/{bridge,decode}.rs`, `crates/adapters/mappers/src/declarative/{args_json,action_builder}.rs` | WASM 내부 ABI 해석·수량 변환·Action 생성 | SDK 소유 decoder 의존으로 재사용. C2a·C2b·C5에서 기존 WASM wrapper에 대한 의존 제거 |
| `crates/policy-server/asset-model/{state,action,transition}/` | 기존 WASM이 사용하는 Action/meta/primitives 직렬화 | `crates/asset-model/{state,action,transition}/`, C2-0a에서 Cargo 경로 이관 |
| 기존 Cargo workspace와 crate 밖 `schema/policy-schema/` | 기존 `policy-engine-wasm`을 소스로 빌드할 때 필요한 간접 의존 | SDK root/API workspace 분리 C2-0b, `crates/policy-engine/schema/policy-schema/` 내재화 C2-0c. C2c·C5에서 독립 빌드 검증 |
| `registry-api/src/server.ts` | inline/`3-ref` 해소 의미를 대조한 원본. 런타임 import는 없음 | DEC-07에 parity 범위 인계. source-context 지원이 필요해질 때 해당 기존 함수와 별도 대조 |

## 사용자가 직접 실행할 준비·빌드·시험 명령

아래 재빌드 절차는 **DEC-02 실행 검증에 사용할 명령이며 에이전트는 실행하지 않았다.** Node 20 이상, `rust-toolchain.toml`의 Rust 1.95.0, CI의 wasm-pack 0.14.0을 기준으로 한다. DEC-01 당시 도구 조회 결과와 사용자 실행 결과는 위 과거 기록표에 유지했다. Registry 의존성 설치 완료를 이미 보고했으므로 의존성이 남아 있다면 다시 설치할 필요는 없다. DEC-02 판정 및 현재 worker를 통한 DEC-01 회귀 검증은 새 실행 기록으로 남긴다.

현재 빌드 설정은 root `Cargo.toml`의 release LTO=`fat`·codegen-units=`1`, WASM crate의 `package.metadata.wasm-pack.profile.release.wasm-opt`, 직접 명령의 `CARGO_PROFILE_RELEASE_OPT_LEVEL=z`다. 생성 위치는 `crates/policy-engine-wasm/pkg/`이며 worker는 그 안의 `policy_engine_wasm.js`와 `policy_engine_wasm_bg.wasm`을 사용한다. JS glue와 WASM은 같은 빌드에서 생성된 것을 함께 사용한다.

아래 블록은 zsh 터미널에서도 그대로 붙여 넣을 수 있도록 별도 Bash에서 실행한다. 순서는 소스·버전 확인 → 직접 WASM 빌드 → SHA-256 → DEC-01/02 통합 시험 → 빌드 후 상태 기록이다. 새 임시 `CARGO_TARGET_DIR`를 사용해 기존 컴파일 출력에 의존하지 않고 빌드하며 기존 `target`은 삭제하지 않는다. 로그와 임시 target은 저장소 밖에 둔다. 실행 중 소스·설정·fixture·정책·`pkg`를 다른 작업에서 수정하지 않는다.

`set -euo pipefail`로 빌드·시험 또는 `tee`가 실패하면 후속 단계를 중단하고 0이 아닌 종료 코드를 유지한다. `build_exit=0`·`test_exit=0`은 해당 파이프라인이 성공한 뒤에만 출력한다. 실패한 빌드 뒤에 기존 `pkg`로 시험을 계속하지 않는다.

```sh
bash <<'DEC02_VERIFY'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
dec02_log_dir="$(mktemp -d /tmp/dambi-dec02-verify.XXXXXX)"
printf 'DEC-02 logs: %s\n' "$dec02_log_dir"
trap 'dec02_rc=$?; date -u "+failure_utc=%Y-%m-%dT%H:%M:%SZ" | tee -a "$dec02_log_dir/timeline.log"; printf "failed_exit=%s\n" "$dec02_rc" | tee -a "$dec02_log_dir/timeline.log"; exit "$dec02_rc"' ERR

export RUSTUP_TOOLCHAIN=1.95.0
export CARGO_TARGET_DIR="$dec02_log_dir/target"
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
{
  date -u '+source_check_utc=%Y-%m-%dT%H:%M:%SZ' || exit $?
  git branch --show-current || exit $?
  git rev-parse HEAD || exit $?
  git status --short --untracked-files=all || exit $?
  rustup show active-toolchain || exit $?
  rustc --version --verbose || exit $?
  cargo --version --verbose || exit $?
  wasm-pack --version || exit $?
  node --version || exit $?
  npm --version || exit $?
  printf 'RUSTUP_TOOLCHAIN=%s\nCARGO_TARGET_DIR=%s\nCARGO_PROFILE_RELEASE_OPT_LEVEL=%s\n' \
    "$RUSTUP_TOOLCHAIN" "$CARGO_TARGET_DIR" "$CARGO_PROFILE_RELEASE_OPT_LEVEL"
} 2>&1 | tee "$dec02_log_dir/source-and-tools.log"
git diff HEAD -- > "$dec02_log_dir/tracked-before.patch"
shasum -a 256 package.json fixtures/decoder-policy/registry-selection.json \
  fixtures/decoder-policy/approve.cases.json fixtures/decoder-policy/approve.test.mjs \
  fixtures/decoder-policy/approve-policy.test.mjs \
  fixtures/decoder-policy/helpers/build-registry.mjs fixtures/decoder-policy/helpers/wasm-worker.mjs \
  browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/policy.cedar \
  browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/manifest.json \
  | tee "$dec02_log_dir/test-inputs.sha256"

date -u '+build_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec02_log_dir/timeline.log"
printf '%s\n' 'wasm-pack build crates/policy-engine-wasm --target web --release --out-dir pkg --out-name policy_engine_wasm' \
  | tee -a "$dec02_log_dir/timeline.log"
wasm-pack build crates/policy-engine-wasm \
  --target web --release --out-dir pkg --out-name policy_engine_wasm \
  2>&1 | tee "$dec02_log_dir/build.log"
printf 'build_exit=0\n' | tee -a "$dec02_log_dir/timeline.log"
date -u '+build_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec02_log_dir/timeline.log"
shasum -a 256 crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm \
  crates/policy-engine-wasm/pkg/policy_engine_wasm.js | tee "$dec02_log_dir/artifacts.sha256"

date -u '+test_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec02_log_dir/timeline.log"
printf '%s\n' 'npm run decoder:test' | tee -a "$dec02_log_dir/timeline.log"
npm run decoder:test 2>&1 | tee "$dec02_log_dir/test.log"
printf 'test_exit=0\n' | tee -a "$dec02_log_dir/timeline.log"
date -u '+test_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec02_log_dir/timeline.log"
shasum -a 256 -c "$dec02_log_dir/artifacts.sha256" | tee "$dec02_log_dir/artifacts-after-test.log"
shasum -a 256 -c "$dec02_log_dir/test-inputs.sha256" | tee "$dec02_log_dir/test-inputs-after.log"
{
  git rev-parse HEAD || exit $?
  git status --short --untracked-files=all || exit $?
} | tee "$dec02_log_dir/source-after.log"
git diff HEAD -- > "$dec02_log_dir/tracked-after.patch"
printf 'Review results in %s\n' "$dec02_log_dir"
DEC02_VERIFY
```

로그의 시작·종료 시각, 소스 HEAD와 전후 변경 내역, 실제 도구 버전, 명령·환경 변수, 빌드 종료 상태, JS/WASM SHA-256, 테스트 요약 수치를 위 **DEC-02 실행 기록**에 반영하고 두 계획서 상태도 실제 결과에 맞게 갱신한다. 테스트 수치는 의도된 37개를 미리 통과로 적지 말고 실제 summary와 7개 정책 판정 출력을 옮긴다. `tracked-before.patch`/`tracked-after.patch`는 추적 파일만 담으므로 미추적 fixture는 `test-inputs.sha256`과 아래 커밋 대상 목록도 함께 확인한다. 소스·설정·fixture·정책이 실행 중 변경되었거나 hash 확인이 실패했다면 동일 소스·산출물 검증을 완료 처리하지 않는다. 임시 로그 자체를 커밋하지 말고 필요한 결과만 이 문서에 기록한다. DEC-01의 과거 검증표는 덮어쓰지 않는다.

필요한 도구가 없거나 버전이 맞지 않을 때만 아래에서 해당 준비 명령을 선택한다. Node 20 이상은 사용하는 버전 관리 방식으로 준비한다. 준비 후에는 위 검증 절차를 처음부터 실행해 실제 버전을 기록한다.

```sh
rustup toolchain install 1.95.0 --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
cargo +1.95.0 install wasm-pack --version 0.14.0 --locked
# registryV2/node_modules가 없을 때만:
npm ci --prefix registryV2
```

기존 `scripts/wasm-build.sh`는 WASM 빌드 외에 license/NOTICE와 산출물을 확장 폴더에 복사하고 기존 public WASM 파일도 정리하므로 이 절차에서는 사용하지 않는다. 직접 빌드에서 license/NOTICE 준비 문제가 실제로 나타나면 해당 준비 단계만 보완한다.

**`npm run decoder:test`는 DEC-01과 DEC-02를 모두 실행하며 각 시험 내부에서 실제 Registry builder를 실행한다.** Registry 빌드는 임시 디렉터리를 대상으로 하며 WASM을 빌드하지 않는다. 사전에 준비한 WASM이 없거나 설치·digest·디코딩·정책 결과가 기대와 다르면 시험을 건너뛰지 않고 실패한다. 이는 SDK 전체 소스·빌드 독립화 시험이 아니다. DEC-01 과거 기록의 동일 명령은 당시 `approve.test.mjs` 30개만 실행했다.

통합 실행 대신 각각 확인할 때의 명령은 다음과 같다. 각각도 내부 Registry 빌드를 수행하므로 이번 에이전트 작업에서는 실행하지 않았다.

```sh
npm run decoder:test:approve
npm run decoder:test:approve-policy
```

## DEC-02 검증 후 커밋 준비

DEC-01은 착수 시 HEAD `3066f0c`에 커밋돼 있었다. 이번 DEC-02는 아직 실행 검증하지 않았으므로 아래 명령은 **사용자가 준비·WASM 빌드·DEC-01/02 검증에 성공하고 README 및 두 계획서의 실행 기록을 갱신한 뒤** 직접 실행한다. 기존 미확인 메타데이터는 확인 대기로 보존한다. 두 계획서의 후속 단계 내용은 계획이며 구현 완료를 뜻하지 않는다. 이번 변경 6개 파일만 명시한다.

```sh
git status --short
git diff --check
git diff -- package.json fixtures/decoder-policy/README.md \
  fixtures/decoder-policy/helpers/wasm-worker.mjs \
  docs/sdk-migration/decoder-design-plan.md docs/sdk-migration/decoder-core-adapters-plan.md
# 신규 미추적 파일은 git diff에 나타나지 않으므로 별도로 검토:
cat fixtures/decoder-policy/approve-policy.test.mjs
# 기존 staged 변경이 없는지 먼저 확인:
git diff --cached --name-only
git add -- package.json \
  fixtures/decoder-policy/approve-policy.test.mjs \
  fixtures/decoder-policy/helpers/wasm-worker.mjs \
  fixtures/decoder-policy/README.md \
  docs/sdk-migration/decoder-design-plan.md \
  docs/sdk-migration/decoder-core-adapters-plan.md
git diff --cached --check
git diff --cached --stat
git commit --only -m "test(decoder): connect approve decoding to policy evaluation" -- \
  package.json \
  fixtures/decoder-policy/approve-policy.test.mjs \
  fixtures/decoder-policy/helpers/wasm-worker.mjs \
  fixtures/decoder-policy/README.md \
  docs/sdk-migration/decoder-design-plan.md \
  docs/sdk-migration/decoder-core-adapters-plan.md
```

생성된 WASM·`pkg`·`dist`·`target`·`node_modules`·Registry 생성물·임시 로그는 커밋 대상에서 제외한다. `git commit --only`에도 같은 6개 경로를 지정해 다른 staged 파일이 포함되지 않게 한다. 실행 전 해당 경로에 새 사용자 변경이 없는지 내용을 검토한다. 이번 에이전트 작업에서는 스테이징·커밋을 하지 않으며 DEC-03으로 진행하지 않는다.
