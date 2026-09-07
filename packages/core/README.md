# @dambi/core

Pre-sign policy core for Web3 wallets. The host (a wallet, a browser extension, a
MetaMask Snap) hands the core a pending request, the core plans which facts it
needs, asks the host's ports for them, and returns a three-state `Verdict`.

## Status: 0.0.1 is a scaffold

This release publishes the **public type contract only**. It exists so the
install path, versioning, and CI are exercised before the implementation lands.

- `createCore()` **throws** `NOT_IMPLEMENTED` on every call. Nothing evaluates yet.
- Every exported type is real and is the contract the 0.1.0 implementation will
  satisfy. Interface changes are still expected before 0.1.0 and will be listed
  in [CHANGELOG.md](./CHANGELOG.md).
- ESM only. Node >= 20. No runtime dependencies. No network access from the core
  (facts and policies arrive through ports the host implements).

Do not integrate against 0.0.1. Pin `0.1.x` once it ships.

## Install

```sh
npm i @dambi/core
```

## Surface

```ts
import { createCore } from "@dambi/core";
import type {
  CoreConfig, DambiCore, Ports, CoreHooks,
  CheckRequest, UnsupportedRequest, Verdict, MatchedPolicy,
  PlannedCall, PolicySet, FactMap,
  PolicySource, SignedPolicyBundle, FactProvider, FactResult, DecoderSource, Clock,
} from "@dambi/core";
```

- `createCore(config)` returns a `DambiCore` with `check()`, `plan()`, `evaluate()`.
- `Ports` is what the core **asks**: `PolicySource`, `FactProvider`, `DecoderSource`, optional `Clock`.
- `CoreHooks` is what the core **tells**: `onPending`, `onVerdict`, `onAwaitingUser`, `onDiagnostic`. Storage is the host's job, inside hooks.
- `CoreConfig.enforcement` is required: `"advisory"` for proxy deployments, `"enforcing"` for wallet integrations.

`@dambi/core/internal` is reserved for the policy-authoring surface and is empty.

## Coverage

None in 0.0.1. The 0.1.0 README will state measured protocol and policy coverage.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
