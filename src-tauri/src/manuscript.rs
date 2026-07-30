use crate::database::MetadataDb;
use crate::document::{DocumentPayload, read_document};
use chrono::Local;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

const MANUSCRIPT_ROOT_SETTING: &str = "manuscript_repository_root";
const INITIAL_MANUSCRIPT: &str = "# 제목 없는 원고\n\n";
const MAX_FILENAME_ATTEMPTS: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptRepositoryStatus {
    pub configured: bool,
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

pub fn repository_status(db: &MetadataDb) -> Result<ManuscriptRepositoryStatus, String> {
    let Some(root) = configured_root(db)? else {
        return Ok(ManuscriptRepositoryStatus {
            configured: false,
            available: false,
            path: None,
            message: "새 원고를 만들 저장소를 선택해주세요.".to_string(),
        });
    };
    let available = root.is_dir();
    Ok(ManuscriptRepositoryStatus {
        configured: true,
        available,
        path: Some(root.to_string_lossy().to_string()),
        message: if available {
            "새 원고를 이 폴더에 저장합니다.".to_string()
        } else {
            "설정한 원고 저장소를 찾을 수 없습니다.".to_string()
        },
    })
}

pub fn configure_repository(
    db: &MetadataDb,
    path: &str,
) -> Result<ManuscriptRepositoryStatus, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("원고 저장소는 존재하는 절대경로의 폴더여야 합니다.".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))?;
    db.set_setting(MANUSCRIPT_ROOT_SETTING, &canonical.to_string_lossy())?;
    repository_status(db)
}

pub fn create_manuscript(db: &MetadataDb) -> Result<DocumentPayload, String> {
    let root =
        configured_root(db)?.ok_or_else(|| "원고 저장소를 먼저 선택해주세요.".to_string())?;
    if !root.is_dir() {
        return Err(
            "설정한 원고 저장소를 찾을 수 없습니다. 저장소를 다시 선택해주세요.".to_string(),
        );
    }
    let timestamp = Local::now().format("%Y-%m-%d %H%M%S").to_string();
    create_manuscript_at(&root, &timestamp)
}

fn configured_root(db: &MetadataDb) -> Result<Option<PathBuf>, String> {
    Ok(db
        .get_setting(MANUSCRIPT_ROOT_SETTING)?
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from))
}

fn create_manuscript_at(root: &Path, timestamp: &str) -> Result<DocumentPayload, String> {
    for attempt in 1..=MAX_FILENAME_ATTEMPTS {
        let suffix = if attempt == 1 {
            String::new()
        } else {
            format!(" ({attempt})")
        };
        let path = root.join(format!("{timestamp} 새 원고{suffix}.md"));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("새 원고 파일을 만들 수 없습니다: {error}"));
            }
        };
        if let Err(error) = file
            .write_all(INITIAL_MANUSCRIPT.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("새 원고의 처음 내용을 기록할 수 없습니다: {error}"));
        }
        drop(file);
        return read_document(&path);
    }
    Err("같은 시간에 만든 원고가 너무 많아 고유한 파일명을 정할 수 없습니다.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    fn test_database(root: &Path) -> MetadataDb {
        MetadataDb::open(&root.join("metadata.sqlite3")).unwrap()
    }

    #[test]
    fn configures_and_reports_an_existing_repository() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("3_Write");
        fs::create_dir(&repository).unwrap();

        let status = configure_repository(&database, repository.to_str().unwrap()).unwrap();

        assert!(status.configured);
        assert!(status.available);
        assert_eq!(
            status.path,
            Some(
                repository
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    #[test]
    fn rejects_invalid_repository_paths() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let file = directory.path().join("not-a-directory");
        fs::write(&file, "content").unwrap();

        assert!(configure_repository(&database, "relative/path").is_err());
        assert!(configure_repository(&database, file.to_str().unwrap()).is_err());
    }

    #[test]
    fn reports_when_a_configured_repository_disappears() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("3_Write");
        fs::create_dir(&repository).unwrap();
        configure_repository(&database, repository.to_str().unwrap()).unwrap();
        fs::remove_dir(&repository).unwrap();

        let status = repository_status(&database).unwrap();

        assert!(status.configured);
        assert!(!status.available);
        assert_eq!(status.path, Some(repository.to_string_lossy().to_string()));
    }

    #[test]
    fn requires_a_repository_before_creating_a_manuscript() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());

        assert_eq!(
            create_manuscript(&database).unwrap_err(),
            "원고 저장소를 먼저 선택해주세요."
        );
    }

    #[test]
    fn creates_unique_markdown_files_without_overwriting() {
        let directory = tempdir().unwrap();
        let timestamp = "2026-07-30 134512";

        let first = create_manuscript_at(directory.path(), timestamp).unwrap();
        let second = create_manuscript_at(directory.path(), timestamp).unwrap();

        assert!(first.path.ends_with("2026-07-30 134512 새 원고.md"));
        assert!(second.path.ends_with("2026-07-30 134512 새 원고 (2).md"));
        assert_eq!(first.content, INITIAL_MANUSCRIPT);
        assert_eq!(second.content, INITIAL_MANUSCRIPT);
        assert_eq!(
            fs::read_to_string(directory.path().join("2026-07-30 134512 새 원고.md")).unwrap(),
            INITIAL_MANUSCRIPT
        );
    }
}
