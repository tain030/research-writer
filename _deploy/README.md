# 노트북 개발·서버 검증 Runbook

## 운영 경계

- Research Writer는 노트북에서 실행되는 데스크톱 앱이며 서버 상시 프로세스가 없다.
- 소스 코드의 단일 기준은 GitHub `main`이다. 노트북만 수정·commit·push·tag를 수행한다.
- `/home/tain/research-writer`는 읽기 전용 서버 검증 미러다. 서버 origin은 fetch만 가능하고 push URL은 차단한다.
- Syncthing은 원고 같은 사용자 데이터용이다. 소스 코드, `node_modules`, 빌드 결과는 Syncthing으로 복사하지 않는다.

## 노트북 최초 설정

기존 Research Agent 배포와 같은 Tailscale·SSH 연결을 사용한다.

```sh
gh auth login
gh repo clone tain030/research-writer
cd research-writer
_deploy/configure-checkout.sh developer
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm server:check
```

`pnpm server:check`가 SSH 연결 또는 서버 역할 오류를 보고하면 실제 동기화를 실행하지 말고 먼저 원인을 해결한다.

## 평상시 코드 변경

```sh
pnpm verify
git add -A
git commit
git push origin main
pnpm server:check
pnpm server:sync
```

서버 동기화는 다음 조건을 모두 만족해야 시작한다.

- 노트북 역할이 `developer`이고 서버 역할이 `server`
- 양쪽이 clean한 `main` 브랜치
- 노트북 HEAD와 `origin/main`이 동일
- 서버 HEAD에서 대상 커밋으로 fast-forward 가능
- 서버 origin fetch는 공식 GitHub 주소이고 push는 `disabled://read-only-server`

실제 동기화는 서버 잠금을 잡고 `main`을 fast-forward한 뒤 `scripts/test-linux-container.sh`로 전체 프런트엔드·Rust 회귀 검사를 수행한다. 실패하면 서버 브랜치와 tracked 파일을 이전 커밋으로 돌린다. 예상하지 못한 untracked 파일이 남은 경우에는 자동 삭제하지 않고 오류로 중단한다.

다른 서버를 대상으로 할 때만 다음 값을 명시적으로 재정의한다.

```sh
DEPLOY_HOST=user@tailscale-host \
DEPLOY_ROOT=/absolute/repository/path \
DEPLOY_BRANCH=main \
pnpm server:check
```

## 릴리스

서버 동기화와 GitHub `main` CI가 성공한 뒤 노트북에서만 버전과 태그를 만든다.

```sh
pnpm release:version 0.8.0
pnpm verify
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v0.8.0"
git push origin main
pnpm server:sync
git tag -a v0.8.0 -m "Research Writer v0.8.0"
git push origin v0.8.0
```

GitHub Actions가 각 운영체제 패키지와 `SHA256SUMS`를 만든다. 서버는 태그나 Release를 만들지 않는다.

## 점검과 복구

```sh
git config --local --get researchwriter.role
git remote -v
git status --short --branch
pnpm server:check
```

서버 검사 실패 시 스크립트가 출력한 이전·실패 커밋을 확인한다. 자동 롤백 후에도 서버가 dirty하면 파일을 삭제하거나 강제 reset하지 말고 변경 목록을 먼저 조사한다. 배포 잠금은 `~/.local/state/research-writer/deploy.lock`에 있으며 프로세스가 종료되면 자동 해제된다.
