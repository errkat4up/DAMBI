# 어댑터 세부 개발 계획 — Policy API와 첫 EVM Fact

작성일: 2026-10-12. 상태: **A1-1~A2-3 완료, A3 구현·로컬 검증 완료 / 원격 CI 대기**. 기준: `feat/bundles`의 `ab6d013`과 B4 인계. 어댑터 개발은 `feat/adapters`에서 진행하며 번들 PR #11과 별도로 관리한다. main 병합·패키지 발행은 진행하지 않는다. C1~C6 완료선을 Core v0.0.1로 부르던 구분을 유지하며, 현재 저장소의 npm 패키지 버전은 0.1.0이다. 이번 계획으로 버전을 변경하지 않는다.

상위 기준: [전체 계획 §6·§7](decoder-core-adapters-plan.md#6-3차-작업-featadapters) · [번들 B4 인계](bundle-development-plan.md#7-b4--어댑터-세부-계획에-넘길-완료-기준) · [제품·요청 범위](../../contracts/core-v1/snapshot-selection.proposal.json) · [첫 Fact 계약](../../fixtures/sdk/first-fact-contract.json). 이 문서는 해당 계약을 복제하지 않고 구현 순서·설계 선택·시험 연결을 구체화한다.

## 1. 목표와 범위

사용자가 설정한 정책 API와 EVM RPC를 기존 `PolicySource`·`FactProvider` 포트에 연결하여 **원문 요청 → Core plan → 실제 조회 → Core verdict**를 Node와 브라우저에서 실행한다. 어댑터가 서명·정책·필수 Fact의 의미를 대신 판단하지 않는다.

| 포함 | 이번 범위 밖 |
| --- | --- |
| A1: 서명된 정책 HTTP wrapper 수신·원문 보존·취소·크기 제한·조건부 조회 | 정책 서버 재구현, 자동 키 신뢰/교체, 감사 업로드 |
| A2: `portfolio.balance`의 ERC-20 `balanceOf(owner)`와 체인·블록 provenance | native 잔고, NFT, 가격/oracle, 서버 WalletState, 송금/서명 |
| A3: 두 어댑터와 실제 Core 연결, 패키지·Node/브라우저 소비, CI 연결 | 풀 30,484개 제품 확대, 런타임 Decoder 검색, npm/Cargo 발행 |

제품 snapshot 804개와 풀 3개 회귀 전용 범위를 유지한다. Day-1 정책 다섯 개의 내용·severity·외부 Fact 0개도 유지한다. A2는 catalog의 `transfer-full-balance-sweep` 및 별도 시험 정책으로 검증하며 제품 정책 활성화와 혼동하지 않는다.

스캠 탐지·태그/평판 데이터·온체인 Registry는 이후 포트 구현/메서드 확장으로 연결할 수 있다. 지금 범용 플러그인 시스템이나 노드를 먼저 만들지 않는다. 특히 현재 Core는 `registry_ref: null`만 지원하므로 온체인 신뢰 모델 변경은 HTTP 어댑터 교체만으로 완료되지 않는다.

## 2. 파일 경계와 공개 진입점

같은 npm 패키지의 선택적 ESM 모듈로 구현하며 기존 Core 포트와 root export는 유지한다. A1 어댑터와 A2-1 RPC codec, A2-2 FactProvider의 HTTP 조회·FactBatch 조립을 구현했다. A2-3의 Core 통합·실제 RPC 검증까지 완료했다. A3의 Node/브라우저 소비 예제와 tarball 소비 검증·CI 연결을 구현했고 로컬 검증을 완료했다. 원격 CI는 대기다.

| 위치 | 책임 |
| --- | --- |
| `packages/core/src/adapters/index.ts` | `@dambi/core/adapters`의 factory·설정 타입·전송 오류 export |
| `packages/core/src/adapters/policy-api.ts` | `createPolicyApiSource(options): PolicySource` |
| `packages/core/src/adapters/fact-provider.ts` | `createEvmFactProvider(options): FactProvider`; 지원 method dispatch·FactBatch 조립 |
| `packages/core/src/adapters/evm-rpc.ts` | 내부 JSON-RPC 요청 검증, chain/block 조회, ERC-20 ABI 처리 |
| `packages/core/src/adapters/http.ts` | 두 어댑터가 실제 공유하는 bounded body 읽기·취소·HTTP 오류 처리만 제공 |
| `packages/core/src/adapters/errors.ts` | 직접 호출용 `AdapterError`와 오류 code |
| `packages/core/tests/adapters/` | HTTP/RPC 전송 시험과 실제 Core 연결 시험·전용 fixture |
| `examples/sdk-adapters/` | A3의 Node/브라우저 소비 예제. URL·신뢰 키는 호스트 설정 |

- `packages/core/package.json`에 `./adapters`의 ESM/타입 export를 추가한다. `@dambi/core`를 import하는 것만으로 어댑터·네트워크·노드가 로드되거나 요청을 시작하지 않는다. 테스트/예제는 패키지 런타임에 포함하지 않는다.
- 표준 Fetch API를 사용하며 `fetch` 주입을 허용한다. 첫 ERC-20 method 때문에 대형 EVM SDK 의존성을 추가하지 않는다. 브라우저 런타임에 Node 전용 import를 넣지 않는다.
- 설정은 생성 시 검증·복사한다. endpoint·인증 header는 명시된 호스트 설정에서 받으며 환경변수 자동 탐색·숨은 endpoint 대체·자동 재시도는 넣지 않는다. redirect는 거절하고 cookie 인증은 기본 사용하지 않는다.
- `CallOptions`는 현재 `{ signal? }` 그대로다. Core는 정책 timeout과 `min(factTimeoutMs, 남은 plan TTL)`을 적용한다. 어댑터는 실제 fetch와 body 읽기에 signal을 전파한다. 포트를 직접 호출하는 소비자는 필요한 deadline을 AbortSignal로 전달한다.
- 직접 호출용 `AdapterError`는 설정/네트워크/HTTP/응답형식/크기/취소 구분과 필요한 HTTP status만 제공한다. URL의 credential·header·응답 본문을 오류 메시지에 담지 않는다. Core의 오류 union을 전송 오류 때문에 늘리지 않는다.

## 3. A1 — 정책 API 어댑터

근거: [PolicySource](../../packages/core/src/ports/policy.ts), [Registry API 구현](../../registry-api/src/server.ts), [OpenAPI SignedPolicyBundle](../../registry-api/openapi.yaml), [정책 wire 계약](../../contracts/core-v1/README.md). OpenAPI 경로 설명의 오래된 `payload: unknown` 문장보다 현재 schema·구현의 `payload: string`을 따른다.

### 3.1 요청·응답 계약

- 설정: `baseUrl`, `maxResponseBytes` 필수, `profile?: "default"`, `version?: number`, `headers?`, `fetch?` 선택. URL API로 `/v1/bundle?profile=default`를 구성한다. 첫 구현의 baseUrl은 API origin으로 제한하여 경로 prefix를 조용히 버리지 않는다. HTTPS를 기본으로 하고 로컬 시험의 loopback HTTP는 허용한다.
- `version`은 지정할 때만 양의 safe integer로 쿼리에 넣는다. 이는 서버의 sequence 선택 요청이며 Core의 서명 검증 후 특정 sequence와 일치함을 강제하는 새 신뢰 계약은 아니다. 별도 암호학적 버전 고정이 필요하면 Core 계약과 함께 확장한다.
- 200의 wrapper는 object이고 `payload`·`signature`는 문자열, 선택 `key_id`도 문자열이어야 한다. 지원 필드 이외의 wrapper 확장은 명시적으로 계약을 갱신하기 전 거절한다. `payload`가 object인 응답을 JSON 문자열로 보정하지 않는다.
- `key_id → keyId`만 변환한다. B 문자열은 parse/재직렬화·공백 정리·JCS 재생성을 하지 않고 그대로 전달한다. B 내부 schema·서명·env/profile·시간·sequence·키 역할 검증은 Core가 수행한다.
- Content-Length가 있으면 사전 확인하고, 실제 body stream의 byte 수에도 상한을 적용한다. 상한 초과·잘못된 UTF-8·JSON·중복 wrapper key·형식은 거절한다. HTTP wrapper 상한과 Core의 B 문자열 `maxPolicyBytes`는 JSON escaping 때문에 별개이며 동일하다고 가정하지 않는다.
- 404·429·5xx와 네트워크 실패는 성공 bundle로 바꾸지 않는다. 실패 시 과거 bundle을 임의 반환하지 않으며 기존 활성 snapshot 보존은 Core의 refresh 실패 처리를 따른다.

### 3.2 ETag·동시 호출·오류 경계

`cache: "no-store"`로 전송하며 조건부 header는 어댑터가 관리한다. A1-2에서 아래 ETag 상태와 실제 Core 연결 시험을 추가했다. 호출별 signal 분리와 기본 취소는 A1-1에서 이어진다.

- 인스턴스의 URL/profile/version·인증 설정은 고정한다. ETag와 마지막 **전송 형식 검사에 통과한 envelope**를 함께 보관한다. 이는 서명 검증 완료 cache가 아니다.
- 요청 시작 시 캡처한 cache/ETag에 대해서만 `If-None-Match`를 전송한다. 304는 해당 요청에 결속된 envelope가 있을 때만 재사용한다. cache 없는 304는 오류다. 200에 ETag가 없거나 단일 entity-tag 형식이 아니면 이전 조건부 cache를 지우고 다음 요청은 조건부 header 없이 진행한다.
- 취소·실패한 응답은 cache를 덮지 않는다. 나중에 시작한 요청이 우선하며 이전 응답이 늦게 도착해 최신 cache를 바꾸지 못하게 한다. 각 호출의 signal을 분리하여 한 Core의 취소가 다른 Core의 요청을 취소하지 않게 한다.
- API ETag는 wrapper byte의 식별자이며 정책 신뢰/유효기간의 증명이 아니다. 304로 반환한 B도 Core가 재검증하므로 정책 수명을 연장하지 않는다. 내부 HTTP cache가 이 처리를 가리지 않도록 Fetch cache 동작을 명시한다.
- 현재 API CORS는 `Access-Control-Expose-Headers: ETag`를 제공하지 않는다. 브라우저 cross-origin에서 ETag가 안 보이면 조건부 요청을 생략해 200 경로로 동작한다. ETag 최적화가 필요하면 API 담당의 header 보완과 실제 브라우저 시험을 추가한다.
- 현재 Core는 PolicySource의 reject를 `POLICY_FETCH_FAILED`로 정규화한다. 어댑터 직접 호출의 상세 오류와, 정상 wrapper 전달 후 Core가 반환하는 `INVALID_SIGNATURE`·`INVALID_POLICY_BUNDLE`을 구분한다. Core가 자체 deadline을 감지한 경우에는 기존 TIMEOUT/ABORTED 처리를 유지한다.

### 3.3 필수 검증

로컬 HTTP 서버로 path/query·header·원문 보존, 200→304·ETag 없음·cache 없는 304, malformed/초과 body·HTTP 실패, headers/body 대기 중 취소를 검증한다. 실제 Core와 연결해 정상 서명 init/refresh, 잘못된 서명 거절, 실패 refresh의 snapshot 보존, 늦은 응답의 cache 오염 방지를 확인한다. Core 기존 암호 시험을 전부 복제하지 않는다.

API 저장소 쪽 호환 검사는 가능하면 실제 `createRegistryApiServer`와 시험용 ObjectReader를 사용한다. SDK의 필수 격리 시험에는 독립적인 로컬 HTTP fixture를 사용하여 `registry-api` 전체를 SDK 빌드 입력으로 가져오지 않는다. 실제 배포 URL의 공동 검증은 §7 조건이 준비된 뒤 별도로 완료한다.

A1-3은 사용자가 선택한 README의 staging 설정을 [명시적 연결 파일](../../fixtures/sdk/policy-api.staging.json)로 두고, [수동 실연결 명령](../../packages/core/README.md#manual-staging-connection-check)을 실행한다. 실제 공개 키·packaged decoder·시스템 시각으로 init/refresh와 no-Fact approve 정책 연결을 확인한다. Node의 CORS header 관찰과 A3의 브라우저 실행은 구분하며, 이 명령을 일반 CI에 자동 연결하지 않는다.

## 4. A2 — 첫 ERC-20 FactProvider

권위 있는 입력/반환 예시는 [첫 Fact 인계](../../fixtures/sdk/first-fact-contract.json)를 따른다. 아래는 기존 계약을 RPC로 구현할 때의 선택이다.

### 4.1 입력·라우팅·수치

- 설정: CAIP-2 chain ID별 `rpcUrl`/선택 header, `maxResponseBytes`, 선택 `fetch`·`clock`을 받는다. 첫 실제 통합은 인계 사례의 `eip155:1`부터 시작하며 다른 체인을 자동 등록하지 않는다. clock을 주입하면 Core와 같은 시간 기준을 사용한다.
- `method === "portfolio.balance"`, 지원 `chain_id`, `asset.key.standard === "erc20"`, `asset.key.chain === chain_id`, owner/token의 정확한 20-byte hex 주소를 확인한 뒤 전송한다. 요청 URL이나 owner를 반환 데이터로 교체하지 않는다.
- batch의 각 체인에서 먼저 `eth_chainId`와 설정 체인을 대조한다. 불일치한 endpoint를 다른 체인으로 자동 수용하지 않는다. chain ID·block·balance는 BigInt/문자열로 다루고 Number로 축소하지 않는다.
- `balanceOf(address)` calldata는 `0x70a08231`과 32-byte로 왼쪽 padding한 owner다. 반환값은 정확한 32-byte ABI word만 허용한다. 결과 `{ balance }`는 lowercase·leading zero 없는 U256 hex이며 zero는 `0x0`이다. decimals/USD 변환을 하지 않는다.
- 모든 RPC 응답의 `jsonrpc: "2.0"`, 요청 ID 일치, result/error의 배타적인 구조를 검사한다. revert·빈 `0x`·잘린 word·다른 ID를 정상 잔고로 처리하지 않는다. Data와 Quantity 형식은 [EIP-1474](https://eips.ethereum.org/EIPS/eip-1474)를 따른다.

### 4.2 블록·provenance·cache

- 최초 범위는 현재 상태 조회다. 각 fetch의 체인별로 `eth_blockNumber`를 조회한 뒤 그 높이를 `eth_call`의 명시적 block 인자로 사용한다. [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/#the-block-parameter)의 숫자 block 인자 규칙을 따른다.
- `FactResult.blockNumber`에는 실제 요청 높이를 decimal 문자열로 기록한다. `observedAt`은 해당 eth_call 시작 시점의 Unix ms로 고정하여 느린 응답을 받은 시각으로 신선도를 늘리지 않는다. `source`는 `onchain:eip155:1:eth_call` 같은 고정 표기이며 credential을 포함하지 않는다.
- 높이 결속은 RPC 응답 인증·블록 hash 일치·finality/reorg 방지를 보장하지 않는다. [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898)의 blockHash/requireCanonical 지원과 Core의 추가 provenance 계약은 필요한 후속 단계로 남긴다.
- 명시 block selector는 첫 구현에서 지원하지 않는다. 그런 params를 받으면 latest로 무시하지 않고 해당 call을 미지원으로 처리한다. 이후 도입할 때 resolved params와 cache key에 반영하며 provider의 숨은 설정으로 의미를 바꾸지 않는다.
- 어댑터 자체 Fact cache는 두지 않는다. 기존 Core cache를 사용하며 최초 observedAt·blockNumber를 보존한다. 원본 catalog의 `optional: true` 응답만으로는 Core cache가 채워지지 않는다. 기존 명시 block 시험은 mock 계약 시험이며 RPC 구현 완료를 뜻하지 않는다.

### 4.3 FactBatch·실패·취소

`options.planId`와 전달받은 opaque `callId`를 그대로 돌려준다. `value`는 projection 전 `{ balance: "0x64" }`이며 RPC envelope·32-byte word·이미 투영한 문자열이 아니다. Core가 manifest의 `$.result.balance`를 한 번 적용한다.

| 상황 | 어댑터 결과 |
| --- | --- |
| 미지원 method/chain/표준, 잘못된 개별 params, 개별 eth_call의 HTTP/RPC 오류·revert·잘못된 응답 | 해당 call을 results에서 생략하고 성공한 형제 결과 보존 |
| 특정 체인의 eth_chainId/eth_blockNumber 공통 준비 요청 실패 | 그 체인의 관련 call을 생략. 다른 체인의 성공은 보존 |
| fetch 입력의 잘못된 planId·중복 callId 등 batch 결속 오류, 전체 작업 취소 | 전체 fetch reject. 중간 결과를 성공으로 반환하지 않음 |
| 지원 요청 전부가 네트워크/HTTP 장애 또는 체인 확인·블록 확보 실패로 실행 불가 | 전체 fetch reject. 모든 개별 revert/미지원으로 인한 빈 결과와 구분 |
| 빈 calls | 동일 planId와 빈 results 반환, 네트워크 요청 없음 |

body 크기·UTF-8·JSON 오류도 발생한 요청 단계에 따라 공통 준비 실패 또는 개별 조회 실패로 분류한다. `optional`에 따른 허용 여부와 최종 판정은 Core에 맡긴다. 실패를 잔고 0이나 error 객체를 넣은 Fact로 바꾸지 않는다. 원본 catalog의 `optional: true`를 유지하고 필수 누락 시험만 별도 `optional: false` 시험 정책으로 구성한다.

첫 구현은 fetch 안에서 작은 고정 동시성 한도 4로 요청 수를 제한한다. JSON-RPC batch 전송·자동 retry·endpoint failover는 넣지 않는다. 전달된 signal로 진행 중 HTTP와 아직 시작하지 않은 작업을 중단하며, 동시 fetch가 controller를 공유하지 않게 한다. Core dispose/timeout 이후 늦은 응답을 반환하거나 공유 상태에 저장하지 않는다.

### 4.4 필수 검증

입력/endpoint chain 불일치의 무전송 또는 무조회 거절, calldata·block 인자, zero/일반/U256 최대값, JSON-RPC 오류·잘린 word, opaque ID·부분 실패·순서 역전, 실제 signal 취소를 묶어 시험한다. 실제 Core로 원본 optional 누락, 시험용 required 누락의 fail-closed, 성공 Fact의 단일 projection과 cache provenance 보존을 확인한다. SDK 필수 CI는 로컬 RPC fixture로 재현하고 실제 RPC+ERC-20 조회는 별도 연결 검증으로 남긴다.

## 5. 단계별 실행 순서

| 단계 | 구현 단위 | 완료 조건 |
| --- | --- | --- |
| A1-1 진입점·HTTP 기본 — 완료 | subpath export, 설정/전송 오류, bounded HTTP, wire→port mapping | 로컬 HTTP 원문·형식·크기·query 시험과 소비자 타입 검사, 새 시험 CI 연결 |
| A1-2 상태·Core 연결 — 완료 | ETag, 동시 호출/취소, 실제 Core init/refresh | cache·timeout·서명/refresh 실패 경계를 실제 Core로 검증 |
| A1-3 실제 API 확인 — 완료 | 배포 URL·신뢰 키·인증/CORS·발행본 연결 | 실제 서명 bundle init/refresh. 환경 미확정이면 구현 완료와 별도로 대기 표시 |
| A2-1 method·ABI — 완료 | params/체인/주소·U256·JSON-RPC codec | 순수 변환 및 거절 경계 시험. Node 전용 런타임 의존 없음 |
| A2-2 RPC·FactBatch — 완료 | 체인/블록 조회, 제한 동시성, 부분 실패·취소 | 로컬 RPC의 실제 HTTP 경로에서 ID·값·provenance·실패표 검증 |
| A2-3 Core·실제 RPC — 완료 | optional/required Core 연결, 지정 endpoint와 ERC-20 공동 확인 | Core 계약 시험 및 실제 조회의 체인/높이/잔고 대조. live 결과를 fixture 성공과 구분 |
| A3 전체 연결·소비 — 로컬 검증 완료·원격 CI 대기 | 두 포트 조합, tarball Node/브라우저 예제, 격리 CI | 아래 소비자 완료 조건과 관련 CI 통과 |

A1-3의 외부 환경이 준비되지 않아도 A2-1/A2-2 구현은 진행할 수 있다. 다만 실제 연결까지 포함한 어댑터 전체 완료로 표시하지 않는다. 추가 method는 B4의 실제 제품 요구가 생긴 것만 후속으로 선정하며 A3에 무조건 포함하지 않는다.

## 6. A3와 CI 완료 조건

- 서명된 Day-1 bundle로 raw approve의 no-Fact 경로를 확인한다. 별도로 시험 키로 서명한 balance 정책으로 raw transfer → A1 → plan → A2 → verdict를 연결한다. 시험 정책을 운영 API나 Day-1 원본에 게시하지 않는다.
- 실제 tarball을 저장소 밖 Node 소비자와 최소 브라우저 소비자에서 사용한다. Core/decoders/adapters ESM export·타입·WASM/asset 경로, HTTP/RPC CORS, 취소, 실패 판정을 확인한다. workspace link·기존 dist 직접 import는 패키지 소비 검증을 대신하지 않는다.
- Node용 자격 증명을 브라우저 예제에 넣지 않는다. 브라우저는 공개 사용이 허용된 endpoint/호스트 proxy 설정을 사용한다. 운영 인증 방식과 RPC 사용 조건은 §7에서 확정한다.
- [전체 계획 §7.2](decoder-core-adapters-plan.md#72-개발-중-sdk의-ci-확장-기준)에 따라 기능 PR에는 `ci:full`을 사용한다. 기능별 새 시험을 같은 변경에서 실제 job에 연결한다. SDK 시험은 운영 RPC·서버·기존 확장 WASM에 의존하지 않는다.
- `core:test:adapters`는 A1-1에서 root와 package/격리 workspace scripts에 연결했다. 후속 시험도 `scripts/sdk/sdk-source-files.json`의 복사 범위와 `verify-isolated.mjs`·package script의 명시적 실행 목록에 연결한다. 릴리스 검증도 같은 시험을 실행하며 자동 시험 발견을 가정하지 않는다.
- A3의 `core:test:consumers`는 저장소 밖 tarball 설치에서 Node·타입·Chromium을 검사한다. `core-consumers` job은 `core`의 격리 빌드 tarball을 재사용하며 Core/소비자 변경 시 두 job을 함께 선택한다. 릴리스도 소비 시험을 통과한 동일 tarball을 게시한다. 로컬 소비 검증은 완료했고 원격 CI는 대기다. API 호환시험이 어댑터 소스를 사용한다면 어댑터 변경으로 API 검사도 선택되게 한다. `ci:full`만으로 이후 일반 PR의 의존성 선택을 대신하지 않는다. 공통 SDK와 Native/WASM 경계를 바꾸면 관련 회귀와 전체 CI를 실행한다. 문서만 바뀐 경우에는 재빌드하지 않는다.
- live 검증은 명시적으로 선택한 환경에서 실행한다. 자격 증명/환경이 없으면 미실행으로 남기며 skip을 live 성공으로 기록하지 않는다. 일반 CI는 재현 가능한 로컬 HTTP/RPC 사례를 필수 검사한다. 전체 npm/Cargo 출시 조건은 상위 §7.1에 별도로 남는다.

## 7. 실제 연결 전에 필요한 환경

아래 항목은 로컬 구현을 막는 선행 조건이 아니다. 각 공동 검증 전에 SDK 담당이 API/RPC 담당과 확인하며 운영값을 추정하지 않는다.

| 확인 항목 | 필요한 시점·담당 |
| --- | --- |
| API origin, staging/production, policy 역할 공개 키, default profile, 소비자 인증·CORS | README의 staging/default·policy 키로 익명 실연결 확인 완료. Node에서 CORS header 관찰 완료. 로컬 브라우저 소비 확인; 배포 origin의 CORS 확인은 별도 |
| 현재 발행 sequence·issued_at·재발행 주기 | 최신 발행본으로 실연결 재검증 완료. 재발행·나이 확인 Job과 스케줄 배포 확인, 최초 일일 예약 실행 관찰은 API 운영 담당의 후속 확인. `expires_at: null`도 최대 나이 72시간 적용 |
| chain별 RPC endpoint·자격 증명·browser 허용·실제 ERC-20/owner 사례 | eip155:1·공개 PublicNode HTTPS·USDC·고정 dead 조회 주소로 예제 준비. 개인 지갑/인증정보 없이 Node 수동 검증 완료. 로컬 브라우저 소비 확인; 실제 RPC의 브라우저 접근 허용은 배포별 확인 |
| browser ETag 최적화 필요 여부 | A1-3/A3: 필요할 때만 API의 Expose-Headers 보완. 미노출 200 경로 자체는 지원 |
| 소비자 limits·Fact 허용 나이·enforcement | A3 예제에서 호스트 입력. 로컬 시험의 명시값을 운영 권장값이나 안전 보장으로 표현하지 않음 |

## 8. 진행·기록

현재 상태는 **A1-1~A2-3 완료 / A3 tarball Node·타입·브라우저 로컬 검증 완료 / 원격 CI 대기 / staging·실제 RPC Node 연결 확인**이다. 개발 브랜치는 `feat/adapters`이며 번들 PR 병합은 별도 승인 대상으로 남는다.

소단계마다 기능과 필요한 검증을 함께 마친다. 결과는 기존 `fixtures/sdk/README.md` 한 곳에 변경 범위·통과/실패·남은 문제만 짧게 기록하고, 이 문서에는 단계 상태만 갱신한다. 커밋은 독립적인 구현 단위에 맞춰 나누며 문서만을 위한 중복 시험·해시 기록은 만들지 않는다.
