# Scam Filter 로컬 시연

이 연결은 명시적으로 설정한 `staging` 환경에서 SDK 결과를 서명 전 확인창에 표시한다. 운영 키 등록·서비스 배포·실제 알고리즘 연결을 완료했다는 의미는 아니다. 기본값은 미구성이며, 설정 키가 없으면 기존 확장 정책 흐름만 사용한다. 전체 설정 화면은 이 범위에 포함하지 않는다.

**먼저 준비할 입력**

| 입력 | 준비 기준 |
| --- | --- |
| 정책 번들 origin·공개키 | 유효한 서명 정책 번들을 제공하는 `/v1/bundle` 서비스와 별도로 확인한 `policy` 역할 SPKI Base64 공개키. 기존 확장 정책 저장소를 SDK 번들로 간주하지 않는다. |
| 스캠 번들 origin·공개키 | `/v1/scam-bundle?env=staging&profile=default` 서비스와 별도로 확인한 `scam` 역할 공개키. 번들의 scope·유효기간·preset ID를 맞춘다. [기존 번들 사용법](../../packages/core/README.md#signed-scam-filter-bundles-sf5-1-development)을 따른다. |
| RPC·대상 체인 | 직접 사용할 RPC URL, 숫자 chain ID, 지원 V2 factory·quote token 주소. 서명 번들의 지원 범위와 맞아야 한다. |
| 실제 요청 | 연결 확인에는 dApp이 요청한 실제 `from`, `to`, calldata, value를 사용한다. 서명자가 없으면 임의 주소로 보충하지 않는다. |

비밀키(private key)는 호스트 설정에 넣지 않는다. endpoint·공개키는 아래 예시에 자동 포함되지 않는다. 같은 origin에서 두 번들을 제공할 수 있지만 키 역할과 검증 경로는 독립적이다.

**터미널: SDK와 확장 빌드**

저장소 루트에서 기존 빌드 환경을 갖춘 뒤 사용자가 실행한다. SF5-1의 `packages/core/dist/runtime/wasm` JS/WASM 쌍과 `dist/decoders.js`가 있으면 재사용하고 TypeScript 출력만 갱신한다. 로컬 화면 확인에는 저장소의 개발용 일회성 빌드를 사용한다. 이 경로는 `.env.development`를 사용하며 운영용 빌드 검사를 변경하지 않는다.

```bash
yarn workspace @dambi/core exec tsc -p tsconfig.build.json
cd browser-extension
NODE_ENV=development TARGET_BROWSER=chrome yarn webpack --config webpack/webpack.dev.js --no-watch
NODE_ENV=development TARGET_BROWSER=chrome yarn workspace dambi-dashboard exec vite build --mode development
```

SDK 산출물이 없거나 관련 Rust 코드를 변경한 경우에만 저장소 루트에서 `yarn core:build`를 먼저 실행한다. 확장 기본 자산·legacy WASM이 준비되지 않았다면 `browser-extension`에서 `yarn prepare:defaults`와 `yarn prepare:wasm`을 먼저 실행한다. 이미 성공한 준비 작업은 그대로 재사용한다. webpack이 출력 폴더를 정리하므로 dashboard 빌드는 반드시 그 뒤에 실행한다.

`yarn build:chrome`은 운영용 설정으로 실제 `REGISTRY_BASE_URL`과 서명 설정을 요구한다. 개발용 산출물에는 개발 권한·dashboard bridge가 포함되므로 운영 배포용 `validate:dist`의 통과를 요구하지 않는다. 이 절차는 로컬 화면 확인이며 운영 배포 검증과는 구분한다. SDK의 스캠 번들 서명 검증은 계속 적용된다.

`browser-extension/dist/chrome`을 개발자 모드로 로드하거나 기존 확장을 새로고침한다. 다음 명령은 터미널이 아니라 해당 확장의 Service Worker **DevTools Console**에서 실행한다.

**DevTools: 명시적 로컬 설정**

전체 계약은 [ScamHostConfig](../backend/service-worker/scam-filter.ts)에 있다. 아래 `input`의 문자열 placeholder와 `0`을 확인한 값으로 모두 교체한다. 데이터 provider의 요청 간격·재시도·원자료 한도는 [기존 AH probe](../../scripts/sdk/scam-data-probe-session.mjs)의 설정을 재사용한다. 안전성·전체 성능이 검증된 기본값은 아니며 준비한 서비스가 먼저 응답할 수 있어야 한다.

```javascript
const input = {
  policyBaseUrl: "<정책 서비스 origin>",
  policyKeyId: "<확인한 정책 키 ID>",
  policyPublicKey: "<정책 공개키 SPKI Base64>",
  scamBaseUrl: "<스캠 번들 서비스 origin>",
  scamKeyId: "<확인한 스캠 키 ID>",
  scamPublicKey: "<스캠 공개키 SPKI Base64>",
  presetId: "<서명 번들에 존재하는 시연 preset ID>",
  chainId: 0, // 실제 양의 정수 chain ID로 교체
  rpcUrl: "<해당 체인의 RPC URL>",
  factories: ["<확인한 V2 factory 주소>"],
  quoteTokens: ["<확인한 quote token 주소>"],
  blockTimeHintMs: 0, // 해당 체인의 양의 정수 탐색 힌트(ms)로 교체
};
const scamHostConfig = {
  version: 1, mode: "local-demo",
  policy: {
    source: { baseUrl: input.policyBaseUrl, maxResponseBytes: 1048576 },
    trust: { env: "staging", profile: "default", keys: [
      { keyId: input.policyKeyId, role: "policy", publicKeySpkiBase64: input.policyPublicKey },
    ] },
    limits: {
      allowedClockSkewMs: 5000, maxPolicyBytes: 1048576, maxDecoderBytes: 16777216,
      maxRequestBytes: 262144, maxFactBytes: 524288, maxPlanCalls: 64,
      planTtlMs: 60000, maxPendingPlans: 32, maxFactAgeMs: 30000,
      factTimeoutMs: 2000, policyTimeoutMs: 10000,
    },
  },
  scam: {
    source: { baseUrl: input.scamBaseUrl, maxResponseBytes: 1048576, env: "staging", profile: "default" },
    config: {
      settings: { enabled: true, presetId: input.presetId, overrides: [], additionalRules: [], locale: "ko" },
      trust: { env: "staging", profile: "default", keys: [
        { keyId: input.scamKeyId, role: "scam", publicKeySpkiBase64: input.scamPublicKey },
      ] },
      limits: {
        scamTimeoutMs: 2500, scamEvalReserveMs: 200, maxBundleBytes: 524288,
        maxResultBytes: 16000000, maxCalls: 8, maxTargets: 4, maxRules: 16,
        maxLogs: 100000, maxPoints: 20000, maxAlgorithmWorkUnits: 1000000,
      },
    },
  },
  facts: {
    policy: { chains: { [`eip155:${input.chainId}`]: { rpcUrl: input.rpcUrl } }, maxResponseBytes: 524288 },
    scam: {
      rpc: {
        chainId: input.chainId, endpoint: { rpcUrl: input.rpcUrl },
        factories: input.factories, quoteTokens: input.quoteTokens,
        verification: { history: "rpc_anchor", stateBinding: "number_recheck" },
        limits: { maxRequests: 512, maxResponseBytes: 8000000, maxTotalResponseBytes: 32000000,
          maxLogs: 100000, maxBlocksPerQuery: 10000, concurrency: 2, maxRetries: 1,
          minRequestIntervalMs: 100, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
        historyCache: { maxEntries: 8, maxBytes: 16000000, ttlMs: 120000, maxBlockSpan: 200000 },
      },
      history: { maxPoints: 20000, maxLogs: 100000, maxBlockLookups: 512, blockTimeHintMs: input.blockTimeHintMs },
      profile: { maxEvents: 20000, maxLogs: 100000, maxBlockLookups: 512, blockTimeHintMs: input.blockTimeHintMs },
      limits: { timeoutMs: 2500, maxCalls: 8, maxTargets: 4, maxRequestBytes: 100000, maxResultBytes: 16000000 },
    },
  },
};
```

예시는 `rpc_anchor + number_recheck`를 **명시적으로 선택**한다. 로그만 있는 블록의 이력은 RPC 로그 응답을 신뢰하고, 실제로 읽은 헤더와 기준 블록의 해시를 재검증해 숫자 블록으로 조회한 상태를 결속한다. 기본 `all_event_headers`의 이벤트 블록 헤더 전수 검증과 같은 보장은 아니다. 로그에 시각이 없으면 여전히 헤더 조회가 필요하므로 요청 수가 일정하다는 뜻도 아니다.

`dambi-v2/2`는 경계 값과 블록별 reserve 변경점을 보존하므로 point 수를 기간/bucketMs로 계산하지 않는다. 예시의 `maxPoints=20,000`은 후보 history 전체에 실제 생성한 점 수를 제한한다. provider 결과·SDK 입력의 16,000,000바이트도 시연 설정이며 운영 권장값이 아니다. cumulative·R2는 추가 24시간 이력이 필요하고 R2 작업 예산에 따라 더 작은 입력도 `resource_limit`이 될 수 있다. 지원 대상·관측 구간을 바꿀 때 실제 입력량과 전체 시간을 확인해야 한다.

`factorySupport`·`adminSupport`는 실제 배포의 지원 근거를 확보했을 때만 `facts.scam`에 추가한다. 미설정으로 나이·관리자 이력 조회가 부분 결과가 되면 원래 사유를 유지한다. 주소가 같다는 이유만으로 지원 정보를 꾸미지 않는다.

사전 준비(preparation)가 필요하면 **저장 전에** 원문 요청에서 옮긴 `CheckRequest[]`를 `scamHostConfig.prepare`에 넣는다. 처음에는 생략해도 된다. 예를 들어 이미 확인한 거래의 `from`, `to`, `data`, 십진 value를 그대로 채운다.

```javascript
scamHostConfig.prepare = [{
  kind: "transaction", chainId: `eip155:${input.chainId}`,
  from: "<원문 요청의 from>", to: "<원문 요청의 to>",
  data: "<원문 calldata>", value: "<원문 value의 십진 문자열>",
}];
```

원문에 없는 선택 필드는 생략한다. 이 배열은 거래를 제출하지 않으며 SDK가 발행한 `scamCalls`만 준비한다. 분석 모듈이 없어 `scamCalls`가 없으면 시장 데이터를 준비하지 않는다. 준비에는 공유 provider의 별도 60초 예산을 사용하고, 서명 요청이 시작되면 진행 중 준비를 취소한다. 준비용 plan은 소비·폐기하며 실제 요청은 새 `check()`로 평가한다. Service Worker 재시작 시 설정은 유지되지만 메모리 인스턴스·캐시는 새로 만들어지고 명시한 준비 대상도 다시 처리된다.

입력을 채운 후 활성화한다.

```javascript
await chrome.storage.local.set({ "scam-filter:host-config": scamHostConfig });
```

설정 변경은 기존 SDK 인스턴스와 진행 중 분석을 취소하고 새 인스턴스를 초기화한다. 이후 지원 dApp에서 실제 서명 요청을 발생시키면 정책 결과와 SDK 스캠 결과를 같은 확인창에서 본다. 보고서는 requestId에 연결된 `storage.session`의 임시 표시 데이터이며 URL에 전체 보고서를 넣지 않는다. 설정된 호스트는 정책 pass에서도 확인을 기다리고, 취소·창 닫기는 진행하지 않는다. 정책 fail에는 승인 버튼이 없다.

**상태 해석과 복구**

- SF6 소스로 다시 빌드한 SDK는 서명 번들이 `algorithm: { id: "dambi.scam.window-rules", version: "0.2.0", contractVersion: 2 }`를 선언할 때 내장 구현을 선택한다. builder 호환성은 `dambi-v2/2`다. algorithm이 null이면 `insufficient / algorithm_unavailable`이며, 다른 구현 선언은 거절한다. `analysisMode: "stub"`인 시험 결과는 화면에서 테스트 결과로 구분한다. 서비스·시연 설정은 개발 중이며 실제 화면 확인은 연결 후 진행한다.
- `quiet`는 실제 완료된 활성 검사 항목에만 적용한다. 부분·실패·미지원·비활성 상태는 성공 분석으로 표시하지 않는다. 현재 호스트는 보유 여부를 조회하지 않아 `unknown`으로 표시한다.
- 초기화 자체가 실패한 `initialization_failed`는 해당 요청에 표시하며 **다음 요청이 다시 초기화**한다. 같은 요청 안에서 무한 재시도하지 않는다.
- SDK는 최초 `refreshScam()` 실패를 정책 초기화와 격리한다. 따라서 Core 초기화는 성공했지만 스캠 번들이 unavailable인 경우가 있다. 이 호스트에는 번들 자동 갱신 스케줄이 없으므로 최초 수신 실패나 이후 만료에서 복구하려면 서비스를 준비한 뒤 Service Worker를 재시작하거나 설정 변경 이벤트를 발생시킨다. 동일 JSON을 그대로 다시 `set()`하면 변경 이벤트가 없을 수 있다. 필요하면 아래처럼 기존 설정을 보관한 뒤 제거·재설정한다.

```javascript
const savedScamHost = (await chrome.storage.local.get("scam-filter:host-config"))["scam-filter:host-config"];
await chrome.storage.local.remove("scam-filter:host-config");
await chrome.storage.local.set({ "scam-filter:host-config": savedScamHost });
```

호스트 요청 예산 2.5초는 설정 읽기·초기화 대기·SDK check를 포함한다. SDK 결과 수락 시 절대 마감 시각도 검사하지만 동기 WASM 계산을 강제 선점하지는 못한다. 실제 알고리즘·최초 이력 조회·확장을 포함한 전체 2.5초 성능은 아직 검증되지 않았다. 초기화가 늦으면 해당 요청은 timeout이고 공유 초기화가 완료된 다음 요청에서 다시 확인할 수 있다.

## S2a 재현 계약과 S2b 인계

이 절은 실행 결과가 아니라 재현할 입력·예산·판정 경계다. 이 변경의 빌드·시험·독립 검토 및 공개 RPC 실측은 아직 확인되지 않았다. S2b 전체 성능 합격이나 S3 호스트 전환을 선언하지 않는다.

### 생성 근거와 나이

`scam-pool-creation.ts`와 단위 시험은 S2a-1 원본 `47f09567db2b5ab66f9f59ba3851cd79af0f99a2`를 재사용한다. factory ABI 일치와 배포 provenance는 별개다. 지원 근거에는 대상 chain ID, factory 주소, 배포 트랜잭션·블록·코드/ABI의 출처, 비재생성 가정을 사용하는 경우 그 별도 근거가 필요하다. 이번 변경은 그 근거를 새로 만들어 넣지 않는다. 기존 `factorySupport` 기본값은 여전히 비어 있다.

provider의 exact 생성 결과는 해당 profile 수집에서 얻은 후보 사건과 같은 batch에서 독립 조회한 생성 헤더를 검증한 뒤에만 반환한다. 이벤트의 optional timestamp나 조회 시각으로 생성 시각을 대체하지 않는다. 검증 후에도 원래 batch의 최종 canonical 검사와 전체 결과 바이트 제한을 거친다. 나이는 현재 시계가 아니라 결과의 reference 시각과 생성 시각에 결속되어야 하며 lower-bound 근거와 exact 근거를 혼용하지 않는다.

RPC 어댑터는 원 로그의 `removed: false`를 확인해 정규화 결과와 이력 캐시에 보존한다. 제거된 로그나 제거 여부가 누락된 로그가 든 구간은 캐시에서 재사용할 수 없다. 생성 시각을 정확히 산출하려면 같은 체인의 블록 헤더, factory·pool·token이 일치하는 생성 사건, 명시적 factory 지원 설정이 필요하다.

### 공통 실행 envelope

probe의 `SCAM_EXECUTION_BUDGET`과 위 호스트 예시는 대상 1~4개, 최대 8개의 history/profile 호출, 1,000,000 algorithm work units, 20,000 points, 100,000 logs, 전체 결과 16,000,000 bytes를 사용한다. probe의 과거 100,000,000 work units를 호스트로 복사하지 않는다. 작은 입력도 실제 R2 계산량에 따라 `resource_limit`일 수 있다. 이 한도들은 모든 조합의 완료를 보장하는 capacity가 아니다.

기본 data probe 관측은 24시간 lookback + 24시간 warm-up이다. 실제 analysis probe는 Core가 발행한 `plannedHistories`의 구간·후보 해상도를 기록한다. 서명 번들의 룰·warm-up과 실제 모듈의 추가 관측 요구를 줄여 맞추지 않는다. history의 point 수는 bucket 수가 아니라 경계·변경점 수이며 두 후보가 있으면 둘 다 예산을 소비한다.

캐시는 8 entries / 16,000,000 bytes / 120초로 유지하고 block-span만 200,000으로 맞춘다. 이는 1초 간격의 48시간 범위를 보관할 수 있는 범위 제한일 뿐, 로그가 많은 범위가 바이트 예산에 들어간다는 뜻은 아니다. 더 빠른 체인, expiry, eviction, Worker 재시작은 cache miss를 일으킨다. cache-enabled를 cache-hit로 기록하지 않는다. 재사용 여부와 원래 관측 시각은 Fact의 `verification`으로 확인한다.

| 대상 수 N | 호출 수 | data probe reference 그룹 | 그룹별 RPC 상한을 모두 쓸 때 요청/수신 바이트 상한 | 전체 결과/캐시 바이트 |
| --- | --- | --- | --- | --- |
| 1 | 2 | 1 | 512 / 32,000,000 | 16,000,000 / 16,000,000 |
| 2 | 4 | 2 | 1,024 / 64,000,000 | 동일 |
| 3 | 6 | 3 | 1,536 / 96,000,000 | 동일 |
| 4 | 8 | 4 | 2,048 / 128,000,000 | 동일 |

이 표는 누적 상한이며 실측 비용이나 메모리 사용량이 아니다. 실제 Core plan의 그룹 공유는 다를 수 있다. 전체 fetch deadline은 N에 곱하지 않는다. response 한 개는 8,000,000 bytes, 동시성은 2, 그룹당 logs는 100,000, builder의 header lookup은 각각 512다. JSON 문자열·파싱 객체·정규화 points·WASM 복사·결과 직렬화가 겹치므로 이 바이트 제한의 합을 heap/RSS 상한이라고 부르지 않는다. S2b에서는 JS heap, WASM memory, 프로세스/Worker 메모리를 별도 기록해야 한다.

`stages`는 실제 실행한 `pool_identity`, `pool_history`, `token_profile`의 실행 횟수와 누적 시간을 기록하며 실패한 단계도 포함한다. 단계 시간에는 해당 단계가 기다린 RPC가 포함된다. reference 취득, 최종 recheck, 결과 직렬화 등은 provider 전체 `durationMs`에 포함되지만 세 builder 단계에는 포함되지 않는다. raw RPC 요청·재시도·수신 bytes는 전체 합계로 보고하며 단계별 RPC 횟수라고 오인하지 않는다. preparation, SDK 초기화, SDK check는 별도 표본이다. SDK check에서 provider 시간을 뺀 잔여 시간을 순수 알고리즘 CPU 시간으로 이름 붙이지 않는다.

### QA 재현과 판정

로컬 회귀는 실제 builder/provider 시험과 production WASM analysis 시험을 사용한다. 생성 verifier 시험, provider 시험, data/analysis probe 시험을 현재 Core build에 대해 실행한다. host 예시의 숫자와 probe 옵션의 일치는 data probe 시험이 예시 configuration을 격리된 VM에서 구성하여 비교한다. 대상 1~4의 provider 시험은 작업량 회귀를 위한 synthetic 입력이며 서로 다른 실배포 4개를 검증했다는 증거가 아니다.

- **완전:** 모든 요청 대상이 일치하고 실제 알고리즘의 모든 활성 룰이 완료되며 missing/unavailable, unknown age, 불완전 warm-up이 없어야 한다. 경고가 발생한 완전 결과도 완전일 수 있다.
- **부분:** 반환된 이력에 gap, 관리자 이력 미지원, unknown age 또는 불완전 룰이 있다. 빠른 partial이나 fired-with-gaps를 성공 표본으로 이동하지 않는다.
- **불가:** timeout, resource limit, reference/subject 불일치, reorg, 검증할 생성 근거 부재 등으로 유효한 결과를 반환하지 못했다. draft를 자르거나 이전 결과로 대체하지 않는다.

공개 GIWA RPC 실측은 별도 수동 단계다. 최초 공급자는 GIWA 공개 endpoint이고 정책 RPC와 거래 데이터 RPC 설정은 독립이다. chain 1의 거래 데이터는 별도 Ethereum endpoint를 사용한다. 공급자를 교체하면 같은 chain ID, 필요한 과거 상태·로그·확정성 지원을 다시 확인한다. 429, 로그 범위 제한, archive 부재와 구현의 resource limit을 구분하여 기록한다. 비밀 헤더·URL을 보고서에 기록하지 않는다.

### S2b 측정 전에 확정할 항목

- 비교 목표: **2,500ms 유지**. host 시작은 `begin()` 진입(설정 읽기 전), 종료는 그 요청의 promise가 report/unavailable로 settle하는 시점이다. UI 렌더 완료·사용자 승인·체인 전송은 이 경계 밖이며 필요하면 별도 지표로 측정한다.
- host 절대 deadline, SDK 예산, provider 예산을 독립 기록한다. preparation은 최대 60,000ms의 별도 작업이며 check latency 표본에 섞지 않는다. 동기 WASM은 타이머로 선점할 수 없으므로 늦게 완료된 응답도 timeout으로 기록한다.
- 층화: N=1,2,3,4 각각 cold, 명시적 준비 후, Worker 재시작 후를 분리한다. 각 표본에 실제 target 수, planned 구간, rule/preset, RPC 공급자·제한, cache reuse, complete/partial/failed와 사유를 남긴다. timeout과 partial도 분모에 남긴다.
- 현 probe의 1~20회 반복과 nearest-rank percentile은 진단용이다. 준비된 3회로 운영 p95를 선언하지 않는다. **운영 표본 수·표집 간격, timeout 허용률, 불완전 허용률은 제공된 F0 수치가 없어 미확정**이다. C/D와 독립 리뷰어가 실측 전에 기록·승인해야 하며, 미확정 상태에서 합격 판정을 내리지 않는다. S2a의 완전 결과 재현에서는 partial/failed를 완전으로 허용하지 않는다.
- 이 변경은 해당 승인이나 측정을 수행했다는 기록이 아니다. 룰 임계, warm-up, 관측 구간, 2.5초 deadline을 완화하여 통과시키지 않는다.

**DevTools: 비활성과 완전 제거**

SDK 검사를 끄되 비활성 상태를 표시하려면 설정을 유지하고 `enabled`만 끈다. 이 상태도 정책 pass에서 확인창을 표시할 수 있으며 SDK 초기화·번들 수신은 남는다. 모든 활성 룰을 끈 경우도 완료된 quiet가 아니다.

```javascript
const disabledScamHost = (await chrome.storage.local.get("scam-filter:host-config"))["scam-filter:host-config"];
disabledScamHost.scam.config.settings.enabled = false;
await chrome.storage.local.set({ "scam-filter:host-config": disabledScamHost });
```

호스트 연결을 완전히 비활성화하고 기존 정책 흐름만 사용하려면 설정 키를 제거한다. `null` 저장은 잘못된 설정으로 표시되므로 제거와 다르다.

```javascript
await chrome.storage.local.remove("scam-filter:host-config");
```

매도 제한형 스캠은 검사 범위에 포함되지 않습니다. 경고 미발견은 자산의 안전성이나 매도 가능성을 보장하지 않습니다.
