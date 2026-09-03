# Phase 0 findings

## F-001 — alias resolution needs the extension webpack aliases

`browser-extension/tsconfig.json` declares `@lib/*` and `@background/*`, but
the dependency graph is complete only when dependency-cruiser also consumes
`browser-extension/webpack/webpack.common.js`.  With that configuration there
are no unresolved alias imports.  The remaining unresolved edge is
`backend/wasm/policy_engine_wasm`, a generated build output imported by
`wasm-bridge.ts`; it is an expected generated-artifact boundary, not an alias
failure.

## F-002 — production build has an intentional registry gate

`yarn build:chrome` requires `REGISTRY_BASE_URL` and production signing
configuration.  The baseline used the explicitly non-distributable local smoke
mode `DAMBI_ALLOW_INSECURE_REGISTRY=1`; no placeholder production value was
introduced.  The normal baseline build also generated the WASM artifact.

## F-003 — current WASM exceeds the stated 1.5 MB gzip budget

The generated `policy_engine_wasm_bg.wasm` is 8,057,968 bytes raw and 2,495,488
bytes gzip.  That is 995,488 bytes (about 66.4%) above a 1,500,000-byte gzip
budget.  This is a measurement and an approval decision for Phase 3, not a
request to optimize or alter the engine in Phase 0.

## F-004 — two different security invariants use the label N2

The signature verifier's N2 pins the verification algorithm and public key.
The declarative engine's N2 warn-closes an empty multicall.  They have distinct
scope and were documented separately in `docs/security-invariants.md` so a
mechanical move cannot accidentally conflate them.

## F-005 — pre-existing user worktree change preserved

`browser-extension/default-bundles/day1-safety/package.json` was already
modified before Phase 0.  It was not changed, staged, or used as a migration
edit.

## F-006 — private policy-ir dependency includes executable code

The existing graph shows that `policy-store/render.ts:4-5` imports the runtime
functions `blocksToEst` and `fillParams`, in addition to its IR/store types.
`policy-store/resolve.ts:10` also imports executable `isEffectiveOn` and
`missingRequiredHoles` through the types barrel; their definitions are at
`sdk/policy-store-types.ts:169` and `:176`.

Moving only shared types into core does not remove core's runtime edge to the
planned private policy-ir package.  The current IR graph has no reverse edge
to core/backend.  Reversing type ownership without addressing these functions
would leave dependencies in both directions.  Publishing policy-ir, inlining
it at build time (including declaration files), or changing the rendering
boundary requires an explicit decision.  No such change has been implemented.

There is also an existing authoring-WASM dependency:
`policy-store/render.ts:6` calls `wasm-bridge.estToPolicyText`.  The planned
runtime/authoring WASM split must account for this path; moving TypeScript
types alone does not isolate the runtime WASM artifact.
