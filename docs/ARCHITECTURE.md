# 아키텍처

## 설계 목표

Research Writer는 “작은 데스크톱 셸 안의 로컬 Markdown 편집기”로 유지합니다. 파일 형식과 동기화 공급자를 소유하지 않고, OS가 이미 잘하는 일은 OS에 맡깁니다.

```text
Svelte 5 UI + CodeMirror 6
          │ Tauri invoke/event
          ▼
Rust application services
  ├─ document: decode, hash, atomic save, merge
  ├─ database: versions, recents, FTS search, settings
  ├─ platform: fonts, keyring, file watch, startup files
  ├─ codex: App Server JSON-RPC bridge
  └─ integrations: Zotero, Syncthing, Research Agent
          │
          ├─ portable .md files
          └─ app-local metadata.sqlite3
```

## 핵심 경계

### 원고와 메타데이터

`.md` 파일이 항상 원고의 단일 진실입니다. 앱 데이터 폴더의 SQLite에는 압축 버전, 최근 문서, FTS 색인과 비밀이 아닌 설정만 저장합니다. 앱을 제거해도 원고는 다른 Markdown 편집기에서 그대로 열 수 있습니다.

### 저장 프로토콜

1. 열 때 원본 바이트의 SHA-256, 줄바꿈, BOM과 인코딩을 기록합니다.
2. 편집 중에는 내부 표현을 LF로 정규화합니다.
3. 저장 직전에 디스크 바이트의 해시가 열 때의 해시와 같은지 확인합니다.
4. 같으면 같은 디렉터리의 임시 파일에 쓰고 flush·fsync 후 원자 교체합니다.
5. 다르면 어느 쪽도 덮지 않고 원격·로컬·공통 기반으로 3-way 병합을 제안합니다.
6. 충돌을 해결하기 전에 양쪽 내용을 버전 DB에 각각 남깁니다.

이 방식은 Syncthing 같은 외부 도구가 파일을 바꾸는 짧은 구간에도 조용한 데이터 손실을 막습니다.

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

### 외부 연동

- Zotero: 루프백 읽기 전용 Local API만 사용합니다.
- Syncthing: 로컬 REST API를 읽기만 하며 설정이나 파일을 변경하지 않습니다.
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
