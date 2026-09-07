# Changelog

All notable changes to `@dambi/core` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). While the major version is 0, minor bumps may
break the public interface and will say so under **Changed**/**Removed** with a
migration note.

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
