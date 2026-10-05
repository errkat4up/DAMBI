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
  `ports` to `CoreConfig`. Initialization still rejects with `CoreError` code
  `NOT_IMPLEMENTED`; no evaluation runtime is included.
- `plan(request)` issues an opaque `CorePlan`; `evaluate(plan, FactBatch)` replaces
  caller-supplied request/policy evaluation. Fact batches carry the plan ID and
  method responses before projection, with required provenance.
- Policy payload is the original signed string. Response key IDs remain telemetry.
- Verdicts/hooks expose typed diagnostics and available/unavailable audit metadata.

### Added
- Cancellation, policy refresh and disposal contracts; stable error code types.
- Consumer declaration checks and an asynchronous scaffold check in CI.

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
