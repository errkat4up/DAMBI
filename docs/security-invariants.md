# Security invariants

This document records security properties that must remain true while DAMBI is
split into a browser-free SDK and extension hosts.  The listed enforcement
points are the authority; moving code must preserve the property, not merely
the current module boundary.

## Signed policy bundles

**Guarantee.** When bundle signing is required, a policy bundle is accepted
only if a detached signature validates for the canonical bytes that were
actually parsed, using the build-time pinned ECDSA key and SHA-256.

**Violation.** A registry response could otherwise substitute a bundle,
provide a self-asserted hash for different bytes, or select a weaker algorithm
or attacker-controlled key.

**Enforcement.** `browser-extension/backend/service-worker/adapter-loader/bundle-verify.ts:129`
canonicalizes and hashes parsed bytes, `:145` rejects a claimed-hash mismatch,
and `:151` fetches the signature by the recomputed hash (N4).  At `:200`,
verification pins both `ECDSA/SHA-256` and the build-time key (N2); response
metadata such as `alg` and `key_id` is deliberately not trusted.

The **N2** label here is specific to signature-algorithm/key pinning.  It is
not the N2 label in `crates/policy-engine-wasm/src/declarative_exports.rs:1023`,
where the label denotes an empty multicall that must warn-close.  The local
labels happen to collide; their semantics must not be merged during the SDK
move.

## Authentic verdict channel

**Guarantee.** A page cannot replace the MessagePort used to deliver extension
verdicts after the genuine isolated-world port has initialized it.

**Violation.** A page-supplied port could impersonate the extension and inject
or suppress a verdict response.

**Enforcement.** `browser-extension/backend/lib/verdict-channel.ts:85` applies
first-init-wins, requires a same-window event at `:90`, validates the init key
at `:92`, and captures only the transferred port at `:93-97`.

## Action-plan completeness and fail-closed evaluation

**Guarantee.** Required enrichment RPC calls are derived only from each valid,
matching policy bundle.  A required result that is absent becomes a
fail-closed `__system__` verdict.

**Violation.** A host-controlled plan could omit a policy-required RPC call and
make a policy evaluate against incomplete context, potentially allowing an
action that should have failed.

**Enforcement.** The boundary contract is documented and implemented from
`crates/policy-engine-wasm/src/action_eval_exports.rs:24-38`: planning uses the
inline bundles' valid matching manifests, materializes per bundle, and turns a
missing required result into `PolicyRpcError::SystemFail`.

## Bypass-message provenance

**Guarantee.** Observe-only wallet bypass rows originate only from this frame's
own window; cross-frame messages cannot inject them.

**Violation.** A foreign frame could post a forged wallet relay message and
create misleading bypass state.

**Enforcement.** Both listeners in
`browser-extension/backend/content-scripts/bypass-check.ts:84-108` reject an
event unless `event.source === window` (N7).  The accepted same-page residual
is explicitly limited to observe-only rows and never gates a verdict.

## Production distribution requires signing

**Guarantee.** A distributable production extension cannot be built without
enforcing policy-bundle signatures and providing the pinned public key.

**Violation.** A production build could silently ship with the registry
integrity check disabled.

**Enforcement.** `browser-extension/webpack/env.js:84-109` fails the build
unless `DAMBI_REQUIRE_BUNDLE_SIGNATURE=true` is supplied.  The only bypasses
are literal, explicit local/staging smoke-build opt-outs
(`DAMBI_ALLOW_UNSIGNED_REGISTRY=1` or `DAMBI_ALLOW_INSECURE_REGISTRY=1`), which
must never be used for distribution.

## Migration rule

Core may receive policy bytes and injected platform capabilities, but it must
not weaken any of the properties above.  Browser transport, storage, UI
messaging, registry retrieval, and production-build environment checks remain
host responsibilities unless an equivalent platform-neutral boundary is
documented and tested first.
