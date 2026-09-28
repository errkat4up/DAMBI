#!/usr/bin/env bash
# Run the full test suite — SDK/server Rust workspaces + browser-extension when present.
set -euo pipefail

cd "$(dirname "$0")/.."

for manifest in Cargo.toml crates/policy-server/Cargo.toml; do
  echo "==> cargo test ($manifest)"
  cargo test --manifest-path "$manifest" --locked --workspace --all-targets

  echo "==> cargo clippy ($manifest)"
  cargo clippy --manifest-path "$manifest" --locked --workspace --all-targets -- -D warnings

  echo "==> cargo fmt ($manifest)"
  cargo fmt --manifest-path "$manifest" --all -- --check
done

if [ -d browser-extension ] && [ -f browser-extension/package.json ]; then
  echo "==> yarn typecheck (browser-extension)"
  (cd browser-extension && yarn typecheck)

  if grep -q '"test"' browser-extension/package.json; then
    echo "==> yarn test (browser-extension)"
    (cd browser-extension && yarn test --run 2>/dev/null || yarn test)
  fi

  echo "==> yarn build:chrome (browser-extension)"
  # Local "does it all compile" gate — NOT a user-distributed build, so it is
  # allowed to build against an unsigned registry (DAMBI_ALLOW_UNSIGNED_REGISTRY=1
  # waives the prod signature-enforcement guard in webpack.prod.js).
  (cd browser-extension && DAMBI_ALLOW_UNSIGNED_REGISTRY=1 yarn build:chrome >/dev/null)
fi

echo "==> all checks passed"
