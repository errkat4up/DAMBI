# Changelog

All notable changes to `@dambi/core` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). While the major version is 0, minor bumps may
break the public interface and will say so under **Changed**/**Removed** with a
migration note.

## [Unreleased]

### Changed
- Module format is **ESM only**, by decision (2026-10-05): no CommonJS build will
  ship. The WASM loader locates its binary via `import.meta.url`, which has no
  CommonJS equivalent, and v0.1 targets browser wallets and ESM Node (>= 20).
  `require("@dambi/core")` is unsupported; CommonJS hosts use `await import()`.
- C1 public contract: `await createCore(config, options?)`, policy/Fact I/O ports,
  fixed Decoder snapshot and local trust/limits configuration. `clock` moves from
  `ports` to `CoreConfig`. `createCore` no longer rejects with `NOT_IMPLEMENTED`.
- `plan(request)` issues an opaque `CorePlan`; `evaluate(plan, FactBatch)` replaces
  caller-supplied request/policy evaluation. Fact batches carry the plan ID and
  method responses before projection, with required provenance.
- Policy payload is the original signed string. Response key IDs remain telemetry.
- Verdicts/hooks expose typed diagnostics and available/unavailable audit metadata.

### Added
- Rust/WASM runtime: `createCore`, `plan`, `evaluate`, `check`, `refreshPolicies`
  and `dispose` execute. The WASM ships in `dist/runtime/wasm` and is located via
  `import.meta.url`.
- `check()` Fact coordination with a bounded in-memory cache, and notification
  hooks (`onPending`, `onVerdict`, `onAwaitingUser`, `onDiagnostic`).
- Signed policy bundle verification (ECDSA P-256/SHA-256 over the original
  payload), sequence ordering and a 72-hour default `maxBundleAgeSec`.
- `@dambi/core/decoders`: a Registry decoder snapshot (799 bundles, ~2.5 MB)
  with its pinned digest and size, as a separate entry point.
- Audit metadata (`requestDigest`, `policyVersion`, `engineVersion`) on verdicts.
- Cancellation, policy refresh and disposal contracts; stable error code types.
- README guide for connecting to the Dambi API and for Vite dev-server use.
- Consumer declaration checks and Native/WASM runtime regression tests in CI.

### Removed
- Public `DecoderSource`, `PolicySet` and `FactMap`. See README for migration.

## [0.0.1] - 2026-09-07

Scaffold release. Exercises the publish path; nothing evaluates.

### Added
- Public type contract: `CoreConfig`, `Ports`, `CoreHooks`, `DambiCore`,
  `CheckRequest`, `UnsupportedRequest`, `Verdict`, `MatchedPolicy`,
  `PlannedCall`, `PolicySet`, `FactMap`, `PolicySource`, `SignedPolicyBundle`,
  `FactProvider`, `FactResult`, `DecoderSource`, `Clock`.
- `createCore()` entry point. **Throws `NOT_IMPLEMENTED` on every call** in this
  release so an empty bundle cannot ship silently.
- `@dambi/core/internal` entry point, intentionally empty.
- ESM build with `.d.ts` and declaration maps. Node >= 20.
