# Scam Filter SF1 — SDK·알고리즘 연결 계약

**SF1 계약 산출물이며 SDK에서 실행·공개된 API가 아니다.** [타입](types.ts)과 [스키마](contract.schema.json)는 담비와 알고리즘의 연결 경계를 정의한다. 기준은 [팀원 명세 v0.2](https://claude.ai/artifact/9FT22CC41pww8s72pxuenn)와 사용자에게 전달된 수정 합의다. 기존 Core API·정책 Fact·Cedar·제품 번들은 변경하지 않는다. 실제 알고리즘, stub, 검증기, provider, 결과 합성 구현은 SF2 이후다.

디렉터리·SDK envelope의 `0.1`, 명세 문서의 `v0.2`, 알고리즘 wire의 `contractVersion: 1`은 별도 버전이다. 기존 문서 v0.1의 해상도·0값·창 선택 의미는 채택하지 않는다. 최초 연결 시 구현 ID·버전과 v0.2 인수 사례를 대조하며, 이후 의미가 바뀌면 wire 호환성을 다시 정한다. 실제 패키지·알고리즘 버전은 인수 전까지 꾸며 넣지 않는다.

## 경계와 단위

| 경계 | 계약 |
| --- | --- |
| 설정 | `RuleSpec` 4종과 `ScamSettingsDraft`. 기본 R1/R2는 일반 프리셋에서 off, demo는 명시적으로 on. 실제 기본 임계치는 미확정 |
| 조회 | `scam.pool_history`, `scam.token_profile`. 기존 `FactProvider.fetch()`를 별도 배치로 호출하며 `planId/callId` envelope를 재사용 |
| 알고리즘 | Python 참조 구현 → Rust 제품 라이브러리. `AlgorithmModulePort`는 정규화된 `AnalysisRequest`를 받아 `ScamAnalysis`를 반환하는 순수 동기 경계. SDK `AlgorithmPort`는 계획 결속·결과 변환 담당 |
| 데이터 | 담비 provider가 로그→`PoolHistory` 스냅샷을 생성. 풀 생성 근거·관리자 이벤트를 `TokenProfile`로 변환. `swapCounts`는 제외 |
| 결과 | 룰별 `fired/clear/incomplete/not_evaluable`, 전체 `warn/quiet/insufficient` 및 미구성·비활성·미지원 상태를 구분 |
| 향후 SDK | `CoreConfigScamDraft`, `CorePlanScamDraft`, `DambiCoreScamDraft`, `VerdictScamDraft`는 제안용 타입만 제공. 현재 `createCore()`에 전달하는 구현 예제가 아님 |

기간은 `*Sec`, 스냅샷 해상도·시각·실행 예산은 `*Ms`, 변화율은 bps다. 블록 높이·원본 정수·스캠 번들 sequence는 지수 표기 없는 10진 문자열로 유지한다. 새 스캠 payload의 발행/만료는 필드명대로 **Unix ms**이며 기존 정책 payload의 Unix 초와 섞지 않는다. `Address`·`Digest`·`number` 타입 자체는 길이·범위·유한성·진위를 검증하지 않는다.

## 계획 고정과 데이터

1. Native 계획에 신규/기본 두 후보, override 적용 후 설정, 공통 X, 나이 미상 선택 규칙, 번들·알고리즘 버전을 고정한다. 두 후보 요구 범위·지표·해상도로 공통 조회를 한 번 계획하고 두 번째 공개 계획을 만들지 않는다.
2. provider가 동일 `planId + chainId + referenceGroupId`에 기준 블록을 먼저 확보하고 두 메서드에 공유한다. 응답의 subject·기준 블록·스키마·builder를 계획과 대조한다. 로그 상한·과거 증거 블록·조회 누락·canonical hash 검사는 SF4의 책임이다.
3. 나이는 factory `PairCreated`의 정확한 생성 근거, 과거 코드 존재의 검증된 하한, 미상으로 구분한다. 첫 Mint를 생성 시점으로 쓰지 않는다. X와 X1이 다르면 나이 검색의 추가 범위·호출 수도 처음부터 예산에 포함한다.
4. 정확한 A<X는 신규, A≥X 또는 하한≥X는 기본이다. 하한<X·나이 미상은 신규를 임시 선택하지만 미발동을 quiet로 올리지 않는다. 선택된 후보 범위만 분석하고 선택 사유·두 후보 해시·적용 설정 해시를 남긴다.
5. provider는 `PoolHistoryValue.histories`에 요청한 각 고유 격자의 `{gridOriginMs, history: PoolHistory}`를 반환한다. SDK가 나이 선택 후 해당 격자 하나를 알고리즘에 넘긴다. `TokenProfileValue`의 검증된 `age/events/coverage`를 연결부가 `TokenProfile`로 축약한다. 정확한 생성 시각 또는 검증된 하한만 전달하고 미상은 필드를 생략한다. 기존 `PoolAge`의 출처·검색 범위는 SDK envelope에 남긴다.

`ScamFactBatch`와 `FactBatch`는 구조상 호환된다. 이것은 전송 포트 재사용이지 보안 분리의 증명이 아니다. 스캠 결과를 기존 `facts::validate`·projection·Cedar에 보내면 안 된다. `optional:true`는 형식 오류·만료·크기 오류를 격리하지 않는다. 특정 지표 조회 불가와 실제 빈 이벤트/0값은 `unavailable/missing`과 원자료로 구분한다.

## 스냅샷·초기 상태 계약

- 원천 로그는 알고리즘 입력이 아니다. 담비 builder는 검증한 풀의 로그를 블록·transaction·log index 순으로 정리하고, 각 격자 시각 **이하**의 마지막 확인된 reserve 상태를 사용한다. 같은 시각이면 마지막 로그가 반영된 상태다. 상태를 확인하지 못한 구간은 `missing`이며 이전 값으로 덮지 않는다. 조회가 완전하고 변화가 없음을 확인한 구간만 값 이어 채우기(forward fill)를 허용한다.
- `bucketMs`와 SDK에 고정한 `gridOriginMs`가 격자를 정한다. 점은 오름차순·중복 없이 격자에 맞고 T 이하이며, T를 맞추려고 비격자 점을 추가하지 않는다. 풀 생성 이전 값은 만들지 않는다. 원본 reserve는 10진 정수 문자열, decimals는 0~255 정수다. U256 범위와 시간·정렬·격자·구간 관계는 의미 검증 대상이다.
- 공통 조회는 두 후보의 X1·W 요구를 모두 포함하고 분석 기준 T는 고정 블록 시각을 유지한다. 두 후보가 서로 다른 격자를 요구하면 같은 원천 조회에서 각 격자를 만들고, `(history.bucketMs, gridOriginMs)`로 구분해 한 응답에 반환한다. 요청 격자 중복은 하나로 합치고 응답의 누락·중복·추가 격자는 거절한다. 조회 누락은 각 history의 missing에 남긴다. 선택 후 알고리즘에는 해당 후보의 최대 X1+W 범위로 잘라낸 history 하나만 전달하며 `fromMs`와 warm-up/누락 범위도 함께 조정한다. 임의 다운샘플링이나 해상도 변경으로 조건을 맞추지 않는다.
- `missing`은 `(fromMs, toMs]`이며, 격자 누락을 모두 표현한다. 가격의 `reserveToken=0`은 스냅샷 자체를 삭제하지 않고 알고리즘이 **가격 룰의 계산 불가 점**으로 처리한다. 유동성 룰까지 자동으로 누락시키지 않는다. 관리자 이벤트 조회 불가는 해당 범위를 missing/unavailable로 남기며, 성공한 빈 이벤트와 구분한다.
- 모듈의 `supports(rule)`가 필요한 초기 상태와 최소 warm-up 요구를 제공한다. W는 그 요구 이상으로 계획하되, 입력의 `warmup.complete`는 필요한 자료 확보 여부이지 상승·하락 방향이 이미 확정됐다는 보장이 아니다. 초기 상태의 실제 완성은 알고리즘이 판단해 룰 결과에 남긴다. 생성부터 전 기록이 있는 경우 존재하지 않는 생성 이전 자료는 요구하지 않는다.
- v0.2의 기본 `bucketMs=12000`은 초기 프리셋 후보이며 GIWA 블록 간격과 다르다. 사용자는 지원 범위 안에서 바꿀 수 있고, 바뀐 Δ에 맞는 룰과 기본값 검증이 필요하다. X는 계속 **풀 생성 나이** 기준이다. 실제 기본 X·임계치·W는 연구 결과 인수 시 확정한다.

## 룰 의미 — v0.2 합의

규칙 필드는 이 저장소의 `RuleSpec`을 wire 정규 표현으로 쓴다. 연구 문서의 `price/liquidity`는 각각 `price_quote_per_token/quote_reserve`, X1/X2는 `lookbackSec/windowSec`, I/θ는 해당 bps 필드다. R2의 `direction_reversal`은 peak와 trough 모두를 센다. peak-only/trough-only 선택자는 MVP에 추가하지 않는다. `event_count`는 합의한 관리자 이벤트 5종과 X1 전체 횟수만 지원한다.

| 항목 | 확정 의미 |
| --- | --- |
| R1 최소 해상도 | `lookbackSec × 1000 > (count − 1) × bucketMs` |
| R2 최소 해상도 | `windowSec × 1000 > (count − 1) × bucketMs`; 등호는 `not_evaluable/resolution_too_coarse` |
| window_drop 최소 창 | `windowSec × 1000 ≥ bucketMs`를 **MVP 지원 정책**으로 사용. 모든 계산 방식에서 수학적으로 필요한 조건이라는 뜻은 아님 |
| R2 근거 | B=`max(T−X1, 확인된 생성 시각)`; `(max(B,end−X2),end]`의 최대 횟수, 동률이면 가장 늦은 end. 사건 0개면 근거 창 없음 |
| 유효한 0 | quote reserve 양수→0, token reserve가 양수인 가격의 양수→0은 유효한 −100% 관측 |
| 계산 불가 | 가격 분모(token reserve) 0이면 구간·상태를 끊고 앞뒤를 잇는 사건을 만들지 않음 |
| 기준값 0 | 0→양수는 백분율 사건 없이 다음 양수에서 상태 재시작 |
| 완전성 | 범위 안의 계산 불가·누락 또는 필요한 초기 상태 미확정이면 clear 금지. 유효한 사건만으로 충족한 fired는 유지 |

R1/R2 해상도 식은 **고정 격자·점당 사건 최대 1개**에서 필요한 사건 수를 담을 최소 조건이지 실제 발동이나 데이터 충족의 보장이 아니다. 모든 기간은 같은 단위로 변환하고 overflow 없이 비교한다. 이 조건을 warm-up이나 비격자 관리자 이벤트에 적용하지 않는다. 잘린 창은 실제 범위와 사건 수로 판단하고 W의 사건은 집계하지 않는다. 정확히 X2 간격인 사건은 함께 세지 않는다.

사건 생성·고저점·윈도우 탐색·정밀도 구현은 팀원 영역이다. [인수 벡터](acceptance-cases.json)는 명세의 고정 입력·기대값을 옮긴 자료이며 실행 결과가 아니다. 기존 SF0-4의 수작업 사건 사례는 그대로 재사용하고, 그 스냅샷에서 사건을 계산했다고 소급 주장하지 않는다.

## Rust 모듈과 SDK 연결부

1. 알고리즘 팀은 `crates/scam-filter/`의 Rust 라이브러리를 Native 및 `wasm32-unknown-unknown` 대상으로 제공한다. Python은 참조 구현이며 제품 Python 서버·브리지·새 노드는 만들지 않는다. 네트워크·시계 읽기·설정 조회 없이 입력만으로 계산하고 checked 연산과 오류 반환을 사용한다.
2. SDK 연결부는 설정 합성·후보 선택·입력 검증을 끝낸 뒤 활성 룰만 `AnalysisRequest.rules`로 전달한다. 공급 메서드의 대상·블록·builder·스키마·coverage를 먼저 검증하며 호스트가 만든 최종 판정을 입력으로 받지 않는다.
3. `AlgorithmModulePort`는 대상·기준 블록·rulesHash의 작은 binding과 룰 결과만 반환한다. SDK 연결부가 원래 `AnalysisBinding`에 붙여 `AlgorithmPort` 결과를 만든다. planId·bundleSequence·설정·나이 근거를 알고리즘 출력에 중복시키거나, 응답이 원 계획을 교체하게 하지 않는다.
4. 요청 룰마다 정확히 한 결과가 있어야 한다. 누락·중복·추가 ID, 대상·블록·해시·ID/버전·analysisMode 불일치, 범위 밖/미래 근거, 잘못된 수치·상태는 `invalid_algorithm_output`이다. 근거 64개 제한으로 events를 줄여도 observed는 전체 횟수이며 사건 배열 길이로 바꾸지 않는다. `coverageBps=10000`만으로 완전성을 인정하지 않고 원자료의 누락과 해당 룰의 초기 상태를 함께 검사한다.

정규 해시(`sha256-jcs-scam-v1`)는 기존 Native의 `serde_json_canonicalizer`와 SHA-256을 재사용한다. 아래 JSON의 JCS UTF-8 바이트를 해시해 소문자 `0x`+64자리로 표현한다. 배열 순서는 고정 계획의 순서를 보존하고, 필드가 없는 경우 임의 null/default를 추가하지 않는다. 문자열 주소는 검증 후 소문자로 정규화한다. **서명 bundle.payload는 이 규칙으로 재직렬화하지 않는다.**

| 해시 | 입력 JSON |
| --- | --- |
| settingsHash | `{domain:"dambi.scam.settings/1", candidates, selection}` — 두 유효 후보와 공통 선택 규칙 |
| effectiveSettingsHash | `{domain:"dambi.scam.preset/1", preset}` — 선택된 유효 프리셋 전체 |
| 알고리즘 rulesHash | `{domain:"dambi.scam.rules/1", rules}` — 실제 전달한 활성 `RuleSpec[]` |

해시 계산은 담비 연결 책임이다. Rust 모듈 출력의 rulesHash도 동일한 규약을 사용하고, 재사용 가능한 경계 helper는 SF2에서 한 곳에 둔다. Python 연구 코드에 SDK 서명·계획 메타데이터 구현을 요구하지 않는다.

| 알고리즘 reason | SDK reason |
| --- | --- |
| partial_coverage | data_missing |
| warmup_incomplete | initial_state_unknown |
| no_usable_segment | data_missing |
| resolution_too_coarse | unsupported_resolution |
| metric_unavailable | field_unavailable |

`outcome`은 SDK `state`로 1:1 대응한다. 근거의 observed/threshold/window/events/coverageBps와 원 reason은 evidence에 보존한다. 원자료 coverage는 SDK envelope에서, 필요한 초기 상태의 충족 여부는 모듈 결과와 해당 룰 요구사항에서 가져온다. 여러 결함이 있으면 원자료·나이·신선도 사유를 추가하되 알고리즘 결과를 조용히 clear로 고치지 않는다.

## 오류·수명주기·기한

- 미구성은 기존 동작 유지, 사용자 비활성·활성 룰 0개는 disabled다. 구성을 시도했지만 소스/번들/알고리즘이 없는 상태는 disabled로 숨기지 않고 insufficient와 사유를 남긴다.
- 수동 API 계약은 **동기** `evaluate(plan, policyFacts, scamFacts?)`다. 세 번째 인자는 조회 메서드 값이며 호스트가 정한 분석 판정이 아니다. 없을 때 모듈도 없으면 `algorithm_unavailable`, 연결된 모듈에 필요한 결과만 없으면 `scam_results_missing`으로 구분한다.
- JSON 복사·직렬화·크기·스키마·대상·블록·알고리즘 오류는 전용 `NativeScamInputDraft`의 unavailable 경로로 전달한다. 기존 `evaluate_check.failure`에 넣지 않는다. 잘못된 스캠 결과라도 유효한 Core 계획의 한 번 소비와 기존 정책 판정은 유지한다.
- Native는 기존 `policy.valid_until_ms()`를 재사용하여 `min(Dplan,Dpolicy)`를 JS-safe 내부 기한으로 전달한다. 이를 공개 handle이나 사용자 입력에서 신뢰하지 않는다. 별도의 정책 기한 계산기를 만들지 않는다.
- 실행부는 전달할 정책 Fact의 `observedAt + maxFactAgeMs`까지 고려해 스캠 마감을 더 이른 쪽으로만 갱신한다. 포함하는 optional Fact도 동일하다. Fact 신선도 등호는 기존 Native 검사를 유지하고 대기 예약에서는 보수적인 기한을 쓴다. 필요한 기한을 알 수 없으면 정책 준비 후 추가 스캠 대기를 하지 않는다.
- 스캠만 시간 부족이면 `no_time_budget/timeout`; 정책 자체의 만료·오류는 기존 deny+fail_closed다. 호출자 취소·dispose도 기존 계약을 유지한다. 동기 알고리즘을 JS 타이머로 강제 중단할 수 있다고 가정하지 않는다.

합성은 정책 deny 유지, warn 유지, allow+scam warn만 warn으로 상향한다. allow+insufficient는 allow를 유지하되 미검사 사유를 반드시 보여준다. `source`는 정책 판정의 출처다. quiet는 활성 룰이 있고 모두 clear이며 기록·초기 상태·나이·신선도 조건을 충족할 때만 가능하다. **스캠 확률·안전 인증·매도 가능성을 뜻하지 않는다.**

## 번들과 검증 책임

별도 스캠 payload를 로컬 `scam` 역할 키로 검증한다. 전송 envelope는 원문 `payload`·P-256/P1363 `signature`·선택적 telemetry `keyId`다. 원문 UTF-8 바이트를 검증하고 keyId로 키를 선택·추가하거나 policy/decoder 역할을 대체하지 않는다. API의 `key_id`→SDK `keyId` 매핑은 어댑터 경계다.

`kind/schema`, env/profile, 발행/만료, engine/builder/알고리즘 호환성, 지원 체인·factory·quote, 프리셋을 별도 검증한다. sequence는 **수치 비교**하며 동일 scope의 역행·동일 sequence의 다른 내용을 거절한다. 갱신은 전부 검증한 후 교체하며 실패는 기존 정책 snapshot을 바꾸지 않는다. 이전 스캠 번들도 유효한 동안만 사용하고 만료가 sequence 기준을 지우지 않는다. 모델은 `null`; 레지스트리·노드·꼬리 발급은 추가하지 않는다.

JSON Schema는 **룰·SDK 서명 envelope·정규화 데이터·알고리즘 요청/결과의 구조**를 정의한다. 전체 스캠 번들 payload·SDK report는 타입과 이 계약으로 정의하며 런타임 검증은 후속 단계다. 다음은 스키마만으로 완료되지 않는다.

- X2≤X1, ID 유일성·override 대상과 종류 일치, 후보별 전체 설정 검증, 공통 입력 준비 가능 여부.
- 알고리즘이 지원하는 metric/mode/스위칭/관리자 이벤트, 해상도·W·자원 상한, 양방향 임계치의 해석. 상승률에 하락률 상한을 공통 적용하지 않는다.
- 서명·strict JSON·scope·시간·sequence·호환성, 전체 payload 구조, 실제 method 값·report의 의미 검증.
- quiet/부분 검사/미연결 상태의 정합성과 기존 deny·fail_closed 보존. 타입에 필드가 존재한다고 이 조건들이 증명되지는 않는다.

## 자원 한도와 실제 모듈 인수

초기 후보는 대상 8개·룰 16개·20,000점/대상·근거 64개/룰·결과 512KiB다. 제품 성능 보장값이 아니며 SDK 한도와 모듈 지원 한도 중 더 엄격한 값을 적용한다. 입력 크기·개수는 할당/호출 전에 확인하고, 알고리즘은 전달받은 작업량 상한을 협력적으로 지켜야 한다. 작업량 소진은 `timeout`, 입력·출력 크기 한도는 `resource_limit`로 구분한다. 논리 작업 단위와 지원 예산은 구현 버전에 결속하며 해당 제한을 지원하지 않는 모듈은 연결하지 않는다. 벽시계 deadline은 SDK 소유이고 순수 함수 내부에 시계 조회를 요구하지 않는다.

모듈 로딩/등록은 Native 연결부의 명시적 구성으로 한다. 미등록은 unavailable, stub은 시험에서만 명시 주입하며 제품 기본값으로 연결하지 않는다. 기능을 구성한 뒤의 스캠 번들 조회/검증 실패는 스캠만 unavailable로 남기고 유효한 정책 초기화를 실패시키지 않는다. 잘못된 로컬 설정 자체는 설정 시 거절한다.

실제 인수 시 팀원이 제공할 것은 Rust 패키지·ID/버전·지원 룰/초기 상태 요구/작업량 제한과 Python/Rust 공통 기대값이다. 정상 오류 격리와 trap/OOM 격리는 같은 보장이 아니다. SF1에서 안전성을 달성했다고 표시하지 않고 실제 Native/WASM 인수에서 확인한다. 공개 페이지의 `test_ref.py` 통과 표시는 **팀원 보고**이며 파일과 실행 결과를 직접 확인한 것이 아니다.

X1=24시간의 최초 조회만으로 예산을 소진할 수 있으므로 부분 입력과 평가 여유를 합의한다. 400개 표본 결과·온체인 레지스트리·실제 LP 거래 확보를 이 계약 초안의 선행 조건으로 추가하지 않는다. 실제 LP 지원은 여전히 미완이다.

## 사용자 실행

[소비자 타입 사례](consumer-types.ts)는 정상 스냅샷·알고리즘 경계, 잘못된 종류·필드·단위 형태, 미구성/미연결, 기존 Core 타입과의 호환성을 컴파일로 확인한다. 패키지 공개·실제 스키마 검증기·암호·Native·알고리즘을 실행하는 시험이 아니다. 다음 명령만 사용자가 실행하며, 결과는 [SDK 검증 기록](../../fixtures/sdk/README.md)에 한 번만 남긴다. 타입이 바뀌었으므로 이전 초안의 통과 결과로 이번 변경까지 통과했다고 보지 않는다.

```sh
cd /Users/spu/SDKdambi/DAMBI
yarn workspace @dambi/core exec tsc -p ../../contracts/scam-filter-v0.1/tsconfig.json
```

성공 시 tsc는 출력 없이 종료한다. 바로 다음 줄에서 `echo $?`로 종료 코드 0을 확인할 수 있다. 추가한 JSON 두 파일은 아래 명령으로 구문만 확인한다. JSON Schema에 대한 실제 입력 검증이나 알고리즘 시험이 아니다.

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; for (const f of ["contract.schema.json", "acceptance-cases.json"]) JSON.parse(readFileSync("contracts/scam-filter-v0.1/" + f, "utf8")); console.log("JSON syntax: 2 files OK");'
```

SF1 계약 작성 완료와 사용자 검증 완료는 구분하며, 현재 상태는 계획서·검증 기록을 따른다. 기존 SF0 시험·전체 SDK 재빌드·RPC 재측정은 이번 계약 변경의 필수 검증에 넣지 않는다.
