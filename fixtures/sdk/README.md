# SDK 정책 입력과 Native 회귀

## Scam Filter — SF0 연결 정보 확인

2026-10-19, [계획서 SF0-1](../../docs/scam-filter/mvp-design-plan.md#sf0-1--연결-대상측정-근거-확인) 범위에서 전달받은 연결 정보와 대표 거래를 공개 RPC에 읽기 전용으로 대조했다. **수동 RPC 확인 6개 항목 일치·0개 불일치:** 체인 ID, pair의 factory, factory의 getPair, token0·token1 구성, 대표 거래의 블록·성공 상태, pair의 Sync→Swap 순서. 자동화 시험 통과 수나 전체 DEX 검증을 뜻하지 않는다.

- 연결: GIWA Sepolia `91342`, `https://sepolia-rpc.giwa.io/`, 조회 User-Agent `curl/8.5.0`.
- factory: `0xd51d7c2a3b9b0f6876336c165adda94468500c47`; 대표 pair: `0xcaafb95fc292c10a526f03fa480407bb438dac67`.
- token0: `0x0274c57358c3a6b8a08b7297ba51665c303a471f`; token1·quote(WETH): `0x4200000000000000000000000000000000000006`.
- 주소 관계의 기준 블록: `39,055,355` (`2026-10-19T09:01:11Z`), 해시 `0x80e9bde215739cc0211e75b6c77440989b687d1ea02772314aa87e17c3d3732f`. 해당 블록의 `pair.factory()`와 `factory.getPair(token0, token1)`이 위 주소와 일치했다.
- 대표 Swap: `0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9`, 블록 `39,044,394`, receipt `status=1`; 위 pair의 log index `14→15`에서 Sync→Swap을 확인했다. 실제 호출 대상은 `0x50d356c7793d41c8b1d2a668f880d3a87aace649`, calldata selector는 `0x7ff36ab5`이며 당시 미확인한 Decoder 연결은 아래 SF0-3에 기록한다.
- 제공 자료 검토: [giwa_handoff.tgz](/Users/spu/SDKdambi/giwa_handoff.tgz)의 Python 스크립트 5개·`giwa_pairs.json`·`giwa_collect2_run.log` 총 7개 파일을 읽었다. 스크립트는 실행하지 않았으며 압축 내용을 작업 폴더에 풀지 않았다. JSON의 수집 head는 `39,042,771`, 중복 없는 페어 42개이며 대표 pair·토큰 주소는 위 대조 결과와 일치한다. 수집 head와 주소 검증 head를 같은 시점으로 합치지 않는다.
- 수집 근거: 스크립트의 RPC·factory·User-Agent, V2 selector/topic과 검증 대상 주소를 확인했다. 완전한 ABI JSON·배포 소스 출처는 미포함이다. 비페어 Sync 탐색 대상은 `0xad153c844ccac3d2ea991170624200e54730be74`이며, 서비스에서는 기존 계획대로 검증된 페어 주소로 로그를 제한한다.
- 실행 로그 범위: `giwa_collect2.py`는 기록된 `pairBlock`부터 `min(pairBlock + 259,200, head)`까지 10,000블록씩, 동시성 3으로 조회한다. 3개 페어 각각 26조각·실패 0·재시도 0, 소요 0.8/0.8/4.2초로 기록됐다. HYANGNO는 34개 이벤트 요약이다. 이는 블록을 시간으로 환산한 약 72시간 수집이며, 24시간 SDK 성능·timeout 비율을 입증하지 않는다.
- 자료 해석 제한: `giwa_collect.py`의 생성 블록 이진 탐색은 RPC 오류·누락을 코드 없음으로 처리한다. 따라서 이 자료만으로 `pairBlock`을 검증된 생성 시점·시장 나이 A·첫 72시간의 확정 경계로 사용하지 않는다. 대표 페어의 `31,390,683`은 이후 SF0-3에서 별도 PairCreated 근거로 확인했으며 다른 페어까지 검증한 것은 아니다. `giwa_collect2.py`의 활동 조회도 실패를 빈 목록으로 바꿀 수 있고, WETH 방향을 심볼로 고르므로 서비스에 그대로 재사용하지 않는다.
- 누락·증빙 범위: 유동성 샘플링은 2,126/2,126/1,740개 요청 중 0/3/3개 실패가 기록되어 있다. 누락을 제외한 곡선의 급감·회복 수치는 참고값이다. 최대 로그 한도·1초 간격·head−100만 블록 응답·기존 24시간 지연/재시도 비율의 원응답은 미포함이다. 원천 이벤트 JSON과 전체 reserve 시계열도 없어 이 압축파일만으로 SF0-4의 고정 replay 입력이 준비된 것은 아니다.
- SF0-1 검토 범위: 자료 검토는 완료했지만 위 보고값을 독립 검증 완료로 승격하지 않는다. 당시 빌드·시험·RPC 재조회·커밋·푸시는 하지 않았으며, 이후 확장 Service Worker 실행 결과는 아래에 기록한다. Decoder 연결·고정 입력 준비는 별도다.
- 후속 검증 범위: 생성 시점·RPC 한도·누락 처리 등은 기존 SF4 데이터 계약에 따라 필요한 범위만 검증하며 새 보고서·400개 표본 조사·전체 재측정을 선행 조건으로 추가하지 않는다. 전체 진행 상태는 계획서에만 표시한다.

### SF0-2 확장 RPC 접근 확인

2026-10-21, 사용자가 [giwa-sw-rpc-check.js](../../browser-extension/scripts/giwa-sw-rpc-check.js)를 실행해 전달한 콘솔 결과를 검토했다. **실제 Service Worker RPC 조회 3개 통과·0개 실패**, 모두 HTTP 200·`stage=result`, 최종 `passed=true`다. 실행 기준 시각은 `2026-10-20T20:25:01.821Z`(한국시간 **2026-10-21 05:25:01.821**). 에이전트의 직접 실행 결과가 아니라 사용자 실행 결과를 인수한 기록이다.

- 실행 환경: Dambi `0.2.3`, extension ID `gpkbgomebnpbpoeppflafcmekjojkgdb`, `chrome-extension://gpkbgomebnpbpoeppflafcmekjojkgdb/js/background.js`, macOS Chrome `154.0.0.0` 기본 UA, GIWA 공개 endpoint. `grantedHostPermission=true`, `<all_urls>` 선언, CSP는 `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`다.
- 조회 결과: `eth_chainId` → `91342` / **144ms**; 기준 블록 `39,055,355`의 `getReserves` → ABI 3 word 응답 / **40ms**; 블록 `39,044,394`의 대표 pair 로그 → 지정 Swap 거래의 Sync·Swap 포함, 로그 **2개 / 31ms**. reserve 수치의 정확성·전체 이력 완전성을 검증한 시험은 아니다.
- 적용 범위: UA 변경·프록시·권한 변경 없이 해당 SW에서 순차 직접 fetch가 성공했다. 요청별 진단 timeout 8초·재시도 없음이며 설정·저장소·체인 상태를 바꾸지 않는다. 단발 요청 지연으로 24시간 이력·p95·전체 분석 시간 예산·장기적인 403/429 부재를 보장하지 않는다.
- 이전 준비: 2026-10-19 소스·기존 빌드의 manifest 정적 확인과 구문 검사 1개 통과·0개 실패를 마쳤다. 브라우저 제어 도구의 내부 관리 페이지 접근 제한은 우회하지 않고 사용자 실행으로 확인했다. 이번 결과 인수는 문서만 갱신했으며 기존 조회·구문 검사·빌드·시험을 반복하지 않았다.
- 남은 통합: 기존 `service-worker/chains/chain-config.ts`에는 `91342`가 없어 `rpcClient(91342)`는 아직 미지원이다. 직접 fetch 성공과 SDK/기존 클라이언트의 GIWA 지원 완료를 구분한다. 다음은 SF0-3 대표 요청의 Decoder·실제 대상 연결이며, RPC 서비스 경로 연결은 SF4에서 필요한 범위로 진행한다.

### SF0-3 대표 요청의 Decoder·실제 대상 연결

2026-10-21, [GIWA 고정 입력·선언·시험](giwa-sf0/)을 추가했다. 현재 소스의 Native `fixture_runner` 빌드 성공, [Decoder 회귀 시험](giwa-sf0/decoder.test.mjs) **6개 통과·0개 실패**. 첫 실행의 양성 2개 실패는 시험에서 `decoder_id` 위치를 잘못 참조한 문제였으며 실제 반환 계약에 맞춰 교정했다. 기존 Core·제품 snapshot·알고리즘은 변경하지 않았다.

- 실제 Swap: 저장한 원문 요청을 현재 Core의 `DecoderRegistry.install → route_request`로 처리해 HYANGNO·대표 pool·factory를 확인했다. router의 `factory()`·`WETH()`도 Swap 기준 블록에서 대조했다. 근거는 [선별 RPC 응답](giwa-sf0/rpc-evidence.json)에 둔다.
- 제한된 선언: GIWA의 확인한 router·selector 및 대표 페어만 허용한다. 다른 토큰·역방향·다중 경로·짧은 path는 `Unknown`, 다른 체인·router는 선언 미일치로 처리한다. 두 선언은 **시험용**이며 전체 GIWA·신규 토큰·기존 SDK의 지원 완료가 아니다. LiveField·slippage 기본값도 실측값이나 위험도 결과가 아니다.
- LP 구분: 표준 `addLiquidityETH`는 **합성·미서명 calldata**의 토큰·수량·pool·factory 연결만 확인했다. 실제 router에서 실행되는 경로인지까지 증명하지 않는다. 관측한 실제 LP 거래 `0x55f28ca8295e4526361edfc735b3eedb69052051591c52d98fac06b278ef3578`는 다른 대상의 `0x08cb1051` 복합 호출이므로 미지원으로 유지한다.
- 추가 근거·남은 문제: 위 실제 LP receipt의 factory `PairCreated`로 대표 페어 생성 블록 `31,390,683`을 확인했다. 실제 **표준 router LP 거래와 지원 진입점 확인**은 남아 있다. WASM·제품 배포 경로·실제 스캠 분석은 이번 검증 범위가 아니며, 온체인 거래를 생성하지 않았다.

아래는 통과한 검증의 재현 명령이다. 관련 변경이 없으면 반복하지 않는다.

```sh
cargo build --locked -p dambi-core --example fixture_runner
DAMBI_FIXTURE_BACKEND=native node --test fixtures/sdk/giwa-sf0/decoder.test.mjs
```

### SF0-4 시험 사례·고정 입력 준비

2026-10-21, [scam-cases.json](giwa-sf0/scam-cases.json)과 [자료 무결성 시험](giwa-sf0/scam-cases.test.mjs)을 추가했다. **합성 스냅샷 4개·수작업 기대 사례 12개 준비, 무결성 시험 4개 통과·0개 실패.** 제품 코드·알고리즘·stub은 구현하지 않았으며 RPC 조회·빌드·기존 SF0-2/3 시험을 반복하지 않았다.

- 스냅샷: 무변화·단방향 계단·반복 반전·조회 구간 누락. reserve는 정수 문자열이고 누락은 0으로 채우지 않는다. 주소 식별 근거만 SF0-3 자료를 재사용하며 수치·상대 시각·decimals는 합성 설정이지 실제 GIWA 관측값이 아니다.
- 기대 사례: R1 횟수 등호, R2 과거 밀집·정확히 X2 간격·B/T 경계·최신 동률·생성 직후 짧은 창, 부분 이력의 발동 유지/판정 불가, 초기 상태 미확정, 미지원 요청·미해결 풀, 신규 풀의 미발동을 포함한다. 사건 배열은 조건 충족이 이미 주어진 수작업 입력이며 스냅샷에서 계산하지 않았다.
- 확인 범위·남은 연결: 시험은 시각·격자·명시적 누락·정수 정밀도·자료 참조·형식 및 손상 입력 거절만 확인한다. **12개 탐지 사례의 실행 통과가 아니다.** SF1에서 버킷·사건 생성·warm-up·입출력 계약과 연결 기대값을 합의하고 실제 탐지 및 원천 로그 재생 연결은 이후 구현·인수 단계에서 확인한다. SF0-3 실제 LP 연결은 사용자 결정대로 미완·보류한다.

재현 명령(관련 변경이 없으면 반복하지 않음):

```sh
node --test fixtures/sdk/giwa-sf0/scam-cases.test.mjs
```

### SF1 공개·데이터·신뢰 계약

2026-10-21, `feat/scam-filter`의 [contracts/scam-filter-v0.1](../../contracts/scam-filter-v0.1/README.md)에 팀원 명세 v0.2를 반영했다(`d5e40d2`). 정규화 스냅샷·프로필·요청/결과 타입과 구조 스키마, Python 참조→Rust Native/WASM 동기 경계, SDK 결속·해시·자원 제한 계약, 소비자 타입 사례를 작성했다. 다중 후보 격자는 SDK 응답에서 구분하고 선택 후 하나만 전달한다. 명세 기반 새 인수 벡터 5개 묶음을 준비했으며 기존 SF0 동률 사례는 재사용한다. **SF1 커밋은 알고리즘·stub·제품 SDK·Native 실행부를 변경하지 않았다.**

검증: **v0.2 반영 변경 범위에 대해 사용자 실행 확인 2건 통과·0건 실패 — tsc 종료 코드 0, JSON 구문 확인 2파일 OK.** 명령은 계약 README에 있다. 이는 타입·구문 검사이며 실제 스키마 검증·탐지·자원 제한 실행은 후속 단계다. 팀원 Python 참조 코드·시험 파일·Rust 구현은 아직 미인수이며 공개 명세의 참조 시험 통과 표시는 팀원 보고로만 취급한다. SF1 계약 단계는 완료다. 에이전트는 검사·빌드·시험·RPC를 재실행하지 않았고 푸시는 하지 않는다.

### SF2 알고리즘 연결부·테스트 대체 모듈

2026-10-21, `feat/scam-filter`의 로컬 커밋 `70227b2`: [dambi-core::scam](../../crates/dambi-core/src/scam/mod.rs)에 Rust 타입·명시적 모듈 주입·입출력 검증·전용 오류 변환·JCS rulesHash·자원/기한 경계를 작성했다. 원자료 coverage를 보존하도록 SDK `AlgorithmInput`을 보완하고 등록 모드와 출력 모드 일치를 명시했다. 테스트 전용 고정 응답 stub과 경계 시험 **14개**를 작성했다. 실제 탐지 알고리즘·RPC/builder·CoreSession/WASM export·최종 정책 합성은 SF2에 포함하지 않았다. 푸시는 하지 않았다.

검증: **사용자 제공 실행 로그·화면 기준 완료 — Rust 경계 시험 14개 통과·0개 실패, WASM 대상 컴파일 검사 통과, 계약 타입 검사 종료 코드 0.** `59 filtered out`은 `scam::` 선택 범위 밖의 기존 시험이며 실패가 아니다. 실제 알고리즘 인수·협력적 작업량 준수·성능은 미확인이고, 이번 기한 검사는 동기 함수의 강제 중단이나 trap/OOM 격리를 보장하지 않는다. 기록 갱신·로컬 커밋을 위해 재시험·재빌드하지 않았다. 아래 명령은 재현용으로 보존한다.

```sh
cd /Users/spu/SDKdambi/DAMBI
cargo test --locked -p dambi-core --lib scam::
cargo check --locked -p dambi-core-wasm --target wasm32-unknown-unknown
yarn workspace @dambi/core exec tsc -p ../../contracts/scam-filter-v0.1/tsconfig.json
```

첫 명령은 새 경계 시험, 둘째는 기존 WASM bridge 의존 경로에서의 컴파일 호환성, 셋째는 변경된 연결 계약 타입을 확인한다. WASM 실행 검증이나 제품 산출물 재생성이 아니다. `tsc`는 성공 시 출력 없이 종료하므로 바로 `echo $?`로 0을 확인한다. 수정하지 않은 SF1 JSON·SF0 RPC·전체 SDK 시험은 재실행하지 않는다.

### SF3 Core 단일 실행 경로

2026-10-24, SF2 `70227b2` 이후 SF3 변경: Native·WASM·SDK에 `scamCalls`/별도 입력, 단일 평가·정책 합성, 계획별 설정·모듈 고정, 후보 선택, 기한·취소·늦은 응답 처리를 연결했다. 실제 알고리즘·RPC·서명 번들 수신은 포함하지 않는다. 정상 빌드는 고정 응답 모듈을 설치할 수 없으며, 회귀 시험만 별도 `scam-test-fixtures` WASM을 사용한다. **사용자 제공 실행 로그 기준 검증 완료 — Native session 12개, 기존 SDK check 8개, [SF3 통합 시험](../../packages/core/tests/scam.test.mjs) 9개로 총 29개 통과·0개 실패. 일반·테스트용 WASM 빌드 모두 성공.** 일반 빌드의 테스트 전용 별칭 `unused import` 경고는 남아 있으나 실패는 아니다. 검증된 기능 코드는 그대로 유지했고 기록·커밋을 위해 빌드·시험·RPC를 재실행하지 않았다.

SF3 시점의 제한: SF0 실제 ETH→HYANGNO 요청은 Decoder가 풀 측 WETH 경로를 전달하지 않아 `subject_unresolved`였다. 당시 연결 시험의 양성 경로는 명시적 합성·미서명 WETH→HYANGNO `swapExactTokensForTokens` 요청이다. 후속 대상 정보 전달 보완은 아래 SF4-1에서 별도로 추적하며, 실제 탐지 정확도는 팀원 모듈 인수 후 확인한다.

2026-10-25 SF3 후속 보완(`0b3efb1` 이후 신규 풀 판정·관련 시험 변경): 나이 기준 미만의 풀은 룰이 모두 clear여도 `insufficient + market_too_young`을 반환하도록 Native 합성을 수정했다. **사용자 실행 결과 기준 테스트용 WASM release 빌드 성공, 대상 시험 1개 통과·0개 실패.** 기존 candidate-grid 시험에서 신규 풀의 수동/자동 평가 일치, 정확한 나이와 검증된 하한의 등호 경계, 나이 미상, 신규 풀 경고 유지를 확인했다. 위 29개는 보완 전 별도 결과이며 이번에 재실행하지 않았다. 실제 알고리즘·RPC와 ETH 경로의 남은 제한은 그대로다. 아래는 통과한 변경 범위의 재현 명령이며 관련 변경이 없으면 반복하지 않는다.

```sh
cd /Users/spu/SDKdambi/DAMBI
wasm-pack build crates/dambi-core-wasm --target web --release --out-dir pkg-scam-test --out-name dambi_core --features scam-test-fixtures --locked &&
node --test --test-name-pattern="one frozen plan" packages/core/tests/scam.test.mjs
```

### SF4-1 실제 거래 대상 연결 보완

2026-10-25, `18ebbca` 이후 변경: Mapper가 신뢰된 `amm.swap.route`의 명시 값만 전달하도록 보완하고, GIWA 시험 Decoder에 calldata 기반 WETH→HYANGNO 단일 hop을 추가했다. 원래 native ETH 지출과 Core 대상 검증은 유지한다. 실제 원문 요청의 수동/자동 평가 일치, 경로 누락·풀/quote 불일치 거절, 잘못된 route 타입 거절·다른 live 값 기본값 보존을 관련 시험에 반영했다. **사용자 실행 로그 기준 Native runner·테스트용 WASM release 빌드 성공, Decoder 7개·SDK 스캠 회귀 11개로 총 18개 통과·0개 실패.** 기존 Native 테스트 전용 별칭의 `unused import` 경고는 남아 있으나 실패는 아니다. 실제 RPC·알고리즘·제품 Decoder 배포·LP 실연결은 미포함이다.

아래는 통과한 변경 범위의 재현 명령이며 관련 변경이 없으면 반복하지 않는다. 공통 Decoder 입력 변경의 영향 범위만 확인했고 기존 Core 전체 시험·SF0 RPC 확인은 반복하지 않았다.

```sh
cd /Users/spu/SDKdambi/DAMBI &&
cargo build --locked -p dambi-core --example fixture_runner &&
DAMBI_FIXTURE_BACKEND=native node --test fixtures/sdk/giwa-sf0/decoder.test.mjs &&
wasm-pack build crates/dambi-core-wasm --target web --release --out-dir pkg-scam-test --out-name dambi_core --features scam-test-fixtures --locked &&
node --test packages/core/tests/scam.test.mjs
```

### SF4-2 공통 RPC 기반과 기준 블록

2026-10-25, SF4-1 `193698f` 이후 신규 `scam-rpc.ts`·`scam-rpc-codec.ts`와 대응 시험 변경: 기존 HTTP 경계를 재사용하는 내부 raw 조회 배치를 추가했다. 체인·허용 factory·토큰 구성·`getPair` 검증, 하나의 기준 블록 공유, 명시적 과거 상태 조회, 로그 분할·동시성·제한된 재시도·시간/요청/바이트/로그 예산, 취소·늦은 응답 격리, head·기준·과거 근거 해시 재확인을 포함한다. 성공한 빈 로그와 실패한 블록 구간을 구분한다. **사용자 제공 실행 로그 기준 codec 5개·조회 배치 8개로 총 13개 통과·0개 실패, 취소·건너뜀 0개.** 실제 RPC는 조회하지 않았으며 정규화·관리자 이벤트 해석·SDK provider 조립·성능 확인은 SF4-3~SF4-5에 남긴다. 알고리즘이나 기존 정책 조회 경로는 변경하지 않았고 기록·커밋을 위한 재시험은 하지 않았다.

아래는 검증 범위의 재현 명령이며 관련 변경이 없으면 반복하지 않는다. 새 TypeScript 코드를 출력한 뒤 해당 시험 두 파일만 실행하며 Rust/WASM 재빌드는 필요 없다. 실패 구간은 아직 raw 블록 범위이며 실제 시각·coverage 변환은 다음 builder 단계에서 처리한다.

```sh
cd /Users/spu/SDKdambi/DAMBI &&
yarn workspace @dambi/core exec tsc -p tsconfig.build.json &&
node --test packages/core/tests/adapters/scam-rpc-codec.test.mjs packages/core/tests/adapters/scam-rpc.test.mjs
```

### SF4-3 풀 이력 정규화

2026-10-25, SF4-2 `d5973c7` 이후 신규 `scam-block-time.ts`·`scam-pool-history.ts`와 대응 시험 변경: 실제 인접 블록 헤더로 관측 시작 경계를 확인하고 과거 `getReserves` + 이후 Sync로 reserve 스냅샷을 구성한다. 블록 간격은 탐색 힌트로만 쓰고 헤더 조회 예산을 제한한다. 두 후보 격자는 한 원천 조회에서 만들며 정수 reserve·0을 보존하고 비격자 끝점을 추가하지 않는다. 결측은 다음 확인 Sync 직전까지 이어지고 두 history와 coverage에 같은 구간으로 남는다. decimals 조회 불가는 임의 값 없이 missing/unavailable이다. **사용자 제공 실행 결과 기준 시각 경계 5개·이력 정규화 8개로 총 13개 통과·0개 실패, 취소·건너뜀 0개.** 원천 RPC·실제 알고리즘은 실행하지 않았다. 저장 GIWA Sync 한 건은 원문 재생하고 주변 seed·헤더는 합성 응답임을 시험에 명시했다. 기록·커밋을 위한 재시험은 하지 않았다.

역산용 Swap/Mint/Burn 조회는 추가하지 않았다. 과거 시작 상태를 얻지 못하면 첫 확인 Sync 전까지 누락이며, 정확한 생성 근거 없이 warm-up 완료로 승격하지 않는다. 풀 생성 나이·관리자 이벤트는 SF4-4, 공개 provider 연결·실측은 SF4-5에 남는다. 다음은 검증 범위의 재현 명령이며 관련 변경이 없으면 반복하지 않는다. 해당 TypeScript 출력과 시험 두 파일만 실행하고 Rust/WASM 재빌드는 필요 없다.

```sh
cd /Users/spu/SDKdambi/DAMBI &&
yarn workspace @dambi/core exec tsc -p tsconfig.build.json &&
node --test packages/core/tests/adapters/scam-block-time.test.mjs packages/core/tests/adapters/scam-pool-history.test.mjs
```

### SF4-4 풀 나이·관리자 이벤트

2026-10-25, SF4-3 `0f92f2e` 이후 신규 `scam-profile-codec.ts`·`scam-token-profile.ts`와 대응 시험 변경: 검증된 factory의 `PairCreated`와 실제 헤더로 풀 생성 나이를 구성하고, 재생성 불가가 확인된 설정이 있을 때만 과거 코드 존재로 나이 하한을 인정한다. 첫 Mint를 생성 시점으로 쓰지 않는다. 나이 검색의 로컬 한도는 `age_unknown`, 배치 전체 자원 한도·취소·timeout·reorg는 실패로 유지한다. `maxAgeSearchCalls`는 논리적 헤더·코드·로그 검색 횟수이며 분할 조회·재시도 등 실제 요청은 기존 `maxRequests`로 제한한다.

관리자 이벤트 5종은 신뢰된 대상·ABI·지원 종류·블록 구간 설정이 있을 때만 정규화한다. 성공한 빈 로그, 부분 누락, 미지원 범위를 구분하고 별개 로그의 같은 시각·종류는 보존한다. 현재 계약은 종류별 coverage가 없으므로 요청한 종류 중 미지원이 있으면 전체 이벤트 창을 missing/unavailable로 남긴다. **TS7053 타입 추론 오류 수정 후 사용자 재실행 결과 기준 codec 5개·profile 10개로 총 15개 통과·0개 실패, 취소·건너뜀 0개.** 저장된 GIWA `PairCreated` 한 건은 원문 재생하며 주변 헤더·코드·대상 검증 응답·지원 설정은 합성임을 명시했다. 실제 RPC·알고리즘은 실행하지 않았고 GIWA 관리자 이벤트·재생성 불가 지원을 확정하지 않았다. 공개 provider 연결·배포별 지원 설정·실측은 SF4-5에 남긴다. 기록·커밋을 위한 재시험은 하지 않았다.

아래는 통과한 변경 범위의 재현 명령이며 관련 변경이 없으면 반복하지 않는다. 해당 TypeScript 출력과 시험 두 파일만 확인하고 기존 SF4-2~SF4-3 시험이나 Rust/WASM 재빌드는 요구하지 않는다.

```sh
cd /Users/spu/SDKdambi/DAMBI &&
yarn workspace @dambi/core exec tsc -p tsconfig.build.json &&
node --test packages/core/tests/adapters/scam-profile-codec.test.mjs packages/core/tests/adapters/scam-token-profile.test.mjs
```

### SF4-5 SDK 통합·데이터 경로 측정

SF4-4 `b832caa` 이후 변경: 공개 `createScamFactProvider`가 기존 정책 provider를 감싸 별도 스캠 batch만 실제 RPC·두 builder로 처리한다. 대상별 history/profile은 같은 기준 블록을 쓰고 최종 해시 검증 후 공개한다. 다중 그룹의 전체 기한·입출력 크기를 제한하며 캐시는 넣지 않았다. 명시적인 `ScamDataError`만 스캠 경로에서 사유를 보존하고 정책 조회와 일반 오류·취소 처리는 유지한다. 성공·부분 완료·실패 모두 계측하며 콜백 오류와 늦은 응답이 결과를 바꾸지 않는다. `receivedBytes`는 완료된 응답 본문 기준이며 네트워크 전체 전송량이 아니다.

**요청 속도 제어·로그 시각·비용 사전 계산 보완까지 사용자 실행 결과: 아래 어댑터 시험 64개 통과·0개 실패, 취소·건너뜀 0개.** SDK 통합·수명주기 6개는 앞선 연결 단계에서 통과했으며 이번에 재실행하지 않았다. 시험 원천 응답은 합성이며 실제 정규화 경로를 실행하고, 해당 SDK 통합 시험의 Core 분석은 명시적 stub을 사용한다. 에이전트는 RPC·빌드·시험을 실행하지 않았으며 기록을 위한 재시험도 하지 않는다. 이번 단계에서 실제 탐지 정확도, 제품 번들·GIWA 관리자 지원·재생성 불가를 검증했다고 표시하지 않는다.

아래는 요청 간격·재시도 및 로그 시각·비용 사전 계산 보완의 검증 명령이다. 공유 시간 인덱스의 profile 회귀를 포함하며 Rust/WASM은 재빌드하지 않는다.

```sh
cd /Users/spu/SDKdambi/DAMBI &&
yarn workspace @dambi/core exec tsc -p tsconfig.build.json &&
yarn workspace @dambi/core exec tsc -p tsconfig.consumer.json &&
node --test \
  packages/core/tests/adapters/scam-rpc-codec.test.mjs \
  packages/core/tests/adapters/scam-rpc.test.mjs \
  packages/core/tests/adapters/scam-block-time.test.mjs \
  packages/core/tests/adapters/scam-pool-history.test.mjs \
  packages/core/tests/adapters/scam-token-profile.test.mjs \
  packages/core/tests/adapters/scam-fact-provider.test.mjs \
  packages/core/tests/adapters/scam-data-probe.test.mjs
```

사용자의 실제 조회: GIWA Sepolia 대표 풀 1개, 24시간+warm-up 1시간, 캐시 없음. 첫 2,500ms 실행은 timeout(2,504.44ms·16요청), 진단용 15,000ms 실행은 data_missing(7,897.38ms·123요청)이었다. 진단 보완 후 15,000ms 실행은 **pool_history의 eth_getBlockByNumber에서 HTTP 429, 2번째 시도까지 실패**했다(11,971.31ms·200요청·재시도 1회·완료 응답 본문 3,750,422바이트·로그 구간 착수 9회·실패로 확정된 구간 0회). 세 실행 모두 반환 결과는 없었다. `logChunks`는 완료 수가 아니며, 마지막 결과가 앞선 두 실패 원인까지 증명하거나 200회가 서버의 정확한 한도임을 뜻하지 않는다.

후속 요청 속도 제어: source 내 배치·재시도 간 요청 간격과 공유 rate-limit cooldown, 기한 내 지수 backoff·429 Retry-After 처리를 추가했다. 프로브 기본은 간격 100ms·재시도 base 1,000ms/cap 8,000ms이며 최대 재시도 1회·조회 범위·자원 상한·제품 시간 제한은 유지한다. 사용자 후속 60,000ms 실행은 **pool_history/block_header의 내부 maxRequests=512에서 resource_limit**으로 종료됐다(56,601.39ms·512요청·재시도 0·7,175,224바이트·logChunks 9·failedChunks 0·반환 결과 없음). 이번 실행에서 429는 보고되지 않았지만, cold 이력 수집과 최종 재확인 비용은 해소되지 않았다.

2026-10-26 보완: optional `blockTimestamp`를 임시 스냅샷에 사용하되 반환 전 실제 헤더의 해시·시각을 모두 대조하고, 누락 시 기존 헤더 조회를 유지한다. 로그 수집 직후 고유 블록·추가 헤더·최종 검증의 요청/최소 pacing 비용을 계산해 명백한 예산 부족은 대량 조회 전에 종료한다. 프로브는 raw 요청 상한과 builder 헤더 조회 상한을 구분해 표시한다.

최신 사용자 실측(60초 제한)은 **4,219.68ms·21요청 후 pool_history/preflight의 resource_limit**으로 종료됐다. 로그의 고유 블록 2,498개 모두 시각이 있어 추가 시각 헤더 조회는 0회였지만, 최종 재확인은 2,502회로 남은 요청 예산 491회를 초과했다. 최소 요청 간격 비용도 250,100ms로 남은 55,782ms를 초과했다. 반환 결과는 없으며 사전 중단은 정상 작동했으나 이력 조회 비용 문제는 남아 있다. **SF4-5는 미완료이며 이후 어댑터 이력 검증 개선 대상으로 넘긴다.** 512회 한도·24시간+warm-up 범위는 유지한다. 미지원 나이·관리자 설정의 `partial`, 확장 환경과 Node의 차이, 프로브의 알고리즘 미포함 제한은 유지하며 제품의 2.5초 성능과 단일 완료·다중 대상 실측은 미검증이다.

### AH1-1 — 어댑터 검증 계약·결과 근거 연결

`07eb4f4` 이후 AH1-1 변경: provider의 불변 검증 설정, 메서드별 `verification` 근거, Rust wrapper 검증과 최종 binding 전달을 추가했다. 기존 응답은 `legacy_unspecified`로 구분하며 신규 미구현 모드는 거부한다. metadata도 결과 크기 제한에 포함한다. **사용자 실행 확인: TypeScript 빌드·소비자 타입 검사와 시험용 WASM 빌드 성공, Rust 18개·RPC/provider 29개·SDK/WASM 통합 15개 — 합계 62개 통과·0개 실패.** 실행 대상의 취소·건너뜀은 없으며 Rust의 무관 시험 59개는 필터 제외됐다. unused import와 wasm-pack 패키지 정보·업데이트 안내는 비차단 경고로 남는다. 기존 전수 헤더 대조와 요청 수는 그대로여서 SF4-5 조회 비용 문제는 남아 있다. live RPC는 이번 검증 범위가 아니다.

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

## 어댑터 A2-2 — RPC 조회·FactBatch

2026-10-12, A2-2 변경 범위(체인·블록 조회, FactBatch·provenance, 제한 동시성, 부분 실패·취소)에 대해 사용자 실행 **11 passed / 0 failed / 0 skipped**. 알려진 실패는 없으며 실제 Core·RPC 통합은 A2-3에 남는다.

## 어댑터 A2-3 — Core·실제 RPC 연결

2026-10-12, A2-3 변경 범위(Core/HTTP 통합·optional/required·cache/취소·수동 RPC 검증)에 대해 사용자 실행 **7 passed / 0 failed / 0 skipped**. PublicNode mainnet USDC 실연결도 사용자 확인 기준 **passed / complete**, 같은 블록 잔고 대조와 Core 평가(`allow`)를 통과했다. 알려진 실패는 없으며 tarball Node/브라우저 소비는 A3에 남는다.

## 어댑터 A3 — 패키지 소비

2026-10-12, A3 사용자 실행: CI 선택 시험 **10 passed / 0 failed**, tarball 타입·Node **5개 그룹 통과**. Playwright의 OPTIONS 자동 응답을 유발한 요청 가로채기를 제거한 뒤 Chromium 전용 재검증 **5개 그룹 통과**로 소비 검증 총 **10개 그룹·남은 실패 0개**를 확인했다. `497b364`의 [원격 전체 CI](https://github.com/errkat4up/DAMBI/actions/runs/38225781316)도 `core`·`core-consumers`를 포함한 **9개 job 성공 / 0개 실패**를 확인했다. 배포 origin의 실제 API/RPC 브라우저 접근 확인은 별도다.

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

[`first-fact-contract.json`](first-fact-contract.json)은 후속 A2의 `portfolio.balance` ERC-20 경로를 선정한 인계 자료다. B4에서 현재 공개 `PlannedCall`·`FactBatch`·provenance 계약에 맞췄다. Core의 원본 Fact 검증·projection·cache는 C5/C6에서, 직접 RPC adapter와 실제 조회 검증은 A2에서 완료했다. Day-1에는 활성화하지 않고 기존 catalog의 optional 선언도 유지한다.

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
