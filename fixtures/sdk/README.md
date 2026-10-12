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

## 번들 B1-2 — Aave

2026-10-12, Native 변경 커밋 `ec5f2d0`: Aave 3개 `array_emit.body` 선언 교정, Umbrella `restake`의 모델·Cedar 전달 및 BatchHelper venue 구분. **사용자 로그 기준 Native 5개 통과·0 실패**(Governance 3개·Umbrella 2개). 별도 모델·Cedar 단위 시험 4개의 로그는 공유되지 않았다. 후속 패키지 검증도 **4개 통과·0 실패**(기존 설치 1개·Aave WASM 3개)했다. 저장된 snapshot은 기존 801개를 보존한 804개이며 Core 거절 0개·source-context 제외 30,484개를 확인했다. 격리 source 목록에 Aave 입력을 포함했으며 원본부터의 생성 격리는 B3에 남는다. 아래 Native 명령은 재현용이며 통과한 시험은 관련 변경이 없으면 반복하지 않는다.

```sh
cargo test --locked -p policy-engine --lib lowering_v2::staking::claim_rewards::tests &&
cargo test --locked -p dambi-core --test aave_governance --test aave_umbrella
```

첫 명령은 기존 Curve 호환성과 `restake`/helper 모델·Cedar 연결 4개, 다음 명령은 Governance 3개·Umbrella 2개 시험이다. 배열 순서·U256 정밀도, 단일 tuple의 reward 목록, `false/true` 정책 전달, 빈 배열·잘못된 calldata를 확인한다. 재예치 조건을 구분하는 정책은 시험 전용이며 Day-1에는 추가하지 않는다. Governance의 Day-1 `allow`는 대응 정책이 없는 경로의 판정으로, 거버넌스 안전성 검증을 뜻하지 않는다.

[Aave 계약 소스](https://github.com/aave-dao/aave-umbrella/blob/main/src/contracts/helpers/UmbrellaBatchHelper.sol)의 `claimRewardsPermit`·`_claimRewardsPermit`·`_depositToStake`를 기준으로 재예치 요청과 최종 beneficiary를 표현했다. 실제 permit 유효성·재예치 가능 경로·수령 수량·실행 성공은 이 디코딩 시험의 범위가 아니다. 선택한 Aave 경로의 Native/WASM 검증·snapshot 편입은 완료했다.

아래 패키지 편입·WASM 검증 명령은 통과한 실행의 재현용이다. 관련 변경이 없으면 반복하지 않는다. 새 Native runner·WASM을 빌드한 뒤 기존 생성기의 엄격한 증분 추가를 사용한다. 전체 후보가 설치 검증을 통과해야 저장되며 기존 번들을 빼지 않는다. 새 artifact를 패키징한 다음 기존 snapshot 설치 시험 1개와 Aave 시험 3개를 실행한다. 결과는 위 기록과 같다.

```sh
cargo build --locked -p dambi-core --example session_runner &&
npm run core:build &&
npm --prefix registryV2 run build:decoder-snapshot -- \
  --add-manifest manifests/aave/governance/core-redeemCancellationFee@1.0.0.json \
  --add-manifest manifests/aave/governance/core-updateRepresentativesForChain@1.0.0.json \
  --add-manifest manifests/aave/umbrella/batch-claimRewardsPermit@1.0.0.json &&
node scripts/sdk/build-decoders.mjs &&
node --test --test-name-pattern="packaged (decoder snapshot|Aave)" packages/core/tests/runtime.test.mjs
```

WASM 시험은 실제 `@dambi/core/decoders`를 사용하며, 큰 정수와 `restake`/helper/수령인 조건을 읽는 시험 전용 정책으로 Native 판정과 비교한다. 조건이 없는 대조군은 allow여야 한다. 빈 배열의 warn과 잘못된 calldata의 fail-closed도 확인한다. Registry 실행 의존성을 추가하지 않았으며, 제품 Day-1 정책은 그대로다.

## 번들 B2 — 대표 풀 정적 구체화

2026-10-12, B1-2 패키지 커밋 `4aed0ec` 이후 변경: [선택 입력](pool-materialization/selection.json)에 Curve NG·Balancer V3·Uniswap V3 대표 template/context 3개를 고정했다. 기존 Registry builder의 순수 구체화 helper를 SDK 도구로 추출하고 snapshot 생성기에 `--selection` 경로를 추가했다. 원본 template 사본과 정적 context만 읽으며 RPC·resolver·index/cache 보충은 없다. 중복 ID·충돌 route·누락 입력을 거절하고, 전체 후보의 실제 Core 설치 검증이 성공해야 별도 산출물을 저장한다. 개별 JCS digest·전체 바이트 digest·선택 파일·route 수를 metadata에 남긴다. **제품 804개는 변경하지 않았다. 사용자 확인 기준 타입 검사와 구체화·생성 시험 6개, API parity 2개가 통과했다(총 8개·0 실패). 대표 3개 범위의 B2 검증을 완료했다.**

원본은 계획서 B0 표의 세 manifest와 각 protocol의 저장된 universe다. Balancer context는 Router에 대표 한 pool의 USDC/WETH map만 넣으므로 전체 resolver corpus와 동일한 digest를 주장하지 않는다. API parity는 동일한 선택 context에 대한 두 구현의 비교다. token 주소·순서는 고정했지만 별도 token metadata나 live 관측값을 합성하지 않는다. Balancer의 `weighted` 근거·`wethIsEth`, Uniswap의 미주입 slippage·가격 한계·token0 metadata, 각 경로의 raw 의미는 B3/제품 편입 전에 검증한다.

아래는 순수 구체화·생성 검증 6개와 API parity 2개다. 생성 시험은 임시 폴더에서 두 번 생성한 바이트/metadata, 실제 WASM 설치, 잘못된 후보의 기존 산출물 보존을 확인한다. B1-2에서 빌드한 Core를 재사용하므로 Rust/WASM 재빌드는 필요 없다.

```sh
npm --prefix registryV2 run typecheck &&
npm --prefix registryV2 run test:decoder-materialization &&
npm --prefix registry-api test -- src/__tests__/sdk-materialization-parity.test.ts
```

산출물을 파일로 확인할 때는 아래 명령을 별도로 사용한다. 출력은 `pool-materialization/generated/pools-preview/`이며 Git에서 제외한다. 회귀 전용 선택 입력으로 제품 snapshot을 덮어쓰거나 Core 검증을 생략할 수 없다. 원본부터의 SDK 격리 검증은 B3에 남는다.

```sh
npm --prefix registryV2 run build:decoder-snapshot -- \
  --selection ../fixtures/sdk/pool-materialization/selection.json
```

## 번들 B3 — 원문 요청과 격리 생성

2026-10-12, B2 커밋 `2bb877e` 이후 변경: 대표 풀의 raw calldata → Core → 시험용 Cedar 정책 → Verdict를 실제 Native/WASM에서 비교하는 시험 4개를 추가했다. Curve 방향·큰 U256, Balancer 토큰/금액 대응·LP 의도, Uniswap signed amount·수령인, 잘못된 calldata/route 및 Unknown을 구분한다. 시험용 정책은 메모리에서 복제·서명하며 Day-1 원본은 변경하지 않는다. **사용자 격리 검증에서 runtime 15개·check 8개 통과, 남은 실패 0개. Balancer 시험 정책 수정 후 해당 1개만 재시험했으며 기존 통과 14개는 반복하지 않았다. 같은 격리 폴더의 `core:pack`(`npm pack --dry-run`) 정상 종료도 실행 로그로 확인했다. 마지막 정적 경계 검사에서 금지 디렉터리·외부 링크가 없고 시험 수정본이 일치함을 확인해 선택 범위의 B3 검증을 완료했다. 제품 804개와 풀 3개의 회귀 전용 구분은 유지한다.**

기존 생성기는 [`scripts/sdk/build-decoder-snapshot.mjs`](../../scripts/sdk/build-decoder-snapshot.mjs) 하나로 옮겼고 Registry 명령은 wrapper로 유지했다. SDK에서는 이미 사용하는 Rust JCS를 Native runner의 `--canonicalize`로 호출하므로 새 라이브러리·서버·Registry 설치가 필요 없다. [UR/Aave 원본 5개](resolved-decoders/selection.json)를 고정해 기존 799개 기준선과 합친 결과가 제품 804개의 정확한 바이트·metadata와 같은지 검증한다. 전체 804개의 원본 재생성을 의미하지 않는다. 풀 3개는 원본 template/context부터 두 번 생성하고 그 산출물을 raw 시험에서 소비한다.

격리 도구는 새 입력과 생성기를 복사하고, Core 빌드 후 재구성한 제품을 다시 패키징해 소비한다. Registry·확장·서버 디렉터리 없이 생성부터 검증하며 기존 통합 시험도 이 새 경로에서 실행한다. 다음 명령은 Registry wrapper 타입·원본 사본 일치와 전체 격리 경로를 확인한다. 격리 도구가 필요한 Native/WASM을 자체 빌드하므로 로컬 재빌드를 먼저 할 필요는 없다.

```sh
npm --prefix registryV2 run typecheck &&
npm --prefix registry-api test -- src/__tests__/sdk-materialization-parity.test.ts &&
npm run sdk:verify:isolated
```

로컬에서 풀 시험만 디버깅할 때는 아래를 사용한다. 기존 Core WASM은 재사용하며 변경된 Native runner만 빌드한다. 위 격리 검증까지 통과했다면 이 명령을 반복할 필요는 없다.

```sh
cargo build --locked -p dambi-core --example session_runner &&
npm run bundle:verify:generation &&
node --test --test-name-pattern='selected' packages/core/tests/runtime.test.mjs
```

Balancer의 `weighted` 상수·`wethIsEth` 누락, Uniswap 가격 한계 미반영·token0 metadata 부재는 제품 편입 전 남은 사항이다. Uniswap exact-input의 Cedar `slippageBp=10000`은 최소 출력 0에서 도출한 값이며 실제 시세 관측이 아니다. 위 시험의 allow/deny는 입력 보존과 정책 연결의 증거로, 거래 실행 가능성이나 가격 검증의 증거가 아니다.

## 번들 B4 — 어댑터 인계

2026-10-12, B3 `cb3d52b` 기준: [제품·요청 범위](../../contracts/core-v1/snapshot-selection.proposal.json)와 [첫 Fact 계약](first-fact-contract.json)을 현재 코드에 맞춰 갱신하고 A1/A2 운영 설정의 담당·확인 시점을 연결했다. JSON 구문·참조 경로·기존 snapshot metadata 정합성을 확인했다. 런타임 변경이 없어 빌드·기능 시험은 반복하지 않았다. 남은 작업은 어댑터 세부 계획·HTTP/RPC 구현 및 실제 통합 검증이다.

## 어댑터 A1-1 — 정책 HTTP 기본

2026-10-12, `feat/adapters`의 A1-1 변경: `@dambi/core/adapters` 진입점, 정책 wrapper 원문 보존, URL·형식·byte 상한·오류·취소 처리와 격리/릴리스 시험 연결을 구현했다. 로컬 HTTP 시험 **8 passed / 0 failed**, TypeScript 빌드·소비자 타입 검사·릴리스 workflow actionlint·diff 검사를 통과했다. package dry-run으로 어댑터 코드/타입 포함과 시험 파일 제외를 확인했다. 전체 격리 빌드와 원격 CI는 이번 변경에서 실행하지 않았다. 다음은 A1-2의 ETag·실제 Core init/refresh 연결이며 실제 배포 API 확인은 A1-3에 남는다.

## 어댑터 A1-2 — ETag·Core 연결

2026-10-12, A1-2 변경 범위(ETag 재사용·동시 요청/취소·Core init/refresh 연결)에 대해 사용자 실행 `core:test:adapters` **16 passed / 0 failed / 0 skipped**. 알려진 실패는 없으며 실제 배포 API 확인(A1-3)은 남아 있다.

## 어댑터 A1-3 — 실제 API 연결

2026-10-12, 만료 문제 조치 후 `core:verify:policy-api` 재실행 **passed**: policy sequence 8, Core init/refresh 성공(HTTP 200→304), 두 단계 모두 unlimited approve `warn`·Fact 0개. 발행 10월 12일 14:53:34 KST, 유효기한 10월 15일 14:53:34 KST. 재발행 Job과 나이 확인 Job의 최근 실행 성공 및 스케줄 활성화(매일 03:00 / 매시간 17분, Asia/Seoul)를 조회했다. 일일 Scheduler의 첫 실행 이력은 아직 없고, Node에서 ETag CORS 노출은 관찰되지 않아 브라우저 소비는 A3에 남는다.

## 어댑터 A2-1 — Fact 입력·EVM codec

2026-10-12, A2-1 변경 범위(입력 검증·ERC-20 ABI·BigInt/U256·JSON-RPC codec)에 대해 사용자 실행 **8 passed / 0 failed / 0 skipped**. 알려진 실패는 없으며 HTTP 조회·FactBatch 조립은 A2-2에 남는다.

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

Fact 0개는 `policy_rpc` 결과가 필요 없다는 뜻이다. 현재 Swap Action의 `live_inputs`와 Permit2 `nonce` 같은 필수 DTO 구조까지 생략할 수 있다는 뜻은 아니다. 위 D3 시험의 해당 값은 합성 입력이며 실제 시장 데이터·nonce 조회의 증거가 아니다. D3 자체는 Action부터의 검사이며, 이후 Core 실행과 UR raw swap 사례 등 현재 검증 범위는 위 B1~B3 기록 및 [B4 인계](../../contracts/core-v1/snapshot-selection.proposal.json)를 따른다.

[`first-fact-contract.json`](first-fact-contract.json)은 후속 A2의 `portfolio.balance` ERC-20 경로를 선정한 인계 자료다. B4에서 현재 공개 `PlannedCall`·`FactBatch`·provenance 계약에 맞췄다. Core의 원본 Fact 검증·projection·cache는 C5/C6에서 구현됐으며 직접 RPC adapter와 실제 조회 검증은 A2에 남는다. Day-1에는 활성화하지 않고 기존 catalog의 optional 선언도 유지한다.

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
