#!/bin/sh
set -eu

DEFAULT_DEPLOY_HOST="tain@100.84.5.117"
DEFAULT_DEPLOY_ROOT="/home/tain/research-writer"
DEFAULT_DEPLOY_BRANCH="main"
CANONICAL_FETCH_URL="https://github.com/tain030/research-writer.git"
DISABLED_PUSH_URL="disabled://read-only-server"
VALIDATION_TIMEOUT_SECONDS=1800

usage() {
    cat <<'EOF'
사용법: _deploy/deploy-to-server.sh [--dry-run]

환경변수:
  DEPLOY_HOST    SSH 대상 (기본값: tain@100.84.5.117)
  DEPLOY_ROOT    서버 저장소 경로 (기본값: /home/tain/research-writer)
  DEPLOY_BRANCH  배포 브랜치 (기본값: main)
EOF
}

die() {
    printf '%s\n' "오류: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "$1 명령이 없습니다."
}

repository_is_clean() {
    [ -z "$(git status --porcelain=v1 --untracked-files=all)" ]
}

checkout_role() {
    git config --local --get researchwriter.role 2>/dev/null || true
}

validate_local_settings() {
    case "$DEPLOY_HOST" in
        ''|*[!A-Za-z0-9_.:@-]*) die "DEPLOY_HOST에 허용되지 않은 문자가 있습니다." ;;
    esac
    case "$DEPLOY_ROOT" in
        /*) ;;
        *) die "DEPLOY_ROOT는 절대경로여야 합니다." ;;
    esac
    case "$DEPLOY_ROOT" in
        /|*[!A-Za-z0-9_./-]*) die "DEPLOY_ROOT가 안전한 저장소 경로가 아닙니다." ;;
    esac
    case "$DEPLOY_BRANCH" in
        ''|*[!A-Za-z0-9_./-]*) die "DEPLOY_BRANCH가 올바르지 않습니다." ;;
    esac
}

validate_remote_arguments() {
    root=$1
    branch=$2
    target=$3
    case "$root" in
        /*) ;;
        *) die "서버 저장소 경로는 절대경로여야 합니다." ;;
    esac
    case "$root" in
        /|*[!A-Za-z0-9_./-]*) die "서버 저장소 경로가 안전하지 않습니다." ;;
    esac
    case "$branch" in
        ''|*[!A-Za-z0-9_./-]*) die "서버 배포 브랜치가 올바르지 않습니다." ;;
    esac
    case "$target" in
        ''|*[!0-9a-f]*) die "배포 커밋이 올바르지 않습니다." ;;
    esac
    [ "${#target}" -eq 40 ] || die "배포 커밋은 40자리 SHA여야 합니다."
}

assert_server_remote_is_read_only() {
    fetch_url=$(git remote get-url origin 2>/dev/null || true)
    push_url=$(git remote get-url --push origin 2>/dev/null || true)
    [ "$fetch_url" = "$CANONICAL_FETCH_URL" ] || die "서버 origin fetch URL이 고정된 공개 원격과 다릅니다: $fetch_url"
    [ "$push_url" = "$DISABLED_PUSH_URL" ] || die "서버 origin push가 차단되어 있지 않습니다: $push_url"
}

remote_preflight() {
    require_command docker
    require_command flock
    require_command git
    require_command timeout
    [ -d "$DEPLOY_ROOT/.git" ] || die "서버 저장소를 찾을 수 없습니다: $DEPLOY_ROOT"

    cd "$DEPLOY_ROOT"
    [ "$(checkout_role)" = "server" ] || die "서버 체크아웃 역할이 server가 아닙니다."
    current_branch=$(git symbolic-ref --quiet --short HEAD) || die "서버가 브랜치 checkout 상태가 아닙니다."
    [ "$current_branch" = "$DEPLOY_BRANCH" ] || die "서버 브랜치가 $DEPLOY_BRANCH가 아닙니다: $current_branch"
    repository_is_clean || die "서버 작업 트리에 커밋되지 않은 변경이 있습니다."
    assert_server_remote_is_read_only

    git fetch --quiet origin "$DEPLOY_BRANCH"
    fetched_commit=$(git rev-parse "origin/$DEPLOY_BRANCH^{commit}")
    [ "$fetched_commit" = "$TARGET_COMMIT" ] || die "노트북이 확인한 커밋과 서버 원격 커밋이 다릅니다."
    OLD_COMMIT=$(git rev-parse HEAD)
    git merge-base --is-ancestor "$OLD_COMMIT" "$TARGET_COMMIT" || die "서버 브랜치를 fast-forward할 수 없습니다."
}

rollback_code() {
    failed_commit=$(git rev-parse HEAD)
    printf '%s\n' "검증 실패: $failed_commit 에서 $OLD_COMMIT 으로 롤백합니다." >&2
    git restore --source="$OLD_COMMIT" --staged --worktree -- .
    if [ "$failed_commit" != "$OLD_COMMIT" ]; then
        git update-ref -m 'rollback failed server validation' "refs/heads/$DEPLOY_BRANCH" "$OLD_COMMIT" "$failed_commit"
    fi
    repository_is_clean
}

deployment_cleanup() {
    status=$1
    trap - EXIT HUP INT TERM
    if [ "$status" -ne 0 ] && [ "${TRANSACTION_STARTED:-0}" -eq 1 ]; then
        set +e
        rollback_code
        rollback_status=$?
        set -e
        if [ "$rollback_status" -eq 0 ]; then
            printf '%s\n' "이전 서버 커밋을 복구했습니다." >&2
        else
            printf '%s\n' "치명적 오류: tracked 파일은 복구했지만 작업 트리가 깨끗하지 않습니다." >&2
        fi
    fi
    exit "$status"
}

run_remote() {
    mode=$1
    DEPLOY_ROOT=$2
    DEPLOY_BRANCH=$3
    TARGET_COMMIT=$4
    export DEPLOY_ROOT DEPLOY_BRANCH
    validate_remote_arguments "$DEPLOY_ROOT" "$DEPLOY_BRANCH" "$TARGET_COMMIT"

    state_dir="$HOME/.local/state/research-writer"
    mkdir -p "$state_dir"
    chmod 700 "$state_dir"
    exec 9>"$state_dir/deploy.lock"
    flock -n 9 || die "다른 Research Writer 서버 동기화가 이미 실행 중입니다."

    remote_preflight
    if [ "$mode" = "--remote-check" ]; then
        printf '%s\n' "서버 동기화 사전점검 완료: current=$OLD_COMMIT target=$TARGET_COMMIT"
        return
    fi

    TRANSACTION_STARTED=1
    export OLD_COMMIT
    trap 'deployment_cleanup $?' EXIT
    trap 'deployment_cleanup 129' HUP
    trap 'deployment_cleanup 130' INT
    trap 'deployment_cleanup 143' TERM

    if [ "$OLD_COMMIT" != "$TARGET_COMMIT" ]; then
        git merge --ff-only "$TARGET_COMMIT"
    fi
    [ -x "$DEPLOY_ROOT/scripts/test-linux-container.sh" ] || die "서버 전체 검증 스크립트를 실행할 수 없습니다."
    timeout "$VALIDATION_TIMEOUT_SECONDS" "$DEPLOY_ROOT/scripts/test-linux-container.sh"
    repository_is_clean || die "서버 검증이 tracked 또는 untracked 파일을 남겼습니다."

    TRANSACTION_STARTED=0
    trap - EXIT HUP INT TERM
    printf '%s\n' "서버 검증 미러 동기화 완료: commit=$TARGET_COMMIT"
}

send_remote_script() {
    remote_mode=$1
    remote_command="sh -s -- $remote_mode $DEPLOY_ROOT $DEPLOY_BRANCH $TARGET_COMMIT"
    ssh "$DEPLOY_HOST" "$remote_command" < "$SCRIPT_PATH"
}

run_local() {
    remote_mode=$1
    require_command git
    require_command ssh
    validate_local_settings

    ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")/.." && pwd)
    cd "$ROOT"
    [ "$(checkout_role)" = "developer" ] || die "노트북 체크아웃 역할이 developer가 아닙니다."
    repository_is_clean || die "노트북 작업 트리에 커밋되지 않은 변경이 있습니다."
    current_branch=$(git symbolic-ref --quiet --short HEAD) || die "노트북이 브랜치 checkout 상태가 아닙니다."
    [ "$current_branch" = "$DEPLOY_BRANCH" ] || die "현재 브랜치가 $DEPLOY_BRANCH가 아닙니다: $current_branch"
    [ "$(git remote get-url --push origin 2>/dev/null || true)" != "$DISABLED_PUSH_URL" ] || die "developer 체크아웃의 push URL이 차단되어 있습니다."

    git fetch --quiet origin "$DEPLOY_BRANCH"
    TARGET_COMMIT=$(git rev-parse "origin/$DEPLOY_BRANCH^{commit}")
    local_commit=$(git rev-parse HEAD)
    [ "$local_commit" = "$TARGET_COMMIT" ] || die "노트북 HEAD가 origin/$DEPLOY_BRANCH와 일치하지 않습니다. 먼저 push하세요."

    printf '%s\n' "서버 동기화 시작: host=$DEPLOY_HOST commit=$TARGET_COMMIT"
    send_remote_script "$remote_mode"
}

SCRIPT_PATH=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
DEPLOY_HOST=${DEPLOY_HOST:-$DEFAULT_DEPLOY_HOST}
DEPLOY_ROOT=${DEPLOY_ROOT:-$DEFAULT_DEPLOY_ROOT}
DEPLOY_BRANCH=${DEPLOY_BRANCH:-$DEFAULT_DEPLOY_BRANCH}

case "${1:-}" in
    '')
        run_local --remote-deploy
        ;;
    --dry-run)
        run_local --remote-check
        ;;
    --remote-check|--remote-deploy)
        [ "$#" -eq 4 ] || die "내부 원격 실행 인자가 올바르지 않습니다."
        run_remote "$1" "$2" "$3" "$4"
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
