# 아키텍처

## 설계 목표

Research Writer는 “작은 데스크톱 셸 안의 로컬 Markdown 편집기”로 유지합니다. 파일 형식과 동기화 공급자를 소유하지 않고, OS가 이미 잘하는 일은 OS에 맡깁니다.

```text
Svelte 5 UI + native textarea manuscript input
  ├─ mdast semantic document model + writing diagnostics
  ├─ 20×20 manuscript-grid projection with correction spacing
  ├─ lazy-loaded CodeMirror Markdown source editor
  └─ worker-rendered, sanitized A4 paged preview
          │ Tauri invoke/event
          ▼
Rust application services
  ├─ document: decode, hash, atomic save, merge
  ├─ manuscript: repository lifecycle, create, rename, OS trash
  ├─ assets: scoped image import and offline preview
  ├─ database: versions, recents, FTS search, settings
  ├─ platform: fonts, keyring, document/repository watch, startup files
  ├─ codex: App Server JSON-RPC bridge
  └─ integrations: Zotero, Syncthing, Research Agent
          │
          ├─ portable .md files
          └─ app-local metadata.sqlite3
```

## 핵심 경계

### 원고와 메타데이터

`.md` 파일이 항상 원고의 단일 진실입니다. 기기별 원고 저장소의 절대경로는
앱 데이터 폴더의 SQLite에 보관하고 vault 자체에는 기록하지 않습니다. 한
번에 하나의 저장소를 열며 마지막 저장소와 마지막 저장소 원고를 복원합니다.
저장소 밖에서 연 파일은 독립 문서로 취급하므로 저장소 상태를 바꾸지 않습니다.

새 원고는 저장소 루트에 `제목 없는 원고.md`라는 고유한 이름으로 배타
생성합니다. 이름 변경은 같은 루트 안에서만 허용하고 삭제는 즉시 제거하지
않고 OS 휴지통으로 보냅니다. 저장소 목록과 FTS 색인은 루트의 일반 Markdown
파일만 대상으로 하며 심볼릭 링크와 하위 폴더는 따라가지 않습니다. SQLite에는
이 설정과 압축 버전, 최근 문서, FTS 색인만 저장하므로 앱을 제거해도 원고는
다른 Markdown 편집기에서 그대로 열 수 있습니다.

### 원고지 편집 모델

숨겨진 네이티브 `textarea`가 IME, 선택, 클립보드와 브라우저 undo 입력을
담당합니다. 같은 원문을 `remark` 기반 mdast로 해석하여 YAML 원고 정보,
문단·제목·인용·목록과 그림·표·수식·코드·각주 블록을 구분한 뒤 화면에는
완성될 내용만 Unicode grapheme 단위로 20열×20행 종이에 투영합니다.
Markdown 문법 문자는 칸을 차지하지 않습니다. mdast가 문단 끝 공백을 의미
없는 문자로 생략하더라도 편집 투영은 원문 범위에서 이를 복원하므로 스페이스
입력 즉시 빈 칸과 커서가 이동합니다.

각 UTF-16 원문 경계는 앞/뒤 이동 성향과 함께 페이지·칸·칸 내부 슬롯에
매핑됩니다. 따라서 감춰진 Markdown 기호, 영문 두 자 한 칸, 줄 끝 문장 부호,
연속 줄바꿈과 빈 문단에서도 키보드·마우스·IME가 같은 커서 좌표를 사용합니다.

첫 장에는 제목과 작성자 정보를 배치하고, 본문 문단 첫 칸과 인용·목록
들여쓰기는 가상 칸으로 만듭니다. 영문 소문자와 숫자는 두 자까지 한 칸에
모으고, 닫는 문장 부호는 줄 끝 칸에 함께 둘 수 있으며 여는 문장 부호는
줄 마지막 칸을 피합니다. 표·그림·블록 수식처럼 한 칸으로 표현할 수 없는
요소는 원문 범위를 가리키는 두 줄 카드가 됩니다. 쓰기 행 사이의 행간은
교정용 시각 공간일 뿐 글자 수나 커서 위치에 포함하지 않습니다.

짧은 원고는 진단을 생략한 구조 분석과 조판을 즉시 수행합니다. 긴 원고는
입력된 연속 변경을 한 프레임 안에 가볍게 투영하고, 전체 Markdown 분석과
정규 조판은 Web Worker에서 수행합니다. 워커가 처리 중일 때는 중간 요청을
쌓지 않고 가장 최신 리비전 하나만 남기며, 오래된 응답은 적용하지 않습니다.
입력이 실제 새 장으로 넘어가면 낙관적 투영이 임시 원고지를 만들어 정규
조판을 기다리는 동안에도 글자와 커서를 보입니다. 한 장 보기에서는 이 활성
원고지만 DOM에 남기며 일반 보기의 가상화와 같은 커서·원문 매핑을 사용합니다.
확정적인 공백·문장 부호·원고지 관행 분석, 단어 수와 개요는 마지막 입력
250ms 뒤 한 번만 계산하며 범위 인덱스로 현재 셀에 장식합니다. 분석 중에는
오래된 위치의 밑줄이나 수정 버튼을 노출하지 않습니다. 안전한 수정만 일괄
적용할 수 있습니다. 원고지는 항상 주 편집기로 남고 CodeMirror 원문 또는
완성본 중 하나를 보조 편집 그룹에 엽니다. 세 화면은 원문 오프셋을 공통
스크롤 앵커로 사용하며 원고지와 원문은 같은 Markdown 문자열을 직접 편집합니다.

완성본은 별도 지연 로딩 청크와 Web Worker에서 Markdown을 HTML로 바꾼 뒤
allowlist로 정화합니다. 메인 스레드에서는 실제 글꼴과 그림 크기로 A4 블록을
측정하고, 긴 표·코드·일반 문단을 안전한 경계에서 나누며 최초 인용 각주를
해당 페이지 하단에 예약합니다. 화면과 인쇄는 같은 페이지 DOM을 공유합니다.
원시 HTML은 버리고 원격 그림은 네트워크로 가져오지 않으며, 로컬 그림만 Rust가
검증해 넘긴 data URL로 치환합니다. 원고의 진실은 여전히 하나의 Markdown
문자열뿐이어서 리치 텍스트와 Markdown 사이의 왕복 변환이 없습니다.

### 문서 요소와 그림

표·수식·각주 삽입기는 표준 GFM, `$...$`/`$$...$$`, Markdown 각주 문법을
문자열에 직접 기록합니다. 그림을 넣을 때 Rust 계층은 PNG·JPEG·WebP·GIF
중 20MiB 이하인 실제 래스터 파일인지 시그니처까지 확인하고 원고 옆
`assets/`에 UUID 이름으로 원자 복사합니다. 미리보기 읽기는 정규화한
상대경로만 허용하고, 심볼릭 링크를 포함한 최종 경로가 열린 저장소 또는
원고 폴더를 벗어나지 않는지 canonical path로 다시 확인합니다.

### 저장 프로토콜

1. 열 때 원본 바이트의 SHA-256, 줄바꿈, BOM과 인코딩을 기록합니다.
2. 편집 중에는 내부 표현을 LF로 정규화합니다.
3. 자동 저장, 창 흐림, 수동 저장과 종료 저장은 단일 큐에서 직렬 실행합니다.
4. 저장 직전에 디스크 바이트의 해시가 열 때의 해시와 같은지 확인합니다.
5. 디스크가 이미 요청 바이트와 같으면 중복 요청을 성공으로 처리합니다.
6. 원본 해시가 같으면 같은 디렉터리의 임시 파일에 쓰고 flush·fsync 후 원자 교체합니다.
7. 다르면 어느 쪽도 덮지 않고 원격·로컬·공통 기반으로 3-way 병합을 제안합니다.
8. 충돌을 해결하기 전에 양쪽 내용을 버전 DB에 각각 남깁니다.

이 방식은 Syncthing 같은 외부 도구가 파일을 바꾸는 짧은 구간에도 조용한 데이터 손실을 막습니다.
운영체제의 창 닫기와 앱 끝내기도 같은 저장 큐가 비워진 뒤에만 완료됩니다.

버전 복원은 현재 편집을 먼저 새 스냅샷으로 보관한 뒤 수행합니다. 복원 전
비교는 짧은 원고는 단어, 긴 원고는 제한 시간 안의 줄 단위로 계산하며, 계산
예산을 넘으면 전체 변경 요약으로 낮춰 UI 스레드가 장시간 멈추지 않게 합니다.

### AI 보안 경계

AI 연결은 Codex CLI의 App Server 프로토콜을 사용합니다.

- 앱은 OAuth 토큰을 취급하지 않습니다.
- 요청마다 ephemeral thread를 만들고 approval policy는 `never`로 둡니다.
- 작업 디렉터리는 원고 폴더가 아닌 빈 앱 데이터 폴더입니다.
- 전용 권한 프로필은 최소 런타임 경로와 빈 작업 폴더만 읽고 네트워크는 허용하지 않습니다.
- App Server를 시작할 때 셸·브라우저·앱·MCP 도구와 사용자 hook을 비활성화합니다.
- 도구 요청이 오면 클라이언트가 명시적으로 거절합니다.
- 편집 범위와 문맥은 UI에서 선택한 텍스트만 요청에 직렬화합니다.
- 결과는 구조화 JSON으로 받고 diff 승인을 거쳐야 편집기에 들어갑니다.
- 맞춤법·문법 검사도 자동 실행하지 않으며 선택·현재 문단·전체 중 사용자가
  고른 범위만 보내고, Markdown·YAML·URL·코드·수식·각주 표식을 보존하도록
  별도 요청 계약을 사용합니다.

### 외부 연동

- Zotero: 루프백 읽기 전용 Local API만 사용합니다.
- Syncthing: 로컬 REST API를 읽기만 하며 설정이나 파일을 변경하지 않습니다.
- Dropbox·OneDrive·Google Drive·iCloud: 관리 경로만 표시하며 실제 동기화는 각 공급자의 데스크톱 앱에 맡깁니다.
- Research Agent: HTTPS/Bearer API를 사용하고 토큰은 OS 보안 저장소에 둡니다. 출처 API가 없을 때만 사용자가 연결한 로컬 작업 폴더를 읽습니다.

## 플랫폼 전략

Tauri는 OS의 기본 WebView를 사용합니다. GUI를 Docker에 넣지 않는 이유는 이 앱의 가치가 OS 글꼴, 파일 선택기, 보안 저장소, WebView, 로컬 Zotero와 Syncthing에 있기 때문입니다.

Docker 이미지는 Debian 12와 Rust·Node·pnpm을 고정한 Linux 테스트 환경입니다. macOS와 Windows는 각 OS의 GitHub-hosted runner에서 네이티브로 컴파일합니다. 패키징도 크로스 컴파일 대신 네이티브 runner에서 수행합니다.

## 의도적으로 넣지 않은 것

- 독점 문서 포맷
- 앱 자체 클라우드 계정과 동기화 서버
- 저장 전에 원문을 덮는 AI 자동 수정
- 원고 디렉터리를 자유롭게 읽는 AI 에이전트
- 별도 플러그인 런타임과 복잡한 확장 API
- 리치 텍스트와 Markdown을 동시에 진실로 유지하는 이중 모델

이 경계는 기능 수보다 쓰는 감각과 데이터의 예측 가능성을 우선하기 위한 것입니다.
