# Research Writer

Markdown의 이식성은 그대로 두고, 종이 위에서 글을 다듬는 감각을 살린 로컬 우선 리서치 에디터입니다.

기존 원고지 격자는 제거했습니다. 한글과 영문 전문용어가 자주 섞이는 리서치 문서에 맞춰 여백이 넉넉한 A4 편집 화면, 안정적인 본문 크기와 행간, 실제 페이지 나눔을 사용합니다. 편집 화면 자체가 완성본이며 PDF도 같은 Chromium 조판 결과로 출력됩니다.

## 설치

설치 파일은 [GitHub Releases](https://github.com/tain030/research-writer/releases/latest)에서 받을 수 있습니다. 현재 공개 파일에는 코드 서명이 적용되지 않았습니다.

### Debian·Ubuntu

`research-writer_amd64.deb`를 내려받은 뒤 설치합니다. 이전 버전을 삭제할 필요가 없습니다. 같은 명령으로 새 `.deb`를 설치하면 원고와 설정을 유지한 채 업그레이드됩니다.

```bash
cd ~/Downloads
wget -O research-writer_amd64.deb \
  https://github.com/tain030/research-writer/releases/latest/download/research-writer_amd64.deb
wget -O SHA256SUMS \
  https://github.com/tain030/research-writer/releases/latest/download/SHA256SUMS
grep 'research-writer_amd64.deb$' SHA256SUMS | sha256sum -c -

# _apt 권한 경고를 피하도록 /tmp의 읽을 수 있는 파일로 설치합니다.
install -m 0644 research-writer_amd64.deb /tmp/research-writer_amd64.deb
sudo apt install /tmp/research-writer_amd64.deb
rm /tmp/research-writer_amd64.deb
```

다른 x86_64 Linux에서는 `research-writer_x86_64.AppImage`를 내려받아 실행 권한을 부여하면 됩니다.

```bash
chmod +x research-writer_x86_64.AppImage
./research-writer_x86_64.AppImage
```

### macOS

- Apple Silicon: `Research-Writer_macOS_arm64.dmg`
- Intel: `Research-Writer_macOS_x64.dmg`

DMG를 열어 앱을 Applications로 옮깁니다. 아직 Apple 공증 전이므로 처음 한 번은 Finder에서 앱을 Control-클릭한 뒤 `열기`를 선택해야 할 수 있습니다.

### Windows

- 설치형: `Research-Writer_Windows_x64_Setup.exe`
- 무설치형: `Research-Writer_Windows_x64_Portable.exe`

초기 무서명 빌드이므로 SmartScreen 안내가 나타날 수 있습니다. 같은 Release의 `SHA256SUMS`로 파일을 먼저 확인할 수 있습니다.

## 편집 방식

- 기본 원고 글꼴은 MaruBuri입니다. Pretendard와 NanumGothicCoding도 함께 제공합니다.
- 210×297mm A4, 고정 여백과 실제 페이지 나눔을 편집 중 그대로 봅니다.
- `페이지 너비에 맞추기`는 읽기 좋은 너비로 연속 페이지를 보여주고, `페이지에 맞추기`는 현재 한 장을 스크롤 없이 맞춥니다.
- 제목, 목록, 인용, 표, 그림, 수식, 각주를 화면에서 직접 편집합니다.
- Markdown 기호는 편집 화면에서 감추되 현재 블록의 의미를 작은 안내로 보여줍니다.
- 커서가 있는 실제 행에는 옅은 청흑색 잉크 가이드가 나타나 현재 작성 위치를 조용히 알려줍니다.
- Markdown 원문 버튼을 누르면 오른쪽에서 실제 저장 내용을 함께 편집할 수 있습니다.
- PDF 내보내기는 별도 미리보기 문서를 다시 만들지 않고 현재 A4 조판을 그대로 인쇄합니다.
- 문단·문장 집중, 타자기 스크롤과 선택적인 타건음을 제공합니다.

원고의 단일 진실은 언제나 평범한 `.md` 파일입니다. 리치 편집기와 원문 편집기는 같은 Markdown 문자열을 수정하므로 독점 문서 포맷이 생기지 않습니다.

## 저장소와 새 문서

처음에는 `저장소 열기`로 작업할 폴더를 선택합니다. Obsidian vault, vault 안의 글쓰기 폴더, 일반 프로젝트 폴더를 모두 사용할 수 있습니다.

저장소를 연 뒤에는 다음 작업이 분리됩니다.

- `새 원고`: 탐색기를 열지 않고 현재 저장소에 새 `.md` 파일을 만들고 즉시 편집
- `파일 열기`: 저장소 안팎의 기존 Markdown 파일 열기
- 목록에서 이름 변경 또는 운영체제 휴지통으로 이동
- 마지막 저장소와 마지막 문서 자동 복원

자동 저장은 짧게 직렬화해 실행하며 원래 줄바꿈과 UTF-8 BOM을 보존합니다. 외부 동기화 도구가 같은 파일을 먼저 바꾸면 조용히 덮지 않고 3-way 병합을 제안합니다. 종료 버튼도 마지막 저장 큐가 끝난 뒤 앱을 닫습니다.

Dropbox, OneDrive, Google Drive, iCloud 또는 Syncthing 폴더를 저장소로 열 수 있습니다. 업로드 자체는 각 동기화 도구가 담당합니다. 같은 폴더를 둘 이상의 동기화 도구가 동시에 관리하지 않는 편이 안전합니다.

## 글꼴

운영체제에 설치된 글꼴은 의도적으로 목록에 넣지 않습니다. OS마다 같은 폰트 이름이 다른 파일을 가리키는 문제를 막고 PDF까지 동일한 조판을 유지하기 위해 다음 두 종류만 사용합니다.

- 앱에 고정해 넣은 Pretendard, MaruBuri, NanumGothicCoding
- 설정의 `저장소에 글꼴 가져오기`로 복사한 TTF·OTF·WOFF2

가져온 글꼴은 `<저장소>/.research-writer/fonts`에 저장됩니다. 저장소를 동기화하면 다른 컴퓨터에서도 같은 글꼴을 사용합니다. 배포·공유 권한이 있는 폰트만 가져와야 합니다.

## 리서치 보조

AI, Zotero, Research Agent와 Syncthing 연동은 모두 선택 기능입니다. 연결하지 않아도 편집·저장·검색·버전 기록은 완전히 로컬에서 동작합니다.

### AI 작문 보조

Codex App Server를 통해 다듬기, 축약, 확장, 논리 점검, 반론, 근거 강화, 이어쓰기를 요청할 수 있습니다. 앱이 OAuth 토큰을 직접 보관하지 않으며 선택한 문맥만 임시 작업에 전달합니다. 결과는 diff로 확인하고 승인해야 원고에 반영됩니다.

### Zotero

Zotero에서 `설정 → 고급 → 다른 응용 프로그램이 이 컴퓨터의 Zotero와 통신하도록 허용`을 켭니다. 앱은 `127.0.0.1:23119`의 읽기 전용 Local API로 자료를 검색하고 Markdown 각주를 삽입합니다.

### Research Agent·Syncthing

Research Agent는 HTTPS API 또는 로컬 `source_index.jsonl`과 출처 카드에서 자료를 읽습니다. 상세 계약은 [Research Agent API](docs/RESEARCH_AGENT_API.md)에 있습니다. Syncthing 연동은 로컬 상태와 충돌 파일만 확인하며 설정이나 원고를 직접 변경하지 않습니다.

## 단축키

- `Ctrl/Cmd+Shift+O`: 저장소 열기
- `Ctrl/Cmd+O`: 파일 열기
- `Ctrl/Cmd+N`: 현재 저장소에 새 원고
- `Ctrl/Cmd+W`: 현재 원고 닫기
- `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`: 굵게, 기울임, 링크
- `Ctrl/Cmd+Shift+V`: Markdown 원문 나란히 보기
- `Ctrl/Cmd+P`: 같은 A4 조판으로 PDF 내보내기

## 개발

Node, pnpm, Rust 버전은 저장소에 고정되어 있습니다. 소스 코드의 기준은 GitHub `main`이며 노트북의 `developer` 체크아웃에서만 수정·commit·push·tag합니다. 이 서버의 `/home/tain/research-writer`는 앱 호스팅 서버가 아니라 push가 차단된 Linux 검증 미러입니다.

```bash
_deploy/configure-checkout.sh developer
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev`는 Rust 백엔드를 빌드하고 Vite와 Electron을 함께 실행합니다. 브라우저 화면만 확인하려면 `pnpm dev:web`을 사용합니다.

전체 검증 명령은 다음과 같습니다.

```bash
pnpm verify
```

`pnpm verify`는 호스트에 C 링커가 없으면 Rust 검증만 Docker로 자동 전환합니다. 프런트엔드까지 고정된 Linux 환경에서 다시 검사하려면 아래 명령을 사용합니다. GUI 앱 자체는 컨테이너에 넣지 않습니다.

```bash
./scripts/test-linux-container.sh
```

변경을 `origin/main`에 push한 뒤 노트북에서 다음 명령을 실행하면 서버가 clean·fast-forward 가능 여부를 확인하고 같은 Docker 전체 검사를 통과한 커밋만 유지합니다. 실패하면 이전 서버 커밋으로 롤백합니다.

```bash
pnpm server:check
pnpm server:sync
```

소스 코드는 Syncthing으로 양방향 복사하지 않습니다. Syncthing은 사용자가 연 원고 저장소에만 선택적으로 사용합니다. 최초 설정과 복구 절차는 [노트북 개발·서버 검증 Runbook](_deploy/README.md)에 있습니다.

## 릴리스

서버 동기화까지 성공한 뒤 노트북에서 버전을 한 번 설정하고 같은 커밋에 태그를 푸시하면 GitHub Actions가 전체 검사를 실행한 뒤 Linux, macOS, Windows 설치 파일 8개와 통합 체크섬을 자동으로 공개합니다. 서버에서는 태그나 Release를 만들지 않습니다.

```bash
pnpm release:version 0.7.0
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v0.7.0"
git tag -a v0.7.0 -m "Research Writer v0.7.0"
git push origin main v0.7.0
```

앱은 Electron 43.2.0과 Chromium 버전을 고정합니다. 각 운영체제의 GitHub-hosted runner에서 네이티브 백엔드와 패키지를 만들므로 크로스 컴파일 차이도 줄입니다.

## 데이터 원칙

- 사용자 문서와 가져온 글꼴은 사용자가 연 저장소에 둡니다.
- SQLite에는 버전, 최근 문서, 검색 색인과 비밀이 아닌 설정만 둡니다.
- Research Agent 토큰은 운영체제 보안 저장소에 둡니다.
- AI 제안과 외부 동기화 결과는 사용자 승인 없이 원고를 덮지 않습니다.
- 원격 그림과 원시 HTML은 편집 화면에서 자동 실행하거나 불러오지 않습니다.

구조와 보안 경계는 [아키텍처 문서](docs/ARCHITECTURE.md), 기여 절차는 [기여 가이드](CONTRIBUTING.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 기본 제공 글꼴의 라이선스는 `static/fonts/Pretendard-OFL.txt`, `static/fonts/OFL.txt`와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 기록했습니다.
