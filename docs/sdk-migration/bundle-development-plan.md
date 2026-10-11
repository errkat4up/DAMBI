# 번들 세부 개발 계획 — Core 이후 제품 번들

작성일: 2026-10-05. 수정일: 2026-10-12. 문서 상태: 단계별 구현 진행. 현재 기준: `main 7387536`, 패키지 **0.1.0**. 최초 작성 기준은 C1~C6 완료 당시의 `e53ad4e`·Core v0.0.1이었다. 상위 계획의 **D4-2 제품 선택·D4-3 재현 생성**을 구체화하며, 아래 B0~B4는 이 문서 안의 작업 구분이다. 이번 작업에서 패키지 버전은 변경하지 않는다.

진행 순서는 **번들 범위 확정 → 필요한 호환성 보완 → 재현 생성·원문 요청 검증 → 어댑터 세부 계획·구현**이다. 선택한 범위를 완료하면 어댑터 단계로 넘어간다. Registry 전체를 지원하는 것이 어댑터 착수 조건은 아니다.

관련 문서: [전체 계획](decoder-core-adapters-plan.md) · [Core 계획](core-development-plan.md) · [Decoder 설계](decoder-design-plan.md) · [기존 제품 선택안](../../contracts/core-v1/snapshot-selection.proposal.json).

## 1. 현재 상태와 이번 작업의 경계

| 항목 | 확인된 상태 | 번들 단계에서 할 일 |
| --- | --- | --- |
| Core 실행부 | C1~C6 구현·검증 완료. 현재 패키지 0.1.0에 `@dambi/core/decoders` 추가 | 필요한 Decoder 호환성만 보완. Core 전체 개발을 다시 시작하지 않음 |
| 제품 snapshot | UR 편입 후 패키지 snapshot 801개 포함. 이전 11개 manifest·USDC 4개 선택안은 여전히 fixture 기반 제안 | 현재 snapshot을 기준으로 추가 지원 경로를 구체화. 이전 선택안으로 기존 799개를 축소하지 않음 |
| 생성 경로 | [Registry 생성기](../../registryV2/scripts/build-decoder-snapshot.ts)와 [SDK 패키징](../../scripts/sdk/build-decoders.mjs) 구현됨 | 생성된 index·기존 Core dist 의존과 source-context 제외를 보완. 원본부터 SDK 독립 재현 생성은 남음 |
| 풀별 번들 | Registry에 template/context 구체화(materialization) 로직이 있음. Core는 완성된 V3 bundle만 받음 | 정적 풀 정보를 빌드 시 채워 넣고 현재 Registry와 결과 일치 확인 |
| Universal Router 2개 | B1-1 검증기 보완·대표 Native/WASM 경로 검증·snapshot 편입 완료 | 필드의 엄격한 검증과 실제 `execute` 회귀를 추가. 시장 데이터 보강과 구분 |
| Aave 3개 | `array_emit.per_item_body` 선언과 Core가 읽는 `emit.body`가 불일치 | Registry 선언 교정 및 실제 Action 의미 확인 |
| 외부 데이터 | 정책 Fact 포트는 구현됨. 구체적인 HTTP/RPC 어댑터는 미구현 | 필요한 데이터와 소비 시점을 정리해 A 단계로 인계 |
| 정책 publisher | 공유 `policy-bundles/`와 SDK loader를 읽도록 수정됨 | 경로 수정 재구현 없이 실제 A1 전송·운영 검증으로 인계 |

현재 [snapshot 메타데이터](../../packages/core/decoder-snapshots/full/snapshot.meta.json)는 **source-context 제외 30,484개·Aave 거절 3개**를 기록한다. 기존 799개에 UR 2개를 증분 편입했으며 전체 Registry를 재생성하지 않았다. 제외 수를 고유 풀 수나 지원 요청 수로 사용하지 않는다. 원본 포함, snapshot 설치 성공, 원문 요청 해석, 정책 판정 검증을 각각 구분한다.

B1-1 대표 UR 경로의 호환성·Native/WASM 회귀·증분 편입을 완료했다. 다음은 B1-2 Aave 선언·의미 보완이다. 실제 API/RPC 연결과 풀별 확대는 후속 범위다.

## 2. 책임과 유지할 계약

| 책임 | 담당 위치 | 기준 |
| --- | --- | --- |
| manifest 선언·정적 원본 | `registryV2/manifests/` 및 선정된 token/pool 자료 | 프로토콜 의미와 canonical 선언을 바로잡음 |
| 빌드 시 구체화·출력 | `scripts/sdk/`와 필요한 순수 공통 helper | 서버·확장 앱을 실행하거나 import하지 않고 선택 입력을 처리 |
| 설치·해석·평가 | `crates/dambi-core/`, 필요한 공통 Action 모델, `packages/core/` | 엄격한 검증·원자적 설치·기존 Unknown/partial 및 오류 계약 유지 |
| 정책 HTTP·Fact RPC | 후속 `packages/core/src/adapters/` | 현재 `PolicySource`·`FactProvider` 계약에 연결. 정책 판정을 대신 계산하지 않음 |

- 공개 Decoder 입력은 [DecoderSnapshot](../../packages/core/src/types/config.ts)의 `artifact`와 `expectedDigest`다. 컨테이너는 `{ schema_version: 1, bundles: [완성된 V3 bundle, ...] }`를 유지한다. 제품 선택표나 인계 메타데이터를 컨테이너에 임의로 추가하지 않는다.
- 개별 `bundle_sha256`은 **구체화가 끝난 bundle의 JCS 바이트**, `expectedDigest`는 **전체 artifact의 정확한 UTF-8 바이트**를 해시한다. 두 값을 혼용하지 않는다. 생성된 digest는 검토 후 신뢰하는 로컬 설정에 고정하며 artifact가 주장한 값만으로 신뢰하지 않는다.
- 정책은 [Day-1 공유 원본](../../policy-bundles/day1-safety/package.json)의 5개 내용·severity를 유지한다. 현재 외부 정책 Fact는 0개다. A2 시험용 `portfolio.balance` 정책을 제품 정책에 자동 추가하지 않는다.
- 정책 payload B의 원문 서명, `registry_ref: null`, policy/decoder 키 역할 분리도 유지한다. 런타임 Registry 검색이나 동적 bundle 설치를 이번 생성기로 도입하지 않는다.

## 3. B0 — 지원 범위와 데이터 의존성 확정 (D4-2)

**목표:** 생성 입력과 실제 지원 요청을 함께 결정한다. 기존 선택안을 출발점으로 사용하되 다음은 아직 권장 후보이며 승인된 제품 범위가 아니다.

**착수 범위(2026-10-12):** 현재 패키지의 799개를 설치 기준선으로 유지한다. 우선 구현은 상위 Core 계획 D4-3a의 UR 2개 검증기 보완이며, Native 원문 회귀는 mainnet의 두 execute selector·대표 V3/V4 ABI 경로에 한정한다. 다른 체인·opcode·시장 데이터까지 지원 완료로 확대하지 않는다. Aave의 `restake` 표현과 대표 풀의 제품 편입은 조사 후 결정한다. B0 전체 완료와 독립적인 호환성 수정의 착수를 구분한다.

| 후보 | 권장 순서·범위 | 확정할 내용 |
| --- | --- | --- |
| 기존 DEC-07 경로 | 11개 manifest와 USDC 4개를 기본 후보로 검토 | approve/transfer 대상, USDC strict Permit, Permit2 v3 한계, NFPM/Morpho의 제품 포함·회귀 전용 구분 |
| Universal Router | deadline 유무가 다른 `execute` 2개를 우선 보완 | 지원 chain/배포 주소, 검증할 command 조합·하위 경로. 두 manifest 설치를 모든 opcode 지원으로 표기하지 않음 |
| Aave | 거절된 3개 선언 교정 및 의미 검증 | 각 요청의 제품 포함 여부, Umbrella `restake` 표현·지원 범위 |
| Curve·Balancer·Uniswap 풀 | 프로토콜별 대표 template/context부터 생성·검증 | 정확한 chain/pool/token 입력과 이후 확대 범위. 전체 30,484개 일괄 포함은 별도 판단 |
| Day-1 정책 | 현재 5개 유지 | 각 정책을 검증할 raw 요청과 기대 판정, 아직 raw 경로가 없는 사례 |

정적 자료가 확인된 B2 대표 후보는 아래와 같다. 모두 chain 1이며, 후보 지정 자체가 제품 지원 승격은 아니다.

| 후보·호출 경로 | 저장된 입력 | 남은 의미 검증 |
| --- | --- | --- |
| Curve StableSwap NG `exchange`, `0x3df02124`, pool `0xd001ae433f254283fece51d4acce8c53263aa186` | [manifest](../../registryV2/manifests/curve/stableswap-ng/zz-source-factory-stable-ng-2coin-mainnet/exchange@1.0.0.json) · [pool universe](../../registryV2/surface/curve/_pool_universe.json), USDC/RLUSD coins 순서 | index i/j·금액·수령인 및 live 값과 기본값 구분 |
| Balancer V3 `addLiquidityProportional`, `0x724dba33`, Router `0xae563e3f8219521950555f5962419c8919758ea2` | [manifest](../../registryV2/manifests/balancer/v3/router-add-liquidity-proportional@1.0.0.json) · [pool universe](../../registryV2/surface/balancer/_pool_universe.json), pool `0xda66e8ddf9959e4db759bfd06256730d8a8b2d13`의 USDC/WETH | pool→tokens map과 배열 길이. manifest의 `pool_type: weighted`는 별도 근거 확인 필요 |
| Uniswap V3 직접 pool `swap`, `0x128acb08`, pool `0x2c40c7b9f106f39a6e2aab6d9f1f29364e7250bc` | [manifest](../../registryV2/manifests/uniswap/v3-pool/swap@1.0.0.json) · [address universe](../../registryV2/surface/uniswap/_address_universe.json)의 token0/token1·fee·tick spacing | token 방향·signed amount, 미주입 slippage 기본값. token0의 별도 token metadata는 없음 |

Balancer universe의 `disposition: exclude`는 직접 callkey 대상 제외를 뜻한다. Router의 정적 pool→tokens context 사용과 구분한다. 정적 입력 수집과 live 데이터 조회를 혼합하지 않는다.

기존 USDC token 목록은 approve/transfer 대상 확장용이다. Permit2 내부 token, NFPM pair, Morpho market의 허용 목록으로 전용하지 않는다. 추가 pool/token을 포함할 때 다른 정책의 적용 범위가 자동으로 같은 대상까지 확장된다고 가정하지 않는다.

선택 항목마다 `request kind·chain·target·selector/typed domain·하위 경로·필요 데이터·검증 사례·제한`을 연결한다. 상태는 **제품 포함 / 회귀 전용 / 미지원**으로 구분한다. 미지원 경로는 문서 표시만으로 막히지 않으므로 실제 생성·설치·요청 수용 경계를 확인하고 필요한 제한을 B1에 포함한다.

### 데이터 소비 시점 구분

| 분류 | 예시 | 처리 원칙 |
| --- | --- | --- |
| 빌드 입력 | token 주소, pool의 coins/context, 배포 주소 | 검토한 정적 입력에 고정하고 B2에서 구체화 |
| 로컬 도출값 | calldata와 정적 주소로 계산 가능한 pool/path, 현재 Core의 `$resolved` 계산 | 기존 구현을 확인해 재사용. 외부 RPC 요구로 중복 분류하지 않음 |
| Decoder의 live 선언·값 | `live_inputs`/LiveField, 가격·풀 상태·예상 출력 등의 참조 | 선언만 보관되는지, Action 구성에 값이 필요한지, placeholder인지 경로별 확인 |
| plan 이후 정책 Fact | `portfolio.balance` 등 `plan.calls` | 기존 `FactProvider`에서 수집하고 Core가 projection·필수/선택·판정을 처리 |

`live_inputs`가 있다는 이유만으로 모두 RPC 의존이라고 판단하지 않는다. 반대로 Day-1 정책 Fact가 0개라는 이유로 Decoder 데이터가 완비됐다고 판단하지 않는다. **현재 `check()`는 디코딩·plan 생성 후 `plan.calls`만 FactProvider로 보낸다. 디코딩에 먼저 필요한 값을 이 포트가 자동으로 공급하지 않는다.**

**현재 구현의 제한:** [Mapper](../../crates/adapters/mappers/src/declarative/action_builder.rs)의 `$resolved`/`$derived` 처리는 알려진 placeholder가 미주입되면 타입별 0 기본값을 반환한다. UR V3 child의 token/path·fee는 calldata에서 도출하지만, pool·slippage와 LiveField skeleton은 실제 관측값이 아닐 수 있다. 따라서 미주입은 항상 실행 오류라는 가정을 버리고, raw 회귀의 판정이 의존하는 필드를 구분한다. 기본값 제거·미확인 값 표현·보강 포트는 별도 계약 판단이며 B1-1에서 전역 Mapper 동작을 변경하지 않는다.

추가 외부값 없이는 선택한 요청을 올바르게 해석할 수 없다면, 정적/로컬 도출로 해결 가능한지 먼저 확인한다. 불가능하면 해당 경로의 보강 계약을 별도로 확정하거나 제품 범위에서 제외한다. 새로운 공개 포트·Action 의미 변경은 구체 입력과 대안을 제시해 결정하고, 0·가짜 가격·placeholder를 실제 조회값으로 취급하지 않는다.

**완료 조건:** 기존 선택안에 결정과 정확한 입력·지원 경로를 반영하고, 경로별 데이터 의존성과 미지원 사유를 확정한다. 기존 선택안의 C1~C6 이전 상태 설명도 이때 정리한다. 범위 미확정 상태로 제품 전체 생성에 들어가지 않는다.

## 4. B1 — 선택 번들의 선언·Core 호환성 보완 (D4-3 선행)

### B1-1 Universal Router

대상은 [execute-v2](../../registryV2/manifests/uniswap/universal-router/execute-v2@1.0.0.json)와 [execute-v2-no-deadline](../../registryV2/manifests/uniswap/universal-router/execute-v2-no-deadline@1.0.0.json)다.

- [snapshot 검증기](../../crates/dambi-core/src/snapshot/decoder.rs)의 dispatch entry에 `inputs_abi_alternatives` 배열·원소 타입·각 ABI 구문 검사를 추가한다. 중첩 dispatch에도 같은 기준을 적용하고 다른 미지원 필드를 포괄 허용하지 않는다.
- [Decoder 실행부](../../crates/dambi-core/src/decode/mod.rs)의 primary → alternative 해석 순서를 보존한다. Registry 필드를 지워 설치만 통과시키지 않는다.
- 실제 snapshot 설치 후 raw `execute`를 입력해 선택한 primary/alternative 경로의 Action과 판정을 확인한다. 기존 helper 시험만으로 전체 경로 완료를 선언하지 않는다.

이번 변경은 opcode dispatch에만 alternatives를 허용한다. 이를 소비하지 않는 tagged 계열은 계속 거절한다. raw 회귀는 수령인 기반 Day-1 정책과 ABI 수량/토큰 필드를 확인하며, pool/slippage/live 기본값을 정상 시장 데이터로 인증하지 않는다. 패키지 snapshot의 WASM·Native 판정 비교와 잘못된 nested ABI 거절 시험도 사용자 검증을 마쳤다.

### B1-2 Aave

대상 manifest는 다음 3개다.

- [core-redeemCancellationFee](../../registryV2/manifests/aave/governance/core-redeemCancellationFee@1.0.0.json)
- [core-updateRepresentativesForChain](../../registryV2/manifests/aave/governance/core-updateRepresentativesForChain@1.0.0.json)
- [batch-claimRewardsPermit](../../registryV2/manifests/aave/umbrella/batch-claimRewardsPermit@1.0.0.json)

`array_emit.per_item_body`를 Core의 canonical `body` 선언에 맞추고 실제 배열 입력의 항목·순서·필드 매핑을 검증한다. 다른 strategy까지 일괄적으로 body를 요구하지 않는다. 현재 ABI bridge의 단일 tuple 평탄화도 고려해 `$args` 경로를 확인한다.

Umbrella의 `restake`는 현재 [ClaimRewardsAction](../../crates/asset-model/action/src/staking/claim_rewards.rs)에 표현 필드가 없다. 필드를 삭제해 통과시킨 뒤 의미가 보존됐다고 선언하지 않는다. B0에서 정한 지원 범위에 따라 모델·mapper·schema 보완 또는 명시적인 제한을 적용하고, `restake` 값에 따른 결과를 확인한다.

**완료 조건:** 선택 manifest의 설치·실제 요청 의미가 일치하고, 잘못된 ABI/필수 입력을 계속 거절한다. 설치 검증을 완화하는 것만으로 완료하지 않는다. 변경한 Core/공통 모델에 관련된 기존 회귀도 유지한다.

## 5. B2 — 정적 입력 구체화와 재현 생성 (D4-3)

**목표:** 같은 선택 입력으로 같은 snapshot 바이트를 생성한다.

1. B0의 manifest·token·정적 pool context와 필요한 builder 의존만 입력 목록으로 고정한다. 필요한 자료가 없으면 수집 출처·chain/address·관측 기준을 확인해 별도 고정 입력으로 준비한다. 재현 생성 중 RPC·서버·기존 cache에서 값을 보충하지 않는다.
2. [Registry builder](../../registryV2/scripts/build-index.ts)의 `buildMaterializedFromSource`와 [API materializer](../../registry-api/src/server.ts)의 의미를 기준으로 순수 helper를 재사용하거나 추출한다. SDK 생성기에서 서버 모듈 전체를 import하지 않는다.
3. `$source.*` 치환, context 검증, ID suffix, chain/address match를 완성한다. 미해결 placeholder·누락 context·중복 ID·경합 route는 오류로 처리한다. template/context/ref index를 Core 설치 입력으로 그대로 넘기지 않는다.
4. 기존 `registryV2/scripts/build-decoder-snapshot.ts`의 수집·정렬·JCS·Core 설치 검증을 재사용하고 원본 입력 처리와 순수 helper를 SDK 쪽으로 분리한다. `scripts/sdk/build-decoders.mjs`의 고정 artifact 패키징 역할은 유지한다. 새로운 병렬 생성기를 중복 구현하지 않으며, 최종 진입점 위치는 분리 결과에 맞춘다. 생성 시각·로컬 절대 경로 등 비결정적 값을 artifact에서 제외한다.
5. 완성된 container와 별도 생성 요약에 개별 JCS digest·전체 artifact digest·선택 입력·포함/지원 경로를 연결한다. 필요한 생성 입력의 고정 정보를 남기되 매 단계 전체 소스 해시나 Git 스냅샷을 수집하지 않는다.

[기존 materialization parity 시험](../../registry-api/src/__tests__/materialization-parity.test.ts)의 비교 원칙을 재사용한다. 로컬에 전체 생성 corpus가 없으므로 전체 Registry sweep 성공을 전제로 삼지 않고, 선택한 concrete/ref/context 대표 사례를 같은 원본으로 대조한다. fixture의 기대 결과는 새 생성기를 그대로 한 번 더 호출해 만들지 않는다.

현재 생성기는 Core가 거절한 항목을 `rejected_by_core`에 기록하고 제외한 뒤 재시도한다. 제품 선택이 확정된 생성 경로에서는 필수 선택 항목이 빠지면 실패해야 한다. 이 감사용 제외 동작을 제품 지원 충족으로 취급하지 않는다. 기존 799개 설치 기준선의 의도하지 않은 축소도 검사한다.

snapshot은 Core의 `maxDecoderBytes`, route 설치 개수 65,536, routing 문자열 총량 32 MiB 제한을 만족해야 한다. 선택 결과의 실제 바이트·설치 route 수를 확인한다. 전체 corpus 확대 때문에 한도를 올리거나 분할·로딩 API가 필요해지면 별도 설계 판단으로 남긴다.

**완료 조건:** 고정 입력으로 반복 생성한 바이트·digest가 같고, 선택한 Registry 구체화 결과와 개별 digest가 일치하며, 실제 Core에 전체 snapshot이 설치된다. 잘못된 한 항목이 섞인 경우 부분 설치하지 않는다.

## 6. B3 — 제품 요청 검증과 SDK 소스 독립성 (D4-3)

| 검증 대상 | 필요한 증거 |
| --- | --- |
| 선택·생성 경계 | 선택하지 않은 입력의 자동 편입 없음, 누락/경합/잘못된 context 거절, 미지원 경로 제한 적용 |
| snapshot 신뢰·설치 | 정확한 바이트 digest 확인, 변조·잘못된 ABI·미해결 source 거절, 전체 원자적 설치 |
| 실제 요청 | 선택된 경로별 raw calldata/typed-data → 실제 Core Action → 기대 Verdict. chain/주소/수량/수령인·배열 순서 등 해당 변경의 핵심 의미 확인 |
| 정책 연계 | Day-1 정책별 raw 사례를 매핑. 특히 swap 수령인 self/other의 기대 판정을 확인하고 합성 Action 검증과 구분 |
| 실패·부분 해석 | malformed 전체 오류와 Unknown/partial 구분, 이미 해석한 정책 deny 보존. 누락 데이터로 거짓 정상값을 만들지 않음 |
| Native/WASM 일치 | 대표 구체화·UR/Aave 경로를 실제 Native와 SDK 자체 WASM에서 비교. 모든 조합을 양쪽에 중복 나열하지 않음 |
| 격리 재현 | 선택 원본·생성 helper·제품 fixture를 [SDK source 목록](../../scripts/sdk/sdk-source-files.json)에 포함하고 기존 격리 도구에서 제품 snapshot 생성·소비까지 검증 |

외부 데이터가 필요한 시험은 출처와 형식이 분명한 고정 mock을 사용하고 **실제 RPC/API 통합 성공과 구분**한다. Decoder/정책 엔진·서명 검증 자체는 mock하지 않는다. B0에서 해결하지 못한 디코딩 선행 데이터 문제를 mock으로 가려 제품 지원으로 표시하지 않는다.

시험은 구현한 변경과 연결된 기존 회귀만 실행한다. 생성 명령과 관련 시험 명령은 실제 scripts가 추가된 시점에 사용자에게 제공한다. 소스 목록·생성기 변경 후에는 기존 `npm run sdk:verify:isolated`를 확장해 사용자 실행으로 확인한다. 이 검증도 실제 tarball의 외부 프로젝트·브라우저 소비나 배포 완료를 대신하지 않는다.

**완료 조건:** B0에서 제품 포함으로 확정한 경로의 검증이 통과하고 제한이 명시된다. 결과는 [SDK fixture README](../../fixtures/sdk/README.md)에 변경 범위·통과/실패 수·남은 문제만 짧게 기록한다. 이 계획에는 단계 상태만 갱신하고 [coverage](../../fixtures/decoder-policy/coverage.md)는 지원/제한이 바뀔 때만 갱신한다.

## 7. B4 — 어댑터 세부 계획에 넘길 완료 기준

다음 자료가 연결되면 `adapter-development-plan.md`를 새로 작성하고 A1부터 구현한다(문서 경로는 예정). 인계 내용은 기존 선택안·fixture·현재 포트 타입을 참조하며 동일한 계약을 여러 문서에 복제하지 않는다.

| 인계 항목 | 확정할 내용 | 어댑터 단계의 사용처 |
| --- | --- | --- |
| 제품 선택과 snapshot | 고정 입력, artifact·신뢰하는 digest, 지원/미지원 raw 경로, 검증 사례 | 어댑터 시험의 동일한 Core 설정과 Decoder 입력 |
| 정책 전송 | [PolicySource](../../packages/core/src/ports/policy.ts), HTTP `{ payload, signature, key_id? }` → SDK `keyId?`, B 문자열 보존 | A1 URL·HTTP·취소·오류·실제 API 통합 |
| 정책 발행 | publisher의 공유 `policy-bundles/`·SDK loader 전환은 구현됨. 실제 payload·키·환경 검증 상태를 인계 | A1 실제 연동 확인. 시험 키를 운영 신뢰로 사용하지 않음 |
| 정책 Fact 목록 | method별 resolved params·원본 응답 형식/단위·chain·block·freshness·오류·optional/required·projection·소비 시점 | A2 첫 method와 A3 추가 method 선정 |
| Decoder 보강 의존 | 정적/로컬 도출/LiveField 선언/외부값 구분, 필요한 경우 확정한 별도 계약, 미지원 경로 | 디코딩 선행 데이터를 FactProvider와 혼합하지 않도록 설계 |
| 통합 환경 | 실제 endpoint·로컬 신뢰 키·인증 적용 여부·chain 라우팅·환경별 설정의 확인 담당과 미확정 값 | 실제 값은 A 단계에서 확인. 미확정 환경을 통합 완료로 표기하지 않음 |

### A 단계로 이어지는 순서

1. **A1 Policy API:** 현재 포트를 구현하고 실제 서명 payload를 Core에 전달한다. wrapper 이름만 매핑하며 B 내부를 보정하지 않는다. 수정된 publisher를 기준으로 실제 환경·키 설정과 공동 통합을 확인한다.
2. **A2 첫 Fact:** [기존 첫 Fact 자료](../../fixtures/sdk/first-fact-contract.json)의 `portfolio.balance` ERC-20 `balanceOf(owner)`부터 구현한다. 현재 [FactProvider](../../packages/core/src/ports/fact.ts)의 opaque `callId`/`planId`, 원본 응답 `{ balance: "0x64" }`, U256 정밀도, `source`, Unix ms `observedAt`, 실제 조회 block provenance를 따른다. 과거 자료의 완료 상태·call ID 예시는 현재 공개 타입에 맞춰 정리한다.
3. **A3 필요한 확장·전체 연결:** B0/B4의 의존 목록에서 실제 필요한 method만 추가하고 raw 요청 → 정책 API → Core plan → Fact → Verdict를 Node/브라우저에서 연결한다. 별도 Decoder 보강 계약이 필요하면 명시된 순서에 포함한다.

`portfolio.balance`의 기존 catalog `optional` 의미를 유지하며 실패를 잔고 0으로 바꾸지 않는다. 원본 RPC ABI word를 의미 응답으로 해석하고, projection은 Core에 맡긴다. cache에서도 최초 관측 시간을 보존하고, 실제 확인하지 않은 block 번호를 만들지 않는다.

**어댑터 착수 조건:** 선택 범위·생성 snapshot·raw 검증·데이터 인계가 완료되고, 포함된 경로의 디코딩 선행 데이터 계약에 미결 사항이 없어야 한다. 제외된 경로의 제한이나 A1/A2에서 해결할 운영 환경·네트워크 작업은 담당과 완료 시점을 적어 넘긴다. 전체 Registry 확대, 실제 외부 서비스 연결 완료, 최종 패키지 배포를 번들 단계의 추가 선행 조건으로 만들지 않는다.

## 8. 단계 상태

| 단계 | 상태 |
| --- | --- |
| 세부 계획 | 작성 완료 |
| B0 지원 범위·데이터 의존성 확정 | 기존 799개 기준선·UR 착수 범위·정적 풀 후보 조사. 제품 확대·데이터 보강 계약은 미확정 |
| B1-1 UR snapshot 검증·raw 회귀 | 대표 Native/WASM 경로 사용자 검증·snapshot 편입 완료. [결과·명령](../../fixtures/sdk/README.md#번들-b1-1--universal-router) |
| B1-2 Aave 및 의미 보완 | 미착수 |
| B2 정적 입력·구체화·재현 생성 | 기존 생성기에 지정 manifest 증분 추가 구현. 원본 독립 생성·context 보완 미착수 |
| B3 raw 경로·정책·격리 검증 | UR 패키지 회귀 입력을 격리 source 목록에 포함. 원본 생성부터의 격리 검증은 미완료 |
| B4 어댑터 인계 확정 | 미착수. 완료 후 어댑터 세부 계획 작성 |

다음은 **B1-2 Aave 선언·의미 보완**이다. B0의 미결 의미·범위는 해당 경로의 제품 편입 전에 해결한다. UR Native 통과를 B1 전체 완료로 표시하지 않는다.
