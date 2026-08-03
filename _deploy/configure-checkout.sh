#!/bin/sh
set -eu

CANONICAL_FETCH_URL="https://github.com/tain030/research-writer.git"
DISABLED_PUSH_URL="disabled://read-only-server"

usage() {
    cat <<'EOF'
사용법: _deploy/configure-checkout.sh developer|server

developer  노트북의 쓰기 가능한 개발 체크아웃으로 설정
server     서버의 읽기 전용 검증 미러로 설정
EOF
}

die() {
    printf '%s\n' "오류: $*" >&2
    exit 1
}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

git rev-parse --show-toplevel >/dev/null 2>&1 || die "Git 저장소가 아닙니다: $ROOT"
[ "$(git rev-parse --show-toplevel)" = "$ROOT" ] || die "저장소 루트에서 실행해야 합니다."
git remote get-url origin >/dev/null 2>&1 || die "origin 원격이 없습니다."

case "${1:-}" in
    developer)
        fetch_url=$(git remote get-url origin)
        git remote set-url --push origin "$fetch_url"
        git config --local researchwriter.role developer
        printf '%s\n' "개발 체크아웃 설정 완료: role=developer push=$(git remote get-url --push origin)"
        ;;
    server)
        [ -z "$(git status --porcelain=v1 --untracked-files=all)" ] || die "서버 역할 전환 전에 작업 트리를 깨끗하게 정리하세요."
        branch=$(git symbolic-ref --quiet --short HEAD) || die "브랜치 checkout 상태가 아닙니다."
        [ "$branch" = "main" ] || die "서버 검증 미러는 main 브랜치여야 합니다: $branch"
        git remote set-url origin "$CANONICAL_FETCH_URL"
        git remote set-url --push origin "$DISABLED_PUSH_URL"
        git config --local researchwriter.role server
        printf '%s\n' "서버 체크아웃 설정 완료: role=server fetch=$CANONICAL_FETCH_URL push=$DISABLED_PUSH_URL"
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
