# Research Writer 아키텍처

## 구성

```text
Electron 43 / 고정 Chromium
  ├─ Svelte 5 화면
  │    ├─ Tiptap·ProseMirror A4 WYSIWYG
  │    ├─ CodeMirror Markdown 원문
  │    └─ 패널, diff 승인, 저장 상태
  ├─ 격리 preload bridge
  │    ├─ 허용된 IPC 명령
  │    ├─ OS 파일 대화상자·창 제어
  │    └─ Chromium printToPDF
  └─ Rust sidecar
       ├─ 문서·저장소·버전·검색
       ├─ 파일 감시와 충돌 방지
       ├─ Zotero·Syncthing·Research Agent
       └─ Codex App Server 연결
```

Electron은 플랫폼마다 달라지는 시스템 WebView 대신 동일한 Chromium을 함께 배포합니다. 번들 파일은 경로 이탈을 차단한 secure `rw://app/` 프로토콜로 제공하며 CSP hash를 적용합니다. `contextIsolation`과 renderer sandbox를 켜고 Node 통합은 끕니다. 화면은 preload가 노출한 좁은 API만 호출할 수 있습니다.

Rust 프로세스는 표준 입출력의 JSON-lines RPC로 Electron main과 통신합니다. 명령 응답과 파일 감시 이벤트가 같은 채널을 공유하되 요청 ID와 이벤트 이름으로 구분합니다. 패키지에는 운영체제에 맞춰 네이티브로 빌드한 실행 파일 하나만 포함합니다.

## 문서 모델

문서의 단일 진실은 Markdown 문자열입니다. 파일을 열면 YAML frontmatter를 분리해 보존하고 본문을 Tiptap 문서로 해석합니다. 편집할 때 Tiptap Markdown serializer가 본문을 만들고 frontmatter를 다시 앞에 붙입니다.

Research Writer 확장은 다음 구문을 명시적으로 왕복합니다.

- GFM 제목, 목록, 체크 목록, 인용, 표, 코드와 링크
- 로컬 Markdown 그림
- `$...$`, `$$...$$` KaTeX 수식
- `[^id]` 각주 참조와 정의

원문 패널은 같은 Markdown 값을 CodeMirror로 편집합니다. 어느 쪽이 바뀌어도 하나의 저장·버전·충돌 경로만 거칩니다. 알 수 없는 비표준 문법은 첫 WYSIWYG 수정에서 정규화될 수 있으므로 원문 패널을 함께 제공합니다.

## A4 편집과 페이지 나눔

편집 DOM 자체의 너비는 210mm이고 위·아래·좌·우 여백도 mm 단위로 고정합니다. 본문 기본값은 Pretendard 11.5pt, 행간 1.75입니다. 화면 확대는 문서 치수를 바꾸지 않고 전체 종이에만 scale을 적용합니다.

페이지 나눔은 별도 완성본 HTML을 만들지 않습니다.

1. 브라우저가 실제 글꼴과 현재 폭으로 문단을 배치합니다.
2. 페이지 본문 높이를 넘는 블록 앞에 ProseMirror decoration을 둡니다.
3. 긴 문단과 코드 블록은 DOM Range의 줄 경계를 이진 탐색해 나눌 위치를 찾습니다.
4. 제목은 가능한 경우 바로 다음 블록과 같은 페이지에 둡니다.
5. decoration은 이전 장의 남은 높이와 장 사이 간격만큼 공간을 만듭니다.

입력 내용은 즉시 ProseMirror에 반영하고 전체 재측정은 짧게 합쳐 실행합니다. 재측정 중에도 커서는 ProseMirror selection을 유지하므로 Enter, Shift+Enter, 공백과 조합 입력이 별도 투영 계층을 거치지 않습니다.

`페이지에 맞추기`에서는 현재 장만 viewport에 맞추고 바깥 장을 시각적으로 숨깁니다. 인쇄 미디어에서는 모든 장을 복원하고 CSS `@page { size: A4 }`를 적용합니다. Electron의 `printToPDF`가 바로 이 DOM을 출력하므로 화면과 PDF가 같은 엔진·폰트·여백을 사용합니다.

## 글꼴 재현성

글꼴 목록은 시스템 글꼴을 스캔하지 않습니다.

- 번들 글꼴: 앱 버전에 고정된 Pretendard, MaruBuri, NanumGothicCoding
- 저장소 글꼴: `.research-writer/fonts`의 TTF·OTF·WOFF2

Rust가 저장소 폰트를 검사하고 family 이름과 data URL을 반환합니다. renderer는 `FontFace`로 해당 바이트를 직접 등록합니다. 따라서 Linux, macOS, Windows와 PDF가 같은 파일을 사용하며 이름만 같은 다른 시스템 글꼴로 대체되지 않습니다.

## 저장 프로토콜

1. 파일을 열 때 원본 바이트의 SHA-256, 줄바꿈, BOM과 인코딩을 기록합니다.
2. 편집 중 내부 문자열은 LF로 정규화합니다.
3. 자동 저장, 수동 저장, 창 흐림과 종료 저장을 단일 큐에서 직렬 실행합니다.
4. 저장 직전 디스크 해시가 열 때 기록한 해시와 같은지 확인합니다.
5. 같은 디렉터리의 임시 파일을 flush·fsync한 뒤 원자 교체합니다.
6. 외부 변경이 먼저 있었다면 덮지 않고 공통 기반의 3-way 병합을 제안합니다.
7. 충돌을 해결하기 전에 로컬과 외부 내용을 버전 DB에 각각 남깁니다.

운영체제의 닫기 요청은 renderer의 저장 guard로 전달됩니다. 저장 큐가 성공하면 `complete_app_exit`만 Electron main에서 `app.quit()`을 허용합니다. 저장 실패나 충돌이면 사용자가 해결하거나 명시적으로 저장하지 않고 끝낼 때까지 창을 유지합니다.

## 보안 경계

- renderer: sandbox, Node 없음, 임의 IPC 없음
- preload: 고정된 대화상자·창·PDF·백엔드 메서드만 노출
- Electron main: HTTP(S)만 외부 브라우저로 열고 다른 탐색을 차단
- Rust: 경로 정규화, 파일 크기·형식 검사, 원자 저장과 해시 충돌 감지
- AI: 선택한 문맥만 ephemeral Codex thread에 전달, 도구 요청 거절, diff 승인 필수
- Zotero: 루프백 읽기 전용 Local API
- Syncthing: 로컬 REST 상태 읽기 전용
- Research Agent: HTTPS/Bearer 또는 사용자가 지정한 로컬 출처 인덱스

로컬 그림은 PNG·JPEG·WebP·GIF 중 20MiB 이하인지 signature까지 검사한 뒤 문서 옆 `assets/`에 안전한 이름으로 복사합니다. 읽을 때도 canonical path가 열린 저장소나 문서 폴더를 벗어나지 않는지 다시 확인합니다.

## 플랫폼과 배포

GitHub Actions는 프런트엔드 검사와 Rust 테스트를 Linux, macOS, Windows에서 수행합니다. `vX.Y.Z` 태그가 `main`의 커밋을 가리키면 다음 패키지를 네이티브 runner에서 병렬 생성합니다.

- Linux x64: Debian 패키지, AppImage
- macOS arm64·x64: DMG, ZIP
- Windows x64: NSIS 설치형, portable 실행 파일

모든 패키지를 모은 뒤 하나의 `SHA256SUMS`를 만들고 GitHub Release를 공개합니다. Docker 이미지는 고정된 Linux 검사 환경일 뿐 GUI 실행이나 배포 산출물의 기반이 아닙니다.

## 의도적으로 넣지 않은 것

- 독점 문서 포맷 또는 이중 원본 모델
- 앱 자체 계정·클라우드 동기화 서버
- 운영체제마다 달라지는 시스템 글꼴 자동 사용
- 승인 전에 원문을 덮는 AI 자동 수정
- 원고 저장소를 자유롭게 읽는 AI 에이전트
- 별도 플러그인 런타임과 복잡한 확장 API

기능 수보다 쓰는 감각, 문서 이식성과 결과의 재현성을 우선합니다.
