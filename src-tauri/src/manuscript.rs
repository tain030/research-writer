use crate::database::MetadataDb;
use crate::document::{DocumentPayload, read_document};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

const REPOSITORY_ROOT_SETTING: &str = "manuscript_repository_root";
const LAST_DOCUMENT_SETTING: &str = "manuscript_repository_last_document";
const UNTITLED_STEM: &str = "제목 없는 원고";
const MAX_FILENAME_ATTEMPTS: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub active: bool,
    pub available: bool,
    pub writable: bool,
    pub path: Option<String>,
    pub last_document_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDocument {
    pub path: String,
    pub name: String,
    pub modified_at_ms: u64,
    pub size_bytes: u64,
    pub read_only: bool,
}

pub fn repository_status(db: &MetadataDb) -> Result<RepositoryStatus, String> {
    let Some(root) = configured_root(db)? else {
        return Ok(RepositoryStatus {
            active: false,
            available: false,
            writable: false,
            path: None,
            last_document_path: None,
            message: "원고 저장소를 열어주세요.".to_string(),
        });
    };

    if !root.is_dir() {
        return Ok(RepositoryStatus {
            active: true,
            available: false,
            writable: false,
            path: Some(root.to_string_lossy().to_string()),
            last_document_path: None,
            message: "마지막 원고 저장소를 찾을 수 없습니다.".to_string(),
        });
    }

    let canonical = root
        .canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))?;
    let writable = repository_is_writable(&canonical);
    let last_document_path = db
        .get_setting(LAST_DOCUMENT_SETTING)?
        .filter(|path| validate_document_in_root(&canonical, Path::new(path)).is_ok());

    Ok(RepositoryStatus {
        active: true,
        available: true,
        writable,
        path: Some(canonical.to_string_lossy().to_string()),
        last_document_path,
        message: if writable {
            "원고 저장소가 열려 있습니다.".to_string()
        } else {
            "읽기 전용 원고 저장소입니다.".to_string()
        },
    })
}

pub fn open_repository(db: &MetadataDb, path: &str) -> Result<RepositoryStatus, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("원고 저장소는 존재하는 절대경로의 폴더여야 합니다.".to_string());
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))?;
    db.set_setting(REPOSITORY_ROOT_SETTING, &canonical.to_string_lossy())?;

    let remembered = db
        .get_setting(LAST_DOCUMENT_SETTING)?
        .filter(|path| validate_document_in_root(&canonical, Path::new(path)).is_ok())
        .or(db.most_recent_document_in(&canonical)?);
    if let Some(path) = remembered {
        db.set_setting(LAST_DOCUMENT_SETTING, &path)?;
    } else {
        db.delete_setting(LAST_DOCUMENT_SETTING)?;
    }
    repository_status(db)
}

pub fn close_repository(db: &MetadataDb) -> Result<RepositoryStatus, String> {
    db.delete_setting(REPOSITORY_ROOT_SETTING)?;
    db.delete_setting(LAST_DOCUMENT_SETTING)?;
    repository_status(db)
}

pub fn list_documents(db: &MetadataDb) -> Result<Vec<RepositoryDocument>, String> {
    let root = available_root(db)?;
    let mut documents = Vec::new();
    let entries =
        fs::read_dir(&root).map_err(|error| format!("원고 저장소를 읽을 수 없습니다: {error}"))?;

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() || !is_markdown(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Some(name) = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        documents.push(RepositoryDocument {
            path: path
                .canonicalize()
                .unwrap_or(path)
                .to_string_lossy()
                .to_string(),
            name,
            modified_at_ms: modified_at_ms(&metadata),
            size_bytes: metadata.len(),
            read_only: metadata.permissions().readonly(),
        });
    }

    documents.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(documents)
}

pub fn create_document(db: &MetadataDb) -> Result<DocumentPayload, String> {
    let root = writable_root(db)?;
    for attempt in 1..=MAX_FILENAME_ATTEMPTS {
        let suffix = if attempt == 1 {
            String::new()
        } else {
            format!(" ({attempt})")
        };
        let name = format!("{UNTITLED_STEM}{suffix}.md");
        if repository_name_conflicts(&root, &name, None)? {
            continue;
        }
        let path = root.join(name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("새 원고 파일을 만들 수 없습니다: {error}")),
        };
        if let Err(error) = file.flush().and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("새 원고 파일을 준비할 수 없습니다: {error}"));
        }
        drop(file);
        let document = read_document(&path)?;
        db.touch_recent(&document.path)?;
        db.set_setting(LAST_DOCUMENT_SETTING, &document.path)?;
        return Ok(document);
    }
    Err("제목 없는 원고가 너무 많아 고유한 파일명을 정할 수 없습니다.".to_string())
}

pub fn rename_document(
    db: &MetadataDb,
    path: &str,
    requested_name: &str,
) -> Result<DocumentPayload, String> {
    let root = writable_root(db)?;
    let from = validate_document_in_root(&root, Path::new(path))?;
    let name = portable_markdown_name(requested_name)?;
    if repository_name_conflicts(&root, &name, Some(&from))? {
        return Err("대소문자만 다른 같은 이름의 원고가 이미 있습니다.".to_string());
    }
    let to = root.join(name);
    let was_last_document = db
        .get_setting(LAST_DOCUMENT_SETTING)?
        .is_some_and(|remembered| same_path(&remembered, &from));

    if from == to {
        return read_document(&from);
    }
    rename_without_overwrite(&from, &to)?;
    let renamed = match read_document(&to) {
        Ok(document) => document,
        Err(error) => {
            let _ = fs::rename(&to, &from);
            return Err(error);
        }
    };

    if let Err(error) = db.rename_document_metadata(&from.to_string_lossy(), &renamed.path) {
        let _ = fs::rename(&to, &from);
        return Err(error);
    }
    if was_last_document {
        db.set_setting(LAST_DOCUMENT_SETTING, &renamed.path)?;
    }
    db.touch_recent(&renamed.path)?;
    Ok(renamed)
}

pub fn trash_document(db: &MetadataDb, path: &str) -> Result<(), String> {
    trash_document_with(db, path, |target| {
        trash::delete(target)
            .map_err(|error| format!("원고를 OS 휴지통으로 옮길 수 없습니다: {error}"))
    })
}

fn trash_document_with<F>(db: &MetadataDb, path: &str, move_to_trash: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let root = writable_root(db)?;
    let target = validate_document_in_root(&root, Path::new(path))?;
    let display_path = target.to_string_lossy().to_string();
    let was_last_document = db
        .get_setting(LAST_DOCUMENT_SETTING)?
        .is_some_and(|remembered| same_path(&remembered, &target));
    move_to_trash(&target)?;
    db.delete_document_metadata(&display_path)?;
    if was_last_document {
        db.delete_setting(LAST_DOCUMENT_SETTING)?;
    }
    Ok(())
}

pub fn remember_document_if_in_repository(db: &MetadataDb, path: &str) -> Result<(), String> {
    let Some(root) = configured_root(db)? else {
        return Ok(());
    };
    if !root.is_dir() {
        return Ok(());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))?;
    if let Ok(document) = validate_document_in_root(&canonical_root, Path::new(path)) {
        db.set_setting(LAST_DOCUMENT_SETTING, &document.to_string_lossy())?;
    }
    Ok(())
}

pub fn clear_last_document(db: &MetadataDb) -> Result<(), String> {
    db.delete_setting(LAST_DOCUMENT_SETTING)
}

fn configured_root(db: &MetadataDb) -> Result<Option<PathBuf>, String> {
    Ok(db
        .get_setting(REPOSITORY_ROOT_SETTING)?
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from))
}

fn available_root(db: &MetadataDb) -> Result<PathBuf, String> {
    let root = configured_root(db)?.ok_or_else(|| "원고 저장소를 먼저 열어주세요.".to_string())?;
    if !root.is_dir() {
        return Err("원고 저장소를 찾을 수 없습니다. 저장소를 다시 열어주세요.".to_string());
    }
    root.canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))
}

fn writable_root(db: &MetadataDb) -> Result<PathBuf, String> {
    let root = available_root(db)?;
    if !repository_is_writable(&root) {
        return Err("읽기 전용 저장소에서는 원고를 변경할 수 없습니다.".to_string());
    }
    Ok(root)
}

fn repository_is_writable(root: &Path) -> bool {
    fs::metadata(root)
        .map(|metadata| !metadata.permissions().readonly())
        .unwrap_or(false)
}

fn repository_name_conflicts(
    root: &Path,
    requested_name: &str,
    current: Option<&Path>,
) -> Result<bool, String> {
    let entries =
        fs::read_dir(root).map_err(|error| format!("원고 저장소를 읽을 수 없습니다: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let Some(existing_name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if !existing_name.eq_ignore_ascii_case(requested_name) {
            continue;
        }
        if current.is_some_and(|current| {
            entry
                .path()
                .canonicalize()
                .ok()
                .is_some_and(|existing| existing == current)
        }) {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn validate_document_in_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !is_markdown(path) {
        return Err("저장소의 Markdown 원고만 변경할 수 있습니다.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "원고의 상위 폴더를 찾을 수 없습니다.".to_string())?
        .canonicalize()
        .map_err(|error| format!("원고의 상위 폴더를 확인할 수 없습니다: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("원고 저장소 경로를 확인할 수 없습니다: {error}"))?;
    if parent != canonical_root {
        return Err("저장소 루트의 원고만 변경할 수 있습니다.".to_string());
    }
    let file_type = fs::symlink_metadata(path)
        .map_err(|error| format!("원고 파일을 확인할 수 없습니다: {error}"))?
        .file_type();
    if !file_type.is_file() || file_type.is_symlink() {
        return Err("일반 Markdown 파일만 변경할 수 있습니다.".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("원고 경로를 확인할 수 없습니다: {error}"))
}

fn portable_markdown_name(requested: &str) -> Result<String, String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("원고 이름을 입력해주세요.".to_string());
    }
    if trimmed.ends_with(['.', ' '])
        || trimmed.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
    {
        return Err("파일 이름에 사용할 수 없는 문자가 있습니다.".to_string());
    }

    let requested_path = Path::new(trimmed);
    let name = match requested_path.extension().and_then(|value| value.to_str()) {
        None => format!("{trimmed}.md"),
        Some(extension) if matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") => {
            trimmed.to_string()
        }
        Some(_) => return Err("원고 확장자는 .md 또는 .markdown만 사용할 수 있습니다.".to_string()),
    };
    if name.len() > 240 {
        return Err("원고 이름이 너무 깁니다.".to_string());
    }
    let stem = Path::new(&name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let device_stem = stem.split('.').next().unwrap_or_default();
    if reserved.contains(&device_stem) {
        return Err("운영체제에서 예약된 파일 이름입니다.".to_string());
    }
    Ok(name)
}

fn rename_without_overwrite(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        let same_file = to
            .canonicalize()
            .ok()
            .zip(from.canonicalize().ok())
            .is_some_and(|(left, right)| left == right);
        if !same_file {
            return Err("같은 이름의 원고가 이미 있습니다.".to_string());
        }
        let temporary =
            from.with_file_name(format!(".research-writer-rename-{}.tmp", Uuid::new_v4()));
        fs::rename(from, &temporary)
            .map_err(|error| format!("원고 이름 변경을 준비할 수 없습니다: {error}"))?;
        if let Err(error) = fs::rename(&temporary, to) {
            let _ = fs::rename(&temporary, from);
            return Err(format!("원고 이름을 바꿀 수 없습니다: {error}"));
        }
        return Ok(());
    }
    fs::rename(from, to).map_err(|error| format!("원고 이름을 바꿀 수 없습니다: {error}"))
}

fn same_path(left: &str, right: &Path) -> bool {
    Path::new(left)
        .canonicalize()
        .ok()
        .zip(right.canonicalize().ok())
        .is_some_and(|(left, right)| left == right)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

fn modified_at_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
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
    fn opens_arbitrary_repository_and_closes_it() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("어떤 폴더");
        fs::create_dir(&repository).unwrap();

        let opened = open_repository(&database, repository.to_str().unwrap()).unwrap();
        assert!(opened.active);
        assert!(opened.available);
        assert_eq!(
            opened.path,
            Some(
                repository
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            )
        );

        let closed = close_repository(&database).unwrap();
        assert!(!closed.active);
        assert_eq!(closed.path, None);
    }

    #[test]
    fn lists_only_root_markdown_regular_files() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("vault");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(repository.join("nested")).unwrap();
        fs::write(repository.join("둘.markdown"), "two").unwrap();
        fs::write(repository.join("하나.md"), "one").unwrap();
        fs::write(repository.join("notes.txt"), "ignored").unwrap();
        fs::write(repository.join("nested").join("숨김.md"), "ignored").unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();

        let documents = list_documents(&database).unwrap();
        assert_eq!(
            documents
                .iter()
                .map(|document| document.name.as_str())
                .collect::<Vec<_>>(),
            ["둘.markdown", "하나.md"]
        );
    }

    #[test]
    fn creates_unique_empty_untitled_documents() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("drafts");
        fs::create_dir(&repository).unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();

        let first = create_document(&database).unwrap();
        let second = create_document(&database).unwrap();

        assert!(first.path.ends_with("제목 없는 원고.md"));
        assert!(second.path.ends_with("제목 없는 원고 (2).md"));
        assert_eq!(first.content, "");
        assert_eq!(second.content, "");
        assert_eq!(
            repository_status(&database).unwrap().last_document_path,
            Some(second.path)
        );
    }

    #[test]
    fn avoids_case_insensitive_name_collisions_for_cross_platform_folders() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("drafts");
        fs::create_dir(&repository).unwrap();
        fs::write(repository.join("제목 없는 원고.MD"), "existing").unwrap();
        fs::write(repository.join("Other.MD"), "other").unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();

        let created = create_document(&database).unwrap();
        assert!(created.path.ends_with("제목 없는 원고 (2).md"));
        assert!(rename_document(&database, &created.path, "other.md").is_err());
    }

    #[test]
    fn renames_document_and_moves_metadata() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("drafts");
        fs::create_dir(&repository).unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();
        let created = create_document(&database).unwrap();
        database
            .snapshot(&created.path, "version", "named", Some("before"))
            .unwrap();

        let renamed = rename_document(&database, &created.path, "연구 계획").unwrap();

        assert!(renamed.path.ends_with("연구 계획.md"));
        assert!(!Path::new(&created.path).exists());
        assert_eq!(database.list_versions(&renamed.path).unwrap().len(), 1);
        assert_eq!(
            repository_status(&database).unwrap().last_document_path,
            Some(renamed.path)
        );
    }

    #[test]
    fn rejects_unsafe_names_and_outside_paths() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("drafts");
        fs::create_dir(&repository).unwrap();
        let outside = directory.path().join("outside.md");
        fs::write(&outside, "outside").unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();

        assert!(rename_document(&database, outside.to_str().unwrap(), "safe").is_err());
        assert!(portable_markdown_name("../escape").is_err());
        assert!(portable_markdown_name("bad?.md").is_err());
        assert!(portable_markdown_name("CON.md").is_err());
        assert!(portable_markdown_name("CON.notes.md").is_err());
        assert_eq!(portable_markdown_name("원고").unwrap(), "원고.md");
    }

    #[test]
    fn trashes_document_then_removes_metadata() {
        let directory = tempdir().unwrap();
        let database = test_database(directory.path());
        let repository = directory.path().join("drafts");
        fs::create_dir(&repository).unwrap();
        open_repository(&database, repository.to_str().unwrap()).unwrap();
        let created = create_document(&database).unwrap();
        database
            .snapshot(&created.path, "version", "named", Some("before"))
            .unwrap();

        trash_document_with(&database, &created.path, |path| {
            fs::remove_file(path).map_err(|error| error.to_string())
        })
        .unwrap();

        assert!(!Path::new(&created.path).exists());
        assert!(database.list_versions(&created.path).unwrap().is_empty());
        assert!(
            repository_status(&database)
                .unwrap()
                .last_document_path
                .is_none()
        );
        assert_eq!(database.get_setting(LAST_DOCUMENT_SETTING).unwrap(), None);
    }
}
