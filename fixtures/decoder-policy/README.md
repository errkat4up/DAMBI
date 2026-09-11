# DEC-01: 실제 ERC-20 approve 디코딩 기준 시험

이 디렉터리는 SDK 이관 전의 **DEC-01 기준 시험(baseline)** 이다. 실제 Registry source를 실제 builder로 확장하고 기존 WASM에 설치한 뒤, 고정된 원문 approve calldata를 Action까지 해석한다. 이름에 `policy`가 있지만 DEC-02 정책 평가는 연결하지 않는다.

DEC-01 구현 및 연결 시험은 **사용자 실행 보고 기준으로 30개 통과**했다. 실패·취소·건너뛰기는 모두 0개다. 최초 시험에 이어 현재 Rust 소스에서 직접 WASM을 빌드한 뒤 실행한 시험도 같은 결과로 통과했다. 실제 Registry builder → resolved bundle digest 확인 → 실제 WASM 설치·approve 디코딩 경로가 시험되었다. 두 결과 모두 사용자가 제공한 출력이며, 문서를 정리한 에이전트가 실행한 결과가 아니다.

**현재 Rust 소스 → 직접 빌드한 WASM → 해당 산출물의 연결 시험 통과를 사용자 보고 기준으로 확인했다.** 근거는 안내한 절차의 실행 완료 보고, 전후 HEAD·Git 변경 목록, 도구 버전 조회, 빌드 성공 표식·시각, WASM SHA-256, 뒤이어 실행한 테스트 출력과 시각이다. 상세 빌드 로그·전체 빌드 명령 출력·실제 임시 target 경로·빌드 시작 시각은 미제공으로 기록 보완을 기다린다. 에이전트가 별도로 재빌드하여 소스와 산출물의 일치를 독립 재현한 것은 아니다. DEC-02는 미착수이고, SDK 전체 소스·빌드 독립화도 완료되지 않았다. 이번 문서 정리에서는 빌드·테스트·설치·Git add/commit/push/merge/reset·브랜치 변경을 실행하지 않는다.

## 검증 기록

문서 정리 시점에 Git을 읽어 확인한 브랜치는 `feat/decoder`, HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`다. Git 상태상 `crates/`의 Rust 소스, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`, `schema/`, `scripts/wasm-build.sh`, `.github/workflows/ci.yml`에 미커밋 변경은 없다. 전체 작업 트리는 `package.json` 수정과 DEC-01 fixture·두 계획서의 미추적 파일 때문에 변경된 상태다. 스테이징된 변경은 없다. 이는 **현재 소스 상태의 확인**이며, 빌드 출처가 없던 최초 시험의 WASM 상태를 소급해 증명하지 않는다. 이번 재빌드 후 검증은 아래 별도 사용자 기록을 따른다.

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

## 파일과 실행 경로

| 파일 | 역할 |
| --- | --- |
| `registry-selection.json` | 실제 manifest 및 네 체인의 token 파일을 명시하고 원본 바이트의 SHA-256을 고정 |
| `approve.cases.json` | 고정 raw calldata, 입력 필드, 독립적으로 작성한 기대 decoder ID/Action/error kind |
| `approve.test.mjs` | Node 내장 `node:test`로 source·index·bundle·WASM 결과를 검사 |
| `helpers/build-registry.mjs` | 원본 복사, 실제 builder 실행, inline/`3-ref` 해소 및 JCS digest 검사 |
| `helpers/wasm-worker.mjs` | 별도 Node 프로세스에서 실제 WASM 초기화·bundle 설치·요청 디코딩 |

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

## 기대값과 오류 구분

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

## 남아 있는 임시 경로 의존

이 시험은 최종 SDK 소유 구조나 독립 빌드 완료 증거가 아니다. 아래 경로는 이관 전 기준 시험을 위한 의존이며, 이번에 이동하지 않는다.

| 원본 경로 | 현재 소비 함수/시험 | 향후 대상과 제거 단계 |
| --- | --- | --- |
| `registryV2/manifests/`, `registryV2/tokens/`, `registryV2/scripts/build-index.ts` | `buildRegistry`, `approve.test.mjs`의 실제 주소 확장·index 검사 | Decoder 원본/빌드 소유권은 유지하며, SDK 배포 입력은 D4 고정 snapshot으로 명시. DEC-07 인계 및 C5 독립 빌드에서 경로 목록 확인 |
| `registryV2/node_modules/{tsx,canonicalize}` | 실제 TypeScript builder 실행과 `resolveIndexBundle`의 JCS | 현재 Registry lockfile로 설치. D4/C5에서 SDK 소스·빌드 입력으로 필요한 부분을 명시하고 이전 설치물 재사용 제거 |
| `crates/adapters/mappers/src/declarative/fn_whitelist.json` | 실제 builder가 스크립트 위치 기준으로 읽는 `$fn` 허용 목록. approve가 `$fn`을 쓰지 않아도 파일을 읽음 | SDK 소유 `crates/adapters/mappers/`의 공유 원본으로 포함, DEC-07 인계·C5 독립 소스 빌드에서 검증 |
| `crates/policy-engine-wasm/src/declarative_exports.rs`, `crates/policy-engine-wasm/pkg/` | worker의 두 실제 WASM export와 생성 JS/WASM import | `crates/dambi-core/src/decode/`, `crates/dambi-core-wasm/`, SDK WASM/glue. C2a·C2b 이관 후 C5에 runner/build 경로 교체 |
| `crates/adapters/abi-resolver/src/{bridge,decode}.rs`, `crates/adapters/mappers/src/declarative/{args_json,action_builder}.rs` | WASM 내부 ABI 해석·수량 변환·Action 생성 | SDK 소유 decoder 의존으로 재사용. C2a·C2b·C5에서 기존 WASM wrapper에 대한 의존 제거 |
| `crates/policy-server/asset-model/{state,action,transition}/` | 기존 WASM이 사용하는 Action/meta/primitives 직렬화 | `crates/asset-model/{state,action,transition}/`, C2-0a에서 Cargo 경로 이관 |
| 기존 Cargo workspace와 crate 밖 `schema/policy-schema/` | 기존 `policy-engine-wasm`을 소스로 빌드할 때 필요한 간접 의존 | SDK root/API workspace 분리 C2-0b, `crates/policy-engine/schema/policy-schema/` 내재화 C2-0c. C2c·C5에서 독립 빌드 검증 |
| `registry-api/src/server.ts` | inline/`3-ref` 해소 의미를 대조한 원본. 런타임 import는 없음 | DEC-07에 parity 범위 인계. source-context 지원이 필요해질 때 해당 기존 함수와 별도 대조 |

## 사용자가 직접 실행할 준비·빌드·시험 명령

아래 재빌드 절차는 **향후 재현에 사용할 명령이며 에이전트는 실행하지 않았다.** Node 20 이상, `rust-toolchain.toml`의 Rust 1.95.0, CI의 wasm-pack 0.14.0을 기준으로 한다. 실제 도구 조회 결과와 이번 사용자 실행 결과는 위 기록표에 반영했다. 사용자는 이미 `npm ci --prefix registryV2`의 설치 완료와 재빌드 후 시험 성공을 보고했으므로 현재 기록 정리를 위해 설치·빌드·시험을 반복할 필요는 없다.

현재 빌드 설정은 root `Cargo.toml`의 release LTO=`fat`·codegen-units=`1`, WASM crate의 `package.metadata.wasm-pack.profile.release.wasm-opt`, 직접 명령의 `CARGO_PROFILE_RELEASE_OPT_LEVEL=z`다. 생성 위치는 `crates/policy-engine-wasm/pkg/`이며 worker는 그 안의 `policy_engine_wasm.js`와 `policy_engine_wasm_bg.wasm`을 사용한다. JS glue와 WASM은 같은 빌드에서 생성된 것을 함께 사용한다.

아래 블록은 zsh 터미널에서도 그대로 붙여 넣을 수 있도록 별도 Bash에서 실행한다. 순서는 소스·버전 확인 → 직접 WASM 빌드 → SHA-256 → DEC-01 시험 → 빌드 후 상태 기록이다. 새 임시 `CARGO_TARGET_DIR`를 사용해 기존 컴파일 출력에 의존하지 않고 빌드하며 기존 `target`은 삭제하지 않는다. 로그와 임시 target은 저장소 밖에 둔다. 실행 중 소스·설정·fixture·`pkg`를 다른 작업에서 수정하지 않는다.

`set -euo pipefail`로 빌드·시험 또는 `tee`가 실패하면 후속 단계를 중단하고 0이 아닌 종료 코드를 유지한다. `build_exit=0`·`test_exit=0`은 해당 파이프라인이 성공한 뒤에만 출력한다. 실패한 빌드 뒤에 기존 `pkg`로 시험을 계속하지 않는다.

```sh
bash <<'DEC01_VERIFY'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
dec01_log_dir="$(mktemp -d /tmp/dambi-dec01-verify.XXXXXX)"
printf 'DEC-01 logs: %s\n' "$dec01_log_dir"
trap 'dec01_rc=$?; date -u "+failure_utc=%Y-%m-%dT%H:%M:%SZ" | tee -a "$dec01_log_dir/timeline.log"; printf "failed_exit=%s\n" "$dec01_rc" | tee -a "$dec01_log_dir/timeline.log"; exit "$dec01_rc"' ERR

export RUSTUP_TOOLCHAIN=1.95.0
export CARGO_TARGET_DIR="$dec01_log_dir/target"
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
} 2>&1 | tee "$dec01_log_dir/source-and-tools.log"
git diff HEAD -- > "$dec01_log_dir/tracked-before.patch"
shasum -a 256 package.json fixtures/decoder-policy/registry-selection.json \
  fixtures/decoder-policy/approve.cases.json fixtures/decoder-policy/approve.test.mjs \
  fixtures/decoder-policy/helpers/build-registry.mjs fixtures/decoder-policy/helpers/wasm-worker.mjs \
  | tee "$dec01_log_dir/test-inputs.sha256"

date -u '+build_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec01_log_dir/timeline.log"
printf '%s\n' 'wasm-pack build crates/policy-engine-wasm --target web --release --out-dir pkg --out-name policy_engine_wasm' \
  | tee -a "$dec01_log_dir/timeline.log"
wasm-pack build crates/policy-engine-wasm \
  --target web --release --out-dir pkg --out-name policy_engine_wasm \
  2>&1 | tee "$dec01_log_dir/build.log"
printf 'build_exit=0\n' | tee -a "$dec01_log_dir/timeline.log"
date -u '+build_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec01_log_dir/timeline.log"
shasum -a 256 crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm \
  crates/policy-engine-wasm/pkg/policy_engine_wasm.js | tee "$dec01_log_dir/artifacts.sha256"

date -u '+test_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec01_log_dir/timeline.log"
printf '%s\n' 'npm run decoder:test' | tee -a "$dec01_log_dir/timeline.log"
npm run decoder:test 2>&1 | tee "$dec01_log_dir/test.log"
printf 'test_exit=0\n' | tee -a "$dec01_log_dir/timeline.log"
date -u '+test_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec01_log_dir/timeline.log"
shasum -a 256 -c "$dec01_log_dir/artifacts.sha256" | tee "$dec01_log_dir/artifacts-after-test.log"
shasum -a 256 -c "$dec01_log_dir/test-inputs.sha256" | tee "$dec01_log_dir/test-inputs-after.log"
{
  git rev-parse HEAD || exit $?
  git status --short --untracked-files=all || exit $?
} | tee "$dec01_log_dir/source-after.log"
git diff HEAD -- > "$dec01_log_dir/tracked-after.patch"
printf 'Review results in %s\n' "$dec01_log_dir"
DEC01_VERIFY
```

로그의 시작·종료 시각, 소스 HEAD와 전후 변경 내역, 실제 도구 버전, 명령·환경 변수, 빌드 종료 상태, WASM SHA-256, 테스트 요약 수치를 위 표의 **현재 Rust 소스 재빌드 후 검증** 칸에 반영한다. 테스트 수치는 예상 30개를 미리 적지 말고 실제 summary를 옮긴다. `tracked-before.patch`/`tracked-after.patch`는 추적 파일만 담으므로 미추적 fixture는 `test-inputs.sha256`과 아래 커밋 대상 목록도 함께 확인한다. 소스·설정·fixture가 실행 중 변경되었거나 hash 확인이 실패했다면 동일 소스·산출물 검증을 완료 처리하지 않는다. 임시 로그 자체를 커밋하지 말고 필요한 결과만 이 문서에 기록한다.

필요한 도구가 없거나 버전이 맞지 않을 때만 아래에서 해당 준비 명령을 선택한다. Node 20 이상은 사용하는 버전 관리 방식으로 준비한다. 준비 후에는 위 검증 절차를 처음부터 실행해 실제 버전을 기록한다.

```sh
rustup toolchain install 1.95.0 --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
cargo +1.95.0 install wasm-pack --version 0.14.0 --locked
# registryV2/node_modules가 없을 때만:
npm ci --prefix registryV2
```

기존 `scripts/wasm-build.sh`는 WASM 빌드 외에 license/NOTICE와 산출물을 확장 폴더에 복사하고 기존 public WASM 파일도 정리하므로 이 절차에서는 사용하지 않는다. 직접 빌드에서 license/NOTICE 준비 문제가 실제로 나타나면 해당 준비 단계만 보완한다.

**`npm run decoder:test`는 내부에서 실제 Registry builder를 실행한다.** Registry 빌드는 임시 디렉터리를 대상으로 하며 WASM을 빌드하지 않는다. 사전에 준비한 WASM이 없거나 설치·digest·디코딩 결과가 기대와 다르면 시험을 건너뛰지 않고 실패한다. 이는 SDK 전체 소스·빌드 독립화 시험이 아니며 DEC-02를 실행하지 않는다.

## DEC-01 커밋 준비

현재 소스의 직접 빌드 성공과 재시험 30개 통과는 사용자 보고 기준으로 위 표에 반영했다. 미제공 메타데이터는 확인 대기로 보존했다. 커밋은 사용자가 아래 차이를 검토한 뒤 실행한다. 두 계획서는 기존 사용자 작성 파일이며 이번 커밋에 설계 근거·상태 기록으로 명시적으로 포함한다. 계획서의 후속 단계 내용은 계획이며 구현 완료를 뜻하지 않는다. 아래 9개 파일을 개별 검토하고 기존 사용자 내용을 보존한다.

```text
package.json
fixtures/decoder-policy/README.md
fixtures/decoder-policy/registry-selection.json
fixtures/decoder-policy/approve.cases.json
fixtures/decoder-policy/approve.test.mjs
fixtures/decoder-policy/helpers/build-registry.mjs
fixtures/decoder-policy/helpers/wasm-worker.mjs
docs/sdk-migration/decoder-design-plan.md
docs/sdk-migration/decoder-core-adapters-plan.md
```

생성된 WASM·`pkg`·`dist`·`target`·`node_modules`·Registry 생성물·임시 로그는 커밋 대상에서 제외한다. 제안 메시지는 `test(decoder): verify real approve decoding baseline`이다. 이번 문서 정리에서는 스테이징·커밋을 하지 않으며 푸시 명령도 제공하지 않는다.
