# Research Agent 연결 계약

Research Writer는 기존 Research Agent API와 로컬 작업 폴더를 모두 지원합니다.

## 인증과 기본 엔드포인트

- 서버 주소는 HTTPS 또는 루프백 HTTP(`127.0.0.1`, `::1`, `localhost`)만 허용합니다.
- 보호된 요청은 `Authorization: Bearer <token>`을 사용합니다.
- 토큰은 OS 보안 저장소에만 보관합니다.
- `GET /health`
- `GET /research-folders`
- `POST /research-folders/start`

폴더 목록은 기존 응답의 `research_folders` 배열을 사용하며 최소 필드는 다음과 같습니다.

```json
{
  "research_folders": [
    {
      "slug": "example",
      "title": "예시 리서치",
      "stage": "human_review",
      "source_count": 12
    }
  ]
}
```

## 선택적인 출처 엔드포인트

서버가 아래 읽기 전용 엔드포인트를 제공하면 로컬 폴백보다 우선합니다.

```http
GET /research-folders/{slug}/sources
Authorization: Bearer …
```

```json
{
  "sources": [
    {
      "id": "S001",
      "title": "Official source",
      "url": "https://example.com/official",
      "publisher": "Example Authority",
      "checkedAt": "2026-07-28",
      "classification": "primary / A",
      "citationMarkdown": "Example Authority, “Official source,” 2026, https://example.com/official.",
      "summary": "검증 카드에서 추린 핵심 요약과 사용할 수 있는 주장"
    }
  ]
}
```

응답은 camelCase 또는 기존 색인과 같은 `source_id`, `accessed_at`, `source_tier`, `citation_markdown`, `source_card` 별칭을 받아들입니다. 엔드포인트는 원문 파일 전체나 내부 절대경로를 반환하지 않는 것이 좋습니다.

## 로컬 폴백

출처 엔드포인트가 없거나 오프라인이면 다음 구조를 읽습니다.

```text
<Research root>/
  <slug>/
    brief.md
    _work/
      source_index.jsonl
      source_cards/
        S001.md
```

폴더 선택은 앱 설정에 저장되며 `RESEARCH_WRITER_RESEARCH_ROOT` 환경 변수와 기본 `~/Research` 자동 감지도 지원합니다. slug는 영문·숫자·하이픈·밑줄만 허용하고, canonical path가 설정한 root 안에 있는지 다시 확인합니다.

각 JSONL 행에서 다음 필드를 사용합니다.

- 식별자: `source_id`
- 제목: `title`
- URL: `canonical_url`, 없으면 `url`
- 발행자: `publisher`
- 확인일: `accessed_at`
- 분류: `source_tier`, `reliability`

검증 카드에서는 `## 핵심 요약` 이후만 최대 6,000자로 잘라 AI 문맥에 넣습니다. 메타데이터 앞부분의 내부 경로는 전달하지 않습니다.
