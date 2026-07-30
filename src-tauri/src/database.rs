use crate::document::{hash_text, read_document};
use chrono::{Duration, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

pub struct MetadataDb {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub id: String,
    pub created_at: String,
    pub kind: String,
    pub name: Option<String>,
    pub content_hash: String,
    pub size_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVersion {
    pub id: String,
    pub document_path: String,
    pub created_at: String,
    pub kind: String,
    pub name: Option<String>,
    pub content: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub path: String,
    pub title: String,
    pub opened_at: String,
}

impl MetadataDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("앱 데이터 폴더를 만들 수 없습니다: {error}"))?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("메타데이터 DB를 열 수 없습니다: {error}"))?;
        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS versions (
                    id TEXT PRIMARY KEY,
                    document_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT,
                    content_hash TEXT NOT NULL,
                    content_gzip BLOB NOT NULL,
                    size_bytes INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS versions_document_created
                    ON versions(document_path, created_at DESC);

                CREATE TABLE IF NOT EXISTS recent_documents (
                    path TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    opened_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
                    workspace UNINDEXED,
                    path UNINDEXED,
                    title,
                    content,
                    tokenize = 'unicode61 remove_diacritics 2'
                );
                "#,
            )
            .map_err(|error| format!("메타데이터 DB를 초기화할 수 없습니다: {error}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn snapshot(
        &self,
        document_path: &str,
        content: &str,
        kind: &str,
        name: Option<&str>,
    ) -> Result<VersionSummary, String> {
        if !matches!(
            kind,
            "auto" | "ai" | "merge" | "restore" | "named" | "conversion"
        ) {
            return Err("지원하지 않는 버전 종류입니다.".to_string());
        }
        if kind == "named" && name.is_none_or(|value| value.trim().is_empty()) {
            return Err("이름 있는 버전에는 이름이 필요합니다.".to_string());
        }

        let content_hash = hash_text(content);
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        if kind != "named" {
            let existing = connection
                .query_row(
                    "SELECT id, created_at, kind, name, content_hash, size_bytes
                     FROM versions
                     WHERE document_path = ?1 AND content_hash = ?2 AND kind = ?3
                     ORDER BY created_at DESC LIMIT 1",
                    params![document_path, content_hash, kind],
                    version_from_row,
                )
                .optional()
                .map_err(|error| format!("기존 자동 버전을 확인할 수 없습니다: {error}"))?;
            if let Some(existing) = existing {
                return Ok(existing);
            }
        }

        let compressed = compress(content)?;
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();
        let clean_name = name.map(str::trim).filter(|value| !value.is_empty());
        connection
            .execute(
                "INSERT INTO versions
                 (id, document_path, created_at, kind, name, content_hash, content_gzip, size_bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    document_path,
                    created_at,
                    kind,
                    clean_name,
                    content_hash,
                    compressed,
                    content.len() as i64
                ],
            )
            .map_err(|error| format!("버전을 저장할 수 없습니다: {error}"))?;
        cleanup_versions(&connection, document_path)?;

        Ok(VersionSummary {
            id,
            created_at,
            kind: kind.to_string(),
            name: clean_name.map(ToOwned::to_owned),
            content_hash,
            size_bytes: content.len(),
        })
    }

    pub fn list_versions(&self, document_path: &str) -> Result<Vec<VersionSummary>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let mut statement = connection
            .prepare(
                "SELECT id, created_at, kind, name, content_hash, size_bytes
                 FROM versions WHERE document_path = ?1 ORDER BY created_at DESC LIMIT 1000",
            )
            .map_err(|error| format!("버전 목록을 준비할 수 없습니다: {error}"))?;
        let rows = statement
            .query_map(params![document_path], version_from_row)
            .map_err(|error| format!("버전 목록을 읽을 수 없습니다: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("버전 목록을 변환할 수 없습니다: {error}"))
    }

    pub fn load_version(&self, id: &str) -> Result<StoredVersion, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let row = connection
            .query_row(
                "SELECT id, document_path, created_at, kind, name, content_hash, content_gzip
                 FROM versions WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("버전을 읽을 수 없습니다: {error}"))?
            .ok_or_else(|| "요청한 버전을 찾을 수 없습니다.".to_string())?;
        let content = decompress(&row.6)?;
        Ok(StoredVersion {
            id: row.0,
            document_path: row.1,
            created_at: row.2,
            kind: row.3,
            name: row.4,
            content,
            content_hash: row.5,
        })
    }

    pub fn touch_recent(&self, path: &str) -> Result<(), String> {
        let title = Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("원고")
            .to_string();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        connection
            .execute(
                "INSERT INTO recent_documents(path, title, opened_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE SET title = excluded.title, opened_at = excluded.opened_at",
                params![path, title, Utc::now().to_rfc3339()],
            )
            .map_err(|error| format!("최근 문서를 기록할 수 없습니다: {error}"))?;
        connection
            .execute(
                "DELETE FROM recent_documents WHERE path NOT IN
                 (SELECT path FROM recent_documents ORDER BY opened_at DESC LIMIT 20)",
                [],
            )
            .map_err(|error| format!("최근 문서를 정리할 수 없습니다: {error}"))?;
        Ok(())
    }

    pub fn recent_documents(&self) -> Result<Vec<RecentDocument>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let mut statement = connection
            .prepare(
                "SELECT path, title, opened_at FROM recent_documents
                 ORDER BY opened_at DESC LIMIT 20",
            )
            .map_err(|error| format!("최근 문서 목록을 준비할 수 없습니다: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RecentDocument {
                    path: row.get(0)?,
                    title: row.get(1)?,
                    opened_at: row.get(2)?,
                })
            })
            .map_err(|error| format!("최근 문서 목록을 읽을 수 없습니다: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("최근 문서 목록을 변환할 수 없습니다: {error}"))
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        connection
            .execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|error| format!("설정을 저장할 수 없습니다: {error}"))?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("설정을 읽을 수 없습니다: {error}"))
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        connection
            .execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(|error| format!("설정을 지울 수 없습니다: {error}"))?;
        Ok(())
    }

    pub fn most_recent_document_in(&self, root: &Path) -> Result<Option<String>, String> {
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("저장소 경로를 확인할 수 없습니다: {error}"))?;
        for recent in self.recent_documents()? {
            let path = PathBuf::from(&recent.path);
            let Some(parent) = path.parent() else {
                continue;
            };
            let Ok(canonical_parent) = parent.canonicalize() else {
                continue;
            };
            let Ok(file_type) =
                std::fs::symlink_metadata(&path).map(|metadata| metadata.file_type())
            else {
                continue;
            };
            if canonical_parent == canonical_root
                && file_type.is_file()
                && !file_type.is_symlink()
                && is_markdown(&path)
            {
                return Ok(Some(recent.path));
            }
        }
        Ok(None)
    }

    pub fn rename_document_metadata(&self, from: &str, to: &str) -> Result<(), String> {
        let title = Path::new(to)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("원고");
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("원고 메타데이터 이동을 시작할 수 없습니다: {error}"))?;
        transaction
            .execute("DELETE FROM recent_documents WHERE path = ?1", params![to])
            .map_err(|error| format!("기존 최근 원고 항목을 정리할 수 없습니다: {error}"))?;
        transaction
            .execute(
                "UPDATE recent_documents SET path = ?1, title = ?2 WHERE path = ?3",
                params![to, title, from],
            )
            .map_err(|error| format!("최근 원고 경로를 바꿀 수 없습니다: {error}"))?;
        transaction
            .execute(
                "UPDATE versions SET document_path = ?1 WHERE document_path = ?2",
                params![to, from],
            )
            .map_err(|error| format!("버전 기록 경로를 바꿀 수 없습니다: {error}"))?;
        transaction
            .execute(
                "UPDATE documents_fts SET path = ?1 WHERE path = ?2",
                params![to, from],
            )
            .map_err(|error| format!("검색 색인 경로를 바꿀 수 없습니다: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("원고 메타데이터 이동을 확정할 수 없습니다: {error}"))
    }

    pub fn delete_document_metadata(&self, path: &str) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("원고 메타데이터 정리를 시작할 수 없습니다: {error}"))?;
        transaction
            .execute(
                "DELETE FROM recent_documents WHERE path = ?1",
                params![path],
            )
            .map_err(|error| format!("최근 원고 기록을 지울 수 없습니다: {error}"))?;
        transaction
            .execute(
                "DELETE FROM versions WHERE document_path = ?1",
                params![path],
            )
            .map_err(|error| format!("원고 버전 기록을 지울 수 없습니다: {error}"))?;
        transaction
            .execute("DELETE FROM documents_fts WHERE path = ?1", params![path])
            .map_err(|error| format!("원고 검색 색인을 지울 수 없습니다: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("원고 메타데이터 정리를 확정할 수 없습니다: {error}"))
    }

    pub fn index_workspace(&self, root: &Path) -> Result<usize, String> {
        if !root.is_absolute() || !root.is_dir() {
            return Err("검색할 작업 폴더는 존재하는 절대경로여야 합니다.".to_string());
        }
        let workspace = root.to_string_lossy().to_string();
        let mut documents = Vec::new();
        let entries = std::fs::read_dir(root)
            .map_err(|error| format!("검색할 저장소를 읽을 수 없습니다: {error}"))?;
        for entry in entries.take(10_001).filter_map(Result::ok) {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() || file_type.is_symlink() || !is_markdown(&path) {
                continue;
            }
            let Ok(document) = read_document(&path) else {
                continue;
            };
            if document.content.len() > 10 * 1024 * 1024 {
                continue;
            }
            let title = document
                .content
                .lines()
                .find_map(|line| line.strip_prefix("# ").map(str::trim))
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "제목 없음".to_string());
            documents.push((document.path, title, document.content));
        }
        if documents.len() > 10_000 {
            return Err(
                "작업 폴더에 Markdown 파일이 10,000개보다 많아 색인을 중단했습니다.".to_string(),
            );
        }

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("검색 색인을 시작할 수 없습니다: {error}"))?;
        transaction
            .execute(
                "DELETE FROM documents_fts WHERE workspace = ?1",
                params![workspace],
            )
            .map_err(|error| format!("이전 검색 색인을 비울 수 없습니다: {error}"))?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO documents_fts(workspace, path, title, content)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|error| format!("검색 색인 문장을 만들 수 없습니다: {error}"))?;
            for (path, title, content) in &documents {
                statement
                    .execute(params![workspace, path, title, content])
                    .map_err(|error| format!("검색 색인에 문서를 넣을 수 없습니다: {error}"))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("검색 색인을 확정할 수 없습니다: {error}"))?;
        Ok(documents.len())
    }

    pub fn search(&self, root: &Path, query: &str) -> Result<Vec<SearchResult>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let workspace = root.to_string_lossy().to_string();
        let match_query = fts_match_query(trimmed);
        if match_query.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "메타데이터 DB 잠금에 실패했습니다.")?;
        let mut statement = connection
            .prepare(
                "SELECT path, title,
                        snippet(documents_fts, 3, '⟦', '⟧', ' … ', 22)
                 FROM documents_fts
                 WHERE workspace = ?1 AND documents_fts MATCH ?2
                 ORDER BY rank LIMIT 100",
            )
            .map_err(|error| format!("검색 문장을 준비할 수 없습니다: {error}"))?;
        let rows = statement
            .query_map(params![workspace, match_query], |row| {
                let path: String = row.get(0)?;
                let title: String = row.get(1)?;
                let snippet: String = row.get(2)?;
                let line = locate_first_line(&path, trimmed);
                Ok(SearchResult {
                    path,
                    title,
                    snippet,
                    line,
                })
            })
            .map_err(|error| format!("문서를 검색할 수 없습니다: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("검색 결과를 변환할 수 없습니다: {error}"))
    }
}

fn version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VersionSummary> {
    Ok(VersionSummary {
        id: row.get(0)?,
        created_at: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        content_hash: row.get(4)?,
        size_bytes: row.get::<_, i64>(5)? as usize,
    })
}

fn cleanup_versions(connection: &Connection, document_path: &str) -> Result<(), String> {
    let cutoff = (Utc::now() - Duration::days(90)).to_rfc3339();
    connection
        .execute(
            "DELETE FROM versions
             WHERE document_path = ?1 AND kind != 'named' AND created_at < ?2",
            params![document_path, cutoff],
        )
        .map_err(|error| format!("오래된 자동 버전을 정리할 수 없습니다: {error}"))?;
    connection
        .execute(
            "DELETE FROM versions
             WHERE id IN (
                 SELECT id FROM versions
                 WHERE document_path = ?1 AND kind != 'named'
                 ORDER BY created_at DESC LIMIT -1 OFFSET 1000
             )",
            params![document_path],
        )
        .map_err(|error| format!("자동 버전 개수를 정리할 수 없습니다: {error}"))?;
    Ok(())
}

fn compress(content: &str) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(content.as_bytes())
        .map_err(|error| format!("버전을 압축할 수 없습니다: {error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("버전 압축을 마칠 수 없습니다: {error}"))
}

fn decompress(content: &[u8]) -> Result<String, String> {
    let mut decoder = GzDecoder::new(content);
    let mut value = String::new();
    decoder
        .read_to_string(&mut value)
        .map_err(|error| format!("버전을 압축 해제할 수 없습니다: {error}"))?;
    Ok(value)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn fts_match_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter_map(|term| {
            let clean = term
                .chars()
                .filter(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
                .collect::<String>();
            (!clean.is_empty()).then(|| format!("\"{}\"*", clean.replace('"', "\"\"")))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn locate_first_line(path: &str, query: &str) -> usize {
    let terms = query
        .split_whitespace()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| {
            content.lines().position(|line| {
                let line = line.to_lowercase();
                terms.iter().any(|term| line.contains(term))
            })
        })
        .map(|line| line + 1)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    #[test]
    fn snapshots_round_trip_and_named_versions_are_listed() {
        let directory = tempdir().unwrap();
        let database = MetadataDb::open(&directory.path().join("meta.sqlite3")).unwrap();
        database
            .snapshot("/tmp/draft.md", "첫 원고", "auto", None)
            .unwrap();
        let named = database
            .snapshot("/tmp/draft.md", "확정 원고", "named", Some("검토 전"))
            .unwrap();
        let listed = database.list_versions("/tmp/draft.md").unwrap();

        assert_eq!(listed.len(), 2);
        assert_eq!(
            database.load_version(&named.id).unwrap().content,
            "확정 원고"
        );
    }

    #[test]
    fn indexes_and_searches_korean_markdown() {
        let directory = tempdir().unwrap();
        let database = MetadataDb::open(&directory.path().join("meta.sqlite3")).unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(
            workspace.join("draft.md"),
            "# 동기화 연구\n\n충돌 없는 자동 저장을 분석한다.\n",
        )
        .unwrap();
        std::fs::create_dir(workspace.join("nested")).unwrap();
        std::fs::write(
            workspace.join("nested").join("hidden.md"),
            "# 숨은 원고\n\n자동 저장",
        )
        .unwrap();

        assert_eq!(database.index_workspace(&workspace).unwrap(), 1);
        let results = database.search(&workspace, "자동 저장").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "동기화 연구");
    }
}
