# Research Writer

글이 도구보다 먼저 보이는 로컬 우선 Markdown 리서치 에디터입니다. 원고는 평범한 `.md` 파일로 남기고, 편집 화면에는 종이의 여백과 타자기의 리듬만 더합니다.

현재 구현은 Linux를 첫 실행 환경으로 삼지만, 같은 코드와 CI에서 macOS Apple Silicon·Intel 및 Windows x64를 함께 검증하도록 구성했습니다.

## Linux에서 바로 실행

로컬 검증을 마친 x86_64 설치물은
[GitHub Releases](https://github.com/tain030/research-writer/releases/latest)에서
내려받을 수 있습니다.

- Debian/Ubuntu: `research-writer_amd64.deb`
- 그 밖의 x86_64 Linux: `research-writer_amd64.AppImage`

두 파일은 공개 배포용 서명을 하지 않은 초기 빌드입니다. 같은 Release의
`SHA256SUMS`를 함께 내려받으면 설치 전에 무결성을 확인할 수 있습니다.

### 다른 노트북에서 설치

노트북에서 아래 명령으로 최신 `.deb`와 체크섬을 내려받습니다. 이미 이전
버전이 설치되어 있어도 삭제할 필요가 없습니다. `apt install`이 같은
`research-writer` 패키지를 새 버전으로 교체하며 원고와 사용자 설정은
유지됩니다.

```bash
cd ~/Downloads
wget -O research-writer_amd64.deb \
  https://github.com/tain030/research-writer/releases/latest/download/research-writer_amd64.deb
wget -O SHA256SUMS \
  https://github.com/tain030/research-writer/releases/latest/download/SHA256SUMS
grep 'research-writer_amd64.deb$' SHA256SUMS | sha256sum -c -
install -m 0644 research-writer_amd64.deb /tmp/research-writer_amd64.deb
sudo apt install /tmp/research-writer_amd64.deb
rm /tmp/research-writer_amd64.deb
```

설치 후 애플리케이션 메뉴에서 `Research Writer`를 선택하거나
`research-writer` 명령으로 실행합니다. 노트북에는 Docker나 개발 도구가
필요하지 않습니다.

Debian/Ubuntu 계열이 아닌 x86_64 Linux에서는 AppImage를 실행할 수 있습니다.

```bash
cd ~/Downloads
wget -O research-writer_amd64.AppImage \
  https://github.com/tain030/research-writer/releases/latest/download/research-writer_amd64.AppImage
grep 'research-writer_amd64.AppImage$' SHA256SUMS | sha256sum -c -
chmod +x research-writer_amd64.AppImage
./research-writer_amd64.AppImage
```

## 지금 들어 있는 기능

- Pretendard를 원고 기본 글꼴로 제공, MaruBuri·NanumGothicCoding 및 설치된 시스템 글꼴 선택
- Markdown 문법은 감추고 완성될 글을 조판하는 20×20 행간 원고지와 무스크롤 한 장·연속 너비 자동 맞춤
- 밝은 원고와 무광 한지 작업대를 분리하고, 매수 도장·종이 결·쪽 이동을 더한 종이형 페이지 뷰어
- 문서명·서식·삽입/보기·출력을 기능군으로 나눈 한 줄 의미 기반 Markdown 도구막대
- 밝은 종이는 유지하면서 모든 버튼과 입력 상태를 고대비 토큰으로 그리는 독립적인 다크 작업대
- 운영체제 제목 문자열을 감춘 통합 타이틀바와 Linux·Windows 창 제어, macOS 네이티브 신호등 버튼
- 제목·부제·장르·소속·작성자를 첫 장에 전통 방식으로 배치하는 호환 가능한 YAML 원고 정보
- 문단 첫 칸, 인용·목록 들여쓰기, 영문 소문자·숫자 두 자 한 칸, 줄 끝 문장 부호와 줄임표 안내
- 글자와 띄어쓰기를 즉시 투영하고 긴 원고의 전체 조판은 최신 입력만 백그라운드에서 갱신
- 원고지를 유지한 채 CodeMirror Markdown 원문 또는 완성본을 옆에 여는 조절 가능한 분할 편집
- 실제 A4 페이지, 페이지 번호, 페이지 하단 각주, 반복 표 머리글을 공유하는 화면 미리보기와 인쇄·PDF 출력
- 대화상자로 그림·표·KaTeX 수식·각주를 넣고 원고지에서는 편집 가능한 문서 카드로 표시
- 어떤 폴더든 원고 저장소로 열고, 루트의 Markdown 원고를 생성·이름 변경·휴지통 삭제
- 마지막 저장소와 마지막 원고 자동 복원, 저장소 밖 Markdown 파일의 독립 편집
- 직렬화된 300ms 자동 저장, 원래 줄바꿈과 UTF-8 BOM 보존, 임시 파일·fsync·원자 교체
- 자동 저장과 종료가 겹쳐도 마지막 편집까지 저장한 뒤 끝내는 안전한 종료 절차
- 외부 변경 감지, 해시 기반 낙관적 잠금, 3-way 병합과 충돌 양쪽 버전 보관
- 문단·문장 집중 모드, 타자기 스크롤, 몰입 중 도구막대 숨김과 선택 가능한 활자 불균일·타건음
- 로컬 SQLite 압축 버전 기록, 이름 있는 버전, 복원 전 교정지 비교와 Markdown 폴더 전체 검색
- Codex App Server와 ChatGPT OAuth를 이용한 다듬기·축약·확장·논리 점검·반론·근거 강화·자동 이어쓰기
- 선택·현재 문단·전체 범위를 명시적으로 보내는 AI 맞춤법·문법 검사와 변경별 diff 승인
- AI 적용 전 버전 보관, 원문과 제안의 diff 확인, 명시적 수락 전 원고 불변
- Zotero 로컬 API 검색과 Markdown 각주 삽입
- Research Agent의 조사 요청·폴더·출처 연결, 로컬 `source_index.jsonl`과 검증 카드 폴백
- 설치된 Syncthing 상태와 `.sync-conflict-*` 파일 감지

AI, Zotero, Research Agent, Syncthing은 모두 선택 기능입니다. 연결하지 않아도 편집·저장·검색·버전 기능은 완전히 로컬에서 동작합니다.

## 빠른 시작

필수 버전은 `.nvmrc`, `rust-toolchain.toml`, `package.json`에 고정되어 있습니다.

```bash
cd research-writer
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

Debian/Ubuntu에서 Tauri 개발 패키지가 없다면 먼저 설치합니다.

```bash
sudo apt update
sudo apt install \
  build-essential \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  patchelf \
  pkg-config \
  xdg-utils
```

현재 호스트처럼 GUI 개발 패키지를 설치할 권한이 없는 환경에서는 Docker로 전체 Linux 검증을 실행할 수 있습니다.

```bash
./scripts/test-linux-container.sh
```

## 릴리스

안정 버전을 설정하고 해당 커밋에 같은 버전 태그를 푸시하면 GitHub Actions가
전체 CI, Linux x86_64 패키징, 체크섬 생성과 GitHub Release 공개를 수행합니다.

```bash
pnpm release:version 0.6.0
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v0.6.0"
git tag -a v0.6.0 -m "Research Writer v0.6.0"
git push origin main v0.6.0
```

태그는 `v숫자.숫자.숫자` 형식이어야 하며 `main`에 포함된 커밋만 릴리스할 수
있습니다. macOS와 Windows는 CI에서 계속 검증하지만 코드 서명과 공증을
준비하기 전까지 공개 설치물에는 포함하지 않습니다.

Docker는 재현 가능한 빌드와 통합 테스트에만 사용합니다. 실제 데스크톱 앱은 호스트의 WebView, 글꼴, OS 보안 저장소, Zotero와 Syncthing에 접근해야 하므로 컨테이너 안에서 실행하지 않습니다.

## 원고 저장소와 Obsidian

`저장소 열기`로 작업할 폴더를 선택합니다. Obsidian vault, vault 안의 글쓰기
폴더, 일반 프로젝트 폴더를 모두 열 수 있습니다. 앱은 마지막 저장소와 그
안에서 마지막으로 열었던 원고를 다음 실행 때 복원합니다.

저장소를 연 뒤 `새 원고`를 누르면 탐색기 없이 루트에
`제목 없는 원고.md`가 만들어지고 곧바로 이름을 입력할 수 있습니다. 같은
이름이 있으면 번호가 붙습니다. 저장소 목록에서는 이름 변경과 OS 휴지통
이동도 할 수 있습니다. 목록과 저장소 검색은 의도적으로 루트의 `.md`와
`.markdown` 파일만 다루며, 하위 폴더 파일은 `파일 열기`로 독립적으로 열 수
있습니다.

원고는 평범한 Markdown 파일이므로 Obsidian에서도 그대로 보입니다. 저장소가
Dropbox·OneDrive·Google Drive·iCloud 폴더에 있다면 실제 업로드와 다른 기기
동기화는 해당 데스크톱 앱이 담당합니다. 같은 폴더를 여러 동기화 도구로
동시에 관리하지 마세요.

주요 단축키는 `Ctrl/Cmd+Shift+O` 저장소 열기, `Ctrl/Cmd+O` 파일 열기,
`Ctrl/Cmd+N` 새 원고, `Ctrl/Cmd+W` 현재 원고 닫기입니다. 글을 선택한 뒤
`Ctrl/Cmd+B`는 굵게, `Ctrl/Cmd+I`는 기울임, `Ctrl/Cmd+K`는 링크를
Markdown 의미 구조로 적용합니다. `Ctrl/Cmd+Shift+V`는 완성본을 옆에 열고,
`Ctrl/Cmd+P`는 같은 A4 조판으로 인쇄 또는 PDF 저장 창을 엽니다.

## 원고지 작성 안내

원고를 열면 Markdown 제목이나 파일 이름이 첫 장 제목으로 표시됩니다.
`원고 정보`에서 제목·부제·장르·소속·이름을 입력하면 다음처럼 평범한 YAML
frontmatter로 저장되므로 Obsidian과 다른 Markdown 편집기에서도 그대로
읽을 수 있습니다.

첫 줄을 비우고 둘째 줄에 제목을 가운데 정렬한 뒤 소속과 작성자를 오른쪽에
두는 배치는 국가 어문 규범이 아니라 널리 쓰이는 한국어 원고지 관행입니다.
영문 대문자와 한 글자짜리 숫자·소문자는 한 칸, 이어지는 영문 소문자와
숫자는 두 자씩 한 칸의 좌우 절반에 배치합니다. 글자를 작게 뭉치지 않고
주변 제목·작성자·본문 크기를 따르므로 첫 장 정보에도 같은 방식이 자연스럽게
적용됩니다.

```yaml
---
title: 연구 노트의 감각
subtitle: 도구보다 글이 먼저 보이게
author: 홍길동
affiliation: 원고지 연구소
genre: 평론
research_writer:
  schema: 1
  layout: traditional-ko
---
```

`Enter`는 새 문단, `Shift+Enter`는 같은 문단 안 줄바꿈입니다. 문단과
인용문의 첫 칸은 화면에서 자동으로 비우므로 원문 앞에 공백이나 탭을 직접
넣지 않아도 됩니다. 스페이스를 누르면 다음 글자를 기다리지 않고 빈 칸과
커서가 즉시 이동합니다. `## `처럼 Markdown 제목을 입력하면 기호는 원고에서
숨기되 편집 중인 행의 왼쪽 여백에 `## · 큰 제목` 안내가 나타납니다. 빈
제목에는 무엇을 입력할지도 표시되며 안내 문구는 저장하거나 인쇄하지 않습니다.
괄호와 따옴표는 짝을 자동으로 만들고, 원고지 관행상
확실히 고칠 수 있는 공백·말줄임표 문제는 입력이 250ms 멈춘 뒤 교정 패널에
갱신되어 안전 수정을 제공합니다. 문맥 판단이 필요한 맞춤법과 문법은
사용자가 버튼을 누를 때만
선택한 범위를 AI에 보내며, 원문과 수정문을 비교해 승인하기 전에는 파일을
바꾸지 않습니다.

상단 `삽입` 메뉴의 `그림`, `표`, `수식`, `각주` 도구는 Markdown 문법을 몰라도 표준
문서 요소를 만듭니다. 그림은 원본을 건드리지 않고 현재 원고 옆의
`assets/`에 무작위 안전 이름으로 복사됩니다. 원고지에서는 긴 Markdown
구문 대신 두 줄짜리 카드를 보여줍니다. 상단의 원문 또는 완성본 아이콘을
누르면 원고지는 왼쪽에 유지되고 오른쪽에서 실제 저장 내용이나 표·그림·수식과
페이지 하단 각주가 조판된 A4 문서를 함께 확인할 수 있습니다.

## 선택 기능 연결

### AI 작문 보조

1. Codex CLI를 설치합니다. App Server 연동은 `0.145.0`에서 검증했습니다.
2. 앱의 `AI` 패널에서 브라우저 로그인 또는 기기 코드 로그인을 선택합니다.
3. 보낼 문맥을 선택·현재 절·전체 중에서 명시적으로 고릅니다.

앱은 API 키나 OAuth 토큰을 읽거나 저장하지 않습니다. Codex App Server가 계정을 관리하고, 각 요청은 빈 임시 폴더의 최소 읽기 권한 프로필에서 실행됩니다. 셸·브라우저·앱·MCP 도구와 네트워크를 끄고, 사용자가 선택한 텍스트, 문체 참고 원고, 출처 카드만 전달합니다.

GUI 앱에서 `codex`를 찾지 못하면 `RESEARCH_WRITER_CODEX_BIN`에 실행 파일의 절대경로를 지정할 수 있습니다.

### Zotero

Zotero의 `설정 → 고급 → 다른 응용 프로그램이 이 컴퓨터의 Zotero와 통신하도록 허용`을 켜고 Zotero를 실행합니다. 앱은 루프백 주소 `127.0.0.1:23119`의 읽기 전용 로컬 API만 사용하며 별도 키가 필요하지 않습니다.

### Research Agent

설정에서 다음 중 하나 또는 둘 다 연결할 수 있습니다.

- HTTPS Research Agent 주소와 Bearer 토큰: 토큰은 OS 보안 저장소에만 보관
- 같은 컴퓨터 또는 Syncthing에 복제된 Research 작업 폴더

서버가 `GET /research-folders/{slug}/sources`를 제공하면 이를 우선 사용합니다. 제공하지 않거나 오프라인이면 로컬 `<root>/<slug>/_work/source_index.jsonl`과 `_work/source_cards/*.md`를 읽습니다. 상세 계약은 [docs/RESEARCH_AGENT_API.md](docs/RESEARCH_AGENT_API.md)에 있습니다.

### Syncthing

앱은 일반적인 Syncthing 설정 위치에서 로컬 GUI API 키와 폴더 목록을 읽어 현재 원고의 동기화 상태를 표시합니다. 원고를 직접 업로드하거나 Syncthing 설정을 변경하지 않습니다. 같은 폴더를 Dropbox 같은 다른 동기화 도구와 동시에 관리하지 않는 편이 안전합니다.

## 개발 명령

```bash
pnpm check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

`CI` 워크플로는 Linux, macOS arm64, Windows x64에서 위 검사를 실행합니다. `Native packages` 수동 워크플로는 Linux x64, macOS arm64·x64, Windows x64 설치물을 workflow artifact로 만듭니다. 실제 공개 배포 전에는 Apple·Windows 코드 서명과 릴리스 키를 별도로 구성해야 합니다.

## 데이터 원칙

- 원고의 단일 진실은 사용자가 선택한 `.md` 파일입니다.
- 삽입한 그림은 원고 옆 `assets/`에 두며 로컬 상대경로만 자동으로 읽습니다.
- SQLite에는 버전, 최근 문서, 검색 색인, 비밀이 아닌 설정만 둡니다.
- Research Agent 토큰은 Keychain, Credential Manager 또는 Secret Service에 둡니다.
- AI 제안과 외부 동기화 결과는 자동으로 원고를 덮지 않습니다.
- 원시 HTML과 원격 그림은 완성본에서 실행하거나 자동으로 불러오지 않습니다.
- 레거시 인코딩은 읽기 전용으로 열고 원본 버전을 만든 뒤 명시적으로 UTF-8로 변환합니다.

구조와 경계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 기여 절차는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 기본 제공 글꼴의 라이선스는
`static/fonts/Pretendard-OFL.txt`, `static/fonts/OFL.txt`와
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 따로 기록했습니다.
