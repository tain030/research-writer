#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check

if command -v cc >/dev/null 2>&1 \
    || command -v clang >/dev/null 2>&1 \
    || command -v gcc >/dev/null 2>&1 \
    || command -v cl.exe >/dev/null 2>&1; then
    cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
    cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
elif command -v docker >/dev/null 2>&1; then
    printf '%s\n' "호스트 링커가 없어 Docker에서 Rust 검증을 계속합니다."
    "$ROOT/scripts/test-linux-container.sh" --rust-only
else
    printf '%s\n' "오류: Rust 검증에 필요한 C 링커 또는 Docker가 없습니다." >&2
    exit 1
fi
