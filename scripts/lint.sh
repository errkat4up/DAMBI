#!/usr/bin/env bash
# Fix-all-the-things: cargo fmt + clippy + yarn lint where applicable.
set -euo pipefail

cd "$(dirname "$0")/.."

for manifest in Cargo.toml crates/policy-server/Cargo.toml; do
  echo "==> cargo fmt ($manifest)"
  cargo fmt --manifest-path "$manifest" --all

  echo "==> cargo clippy --fix ($manifest)"
  cargo clippy --manifest-path "$manifest" --locked --workspace --all-targets --fix --allow-dirty --allow-staged
done

if [ -f browser-extension/package.json ]; then
  (cd browser-extension && yarn lint || true)
fi

echo "==> done"
