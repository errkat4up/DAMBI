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
        maxResultBytes: 16000000, maxCalls: 32, maxTargets: 8, maxRules: 16,
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
        historyCache: { maxEntries: 8, maxBytes: 16000000, ttlMs: 120000, maxBlockSpan: 100000 },
      },
      history: { maxPoints: 20000, maxLogs: 100000, maxBlockLookups: 512, blockTimeHintMs: input.blockTimeHintMs },
      profile: { maxEvents: 20000, maxLogs: 100000, maxBlockLookups: 512, blockTimeHintMs: input.blockTimeHintMs },
      limits: { timeoutMs: 2500, maxCalls: 32, maxTargets: 8, maxRequestBytes: 100000, maxResultBytes: 16000000 },
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
