# 기여 가이드

## 원칙

- `.md` 파일의 이식성과 데이터 보존을 기능 편의보다 우선합니다.
- 편집 화면의 상시 UI를 늘리기 전에 패널이나 명령으로 숨길 수 있는지 검토합니다.
- AI 기능은 명시적인 문맥 선택, diff, 사용자 승인과 되돌리기를 유지해야 합니다.
- 비밀은 프런트엔드 상태, 로그, SQLite 또는 저장소에 넣지 않습니다.
- 플랫폼 전용 코드는 Electron main 또는 Rust 서비스 경계 안에 두고 Svelte 화면은 공통으로 유지합니다.

## 변경 전 확인

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

로컬 Rust 도구 구성이 어렵다면 `./scripts/test-linux-container.sh`를 사용합니다.

## 테스트 기대치

- 저장 변경: BOM·CRLF 보존, stale hash 거절, 원자 저장과 병합 테스트
- 버전 변경: 압축 round-trip, 이름 있는 버전 보존, 정리 정책 테스트
- Markdown 변경: fenced code, 제목·각주·한글 검색 사례
- 연동 변경: 실제 계정 대신 `docker-compose.test.yml`의 WireMock fixture
- UI 변경: 밝은·어두운 테마, 920px 최소 창, A4 페이지/너비 맞춤을 확인

외부 서비스에 쓰는 통합 테스트나 실제 OAuth 로그인은 자동 CI에서 수행하지 않습니다.
