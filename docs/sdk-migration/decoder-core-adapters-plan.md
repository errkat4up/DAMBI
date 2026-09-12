# Dambi: Decoder·정책 → Core → Adapters 개발 계획

**DEC-06c·DEC-06 현재 상태:** 구현·정적 검토·사용자 검증 완료. [확정 계약](decoder-design-plan.md#dec-06c--확정-계약과-실행-상태)을 유지하며 실행 근거는 [README 검증 기록](../../fixtures/decoder-policy/README.md#dec-06c--사용자-검증-완료-dec-06-완료) 한 곳을 따른다. 아래 06a/06b 상세는 해당 단계의 기존 기록이다. DEC-07은 구현·정적 검토·사용자 검증 및 Decoder 인계 완료다. SDK 소스 이관은 미착수다.

**2026-09-12 DEC-06b 구현 당시 상태:** 실제 Bundler3 Call[] 연결 **구현·정적 검토 완료, 사용자 실행 대기**다. 요청 43개 + 구조 6개 = **49개**, 기존 514개 포함 통합 **563개 정의**이며 통과 수가 아니다. DEC-06a는 self 48/48·통합 514/514 및 분리 커밋 `9923487`까지 확인했다. 06c는 별도 미구현이며 06b 사용자 검증 후 진행한다.

**2026-09-12 DEC-06a 검증 당시 기록:** 성공 로그 `AsBmk6`에서 **self 48/48·통합 514/514 사용자 재실행 검증 완료**다. 최초 실패 `kJih6u`는 과거 기록으로 보존한다. 실행 당시 HEAD `1326fb5`의 9개 미커밋 경로와 이후 구현 커밋 `9923487`을 구분한다. DEC-05 기록 `56ece47`·06a 구현 `9923487`의 경계와 성공 로그 입력을 확인해 06b 착수 조건을 충족했다. 06b는 이번 별도 변경으로 진행하며 06c는 미구현이다. 06c까지 구현·검증해야 DEC-06 전체 완료다.

**2026-09-12 DEC-05 상태:** Single **85/85·당시 통합 358/358**, Batch **108/108·통합 466/466 사용자 실행 검증 완료**다. DEC-05b 저장 로그를 읽고 입력 44개·JS/WASM·전후 tracked patch를 대조했다. 실제 실행 HEAD `66af65c`의 미커밋 작업 트리와 이후 구현 커밋 `1326fb5`를 구분한다. **DEC-05는 합의한 A안의 기존 v3 연결·진단·교정 설계 범위에서 완료**다. nonce 모델·malformed fallback·uint160/uint48 범위·큰 시간 표현·v4 교정은 기존 후속 항목으로 유지한다. v4는 여전히 USDC EIP-2612만 지원하며 Permit2 v3 연결 성공은 full EIP-712 검증이 아니다. 상세 실행 근거는 [README](../../fixtures/decoder-policy/README.md#dec-05b-사용자-실행-기록--저장-로그-확인)를 따른다.

아래 DEC-01~04의 “현재/이번”·DEC-05 미진행·문서만 변경했다는 설명은 당시 과거 기록이다. DEC-04의 저장 로그·Native 181개·Node 273개 검증 완료 기록과 미제공 항목을 보존한다. 이번에도 읽기·수정·정적 검토만 수행하고 빌드·시험·설치·Git 변경 명령은 실행하지 않는다.

작성일: 2026-09-11. 기준: `main`의 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`.
DEC-02 시작 시 실제 Git 상태는 `feat/decoder`, HEAD `3066f0c` (`test(decoder): verify real approve decoding baseline`), 작업 트리 깨끗함이다. DEC-01 사용자 보고 빌드 대상 HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`이며, **Rust 소스 직접 빌드 후 연결 시험은 사용자 실행 보고 기준 30개 통과**라는 기존 기록을 유지한다. DEC-02 구현은 `26df736`에 커밋됐으며 **사용자 실행 보고 기준으로 통합 37개 통과·D1 검증 완료**다. 실패·취소·건너뛰기·todo는 모두 0이며 에이전트의 독립 재실행 결과는 아니다. **DEC-03도 사용자 실행 보고 기준 검증 완료**다. transfer 개별 21개와 통합 회귀 58개가 모두 통과했으며 두 실행 모두 실패·취소·건너뛰기·todo는 0이다. 04a는 사용자 제공 로그 기준 개별 47/47 통과(`duration_ms=801.277375`), 당시 통합 105/105 통과(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 과거 값으로 채우지 않는다. 04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. DEC-05 이후와 SDK 전체 소스·빌드 독립화는 미완료다.

DEC-03 착수 시 실제 상태는 `feat/decoder`, HEAD `26df736b4d8f0073cfefccf70f68d3b243b016b5`이며 README와 두 계획서의 DEC-02 검증 완료 미커밋 변경 3개를 보존했다. DEC-04 착수 시 실제 브랜치는 `feat/decoder`, HEAD는 `b10271365ce06a944b5672d833545db42b243881`(DEC-03 커밋), 작업 트리는 깨끗했다. 시작 HEAD를 새 시험 실행 HEAD로 사용하지 않는다. 이번 DEC-04 작업에는 사용자 실행 제한이 아래 일반 진행 지침보다 우선한다. 작성자는 코드·시험·문서 작성과 정적 검토까지만 진행하며 빌드·시험·의존성 설치 및 Git add·commit·push·merge·reset·브랜치 변경을 실행하지 않는다. DEC 시험은 내부에서 Registry를 빌드하므로 직접 실행하지 않는다. 기존 사용자 실행 기록, 필요한 경우의 준비·직접 WASM 빌드와 typed permit/통합 시험·04a/04b 분리 커밋 기록과 명시적 문서 커밋 안내는 [README](../../fixtures/decoder-policy/README.md), 사례·한계는 [coverage](../../fixtures/decoder-policy/coverage.md)를 따른다. 04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. DEC-05로 자동 진행하지 않는다.

## 1. 목표와 진행 방식

먼저 디코더가 요청을 정확한 동작(Action)으로 해석하고 정책이 그 동작을 의도대로 평가하는지 확인한다. 다음으로 이를 독립 Core 실행부에 연결한다. 마지막으로 실제 API·RPC 통신을 어댑터로 연결한다.

```text
feat/decoder: 원문 요청 → Decoder → Action → 정책 콘텐츠·manifest 검증
feat/core:    검증된 번들 + 위 경로 → plan → 원본 Fact 검증 → evaluate/check
feat/adapters:                   Policy API / RPC 등 실제 외부 데이터 연결
```

- 한 번에 아래 표의 한 소단계만 진행하고 검증·별도 커밋·결과 보고 후 그 작업을 끝낸다. 뒤 단계를 같은 변경에 섞지 않는다.
- 같은 소단계도 요청 종류, Rust 추출, 정책 이동처럼 독립적인 목적이 있으면 커밋을 더 나눈다.
- 일괄 구현 `b219617`은 백업 브랜치의 참고 자료다. 전체 cherry-pick으로 복구하지 않는다.
- 정책 severity 변경, 지원 범위 축소, 공개 API 변경은 별도 변경점으로 설명한다. 미지원 반환 구현을 기능 지원 완료로 세지 않는다.
- 실제 코드와 데이터가 검증한 범위만 완료로 표시한다. Mock 포트 시험과 실제 API/RPC 연동을 구분한다.
- GitHub push·공개 발행은 실행하지 않는다. main 반영도 별도 통합 작업으로 관리한다.
- 최종 SDK는 배포 패키지뿐 아니라 소스·테스트·빌드·CI도 기존 익스텐션/서버 디렉터리에 의존하지 않아야 한다. 아래 소스 이관 단계와 §7.1의 독립 빌드 검증이 모두 통과해야 SDK 전환 완료로 표시한다.

## 2. 책임과 파일 경계

| 영역 | 책임 | 주로 다룰 경로 |
| --- | --- | --- |
| Decoder | selector·chain·대상 주소·typed-data 매칭, ABI/emit 규칙, Action·오류 결과 | `registryV2/manifests/`, `registryV2/tokens/`, `registryV2/scripts/` |
| 정책 콘텐츠 | Cedar 본문, manifest, 적용 조건·severity·필요 Fact 선언 | 현재 `browser-extension/default-bundles/day1-safety/`; D3에서 공유 원본으로 정리 |
| 검증 사례 | 원문 요청·예상 Action·정책 ID·판정, 오류·경계 사례 | 신규 `fixtures/decoder-policy/` |
| 기존 실행기 | Decoder·정책 정확성 검증에 우선 재사용. 확인된 결함만 좁게 수정 | `crates/policy-engine-wasm/src/declarative_exports.rs`, `action_eval_exports.rs` |
| Core | 신뢰 검증, 순수 Rust 실행기, 계획 고정, Fact 의미 검증, Store/Cache, 최종 판정 | `packages/core/src/`, Core 단계의 신규 `crates/dambi-core/`, `crates/dambi-core-wasm/` |
| Adapters | HTTP/RPC 요청·인증·응답 전달·취소·통신 오류 | Core 단계 후 신규 `packages/core/src/adapters/` |
| API 서버 | 번들 발행·서명, 키 운영, 인증, Registry 동기화, 감사 저장 | 기존 API 담당 트랙 |

정책 **콘텐츠**와 정책 **평가 엔진**을 분리한다. Cedar 실행과 최종 판정은 Core에 남는다. 서명·신선도·필수 Fact·계획 일치 검사도 Core 책임이다. 어댑터가 판단을 대신하거나 서명 검증을 완료했다고 주장하는 구조를 만들지 않는다.

별도 npm 패키지나 저장소는 추가하지 않는다. 어댑터는 같은 SDK의 선택적 모듈로 시작하며, export 경로는 C1에서 정한다. WASM, Cache, 서명 검증, 테스트·CI를 각각 장기 브랜치로 쪼개지 않는다.

### 2.1 최종 SDK 소스 구조와 이관 위치

기존 `browser-extension/`, `crates/policy-server/` 경로는 이관 전 동작 확인에만 일시적으로 사용한다. 완성된 SDK의 소스·빌드 입력으로 남기지 않는다. 폴더 이름 변경만으로 완료하지 않고 import, Cargo 의존 경로, 정적 파일 읽기, 테스트 출력, 생성 스크립트까지 전환한다.

아래는 **구현 예정 위치**다. 디렉터리 이관과 로직 변경은 별도 소단계로 진행하고 기존 Rust crate 이름·직렬화 형식은 우선 유지한다.

| 대상 | 현재 위치 → SDK 소유 위치 | 담당 단계 |
| --- | --- | --- |
| 공통 상태 타입 | `crates/policy-server/asset-model/state/` → `crates/asset-model/state/` | C2-0a. crate 이름 `policy-state` 유지 |
| Action 타입 | `crates/policy-server/asset-model/action/` → `crates/asset-model/action/` | C2-0a. crate 이름 `policy-action` 유지 |
| 순수 상태 계산 로직 | `crates/policy-server/asset-model/transition/` → `crates/asset-model/transition/` | C2-0a. crate 이름 `policy-transition` 및 호환 re-export 유지. SDK에서 필요 없는 계산 모듈은 런타임 의존으로 강제하지 않음 |
| Cedar schema 원본 | `schema/policy-schema/` → `crates/policy-engine/schema/policy-schema/` | C2-0c. 현재도 서버 밖 원본이며, 이번 이동은 Rust 패키지 내부 포함을 위한 작업 |
| 정책 콘텐츠 | `browser-extension/default-bundles/day1-safety/` → `policy-bundles/day1-safety/` | D3. SDK 및 시험은 공유 원본이나 여기서 생성한 파일을 사용 |
| SDK 회귀 시험 데이터 | 확장 dashboard/public 및 서버 seed 중 SDK에 필요한 사례 → `fixtures/sdk/`와 crate별 `tests/fixtures/` | D3·C2c. 배포 crate 시험에 필요한 데이터는 해당 crate 안에 포함 |
| 순수 TS 입력 처리 | 확장 파일의 selector/typed 정규화 등 → `packages/core/src/internal/`의 해당 모듈 | C1·C5. 필요한 함수와 시험만 이관하고 확장 loader/storage는 가져오지 않음 |
| Rust Decoder·평가 실행 | 기존 WASM export 내부 로직 → `crates/dambi-core/src/{decode,runtime}/` | C2a·C2b |
| SDK WASM wrapper | 신규 `crates/dambi-core-wasm/` → `packages/core`가 소비할 WASM/glue | C5. 기존 `policy-engine-wasm/pkg`는 최종 SDK 빌드 입력이 아님 |
| Decoder 정적 입력·생성 | `registryV2`의 승인된 source/token/고정 자료 → D4의 snapshot 생성 입력 및 SDK asset | D4·C5. 확장 기본 bundle 파일에서 역으로 복사하지 않음 |
| SDK 빌드·검증 진입점 | 신규 `scripts/sdk/` | C5·§7.1. 확장 빌드/복사 스크립트를 호출하지 않음 |

공통 코드의 원본은 한 곳에 둔다. 이관 후 과거 경로로 다시 fallback하거나 두 사본을 수동 관리하지 않는다. SDK 소스에 필요한 범위가 늘어나면 입력 목록에 추가하고 이관한다. `browser-extension/` 또는 서버 폴더 전체를 빌드 편의를 위해 포함하지 않는다.

API 서버 구현·운영은 API 담당 영역이다. 공통 crate를 이동한 뒤 API가 이를 의존할 수는 있지만, SDK가 서버의 소스·설정·기동을 요구해서는 안 된다. 기존 애플리케이션 파일의 보관·삭제와 무관하게 SDK 소스 배포물과 필수 빌드 경로에서는 제외한다.

## 3. 현재 코드에서 확인한 출발점

1. `main`에는 이미 root workspace와 `core:typecheck`, `core:build`, scaffold CI가 있다. 이를 새로 만드는 단계는 생략한다.
2. `@dambi/core`는 0.0.1 scaffold이며 `createCore()`는 throw한다. 실제 실행 연결은 Core 단계에서 한다.
3. `registryV2/manifests/standard/erc20/approve@1.0.0.json`은 `tokens:erc20`으로 주소를 확장한다. source manifest를 완성된 decoder bundle로 오인하면 안 된다.
4. `unlimited-approval-deny/policy.cedar`는 실제로 `@severity("warn")`이다. 기존 판정을 먼저 재현하고, 변경할 경우 별도 정책 변경으로 다룬다.
5. 기존 baseline은 이미 만들어진 Action을 평가한다. 새 D1은 원문 calldata부터 디코딩해 그 앞 구간까지 검증한다.
6. `registryV2`의 `check:manifest`는 현재 체크아웃에 없는 `crates/integration-tests` harness에 의존한다. 새 clone에서 재현되는 완료 조건으로 사용하지 않는다.
7. 기존 `policy-rpc.ts`에는 `dambi.evaluate_v3` 서버 평가 경로가 있다. 원본 Fact를 반환하는 SDK 어댑터로 그대로 복사할 수 없다.
8. 루트 `Cargo.toml`은 SDK와 서버 crate를 같은 workspace 구성원으로 둔다. `cargo -p`로 실행 대상만 고르면 서버 폴더가 없어도 된다고 가정할 수 없다. workspace 구성을 실제로 분리해야 한다.
9. 일부 Rust 시험은 확장/서버 seed를 읽고, `est_roundtrip.rs`는 확장 경로에 fixture를 쓰기도 한다. SDK 시험 데이터와 출력 경로를 옮기고 검증 전후에 과거 디렉터리가 없는지 확인해야 한다.
10. `policy-engine/src/schema/mod.rs`는 crate 밖 schema를 `include_str!`로 읽는다. npm 실행과 별개로 Rust 소스 패키지의 파일 포함 범위를 해결해야 한다.

## 4. 1차 작업: feat/decoder

### D1. ERC-20 approve 한 경로의 기준 시험

상세 계획에서 D1을 **DEC-01(approve 디코딩)**과 **DEC-02(소비자 정책 연결)**로 나눈다. DEC-01 구현 및 당시 Rust 소스 재빌드 후 연결 시험은 사용자 실행 보고 기준 30개 통과, 실패·취소·건너뛰기 각 0개다. 소스 → 직접 WASM 빌드 → hash 확인 → 실제 builder·digest·WASM 설치·디코딩 경로를 사용자 보고 기준으로 확인한 기록을 유지한다. DEC-02의 별도 사용자 실행 보고에서는 실제 WASM 빌드 완료와 통합 37개 통과를 확인했으므로 D1의 정책 평가 완료 조건도 충족했다. 새 SDK 실행부나 네트워크 어댑터는 만들지 않는다.

```text
approve calldata
  → 실제 Registry build-index의 토큰 주소 확장
  → index 참조 해소·resolved bundle JCS digest 확인
  → 기존 WASM에 decoder bundle 설치·라우팅
  → Action 및 token/spender/amount 검증 [DEC-01]
  → 기존 plan/evaluate에 실제 Cedar·manifest 전달
  → 적용 정책 ID·severity·판정 검증 [DEC-02, 사용자 실행 보고 기준 검증 완료]
```

DEC-01 구현 파일:

- `fixtures/decoder-policy/README.md`, `registry-selection.json`, `approve.cases.json`, `approve.test.mjs`.
- 최소 helper `fixtures/decoder-policy/helpers/build-registry.mjs`, `wasm-worker.mjs`.
- 루트 `package.json`의 시험 스크립트. DEC-01 검증 당시 `decoder:test`는 `approve.test.mjs`만, DEC-02에서는 기존 두 파일의 37개를 실행했다. DEC-03 변경은 기존 두 파일을 유지하고 transfer를 추가했으며 DEC-04a는 기존 세 파일/58개를 유지하고 typed permit 파일을 추가해 사용자 통합 105개 통과를 확인했다. 04b는 그 네 파일을 유지하며 strict 시험 파일을 추가한다. 기존 개별 명령 `decoder:test:approve`, `decoder:test:approve-policy`도 유지한다. 시험 내부에서 임시 Registry를 실제로 빌드한다.

DEC-01은 실제 `registryV2/manifests/standard/erc20/approve@1.0.0.json`과 선언된 1·10·8453·42161 네 체인의 실제 USDC token 파일을 하나씩 선택한다. 원본 chain 범위를 줄이지 않는다. 임시 Registry와 `BUILD_INDEX_REGISTRY_ROOT`로 **실제 build-index를 `--strict-callkeys`로 실행**하고 실패 시 일부 산출물도 입력으로 사용하지 않는다. 산출물의 chain·주소·selector 범위와 resolved bundle의 JCS digest까지 확인한다. 이는 선택한 token 기준 시험이며 전체 SDK 커버리지는 아니다. DEC-02는 같은 builder와 실제 WASM 디코딩 경로를 재사용해 Day-1 정책 하나를 연결한다. CI 개편은 이번에 포함하지 않는다.

DEC-02 코드 작성 범위:

- 신규 `fixtures/decoder-policy/approve-policy.test.mjs`에서 실제 `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/policy.cedar`와 같은 디렉터리의 `manifest.json`을 읽는다. 기존 `helpers/wasm-worker.mjs`에 선택적 `scenario.policyBundle` 경로만 추가하며 신규 helper를 만들지 않는다. DEC-01 입력과 `{ installations, results: [{ id, result }] }` 출력 계약 및 기존 30개 검사는 유지한다.
- 실제 디코딩 결과의 `Action.body`와 `Action.meta`를 기존 `plan_action_rpc_v2_json`·`evaluate_action_v2_json`에 그대로 전달한다. `tx`는 원래 요청에서 `chain_id: eip155:<chain_id>`, `from: submitter`, `to: token contract`로 구성한다. token/spender/amount를 재구성하거나 DEC-01 expected Action을 평가 입력으로 사용하지 않는다.
- planner에는 실제 manifest를 전달하고 정상 응답·`planned: []`를 검사한다. evaluator에는 `bundles: [{ policy, manifest }]`, `results: {}`를 전달한다. 실제 `pass/warn/fail` DTO 전체를 비교하며 warn 사례에서 `unlimited-approval-deny` 정책 ID·severity `warn`을 확인하고 `__engine::*`, quarantine, `__system__` 오류 판정을 배제한다.
- 추가한 사례는 승인량 `0`·일반 승인량·`2^256-2`의 일반 spender `pass`, `2^160-1`·`2^256-1`의 일반 spender `warn`, 두 MAX 수량의 정책상 Permit2 spender `pass`로 총 7개다. Permit2 주소는 정책 원문과 대조하고 기존 calldata의 spender word를 바꿔 실제 디코더를 다시 통과시킨다. 기대값은 독립적인 입력 분석과 정책 원문에 근거하며 실제 결과를 자동 저장하지 않는다.
- 기존 정책 본문·manifest·severity 및 Rust 실행부는 변경하지 않는다. 확장 경로 정책은 **D3 이관 전 기준 시험의 임시 입력**이며 D3에서 공유 원본으로 전환한다. Core 공개 API, `createCore`, 외부 Fact/API/RPC·서명 검증, 디렉터리 이관과 SDK 독립 빌드는 이번 범위에 포함하지 않는다.

**사용자 실행 결과는 DEC-01 회귀 30개와 DEC-02 정책 7개, 합계 37개 통과**이며 실패·취소·건너뛰기·todo는 모두 0이다. `planned: []`, 빈 Fact 평가, 정확한 정책 ID·severity `warn`·origin `action` 검사를 포함한다. 실제 Rust WASM 컴파일·최적화·`pkg` 생성 완료와 현재 JS/WASM SHA-256의 실행 로그 일치도 사용자 보고로 확인했다. DEC-02와 D1은 사용자 실행 보고 기준 검증 완료이며 자세한 근거와 미제공 세부값은 [README](../../fixtures/decoder-policy/README.md)에 기록한다. 향후 회귀 시험에서 기대와 다르면 정책·Rust 실행부로 범위를 넓히지 않고 관련 파일·최소 입력·코드상 동작·차이·선택지·영향·권장안을 제시한다.

우선 Node 내장 `node:test`와 기존 WASM 초기화 방식을 사용해 새 테스트 프레임워크 도입을 피한다. 필요한 WASM은 crate를 직접 빌드한다. `scripts/wasm-build.sh`는 extension 경로에 복사하는 부수 동작이 있으므로 신규 시험의 필수 경로로 두지 않는다.

완료 조건:

- 승인량 0·일반 수량, MAX 승인, 허용 spender의 예외가 현재 정책대로 평가된다.
- `uint256::MAX`, `uint160::MAX`, MAX 바로 아래 값의 차이를 실제 정책 기준으로 검증한다.
- 정상 형식이지만 해당 approve decoder의 등록 조합 `(chain, to, selector)`에 포함되지 않는 요청이 이 decoder로 해석되지 않는지 확인한다. 이는 **디코더 매칭 범위** 시험이며 주소·체인이 위험하거나 잘못되었다는 판정이 아니다.
- 기존 주소 파서가 거절하는 문자열, 비정상 hex, ABI 인자가 부족한 calldata는 **입력 형식/디코딩 오류** 사례로 구분한다. 새로운 주소 안전성 기준을 추가하지 않는다.
- 매칭 실패, malformed, 정상 디코딩을 시험 결과에서 구분한다. SDK가 아직 없는 단계에서 최종 deny 처리를 구현했다고 주장하지 않는다.
- WASM을 mock하지 않으며 브라우저 확장을 실행하지 않는다. 새 clone에서 준비·실행 명령으로 재현된다.

주소·체인에 대한 세 가지 질문을 혼동하지 않는다.

| 질문 | D1에서 확인하는 내용 |
| --- | --- |
| 입력을 파싱할 수 있는가? | 기존 주소/수치/hex/ABI parser의 형식 검사. 예: `not-an-address`는 기존 `invalid_input_json` 사례 |
| 이 decoder가 처리할 조합인가? | 설치한 approve manifest의 chain·to·selector 매칭. 조합이 없으면 기존 `no_declarative_v3_mapper` 결과 확인 |
| 이 주소나 동작이 위험한가? | 별도 정책·Fact의 판단 영역. 미등록 주소·체인을 위험하다고 추론하지 않음 |

일반적인 악성 주소 목록, 실제 체인의 존재 여부, 계약 배포 여부, 사용자가 의도한 네트워크인지의 확인은 D1에 추가하지 않는다. 다른 decoder에는 주소 비종속 매칭도 있으므로 `(chain, to, selector)` 규칙을 모든 decoder에 강제하지 않는다. 각 manifest가 이미 선언한 매칭 방식을 기준으로 검증한다.

### D2. 디코더 계약과 요청 종류별 커버리지

**DEC-03 기록: 사용자 실행 보고 기준 검증 완료.** 신규 `transfer.cases.json`, `transfer.test.mjs`, `coverage.md`와 selection/helper·npm 시험 명령·README·두 계획서를 작성 또는 수정했다. 실제 transfer source `standard/erc20/transfer@1.0.0` (`0xa9059cbb`)를 approve와 같은 strict builder → index·resolved bundle JCS digest → 실제 WASM 설치 → 원문 calldata → decoder ID·Action 경로에 연결하고 사용자 실행으로 검증했다. 기존 approve/token 경로·바이트 hash와 네 체인 `1/10/8453/42161` 범위를 보존하고 transfer 원본 바이트 hash만 추가한다.

`buildRegistry(selection)`은 기존 approve 전용 동작과 `{ root, source, tokens, cleanup }` 반환을 유지한다. DEC-03에서만 `{ includeTransfer: true }`를 전달해 transfer 원본을 함께 복사하고 `transferSource`를 반환한다. 기존 DEC-01은 정확히 4개 callkey를 계속 요구하고 DEC-03은 정확히 8개 callkey와 selector별 bundle ID·JCS digest, 주소 확장을 제외한 원본 필드 보존을 검사한다. 실패 시 임시 산출물 폐기와 실제 `--strict-callkeys` 경로는 유지한다. DEC-03 당시에는 기존 approve fixture·두 시험 파일·다중 bundle 설치 WASM worker를 수정하지 않았다.

작성한 요청은 정상 7개와 오류 11개다. 네 체인의 0·일반 `1,000,000`·`2^256-1`, token/recipient/submitter 대소문자 정규화, zero recipient, 1바이트·32바이트 trailing 허용을 포함한다. 정상 형식의 미등록 조합과 calldata hex 오류, 필수 selector 누락·잘못된 calldata 타입, selector-only·잘린 ABI word, 등록 approve/transfer 조회 selector와 calldata selector의 양방향 불일치를 구분한다. token contract·recipient·submitter를 서로 다르게 두고 실제 Rust의 body/meta, `spender` 부재, `is_router_egress: false` 기본값 생략, `BigInt`·U256 문자열을 비교한다. gas price의 Pyth source는 실제 외부 조회가 아닌 기존 stub이다.

구조 검사 3개는 실제 두 source와 8개 callkey·digest, 고정 calldata word의 독립 검산, 같은 WASM 프로세스의 transfer/approve 교대 요청과 별도 approve-only 프로세스의 transfer miss다. **사용자 실행으로 DEC-03 21개와 통합 58개(기존 37 + 21)가 모두 통과**했다. 정확한 case ID와 기존 DEC-01의 공통 오류·DEC-02 정책 검사를 유지한 범위는 [coverage](../../fixtures/decoder-policy/coverage.md)를 따른다.

| 사용자 실행 명령 | tests / pass | suites / fail / cancelled / skipped / todo | duration_ms |
| --- | --- | --- | --- |
| `npm run decoder:test:transfer` | 21 / 21 | 0 / 0 / 0 / 0 / 0 | 866.922333 |
| `npm run decoder:test` | 58 / 58 | 0 / 0 / 0 / 0 / 0 | 635.086875 |

approve·transfer 공동 설치와 selector별 decoder ID·Action, 8개 callkey·JCS digest, 프로세스 격리 및 기존 37개 회귀가 통과해 DEC-03 완료 조건을 충족했다. 에이전트가 독립 재실행한 결과는 아니다. 이번 실행의 HEAD·시각·도구 버전·산출물 hash·재빌드 로그는 미제공이며 착수 HEAD나 이전 단계 기록으로 채우지 않는다. 이 세부 기록의 미제공은 DEC-03 검증 완료를 막지 않으며 이를 채우기 위한 재빌드·재시험은 요구하지 않는다.

selector 문자열의 길이·hex가 현재 DTO에서 검증되지 않아 malformed가 lookup miss로 처리될 수 있다는 정적 한계를 문서화했다. 정상 미지원이나 실행으로 재현한 결함으로 표현하지 않는다. 이번 runtime 수정은 필요하지 않으며, 형식 검증을 도입하려면 오류 우선순위·빈 calldata native 분기·기존 호출자와 기대값 영향을 먼저 사용자에게 제시한다. 실제 raw JSON 문법 오류는 worker의 `JSON.stringify` 경로 때문에 이 fixture에서 직접 검증하지 않는다. transfer 정책 평가, typed permit, multicall, Core 공개 API, API/RPC, 서명 검증, 소스 이관, CI 개편은 DEC-03 당시 범위 밖이었다. 아래 D2 전체 완료 조건은 DEC-03 검증 완료만으로 충족되지 않는다.

- `registryV2`와 신규 `fixtures/decoder-policy/coverage.md`에 지원 chain·contract·selector·typed-data·하위 동작을 기록한다.
- Action은 기존 Rust `ActionBody` 구조를 기준으로 한다. 새 독립 IR을 동시에 만들지 않는다.
- 기존 `requires.adapter_capabilities`·`host_capabilities`·extension 호환 메타데이터가 실제로 요구하는 기능을 구분한다. SDK 지원 여부를 Chrome 확장 설치 여부나 확장 버전으로 판단하지 않도록 계약을 정리한다.
- 수량 정밀도, 주소 정규화, chain 표현, decode 상태·오류 코드를 정리한다. Fact 계획에 필요한 값이 손실되지 않는지 검사한다.
- approve 다음 transfer, typed permit, multicall을 **각각 별도 변경**으로 검증한다. 알려진 요청의 필수 필드 누락, typed-data schema 불일치, unknown multicall leg를 포함한다.
- `untyped_signature`, `venue_order`도 지원 현황과 추가 요구사항을 조사한다. 구현 필요 항목을 후속 단계에 남길 때 명시하며, 임의로 v0.1 지원 범위에서 삭제하지 않는다.

완료 조건: 선언된 커버리지마다 정상·경계·오류 사례가 있고, 미검증 항목과 실행 가능한 항목이 구분된다. 단순 unknown 반환을 해당 요청 지원으로 세지 않는다.

#### DEC-04a / DEC-04b — EIP-2612 기준선과 전체 typed 계약의 분리

04a는 사용자 제공 로그 기준 개별 47/47 통과(`duration_ms=801.277375`), 당시 통합 105/105 통과(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 과거 값으로 채우지 않는다. 04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다.

| 단계 | 작성·실행 상태 |
| --- | --- |
| 04a | 실제 `standard/erc20/permit@1.0.0` source → strict Registry → typed index/JCS → 실제 v3 WASM → Action/meta/error 연결. 47/47 및 당시 통합 105/105 사용자 통과 |
| 04b | 별도 v4 full-input DTO/export·순수 validator·실제 emit·shared Rust/Node 회귀 작성. Native 181개·새 WASM 빌드·Node strict 168개/기존 typed 47개/통합 273개 사용자 통과 |
| DEC-04 / D2 전체 | **DEC-04 검증 완료.** D2 전체는 다른 decoder 단계가 남아 미완료 |

실제 원본은 chain 1, mainnet USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, selector `0xd505accf`, primary type `Permit`, name `USD Coin`이다. source 바이트 SHA-256 `0x9e7337ae3ce7e1a80851652e39b2ac4fb264b5e8caf00a4c93193c6b93c76eb3`과 resolved JCS digest를 구분한다. 네 체인으로 확장하지 않는다. helper의 approve-only 4 callkey/typed 없음, approve+transfer 8 callkey/typed 없음·기존 반환 계약을 보존한다. approve+permit 선택은 5 callkey/1 typed/0 selector이며 04a 사용자 실행에서 검사했다. typed index에서 해소한 실제 inline bundle을 설치하며 permit calldata 성공으로 typed 검증을 대신하지 않는다.

worker 기본/transaction·선택적 정책 평가·typed v3 동작을 유지하고 `typed_strict`만 v4 export로 보낸다. 설치 상태는 별도 Node 프로세스로 분리하며 Chrome runtime import·JS decoder·WASM mock·자동 v3 재시도는 없다.

합의한 계약은 다음과 같이 구현했다.

- 기존 v3 축약 DTO·확장 소비자를 유지하고 별도 `declarative_route_typed_data_v4_json`에 `typed_data` object/JSON string, `requested_signer`, 선택 `submitter`/`routing`, 필수 `submitted_at`을 받는다.
- `request.original`은 전체 요청 원문과 필드 생략, `request.routing`은 정규화 조회값, `request.validated`는 정규화 주소와 signed_nonce/deadline_seconds decimal 문자열이다. JSON string 원문은 original.typed_data_json에 별도 보존하며 입력에서는 해당 보조 필드명을 예약한다. submitter 생략 시 requested_signer를 사용한다.
- requested_signer는 요청된 서명 대상 지갑이다. 정규화 owner 일치는 요청 일관성 조건이며 다른 submitter의 대리 제출을 허용한다. 성공에도 `request.validation.signature_verification: "not_performed"`를 표시한다.
- 기본 형식·routing/domain 충돌 → lookup → 지원 manifest의 types/domain/message → owner/requested_signer 일관성·deadline 표현 → emit 순서를 지킨다. 미등록 contract+malformed owner는 `no_typed_data_mapper`가 우선이다. 다른 설치 typed bundle에 정확히 매칭되면 `unsupported_typed_data_contract`다. 두 결과는 상세 검증 미수행이며 검증 성공이 아니다.
- 선언 name/chain/contract/types, 필드 배열 순서와 reachable graph를 대조한다. JSON 객체 키 순서는 무관하다. owner/spender 주소, value/nonce/deadline의 필수 uint256 형식·범위를 검사하고 선언 밖 message/domain 필드를 거절한다. version 문자열·salt bytes32를 보존·형식 검사하며 manifest에 없는 정답을 추가하지 않는다. 선택적 EIP712Domain 선언은 실제 domain 필드·타입과 일치해야 한다.
- raw uint256 deadline을 보존하고 strict는 `0..9007199254740991`만 기존 Time/Action/meta에 투영한다. 초과는 `typed_deadline_out_of_range`다. submitted_at도 같은 안전 범위의 정수 JSON number로 제한한다. 직접 JSON의 소수점/지수 number 표기를 정수로 반올림하지 않고 거절한다. 공통 Time와 mapper는 바꾸지 않는다.

04a의 owner/nonce/domain_name 검증 공백은 legacy observation 통과 기록이며 올바른 전체 EIP-712 입력 계약이 아니다. signed nonce와 Action nonce LiveField(value `0x0`, `nonces(address)`/`erc20_permit_nonce`, TTL 12, synced_at=제출 시각)는 구분한다. 후자는 실제 체인 조회 결과가 아니다. v3에서 deadline `"18446744073709551616"`의 body 포화/meta 0 차이는 정적 분석이며 실행 재현하지 않았다. strict는 안전 범위를 벗어난 값을 emit 이전에 거절하고 body/meta deadline 일치도 확인한다.

04b 변경 파일은 WASM `src/{dto,declarative_exports,lib,typed_data_validation}.rs`, 신규 `tests/declarative_v3_typed_data_strict.rs`, strict Node cases/test·worker·npm 명령과 네 문서다. Node strict 요청 163개+구조 5개=168개, 기존 105개를 보존한 통합 정의 273개를 작성했고 저장된 사용자 로그에서 각각 168/168·273/273 통과했다. Native는 같은 fixture와 raw JSON·다른 설치 계약·내부 emit 결함·v3 호환 회귀를 검사한다. 오류 코드·입출력 예시는 [상세 계획](decoder-design-plan.md#dec-04--eip-2612와-typed-입력-계약--전체-계획-d2)을 따른다.

04b 정적 검토: 수정/관련 JS 4개 `node --check`, 설치된 Rust formatter의 새 코드 형식·5개 Rust 파일 구문 확인, 문서 shell 블록 8개 `bash -n`, JSON·고정 수량·주소·원본 7개 hash 대조, 기존 v3 함수의 바이트 동일성 및 04a patch 경계를 확인했다. `git diff --check`와 신규 파일 공백 검사도 문제없다. 이는 구현 당시 에이전트의 정적 검토 기록이다. 에이전트는 Rust 컴파일·Registry/WASM/Node 시험을 직접 실행하지 않았으며, 후속 사용자 실행 로그의 성공은 아래 별도 기록으로 확인했다.

미응답 계약 질문은 없다. 사용자 Native 회귀 → 새 WASM 직접 빌드 → strict 개별·기존 typed 개별·전체 Node 시험의 성공을 저장 로그로 확인했다. 04a `593ea16`과 04b `e487805`로 분리 커밋됐고 생성물은 제외했다. 이번 검증 결과는 네 문서에 함께 반영했다. DEC-05, selector 개선, Permit2/multicall/Core/API/RPC, 정책·서명 검증, 소스 이관·CI로 확대하지 않는다.

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



#### DEC-05a / DEC-05b — Permit2 기존 v3 연결과 계약 교정 범위

**DEC-05b 저장 로그 확인:** `/private/tmp/dambi-dec05b-verify.WCHZDj/`에서 Batch **108/108 통과**(`duration_ms=817.124708`), 기존 DEC-01~04의 273개와 Single 85개를 포함한 통합 **466/466 통과**(`duration_ms=1198.186625`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. 실제 실행 전후 HEAD는 `66af65c6bbe0adb6f8fbb9941aac729ec330b801`이며 Batch 관련 9개 미커밋 경로를 포함한 작업 트리다. 이후 구현 커밋 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`와 DEC-06a 편집 전 파일을 읽기 전용으로 대조하여 입력 **44개 모두 Git blob 및 당시 현재 파일과 일치**함을 확인했다. 실행 후 입력 44개와 JS/WASM 2개 검사도 모두 OK이며 전후 tracked patch·Git 상태·HEAD가 동일하다. Node v25.9.0/npm 11.12.1, UTC Batch `2026-09-12T07:10:27Z–07:10:28Z`, 통합 `07:10:28Z–07:10:30Z`, verification/input hash/artifact hash exit는 모두 0이다. 실제 Batch resolved JCS digest는 `0x161755caa54753a0064c023990f6af3a9698e45b74b414db1bb3a8946f45c0d5`다. 현재 JS/WASM hash는 검증된 DEC-04·Single의 동일 쌍과 일치한다. **DEC-05는 A안의 기존 v3 연결·진단·교정 설계 범위에서 검증 완료**이며 nonce·입력 범위/형식·시간·v4 런타임 교정은 기존 후속 항목이다. 실행 HEAD를 이후 구현 커밋으로 바꾸지 않으며 기록 갱신을 위해 빌드·시험을 재실행하지 않았다.

**DEC-05a 저장 로그 확인:** `/private/tmp/dambi-dec05a-verify.JPtwLZ/`에서 Single **85/85 통과**(`duration_ms=728.833416`), 당시 통합 **358/358 통과**(`duration_ms=1055.562083`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. 실제 실행 HEAD는 전후 `60bb3d561b889594ce5837088d74f072de4fd6a2`이며 9개 미커밋 경로가 있던 worktree다. 이후 사용자 커밋 `66af65c6bbe0adb6f8fbb9941aac729ec330b801`과 **Batch 편집 전** 파일을 대조하여 로그 입력 41개가 모두 현재 파일·Git blob에 일치함을 확인했다. 전후 tracked patch도 바이트 동일하고 입력 41개·산출물 2개 사후 검사는 모두 OK다. Node v25.9.0/npm 11.12.1, UTC Single `2026-09-12T06:46:09Z–06:46:10Z`, 통합 `06:46:10Z–06:46:11Z`, verification/input hash/artifact hash exit는 모두 0이다. DEC-04의 같은 JS/WASM 쌍을 재빌드 없이 사용했고 현재 산출물 hash도 일치한다. 실행 HEAD와 이후 구현 커밋을 구분한다. 에이전트 재실행이 아니며 full EIP-712·서명·외부 nonce 검증이나 A안에서 별도로 남긴 계약 교정의 완료가 아니다. 상세 로그·hash는 [README](../../fixtures/decoder-policy/README.md#dec-05a-사용자-실행-기록--저장-로그-확인)에 기록했다.

| 단계 | 코드 작성·정적 검토 | 사용자 실행 검증·현재 범위 |
| --- | --- | --- |
| DEC-05a Single | 코드 작성·정적 검토·사용자 실행 검증 완료. 사용자 구현 커밋 `66af65c` | 저장 로그에서 **85/85·당시 통합 358/358 통과**. 실제 실행 HEAD `60bb3d5`와 이후 커밋 구분 |
| DEC-05b Batch | 코드 작성·정적 검토·사용자 실행 검증 완료. 이후 구현 커밋 `1326fb5` | 저장 로그 **108/108·통합 466/466 통과**. 실제 실행 HEAD `66af65c`와 이후 커밋 구분. DEC-05 A안 범위 완료 |
| 계약 교정 | 사용자 요청에 따라 이번 단계에서 [교정안 A/B/C](decoder-design-plan.md#dec-05-계약-교정안-a안-확정bc-미구현-제안) 구체화 | **A baseline+설계 확정**. B v4 입력 검증, C allowance Action/소비자 교정은 별도 범위의 미구현 제안 |

Single 원본은 [`registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json), Batch는 [`permitBatch@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitBatch@1.0.0.json)이다. 두 파일 모두 체인 `1/10/8453/42161`의 concrete Permit2 주소를 직접 선언하고 USDC token 목록을 통한 확장 대상이 아니다. 기존 Rust synthetic Single/Batch는 schema·ID·체인/types·emit이 다르며 `ON_DISK` Batch JSON literal도 현재 원본과 달리 named emit·nonce 누락이다. 새 연결 시험은 실제 파일을 사용한다. 상세 대응표는 [상세 계획 DEC-05](decoder-design-plan.md#dec-05--permit2-single--batch--전체-계획-d2)에 기록했다.

`buildRegistry(selection, { includePermit: true, includePermit2Single: true })`는 approve+USDC+Single을 빌드한다. 정확히 callkey 9개·typed index 5개·selector index 0개, 네 체인 typed 참조와 원본/JCS digest를 검사한 뒤 실제 WASM에 설치한다. 기본 approve 호출·다른 기존 선택·반환 구조·hash 검증·실패 정리를 보존하고 Single 선택에만 `permit2SingleSource`를 더했다. Rust의 기존 named object→ABI components 순서 positional 변환과 worker typed export를 재사용하며 decoder를 mock하거나 JS로 재작성하지 않는다.

Single 정상 객체의 details token/amount/expiration/nonce·공통 spender/sigDeadline, verifying contract와 underlying token·submitter의 분리, key 재배열, EIP-2612 flat 회귀를 작성했다. message owner를 추가하지 않는다. 79개 요청 분류는 normal 19, routing_miss 6, input_error 12, emit_error 26, legacy_diagnostic 14, compatibility 2다. `uint160/uint48`의 선언 MAX+1, nonce 누락/null/파싱 실패, 큰 sigDeadline과 내부 배열 호환은 정상 계약 검증과 분리한다. BigInt·decimal string으로 경계를 독립 검산하며 JS Number로 손실된 기대값을 만들지 않는다.

현재 signed nonce `513`은 `["0x2",1]`로 분해되고 source `nonceBitmap(address,uint256)`·`permit2_nonce_bitmap`, ttl 12, synced_at=submitted_at과 함께 나온다. 값은 체인 조회 결과나 zero stub이 아니다. AllowanceTransfer의 owner/token/spender별 순차 uint48 nonce와 SignatureTransfer의 unordered bitmap은 다른 의미다. [AllowanceTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer), [SignatureTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer).

정적 분석상 nonce malformed는 zero fallback, v3는 선언 uint160/uint48 폭 미검사, 큰 sigDeadline은 body u64 포화/meta 0 또는 JSON→JS 정밀도 손실이 가능하다. nonce 모델 변경은 Action·sync args·transition 소비에 영향을 주고 malformed/범위/시간 거절은 기존 v3 성공을 오류로 바꾼다. 사용자는 교정안 구체화 후 **A — 연결 시험·교정 설계만 마무리**를 선택했다. 이번 범위의 미응답 질문은 없으며 런타임 교정은 별도 범위로 남긴다. B/C의 입력/출력 계약 변경은 아직 구현하거나 승인한 것이 아니다. 구체 최소 입력·현재 동작·차이·수정 범위·소비자 영향은 [coverage](../../fixtures/decoder-policy/coverage.md#dec-05a--작성한-검사와-미결-계약)와 상세 계획을 따른다. v4 strict는 현재 USDC EIP-2612만 지원하고 Permit2 허용 ID 추가·v3 fallback은 적용하지 않는다.

Batch는 별도 `permit2-batch.cases.json`/`.test.mjs`와 `includePermit2Batch: false` 기본값·명시 선택 때만 `permit2BatchSource` 반환을 작성했다. `buildRegistry(selection, { includePermit2Single: true, includePermit2Batch: true })`로 **approve+Single+Batch**를 선택하여 callkey 12·typed 8·selector 0개를 요구한다. 네 체인 typed/callkey 참조·JCS digest·실제 WASM 설치와 v3 요청을 연결한다. USDC permit은 이 조합에 포함하지 않고 기존 Single 시험의 조합과 기대값은 유지한다. 원본 Batch SHA-256은 `0x0343bc44659b2b1e7e184a39e7e17acd642ec52f2776adca963df4d8d3bd35ee`다.

작성 범위는 서로 다른 token/amount/expiration/nonce·순서/역순/중복 유지, 공통 spender/sigDeadline, 첫째/둘째 필수 필드 누락/null/불량, empty/비배열/64·65개, 동일 WASM Single/Batch primary type 구분이다. 최상위 Action 하나와 외부 meta 하나 아래 Multicall의 자식 ActionBody 구조를 검사한다. empty는 Unknown이며 65개는 명시적 `build_array_emit_failed` 전체 오류다. child 오류도 `data:null`인 전체 실패이며 정상 child만 남기거나 65번째 이후를 조용히 자르지 않는다. nonce 누락의 zero fallback·폭/시간은 별도 기존 한계 진단이며 A안의 교정을 이번에 구현하지 않는다. 현행 한도 오류를 관찰하므로 새 한도 계약 결정이 필요하지 않다.

Batch의 **코드 작성·정적 검토·사용자 실행 검증 완료**다. 요청은 normal 25, legacy_diagnostic 22, limit_boundary 1, limit_error 3, empty_observation 1, emit_error 37, input_error 8, routing_miss 5로 102개이며 구조 6개 포함 **108/108·통합 466/466 통과**를 저장 로그에서 확인했다. v4는 여전히 USDC만 지원하며 nonce·범위/형식·시간·v4 교정은 별도 후속 범위다. [README](../../fixtures/decoder-policy/README.md#dec-05b-사용자-실행-기록--저장-로그-확인)에 검증된 JS/WASM 재사용과 실제 실행 기록을 보존한다. 완료 기록을 위한 재빌드·재시험은 필요하지 않다. 상세 오류·coverage는 [Batch 기록](../../fixtures/decoder-policy/coverage.md#dec-05b--작성한-검사와-미결-계약)을 따른다. **DEC-05 A안 범위는 완료이며 D2 전체는 미완료**다.

#### DEC-06 — self 연결과 후속 Call[]·진단/한도

**DEC-06a self — 사용자 재실행 검증·분리 커밋 완료.** 실제 `registryV2/manifests/uniswap/v3-nfpm/{multicall,mint,refundETH}@1.0.0.json`을 선택하는 [`multicall-self.cases.json`](../../fixtures/decoder-policy/multicall-self.cases.json)·[`.test.mjs`](../../fixtures/decoder-policy/multicall-self.test.mjs)을 작성했다. 고정 요청 **43개 + 구조 5개 = 48/48 통과**, 기존 일곱 파일의 466개를 포함한 통합 **514/514 통과**를 성공 로그에서 확인했다. 에이전트는 소스 읽기·수정·정적 검토만 했고 Registry/Native/WASM/Node 빌드·시험·설치·Git 변경 명령을 실행하지 않았다.

**사용자 재실행 검증 완료:** `/private/tmp/dambi-dec06a-verify.AsBmk6/`에서 self **48/48 통과**(`duration_ms=860.220167`), 기존 466개를 포함한 통합 **514/514 통과**(`duration_ms=1337.026125`)를 확인했다. 두 실행 모두 suites/fail/cancelled/skipped/todo는 0이다. self는 UTC `2026-09-12T07:53:21Z–07:53:22Z`, 통합은 `07:53:22Z–07:53:24Z`이며 command/tee/hash/inventory/Git/final exit 모두 0이다. 실행 전후 HEAD는 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`, branch는 `feat/decoder`이고 **06a 관련 9개 미커밋 경로를 포함한 작업 트리**에서 실행했다. 이번 완료 기록 편집 전에 입력 **1356개 모두 현재 파일과 일치**, JS/WASM 2개 hash도 일치함을 확인했다. 입력·산출물·HEAD/branch/status·tracked/staged patch는 실행 전후 및 편집 전 작업 트리와 동일하다. 최초 실패 `kJih6u`는 아래 과거 기록으로 보존하며 성공 결과로 덮어쓰지 않는다. 에이전트가 빌드·시험을 재실행한 결과가 아니다.

**커밋 경계 확인 완료:** 사용자 커밋은 `1326fb5` → DEC-05 기록 `56ece474961ca72cea014b17e0060ad180a4b53a` → DEC-06a 구현·검증 기록 `99234877c8b72e1ea96cd8597e45e9c0e716d66d` 순서다. 첫 커밋은 네 문서만, 두 번째는 06a 관련 정확한 아홉 경로만 포함한다. DEC-05 기록 전용 patch를 `1326fb5` 원문에 메모리에서 적용한 네 결과가 `56ece47` Git blob과 바이트 동일함을 읽기 전용으로 확인했다. 성공 로그 `AsBmk6`의 **06a 구현 다섯 파일**(fixture·test·selection·helper·package)의 SHA-256도 `9923487` blob과 모두 일치한다. **06a 실제 실행 HEAD는 `1326fb5`의 미커밋 작업 트리이며 이후 구현 커밋은 `9923487`**이다. 06b 착수 전에 `feat/decoder`, HEAD `9923487`, 깨끗한 작업 트리·빈 index를 확인했으므로 커밋 선행 조건을 충족했다. 과거 DEC-05/06a 커밋 절차는 이미 완료해 다시 실행하지 않는다. 기록 확인을 위한 재빌드·재시험은 필요 없다.

**첫 사용자 실행 실패와 수정:** `/private/tmp/dambi-dec06a-verify.kJih6u/`의 self 결과는 **tests 48 / pass 0 / fail 48**, suites/cancelled/skipped/todo 모두 0, `duration_ms=659.926875`다. 모든 index를 `3-ref`로 가정한 공통 before hook(당시 `multicall-self.test.mjs:93`)에서 NFPM inline의 실제 `schema_version=undefined`와 기대 `"3-ref"`가 불일치했다. 최초 정적 검토에서 놓친 시험의 형식 가정이며 48개의 개별 ABI/Action 실패로 해석하지 않는다. 임시 Registry 빌드 후 index 검사에서 중단되어 실제 WASM 설치·route 요청은 시작하지 않았고, self exit 1로 통합도 미실행(`integrated.log` 없음)이다. 실행 전후 HEAD는 `1326fb5ac0c61e9552d952b748a3d09c2b236b35`, branch는 `feat/decoder`, 관련 9개 미커밋 경로가 있었고 입력 1356개·JS/WASM·tracked/staged patch·HEAD/status가 전후 동일하다. 사후 입력 1356개 모두 OK이며 final/command exit=1, hash/inventory/Git record exit=0이다. 전체 UTC `2026-09-12T07:45:32Z–07:45:34Z`, self `07:45:33Z–07:45:34Z`다. Rust/빌드 입력 1279개는 검증된 `e487805`와 같고 현재 JS/WASM hash도 기록과 일치한다. 상세 도구·수정 전 파일 대응은 [README](../../fixtures/decoder-policy/README.md#dec-06a-첫-사용자-실행--공통-준비-훅-실패와-수정)에 보존한다.

**수정한 index 계약:** approve sourced callkey **4개는 `3-ref`**, NFPM concrete callkey **12개는 `schema_version`·`bundle_ref` 없이 `bundle`을 직접 담은 inline**이다. 별도 `bundles/` 파일은 approve **1개**이며 서로 다른 해석 bundle 객체·JCS digest **4개**와 구분한다. 실제 builder의 두 경로에 맞춰 exact key·형식·참조/원본·JCS 검사를 수정했다. 기대 Action·fixture·43요청+5구조=48개 및 통합514개 정의는 유지한다. **사용자 재실행 검증 완료**이며 기존 실패 기록과 DEC-05 기록 전용 patch를 보존한다. 같은 JS/WASM 쌍으로 self 48/48·통합 514/514가 통과했다. 완료 기록 갱신을 위한 재실행은 필요 없으며 실제 06a 커밋 `9923487`을 확인해 06b를 별도 변경으로 진행한다.

`buildRegistry(selection, { includeNfpmSelf: true })`는 기존 approve와 NFPM 세 원본을 선택한다. 원본 hash 검증 → 임시 strict Registry → 정확한 **callkey 16·typed 0·selector 0** 및 네 bundle의 고정 JCS digest → 실제 WASM 설치 → worker의 기존 transaction route를 연결했다. 기본 false인 선택 옵션과 해당 경우의 NFPM source 반환만 더하고 기존 기본값·반환·정리 동작을 유지한다. 세 원본의 세 체인 `1/10/42161` 공통 주소 `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`와 Base `8453` 주소 `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`을 그대로 유지한다. USDC token 목록은 approve 확장용이며 NFPM 주소 확장에 쓰지 않는다.

작성 범위는 mint/refundETH 직접 호출과 self 단독/조합, 순서·반복·작은 중첩 깊이 2/3/4·트리 구조, 알려진+미등록 selector·전부 미등록, 하위 bundle 설치/미설치, 빈 배열·4바이트 미만 child·등록된 mint의 잘린 ABI·외부 bytes[] offset/count/length/절단, 64/65, 정상 ABI 뒤 추가 바이트 허용, 같은 프로세스에서 정상/실패/미지원 교대다. self의 target은 부모 NFPM이고 일반 ERC-20 approve calldata는 미지원 Unknown으로 보존하는 현행 경로를 검사한다. 정상 전체 Action/meta는 원본·Rust 직렬화와 고정 ABI word/offset/length/padding·수량/signed tick의 독립 검산으로 작성했으며 WASM 실제 출력에서 기대값을 생성하지 않는다. 구조 5개는 index/JCS·mint ABI·bytes[]/변형 검산·설치 조합·교대 요청이다.

mint는 `amm/add_liquidity`·`params.kind=concentrated_mint`다. token pair·desired/min·signed tick·recipient와 원본 fee `3000`이 그대로 들어가는 `fee_tier_bp`를 대조한다. pool은 로컬 CREATE2 계산값이며 pool 존재·유동성·mint 실행 성공을 확인한 값이 아니다. pool_state의 `xy_constant`/zero reserve와 current_price `"0"`은 현행 placeholder이며 `onchain_view` source 표시는 RPC 조회 증거가 아니다. ABI deadline은 현재 Action에 투영되지 않는 한계다. refundETH는 `token/refund_native`이고 recipient는 submitter이며 calldata에 없는 금액이나 부모 value 복사를 추가하지 않는다. 최상위 meta 아래에는 자식 ActionBody만 있어 내부 meta·decoder ID 전체 보존을 주장하지 않는다. self 자식 route value `"0"`은 현행 입력 관찰이며 실제 EVM `msg.value` 의미 검증이 아니다.

**DEC-06a 당시 깊이·진단 한계:** self manifest의 `max_depth: 3`을 `build_multicall_recurse_body`는 읽지 않으며 자식은 public route로 재진입한다. 현행 직접 제한은 단계별 자식 64개이고 작은 깊이 4도 관찰 대상으로 남긴다. 65개와 malformed child는 현행 전체 오류다. 미등록 child의 Unknown 보존과 malformed 오류 전파를 구분하며 현재 DTO에 없는 reason/path/complete/partial을 정상 기대값에 만들지 않는다. TS의 self 사전 설치는 직계 selector만 검색하며 별도 `MAX_REENTER_DEPTH = 4`는 Call[]의 `installCallTree` 경로에 적용된다. WASM 해석 한도와 구분하고 bundle 사전 설치 Node 시험만으로 호스트 동적 발견·설치를 검증했다고 표시하지 않는다.

**DEC-06a 당시 검증·재사용:** DEC-04b 사용자 빌드 및 DEC-05a/05b에서 검증한 JS/WASM 쌍은 현재 hash가 같고 Rust·schema·Cargo·빌드 입력도 유지돼 재사용 가능하다. 불필요한 Native 회귀·새 WASM 빌드·설치를 요구하지 않는다. [README](../../fixtures/decoder-policy/README.md#dec-06a-사용자가-직접-실행할-검증-명령)의 사전 입력/산출물 대응 확인 → **self 개별 → 통합**은 사용자 재실행에서 통과했다. 완료 기록 갱신을 위한 재시험·재빌드는 필요 없다. 실제 source/hash·범위·오류·한계는 [coverage](../../fixtures/decoder-policy/coverage.md#dec-06a--self-multicall-연결과-현재-한계)에 기록한다.

| 후속 단계 | 현재 상태·다음 범위 |
| --- | --- |
| **06b Call[]** | **사용자 통합 검증 완료.** 실행 결과는 README의 06b 기록을 따른다 |
| **06c 진단·한도** | **사용자 검증 완료.** self·Call[]·callback의 공유 재귀 문맥과 한도, 미해석 원문 Unknown·진단 및 소비자 전달을 [확정 계약](decoder-design-plan.md#dec-06c--확정-계약과-실행-상태)에 맞춰 확인. [실행 근거](../../fixtures/decoder-policy/README.md#dec-06c--사용자-검증-완료-dec-06-완료)를 따르며 Permit2 Batch의 기존 계약은 유지 |

**DEC-06 전체 상태: 사용자 검증 완료.** self·Call[] 연결과 06c 진단·한도의 구현·사용자 검증을 마쳤다. 미해석 구간의 Unknown·partial 보존, 정상 호출과 순서 유지, 한도 경계와 서로 다른 재귀 경로의 공유 문맥을 확인했다. 실행 근거는 [README](../../fixtures/decoder-policy/README.md#dec-06c--사용자-검증-완료-dec-06-완료)를 따른다. Core API·allow/warn/deny 정책·RPC·서명 검증·SDK 이관·DEC-07은 이번 구현 범위 밖이다.

#### DEC-06b — 실제 Bundler3 Call[] 연결

**06b 구현 당시 기록: 구현·정적 검토 완료, 사용자 실행 대기.** [`multicall-call-array.cases.json`](../../fixtures/decoder-policy/multicall-call-array.cases.json)의 **43요청**(성공 envelope 기대 25·오류 기대 18)과 [`.test.mjs`](../../fixtures/decoder-policy/multicall-call-array.test.mjs)의 **구조 검사 6개**, 합계 **49개 정의**다. 기존 514개 포함 통합 **563개 정의**이며 통과 수가 아니다. DEC-05 기록 `56ece47`·06a 구현 `9923487`의 실제 분리 커밋과 성공 로그 구현 다섯 파일의 hash를 먼저 확인하여 선행 조건을 충족했다. 실제 06a 실행 HEAD는 `1326fb5`의 미커밋 작업 트리로 구분하고 과거 검증/커밋 절차는 다시 실행하지 않는다.

실제 원본은 `registryV2/manifests/morpho/bundler3/1-multicall@1.0.0.json`, 원본 SHA-256은 `0xd909edf6d2f1cf5eeb375042b5f61979b3cd1a1e0505a4fee9352b87d78b2a63`다. chain **1**·부모 `0x6566194141eefa99af43bb5aa71460ca2dc90245`·selector `0x374f435d`를 유지한다. `includeTransfer: true, includeBundler3: true`로 approve/transfer/Bundler3를 선택하고 원본 hash → 임시 strict Registry → exact index·inline/ref·JCS → 실제 WASM install → 기존 worker transaction route를 연결한다. callkey **9개**는 approve `3-ref` 4개·transfer `3-ref` 4개·Bundler3 inline 1개이며 typed/selector index는 0개다. 서로 다른 bundle/digest **3개**와 별도 `bundles/` 파일 **2개**를 구분한다. concrete 부모를 USDC token 목록으로 네 체인에 확장하지 않는다. 새 옵션의 기본값은 false이며 명시 선택에만 `bundler3Source`를 추가하고 기존 기본값·반환·실패 정리를 보존한다.

Call tuple `(to,data,value,skipRevert,callbackHash)`의 순서·동적 offset/length/padding과 고정 calldata를 독립 검산한다. 자식별 to의 실제 approve/transfer에서 token·spender/recipient·수량 `1234567`/`2^200+12345`·전체 Action/meta를 대조한다. 부모 value `999`와 자식 `17/19`·큰 uint256을 구분한다. 단독/조합·역순/반복·flags 변형, known/미등록 target·selector 혼합 및 전부 Unknown, 0/1/2/3바이트 child, empty/64/65, 등록된 malformed 첫째/마지막 child와 skipRevert false/true, 외부 ABI malformed 10개, 추가 바이트 허용, 부모 routing miss를 포함한다. 여섯 설치 상태와 같은 프로세스의 정상/오류/미지원 교대도 검사한다. 기대값은 실제 WASM 출력에서 생성하지 않았다.

**현행 오류·정보 보존 범위:** 짧거나 미등록인 Call[] child는 각 target·원문 calldata·value의 Unknown으로 보존하며 self의 짧은 child 오류와 통일하지 않는다. all-unknown은 순서를 유지한 Multicall이고 empty·65개·등록된 malformed는 전체 오류다. source note/Rust 주석의 오래된 “skip” 문구보다 실제 `process_call_legs` 구현을 따른다. skipRevert/callbackHash는 ABI 입력으로 파싱되지만 해당 처리 함수가 적용/검증하지 않으므로 true가 decoder 오류를 숨기지 않고 nonzero hash가 callback 실행·인증을 의미하지 않는다. 최상위 meta 아래에는 child ActionBody만 존재하며 known body에 Call.value·flags·내부 meta/decoder ID를 추가하지 않는다. Unknown의 value 보존도 실제 EVM 자금 전송·계약 실행 성공의 증거가 아니다.

**정적 검토·사용자 검증:** 실제 세 원본의 바이트/JCS 기대값, 고정 ABI·수량·10개 malformed outer 변형·flags 출력 관계, source별 ref/inline 분기를 읽어 대조했다. 새 test/helper의 `node --check`, JSON 파싱·고유 case ID·안전 정수 literal, `git diff --check`, 사용자 Bash/Python 구문을 검사했다. 기존 여덟 test·일곱 fixture·worker **16파일**은 `9923487`와 바이트 동일하며 기존 selection 항목을 보존한다. Rust·schema·Cargo·빌드 입력 **1279파일**이 `e487805`와 같고 JS/WASM hash가 검증된 쌍과 동일하여 재빌드·설치를 요구하지 않는다. [README](../../fixtures/decoder-policy/README.md#dec-06b-사용자가-직접-실행할-검증-명령)의 **Call[] 개별 → 기존 self 포함 통합**을 사용자가 실행하고 실제 결과를 기록한다. 시험·빌드·Git 쓰기는 에이전트가 실행하지 않았다.

기존 Native Call[] 시험의 synthetic child/해석 후 JSON 입력과 TS mock installer/WASM 사전 설치 시험은 참고 근거이며 실제 부모 원본 → Registry → outer ABI → WASM 연결의 대체물이 아니다. 새 Node 시험도 실제 bundle을 사전 설치하므로 호스트의 동적 발견·설치를 검증하지 않는다. manifest의 `max_depth: 4`는 현재 `reenter(Call[])` callback 재귀에만 읽히며 06b는 callback 재귀·public route 재진입의 전역 깊이 계약을 검증하지 않는다.

**다음 문단은 06b 당시의 후속 범위 기록**이다. 현재 06c의 구현 상태와 계약은 확정 계약 절을 따른다. 06b 사용자 결과 확인 후 재귀 문맥·서로 다른 경로의 한도 우회·callback 생략을 보완한다. **해석한 호출과 순서 보존 + 남은 구간 Unknown/한도 사유**라는 기존 결정은 유지하고 새로운 제한값·정확한 wire/complete/partial·진단 코드·호출 경로/decoder ID·소비자 호환만 구체 입력/현재 결과/영향 파일/권장안과 함께 확정한다. 현재 없는 진단을 06b 기대값에 넣거나 Permit2 Batch에 새 multicall 정책을 자동 적용하지 않는다. 06c까지 구현·사용자 검증해야 DEC-06 전체 완료이며 Core API·정책 allow/warn/deny·RPC·서명·SDK 이관·DEC-07은 이번 범위 밖이다. 세부 원본/JCS·사례·한계는 [coverage](../../fixtures/decoder-policy/coverage.md#dec-06b--call-연결과-현재-한계)를 따른다.

### D3. 정책 콘텐츠와 manifest 정리

- 초기 대상으로 Day-1 정책 묶음을 정하고, 새 공유 원본 경로 `policy-bundles/day1-safety/`로 정리한다. 이 이동은 decoder 기능 변경과 다른 커밋으로 한다.
- SDK 시험과 정책 생성은 공유 원본을 소비하도록 바꾼다. 이관 중 기존 동작을 비교하는 데 필요한 소비 경로만 함께 조정하며, 확장 유지·빌드를 SDK 완료 조건으로 넣지 않는다. 런타임 구현과 UI 코드는 옮기지 않는다.
- `fixtures/baseline-verdicts.json`이 참조하는 확장 public 정책 파일을 공유 원본에서 재현하는 경로로 전환한다. 내용이 같으면 정책 hash를 유지하며, 경로만 옮기기 위해 판정이나 기대값을 변경하지 않는다.
- policy id·manifest id, `schema_version: 2`, trigger, severity, 필요한 Fact method·params·outputs·optional 선언을 확인한다.
- 정적 정책과 외부 Fact가 필요한 정책을 구분하고, 각 정책에 적용/비적용·경계값·필수 데이터 누락 사례를 만든다.
- 기존 정책을 이름에 맞추려고 warn→deny로 자동 변경하지 않는다. 정책 의도 수정은 별도 변경으로 설명한다.

완료 조건: 정책 원본을 한 곳에서 관리하고 기존 소비 결과가 유지된다. SDK 정책 입력·fixture 생성이 확장 디렉터리를 읽지 않는다. 각 활성화 대상 정책은 유효한 manifest와 예상 판정 사례를 갖는다. 향후 A2에서 구현할 첫 Fact method와 원본 응답 계약을 여기서 선정한다.

### D4. Core에 넘길 번들·고정 스냅샷

**Decoder 부분 상태:** DEC-07 구현·정적 검토·사용자 검증 및 Decoder 인계 완료. [인계 자료·실행 기록](../../fixtures/decoder-policy/README.md#dec-07--decoder-인계)을 따른다. D4 전체 및 C2c·C5 완료를 뜻하지 않는다.

- 신규 `contracts/core-v1/`에 payload/envelope 타입·Schema·정상/오류 fixture를 만든다. 정책의 7개 필드는 API 담당이 준 형태를 기준으로 한다.
- B 방식 문자열 payload, `registry_ref: null`, 역할별 키 분리 방향을 반영한다. 실제 API 필드명·인증·운영값의 미확정 항목은 제안과 구분한다.
- Registry 빌드의 **개별 bundle digest**와 SDK 고정 스냅샷 전체의 **로컬 digest**를 구분한다. 아직 없는 원격 root digest/ref를 만들어 계약으로 사용하지 않는다.
- SDK에 포함할 snapshot 범위·생성 입력·정렬·digest·coverage 목록을 기록하고 재현 가능한 빌드 결과를 만든다. 전체 Registry를 무조건 번들링하거나 이전 백업의 세 토큰만 제품 범위로 확정하지 않는다.
- 정책 payload와 decoder artifact는 신뢰 경로를 각각 기록한다. 내장 artifact 신뢰와 외부 decoder 서명을 혼동하지 않는다. 실제 Core 서명 검증 코드는 C3에서 구현한다.
- snapshot 생성에 필요한 manifest·token·고정 프로토콜 자료와 생성기 의존 파일을 추적 가능한 목록으로 고정한다. SDK 소스 복사본 안에서 재생성할 수 있어야 한다. live RPC, 확장 산출물, 로컬 전용 cache/harness가 없으면 생성할 수 없는 대상은 미완료로 남긴다.

완료 조건: Core 담당이 extension 디렉터리를 읽지 않고 사용할 정책·decoder 입력과 fixture를 얻는다. 같은 입력은 같은 정규화 바이트/digest를 만든다. 계약 구조 검증과 서명·의미 검증의 완료 여부를 구분한다.

**Decoder 단계 인계물:** coverage 표, 재현 가능한 decoder artifact, Cedar/manifest 원본, API 계약 fixture, 원문 요청→Action→예상 판정 사례.

## 5. 2차 작업: feat/core

실제 API/RPC는 아직 연결하지 않는다. D 단계의 실제 정책·디코더와 서명된 테스트 번들, 기록된 원본 Fact를 반환하는 mock 포트로 실행부를 개발한다. 평가·암호 검증 자체는 mock하지 않는다.

| 단계 | 변경 단위·주요 파일 | 완료 조건 |
| --- | --- | --- |
| C1 | `packages/core/src/{core,ports,types,index}.ts` 계열과 공개 `.d.ts` 검사 | 생성/함수·포트·타입 변경 전후가 명시됨. B bytes, 원본 Fact, 계획 handle, 오류·미지원 규칙을 계약으로 고정 |
| C2-0a | 공통 `state/action/transition`을 `crates/asset-model/`로 이관 | crate 하나씩 이동·경로 수정·시험. 타입/직렬화/계산 로직 변경을 섞지 않음 |
| C2-0b | SDK/API Cargo workspace 분리 및 manifest·lockfile 정리 | SDK workspace가 서버 폴더의 manifest를 읽지 않음. 검사 때만 manifest를 고치는 방식은 사용하지 않음 |
| C2-0c | Cedar schema를 배포 crate 내부로 이동하고 include/목록 시험/생성 경로 수정 | schema 원본이 한 곳이고 Rust 패키지에 포함. 과거 root schema 또는 서버 static 파일로 fallback하지 않음 |
| C2a | Decoder Registry를 신규 `crates/dambi-core/src/decode/`로 추출. 기존 WASM wrapper는 이관 중 회귀 비교용으로만 사용 | 전역 상태를 인스턴스별로 분리. D 단계 디코딩 결과와 독립 인스턴스 시험 통과 |
| C2b | 순수 평가 로직을 `crates/dambi-core/src/runtime/`로 추출. DTO·기존 wrapper 정리 | 같은 Action·정책·Fact에 기존 결과 유지. 정책 severity 변경이나 전체 의존성 개편을 섞지 않음 |
| C2c | SDK 필수 회귀 시험·seed·fixture와 읽기/쓰기 경로 이관 | 확장/서버 경로 접근 0. fixture 부재로 필수 시험이 skip되지 않음. 기존 디렉터리를 시험 중 다시 만들지 않음 |
| C3 | `crates/dambi-core/src/bundle/`에 엄격한 parser/JCS/서명·의미 검증 | 원본 바이트·중복 키·BOM·Unicode·수치·크기·키 역할·scope/time/rollback을 실제 fixture로 검증 |
| C4 | 검증된 정책/decoder snapshot 및 Store | 전체 검증 후 활성화. 외부 decoder는 별도 역할 서명, 내장은 고정 artifact 신뢰. 갱신 전 계획의 의미가 변하지 않음 |
| C5 | Rust 계획/평가 + `dambi-core-wasm` + JS `plan/evaluate`, SDK 전용 빌드·시험 경로로 전환 | 요청 digest·해석 결과·정책/decoder·필수 Fact 고정. 타 인스턴스·변조·만료·재사용 거절, 원본 projection 한 번 수행. 기존 WASM/확장 빌드 산출물 참조 제거 |
| C6 | JS `check`·포트 조율·timeout·Fact Cache·hook | mock 포트로 끝까지 실행. 필수 값·신선도·request/call ID·동시성 검증. 늦은 응답은 상태를 바꾸지 않음 |

C1에서 기존 scaffold의 `PolicySource.payload: unknown`, Fact의 '투영 후 값', selector+chain만 받는 decoder 조회, 기존 plan/evaluate 시그니처와 새 계약의 차이를 명시한다. 초기 공개 표면을 무조건 유지하거나 무단으로 보조 export를 늘리지 않는다. 생성/수명주기 함수와 주요 함수 3종, 포트 2종, 주요 타입 3종 및 보조 타입을 정확히 구분한다.

**C2-0b workspace 변경:** 루트 `Cargo.toml`을 SDK와 필요한 순수 공통 crate를 위한 workspace로 관리한다. `policy-db`, `policy-sync`, `policy-server`는 서버 측 별도 workspace/manifest로 분리하고 공통 crate의 새 위치를 의존하게 한다. 이동으로 의존 버전이 자동 갱신되지 않도록 manifest·lockfile을 함께 검토한다. SDK/API CI는 각각 자신의 workspace 명령을 사용한다. 기존 WASM wrapper는 비교 기간에만 사용하며 C5 전환 완료 시 최종 SDK workspace와 소스 입력 목록에서 제외한다.

**C2-0c schema 변경:** 현재 중립 원본은 `schema/policy-schema/`다. 이를 `crates/policy-engine/schema/policy-schema/`로 옮기고 `src/schema/mod.rs`의 include 경로, schema 목록 시험, 관련 생성·소비 스크립트를 조정한다. 서버의 `static/policy-schema.json`을 SDK 원본으로 사용하거나 수동 복제하지 않는다.

**C2c 시험 변경:** `fixtures/baseline-verdicts.*`, 기존 WASM의 `hl_exchange_deny_e2e.rs`, `est_roundtrip.rs` 등에서 SDK에 필요한 사례와 정적 입력을 인계한다. fixture 출력은 SDK 경로나 임시 디렉터리에 쓴다. 앱 UI 전용 시험은 SDK 시험과 구분하되, 필수 SDK 회귀 사례를 제외하거나 fixture 미존재 시 skip해서 검증을 통과시키지 않는다. 필수 case ID/실행 수를 기록해 누락을 확인한다.

**C5 빌드 전환:** 기능 연결과 빌드 변경을 별도 소단계로 진행한다. 신규 `scripts/sdk/build-wasm.mjs`와 필요한 asset 생성 명령으로 `dambi-core-wasm`을 소스에서 빌드한다. root/package 스크립트, TS import·types, Node fixture, CI의 WASM 입력을 새 경로로 교체한다. SDK 명령은 `scripts/wasm-build.sh`, 확장 `postinstall/build`, 기존 `policy-engine-wasm/pkg`에 의존하지 않는다. root의 서버 기동 명령은 API 측 도구로 분리하고, SDK CI는 `createCore()` throw를 기대하는 scaffold 시험을 실제 실행 시험으로 교체한다.

SDK CI 전환은 C5부터 실제 실행 경로를 검사하고 C6에서 mock 포트 기반 전체 동작까지 확장한다. 어댑터 작업 후에도 같은 독립 빌드 검증을 유지한다. 기존 경로로 실패를 우회하는 fallback은 남기지 않는다.

C3의 정책 `expires_at: null`은 최대 나이를 무제한으로 만드는 뜻이 아니다. 최대 나이·clock skew·크기 제한은 명시적인 Core 지원 정책으로 기록한다. API와 합의되지 않은 값을 서버 계약으로 표현하지 않는다.

C5–C6에서는 empty bundle, 매칭 정책 없음, 엔진 오류, 부분 디코딩, 필수 Fact 누락, 알려진 malformed 요청, 미지원 kind 각각의 결과를 명시한다. `warn`은 호스트 확인 필요, `enforcing`은 호스트의 선언이다. 실제 서명 요청과 평가 요청을 동일하게 유지하는 통합 지침도 작성한다.

**Core 단계 인계물:** 실제 Native/WASM 실행 경로, 고정된 포트·타입, 테스트용 PolicySource/FactProvider, 보안·회귀 시험, 어댑터가 지켜야 할 오류·취소·데이터 계약, SDK 소유 workspace/소스 목록/빌드 명령. 기존 폴더가 없는 복사본에서 C6까지의 시험·빌드가 통과한 결과를 포함한다. 최종 배포 형식 검증은 §7.1에서 수행한다.

## 6. 3차 작업: feat/adapters

C 단계 이후에 브랜치를 만든다. HTTP와 Fact 어댑터는 SDK의 선택적 모듈로 구현하며, Core는 이 구현을 강제로 참조하지 않는다.

| 단계 | 구현 범위 | 완료 조건 |
| --- | --- | --- |
| A1 Policy API | `packages/core/src/adapters/policy-api.ts`: URL·인증·HTTP·크기/취소·엄격한 wrapper 파싱·전달 | payload 문자열의 바이트를 재직렬화하지 않음. 실제 서버의 필드·헤더·kid·서명으로 공동 시험. 통신 장애와 잘못된 번들을 구분 |
| A2 첫 Fact provider | `fact-provider.ts`, 필요한 `evm-rpc.ts` 등: D3에서 선정한 한 method | 실제 raw 데이터에 source·observedAt·필요 block 정보를 연결. call ID별 반환·체인 라우팅·timeout·RPC 오류·필수 누락 검증. 최종 정책 판정을 대신 반환하지 않음 |
| A3 추가 method·전체 연결 | 필요한 method만 별도 변경으로 확장, `examples/`의 고객 앱 예제 | 원문 요청→실제 정책 API→Core plan→실제 Fact→Core verdict 재현. Node/브라우저에서 확장 없이 실행 |

`oracle.usd_value` 같은 기존 이름만 보고 구현된 데이터 소스가 있다고 가정하지 않는다. 정책 서버의 `dambi.evaluate_v3` 최종 평가 결과는 원본 Fact의 대체물이 아니다. 실제 데이터 API가 없으면 해당 method의 연동을 미완료로 남기고 필요한 서버 계약을 구체적으로 전달한다.

API 담당에게 필요한 입력: 실제 B wrapper와 서명 예제, 인증 헤더/키 절차, staging/production URL, 공개 검증 키·kid, 갱신/만료 정책. 이것이 없어도 D·C와 A의 mock HTTP 시험은 진행할 수 있지만 실제 통합 완료로 표기하지 않는다. 감사 전송이 필요하면 별도 transport로 연결하되 기본 평가가 감사 서버 가용성에 종속되지 않게 한다.

## 7. 마지막 통합·패키징

새 장기 브랜치를 만들지 않고 해당 단계에서 필요한 작은 변경으로 진행한다.

- Core 실행 연결 시부터 실제 WASM 크기를 측정한다. 최종 목표는 raw < 6 MiB, runtime gzip 합계 ≤ 1,500,000 B이며 미달성 값을 통과로 바꾸지 않는다.
- 런타임과 관계없는 의존성 제거, Cargo 내부 스키마 포함, crate 이름/발행 순서는 각각 확인 후 별도 변경한다. 기존 백업의 광범위한 import 교체를 자동 적용하지 않는다.
- ESM/CJS·`.d.ts`·WASM/glue·필요 decoder asset을 실제 tarball로 묶는다. 기존 scaffold의 `npm pack --dry-run`만으로 설치 성공을 주장하지 않는다.
- 저장소 밖 Node ESM/CJS 소비자, 실제 브라우저, Native Cargo 패키지의 독립 실행을 확인한다.
- npm/Cargo 발행, 실제 API 운영 검증, GitHub 전체 CI의 통과 여부를 로컬 시험과 구분해 릴리스 체크리스트에 기록한다.

### 7.1 필수 완료 조건: SDK 소스만으로 빌드·시험·패키징

**패키지가 실행되는 것만으로 완료하지 않는다. SDK 소스에서 다시 만드는 과정도 독립적이어야 한다.** 다음 검증은 선택 사항이 아닌 SDK 전환·릴리스 필수 조건이다.

신규 구현할 도구:

- `scripts/sdk/sdk-source-files.json`: SDK 소스·workspace 설정·lockfile·schema·정책/decoder 원본·필수 fixture·라이선스·도구 설정의 포함 목록. 목록 밖 원본 저장소 파일을 참조하면 실패한다.
- `scripts/sdk/check-boundaries.mjs`: 실제 TS import, Cargo path/include, fixture 경로, 빌드·asset 생성 입력을 점검한다. 문서의 과거 코드 링크나 주석 언급과 실행 의존은 구분한다.
- `scripts/sdk/check-source-isolation.mjs`: 아래 절차를 임시 디렉터리에서 실행한다. 원본 작업 폴더를 삭제·이동하지 않는다.
- root의 `sdk:verify:isolated`: 위 검사를 실행하는 신규 명령. **현재 구현돼 있거나 통과한 명령이 아니다.**

검증 절차:

1. 추적되는 SDK 원본만 별도 임시 디렉터리에 복사한다. 최종 SDK workspace manifest를 그대로 사용하며 검사 과정에서 members나 dependency를 임의로 빼서 성공시키지 않는다.
2. `browser-extension/`, `crates/policy-server/`, 기존 `crates/policy-engine-wasm/`은 포함하지 않는다. 기존 `dist`, WASM `pkg`, `target`, `node_modules`, 생성된 Registry index/bundle 출력도 가져오지 않는다. 필요한 원본·고정 입력은 목록에 명시한다.
3. 원본 저장소로 이어지는 절대 경로·symlink·외부 path dependency가 없는지 확인한다. 패키지 관리자가 격리 디렉터리 내부에 만드는 정상 연결은 허용한다. SDK가 사용하는 로컬 소스·데이터 경로는 모두 복사본 안에서 해소돼야 한다.
4. 고정한 toolchain/lockfile에 따라 의존성을 설치한다. 일반 의존성 다운로드는 허용하되, 과거 빌드 artifact·compiler 산출물·로컬 전용 테스트 harness를 빌드 대체물로 사용하지 않는다. `SKIP_WASM_BUILD`로 소스 빌드를 건너뛰지 않는다.
5. 정적 입력에서 decoder/policy asset을 생성하고, 새 Native/WASM 출력 디렉터리에서 Rust → WASM/glue → TS/ESM/CJS/타입을 빌드한다. 원본이 부족하거나 live RPC/cache가 있어야만 생성되면 실패로 남긴다.
6. Native 및 Node + 실제 WASM의 필수 SDK 사례를 실행한다. 필수 fixture 누락, 필수 사례 0개/skip은 통과가 아니다. mock 외부 포트를 쓰더라도 실제 해석·서명 검증·평가는 실행한다.
7. 실제 npm tarball을 만든 뒤 저장소 밖 새 소비자 프로젝트에 설치한다. ESM/CJS import, `.d.ts`, WASM/asset 로딩, 실제 `check` 호출 및 필요한 브라우저 소비 시험을 확인한다. workspace link나 SDK의 기존 dist를 직접 읽지 않는다.
8. 배포할 Rust crate의 package 파일 목록과 unpack한 소스의 경로를 확인한다. schema·fixture·필요 자산이 포함되고 외부 workspace 파일을 읽지 않아야 한다. 아직 발행되지 않은 자체 의존 crate는 로컬 임시 registry 또는 unpack한 패키지들로 검증 환경을 구성하며 원본 source tree로 연결하지 않는다. 공개 registry 의존성 해소 검증과 로컬 사전 검증의 상태는 구분한다.
9. 빌드·시험이 끝난 후에도 과거 디렉터리가 없고 원본 저장소를 참조하지 않는지 재검사한다. 과거 경로에 fixture나 WASM을 다시 생성하면 실패다.

CI에는 이 명령을 소스부터 실행하는 SDK 전용 job을 둔다. extension/server job의 성공, 그 job이 올린 WASM 파일, dashboard fixture 생성이 선행 조건이어서는 안 된다. Core 단계에서는 해당 시점의 지원 사례로 먼저 통과시키고, 어댑터·패키징 단계에서 릴리스 대상 전체 사례로 확장한다.

완료 증거: 포함한 source 목록, 사용한 toolchain/lockfile, Native/WASM 시험 결과와 필수 case 수, npm/Cargo package 포함 목록 및 소비자 실행 결과, 빌드 전후 경계 검사 결과. 실패 항목이 있으면 SDK 소스·빌드 독립화는 미완료다.

## 8. 브랜치 인계와 보고 단위

현재는 `feat/decoder`만 작업한다. `feat/core`는 출발점에서 유지하고 `feat/adapters`는 아직 만들지 않는다.

Decoder 인계 조건을 충족하면 검토된 decoder 이력을 Core에 통합한다. 아직 main에 반영되지 않았다면 변경 없는 `feat/core`를 `feat/decoder`까지 fast-forward해 이어갈 수 있다. Core 단계 이후 `feat/adapters`는 검토된 Core 커밋에서 만든다. 비교 기준을 각각 직전 단계로 잡아 기존 변경이 새 리뷰에 중복되지 않게 한다. 브랜치가 분기되면 force/reset으로 맞추지 않고 실제 이력을 확인한다.

각 소단계의 보고 형식:

1. 이번 단계와 변경 목적.
2. 변경 파일과 기존 동작 대비 차이.
3. 실행한 검증 및 실제 통과/실패.
4. 지원 범위·미완료·다음 작업.
5. 로컬 커밋과 push 여부.
6. 이관 작업이면 제거한 기존 경로 의존과 아직 남은 임시 의존, 독립 빌드 검증 상태.

**현재 DEC-02와 D1은 사용자 실행 보고 기준 검증 완료다.** 구현 커밋은 `26df736`이며 통합 37개(DEC-01 회귀 30개 + DEC-02 정책 7개)가 통과했다. 실패·취소·건너뛰기·todo는 모두 0이다. 사용자 보고로 실제 Rust WASM 빌드 완료와 현재 JS/WASM의 직접 계산 SHA-256이 실행 로그와 일치함을 확인했다. 이번 문서 갱신에서 원본 로그 재열람이나 hash 재계산은 하지 않았다.

**현재 DEC-03은 사용자 실행 보고 기준 검증 완료다.** 요청 18개와 구조 검사 3개, 합계 21개를 작성했고 사용자 실행 로그에서 transfer 21/21 통과(`duration_ms=866.922333`), 통합 58/58 통과(`duration_ms=635.086875`)를 확인했다. 각 실행의 suites·fail·cancelled·skipped·todo는 모두 0이다. 공동 설치·8개 callkey·JCS digest·프로세스 격리와 기존 37개 회귀도 통과했다. 소스·Rust 직렬화/오류 순서·고정 calldata word를 읽어 정적 대조했고 기존 37개 시험/fixture/worker 및 Rust·빌드 입력을 유지했다. DEC-02에서 검증한 같은 빌드의 JS/WASM 쌍은 재사용할 수 있으며 이번 로그에 별도 재빌드 기록이 없다는 이유로 재빌드·재시험을 요구하지 않는다. 이 기준 시험은 기존 WASM과 임시 경로를 사용하며 SDK 독립 빌드 증거가 아니다.

DEC-01의 과거 기록은 별도로 유지한다. 당시 Rust 소스 재빌드 후 연결 시험은 사용자 제공 로그 기준 30개 통과, 실패·취소·건너뛰기 각 0개이며 작성자가 직접 실행한 결과가 아니다. 사용자 제공 실행 전후 Git 상태에서 HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`로 같고 Rust 소스·빌드 설정 변경은 표시되지 않았다. 도구 조회 결과는 Rust/Cargo 1.95.0, wasm-pack 0.14.0, Node 25.9.0, npm 11.12.1이다. 빌드 성공 표식 `build_success_utc=2026-09-11T06:57:10Z`, WASM SHA-256과 재시험 로그를 [README](../../fixtures/decoder-policy/README.md)에 기록했다. 재시험은 `2026-09-11T06:57:40Z` 시작, `2026-09-11T06:57:42Z` 성공 표식, `duration_ms=1290.958958`이며 최초 시험 30개 통과(`duration_ms=2050.144875`)와 별도 실행이다.

DEC-01 당시 미제공 세부 기록은 그대로 유지한다. DEC-02의 실제 실행 시점 HEAD·도구 버전·시각·원본 hash 값 등 사용자 요약에 없는 값도 임의로 채우거나 DEC-01에서 복사하지 않는다. 이 세부 기록을 채우기 위해 빌드·시험을 다시 요구하지 않는다. DEC-03 착수 시 남아 있던 DEC-02 검증 완료 문서 변경 3개도 보존했다. 이번 사용자 실행 로그를 README·coverage·두 계획서에 실제 반영했으며 DEC-03 실행의 미제공 hash·시각·HEAD·도구 버전·재빌드 로그는 채우지 않는다. 착수 HEAD는 실행 시점 HEAD의 증거가 아니며 세부 기록의 미제공은 DEC-03 검증 완료를 막지 않는다. 에이전트는 빌드·시험·의존성 설치·Git 변경 명령을 실행하지 않았다. 04a 결과를 네 문서에 반영하고, 네 계약 답변에 따라 별도 v4 full-input DTO·strict validator·emit 연결·Rust/Node 회귀 시험을 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다. DEC-05로 자동 진행하지 않는다. D1 완료 범위는 approve 디코딩·소비자 정책 연결까지다. 소스 이관, Core 재구현과 SDK 전체 소스·빌드 독립화는 미완료다.
