# Native Core regression inputs

These are fixed test inputs, included inside the crate; tests never load app seeds.

- `erc20-permit.manifest.json`: unchanged `registryV2/manifests/standard/erc20/permit@1.0.0.json`.
- `typed-permit-numeric-request.json`: `fixtures/decoder-policy/typed-permit-strict.cases.json` request defaults for Rust numeric-token regressions.
- `policy-bundle/day1.envelope.json`: unchanged `contracts/core-v1/examples/day1.envelope.json`, used for parsing regressions.
- `policies/default/`: the six policies consumed by the HL tests, copied verbatim from `crates/policy-engine/tests/fixtures/default_policies_v2/`.
- `policies/phase1-market.json` and `policies/dashboard-phase1a.json`: only the used `hl-corewriter-no-short-perp` and `hl-confirm-approve-agent` entries from the server's `phase1-seed.json` and dashboard's `phase1A-seed.json`, respectively. Their Cedar and manifests are preserved; these tests do not track later app seed edits.

All expectations stay in the migrated tests. Missing inputs fail instead of skipping.
