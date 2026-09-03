# Phase 1 사전 검증 및 승인안

2026-09-02 확정 프롬프트 §3과 §8.1–3에 따른 검증·제안이다.
Phase 1 1단계의 설정 변경은 아직 시작하지 않았다. 기존 Phase 0 그래프,
소속 표, fixture, normalizer를 읽었으며 재생성하거나 교체하지 않았다.

## 확정된 전제

- `registryV2`, `schema`, `scripts`는 현재 루트 위치를 유지한다.
- `request-module`, `crates/web-server`, 빈 `sdk/hole-specs.ts`는 이후 해당
  이동 단계에서 삭제한다. 이번 검증에서는 삭제하지 않았다.
- `sdk/block-ir` 6파일과 `policy-store-types.ts`는 private `@dambi/policy-ir`,
  `extension-client.ts`와 관련 테스트는 dashboard 쪽으로 이관할 대상이다.
- WASM은 ESM/CJS + 외부 파일만 제공한다. UMD는 제외한다.
- SDK 런타임 gzip < 1.5 MB, 런타임 WASM raw < 6 MiB, 확장 배포본은 별도
  예산으로 관리한다. 이전 Phase 0 보고서의 미결정 제안보다 확정 프롬프트가 우선한다.

## §3 검증 결과

### 문서 추적과 fixture

아래 6개 모두 `TRACKABLE`이다. `docs/phase0-scratch.md`는 기존 `/docs/*`
규칙으로 계속 무시된다.

```text
docs/security-invariants.md
docs/sdk-migration/phase0-report.md
docs/sdk-migration/FINDINGS.md
docs/sdk-migration/graph.json
docs/sdk-migration/deps.svg
fixtures/baseline-verdicts.json
```

기존 Vitest 4.1.9 실행 파일로 독립 Node 설정을 사용했다.

```sh
./browser-extension/node_modules/.bin/vitest run --config fixtures/vitest.config.ts
```

재빌드 전후 모두 4/4 통과했다. 실제 WASM의 normalized JSON을 기존 expected
JSON과 문자열로 비교했으며 fixture나 snapshot을 갱신하지 않았다.

빌드 후 Phase 0 산출물, 4개 lockfile, `.gitignore`, 기존 사용자 변경 파일의
SHA-256 17개가 검증 시작 시점과 같았다. 아래의 새 발견 사항만 이후
`FINDINGS.md`에 덧붙인다.

### 설치·빌드·크기

`browser-extension`에서 `yarn install --immutable`이 통과했다. 기존 lockfile
그대로 설치하기 위해 일반 `yarn install`보다 엄격한 옵션을 사용했다.

이전 기준선과 동일한 로컬 smoke 환경으로 WASM까지 재빌드했다.

```sh
DAMBI_ALLOW_INSECURE_REGISTRY=1 yarn build:chrome
```

제한된 환경에서는 wasm-pack 보조 도구 실행이 `Operation not permitted`로
중단됐고, 권한 확장 재실행은 성공했다. webpack, dashboard build,
`validate-dist`가 모두 통과했다. 생산 배포용 환경값을 새로 채우지 않았다.

| 항목 | 기존 기준선 | 이번 재빌드 | 비교 |
| --- | ---: | ---: | --- |
| `du -sk dist/chrome` | 20,540 KiB | 21,704 KiB (`du -sh`: 21M) | +1,164 KiB, 약 +5.7% |
| background.js gzip | 64,757 B | 64,757 B | 동일 |
| WASM raw | 8,057,968 B | 8,057,968 B | 동일 |
| WASM gzip | 2,495,488 B | 2,495,488 B | 동일 |
| WASM base64, 개행 제외 | 10,743,960 B | 10,743,960 B | 동일 |

`du`는 디스크 할당량을 센다. 이번 배포본은 139파일, 논리적 파일 크기 합계
20,560,378 B이다. 이전의 논리적 합계는 기록되지 않아 디스크 할당량 차이의
원인은 확정하지 않았다. 별도 크기 게이트를 만들 때 측정 기준을 명시해야 한다.
macOS의 base64는 `base64 < file | tr -d '\n' | wc -c`로 측정했다.

기존 extension 1,208건·Rust 전체 통과 기록은 유지된다. 이번 사전 검증에서
그 전체 스위트를 재실행한 것은 아니며, 설정 변경을 하는 1단계의 종료 게이트에서
다시 실행한다.

## Phase 1 6단계 이동 후보 — 기존 표에서 추출

Madge 파일은 여전히 51노드·101에지다. 기존 표의 `core` 행 21개를 그대로
추출했다. 확정된 private policy-ir 배치를 적용하면 core 후보는 14파일 /
3,673 LOC, policy-ir 후보는 7파일 / 1,201 LOC이다. 이는 공개 API나 최종
SDK 용량의 목표값이 아니다.

| 기존 경로 | LOC | 이관 패키지 |
| --- | ---: | --- |
| `browser-extension/backend/lib/types.ts` | 308 | `packages/core` |
| `browser-extension/backend/service-worker/adapter-loader/bundle-schema.ts` | 1,008 | `packages/core` |
| `browser-extension/backend/service-worker/adapter-loader/bundle-verify.ts` | 215 | `packages/core` |
| `browser-extension/backend/service-worker/adapter-loader/declarative-decode.ts` | 21 | `packages/core` |
| `browser-extension/backend/service-worker/diagnostics.ts` | 204 | `packages/core` |
| `browser-extension/backend/service-worker/hl-order-to-action.ts` | 312 | `packages/core` |
| `browser-extension/backend/service-worker/legacy-v1-rpc.ts` | 16 | `packages/core` |
| `browser-extension/backend/service-worker/local-method-handlers.ts` | 183 | `packages/core` |
| `browser-extension/backend/service-worker/policy-store/render.ts` | 88 | `packages/core` |
| `browser-extension/backend/service-worker/policy-store/types.ts` | 2 | `packages/core` |
| `browser-extension/backend/service-worker/venue/hl-signature-recovery.ts` | 322 | `packages/core` |
| `browser-extension/backend/service-worker/venue/leverage-cap-guard.ts` | 89 | `packages/core` |
| `browser-extension/backend/service-worker/wasm-bridge.ts` | 560 | `packages/core` |
| `browser-extension/backend/service-worker/wasm-bridge.types.ts` | 345 | `packages/core` |
| `browser-extension/sdk/block-ir/blocksToEst.ts` | 103 | `packages/policy-ir` |
| `browser-extension/sdk/block-ir/est.ts` | 26 | `packages/policy-ir` |
| `browser-extension/sdk/block-ir/estToBlocks.ts` | 202 | `packages/policy-ir` |
| `browser-extension/sdk/block-ir/ir.ts` | 249 | `packages/policy-ir` |
| `browser-extension/sdk/block-ir/params.ts` | 363 | `packages/policy-ir` |
| `browser-extension/sdk/block-ir/schema.ts` | 74 | `packages/policy-ir` |
| `browser-extension/sdk/policy-store-types.ts` | 184 | `packages/policy-ir` |

`declarative-route.ts`, `sig-routing.ts`, `policy-store/resolve.ts`는 현재 host
행이므로 이 이동 목록에 미리 넣지 않는다. Phase 2 포트 도입 후 전이 의존을
재확인할 대상이다. 현재 표에 없는 파일도 이 목록에 추정으로 추가하지 않았다.

## 승인안 A — registry-api를 루트 Yarn workspace로 흡수 (권장)

최종 `workspaces: ["packages/*", "apps/*"]`와 일치하며, registryV2만 npm
프로젝트로 남긴다. Phase 1 1단계는 물리 이동보다 먼저이므로 일시적으로 기존
경로를 열어 두어야 한다.

```json
{
  "workspaces": [
    "packages/*",
    "apps/*",
    "browser-extension",
    "browser-extension/dashboard",
    "registry-api"
  ]
}
```

3단계에서 앱을 옮길 때 임시 3개 항목을 제거한다. 이름은 현재
`dambi-extension`, `dambi-dashboard`, `registry-api` 그대로 유지한다.

### 1단계의 구체적 설정 변경

1. 루트 Yarn 4.14.1 및 `node-modules` linker를 단일 기준으로 사용한다.
   extension의 `resolutions`를 루트로 옮겨 기존 선택 규칙을 보존한다.
   루트에 fixture 실행용 Vitest 4.1.9 및 `test:fixtures` 스크립트를 선언한다.
2. extension의 중첩 `workspaces` 선언, 자체 `yarn.lock`, `.yarnrc.yml`, 중복
   Yarn release 파일을 루트 설정으로 통합한다.
3. 기존 extension lockfile의 유효한 고정값과 registry-api npm lockfile의
   해석 결과를 기준으로 루트 lockfile을 만든다. 불필요한 전체 업그레이드는 하지
   않고, 기존값 대비 resolution 변경 목록을 보고한다. 검증 후
   `registry-api/package-lock.json`을 제거한다.
4. 도구 버전 차이를 명시적으로 처리한다. 현재 extension TypeScript는 5.7.3,
   API는 5.9.3인데 둘 다 `^5.7.3`을 선언한다. 하나의 Yarn descriptor로는
   이 두 기존 선택을 동시에 나타낼 수 없으므로 API 쪽을 5.9.3 exact로 고정해
   기존 컴파일러를 유지한다. API Vitest도 기존 npm 해석값 4.1.6을 고정하고
   extension/fixture의 4.1.9와 분리한다. 선택 이유와 transitive 변동은
   lockfile diff에 함께 보고한다.
5. CI 설치를 루트의 `yarn install --immutable`로 맞추고, 앱 실행은
   `yarn workspace <현재 이름> ...`으로 한다. registryV2의 npm 설치·검증은
   그대로 독립적으로 실행한다.
6. registry-api의 Dockerfile은 현재 자체 `package-lock.json`을 두 번
   `npm ci`한다. 이를 루트 Yarn lockfile 및 workspace focus를 사용하는
   다단계 이미지로 바꾸고 production 의존성만 최종 이미지에 포함한다.
   기존 digest 고정, lifecycle script 비활성화, 비root 사용자, healthcheck는
   유지한다. Docker build context도 레포 루트로 바꾼다.
7. CI의 Docker 호출뿐 아니라
   `registryV2/scripts/deploy/deploy-proxy.sh`의 Cloud Build 호출도 같은 문맥과
   명시적 Dockerfile을 쓰도록 맞춘다. 로컬 호출용 Cloud Build 설정과 해당
   문맥의 ignore 규칙을 함께 점검한다. 배포 명령은 실행하지 않는다.

### 예상 변경 파일 범위

- 루트 `package.json`, `yarn.lock`; 필요 시 `.yarnrc.yml`의 설정 집중화.
- `browser-extension/package.json` 및 중복 Yarn 설정·lock·release 파일.
- `registry-api/package.json`, `package-lock.json`, `Dockerfile`, 로컬 빌드용
  Cloud Build 설정 및 README의 설치/이미지 빌드 명령.
- `.dockerignore`와 Cloud Build 문맥의 ignore 설정.
- `.github/workflows/ci.yml`, `extension-release.yml`, `registry-publish.yml`,
  `registry-proxy-deploy.yml`의 설치·빌드 호출.
- `registryV2/scripts/deploy/deploy-proxy.sh`의 빌드 문맥 호출만 수정 대상.
  registryV2 패키지·lockfile·데이터는 통합 대상이 아니다.

완료 게이트는 루트 immutable 재설치, workspace 목록 확인, 기존 extension
테스트/타입 검사/빌드, registry-api 테스트/타입 검사/빌드, fixture 4/4,
Rust workspace 테스트다. Docker 변경은 이미지 빌드까지 검증하되 로컬 환경상
불가능하면 그 제한을 보고하고 다음 단계로 진행하지 않는다.

### 대안 B — registry-api도 npm 섬으로 유지

자체 Docker 문맥과 npm lockfile을 유지하므로 초기 변경은 작다. 다만 확정된
`apps/registry-api` 위치와 `apps/*` workspace 패턴을 함께 쓰면 자동으로
workspace에 포함된다. 독립성을 지키려면 앱 workspace 패턴을 명시 목록으로
바꾸는 등 목표 설정의 예외 승인이 필요하다. 같은 앱에 npm/Yarn lockfile을
모두 권위 있는 파일로 남기는 방식은 drift 관리가 추가되므로 권장하지 않는다.

## policy-ir / core 의존 방향 — 그래프와 선택지

기존 `graph.json`과 실제 import 문이 일치한다.

| 호출자 | 실제 의존 | 성격 |
| --- | --- | --- |
| `policy-store/render.ts:3` | `sdk/block-ir/ir.ts`의 `PolicyIR` | 타입 |
| `policy-store/render.ts:4` | `blocksToEst.ts`의 `blocksToEst` | 실행 시 함수 |
| `policy-store/render.ts:5` | `params.ts`의 `fillParams` | 실행 시 함수 |
| `policy-store/render.ts:7` | `policy-store/types.ts` → `sdk/policy-store-types.ts` | 타입 |
| `policy-store/resolve.ts:10` | 같은 barrel의 `isEffectiveOn`, `missingRequiredHoles` | 실행 시 함수 + 타입 |
| `policy-store/render.ts:6` | `wasm-bridge.ts`의 `estToPolicyText` | 실행 시 저작 WASM 호출 |

`sdk/policy-store-types.ts`는 이름과 달리 함수도 가진다(`:169`, `:176`).
반대로 현재 IR 7파일에서는 core/backend로 향하는 import가 없다. 현재 그래프는
core 후보 → IR 방향의 비순환 그래프다. 타입만 core로 옮겨 policy-ir이 core를
참조하게 바꾸면 남아 있는 실행 의존이 반대 방향을 계속 만들기 때문에 완결된
해결책이 되지 않는다. 이 사실을 `FINDINGS.md` F-006에 기록한다.

| 선택지 | 구체적 의미 | 이점 | 추가 비용/결정 |
| --- | --- | --- | --- |
| ① 공통 계약을 core로 이동 | 공통 타입을 core에 두고 policy-ir이 참조 | 공개 계약의 소유권이 core로 모임 | `blocksToEst`, `fillParams`, policy helper 실행 의존도 제거해야 한다. PolicySource에서 사전 렌더링하거나 렌더링 기능을 주입하는 추가 경계 설계가 필요하며, 타입 이동만으로는 불충분 |
| ② policy-ir도 발행 | core가 공개된 policy-ir을 정상 런타임 의존성으로 선언 | 기존 호출 관계를 유지하기 쉬움 | 확정된 private 정책을 변경하고 두 패키지의 공개 API·버전·발행 순서를 관리해야 함 |
| ③ 빌드 시 인라인 (권장) | policy-ir은 private로 유지하고 core의 빌드 의존성으로만 사용 | 확정된 패키지 배치와 현재 렌더링 동작을 유지할 수 있음 | tsup의 JS 및 declaration 출력에 IR 코드를 포함해야 하며 internal 번들에 저작 코드가 포함됨 |

③을 승인할 경우의 구체적인 약속:

- core → policy-ir은 workspace **개발/빌드 의존성**으로만 선언하고,
  배포 manifest의 `dependencies`·`peerDependencies`·`optionalDependencies`에는
  private policy-ir을 넣지 않는다. policy-ir에서 core로 향하는 역방향 의존은
  새로 만들지 않는다.
- tsup에서 policy-ir을 외부화하지 않고 필요한 코드와 타입 선언을 인라인한다.
  JS import뿐 아니라 `.d.ts` 안의 private 패키지 참조도 검사한다.
- 별도 tarball 설치에서 Node ESM/CJS·Vite 검증이 통과해야 하며,
  workspace 링크나 policy-ir 설치가 있어야만 통과하는 상태는 실패로 처리한다.
- 이 승인은 `renderDef`를 공개 런타임 API에 노출한다는 뜻이 아니다.
  `renderDef`의 저작 WASM 의존은 Phase 2/3에서 `internal` 표면과 런타임 6종
  분리를 검토할 때 함께 처리해야 한다. 렌더링 책임의 최종 경계는 별도로 보고한다.

## 현재 승인 요청

패키지 매니저는 **A**, policy-ir은 **③**을 권장한다. 두 선택 모두 아직
적용하지 않았다. 확정 프롬프트 §8.2–3에 따라 사용자의 결정 후
Phase 1 1단계만 구현·검증하고, 커밋·CI 확인을 기다린다.
