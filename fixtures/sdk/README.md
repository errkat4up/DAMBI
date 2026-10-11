# SDK 정책 입력과 Native 회귀

## 번들 B1-1 — Universal Router

2026-10-12, `main 7387536` 이후 B1-1 변경 검증: **Native 원문 2개 시험과 패키지 WASM 3개 시험 통과, 최종 WASM 로그 3 통과·0 실패.** 저장된 snapshot은 801개이며 기존 799개 내용 보존·UR 2개 추가·digest/bytes 일치를 확인했다. source-context 제외 30,484개와 Aave 거절 3개는 유지한다. 별도 `decoder_snapshot` target의 전체 결과는 공유되지 않았다. 대표 UR 경로의 편입·검증을 마쳤으며 다음은 B1-2 Aave다.

아래는 관련 설치 회귀와 두 execute selector의 V3 수령인 정책·V4 primary/alternative ABI를 확인하는 명령이다. alternatives 제거 대조군도 포함한다. 이미 통과한 UR 사례는 관련 변경이 없으면 반복하지 않는다.

```sh
cargo test --locked -p dambi-core --test decoder_snapshot --test universal_router
```

현재 Mapper의 pool/slippage·LiveField 기본값은 실제 관측 데이터가 아니다. V3는 calldata 수령인 정책을, V4는 토큰·수량·대안 ABI 연결을 검사한다. V4 swap의 수령인은 manifest의 `$tx.from`이며 최종 TAKE/SETTLE 수령인이나 EVM 실행 성공을 검증하지 않는다.

아래 명령은 재현용이다. 수정한 Native runner·WASM을 빌드하고, 기존 799개를 보존하며 UR 2개를 추가한다. 증분 생성은 전체 후보가 Core 설치 검증을 통과해야 저장하며, 실패 항목을 제외하고 성공 처리하지 않는다. 이어 새 snapshot만 패키징한 뒤 관련 WASM 시험 3개를 실행한다. 이미 통과했으므로 관련 변경이 없으면 반복하지 않는다.

```sh
cargo build --locked -p dambi-core --example session_runner &&
npm run core:build &&
npm --prefix registryV2 run build:decoder-snapshot -- \
  --add-manifest manifests/uniswap/universal-router/execute-v2@1.0.0.json \
  --add-manifest manifests/uniswap/universal-router/execute-v2-no-deadline@1.0.0.json &&
node scripts/sdk/build-decoders.mjs &&
node --test --test-name-pattern="packaged" packages/core/tests/runtime.test.mjs
```

새 시험은 두 selector의 V3 self/other·V4 primary/alternative 판정을 WASM `check()`와 Native 사이에서 비교하고, 손상된 nested ABI가 digest를 다시 고정해도 거절되는지 확인한다. 이 패키지 회귀 입력은 SDK 격리 source 목록에도 추가했다. Registry 원문을 직접 포함하는 Native target과 원본부터의 snapshot 생성 격리는 B3에 남는다. B1-2 Aave로 이어간다.

## 공유 정책 입력

Day-1 정책의 공유 원본은 [`policy-bundles/day1-safety/`](../../policy-bundles/day1-safety/package.json)이다. Cedar 본문과 manifest 10개는 그대로 이동했고 package의 원본 경로만 변경했다. [`policy-bundle.cjs`](../../scripts/sdk/policy-bundle.cjs)가 package 선언 순서대로 `{id, policy, manifest}`를 읽고 직렬화한다. SDK baseline과 기존 확장 asset copier가 같은 함수를 사용하며, DEC-02는 공유 Cedar/manifest를 직접 읽는다. 원본이 없으면 빈 set 또는 합성 manifest로 대체하지 않는다.

## 정책·Fact 범위

| 정책 | 적용 조건 | 실제 severity / 기대 판정 | 외부 Fact |
| --- | --- | --- | --- |
| `unlimited-approval-deny` | ERC-20 approve, 정확한 uint160/uint256 최대값, Permit2 spender 제외 | warn / warn | 없음 |
| `send-first-time-or-burn-recipient-warn` | ERC-20 transfer의 zero·dead 수령 주소 | deny / fail | 없음 |
| `unknown-blind-sign-warning` | Unknown Action | warn / warn | 없음 |
| `permit2-sign-allowance-confirm` | Permit2 allowance 서명, 금액 0 포함 | warn / warn | 없음 |
| `swap-recipient-not-self-deny` | swap 수령 주소가 평가 지갑과 다름 | deny / fail | 없음 |

조건이 성립하지 않는 유효 Action은 pass다. 이름의 deny/warn과 실제 severity가 다른 기존 정책도 그대로 유지한다. 첫 수령인 이력 조회는 Day-1 전송 정책에 없으며, 신규 정책으로 추가하지 않았다.

[`day1-policy.cases.json`](day1-policy.cases.json)은 trigger·필요 Action 입력·독립 기대값을 담는다. [`day1-policy.test.mjs`](day1-policy.test.mjs)는 기존 baseline 4개를 그대로 재사용하고, 경계·대소문자 정규화·비적용·필수 입력 누락을 실제 기존 WASM plan/evaluate로 확인한다. 입력 오류는 정책 deny와 구분한다. 기존 API에서 plan은 오류 envelope, evaluate는 `__engine::invalid_input_json` fail을 반환한다.

Fact 0개는 `policy_rpc` 결과가 필요 없다는 뜻이다. 현재 Swap Action의 `live_inputs`와 Permit2 `nonce` 같은 필수 DTO 구조까지 생략할 수 있다는 뜻은 아니다. 시험의 해당 값은 합성 입력이며 실제 시장 데이터·nonce 조회의 증거가 아니다. 스왑·Permit2 사례는 이미 해석한 Action부터 검증한다. raw approve→판정은 기존 DEC-02 시험을 재사용하며, Day-1 전체 원문 요청→판정이나 SDK `createCore()` 실행 완료를 뜻하지 않는다.

[`first-fact-contract.json`](first-fact-contract.json)은 후속 A2의 `portfolio.balance` ERC-20 경로를 선정한 개발용 인계 자료다. params·원본 응답·projection·optional·향후 오류 사례를 기록한다. Day-1에 활성화하지 않으며 직접 RPC adapter와 Core 원본 Fact 검증은 후속 구현이다. 기존 catalog의 optional 선언을 필수로 바꾸지 않는다.

## D3 사용자 실행

이번 변경은 Rust/WASM 소스를 바꾸지 않는다. 아래 두 검사는 사용자 실행으로 통과했으며 명령은 재현용으로 보존한다. 첫 명령은 정책 29개, 두 번째는 경로를 바꾼 DEC-02 7개를 실행한다. 기록 갱신을 위한 재시험·재빌드는 필요 없다.

```sh
cd /Users/spu/SDKdambi/DAMBI
npm run policy:test && npm run decoder:test:approve-policy
```

정책 29개는 이관 경계 3개 + Day-1 메타 계약 1개 + 기존 baseline 4개 + 추가 판정 11개 + 입력 누락 10개다. decoder 전체 재시험은 관련 decoder 소스 변경이나 실패가 생길 때만 확대한다. CI는 기존 WASM 빌드 결과를 재사용해 `policy:test`를 실행한다.

필요한 JS/WASM 쌍이 없거나 Rust 소스가 달라진 경우에만 직접 생성한다. Registry 의존성이 없는 경우에만 `npm ci --prefix registryV2`를 별도로 실행한다.

```sh
wasm-pack build crates/policy-engine-wasm --target web --release --out-dir pkg --out-name policy_engine_wasm
```

## C2c Native Core 회귀

`core:test:fixtures`는 DEC 인계 목록의 10개 시험 파일과 D3 두 파일을 Native `dambi-core`에 연결한다. 기존 case ID·기대값·Registry 생성·설치 조합·digest 검사는 그대로 사용한다. 기존 DEC 589개와 D3 29개를 합친 실행이며 새 지원 사례를 추가한 것이 아니다. WASM·확장·서버가 필요 없고, 바이너리나 필수 자료가 없으면 실패한다.

Rust의 정책 평가 30개·HL 26개·JavaScript가 보존하지 못하는 숫자 원문 2개도 Core로 옮겼다. HL 정책과 숫자 원문 입력은 `crates/dambi-core/tests/fixtures/` 안에 고정되어 있으며 앱 seed를 읽지 않는다. baseline은 기존 공유 원본을 그대로 사용한다. EST는 editor bridge 시험으로 기존 crate에 유지하되 생성물을 임시 디렉터리에 쓰고 삭제한다. diagnosis용 기존 fixture helper도 해당 crate 내부에만 남긴다.

사용자가 저장소 root에서 다음을 실행한다. 이관한 시험의 새 실행 경계를 확인하는 것이므로 전체 workspace 재시험이나 WASM 재빌드는 필요 없다.

```sh
cargo test --locked -p dambi-core
cargo test --locked -p policy-engine-wasm --lib diagnosis_exports::tests
cargo test --locked -p policy-engine-wasm --test est_roundtrip
cargo build --locked -p dambi-core --example fixture_runner
npm run core:test:fixtures
```

Registry 의존성은 기존 Decoder 시험과 같다. 없을 때만 `npm ci --prefix registryV2`를 실행한다. 기본 바이너리는 `target/debug/examples/fixture_runner`이며 다른 출력 위치를 쓰면 `DAMBI_CORE_FIXTURE_BIN`으로 지정한다. SDK 명령은 `DAMBI_FIXTURE_BACKEND=native`를 고정하며 자동 빌드·WASM fallback을 하지 않는다. 기존 `decoder:test`와 `policy:test`는 기본적으로 legacy WASM 비교 경로를 유지한다. CI의 Native fixture 검사는 Rust job에서 독립적으로 실행한다.

## 결과 기록

2026-09-13, 기준 커밋 `40a268c` 이후 D3 변경(공유 원본 이동·소비자 전환·정책/Fact fixture·CI 진입점)은 **사용자 제공 실행 로그 기준 검증 완료**다. `policy:test`는 **29/29 통과**(`duration_ms=445.847167`), `decoder:test:approve-policy`는 **7/7 통과**(`duration_ms=1546.184`)했으며 두 실행 모두 suites·실패·취소·건너뛰기·todo는 0이다. 중간의 `zsh: command not found: decoder:test:approve-policy`는 npm script 이름을 직접 실행한 명령 오류이며, 이후 `npm run decoder:test:approve-policy`로 정상 실행해 통과했다. 기존 정적 대조에서 Cedar/manifest 10개와 직렬화 baseline hash 불변 및 변경 JavaScript 구문을 확인했다. D3 변경은 미커밋 상태이며, 이번 기록 갱신에서는 빌드·시험·설치·커밋·푸시를 실행하지 않았다.

다음 단계는 D4 계약 초안 및 제품 snapshot 범위 결정이다. D4 상세 단계는 [기존 개발 계획](../../docs/sdk-migration/decoder-core-adapters-plan.md#d4-core에-넘길-번들고정-스냅샷)을 따른다. 첫 Fact method의 runtime 검증은 후속 Core·A2 단계에 남는다. 모든 번들 구현·정상/오류 API fixture·실제 서명 검증·Core 연결은 이번 D3 완료 범위에 포함하지 않는다.
