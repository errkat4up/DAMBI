# Dambi Core 세부 개발 계획

작성일: 2026-09-14. 수정일: 2026-09-28. 상위 계획은 [Decoder·정책 → Core → Adapters](decoder-core-adapters-plan.md)이며, 이 문서는 Core의 C1~C6 실행 순서와 VS Code 작업 기준을 구체화한다. **C1·C2-0a~c·C2a/b/c·C3-1/2/3 완료. C4 구현 및 Store 사용자 검증 완료·Decoder 시험 결과 확인 대기. C5 구현 및 타입·JS/WASM 사용자 검증 완료·Native session 시험 결과 확인 대기.**

문서 상태: **v0.1 작업 초안**. 구현·검증에서 확인한 의존성과 비용에 따라 단계 분할·순서·설계를 수정할 수 있다. 이미 검증한 동작과 명시적으로 합의한 계약, 아직 제안인 API·제품 범위를 구분한다. 계획의 추정을 구현 사실로 취급하거나 계획을 맞추기 위해 불필요한 절차를 추가하지 않는다. 이 문서 버전은 현재 SDK 패키지 버전 `0.0.1`과 별개다.

## 1. 출발점과 착수 범위

- 현재 작업 브랜치는 `feat/core`, 기준 커밋은 `3f0ad6b`이며 로컬 `main`도 같은 커밋이다. 2026-09-28 GitHub 비교 API로 원격 `main`도 동일함을 재확인했다. `feat/decoder`는 `4803a2a`다. Core 브랜치 준비는 끝났으며 이 문서의 API 대조 기준도 `3f0ad6b`다.
- [Decoder 인계](../../fixtures/decoder-policy/README.md#dec-07--decoder-인계), [D3 정책 검증](../../fixtures/sdk/README.md#결과-기록), [D4-1 계약 fixture 검증](../../contracts/core-v1/README.md#결과-기록)은 완료됐다. 기존 통과 수와 로그는 해당 기록을 따르며 여기 복제하지 않는다.
- `packages/core` 0.0.1은 C5에서 `createCore/plan/evaluate/refreshPolicies/dispose`를 SDK 전용 WASM과 연결했다. `check`·Fact 자동 조회·cache·hook은 C6에 남아 있다. 과거 `backup/core-sdk-b219617`의 코드·시험 결과를 현재 구현으로 사용하지 않는다.
- D4-1 완료는 **당시 SDK 초안의 fixture 검증**이다. C1-1에서 현재 `GET /v1/bundle`의 payload 필드·sequence 타입·wrapper에 맞춘 변경의 사용자 실행 검증을 마쳤다. 실제 운영 API 통합 검증은 후속이다. 기존 통과 기록을 수정된 계약의 검증 결과로 재사용하지 않는다.
- [D4-2 제품 선택안](../../contracts/core-v1/snapshot-selection.proposal.json)은 미확정이다. D4-2·D4-3은 C1/C2 및 고정 fixture를 사용하는 C3~C6 개발의 전체 선행 조건이 아니다. 제품 범위·제품 snapshot 재현성·최종 배포 완료 표시는 확정된 D4-2·D4-3 결과가 있어야 한다.

이번부터의 흐름은 **C1-1 정책 API·fixture 정합화 → C1-2/3 공개 타입·소비자 검증 → C2 소스·실행부 추출 → C3 신뢰 검증 → C4 snapshot → C5 plan/evaluate → C6 check**다. 별도 준비 단계를 늘리지 않고 C1 안에서 계약을 맞춘다. C3는 정합화한 계약과 최소 `dambi-core` 경계가 준비되면 fixture 기반으로 병행할 수 있다. D4의 제품 결정은 별도 항목으로 유지한다.

사용 가능한 결과를 다음 두 이정표로 확인한다. C1~C6는 구현 책임이고, M1/M2는 그 책임을 관통하는 실행 사례다. M1 성공만으로 Core 전체를 완료 처리하지 않는다.

| 이정표 | 실제 연결할 경로 | 완료 근거 |
| --- | --- | --- |
| **M1: approve 첫 판정** | 시험 서명 정책 + 고정 Decoder → `await createCore` → raw approve → `plan/evaluate`, 이어서 `check` | 실제 Rust/WASM에서 일반 금액 allow, 최대 승인 warn, 기존 Permit2 spender 예외 유지. Fact 호출 없이도 전체 경로 실행 |
| **M2: transfer + 첫 Fact** | raw transfer → 계획 → mock `portfolio.balance` → 원본 응답 검증·projection → 판정 | 잔고와 같은 금액의 catalog warn, optional 누락 보존. 별도 필수 manifest로 누락·잘못된 값·계획 불일치·오래된 응답·취소 검증 |

M1은 C2~C5의 필요한 경로를 먼저 연결한 뒤 C6의 얇은 `check`까지 확장한다. M2에서 Fact 조율을 완성하고 나머지 인계 요청·회귀를 연결한다. 추출 과정에서는 첫 사례가 approve라는 이유로 기존 Decoder 지원을 지우거나 회귀를 생략하지 않는다. 운영 API·키·실제 RPC·제품 snapshot 선택은 이 두 개발 이정표의 선행 조건이 아니다.

## 2. 책임과 파일 경계

```text
PolicySource ─ 원본 B와 서명 → Core parser·서명·의미 검증 → snapshot
요청 ─ 정규화·Decoder(snapshot) → Action → plan(handle, Fact 호출 목록)
FactProvider ─ projection 전 의미 응답 → Core 검증·projection → evaluate → Verdict
check ─ 위 단계를 조율하며 timeout·cache·hook을 처리
```

| 영역 | 현재 근거 → Core 소유 위치 | 책임 |
| --- | --- | --- |
| JS 공개 API | `packages/core/src/{core,ports,types,index}.ts` | 입력·포트·계획 handle·판정 타입, 초기화/종료, async 조율 |
| 공통 Rust 모델 | `crates/policy-server/asset-model/{state,action,transition}` → `crates/asset-model/` | 기존 crate 이름·직렬화 유지, 서버 경로 의존 제거 |
| Decoder | `crates/policy-engine-wasm/src/declarative_exports.rs` → `crates/dambi-core/src/decode/` | 설치·조회·해석 상태의 인스턴스 소유권, transaction/typed 경로 |
| 정책 평가 | `action_eval_exports.rs` → `crates/dambi-core/src/runtime/` | lower·manifest 선택·계획·materialize·Cedar 평가. 기존 `policy-engine` 재사용 |
| 신뢰·snapshot | 신규 `crates/dambi-core/src/{bundle,snapshot}/` | 엄격한 입력 검증, 역할별 키, 검증 후 활성화, 계획이 참조하는 불변 상태 |
| WASM 경계 | 신규 `crates/dambi-core-wasm/` | Rust 실행부의 얇은 wrapper. WASM용 상태와 JS 오류/타입 연결 |
| schema·fixture·빌드 | `crates/policy-engine/schema/`, `fixtures/sdk/`, `scripts/sdk/` | SDK 소유 입력·출력, 확장/서버 없는 소스 빌드 |
| 외부 통신 | 후속 A 단계의 `packages/core/src/adapters/` | HTTP/RPC·인증·ABI 응답 해석. 최종 정책 판정은 Core 책임 |

Core 내부의 snapshot·계획 수명·cache와 호스트의 영구 저장·감사·UI를 구분한다. 현재 scaffold의 “Core는 저장하지 않는다” 주석을 이유로 계획 무결성에 필요한 내부 상태까지 호스트에게 맡기지 않는다. 원격 통신은 mock 포트로 대체하되 Decoder·암호 검증·평가 엔진은 실제 구현을 사용한다.

## 3. Core 계약 권장안

§3.1은 현재 API 구현·OpenAPI·결정문서를 기준으로 SDK 초안을 맞춘 계약이다. 초기화·Decoder 구성·계획 소비·감사 메타데이터는 **C1 공개 타입과 C5 실행부에 반영했다**. 정확한 export·필드와 digest 입력 규칙 및 확인된 검증 결과는 [패키지 README](../../packages/core/README.md) 및 공개 타입을 따른다. B 원문·Fact 의미·기존 정책 severity를 유지하고, API에 이미 정의된 내용을 다시 미정으로 돌리지 않는다.

| 항목 | C1 이전 scaffold | C1 작업·결정 |
| --- | --- | --- |
| 초기화·수명주기 | 동기 `createCore(config)`, 구현은 throw | `Promise<DambiCore>`로 변경. 준비 완료 인스턴스만 반환하고 명시적 정책 갱신·종료 제공 |
| 정책 입력 | `payload: unknown`, 평면 `signature/keyId?`, JCS 설명 | B 문자열 UTF-8 원문 유지. API의 평면 wrapper를 SDK 타입에 매핑. optional `key_id`는 telemetry이며 검증 키 선택 근거로 사용하지 않음 |
| Fact 값 | `FactResult.value`를 “투영 후 값”으로 설명 | projection 전 메서드 의미 응답. `source`, 관측시각, 블록과 call ID·요청 결속 유지 |
| Decoder 입력 | `load(selector, chainId)` | 초기 버전은 고정 Decoder snapshot을 설정으로 제공. 실제 chain·target·selector/typed 매칭은 Core Registry에서 수행 |
| 포트 구성 | policy/fact/decoder 3종 + clock | 외부 I/O는 policy/fact 두 포트. clock은 설정, Decoder는 내장 입력. `DecoderSource` 공개 export 제거는 호환성 변경으로 명시 |
| 계획·평가 | `plan(req, policies) → PlannedCall[]`, `evaluate(req, policies, facts)` | 계획 handle에 인스턴스·요청·해석 결과·정책/decoder·필수 Fact를 고정. 평가 시 임의 요청·정책으로 대체할 수 없는 계약 |
| 판정·오류 | allow/warn/deny, evaluated/fail_closed, enforcement | 기존 구분 유지. 초기화/호출 오류와 요청 판정을 나누고 안정적인 오류·진단 code 추가 |
| 감사 연결 | `onVerdict(verdict)`에 요청/정책/엔진 식별 정보 없음 | 실제 판정에 결속된 메타데이터를 Verdict와 hook에서 공유. HTTP 전송·API key·재시도는 호스트/어댑터 책임 |
| 공개 표면 | 알려진 요청 4종과 별도 `UnsupportedRequest` | 선언된 요청과 실제 구현된 경로를 구분. 초기 미구현을 지원 완료로 표시하지 않으며 추가 export는 목적·호환성 확인 후 도입 |

### 3.1 정책 API와 계약 fixture 정합화

기준은 [현재 OpenAPI](../../registry-api/openapi.yaml), [정책 발행기](../../registryV2/scripts/publish-policy-bundle.ts), [ADR 0001](../decisions/0001-cloud-split.md)이다. `contracts/core-v1/`의 기존 SDK 초안을 이 기준과 맞춘 뒤 공개 타입을 고정한다.

| 항목 | 실제 API 기준과 C1 반영 내용 |
| --- | --- |
| 서명 wrapper | HTTP는 `{ payload: string, signature: string, key_id?: string }`. SDK 권장 타입은 기존 명명에 맞춘 `{ payload: string, signature: string, keyId?: string }`. A1은 바깥 필드명만 매핑하며 D4 초안의 `sig` 중첩 wrapper는 교체 |
| 서명 원문 B | 발행기가 만든 JCS 문자열의 UTF-8 바이트를 그대로 검증. P-256/SHA-256·64바이트 P1363·Base64는 고정 알고리즘/인코딩. 수신 측에서 B를 재직렬화하거나 응답의 `alg`로 알고리즘을 선택하지 않음 |
| payload 필드 | `policies`, `sequence`, `issued_at`, `expires_at`, `env`, `profile`, `registry_ref`가 필수. 최상위 `schema_version: 1` 요구를 제거. 각 정책 **manifest의 `schema_version: 2`는 유지** |
| sequence | JSON 정수 `1..9007199254740991`. D4 초안의 0 이상 십진 문자열을 교체. 문자열·0·소수·범위 밖 수를 거절하고 검증 후 수치로 비교 |
| key ID·신뢰 | API의 `key_id`는 선택적 telemetry. 누락·알 수 없는 ID만으로 유효 서명을 거절하거나 응답이 지정한 새 키를 신뢰하지 않음. 로컬에 고정된 policy 역할 키로 검증하고 decoder 역할 키를 대신 사용하지 않음 |
| 시간·scope | Unix 초, `env`는 `staging/production` 중 설정값과 일치. v0.1 `profile`은 `default`, `registry_ref`는 `null`. non-null registry ref는 `UNSUPPORTED_REGISTRY_REF`로 구분. `expires_at`은 현재 발행 시 null이며 숫자를 받으면 issued_at 이후인지 검사 |

**B 내부 필드 차이는 A1 어댑터에서 보정하지 않는다.** `sequence`를 문자열로 바꾸거나 version 필드를 삽입하면 서명 원문이 달라진다. C1-1에서 `contracts/core-v1/{types.ts,policy-wire.schema.json,helpers/structure.mjs,fixtures.mjs,contract.test.mjs,examples/}`와 README를 함께 정합화하고, 바뀐 B fixture는 시험 전용 키로 다시 서명한다. 원문 보존·서명 변조·키 역할·parser/semantic 인계 사례는 유지하되 구조 오류 때문에 의미 검증 사례가 가려지지 않게 기대 계층도 맞춘다. 기존 D3 정책 콘텐츠는 변경하지 않는다.

정책 최대 나이는 ADR의 **v0.1 시작값 `maxBundleAgeSec = 259200`(72시간)**을 적용한다. 유효 기한은 `issued_at + maxBundleAgeSec`와 숫자 `expires_at` 중 더 이른 값이며, null이면 최대 나이만 적용한다. 이는 Core 설정값이고 API payload 필드가 아니다. clock skew·입력 크기·계획/Fact 한도는 여전히 SDK에서 구체화할 항목이다. 시간 시험은 고정 clock을 사용하며 오래된 저장 번들을 최신 정책으로 취급하지 않는다.

정책·Decoder 키의 역할 분리는 유지한다. ADR의 후속 결정대로 v0.1 개발은 별도 로컬 개발 키를 사용하며 신규 KMS 구축이나 향후 온체인 전환을 C1~C6 선행 조건으로 넣지 않는다. 로컬 개발 키를 운영 신뢰 설정에 자동 추가하지 않는다.

**API 담당 수정 항목:** 현재 발행기의 기본 입력은 사라진 `browser-extension/default-bundles`를 가리킨다. D3 공유 원본 `policy-bundles/`와 그 패키지 선언을 읽도록 수정하고, [공유 loader](../../scripts/sdk/policy-bundle.cjs)의 정책 ID·severity·manifest 일치 기준을 재사용한다. 실제 정책 재발행과 A1 연동 전에 해결할 항목이며 Core의 고정 fixture 개발은 계속할 수 있다. C1-1에서는 SDK fixture만 갱신했으며 실제 발행기는 미수정이다.

### 3.2 생성·포트·수명주기

C1에서 반영한 공개 진입점이다. 아래 타입은 빌드 후 공개 패키지에서 import할 수 있으며, C5 실행부를 연결했다. `check`는 C6 구현 전까지 `NOT_IMPLEMENTED`로 reject한다.

```ts
declare function createCore(config: CoreConfig, options?: CallOptions): Promise<DambiCore>;

interface DambiCore {
  plan(req: CheckRequest, options?: CallOptions): Promise<CorePlan>;
  evaluate(plan: CorePlan, facts: FactBatch): Verdict;
  check(req: CheckRequest | UnsupportedRequest, options?: CallOptions): Promise<Verdict>;
  refreshPolicies(options?: CallOptions): Promise<void>;
  dispose(): void;
}

interface CallOptions { signal?: AbortSignal }
interface PolicySource {
  fetch(options?: CallOptions): Promise<SignedPolicyBundle>;
}
interface FactProvider {
  fetch(calls: readonly PlannedCall[], options: CallOptions & { planId: string }): Promise<FactBatch>;
}
```

`CoreConfig`는 `ports: { policy, fact }`, `decoderSnapshot`, 역할별 로컬 신뢰 키·env/profile을 담는 `trust`, 실행 한도를 담는 `limits`, 선택적 `clock/hooks`, 필수 `enforcement`로 구성한다. `limits`는 §3.1의 `maxBundleAgeSec` 외에 clock skew, 정책/Decoder/요청/FactBatch 크기, 계획 TTL/보관·call 한도, Fact 최대 나이, 정책/Fact 조회 timeout을 명시한다. 정확한 필드와 단위는 `CoreLimits`를 따른다. 나머지 미정 운영값에 임의 기본값을 넣지 않고 fixture에는 명시적인 시험 설정을 쓴다.

- **생성:** WASM 준비와 정책 fetch를 병렬로 수행한 뒤, Native session 생성에서 고정 Decoder 무결성/구조 검사·설치 → B 원문 서명·의미 검증 → 활성 snapshot 생성을 완료한다. 실패하면 자원을 정리하고 `CoreError`로 reject한다. 부분 초기화 인스턴스를 반환하지 않는다.
- **내장 Decoder:** 신뢰 가능한 로컬 패키지/설정에 고정된 예상 digest와 artifact를 비교한다. artifact와 함께 온 자기 주장 digest만으로 신뢰하지 않는다. C1~C6 초기 경로에는 원격 Decoder 자동 조회·갱신을 넣지 않는다. 외부 Decoder의 별도 역할 서명 검증 능력은 C3에서 준비하되, 공개 로딩 API는 필요가 생길 때 별도 계약으로 추가한다.
- **정책 갱신:** `refreshPolicies`는 현재 고정 Decoder와 호환되는 새 정책을 전부 검증한 뒤 활성 snapshot만 원자적으로 교체한다. 실패하면 기존 상태를 유지한다. 초기 버전에는 자동 갱신 timer를 두지 않는다.
- **종료·취소:** `dispose`는 여러 번 호출해도 안전하고 진행 중 I/O 취소, 계획·cache 해제, WASM 자원 정리를 수행한다. 종료 후 신규 호출은 수명주기 오류다. 생성·계획·조회·갱신에 전달한 `AbortSignal`은 외부 포트까지 전파하며, 취소를 무시하고 늦게 도착한 결과도 상태에 반영하지 않는다.

### 3.3 계획과 Fact의 결속

`CorePlan`은 Core가 발급한 불투명 handle(opaque handle)이며, 호스트에는 읽기 전용 `planId`, `calls`, `expiresAt`(Unix 밀리초)를 노출한다. 요청·Action·정책/Decoder snapshot·필수 call의 권위 있는 복사본은 Core 내부에 보관한다. `readonly` 타입이나 caller가 다시 보낸 객체 내용을 무결성 증거로 삼지 않는다.

```ts
interface FactBatch {
  planId: string;
  results: Record<string, FactResult>; // key = plan이 발급한 callId
}

const core = await createCore(config);
try {
  const plan = await core.plan(request);
  const facts = await config.ports.fact.fetch(plan.calls, { planId: plan.planId });
  const verdict = core.evaluate(plan, facts);
  // 별도 요청을 처음부터 실행할 때: await core.check(anotherRequest)
} finally {
  core.dispose();
}
```

C1 타입 계약에서 계획은 **한 번 소비**한다. 유효한 자기 인스턴스 handle을 접수할 때 원자적으로 소비하며, Fact 검증 실패도 소비에 포함한다. 재시도는 새 `plan`을 만든다. 다른 인스턴스·위조·재사용 handle은 거절한다. `expiresAt`은 plan TTL의 Unix 밀리초 기한이다. handle 유효성·TTL을 먼저 검사해 호출 오류를 구분하고, 통과한 handle의 신뢰 snapshot 만료는 별도로 fail-closed 판정한다. 따라서 plan TTL이 신뢰 유효 기간을 연장하지 않는다. 실효성 검증은 C5에서 구현하며, 갱신 전 계획은 고정한 snapshot이 여전히 유효할 때만 평가한다. 보관 한도와 만료 정리로 방치된 계획을 제한한다. 사용자에게 보인 `calls`를 변경해도 Core의 필수 Fact 목록은 바뀌지 않는다.

Fact는 정확한 `planId`와 알려진 `callId`에만 결합한다. 공개 `callId`는 계획 안에서 유일한 opaque ID로 취급한다. multicall의 여러 child가 같은 manifest/spec을 쓰더라도 충돌하지 않게 Core가 `(노드 경로, manifest ID, spec ID)`를 구분하고, 하위 엔진에 전달할 때 원래 call ID로 매핑한다. 기존 `<manifest_id>::<spec_id>`만을 전체 트리의 고유 키로 사용하지 않는다. 계획 ID는 요청 혼동을 방지하며 provider의 응답 진실성을 인증하지 않는다. 필수/선택 여부는 Core에 고정된 manifest의 `call.optional`이 결정한다. 임의 결과 추가·누락·projection 실패·시간/블록 메타데이터를 각각 검사하고 실패를 zero로 바꾸지 않는다.

첫 Fact 인계는 [portfolio.balance](../../fixtures/sdk/first-fact-contract.json)를 따른다. Core 원본 값은 `{ balance: "0x64" }`이며 JSON-RPC envelope·ABI word·투영된 `"0x64"` 문자열이 아니다. `observedAt`은 Unix **밀리초**, 정책 API의 `issued_at/expires_at`은 Unix **초**이므로 암묵적인 단위 변환을 만들지 않는다. `source` 문자열은 출처 표시이며 인증 증거가 아니다. balance의 canonical U256 검사는 메서드를 아는 provider/adapter의 책임이며, Core의 일반 `String` projection만으로 완료했다고 보지 않는다.

### 3.4 오류와 판정

판정의 `decision/source/enforcement`와 정책 severity는 유지한다. `CoreError.code`와 판정에 부가하는 진단 code는 C1에서 문자열 union으로 정의했으며, 엔진의 내부 오류 문자열에 소비자가 의존하게 하지 않는다. `source: evaluated`는 지원 범위 전체의 안전 보장을 뜻하지 않으므로 미지원/부분 해석 여부도 진단에 명시한다.

| 상황 | 권장 처리 |
| --- | --- |
| 생성·정책 갱신 중 서명/구조/의미 검증 실패 | 구조화된 오류로 reject. 갱신은 기존 정상 snapshot 보존 |
| 위조·타 인스턴스·재사용·TTL 만료 handle, 종료한 인스턴스 호출 | 직접 API 호출은 프로그래밍/수명주기 오류 throw. 성공 Verdict로 변환하지 않음 |
| 알려진 요청의 malformed, 필수 Fact 실패, 만료된 신뢰 상태, 전역 lower/계획/실행 오류 | `check`는 `deny + fail_closed`와 원인 진단. `plan`의 실패는 reject하며 `check`가 판정으로 매핑. malformed의 기존 확장 warn 경로를 통일하는 것은 신규 SDK 제안 |
| 유효한 handle을 받은 직접 `evaluate`의 Fact 검증/필수 누락/신뢰 만료/전역 평가 실패 | 계획을 소비하고 `deny + fail_closed` Verdict 반환. 잘못된 handle을 사용한 호출 오류와 구분 |
| 기존 평가기의 bundle-local quarantine | 해당 bundle의 기존 warn과 정상 bundle 판정 집계 유지. C3에서 거절할 잘못된 서명/의미 입력을 이 fallback으로 통과시키지 않음 |
| 순수 미지원 kind | 기존 R1의 `warn` 유지. 실제 지원 완료나 완전한 평가로 표시하지 않음 |
| 부분 해석 | 알려진 outer/child 판정을 집계하고 Unknown이 있으면 최소 warn. 우선순위는 deny > warn > allow. child deny와 모든 진단 보존 |
| 빈 정책 envelope | D4-1의 `policies.minItems = 1`에 따라 생성/갱신에서 거절. 하위 Rust 엔진의 빈 배열 Pass는 기존 엔진 회귀로만 유지 |
| 정책 미매칭 | 유효하고 비어 있지 않은 snapshot·완전한 해석·실행 오류 없음이 전제면 `allow + evaluated`. `no_matching_policy` 진단으로 구분하며 다른 warn/deny를 덮지 않음 |
| 선택 Fact 누락·projection 실패 | 기존 optional 의미 유지. 임의 zero·필수 실패·해당 정책 warn을 만들어 넣지 않음 |
| `check` 실행 중 취소·timeout | 성공 판정으로 처리하지 않고 `deny + fail_closed`와 원인 진단. 직접 `plan/refreshPolicies` 취소는 reject |
| hook 예외 | 진단만 남기고 이미 결정한 판정과 필수 검증 흐름 유지 |

근거는 `contracts/core-v1/policy-wire.schema.json`의 빈 목록 금지, `action_eval_exports.rs`의 `evaluate_matching_bundles`, 기존 `orchestrator.ts`의 `evaluateBodyTree/aggregateV2Verdicts`다. 현재 확장의 빈 resolved 목록 warn과 하위 엔진의 빈 배열 Pass를 SDK의 유효한 정책 로드 성공으로 혼동하지 않는다. 부분 해석의 집계 우선순위는 유지하되, 중첩 child 오류가 앞서 모은 정책 이유를 버릴 수 있는 실행 구조는 C5에서 보완한다.

### 3.5 감사 로그용 메타데이터

[구현된 감사 API](../../crates/policy-server/server/src/audit_handlers.rs)는 `event_id`, `request_digest`, `verdict`, `policy_version`, `engine_version`을 요구하며 raw 요청이나 전체 Verdict 객체를 받지 않는다. Core에는 판정에 고정된 `requestDigest`, `policyVersion`, `engineVersion`을 담는 `Verdict.metadata`를 C1 공개 타입에 추가했다. `status: available/unavailable`로 제공 가능 여부를 구분한다. `check/evaluate` 반환과 `onVerdict`가 같은 메타데이터를 사용한다.

- `requestDigest`는 실제 판정에 고정한 요청에서 만든다. C1은 선언된 요청 필드를 복사한 `request`와 `domain: dambi.core.request.v1`의 JCS를 UTF-8/SHA-256으로 해시하도록 정의했다. 문자열 변환·기본값 삽입 없이 전체 typedData/order/message를 포함하며 세부 거절 규칙은 패키지 README를 따른다. C5에서 계산한다. API 형식은 `0x` + 소문자 hex 64자리다.
- `policyVersion`은 **해당 계획 snapshot의 sequence**를 십진 문자열로 표현한다. 감사 전송용 문자열이며 signed payload의 정수 계약을 바꾸지 않는다. `engineVersion`도 사용한 실행부 버전에 고정하고 정책 갱신·동시 요청 때문에 최신 전역 값으로 덮어쓰지 않는다.
- malformed 등으로 메타데이터를 만들 수 없는 판정은 가짜 digest/버전을 채우지 않는다. C1에서 메타데이터 부재를 `status: unavailable`과 사유 및 진단으로 표현했으며, 필수값이 없는 사건은 호스트가 로컬에 기록하며 현재 API에는 전송하지 않는다.
- 호스트/후속 어댑터가 `event_id`, 필요한 `submitted_at`(Unix 초), `X-Api-Key`, 전송·재시도를 맡는다. API 필드만 골라 보내고 네트워크/인증을 Core 포트에 추가하지 않는다. 전송 실패가 판정이나 서명 흐름을 바꾸지 않게 한다.

## 4. 단계별 실행 계획

### C1 — 공개 계약과 타입

1. **C1-1 정책 API·fixture 정합화:** §3.1에 따라 기존 wire 타입·Schema·정상/오류 fixture·구조 helper·참조 서명 시험을 수정한다. 실제 API의 필드·sequence·optional key ID와 B 원문을 보존하며, 시험 키로 새 B를 서명한다. README의 과거 “정책 배포 API 근거 없음” 설명도 현재 구현에 맞춘다. 추가 선택이 필요한 SDK 초기화·계획 소비·감사 메타데이터 계약만 권장안과 영향으로 확인한다.
2. **C1-2 타입 반영:** 정합화한 계약을 아래 공개 타입·주석·export에 반영한다. 기존 동기 API·3포트 호출 예시와의 호환성 차이, 감사 메타데이터 제공/부재 형태를 README에 짧게 설명한다. 아직 없는 런타임 구현을 지원 완료로 표시하지 않는다.
3. **C1-3 소비자 검증:** 공개 import, 요청 union narrowing, 필수 provenance, opaque handle의 임의 생성 거절, 예전 evaluate 시그니처 거절, 반환값/hook의 감사 메타데이터 접근을 타입 사례로 확인한다. 재사용·시간·서명 같은 runtime 검증은 C3~C6가 담당한다.

| 파일 | C1 변경 |
| --- | --- |
| `contracts/core-v1/{types.ts,policy-wire.schema.json,helpers/structure.mjs,fixtures.mjs,contract.test.mjs,examples/,README.md}` | §3.1의 실제 API wire와 fixture 정합화. 정책 콘텐츠는 유지하고 변경된 payload의 시험 서명·기대 오류 계층 갱신 |
| `packages/core/src/core.ts` | config, async 생성, 기본 3함수와 갱신/종료 계약 |
| `packages/core/src/ports/{policy,fact,clock,index}.ts` | B 문자열·서명 wrapper, FactBatch와 취소, clock 위치 |
| `packages/core/src/ports/decoder.ts` 및 공개 export | 내장 snapshot 설정으로 대체하는 안의 호환성 반영 |
| `packages/core/src/types/{plan,request,verdict}.ts` | CorePlan·FactBatch·트리 내 call ID 결속, PolicySet 임의 주입 제거, 오류/진단·판정에 고정된 감사 metadata |
| `packages/core/src/index.ts`, `packages/core/README.md` | 공개 표면과 실제 호출 예시·미구현 상태 일치 |
| 신규 `packages/core/tests/types/` 및 전용 tsconfig/명령 | 빌드된 공개 `.d.ts`를 소비하는 허용/거절 사례. 현재 src 전용 typecheck 밖이므로 실행 경로도 함께 연결 |

완료 조건: API wire와 수정 fixture의 구조·참조 서명이 일치하고, 사용자가 변경된 `contract:test`와 공개 타입 검사·빌드·소비자 검사를 실행해 확인한다. 이전 D4-1 통과 수를 새 결과로 옮기지 않는다. 새 타입과 아직 없는 실행 구현의 상태를 구분한다.

### C2-0 — 소스 소유권과 Cargo 경계

| 단계 | 변경 범위 | 확인할 결과 |
| --- | --- | --- |
| C2-0a | state → action → transition 순으로 `crates/asset-model/` 이관. Cargo path·import·re-export 갱신 | crate 이름과 serde 형식 유지, 이동한 모델의 기존 시험·의존 crate 컴파일 통과 |
| C2-0b | SDK root와 API/server Cargo workspace 분리. manifest·lockfile·CI와 서버 Dockerfile/Cloud Build 입력 경로 정리 | SDK가 서버 member manifest를 읽지 않고 서버 빌드·바이너리 COPY도 새 경로로 유지. dependency 자동 갱신·시험 때만 member 제거 금지 |
| C2-0c | `schema/policy-schema/` → `crates/policy-engine/schema/policy-schema/`, `src/schema/mod.rs` include 경로 갱신 | schema 원본 한 곳, Cargo package에 포함, 기존 경로 fallback 없음 |

C2-0a는 기존 모델 시험과 분리 전 전체 workspace 컴파일을 사용자 실행으로 확인했다. workspace 분리 후 루트 Cargo 명령은 SDK만 대상으로 한다.

각 이동은 실제 의존 순서대로 수행한다. 경로 이동과 정책·DTO·수치 처리 변경을 같은 작업에 섞지 않는다. 새 workspace를 위해 lockfile 생성이 필요하면 사용자가 실행할 명령과 이유를 제공한다.

C2-0b는 서버 manifest를 `crates/policy-server/Cargo.toml`, 서버 출력 위치를 `crates/policy-server/target/`로 분리한다. [서버 Dockerfile](../../crates/policy-server/server/Dockerfile)은 저장소 root build context를 유지하되 새 manifest와 출력 경로를 사용한다. 공유 모델·기존 release profile·의존성 버전은 유지한다.

C2-0b는 두 workspace의 lockfile 정리·컴파일을 사용자 실행으로 확인했다. 외부 dependency의 version/source/checksum은 기존과 같고 필요한 항목만 남았다.

C2-0c는 원본 schema를 crate 안으로 이동하고 Rust include·목록 시험·기존 확장 생성 경로를 새 위치로 맞춘다. Cargo의 기본 패키지 포함 규칙을 사용하며 별도 원본 복사본이나 fallback은 두지 않는다. 사용자 검증:

```sh
cargo test --locked -p policy-engine --lib schema::
cargo package --locked --offline --allow-dirty -p policy-engine --list | rg -c '^schema/policy-schema/.*\.cedarschema$'
```

두 번째 명령은 패키지 파일 목록 확인이며 현재 schema 파일 수는 111개다. 실제 패키지 빌드·배포는 수행하지 않는다.

### C2a — Decoder 인스턴스화

- `DeclarativeV3State`와 `thread_local! DECLARATIVE_V3_STATE`를 `dambi-core` 인스턴스 소유 상태로 추출한다. 설치·인덱스·재귀 문맥의 수명을 분명히 한다.
- `declarative_install_v3_json`, transaction v3, typed v3/v4와 `typed_data_validation.rs`의 필요한 순수 처리를 옮긴다. 기존 WASM export는 비교 기간에 같은 실행부를 부르는 wrapper로 남긴다.
- 기존 DEC fixture의 원문 → Action·decoder ID·진단 결과를 유지한다. 별도 인스턴스의 설치·재설치·실패·해제 간 상태가 섞이지 않는 사례를 추가한다.

완료 조건: DEC 원문 회귀와 상태 격리 검증 통과. USDC strict 실패 후 v3 fallback을 넣지 않고, Permit2 v3 한계를 임의 교정하지 않는다. multicall 순서·Unknown/partial·한도와 malformed 전체 오류를 보존한다. 제품에서 어떤 경로를 켤지는 D4-2의 별도 결정이다.

새 workspace member와 wrapper 의존 관계를 lockfile에 연결하기 위해 최초 검증 전에 `cargo update --workspace --offline`을 한 번 실행한다. 이후 §5의 Core Native·wrapper 회귀·WASM 재빌드·DEC 통합 회귀 순서로 확인한다.

### C2b — 계획·평가 실행부 추출

- `action_eval_exports.rs`의 `plan_action_rpc_v2_json`·`evaluate_action_v2_json`에서 순수 실행과 JSON/WASM 입출력을 나눈다.
- `policy-engine/src/{lowering_v2,policy_rpc,policy,schema}/`를 재사용한다. 특히 `planning_v2.rs`, `materialize_v2.rs`, `manifest_v2.rs`의 동작을 중복 구현하지 않는다.
- 기존 evaluator가 bundle 자체 manifest로 필수 Fact를 다시 확인하는 경계를 유지한다. 호스트가 전달한 call 목록만 신뢰하여 필수 결과 누락을 우회하게 만들지 않는다.

완료 조건: 같은 Action·manifest·Fact에 같은 정책 ID·severity·판정. 누락·잘못된 projection·invalid matching manifest와 정상 정책 공존의 기존 오류 동작 유지. plan handle 도입에 따른 재사용 방식 변경은 C5에서 검증한다.

기존 `policy-engine`을 재사용하며 외부 의존성 버전 변경 없이 lockfile에 Core의 의존 관계를 반영했다. C2b 검증은 완료됐으며 평가 시험은 C2c에서 `crates/dambi-core/src/runtime/tests.rs`로 이동했다.

### C2c — SDK 회귀 자료 이관

`fixtures/decoder-policy`의 필수 case ID와 D3 정책 사례를 SDK runner에 연결한다. `hl_exchange_deny_e2e.rs`, `est_roundtrip.rs`, baseline 등이 읽거나 쓰는 확장/서버 seed를 찾아 SDK fixture 또는 crate 내부 시험 자료로 옮긴다. 소비 경로 전환 후에만 이전 참조를 제거한다.

완료 조건: 해당 SDK 시험의 읽기·쓰기가 확장/서버 경로에 의존하지 않으며, 필수 fixture 부재를 skip이나 빈 입력으로 처리하지 않는다. 제품 지원 확대 없이 기존 검증 사례를 인계한다.

구현 경로와 실행 명령은 [SDK fixture 안내](../../fixtures/sdk/README.md#c2c-native-core-회귀)를 따른다. HL·정책 평가·Rust 숫자 원문 회귀는 Core가 소유한다. EST editor bridge는 기존 WASM crate에 남기고 자동 시험의 dashboard 쓰기만 임시 출력으로 바꾼다. C5의 SDK WASM·공개 API 연결과 구분한다.

### C3 — 엄격한 번들 검증

| 단계 | 구현 내용 | 의미 있는 검증 |
| --- | --- | --- |
| C3-1 parser | C1에서 맞춘 실제 wire, 입력 크기·중복 JSON 키·BOM·Unicode·수치·manifest 외형 검사 | 최상위 schema_version 없는 정상 payload 수용. sequence의 문자열·0·소수·상한 초과와 손실되는 수치 거절 |
| C3-2 서명 | 정책 B UTF-8 원문을 로컬 policy 키로 검증. optional key ID는 telemetry, 외부 decoder는 별도 역할 키/JCS 계약 | C1에서 정합화한 정상/변조 서명·decoder 키 오용을 실제 Rust에서 검증. key ID 누락/변경이 신뢰 키 집합을 바꾸지 않음을 확인 |
| C3-3 의미 | 전체 ManifestV2/Cedar, ID 관계, env/profile, 시간·만료, sequence/rollback, registry_ref 지원 여부 | 의미 오류·non-null registry_ref를 구분해 거절. null expires_at에도 72시간 시작값과 설정된 시간 경계 적용 |

D4-1의 fixture helper는 C3 parser가 아니다. `JSON.parse`와 TypeScript 타입만으로 신뢰 검증을 대체하지 않는다. 최대 나이는 §3.1의 72시간 시작값을 따르고, 운영 키·clock skew·크기 제한 등 나머지 미확정 항목은 명시적인 시험 설정과 구분한다. 구조 외형의 저비용 검사 후 B 원문 서명을 검증하고, 전체 Manifest/Cedar 의미 검증과 활성화로 연결한다. sequence의 검증과 활성 상태 갱신은 C4에서 원자적으로 연결한다.

C3-1 구현은 `crates/dambi-core/src/bundle/`에 둔다. `parse_policy_bundle`은 PolicySource의 B·서명·선택 key ID를 받고, `parse_policy_envelope`는 평면 wire도 검사한다. 반환하는 `ParsedPolicyBundle`은 **미검증 입력**이며 활성화에 사용할 수 없다. B의 UTF-8 바이트 제한과 128단계 container 제한을 적용하고 숫자 원문을 검사한 뒤 값으로 변환한다. 기존 구조 계약처럼 `42.0`·`4.2e1`은 42로 수용하되 반올림·underflow로 값이 달라지면 거절한다. 서명은 64바이트 canonical Base64 인코딩까지만 확인한다. 서명·키 역할·전체 정책 의미·snapshot 연결은 C3-2 이후다.

C3-2의 `TrustedKeys`는 로컬 Base64 DER SPKI를 P-256 공개키로 검증하고 정책 역할 키를 최소 하나 요구한다. 로컬 key ID는 비어 있지 않고 고유해야 하며, 같은 공개키를 정책·Decoder 두 역할에 배정하지 않는다. 정책 검증은 B 원문, 외부 Decoder 검증은 strict parse를 통과한 전체 객체의 JCS 바이트에 고정 P-256/SHA-256을 적용한다. 응답 key ID는 키 선택에 사용하지 않고 실제 검증한 로컬 key ID를 결과에 담는다. 기존 KMS/WebCrypto와 같이 high-S·low-S 유효 서명을 모두 수용한다. `SignatureVerifiedPolicyBundle`·`SignatureVerifiedDecoderBundle`은 **서명 확인만** 나타낸다. 정책 의미 검사는 C3-3, Decoder 설치·index digest/고정 snapshot digest 결속·활성화는 C4 이후다. 외부 Decoder 조회나 공개 JS 로딩 API는 추가하지 않는다.

C3-3의 `validate_policy_bundle`은 서명 확인 객체만 받아 전체 ManifestV2와 정책별 Cedar schema를 검증한다. 각 entry는 정확히 하나의 static 정책이며 entry·manifest·Cedar `@id`가 일치해야 한다. 중첩 미지원 필드·projection 타입 불일치·미선언 custom 참조를 거절하며 한 정책의 오류도 전체 실패다. Unix 초를 밀리초로 비교해 `expires_at <= issued_at`은 잘못된 번들, `now >= 유효 기한`은 만료로 처리하고 미래 발행에만 `allowedClockSkewMs`를 허용한다. 결과의 `check_update`는 기존 sequence와 B 원문을 비교하는 순수 검사이며, 최신 상태와의 비교·활성화 원자성은 C4가 담당한다.

### C4 — 검증된 snapshot과 Store

- 정책과 decoder를 검증한 뒤 한 번에 활성화한다. 일부 설치 성공 뒤 오류가 나도 절반짜리 상태를 노출하지 않는다.
- 갱신 실패 시 기존 검증 상태를 보존하고, 이전 계획은 고정한 snapshot을 참조한다. key scope·sequence·만료 확인과 갱신 간 경쟁 조건을 다룬다.
- sequence는 §3.1의 정수 범위에서 수치로 비교한다. 같은 env/profile의 낮은 sequence는 거절하고, 같은 sequence·같은 B 재조회는 변경 없이 종료하며 같은 sequence·다른 B는 거절하는 안을 따른다. 재조회에도 서명·유효 기간을 확인하고 기존 issued_at/만료 시각을 연장하지 않는다.
- 내장 artifact의 고정 신뢰와 외부 decoder 서명 경로를 구분한다. 인스턴스 분리·동시 갱신·오래된 갱신·해제 사례를 확인한다.

갱신은 가장 나중에 시작한 작업만 유효하며, 활성화 직전에 최신 sequence와 만료를 다시 확인한다. C4의 Native Store를 계획 handle 및 외부 I/O와 연결하는 작업은 C5/C6에서 담당한다.

고정 fixture로 Store 구현·검증은 진행할 수 있다. **제품용 완료 조건**에는 D4-2의 확정 요청 범위와 D4-3 생성물 연결이 추가된다. artifact에 index가 존재하는 것만으로 미검증 요청 경로를 활성화하지 않는다.

### C5 — Rust/WASM/JS plan·evaluate 연결

1. `dambi-core-wasm`의 얇은 wrapper와 `scripts/sdk/build-wasm.mjs`를 만들고, Core 전용 WASM/glue 입력을 연결한다. 기존 `policy-engine-wasm/pkg`와 확장 복사 스크립트 의존을 제거한다.
2. 계획에 요청 digest·해석 결과·snapshot·필수 Fact 목록을 고정한다. §3.5의 감사 metadata도 실제 사용한 요청·snapshot sequence·엔진 버전에서 생성한다. 타 인스턴스, 요청 변조, 만료, 허용되지 않은 재사용·종료 후 handle을 거절한다. 구체 수명·소비 규칙은 C1 계약을 따른다.
3. Fact의 call ID·출처 메타데이터·신선도·계획 일치를 확인하고 메서드 의미 응답을 한 번만 projection한다. 같은 manifest를 쓰는 서로 다른 child의 call/result가 충돌하지 않게 매핑한다. 사용자에게 받은 임의 정책/요청으로 다시 평가하지 않는다.
4. CI의 `createCore()` NOT_IMPLEMENTED reject 기대 검사를 실제 plan/evaluate 실행으로 교체한다. 기존 scaffold typecheck·pack dry-run만으로 실행 연결 완료를 주장하지 않는다.
5. multicall은 노드별 실행 오류를 집계해 다른 sibling의 판정·이유가 사라지지 않게 한다. child deny + Unknown, child deny + 다른 child의 계획/Fact/평가 오류를 순서를 바꿔 확인한다. malformed 전체 요청의 Decoder 오류 경계는 유지한다.

완료 조건: 실제 WASM을 사용한 JS 호출이 Rust와 일치하고 오류·수명 경계가 유지된다. SDK 전용 빌드·시험·자산 경로로 전환한다. 전체 제품 snapshot과 최종 소스 독립성 완료 여부는 별도 확인한다.

### C6 — check·Fact 조율·cache·hook

- `check`를 C5 plan/evaluate 위에 구성한다. PolicySource/FactProvider는 고정 데이터 mock이며 평가·서명·해석은 실제 실행한다.
- `portfolio.balance` 의미 응답·정밀도·provenance·projection을 검증한다. 기존 catalog `optional: true`·`required: false`는 유지하고, 필수 누락 시험은 별도 SDK 시험 manifest로 구성한다.
- timeout·취소·부분 응답·늦은 응답·동시 요청에서 상태가 섞이지 않게 한다. cache 재사용 시 `observedAt`을 현재 시각으로 바꾸지 않으며 chain·method·정규화 params·필요 block scope를 키에 반영한다.
- hook 예외가 최종 판정이나 필수 검증을 우회하지 않게 한다. `enforcement`는 호스트의 선언이며 실제 트랜잭션 차단을 Core가 수행했다는 뜻으로 표시하지 않는다.
- `check/evaluate` 반환과 `onVerdict`의 metadata가 일치하는지, 진행 중 정책 갱신·동시 요청에서도 판정 당시 값이 보존되는지 확인한다. 감사 전송은 호스트/후속 어댑터가 담당하고 전송 실패가 Core 판정을 바꾸지 않는다.

완료 조건: 승인된 요청 경로에서 원문 → 실제 Core → mock 외부 Fact → 판정이 연결된다. 알려진 malformed, 미지원 요청, 부분 해석, 빈 정책, 매칭 없음, 필수 Fact 누락을 각각 확인한다. **C6 인계 시점에도 그때의 fixture 범위로 확장·서버·기존 WASM 폴더 없는 SDK 소스 복사본에서 Native/WASM 빌드·시험을 통과해야 한다.** 제품 snapshot 확정과 최종 tarball 소비자 검증은 제품 완료 조건으로 남긴다. 실제 HTTP/RPC 연결은 A 단계이며 이 단계의 mock 성공과 구분한다.

## 5. 시험과 최종 완료 기준

관련 코드가 바뀐 최소 회귀부터 사용자가 실행한다. Core Native 실행부·fixture 변경은 아래 Native 경로로 확인하고, WASM 실행부나 경계를 변경했을 때 해당 WASM 빌드·Node 회귀를 추가한다. JSON/문서/VS Code 설정만 바뀌면 빌드·전체 회귀를 반복하지 않는다. 시험 수를 늘리기 위해 같은 기대값을 반복하지 않는다.

주요 사용자 실행 명령은 다음과 같다. VS Code에는 자주 쓰는 검사를 수동 Task로 연결한다.

| 명령 | 현재 의미·실행 시점 |
| --- | --- |
| `npm run core:typecheck` | 현재 공개 TS 타입 검사. C1 타입 변경 시 |
| `npm run core:build` | TS/선언 파일과 SDK 전용 WASM/glue 생성. wasm-pack·wasm32 target 필요 |
| `npm run core:test:types` | build 후 공개 `.d.ts` 소비자와 wire 타입 검사 |
| `npm run core:test:runtime` | Core·session runner 빌드 후 실제 WASM/Native 판정 일치·계획/Fact/갱신 수명 검사 |
| `npm run core:pack` | 기존 dist의 pack dry-run. 실제 설치 검증이 아니며 build 이후 사용 |
| `npm run contract:test` | C1-1 구조·Node 참조 서명 사례. 사용자 검증 완료, 관련 변경 시 실행. Core 암호 구현 검증과 구분 |
| `npm run policy:test` | D3 실제 기존 WASM 정책 검사 |
| `npm run core:test:fixtures` | 명시적으로 빌드한 Native runner로 DEC 인계 목록 전체·D3·baseline 실행. WASM 불필요 |
| `cargo test --locked -p policy-engine --lib` | 기존 정책 엔진 Native library 시험. integration test는 별도 |
| `cargo test --locked -p dambi-core` | Decoder helper·인스턴스·숫자 원문·계획/평가·HL의 Native 시험 |
| `cargo test --locked -p dambi-core --lib runtime::tests` | 옮긴 계획·Fact projection·정책 판정 회귀만 실행 |
| `cargo test --locked -p dambi-core --test policy_bundle_parser` | C3-1 원문 보존·엄격한 JSON·wire 외형·서명 인코딩 검사. 암호 검증은 후속 |
| `cargo test --locked -p dambi-core --test policy_bundle_signature` | C3-2 실제 P-256 서명·키 역할·원문/JCS 결속 검사. 의미 검증·활성화는 후속 |
| `cargo test --locked -p dambi-core --test policy_bundle_semantics` | C3-3 전체 Manifest/Cedar·ID·scope·시간·sequence 의미 검증 |
| `cargo test --locked -p dambi-core --test decoder_snapshot --test snapshot_store` | C4 Decoder 무결성·설치 경계와 Store 초기화·갱신·snapshot 수명 검증 |
| `cargo test --locked -p dambi-core --test session` | C5 계획·Fact 결속, multicall 오류 집계와 수명 검사 |
| `cargo build --locked -p dambi-core --example session_runner` | 공개 JS/WASM 시험의 Native 비교 실행 파일 생성 |
| `cargo build --locked -p dambi-core --example fixture_runner` | Node DEC/D3 시험이 부르는 Native 실행 파일 생성 |
| `cargo test --locked -p policy-engine-wasm --test declarative_v3_route --test declarative_v3_typed_data_install --test declarative_v3_typed_data_strict --test multicall_limits` | 기존 wrapper의 원문·strict 숫자 원문·multicall 회귀. Node에서 표현할 수 없는 숫자 사례도 유지 |
| `wasm-pack build crates/policy-engine-wasm --target web --release --out-dir pkg --out-name policy_engine_wasm` | 기존 wrapper의 JS/WASM 쌍 재생성. C5 SDK 빌드는 core:build 사용 |
| `npm run decoder:test:approve-policy` | raw approve → 기존 WASM 정책 연결 |
| `npm run decoder:test:handoff` | 인계 자료의 Registry 재현 생성·정합성. 내부 builder 실행 포함 |
| `npm run decoder:test` | 전체 DEC 원문·Action·decoder ID·진단 및 approve 정책 연결 회귀. C2a에서는 위 Native 검사와 새 JS/WASM 빌드 후 실행 |

**C2c 검증:** Core Native 시험 → fixture runner 빌드 → `core:test:fixtures` 순서다. 참조를 바꾼 legacy diagnosis와 임시 출력으로 바꾼 EST 시험도 한 번 확인한다. 정확한 명령은 SDK fixture 안내에 모으며 전체 workspace 검사·WASM 재빌드는 요구하지 않는다.

**C3-1 최소 검증:** 위 `policy_bundle_parser` 시험만 실행한다. 기존 Decoder·정책 평가·공개 TS 표면은 바꾸지 않았으므로 C2c 전체 회귀나 WASM 재빌드는 반복하지 않는다.

**C3-2 최소 검증:** 신규 P-256/JCS 의존 관계를 위해 `cargo update --workspace --offline`을 한 번 실행한 뒤 `cargo test --locked -p dambi-core --test policy_bundle_parser --test policy_bundle_signature`로 검사한다. JCS 의존성이 공유 JSON의 `float_roundtrip` 기능을 켜므로 parser도 함께 확인한다. 기존 Decoder 통합 회귀나 WASM 재빌드는 요구하지 않는다.

**C3-3 최소 검증:** 기존 Cedar 의존성의 Core 직접 참조를 lockfile에 반영하려고 `cargo update --workspace --offline`을 실행한 뒤 `cargo test --locked -p dambi-core --test policy_bundle_semantics`로 검사한다. 기존 parser·서명 구현과 엔진을 수정하지 않으므로 이미 통과한 시험을 반복하지 않는다.

**C4 최소 검증:** 기존 SHA-256 의존성의 Core 직접 참조를 `cargo update --workspace --offline`로 반영한 뒤 `cargo test --locked -p dambi-core --test decoder_snapshot --test snapshot_store`를 실행한다. C3의 검증 로직과 기존 Decoder 실행부는 재사용한다.

**C5 최소 검증:** 신규 WASM crate를 `cargo update --workspace --offline`로 반영한 뒤 session 시험 → session runner 빌드 → `core:build` → `core:test:types` → `core:test:runtime` 순서로 실행한다. 실제 명령은 [패키지 개발 안내](../../packages/core/README.md#development-checks)에 모은다. C1 scaffold 시험은 실제 runtime 시험으로 교체했다. `sdk:verify:isolated`는 아직 미구현이며 C6 인계 때 연결한다.

Core 기능 구현 완료와 제품 출시 완료를 구분한다. 최종 SDK는 상위 계획 [§7.1](decoder-core-adapters-plan.md#71-필수-완료-조건-sdk-소스만으로-빌드시험패키징)의 SDK 소스 복사본에서 빌드·시험·패키징해야 한다. 확장/서버/기존 WASM 폴더 없이 재현하고, 실제 tarball의 ESM/CJS·타입·WASM·브라우저 소비를 확인한다. 최종 제품 범위에는 D4-2·D4-3 결과가 필요하다. 크기 목표와 실제 API/발행 검증도 상위 계획을 따른다.

## 6. VS Code에서 시작하기

**workspace 파일은 필수가 아니다.** 저장소 폴더만 열어도 개발할 수 있다. 이 프로젝트에서는 수동 검사 명령·오류 위치 탐색·fixture 디버깅 설정을 함께 사용하도록 [dambi-core.code-workspace](../../dambi-core.code-workspace)를 유지한다. Rust/Cargo workspace와는 별개이며, 이 파일을 연다고 브랜치나 소스 구조가 바뀌지 않는다.

아래 명령으로 저장소의 Core workspace를 연다.

```sh
code /Users/spu/SDKdambi/DAMBI/dambi-core.code-workspace
```

CLI를 쓰지 않으면 VS Code의 `File → Open Workspace from File…`에서 같은 파일을 선택한다. 하나의 저장소 root를 사용하므로 필요한 과거 실행부를 찾아볼 수 있고 중첩 workspace로 같은 파일이 중복 표시되지 않는다.

- 저장소 TypeScript 경로는 `node_modules/typescript/lib`다. TS 파일을 연 뒤 `TypeScript: Select TypeScript Version` → `Use Workspace Version`을 선택한다. Yarn은 저장소에 포함된 4.14.1 실행 파일을 Task에서 직접 호출한다. Node 20 이상·TS 5.7.3·Rust 1.95.0·WASM 도구 핀은 현재 설정을 유지한다.
- Rust Analyzer는 SDK·서버 두 Cargo manifest를 읽도록 연결했고, Cedar 확장과 함께 추천 목록에 넣는다. Rust Analyzer는 현재 로컬에 없어 사용자가 설치한다. TypeScript/JSON 지원은 VS Code 기본 기능을 사용한다.
- `checkOnSave`, `cargo.buildScripts.enable`, `procMacro.enable`을 꺼서 자동 Cargo 검사·build.rs 실행을 막는다. 이에 따라 일부 매크로 기반 분석은 제한된다. [Rust Analyzer 설정 근거](https://rust-analyzer.github.io/book/configuration.html)
- `Tasks: Run Task`에 §5의 수동 작업을 연결했다. `Cmd+Shift+B`는 Core 타입 검사이며 TypeScript 오류는 `Problems`에서 해당 소스로 이동한다. Core Native 회귀·fixture runner 빌드·DEC/D3 회귀도 선택할 수 있다. 폴더를 열 때 실행되는 Task·설치·빌드·시험은 없다.
- **F5 디버깅:** `contracts/core-v1/contract.test.mjs`를 열고 시험 본문에 중단점을 설정한 뒤 `Core 계약: C1-1 참조 시험 디버깅`을 선택한다. Node 시험 runner의 자식 프로세스에도 연결한다. 이는 현재 존재하는 계약 fixture용이며 Rust/WASM 내부나 미구현 Core 실행부의 디버깅은 아니다. 자동 선행 빌드는 없다.
- 생성물과 dependency 폴더만 검색·감시에서 제외한다. 기존 확장/서버 소스는 추출 작업에 필요하므로 숨기지 않는다. 새 Core crate·WASM runner가 생기는 C2/C5에서 해당 Task/launch를 실제 경로로 추가한다.

의존성이 없다면 사용자가 아래 명령을 필요한 범위에서 실행한다. 이 계획서 작성에서는 설치하지 않았다. Registry 설치는 관련 기존 Decoder 시험을 실행할 때만 필요하다.

```sh
cd /Users/spu/SDKdambi/DAMBI
# Rust Analyzer 확장이 없을 때만:
code --install-extension rust-lang.rust-analyzer
# 저장소 JS 의존성이 없을 때만:
node .yarn/releases/yarn-4.14.1.cjs install --immutable
# 기존 Decoder/Registry 검사가 필요하고 의존성이 없을 때만:
npm ci --prefix registryV2
```

## 7. 단계 상태

C1 결과는 [계약 README](../../contracts/core-v1/README.md#결과-기록) 한 곳에 기록한다. 기존 DEC/D3/D4 로그는 원래 README에 유지한다.

| 단계 | 상태 |
| --- | --- |
| 개발 계획·VS Code workspace | 구체화·정적 검토 완료 |
| C1-1 정책 API·fixture 정합화 | 사용자 검증 완료. [결과 기록](../../contracts/core-v1/README.md#결과-기록) |
| C1-2/3 타입·소비자 검증 | 완료 |
| C2-0a 공통 모델 이관 | 사용자 검증 완료 |
| C2-0b workspace 분리 | 사용자 검증 완료 |
| C2-0c schema 경계 | 사용자 검증 완료 |
| C2a Decoder 인스턴스화 | 사용자 검증 완료 |
| C2b 정책 평가 실행부 추출 | 사용자 검증 완료 |
| C2c SDK 회귀 자료 이관 | 사용자 검증 완료 |
| C3-1 parser | 사용자 검증 완료 |
| C3-2 서명 | 사용자 검증 완료 |
| C3-3 의미 | 사용자 검증 완료 |
| C4 snapshot·Store | 구현 및 Store 사용자 검증 완료·Decoder 시험 결과 확인 대기 |
| C5 plan/evaluate·SDK WASM | 구현 및 타입·JS/WASM 사용자 검증 완료·Native session 시험 결과 확인 대기 |
| C6 check·Fact·cache·hook | 미착수 |
| API 정책 publisher 경로 수정 | API 담당 후속 작업. 실제 정책 재발행·A1 연동 전 필요 |
| D4-2·D4-3 제품 범위·재현 생성 | 후속 의존 항목. C1 착수 조건 아님 |
