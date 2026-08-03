# 기여 가이드

## 원칙

- `.md` 파일의 이식성과 데이터 보존을 기능 편의보다 우선합니다.
- 편집 화면의 상시 UI를 늘리기 전에 패널이나 명령으로 숨길 수 있는지 검토합니다.
- AI 기능은 명시적인 문맥 선택, diff, 사용자 승인과 되돌리기를 유지해야 합니다.
- 비밀은 프런트엔드 상태, 로그, SQLite 또는 저장소에 넣지 않습니다.
- 플랫폼 전용 코드는 Electron main 또는 Rust 서비스 경계 안에 두고 Svelte 화면은 공통으로 유지합니다.

## 변경 전 확인

```bash
git config --local --get researchwriter.role
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify`는 호스트에 C 링커가 없으면 Rust 검증을 Docker로 자동 전환합니다. 프런트엔드까지 고정된 Linux 환경에서 검사하려면 `./scripts/test-linux-container.sh`를 사용합니다.

코드는 `researchwriter.role=developer`인 노트북 체크아웃에서만 수정합니다. `researchwriter.role=server`인 `/home/tain/research-writer`는 읽기 전용 검증 미러이며 `_deploy/deploy-to-server.sh`의 clean fast-forward 외에는 갱신하지 않습니다. 노트북에서 `main`을 push한 뒤 `pnpm server:check`, `pnpm server:sync` 순서로 서버 전체 회귀 검사를 실행합니다.

## 테스트 기대치

- 저장 변경: BOM·CRLF 보존, stale hash 거절, 원자 저장과 병합 테스트
- 버전 변경: 압축 round-trip, 이름 있는 버전 보존, 정리 정책 테스트
- Markdown 변경: fenced code, 제목·각주·한글 검색 사례
- 연동 변경: 실제 계정 대신 `docker-compose.test.yml`의 WireMock fixture
- UI 변경: 밝은·어두운 테마, 920px 최소 창, A4 페이지/너비 맞춤을 확인

외부 서비스에 쓰는 통합 테스트나 실제 OAuth 로그인은 자동 CI에서 수행하지 않습니다.
