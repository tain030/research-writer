#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="research-writer-linux-ci:1.97.1"

docker build \
  --file "${project_dir}/docker/Dockerfile.linux-ci" \
  --tag "${image}" \
  "${project_dir}"

docker run --rm \
  --volume research-writer-node-modules:/workspace/node_modules \
  --volume research-writer-pnpm-store:/pnpm/store \
  --volume research-writer-cargo-registry:/usr/local/cargo/registry \
  --volume research-writer-cargo-git:/usr/local/cargo/git \
  --volume research-writer-target:/workspace/src-tauri/target \
  --env CI=true \
  --env PNPM_HOME=/pnpm \
  --env PNPM_STORE_DIR=/pnpm/store \
  "${image}" \
  sh -c '
    set -eu
    pnpm install --frozen-lockfile
    pnpm check
    pnpm test
    pnpm build
    cargo fmt --manifest-path src-tauri/Cargo.toml --check
    cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
  '
