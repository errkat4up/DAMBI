# DEC-01~05: 실제 Registry·WASM Decoder 기준 시험

## DEC-05a 현재 상태 — 구현 완료, 사용자 실행 대기

DEC-05a는 실제 [`permitSingle@1.0.0.json`](../../registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json)을 기존 **v3 typed 경로**에 연결하는 fixture·시험 구현이다. 코드 작성·정적 검토와 사용자 실행 검증을 구분한다. **구현 완료, 사용자 실행 대기**이며 실행 통과 수·실행 로그·resolved digest는 아직 없다. 신규 요청 79개 + 구조 검사 6개 = **85개 정의**, 기존 Node 273개를 보존한 통합은 **358개 정의**다. DEC-01~04 사용자 통과 기록은 아래에 보존한다. **DEC-05b Batch는 미착수**이고 Single 사용자 실행 결과를 확인한 뒤 별도 변경으로 진행한다.

| 변경 파일 | 목적 |
| --- | --- |
| `permit2-single.cases.json`, `permit2-single.test.mjs` | 실제 원본 → strict Registry builder → typed index 해소·JCS digest → 실제 WASM 설치 → v3 Single Action·meta·오류·기존 한계 관찰 |
| `registry-selection.json` | `permit2_single_manifest`의 원본 경로·바이트 SHA-256 고정 |
| `helpers/build-registry.mjs` | 선택적 `includePermit2Single: true`와 해당 선택 때만 `permit2SingleSource` 반환. 기존 기본값·반환·hash 검증·실패 정리 유지 |
| 루트 `package.json` | `decoder:test:permit2-single` 추가, 통합 명령의 기존 다섯 시험 파일을 유지하고 Single만 추가 |
| 이 README, `coverage.md`, 두 `docs/sdk-migration/decoder-*-plan.md` | 작성/실행 상태, 원본 대응, 미결 계약과 사용자 실행 절차 기록 |

Single 시험의 선택은 `buildRegistry(selection, { includePermit: true, includePermit2Single: true })`다. approve 네 체인 4개 + USDC permit 1개 + Permit2 Single 네 체인 4개로 **callkey 9개, typed index 5개, selector index 0개**를 요구한다. Permit2 원본이 체인 `1/10/8453/42161`에 직접 선언한 `0x000000000022d473030f116ddee9f6b43ac78ba3`를 유지한다. USDC token 목록은 approve의 주소 확장 입력이며 Permit2 주소를 확장하는 입력이 아니다. Single 원본 바이트 SHA-256은 `0x6657c04696e97d08aaa80cc842d3d7976df7515953e7506fa97e50bd2812e696`이다.

기존 Rust의 `build_typed_data_args_json`은 이미 ABI components 순서로 named object를 positional tuple로 변환한다. Single typed message에는 owner를 추가하지 않는다. underlying token·Permit2 verifying contract·spender·submitter를 구분하고 객체 키 재배열, 수량/시간/nonce 경계, 기존 EIP-2612 flat 경로 및 프로세스 격리를 검사하도록 작성했다. 내부 배열 호환 입력과 정상 EIP-712 객체를 별도 분류한다. 정확한 정상/오류/관찰 범위와 원본/Rust synthetic 대응표는 [coverage](coverage.md#dec-05a--작성한-검사와-미결-계약) 및 [상세 계획](../../docs/sdk-migration/decoder-design-plan.md#dec-05--permit2-single--batch--전체-계획-d2)을 따른다.

**nonce 모델 문제는 별도 교정 대상으로 남긴다.** signed nonce `513`을 현재 mapper가 `["0x2", 1]`로 분해하며 `source.function = nonceBitmap(address,uint256)`, `decoder_id = permit2_nonce_bitmap`, `ttl = 12`, `synced_at = submitted_at`을 붙인다. 이 값은 외부 RPC 조회 결과나 단순 zero stub이 아니다. PermitSingle/Batch의 AllowanceTransfer 순차 `uint48` nonce와 SignatureTransfer의 unordered nonce bitmap은 서로 다른 계약이다. [AllowanceTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer), [SignatureTransfer 공식 문서](https://developers.uniswap.org/docs/protocols/permit2/concepts/signature-transfer).

nonce 누락/null/파싱 실패의 zero fallback, `uint160/uint48` 선언 폭 미검사, 큰 `sigDeadline`의 body/meta 불일치·JS 정밀도 손실은 정상 계약으로 승인한 기대값이 아닌 **기존 동작 진단**이다. 사용자는 교정안 구체화 후 **A — 연결 시험·교정 설계만 마무리**를 선택했다. [구체 계약 교정안 A/B/C](../../docs/sdk-migration/decoder-design-plan.md#dec-05-계약-교정안-a안-확정bc-미구현-제안)는 A 현재 baseline+설계(확정), B v4 입력 검증만 추가(모델 의미 미교정), C v4+새 allowance Action/소비자 교정으로 구분한다. 이번 변경 범위의 미응답 질문은 없다. 런타임 계약 교정은 별도 범위로 남기며 B/C는 미구현 제안이다. v4 strict 지원은 여전히 USDC EIP-2612만이며 Permit2 허용 ID 추가·v3 자동 재시도를 하지 않는다. 외부 nonce 조회·서명 검증·정책 판정은 미연결이다.

### DEC-05a 사용자가 직접 실행할 검증 명령

에이전트는 빌드·시험·의존성 설치·Git 변경 명령을 실행하지 않았다. Rust·worker·빌드 입력을 변경하지 않았고 DEC-04 저장 로그의 Rust/빌드 입력 9개와 현재 파일을 읽기 전용으로 대조해 일치를 확인했다. 현재 JS/WASM hash도 아래 DEC-04b 저장 로그의 검증된 쌍과 일치한다. 따라서 **WASM 재빌드 없이** Single 개별 시험 → 기존 273개를 포함한 통합 시험을 실행한다. 아래 블록은 실행 전후 입력/산출물 hash·Git 상태·patch와 종료 상태를 `/tmp`에 저장하며 `tee`가 시험 실패를 숨기지 않게 한다. 산출물이 기록값과 다르면 이 블록은 시험 전에 중단하므로 출처를 먼저 확인한다.

```bash
bash <<'BASH'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
export GIT_OPTIONAL_LOCKS=0
dec05_log_dir="$(mktemp -d /tmp/dambi-dec05a-verify.XXXXXX)"
printf 'dec05a_log_dir=%s\n' "$dec05_log_dir"
dec05_inputs=(
  package.json
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  fixtures/decoder-policy/permit2-single.cases.json
  fixtures/decoder-policy/permit2-single.test.mjs
  fixtures/decoder-policy/registry-selection.json
  fixtures/decoder-policy/helpers/build-registry.mjs
  fixtures/decoder-policy/helpers/wasm-worker.mjs
  fixtures/decoder-policy/approve.cases.json
  fixtures/decoder-policy/approve.test.mjs
  fixtures/decoder-policy/approve-policy.test.mjs
  fixtures/decoder-policy/transfer.cases.json
  fixtures/decoder-policy/transfer.test.mjs
  fixtures/decoder-policy/typed-permit.cases.json
  fixtures/decoder-policy/typed-permit.test.mjs
  fixtures/decoder-policy/typed-permit-strict.cases.json
  fixtures/decoder-policy/typed-permit-strict.test.mjs
  fixtures/decoder-policy/README.md
  fixtures/decoder-policy/coverage.md
  docs/sdk-migration/decoder-design-plan.md
  docs/sdk-migration/decoder-core-adapters-plan.md
  registryV2/package.json
  registryV2/package-lock.json
  registryV2/scripts/build-index.ts
  registryV2/manifests/standard/erc20/approve@1.0.0.json
  registryV2/manifests/standard/erc20/transfer@1.0.0.json
  registryV2/manifests/standard/erc20/permit@1.0.0.json
  registryV2/manifests/uniswap/permit2/permitSingle@1.0.0.json
  registryV2/tokens/1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.json
  registryV2/tokens/10/0x0b2c639c533813f4aa9d7837caf62653d097ff85.json
  registryV2/tokens/8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.json
  registryV2/tokens/42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831.json
  crates/policy-engine-wasm/src/declarative_exports.rs
  crates/policy-engine-wasm/Cargo.toml
  crates/policy-engine-wasm/src/lib.rs
  crates/policy-engine-wasm/src/typed_data_validation.rs
  crates/policy-engine-wasm/src/dto.rs
  crates/adapters/mappers/src/declarative/action_builder.rs
  crates/policy-server/asset-model/action/src/token/permit2_sign.rs
  crates/policy-engine-wasm/tests/declarative_v3_typed_data_install.rs
)
dec05_artifacts=(
  crates/policy-engine-wasm/pkg/policy_engine_wasm.js
  crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm
)
dec05_finish() {
  dec05_exit=$?
  trap - EXIT
  set +e
  {
    date -u '+finished_utc=%Y-%m-%dT%H:%M:%SZ'
    git branch --show-current
    git rev-parse HEAD
    git status --short
    git diff --name-only
  } > "$dec05_log_dir/source-after.log" 2>&1
  git diff --binary > "$dec05_log_dir/tracked-after.patch"
  shasum -a 256 -c "$dec05_log_dir/inputs-before.sha256" > "$dec05_log_dir/inputs-after.log" 2>&1
  dec05_input_exit=$?
  shasum -a 256 -c "$dec05_log_dir/artifacts-before.sha256" > "$dec05_log_dir/artifacts-after.log" 2>&1
  dec05_artifact_exit=$?
  if [ "$dec05_exit" -eq 0 ] && { [ "$dec05_input_exit" -ne 0 ] || [ "$dec05_artifact_exit" -ne 0 ]; }; then
    dec05_exit=1
  fi
  printf 'verification_exit=%s input_hash_exit=%s artifact_hash_exit=%s\n' \
    "$dec05_exit" "$dec05_input_exit" "$dec05_artifact_exit" | tee -a "$dec05_log_dir/timeline.log"
  printf 'dec05a_log_dir=%s\n' "$dec05_log_dir"
  exit "$dec05_exit"
}
trap dec05_finish EXIT
{
  date -u '+started_utc=%Y-%m-%dT%H:%M:%SZ'
  git branch --show-current
  git rev-parse HEAD
  git status --short
  git diff --name-only
  node --version
  npm --version
} | tee "$dec05_log_dir/source-and-tools.log"
git diff --binary > "$dec05_log_dir/tracked-before.patch"
shasum -a 256 "${dec05_inputs[@]}" > "$dec05_log_dir/inputs-before.sha256"
shasum -a 256 "${dec05_artifacts[@]}" > "$dec05_log_dir/artifacts-before.sha256"
cat > "$dec05_log_dir/dec04b-artifacts.sha256" <<'HASHES'
628e1a7956b3d82ec203c17af83cb3b06a915d45df070166c6de49a843207043  crates/policy-engine-wasm/pkg/policy_engine_wasm.js
c39531dabb7f6f81b0cfa7b0324f33a2b5e906c569ddc15063ec1d170f6177b9  crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm
HASHES
shasum -a 256 -c "$dec05_log_dir/dec04b-artifacts.sha256" | tee "$dec05_log_dir/reused-artifacts.log"
git diff --check 2>&1 | tee "$dec05_log_dir/diff-check.log"
date -u '+single_started_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec05_log_dir/timeline.log"
npm run decoder:test:permit2-single 2>&1 | tee "$dec05_log_dir/permit2-single.log"
date -u '+single_success_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec05_log_dir/timeline.log"
date -u '+integrated_started_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec05_log_dir/timeline.log"
npm run decoder:test 2>&1 | tee "$dec05_log_dir/integrated.log"
date -u '+integrated_success_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec05_log_dir/timeline.log"
BASH
```

사용자 실행 후 위 로그 경로의 개별·통합 결과, 전후 입력/산출물 hash 및 실제 코드를 대조하고 네 문서의 실행 상태를 갱신한다. 입력 목록은 이번 실행을 대조하는 목록이며 전체 SDK 소스 독립 빌드의 증거가 아니다. 기존 Registry 의존성이 없다는 오류가 나오면 시험은 실패로 남기고 `npm ci --prefix registryV2`가 필요한지 사용자가 확인한다. 새 dependency를 추가하지 않는다.

### DEC-05a 검증 결과 반영 후 로컬 커밋 명령

아래는 사용자 실행 검증과 결과 문서 갱신 이후 사용자가 실행할 명령이다. 변경 내용을 검토하고 이번 아홉 경로만 stage한다. 기존 staged 변경이 있으면 중단하고, stage 이후에도 목록이 아홉 경로와 정확히 일치해야 commit한다. Batch 파일·WASM·pkg·target·node_modules·임시 로그와 push는 포함하지 않는다.

```bash
bash <<'BASH'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
git diff --check
git status --short
git diff --name-only
if ! git diff --cached --quiet; then
  printf 'Existing staged changes: review their scope before this commit.\n' >&2
  git diff --cached --name-only
  exit 1
fi
dec05_files=(
  fixtures/decoder-policy/permit2-single.cases.json
  fixtures/decoder-policy/permit2-single.test.mjs
  fixtures/decoder-policy/registry-selection.json
  fixtures/decoder-policy/helpers/build-registry.mjs
  package.json
  fixtures/decoder-policy/README.md
  fixtures/decoder-policy/coverage.md
  docs/sdk-migration/decoder-design-plan.md
  docs/sdk-migration/decoder-core-adapters-plan.md
)
dec05_stage_dir="$(mktemp -d /tmp/dambi-dec05a-stage.XXXXXX)"
git add -- "${dec05_files[@]}"
git diff --cached --check
git diff --cached --stat
printf '%s\n' "${dec05_files[@]}" | LC_ALL=C sort > "$dec05_stage_dir/expected-paths.txt"
git diff --cached --name-only | LC_ALL=C sort > "$dec05_stage_dir/staged-paths.txt"
diff -u "$dec05_stage_dir/expected-paths.txt" "$dec05_stage_dir/staged-paths.txt"
git commit -m "test(decoder): connect real Permit2 Single typed decoding" -- "${dec05_files[@]}"
git log -1 --oneline
git status --short
BASH
```

## DEC-01~04 보존 기록

아래의 “현재”, “이번”, DEC-05 미진행 및 과거 준비·빌드·커밋 명령은 **각 기록을 작성한 DEC-01~04 당시 문맥**이다. 과거 실행 결과·로그·hash·미제공 항목은 수정하지 않는다. 이번 실행에는 위 DEC-05a 명령을 사용한다.

이 디렉터리는 SDK 이관 전의 **DEC-01/02/03/04 기준 시험과 strict 입력 회귀** 이다. 실제 Registry source를 실제 builder로 확장하고 기존 WASM에 설치한 뒤, 고정된 원문 approve·transfer calldata와 typed permit 요청을 Action까지 해석한다. DEC-02는 approve 디코딩 결과를 기존 planner/evaluator에 전달해 실제 Cedar 정책 하나를 평가한다. **DEC-01/02는 사용자 실행 보고 기준 검증 완료**이며 통합 37개(30 + 7) 통과, 실패·취소·건너뛰기·todo 모두 0이다. **DEC-03도 사용자 실행 보고 기준 검증 완료**다. 제공된 터미널 로그에서 transfer 개별 21개와 통합 회귀 58개가 모두 통과했으며 실패·취소·건너뛰기·todo는 모두 0이다. 04a는 사용자 제공 전체 로그 기준 typed permit **47/47 통과**(`duration_ms=801.277375`), 당시 통합 **105/105 통과**(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 이전 기록으로 채우지 않는다. 04a 사용자 실행 결과를 반영했고, 합의된 04b v4 DTO·strict validator·실행부·Rust/Node 회귀 시험을 별도 변경으로 작성했다. 04b 사용자 실행의 저장 로그를 직접 확인했다. Native 181개와 새 WASM 빌드, Node strict 168개·기존 typed 47개·통합 273개가 모두 통과하여 **DEC-04 전체 검증 완료**다. 에이전트가 빌드·시험을 재실행한 결과는 아니다.

DEC-01 구현 및 연결 시험은 **사용자 실행 보고 기준으로 30개 통과**했다. 실패·취소·건너뛰기는 모두 0개다. 최초 시험에 이어 현재 Rust 소스에서 직접 WASM을 빌드한 뒤 실행한 시험도 같은 결과로 통과했다. 실제 Registry builder → resolved bundle digest 확인 → 실제 WASM 설치·approve 디코딩 경로가 시험되었다. 두 결과 모두 사용자가 제공한 출력이며, 문서를 정리한 에이전트가 실행한 결과가 아니다.

**DEC-01 당시 Rust 소스 → 직접 빌드한 WASM → 해당 산출물의 연결 시험 통과를 사용자 보고 기준으로 확인했다.** 근거는 안내한 절차의 실행 완료 보고, 전후 HEAD·Git 변경 목록, 도구 버전 조회, 빌드 성공 표식·시각, WASM SHA-256, 뒤이어 실행한 테스트 출력과 시각이다. 상세 빌드 로그·전체 빌드 명령 출력·실제 임시 target 경로·빌드 시작 시각은 미제공으로 기록 보완을 기다린다. 에이전트가 별도로 재빌드하여 소스와 산출물의 일치를 독립 재현한 것은 아니다. DEC-02는 아래 별도 사용자 실행 기록으로 완료를 확인했다. SDK 전체 소스·빌드 독립화는 미완료다. 이번 기록 갱신에서 에이전트는 빌드·테스트·설치·Git add/commit/push/merge/reset·브랜치 변경을 실행하지 않는다. 이 사용자 제한은 계획서의 자동 검증·커밋 지침보다 우선한다.

## 검증 기록

DEC-01 문서 정리 시점에 Git을 읽어 확인한 브랜치는 `feat/decoder`, HEAD는 `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615`였다. 당시 Git 상태상 `crates/`의 Rust 소스, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`, `schema/`, `scripts/wasm-build.sh`, `.github/workflows/ci.yml`에 미커밋 변경은 없었다. 전체 작업 트리는 `package.json` 수정과 DEC-01 fixture·두 계획서의 미추적 파일 때문에 변경된 상태였고 스테이징된 변경은 없었다. 이는 **당시 소스 상태의 확인**이며, 빌드 출처가 없던 최초 시험의 WASM 상태를 소급해 증명하지 않는다. 재빌드 후 검증은 아래 별도 사용자 기록을 따른다.

2026-09-11 DEC-02 착수 시 직접 읽은 Git 상태는 `feat/decoder`, HEAD `3066f0c` (`test(decoder): verify real approve decoding baseline`), 작업 트리 깨끗함, `origin/feat/decoder`보다 1커밋 앞섬이다. DEC-01 커밋의 존재는 WASM과 소스의 일치 검증을 추가로 증명하지 않는다. 기존 사용자 실행 기록의 HEAD와 미확인 항목을 현재 HEAD로 덮어쓰지 않는다.

아래 두 실행 기록은 별개로 유지한다. 확인 대기 칸은 실제 결과가 제공된 뒤 채우며, 저장소에 선언된 권장 버전이나 예상 통과 수를 실행 결과로 복사하지 않는다.

| 기록 항목 | 기존 사용자 실행 보고 | 현재 Rust 소스 재빌드 후 검증 |
| --- | --- | --- |
| 실행자·근거 | 사용자 제공 터미널 출력 | 사용자 제공 도구 조회·절차 전후 Git 출력·빌드 성공 표식·`shasum` 출력·재빌드 후 전체 테스트 출력. 상세 빌드 로그는 확인 대기 |
| 빌드 대상 브랜치·소스 HEAD | 확인 대기 | 준비 시 브랜치 `feat/decoder`; 절차 전후 HEAD `23eaaa6992f21fcd48ba6eb79762ec5db3ad6615` 동일. 안내한 현재 소스 재빌드 절차의 사용자 실행 보고 기준 |
| 빌드 전후 미커밋 변경 목록·diff | 확인 대기 | 전후 Git 변경 목록 동일: `package.json` 수정, 두 계획서와 DEC-01 fixture 6개 미추적. Rust 소스·빌드 설정 변경은 목록에 없음. 파일 내용의 전후 diff는 확인 대기 |
| 실제 Rust toolchain·rustc·Cargo 버전 | 확인 대기 | 사용자 조회: `1.95.0-aarch64-apple-darwin` (`RUSTUP_TOOLCHAIN` override), `rustc 1.95.0 (59807616e 2026-04-14)`, `cargo 1.95.0 (f2d3ce0bd 2026-03-21)` |
| 실제 wasm-pack·Node·npm 버전 | 확인 대기 | 사용자 조회: wasm-pack `0.14.0`, Node `v25.9.0`, npm `11.12.1` |
| 실제 빌드 명령·환경 옵션·종료 코드 | 확인 대기 | `RUSTUP_TOOLCHAIN=1.95.0` 설정 및 안내한 2번 빌드의 `build_success_utc` 표식 보고. 상세 명령·나머지 환경 옵션·별도 종료 코드 출력은 확인 대기 |
| 빌드 시작·종료 시각(UTC) | 확인 대기 | 시작: 확인 대기. 성공 표식: **`2026-09-11T06:57:10Z`** |
| 생성 WASM 경로·SHA-256 | 확인 대기 | `crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm` — **`1eb49d624365f942ce911ab3aeba8a063556857436faca9097676f6f226d9dbd`** (사용자의 `shasum -a 256` 출력) |
| 실제 테스트 명령 | `npm run decoder:test` | `npm run decoder:test && date -u '+test_success_utc=%Y-%m-%dT%H:%M:%SZ'` |
| 테스트 시작·종료 시각(UTC)·종료 코드 | 확인 대기 | 시작 **`2026-09-11T06:57:40Z`**, 성공 **`2026-09-11T06:57:42Z`**. `&&` 뒤 성공 시각이 출력되어 테스트 종료 코드 0 확인 |
| 전체 / 통과 / 실패 / 취소 / 건너뛰기 | **30 / 30 / 0 / 0 / 0** | **30 / 30 / 0 / 0 / 0** (재빌드 후 사용자 출력) |
| 테스트 출력의 실행 시간 | `duration_ms: 2050.144875` | `duration_ms: 1290.958958` |
| 소스 → 빌드 → 동일 WASM으로 시험 연결 | 최초 시험의 빌드 출처는 미확인 | **사용자 실행 보고 기준 확인.** 에이전트 독립 재빌드·시험은 미수행 |

사용자 제공 `rustc --version --verbose`의 상세 값은 commit hash `59807616e1fa2540724bfbac14d7976d7e4a3860`, commit date `2026-04-14`, host `aarch64-apple-darwin`, release `1.95.0`, LLVM `22.1.2`다. 재빌드 후 시험 결과는 새로 제공된 전체 출력에서 기록했으며, 최초 30개 통과를 복사한 것이 아니다. 새 출력의 `suites`와 `todo`도 각각 0이다.

기존 `pkg`의 수정 시각이나 파일 hash만으로 새 빌드를 증명하지 않는다. 이번 확인은 사용자가 보고한 소스 상태·도구 버전·직접 빌드 성공·WASM hash·후속 시험을 함께 근거로 한다. 남은 기록 항목은 미제공 상태를 보존하며 임의의 시작 시각이나 로그를 채우지 않는다.

### DEC-02 실행 기록 — 사용자 실행 보고 기준 검증 완료

2026-09-11 사용자가 제공한 실행 검증 요약을 반영했다. 사용자는 실제 WASM 빌드, 통합 시험 통과, 현재 JS/WASM의 SHA-256과 실행 로그의 일치를 확인했다고 보고했다. 이번 기록 갱신에서는 원본 로그 재열람·hash 재계산·빌드·시험을 수행하지 않았다.

| 기록 항목 | 상태 |
| --- | --- |
| 구현·정적 검토 | 로컬 커밋 `26df736` (`test(decoder): connect approve decoding to policy evaluation`), 브랜치 `feat/decoder`. 예정한 6개 파일 포함. 실제 DTO·정책 원문과 연결 코드를 대조했으며 진행을 막는 코드 문제를 발견하지 않음 |
| 실행자·근거 | 사용자 실행 및 사용자가 제공한 검증 요약. 에이전트의 독립 재실행 결과가 아님 |
| WASM 빌드 | 실제 Rust crate 컴파일·최적화·`pkg` 생성 완료 보고 |
| 현재 JS/WASM과 실행 로그의 일치 | 사용자가 직접 계산한 WASM·JS SHA-256이 실행 로그와 모두 일치했다고 보고. 구체적인 hash 값은 이번 요약에 미포함 |
| 통합 시험 전체 / 통과 / 실패 / 취소 / 건너뛰기 / todo | **37 / 37 / 0 / 0 / 0 / 0** — 사용자 실행 결과 |
| DEC-01 회귀 시험 | 기존 **30개 모두 통과** |
| DEC-02 정책 시험 | 요구한 **7개 모두 기대 판정과 일치** |
| 연결 시험에서 확인한 계약 | `planned: []`, 외부 Fact 없는 평가, 정확한 `unlimited-approval-deny` 정책 ID·severity `warn`·origin `action` 검사 통과. 엔진 오류나 quarantine 경고를 정상 정책 경고로 인정하지 않음 |

실행 시점의 소스 HEAD·전후 diff, 실제 도구 버전·전체 명령·환경·임시 target 경로, 시각·별도 종료 코드·실행 시간과 구체적인 JS/WASM hash 값은 이번 요약에 포함되지 않아 임의로 채우지 않는다. 위 구현 커밋을 실행 시점 HEAD로 대체하거나 DEC-01의 과거 값을 복사하지 않는다. 이 세부 기록의 부재로 사용자 실행 기준 통과를 검증 대기로 되돌리거나 재빌드·재시험을 요구하지 않는다. DEC-01의 두 과거 실행과 미제공 항목은 그대로 유지한다.

## 파일과 실행 경로

| 파일 | 역할 |
| --- | --- |
| `registry-selection.json` | 실제 manifest 및 네 체인의 token 파일을 명시하고 원본 바이트의 SHA-256을 고정 |
| `approve.cases.json` | 고정 raw calldata, 입력 필드, 독립적으로 작성한 기대 decoder ID/Action/error kind |
| `approve.test.mjs` | Node 내장 `node:test`로 source·index·bundle·WASM 결과를 검사 |
| `approve-policy.test.mjs` | DEC-01의 원문 입력을 재사용해 7개 실제 approve 정책 판정 및 planner/평가 DTO 검사 |
| `transfer.cases.json` | 네 체인의 고정 transfer calldata와 독립적인 기대 Action·오류 18개 |
| `transfer.test.mjs` | 18개 요청 및 3개 구조 검사. 두 실제 manifest의 8개 callkey, JCS digest, 교대 디코딩·설치 격리 검사 |
| `typed-permit.cases.json`, `typed-permit.test.mjs` | 실제 USDC 원본의 typed index·WASM 경로, 축약 DTO의 정상·오류 및 알려진 검증 한계 관찰 |
| `typed-permit-strict.cases.json`, `typed-permit-strict.test.mjs` | 전체 입력·오류 우선순위·정밀도·원본 보존을 실제 v4 WASM으로 검사. Rust integration도 같은 fixture를 재생 |
| `coverage.md` | 기존 58개·04a 47개/통합 105개 사용자 통과 기록, 04b 실제 실행 결과·완료 범위 |
| `helpers/build-registry.mjs` | 원본 복사, 실제 builder 실행, inline/`3-ref` 해소 및 JCS digest 검사 |
| `helpers/wasm-worker.mjs` | 별도 Node 프로세스에서 실제 WASM 초기화·bundle 설치·요청 디코딩. 선택적 `policyBundle`이 있을 때 실제 planner/evaluator까지 연결 |
| 루트 `package.json` | `decoder:test`는 기존 네 시험 파일·105개 사례를 유지하고 strict 파일 추가. typed permit 및 strict 개별 명령 제공 |

```text
registryV2/manifests/standard/erc20/approve@1.0.0.json
  + DEC-03에서만 standard/erc20/transfer@1.0.0.json 명시 선택
  + registry-selection.json이 선정한 실제 token 파일
  → 원본 바이트 hash 확인 및 임시 Registry 복사
  → BUILD_INDEX_REGISTRY_ROOT=<임시 경로>
  → 실제 build-index.ts --strict-callkeys
  → 생성 index의 chain/to/selector 및 bundle 참조 확인
  → resolved bundle의 JCS SHA-256 확인
  → 실제 WASM declarative_install_v3_json
  → 원문 calldata를 declarative_route_request_v3_json에 전달
  → decoder ID 및 Action/error kind 검증
  → DEC-02: 실제 Action.body/meta + 원래 요청의 tx
  → 실제 manifest로 plan_action_rpc_v2_json → planned: [] 검사
  → 실제 Cedar/manifest + results: {}로 evaluate_action_v2_json
  → pass/warn/fail DTO와 정확한 matched 정책 정보 검사
```

helper는 `mkdtemp`로 만든 Registry에 원본 파일을 그대로 복사한다. `buildRegistry(selection)`의 기본 호출은 기존처럼 approve만 빌드하고 `{ root, source, tokens, cleanup }`을 반환한다. DEC-03에서만 `buildRegistry(selection, { includeTransfer: true })`로 `selection.transfer_manifest`를 추가하며 이때만 `transferSource`를 반환값에 더한다. 기존 DEC-01의 정확히 4개 callkey 검사와 DEC-02의 기본 호출을 유지한다.

source manifest의 `chain_ids`를 다시 쓰거나 임의로 축소하지 않는다. 실제 builder를 `execFile`의 구조화된 인수로 호출하며, `BUILD_INDEX_REGISTRY_ROOT`가 임시 입력·출력 경로를 지정한다. builder가 실패·시간 초과하면 임시 산출물 전체를 폐기하고 예외를 전달한다. 일부 생성된 index/bundle을 WASM 입력으로 계속 소비하지 않는다. 정상 실행 후에도 시험이 임시 파일을 정리한다.

## 선정한 원본과 digest 의미

실제 approve·transfer source 모두 `chain_to_addresses_source: "tokens:erc20"`, `chain_ids: [1, 10, 8453, 42161]`를 선언한다. 네 체인의 실제 USDC token 파일을 각각 하나씩 선택한다. 정확한 입력 목록과 바이트 hash는 `registry-selection.json`이 기준이다. 기존 approve/token 경로·hash는 보존하고 transfer 원본 바이트의 SHA-256 `0x47e37a1ada72a9fee9e4b8077b7000f0b1198a0219fa513d3ccb74def70ee925`만 추가했다.

| chain ID | `registryV2/` 기준 token 파일 |
| --- | --- |
| 1 | `tokens/1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.json` |
| 10 | `tokens/10/0x0b2c639c533813f4aa9d7837caf62653d097ff85.json` |
| 8453 | `tokens/8453/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.json` |
| 42161 | `tokens/42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831.json` |

이 선택은 네 체인의 주소 확장과 최소 정상 사례를 위한 시험 입력이다. 전체 Registry token 목록, 체인의 실제 존재 여부, 계약 배포 상태 또는 최종 SDK 지원 범위를 검증했다는 뜻이 아니다. source hash가 달라지면 먼저 원본 변경을 검토하고 selection을 명시적으로 갱신한다. 실행 결과에서 기대값이나 hash를 자동 재생성하지 않는다.

서로 다른 hash의 의미를 구분한다.

| 값 | 검사 대상 |
| --- | --- |
| selection의 `sha256` | manifest/token **원본 파일 바이트**의 SHA-256. 공백 변경도 감지 |
| index의 `bundle_sha256` | **해소 완료된 bundle 객체**를 JCS(RFC 8785)로 정규화한 문자열의 SHA-256 |
| `bundle_ref` 파일명 | `bundles/<bundle_sha256>.json`과의 일치 |

digest 검사는 index가 지시하는 resolved bundle의 일관성을 검증한다. 개별 index 파일 전체의 서명, Registry 전체 root digest, 발행자 인증 또는 공급망 서명을 검증하는 기능은 아니다.

기존 `registry-api/src/server.ts`의 `materializeIfRefIndex`를 참고해 이번에 필요한 두 형태만 해소한다. inline index는 `bundle`을 사용하고, `schema_version: "3-ref"`는 `bundle_ref` 파일을 읽는다. 현재 approve·transfer token source는 후자다. builder가 사용하는 기존 `canonicalize` 의존성을 재사용하며, bundle을 별도 타입으로 투영하거나 emit 규칙을 다시 작성하지 않는다. `context_ref`/`materialization`이 있는 source-context 조립은 지원하지 않고 명시적으로 거절한다. 해당 경로가 필요해지면 기존 `materializeSourceBundle`과의 동일성을 별도 검토해야 한다.

## DEC-01 기대값과 오류 구분

고정 calldata에서 selector, spender의 32바이트 word, uint256 amount 위치를 독립적으로 확인한다. 수량 검산에는 `BigInt`와 문자열을 사용하며 JS `Number`로 변환하지 않는다. 기대 Action을 decoder 반환값에서 만들지 않는다. 기존 `args_to_json`은 uint256을 decimal string으로 전달하고, 최종 Rust U256 JSON 직렬화는 최소 길이 hex 문자열을 출력한다. 예를 들어 0은 `"0x0"`, 1,000,000은 `"0xf4240"`이다.

manifest의 중첩 `token.erc20_approve`와 실제 Action body의 평탄화된 `domain`, `action`, `token`, `spender`, `amount`를 구분한다. token은 호출 대상 `to`, spender는 calldata 인자이고 출력 주소는 소문자다. token chain은 `eip155:<chain_id>`를 유지한다. 설치 결과와 디코딩 결과의 ID는 모두 `standard/erc20/approve@1.0.0`이어야 한다.

27개 요청 사례와 3개 연결·fixture 검사를 작성했다(총 30개 Node test). 시험 사례는 다음을 포함한다.

- 네 체인의 정상 approve, 승인량 0·일반 수량·`2^160-1`·`2^256-1`·`2^256-2`.
- 주소 대소문자 정규화 및 token/spender의 구분.
- 설치된 decoder의 등록 조합에 없는 정상 형식의 요청.
- 잘못된 주소·chain 표현, 비정상 hex, selector만 존재, 인자 일부 누락.
- 입력 selector와 calldata selector 불일치의 두 방향.
- 정상 ABI 인자 뒤 추가 바이트를 붙여도 동일 Action을 얻는 기존 호환성.
- bundle을 설치한 프로세스와 설치하지 않은 프로세스의 상태 분리.

| 구분 | 기존 결과 및 의미 |
| --- | --- |
| 주소 파싱 실패 / `chain_id: u64` 역직렬화 실패 | `invalid_input_json`: 입력 형식 오류 |
| 비정상 calldata hex | `invalid_calldata`: 입력 바이트 형식 오류 |
| 정상 형식의 미등록 `(chain, to, selector)` | `no_declarative_v3_mapper`: 설치된 decoder의 매칭 범위 밖 |
| 매칭된 approve의 selector-only / 부족한 ABI 인자 | `decode_failed`: 알려진 호출의 해석 실패 |
| 입력 selector=approve, calldata selector=다른 값 | approve lookup 후 ABI selector 검사에서 `decode_failed` |
| 입력 selector=미등록 값, calldata selector=approve | ABI 해석 전 lookup에서 `no_declarative_v3_mapper` |
| 정상 ABI 인자 뒤 추가 바이트 | 허용. 기본 `decode_with_function`의 `validate=false` 유지 |

selector 불일치의 두 오류는 현재의 lookup 우선순위를 고정한다. lookup 전 일치 검사를 추가하면 오류 분류가 달라지므로 이 단계에서 추가하지 않는다. selector-only는 4바이트 calldata이며 빈 calldata의 native-transfer 분기와 다르다. 인자 누락 거절과 추가 바이트 허용은 최초 시험과 현재 소스 재빌드 후 시험의 사용자 출력에서 모두 통과했다. 코드에서는 Alloy의 최소 word 검사와 permissive ABI decode가 각각 이 동작에 대응한다.

형식 검사, decoder 매칭, 위험 판정은 별개다. 미등록 주소·체인을 악성으로 판단하거나 allow/warn/deny 정책을 추가하지 않는다. 이번 필수 사례에서 Rust 변경이 필요한 차이는 정적 검토 및 사용자 실행 보고에서 발견하지 않았다. 현재 소스의 재빌드·시험 결과가 기대와 다르면 fixture를 유지하고 관련 최소 입력·현재 결과·기대 차이·수정 선택지를 정리한 뒤 범위 변경을 판단한다.

서로 다른 설치 시나리오는 각기 새 Node 프로세스로 실행한다. 기존 WASM의 전역 `DECLARATIVE_V3_STATE`와 module cache를 공유하지 않으며, 격리를 위해 reset API나 Core 인스턴스 구현을 추가하지 않는다. 디코더·WASM은 mock하지 않는다.

Action meta의 gas price에는 기존 실행부가 만든 Pyth source stub이 포함된다. 시험은 현재 직렬화 형식을 확인하며, 이 값을 실제 Oracle 조회나 검증된 provenance의 증거로 사용하지 않는다.

## DEC-02 정책 입력·기대값·오류 구분

정책 원본은 `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/{policy.cedar,manifest.json}`이다. 파일을 그대로 읽어 사용하며 본문·manifest·severity는 변경하지 않는다. 이름에 `deny`가 있어도 실제 annotation은 `@severity("warn")`이다. 정책은 `context.amount`가 정확히 40개 또는 64개의 `f`인 U256 hex 문자열일 때, spender가 원문 allowlist의 Permit2 주소 `0x000000000022d473030f116ddee9f6b43ac78ba3`가 아니면 경고한다. 시험에 고정한 주소를 해당 Cedar set literal과 대조한다.

| DEC-01 원문 입력 | spender | 승인량의 독립 검산 | 기대 DTO `kind` |
| --- | --- | --- | --- |
| `amount-zero` | 일반 spender | `0` | `pass` |
| `amount-normal` | 일반 spender | `1,000,000` | `pass` |
| `amount-uint160-max` | 일반 spender | `2^160-1` | `warn` |
| `amount-uint256-max` | 일반 spender | `2^256-1` | `warn` |
| `amount-uint256-max-minus-one` | 일반 spender | `2^256-2` | `pass` |
| `amount-uint160-max`의 spender word만 교체 | 정책에 선언된 Permit2 | `2^160-1` | `pass` |
| `amount-uint256-max`의 spender word만 교체 | 정책에 선언된 Permit2 | `2^256-1` | `pass` |

일반 spender는 DEC-01 원문 입력의 `0x00000000000000000000000000000000deadbeef`다. 체인 1의 기존 5개 입력만 재사용하고 Permit2 예외 2개를 추가한다. Registry source의 네 체인 선언은 그대로 빌드하지만 정책 시험의 불필요한 체인·수량 조합과 DEC-01의 30개 검사는 복제하지 않는다.

기대 판정은 위 정책의 정확한 동등 비교와 예외 조건을 읽고 명시했으며, 수량은 원문 calldata의 두 번째 ABI word를 `BigInt`로 독립 검산한다. 실제 평가 결과를 정답 파일에 저장하거나 DEC-01 fixture의 `expected` Action을 평가 입력으로 사용하지 않는다. Permit2 사례는 **원문 calldata의 첫 번째 ABI word만 교체**하고 selector·amount 바이트 보존을 확인한 뒤 실제 디코더를 다시 통과한다. 이미 디코딩된 Action은 수정하지 않는다.

worker는 실제 디코딩 결과에서 `action: decoded.body`, `meta: decoded.meta`를 그대로 전달한다. `tx`는 원래 요청의 `chain_id`를 `eip155:<chain_id>` 문자열로 표현하고, `from: input.submitter`, `to: input.to`로 구성한다. token·spender·amount를 새 평가용 객체로 재작성하지 않는다. 기존 `action_eval_exports.rs`의 `plan_action_rpc_v2_json`에는 `manifests: [manifest]`, `evaluate_action_v2_json`에는 `bundles: [{ policy, manifest }]`, `results: {}`를 전달한다. 별도 평가 로직·mock·Fact provider는 없다.

각 사례는 planner의 전체 성공 envelope와 `data.planned: []`를 검사한다. evaluator의 성공 envelope만으로는 판정 성공을 알 수 없으므로 `dto.rs`의 실제 `pass/warn/fail` 표현을 사용한다. pass는 `{ kind: "pass" }`, warn은 다음 전체 DTO와 일치해야 한다.

```json
{
  "kind": "warn",
  "matched": [{
    "policy_id": "unlimited-approval-deny",
    "reason": null,
    "severity": "warn",
    "origin": "action"
  }]
}
```

정확한 `matched` 비교는 엔진 오류 `__engine::*`, `__engine::quarantine::*`, `__system__`, schema 오류 판정과 여분의 정책 match를 모두 배제한다. 빈 계획만으로 정책 trigger가 적용됐다고 간주하지 않으며, 두 일반 spender 경고 사례가 실제 정책 ID로 판정되는지도 검사한다. manifest에 외부 RPC 항목이 없고 기존 approve lowering이 수량을 최소 길이 hex 문자열로 전달하는 것은 코드상 확인했다. 이 연결과 7개 판정의 성공은 **사용자 실행 보고 기준으로 확인했다**. 향후 회귀 시험에서 불일치가 나오면 기대값을 유지하고 최소 입력·코드상 동작·실제 결과·수정 선택지를 정리한다.

`helpers/wasm-worker.mjs`는 선택적 `policyBundle`이 없으면 DEC-01의 기존 입력과 `{ installations, results: [{ id, result }] }` 출력을 유지한다. DEC-02에서만 결과 항목에 `plan`, `evaluation` 응답을 추가한다. DEC-02 구현 당시 `approve.test.mjs`, `approve.cases.json`, `registry-selection.json`, `helpers/build-registry.mjs`는 수정하지 않았다. DEC-03에서는 selection/helper만 위 명시 선택 방식으로 확장하고 두 approve 시험 파일·approve fixture·worker를 그대로 유지한다.

## DEC-03 작성 범위와 실행 기록

**상태: 사용자 실행 보고 기준 검증 완료.** 사용자가 제공한 `npm run decoder:test:transfer`와 `npm run decoder:test`의 전체 결과에서 개별 21개와 통합 58개가 모두 통과했다. 코드 작성 시점의 실행 대기 상태를 이 실제 실행 결과로 갱신한다. 에이전트가 빌드·시험을 독립 실행한 결과는 아니다.

착수 시 읽은 브랜치는 `feat/decoder`, HEAD는 `26df736b4d8f0073cfefccf70f68d3b243b016b5`다. README와 두 계획서에 남아 있던 DEC-02 검증 완료 문서 변경을 보존했다. 이 HEAD는 착수 기록이며 이번 사용자 실행 HEAD로 대체하지 않는다.

| 사용자 실행 명령 | tests | pass | fail | cancelled | skipped | todo | suites | duration_ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `npm run decoder:test:transfer` | 21 | 21 | 0 | 0 | 0 | 0 | 0 | 866.922333 |
| `npm run decoder:test` | 58 | 58 | 0 | 0 | 0 | 0 | 0 | 635.086875 |

| 확인 항목 | 사용자 실행 결과·기록 범위 |
| --- | --- |
| DEC-03 요청·구조 검사 | 정상 7개 + 오류 11개 + 구조 검사 3개, 총 21개 모두 통과 |
| 기존 회귀 시험 | DEC-01 30개 + DEC-02 7개도 이번 통합 실행에서 모두 통과. 과거 37개 통과 기록과 별도 실행 |
| 완료 조건 | 실제 Registry source → strict builder → 8개 callkey·resolved JCS digest → 실제 WASM 설치 → transfer Action·meta·오류 분류 및 approve/transfer 교대 요청 검사 통과 |
| 빌드·산출물 기록 | DEC-03에서 Rust·빌드 입력 변경 없음. 제공된 명령은 준비된 JS/WASM을 사용하는 시험이며 WASM을 빌드하지 않음. 새 WASM 빌드나 JS/WASM hash 재검증을 이번 결과로 주장하지 않음 |
| 미제공 메타데이터 | 실행 HEAD·전후 diff·도구 버전·시작/종료 시각·별도 종료 코드 출력·JS/WASM hash 값은 이번 로그에 미포함. 현재 조회 HEAD나 과거 값을 복사하지 않음 |

이 결과로 DEC-03 완료 조건을 충족했다. 미제공 메타데이터 때문에 검증 완료를 대기로 되돌리거나 재빌드·재시험을 요구하지 않는다. 이 문서·coverage·두 계획서에 같은 사용자 실행 결과를 반영한다.

실제 `standard/erc20/transfer@1.0.0`와 selector `0xa9059cbb`를 approve `0x095ea7b3`와 함께 빌드한다. 네 체인마다 두 selector가 있으므로 정확히 8개 callkey를 요구하고, 각각의 manifest 경로·bundle ID·해소된 bundle의 JCS digest를 검사한 뒤 설치한다. 원본에서 주소 확장용 `match`만 해소되고 ABI·emit 등 나머지 필드가 보존되는지도 비교한다.

정상 7개는 네 체인에서 각각 일반 수량·0·`2^256-1`·혼합 대소문자 요청, zero-address recipient, 정상 인자 뒤 1바이트·32바이트 word다. 오류 11개는 미등록 token·chain·selector, 비정상 calldata hex, 필수 selector 누락, calldata 타입 오류, selector-only·잘린 recipient/amount word, approve/transfer lookup과 calldata selector가 다른 두 방향이다. 정확한 case ID와 기존 시험의 공통 오류 범위는 [coverage](coverage.md)에 구분했다.

기대 Action body는 `domain: "token"`, `action: "erc20_transfer"`, `token.key.standard: "erc20"`, `token.key.chain: "eip155:<chain_id>"`, token contract 주소, recipient, U256 최소 길이 hex 문자열 amount를 비교한다. token contract·recipient·submitter는 서로 다른 주소다. calldata의 첫 ABI 인자 `to`는 recipient이며 요청의 `to`와 구분한다. body 전체 비교와 `spender` 부재 검사를 통해 approve 필드 혼입을 검출한다. 기대 amount를 `BigInt`와 고정 문자열로 검산하며 JS `Number`를 거치거나 decoder 출력으로 기대값을 생성하지 않는다. `is_router_egress: false`는 실제 Rust 직렬화에서 생략되므로 기대 객체에 추가하지 않는다. meta도 전체 비교하며 gas price의 Pyth source는 기존 stub이다.

기존 worker로 두 bundle을 같은 프로세스에 설치한 뒤 transfer → approve → transfer → approve → transfer를 교대로 보낸다. 두 approve 요청은 기존 일반/MAX fixture를 재사용하고 decoder ID와 Action body/meta 전체를 검사한다. approve만 설치한 대조 시나리오는 별도 Node 프로세스에서 transfer miss를 검사한다. 전역 Registry의 자동 초기화를 가정하거나 WASM/ABI를 mock하지 않는다.

현재 순서에서 등록된 조회 selector와 calldata selector의 불일치는 `decode_failed`, 정상 형식의 미등록 조회 selector는 ABI 해석 전에 `no_declarative_v3_mapper`다. selector 문자열 자체의 길이·hex 오류가 miss로 처리될 수 있는 점은 **정적 검토에서 확인한 한계이며 이번 실행으로 재현한 결함이 아니다.** 정상 미지원 사례로 표현하지 않고 [coverage의 판단 항목](coverage.md#selector-문자열-형식-검사의-한계와-판단-항목)에 최소 입력·관련 코드·변경 영향을 남겼다. 이번 fixture는 기존 오류 분류와 trailing-byte 허용을 유지하며 Rust·manifest 수정은 포함하지 않는다.

DEC-03에서는 transfer 정책 평가·typed permit·multicall·Core/API/RPC·서명 검증·소스 이관·CI를 추가하지 않았다. DEC-04a는 아래 별도 단계로 진행하며, 기존 경로/WASM을 이용한 기준 시험은 SDK 전체 소스·빌드 독립화 완료를 뜻하지 않는다.

## DEC-04a 작성 범위와 DEC-04b 경계

착수 시 읽기 전용 Git 조회: 브랜치 `feat/decoder`, HEAD `b10271365ce06a944b5672d833545db42b243881`(DEC-03), 작업 트리 깨끗함. 이는 이번 시험 실행 HEAD가 아니다.

| 단계 | 작성 상태 | 실행 검증 상태 |
| --- | --- | --- |
| DEC-01/02/03 | 기존 구현 유지 | 과거 사용자 통합 58개 통과 기록 유지 |
| DEC-04a | 실제 원본 연결 fixture·시험·최소 helper/worker·명령 작성 | 사용자 실행 기준 47/47 및 당시 통합 105/105 통과 |
| DEC-04b | 합의된 full-input v4 DTO·validator·emit 연결·Rust/Node 회귀 작성 | Native 181개·새 WASM 빌드·Node strict 168개/기존 typed 47개/통합 273개 사용자 통과 |
| DEC-04 전체 | 검증 완료 | 04a/04b 분리 커밋 및 사용자 실행 로그·현재 입력/산출물 hash 일치 확인 |

원본은 `registryV2/manifests/standard/erc20/permit@1.0.0.json`, 바이트 SHA-256은 `0x9e7337ae3ce7e1a80851652e39b2ac4fb264b5e8caf00a4c93193c6b93c76eb3`다. 원본이 직접 선언한 chain `1`, USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, selector `0xd505accf`, typed primary type `Permit`, domain name `USD Coin`, 필드 배열 `owner/address → spender/address → value/uint256 → nonce/uint256 → deadline/uint256`를 그대로 사용한다. 네 체인 token 확장은 approve에만 적용된다.

`buildRegistry(selection, { includePermit: true })`로 **approve + permit**을 선택한다. 기존 반환값에 `permitSource`만 추가하며 transfer는 선택하지 않는다. 기본 `buildRegistry(selection)`은 approve/4 callkey/typed index 없음, `{ includeTransfer: true }`는 approve+transfer/8 callkey/typed index 없음이라는 기존 계약을 유지한다. 통합 명령에서 기존 세 파일은 수정 없이 이 계약을 계속 검사한다.

```text
실제 approve + permit 원본 → 원본 바이트 hash 검사 → 임시 strict Registry build
  → callkey 5개 / typed 1개 / by-selector 0개를 정확히 검사
  → typed index 1__0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48__Permit.json
  → inline bundle 해소 + resolved bundle 전체 JCS digest 확인
  → 실제 WASM 설치 → kind: typed → declarative_route_typed_data_v3_json
  → decoder ID / Action body / offchain_sig meta / error 검사
```

index 개수·inline 형식·JCS 연결 검사는 04a 사용자 실행에서 통과했다. permit은 calldata index도 만들지만 typed 시험의 설치 bundle은 **typed index에서 해소**한다. permit calldata와 typed index의 bundle/digest 일치도 비교하고 inline을 억지로 `3-ref`로 바꾸지 않는다. `permit()` calldata 성공을 typed 서명 경로 검증으로 대체하지 않는다. source hash와 resolved JCS digest는 별개이며 후자의 실행값은 미제공이다.

04a worker는 요청별 `kind: "typed"` 분기를 추가했고, 04b는 별도 `kind: "typed_strict"`를 v4 export에 연결한다. 생략/`"transaction"`은 기존 transaction export로 보내고 DEC-02 `policyBundle` 동작을 보존한다. 설치된/미설치/approve-only 상태는 별도 Node 프로세스로 구분한다. Chrome runtime import·JS 디코더·WASM mock은 없다.

정적 확인에서는 원본 7개 바이트 hash 대조, JSON 파싱·fixture 수량/주소 검산, 수정한 JS 세 파일의 `node --check`, 사용자 명령 블록의 `bash -n`, `git diff --check`를 수행했다. 모두 문제없었다. `--check`/`-n`은 구문 검사만 하므로 fixture·Registry builder·WASM을 실행하지 않는다. 04a 당시 기존 세 시험 파일·fixture, Rust·빌드 입력과 원본 manifest의 Git diff는 없었다. 04b는 Rust 네 파일과 strict 시험을 별도로 추가/수정했다.

새 시험 정의는 요청 44개(정상 5, routing miss 4, DTO 오류 17, emit 오류 11, legacy observation 7)와 구조 검사 3개, 합계 **47개이며 사용자 실행에서 모두 통과**했다. 정상 수량·오류와 관찰 사례의 정확한 ID는 [fixture](typed-permit.cases.json)에 고정한다.

기준 시험은 축약 DTO의 `chain_id`, `verifying_contract`, `primary_type`, `message`, `submitter`, `submitted_at`과 선택적 `domain_name`, `witness_type`을 사용한다. `domain_name`은 Rust `Option<String>`이며 누락/null이 허용된다. 정상 수량 0·1,000,000·uint256 MAX는 고정 문자열과 `BigInt`로 독립 검산한다. token contract·spender·submitter를 구분하고 정확한 body/meta와 기본값 생략 규칙을 검사한다.

`message.nonce`는 원본 서명 요청의 값이며 `Action.body.nonce`와 다르다. 후자는 manifest의 `live_inputs.nonce`를 바탕으로 실행부가 만든 `value: "0x0"`, onchain_view source, TTL 12, 제출 시각의 stub이다. 실제 체인 조회·nonce 유효성 확인을 뜻하지 않는다. Action에 owner가 없다는 점도 owner 검증 완료의 증거가 아니다. owner와 submitter의 동일성 규칙은 추가하지 않는다.

owner/nonce의 누락·형식 오류와 domain name 제약 누락은 정상 EIP-712 사례가 아닌 **현재 축약 경로의 검증 한계 관찰**로 분리한다. 전체 `types`, domain version/salt 검증이 없으므로 “유효한 EIP-712 요청 검증 완료”라고 표시하지 않는다. deadline 범위 초과의 body/meta 불일치는 **정적 검토만** 했고 성공 기대값으로 고정하지 않았다. 최소 입력·소스·영향은 [coverage](coverage.md)의 DEC-04 항목과 설계안에 기록한다.

**04b의 네 계약 항목은 사용자 답변으로 모두 확정했다.**

| 항목 | 확정한 계약 |
| --- | --- |
| 진입점·호환성 | 기존 v3 축약 DTO 유지 + 별도 v4 full-input export 추가 |
| deadline 표현 | 원본 uint256 보존. strict에서는 JS 안전 정수 상한 `9007199254740991` 초과를 명시적 오류로 거절. 기존 Action/meta와 공통 Time 형식 유지 |
| 요청 주체 | `requested_signer`는 서명 대상 지갑. 정규화한 owner와 requested_signer의 일치를 **요청 일관성 조건**으로 검사하고 불일치하면 명시적 오류 반환. submitter는 별도 제출 주체로 보존하며 owner와 달라도 허용해 대리 제출 지원 |
| domain·오류 순서 | 기본 입력 형식·routing/domain 충돌 → lookup → 지원 manifest의 types/domain/message → owner/requested_signer 일관성·deadline 표현 범위 → emit |

각 주소의 원본을 유지하고 정규화 값은 별도로 둔다. 주소 일치 여부와 무관하게 **실제 서명은 미검증 상태**임을 strict 결과에 명시한다. 이는 서명 복구·암호학적 검증을 추가하는 결정이 아니다. manifest가 선언한 name/chain/contract/types를 대조하고 version/salt는 원본 보존과 형식 검사만 수행하며 미선언 기대값을 추가하지 않는다.

미등록 contract와 잘못된 owner가 함께 있으면 **미지원이 우선**이다. 이 결과는 검증 성공이 아니라 **지원 범위 밖이므로 상세 검증하지 않았음**을 뜻한다. 지원하는 Permit은 상세 검증을 모두 수행하고 형식 오류·불일치를 명시적으로 반환한다. strict 실패와 미지원 모두 v3로 자동 재시도하지 않는다. 이 순서와 결과 의미는 04b 계약 및 회귀 시험 항목으로 고정한다.

작성한 strict 회귀에는 owner/requested_signer의 정규화 후 일치·불일치, owner와 다른 submitter 허용, 실제 서명 미검증 표시, 미등록 contract+잘못된 owner의 미지원 우선 및 v3 자동 재시도 부재를 포함한다. 정확한 DTO 보조 필드·오류 코드 이름과 파일 배치는 [상세 설계](../../docs/sdk-migration/decoder-design-plan.md#dec-04--eip-2612와-typed-입력-계약--전체-계획-d2)의 구현안으로 정리한다.

**미응답 계약 질문은 없다.** 04a 결과를 네 문서에 반영하고 04b Rust 실행부와 회귀 시험을 작성했다. 공통 Time과 기존 v3 경로는 유지한다. 04b Native/WASM/Node 검증은 사용자 실행의 저장 로그에서 성공을 확인했다. 정책 판정·암호 검증·Permit2·multicall·Core·어댑터·이관·CI·DEC-05는 이번 범위에 포함하지 않는다.

## DEC-04a 사용자 실행 기록과 04b 구현 상태

04a는 사용자 제공 전체 로그 기준 typed permit **47/47 통과**(`duration_ms=801.277375`), 당시 통합 **105/105 통과**(`duration_ms=690.439291`)다. 두 실행 모두 suites·fail·cancelled·skipped·todo는 0이다. 04a 당시 실행 HEAD·시각·도구 버전·JS/WASM hash·새 빌드 로그는 미제공이며 이전 기록으로 채우지 않는다.

| 사용자 실행 명령 | tests | pass | fail / cancelled / skipped / todo / suites | duration_ms |
| --- | --- | --- | --- | --- |
| `npm run decoder:test:typed-permit` | 47 | 47 | 0 / 0 / 0 / 0 / 0 | 801.277375 |
| 당시 `npm run decoder:test` (기존 네 파일) | 105 | 105 | 0 / 0 / 0 / 0 / 0 | 690.439291 |

04b 재개 시 읽은 Git은 `feat/decoder`, HEAD `b10271365ce06a944b5672d833545db42b243881`이며 04a의 10개 파일이 미커밋 상태였다. 이 착수 조회만으로 위 04a 시험의 실행 HEAD를 확정하지 않는다. 04b 편집 전에 04a 전체 patch를 별도로 보존했으며, 이후 사용자가 04a `593ea16`과 04b `e487805`로 분리 커밋했다.

04b는 `declarative_route_typed_data_v4_json`에 전체 object/JSON string 입력을 전달한다. `request.original`은 원본과 생략 여부, `request.routing`은 정규화 routing, `request.validated`는 주소와 signed nonce/deadline의 decimal 문자열을 보존한다. JSON string 입력은 `original.typed_data_json`에 정확한 문자열도 남기며 이 보조 필드명은 입력 envelope에서 예약한다. `submitter` 생략 시 requested_signer를 사용하되 original의 생략은 유지한다. `submitted_at`은 `0..9007199254740991`의 정수 JSON number다. `typed_data`의 수량 문자열은 decimal/`0x` hex의 온전한 uint256만 받으며 공백·부호·소수·지수 문자열은 거절한다. 직접 JSON의 소수점/지수 number 표기도 정수로 반올림하지 않고 거절한다. 성공 원문에 남는 모든 numeric leaf도 signed 안전 정수 JSON 표기여야 하며, 그 밖의 숫자는 문자열로 전달해야 한다.

지원 범위는 설치된 실제 `standard/erc20/permit@1.0.0`이다. 조회 실패는 `no_typed_data_mapper`, 다른 설치 bundle의 정확한 매칭은 `unsupported_typed_data_contract`이며 모두 상세 검증 미수행이다. 지원 Permit의 선언 types 배열·참조 graph, domain name/chain/contract, 모든 message 필드를 검사한다. version은 문자열, salt는 bytes32이며 실제 기대값을 추가하지 않는다. 선택적 EIP712Domain 선언은 실제 domain 필드·타입과 대조하고 선언 밖 domain/message 필드를 거절한다. Permit에서 사용하지 않는 type 정의는 원문에 보존하며 지원 범위를 확장하지 않는다.

`invalid_typed_data`, `typed_routing_mismatch`, `typed_domain_mismatch`, `typed_requested_signer_mismatch`, `typed_deadline_out_of_range`, `invalid_bundle`, `typed_interpretation_failed`로 입력·일관성·표현·내부 오류를 구분한다. 진단 가능한 필드는 `error.path`의 점 표기로 반환한다. 오류에서는 `data: null`이고 원문을 되돌려주지 않으므로 호출자가 요청을 유지한다. 실제 서명 미검증 표시는 성공의 `request.validation.signature_verification: "not_performed"`다. builder가 만든 body와 meta의 deadline 일치를 검사하며 signed nonce를 nonce LiveField에 덮어쓰지 않는다. 기존 v3로 자동 재시도하지 않는다.

새 Node 회귀는 shared fixture 요청 163개와 구조 검사 5개를 합친 **168개 모두 사용자 실행에서 통과**했다. 기존 네 파일의 105개와 합친 **통합 273개도 모두 통과**했다. Native integration은 같은 요청 fixture와 malformed raw JSON·설치 범위·emit 결함·v3 호환 회귀를 사용한다. 최신 정의 수는 fixture와 시험 파일을 기준으로 한다.

04b 정적 검토: 수정/관련 JS 4개 `node --check`, 설치된 Rust formatter의 새 코드 형식·5개 Rust 파일 구문 확인, 문서 shell 블록 8개 `bash -n`, JSON·고정 수량·주소·원본 7개 hash 대조, 기존 v3 함수의 바이트 동일성 및 04a patch 경계를 확인했다. `git diff --check`와 신규 파일 공백 검사도 문제없다. 이는 구현 당시 에이전트의 정적 검토 기록이다. 에이전트는 Rust 컴파일·Registry/WASM/Node 시험을 직접 실행하지 않았으며, 후속 사용자 실행 로그의 성공은 아래 별도 기록으로 확인했다.

## DEC-04b 실행 기록 — 저장 로그 확인·DEC-04 완료

사용자가 검증 블록을 실행했고 터미널 출력이 남아 있지 않다고 알려, 에이전트가 `/private/tmp/dambi-dec04b-verify.OepBZF/`의 저장 로그를 읽었다(`/tmp` 경로와 동일한 위치). **사용자 실행 로그 기준으로 04a/04b 검증과 DEC-04 완료를 확인했다.** 빌드·시험·설치·Git 변경 명령을 재실행하지 않았다. 과거 DEC-01/02/03 및 04a의 통과 기록·미제공 항목은 그대로 유지하며 이 실행 기록으로 소급 보충하지 않는다.

| 실제 사용자 검증 | 전체 / 통과 | 실패 | 시험 시간 | 근거 파일 |
| --- | --- | --- | --- | --- |
| Native `declarative_v3_typed_data_strict` | 7 / 7 | 0 | 0.05s | `native-strict.log` |
| Native `declarative_v3_typed_data_install` | 7 / 7 | 0 | 0.01s | `native-typed-install.log` |
| Native `declarative_v3_route` | 138 / 138 | 0 | 0.07s | `native-route.log` |
| Native `declarative_exports::tests` | 29 / 29 | 0 | 0.01s | `native-route-helpers.log` |
| `npm run decoder:test:typed-permit-strict` | 168 / 168 | 0 | 943.529416ms | `typed-permit-strict.log` |
| `npm run decoder:test:typed-permit` | 47 / 47 | 0 | 514.873041ms | `typed-permit-v3.log` |
| `npm run decoder:test` | 273 / 273 | 0 | 901.401958ms | `integrated.log` |

Native 합계는 181개다. 각 Native의 ignored/measured는 0이며, helper 명령의 **66개 filtered out**은 지정한 모듈 외 시험을 필터링한 수다. 전체 crate 시험을 모두 실행한 것으로 표현하지 않는다. Node 세 실행은 각각 suites/fail/cancelled/skipped/todo가 모두 0이고 개별 성공 행 수도 요약 집계와 일치한다. Native strict의 shared matrix 시험은 163개 요청을 재생한다.

| 실행 문맥·빌드 근거 | 실제 로그에서 확인한 값 |
| --- | --- |
| 실행 branch·HEAD | `feat/decoder`, 전후 `b10271365ce06a944b5672d833545db42b243881`. **DEC-04 미커밋 변경이 있는 worktree에서 실행**했으며 현재 구현 커밋 `e487805`를 실행 HEAD로 대체하지 않음 |
| 실행 전후 소스 | `source-and-tools.log`의 11개 수정·6개 미추적 파일과 `source-after.log`가 동일. `tracked-before.patch`와 `tracked-after.patch` 바이트 동일 |
| 현재 구현과의 연결 | 로그에 hash를 기록한 입력 24개가 현재 파일 및 `e487805bdb86451a6c9688f7b2dcce399cc13892`의 각 Git blob과 모두 일치. 당시 추적 파일 11개의 patch도 `b102713..e487805`의 해당 경로 diff와 일치 |
| 실제 도구 | Rust/Cargo `1.95.0`, wasm-pack `0.14.0`, Node `v25.9.0`, npm `11.12.1`; `source-and-tools.log`에 상세 버전 기록 |
| 환경·target | `RUSTUP_TOOLCHAIN=1.95.0`, `CARGO_PROFILE_RELEASE_OPT_LEVEL=z`, `CARGO_TARGET_DIR=/tmp/dambi-dec04b-verify.OepBZF/target` |
| Native 시작·종료 코드 | `2026-09-11T10:09:50Z`, `native_exit=0`. Native 종료 시각과 각 시험별 시작/종료 시각은 별도 기록 없음 |
| 직접 WASM 빌드 | `wasm-pack build crates/policy-engine-wasm --target web --release --out-dir pkg --out-name policy_engine_wasm`. `build.log`의 release 컴파일·wasm-opt 최적화·pkg 생성 성공 |
| 빌드 시작/종료·종료 코드 | `2026-09-11T10:10:27Z` → `2026-09-11T10:11:21Z`, `build_exit=0`; wasm-pack 완료 시간 53.63s |
| Node 시작/종료·종료 코드 | `2026-09-11T10:11:21Z` → `2026-09-11T10:11:24Z`, `node_exit=0`. 개별 npm 명령별 timestamp는 기록 없음 |
| 입력·산출물 사후 검사 | `test-inputs-after.log` 24개와 `artifacts-after.log` 2개 모두 OK. 에이전트의 현재 파일 hash 재계산도 모두 일치 |
| 분리 커밋 | 04a `593ea166421b3cff7bdc6f2fa0704143f64bd389`, 04b `e487805bdb86451a6c9688f7b2dcce399cc13892`. 이번 문서 갱신 전 작업 트리는 깨끗함 |

`crates/policy-engine-wasm/pkg/`에 있는 같은 빌드의 산출물 SHA-256은 다음과 같다.

| 파일 | SHA-256 |
| --- | --- |
| `policy_engine_wasm.js` | `628e1a7956b3d82ec203c17af83cb3b06a915d45df070166c6de49a843207043` |
| `policy_engine_wasm_bg.wasm` | `c39531dabb7f6f81b0cfa7b0324f33a2b5e906c569ddc15063ec1d170f6177b9` |

빌드 로그의 wasm-pack 최신 버전 알림과 Cargo description/repository·LICENSE 파일 안내는 빌드를 중단시키지 않았으며 컴파일·시험 오류는 없다. 도구 업데이트나 배포 준비 작업을 이번 범위에 추가하지 않는다. 원본 로그는 위 임시 디렉터리에 남기고 결과·필수 메타데이터를 이 문서와 coverage·두 계획서에 기록한다.

**DEC-04 완료 범위:** 실제 USDC 원본의 v3 기준선, 별도 full-input v4 계약·검증·원문 보존·오류 우선순위와 기존 회귀다. 서명 복구·체인 nonce 검증·정책 판정·SDK 전체 독립화·D2 전체 완료를 뜻하지 않는다. DEC-05로 자동 진행하지 않는다. 이번 갱신은 네 문서만 변경하며 소스·fixture·생성물을 변경하지 않으므로 재시험은 필요하지 않다.

## 남아 있는 임시 경로 의존

이 시험은 최종 SDK 소유 구조나 독립 빌드 완료 증거가 아니다. 아래 경로는 이관 전 기준 시험을 위한 의존이며, 이번에 이동하지 않는다.

| 원본 경로 | 현재 소비 함수/시험 | 향후 대상과 제거 단계 |
| --- | --- | --- |
| `registryV2/manifests/`, `registryV2/tokens/`, `registryV2/scripts/build-index.ts` | `buildRegistry`, `approve.test.mjs`의 실제 주소 확장·index 검사 | Decoder 원본/빌드 소유권은 유지하며, SDK 배포 입력은 D4 고정 snapshot으로 명시. DEC-07 인계 및 C5 독립 빌드에서 경로 목록 확인 |
| `registryV2/node_modules/{tsx,canonicalize}` | 실제 TypeScript builder 실행과 `resolveIndexBundle`의 JCS | 현재 Registry lockfile로 설치. D4/C5에서 SDK 소스·빌드 입력으로 필요한 부분을 명시하고 이전 설치물 재사용 제거 |
| `crates/adapters/mappers/src/declarative/fn_whitelist.json` | 실제 builder가 스크립트 위치 기준으로 읽는 `$fn` 허용 목록. approve가 `$fn`을 쓰지 않아도 파일을 읽음 | SDK 소유 `crates/adapters/mappers/`의 공유 원본으로 포함, DEC-07 인계·C5 독립 소스 빌드에서 검증 |
| `crates/policy-engine-wasm/src/declarative_exports.rs`, `crates/policy-engine-wasm/pkg/` | worker의 install·transaction·typed WASM export와 생성 JS/WASM import | `crates/dambi-core/src/decode/`, `crates/dambi-core-wasm/`, SDK WASM/glue. C2a·C2b 이관 후 C5에 runner/build 경로 교체 |
| `browser-extension/default-bundles/day1-safety/policies/unlimited-approval-deny/` | `approve-policy.test.mjs`가 읽는 실제 Cedar/manifest. 이관 전 기준 시험의 임시 입력 | D3에서 `policy-bundles/day1-safety/` 및 공유 fixture로 이관한 뒤 시험 입력 경로 교체. 최종 SDK 의존 구조가 아님 |
| `crates/policy-engine-wasm/src/action_eval_exports.rs`, `src/dto.rs` | worker가 호출하는 실제 planner/evaluator 및 판정 계약 | C2a·C2b·C5에서 SDK 실행부/WASM 경계로 이관하며 DEC-02 회귀 사례 유지 |
| `crates/adapters/abi-resolver/src/{bridge,decode}.rs`, `crates/adapters/mappers/src/declarative/{args_json,action_builder}.rs` | WASM 내부 ABI 해석·수량 변환·Action 생성 | SDK 소유 decoder 의존으로 재사용. C2a·C2b·C5에서 기존 WASM wrapper에 대한 의존 제거 |
| `crates/policy-server/asset-model/{state,action,transition}/` | 기존 WASM이 사용하는 Action/meta/primitives 직렬화 | `crates/asset-model/{state,action,transition}/`, C2-0a에서 Cargo 경로 이관 |
| 기존 Cargo workspace와 crate 밖 `schema/policy-schema/` | 기존 `policy-engine-wasm`을 소스로 빌드할 때 필요한 간접 의존 | SDK root/API workspace 분리 C2-0b, `crates/policy-engine/schema/policy-schema/` 내재화 C2-0c. C2c·C5에서 독립 빌드 검증 |
| `registry-api/src/server.ts` | inline/`3-ref` 해소 의미를 대조한 원본. 런타임 import는 없음 | DEC-07에 parity 범위 인계. source-context 지원이 필요해질 때 해당 기존 함수와 별도 대조 |

## 사용자가 직접 실행할 준비·빌드·시험 명령

아래 명령은 **사용자가 성공적으로 실행한 검증 절차를 보존한 참고 명령**이다. 에이전트는 실행하지 않았다. 기록 확인을 위해 재실행할 필요는 없다. 04a 개별 47개·당시 통합 105개 통과 기록을 보존한다. **04b는 Rust 변경이 있으므로 Native 회귀 후 새 JS/WASM 쌍을 생성해야 한다.** 기존 pkg로 strict 결과를 검증하지 않는다. Node 시험 내부에서도 실제 Registry builder를 실행한다.

### 준비 — 필요한 항목만

저장소 핀 Rust 1.95.0, CI wasm-pack 0.14.0, Node 20 이상을 사용한다. 실제 도구 버전은 사용자 실행 로그에 따로 기록한다. 이미 준비된 의존성을 다시 설치할 필요는 없다.

```sh
cd /Users/spu/SDKdambi/DAMBI
node --version
npm --version
rustup show active-toolchain
rustc --version --verbose
cargo --version --verbose
wasm-pack --version

# 없는 도구/target만 준비:
rustup toolchain install 1.95.0 --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
cargo +1.95.0 install wasm-pack --version 0.14.0 --locked
# registryV2/node_modules가 없을 때만:
npm ci --prefix registryV2
```

### DEC-04b Native 회귀 → 새 WASM 빌드 → Node 시험

zsh에서도 아래 Bash 블록 전체를 실행할 수 있다. 각 단계가 실패하면 후속 단계와 성공 표식 출력을 중단한다. 새 임시 target/log는 저장소 밖에 만들며 기존 target을 삭제하지 않는다. root release의 LTO/codegen 설정, crate의 wasm-opt 설정과 `CARGO_PROFILE_RELEASE_OPT_LEVEL=z`를 사용한다. `scripts/wasm-build.sh`의 확장 폴더 복사·기존 public WASM 정리는 이 시험에 필요하지 않아 직접 wasm-pack을 호출한다.

```sh
bash <<'DEC04B_VERIFY'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
dec04b_run_dir="$(mktemp -d /tmp/dambi-dec04b-verify.XXXXXX)"
export RUSTUP_TOOLCHAIN=1.95.0
export CARGO_TARGET_DIR="$dec04b_run_dir/target"
export CARGO_PROFILE_RELEASE_OPT_LEVEL=z
printf 'DEC-04b logs and target: %s\n' "$dec04b_run_dir"
{
  date -u '+source_check_utc=%Y-%m-%dT%H:%M:%SZ' || exit $?
  git branch --show-current || exit $?
  git rev-parse HEAD || exit $?
  git status --short --untracked-files=all || exit $?
  rustup show active-toolchain || exit $?
  rustc --version --verbose || exit $?
  cargo --version --verbose || exit $?
  wasm-pack --version || exit $?
  node --version || exit $?
  npm --version || exit $?
  printf 'RUSTUP_TOOLCHAIN=%s\nCARGO_TARGET_DIR=%s\nCARGO_PROFILE_RELEASE_OPT_LEVEL=%s\n' \
    "$RUSTUP_TOOLCHAIN" "$CARGO_TARGET_DIR" "$CARGO_PROFILE_RELEASE_OPT_LEVEL"
} 2>&1 | tee "$dec04b_run_dir/source-and-tools.log"
git diff HEAD -- > "$dec04b_run_dir/tracked-before.patch"
shasum -a 256 \
  crates/policy-engine-wasm/src/{dto,declarative_exports,lib,typed_data_validation}.rs \
  crates/policy-engine-wasm/tests/declarative_v3_typed_data_strict.rs \
  fixtures/decoder-policy/*.mjs fixtures/decoder-policy/*.json \
  fixtures/decoder-policy/helpers/*.mjs package.json Cargo.toml Cargo.lock \
  rust-toolchain.toml crates/policy-engine-wasm/Cargo.toml \
  registryV2/manifests/standard/erc20/permit@1.0.0.json \
  registryV2/manifests/lido/steth/permit@1.0.0.json \
  | tee "$dec04b_run_dir/test-inputs.sha256"

date -u '+native_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee "$dec04b_run_dir/timeline.log"
cargo test --locked -p policy-engine-wasm --test declarative_v3_typed_data_strict \
  2>&1 | tee "$dec04b_run_dir/native-strict.log"
cargo test --locked -p policy-engine-wasm --test declarative_v3_typed_data_install \
  2>&1 | tee "$dec04b_run_dir/native-typed-install.log"
cargo test --locked -p policy-engine-wasm --test declarative_v3_route \
  2>&1 | tee "$dec04b_run_dir/native-route.log"
cargo test --locked -p policy-engine-wasm --lib declarative_exports::tests \
  2>&1 | tee "$dec04b_run_dir/native-route-helpers.log"
printf 'native_exit=0\n' | tee -a "$dec04b_run_dir/timeline.log"

date -u '+build_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec04b_run_dir/timeline.log"
wasm-pack build crates/policy-engine-wasm \
  --target web --release --out-dir pkg --out-name policy_engine_wasm \
  2>&1 | tee "$dec04b_run_dir/build.log"
printf 'build_exit=0\n' | tee -a "$dec04b_run_dir/timeline.log"
date -u '+build_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec04b_run_dir/timeline.log"
shasum -a 256 crates/policy-engine-wasm/pkg/policy_engine_wasm.js \
  crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm \
  | tee "$dec04b_run_dir/artifacts.sha256"

date -u '+node_start_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec04b_run_dir/timeline.log"
npm run decoder:test:typed-permit-strict 2>&1 | tee "$dec04b_run_dir/typed-permit-strict.log"
npm run decoder:test:typed-permit 2>&1 | tee "$dec04b_run_dir/typed-permit-v3.log"
npm run decoder:test 2>&1 | tee "$dec04b_run_dir/integrated.log"
printf 'node_exit=0\n' | tee -a "$dec04b_run_dir/timeline.log"
date -u '+node_end_utc=%Y-%m-%dT%H:%M:%SZ' | tee -a "$dec04b_run_dir/timeline.log"
shasum -a 256 -c "$dec04b_run_dir/artifacts.sha256" | tee "$dec04b_run_dir/artifacts-after.log"
shasum -a 256 -c "$dec04b_run_dir/test-inputs.sha256" | tee "$dec04b_run_dir/test-inputs-after.log"
git diff --check
git rev-parse HEAD | tee "$dec04b_run_dir/head-after.log"
git status --short --untracked-files=all | tee "$dec04b_run_dir/source-after.log"
git diff HEAD -- > "$dec04b_run_dir/tracked-after.patch"
printf 'Review results in %s\n' "$dec04b_run_dir"
DEC04B_VERIFY
```

strict 개별 명령은 `npm run decoder:test:typed-permit-strict`이며 현재 Node 정의는 168개다. `decoder:test`는 approve/approve-policy/transfer/typed-permit 네 파일의 기존 105개를 유지하고 strict 파일을 더해 273개를 정의한다. 이제 저장된 사용자 실행 로그에서 각각 전부 통과한 것을 확인했다. 기존 모든 개별 명령도 유지한다. Native strict integration은 7개 시험 함수 안에서 shared 요청 163개와 추가 raw JSON·내부 결함 사례를 검사한다.

실행 중 source·fixture·정책·pkg를 변경하지 않는다. 입력·산출물 hash와 전후 diff를 함께 검토하며 미추적 source는 hash·Git 상태로도 확인한다. 이번 저장 로그의 실제 결과는 네 문서에 함께 반영했다. 이후 실행 결과도 별도 기록으로 반영한다. 전달되지 않은 hash·실행 HEAD·시각·도구 버전은 과거 값을 복사하지 않는다. 로그와 생성물은 커밋하지 않는다.

## 로컬 커밋과 검증 기록 갱신

04a는 `593ea16`, 04b는 `e487805`로 이미 분리 커밋됐다. 04a 미커밋 변경을 보존했던 patch는 분리 작업의 과거 기록이며 다시 적용하지 않는다. 이번에는 저장 로그를 확인해 **네 문서의 DEC-04 완료 기록만 갱신**했다. 실제 구현·시험 입력은 `e487805`와 같고 생성물은 변경/추적하지 않는다. 문서는 이미 Git 추적 중이므로 `*.md` ignore에 대한 강제 추가도 필요하지 않다.

아래는 사용자용 문서 커밋 명령이며 에이전트는 실행하지 않는다. 별도 commit으로 기록하여 기존 04a/04b 경계를 보존한다.

```sh
bash <<'DEC04_RECORD_COMMIT'
set -euo pipefail
cd /Users/spu/SDKdambi/DAMBI
git diff --cached --quiet
dec04_record_files=(
  docs/sdk-migration/decoder-design-plan.md
  docs/sdk-migration/decoder-core-adapters-plan.md
  fixtures/decoder-policy/README.md
  fixtures/decoder-policy/coverage.md
)
git diff --check
git diff -- "${dec04_record_files[@]}"
git add -- "${dec04_record_files[@]}"
diff -u <(printf '%s\n' "${dec04_record_files[@]}" | LC_ALL=C sort) \
  <(git diff --cached --name-only | LC_ALL=C sort)
git diff --cached --check
git diff --cached --stat
git commit -m "docs(decoder): record DEC-04 verification completion"
git status --short --untracked-files=all
DEC04_RECORD_COMMIT
```

push와 DEC-05 진행은 포함하지 않는다. 코드·시험을 바꾸지 않은 이번 기록 갱신 때문에 검증 절차를 다시 실행할 필요는 없다.
