use base64::Engine;
use fontdb::Database;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc::Sender};

const CREDENTIAL_SERVICE: &str = "com.tain.researchwriter";
const RESEARCH_TOKEN_ACCOUNT: &str = "research-agent-token";
const BUNDLED_FONTS: [(&str, bool); 4] = [
    ("Goorm Sans Code", true),
    ("MaruBuri", false),
    ("Pretendard", false),
    ("NanumGothicCoding", true),
];

pub trait FontService: Send + Sync {
    fn list(&self, repository: Option<&Path>) -> Result<Vec<FontRecord>, String>;
    fn import(&self, repository: &Path, source: &Path) -> Result<Vec<FontRecord>, String>;
}

pub trait CredentialStore: Send + Sync {
    fn set_research_token(&self, token: &str) -> Result<(), String>;
    fn research_token(&self) -> Result<Option<String>, String>;
    fn clear_research_token(&self) -> Result<(), String>;
}

pub trait SystemIntegration: Send + Sync {
    fn startup_markdown_path(&self) -> Option<String>;
}

pub struct PlatformServices {
    pub fonts: SystemFontService,
    pub credentials: SystemCredentialStore,
    pub system: DesktopSystemIntegration,
    pub watchers: FileWatcherService,
}

#[derive(Default)]
pub struct SystemFontService;

#[derive(Default)]
pub struct SystemCredentialStore;

#[derive(Default)]
pub struct DesktopSystemIntegration;

pub struct FileWatcherService {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    events: Sender<BackendEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRecord {
    pub family: String,
    pub monospaced: bool,
    pub bundled: bool,
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangeEvent {
    path: String,
    kind: String,
}

#[derive(Debug, Clone)]
pub struct BackendEvent {
    pub event: String,
    pub payload: Value,
}

impl PlatformServices {
    pub fn new(events: Sender<BackendEvent>) -> Self {
        Self {
            fonts: SystemFontService,
            credentials: SystemCredentialStore,
            system: DesktopSystemIntegration,
            watchers: FileWatcherService {
                watchers: Mutex::new(HashMap::new()),
                events,
            },
        }
    }
}

impl FontService for SystemFontService {
    fn list(&self, repository: Option<&Path>) -> Result<Vec<FontRecord>, String> {
        let families = repository
            .map(repository_font_records)
            .transpose()?
            .unwrap_or_default();
        Ok(font_records(families))
    }

    fn import(&self, repository: &Path, source: &Path) -> Result<Vec<FontRecord>, String> {
        let canonical_repository = repository
            .canonicalize()
            .map_err(|error| format!("저장소 경로를 확인할 수 없습니다: {error}"))?;
        if !canonical_repository.is_dir() {
            return Err("폰트를 가져올 저장소가 폴더가 아닙니다.".to_string());
        }
        let canonical_source = source
            .canonicalize()
            .map_err(|error| format!("폰트 파일을 확인할 수 없습니다: {error}"))?;
        let metadata = fs::metadata(&canonical_source)
            .map_err(|error| format!("폰트 정보를 읽을 수 없습니다: {error}"))?;
        if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 {
            return Err("20MB 이하의 일반 폰트 파일만 가져올 수 있습니다.".to_string());
        }
        supported_font(&canonical_source)?;
        let fonts_directory = canonical_repository.join(".research-writer").join("fonts");
        fs::create_dir_all(&fonts_directory)
            .map_err(|error| format!("저장소 폰트 폴더를 만들 수 없습니다: {error}"))?;
        let file_name = canonical_source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "폰트 파일 이름을 읽을 수 없습니다.".to_string())?;
        let destination = unique_font_destination(&fonts_directory, file_name);
        fs::copy(&canonical_source, &destination)
            .map_err(|error| format!("폰트를 저장소로 복사할 수 없습니다: {error}"))?;
        self.list(Some(&canonical_repository))
    }
}

fn font_records(families: BTreeMap<String, (bool, String)>) -> Vec<FontRecord> {
    let mut result = BUNDLED_FONTS
        .into_iter()
        .map(|(family, monospaced)| FontRecord {
            family: family.to_string(),
            monospaced,
            bundled: true,
            data_url: None,
        })
        .collect::<Vec<_>>();
    result.extend(
        families
            .into_iter()
            .filter(|(family, _)| {
                !BUNDLED_FONTS
                    .iter()
                    .any(|(bundled, _)| family.eq_ignore_ascii_case(bundled))
            })
            .map(|(family, (monospaced, data_url))| FontRecord {
                family,
                monospaced,
                bundled: false,
                data_url: Some(data_url),
            }),
    );
    result
}

fn repository_font_records(repository: &Path) -> Result<BTreeMap<String, (bool, String)>, String> {
    let fonts_directory = repository.join(".research-writer").join("fonts");
    if !fonts_directory.is_dir() {
        return Ok(BTreeMap::new());
    }
    let mut families = BTreeMap::new();
    let entries = fs::read_dir(&fonts_directory)
        .map_err(|error| format!("저장소 폰트 폴더를 읽을 수 없습니다: {error}"))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("저장소 폰트 항목을 읽을 수 없습니다: {error}"))?
            .path();
        let Ok((mime_type, _)) = supported_font(&path) else {
            continue;
        };
        let bytes =
            fs::read(&path).map_err(|error| format!("저장소 폰트를 읽을 수 없습니다: {error}"))?;
        if bytes.len() > 20 * 1024 * 1024 {
            continue;
        }
        let mut database = Database::new();
        database.load_font_data(bytes.clone());
        if database.faces().next().is_none() {
            continue;
        }
        let data_url = format!(
            "data:{mime_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        for face in database.faces() {
            for (family, _) in &face.families {
                families
                    .entry(family.trim().to_string())
                    .or_insert_with(|| (face.monospaced, data_url.clone()));
            }
        }
    }
    Ok(families)
}

fn supported_font(path: &Path) -> Result<(&'static str, &'static str), String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "ttf" => Ok(("font/ttf", "ttf")),
        "otf" => Ok(("font/otf", "otf")),
        "woff2" => Ok(("font/woff2", "woff2")),
        _ => Err("TTF, OTF, WOFF2 폰트만 가져올 수 있습니다.".to_string()),
    }
}

fn unique_font_destination(directory: &Path, file_name: &str) -> PathBuf {
    let requested = directory.join(file_name);
    if !requested.exists() {
        return requested;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("font");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("ttf");
    for index in 2..10_000 {
        let candidate = directory.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("font-{}.{}", std::process::id(), extension))
}

impl CredentialStore for SystemCredentialStore {
    fn set_research_token(&self, token: &str) -> Result<(), String> {
        if token.trim().is_empty() {
            return self.clear_research_token();
        }
        credential_entry()?
            .set_password(token.trim())
            .map_err(|error| format!("OS 보안 저장소에 토큰을 저장할 수 없습니다: {error}"))
    }

    fn research_token(&self) -> Result<Option<String>, String> {
        match credential_entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "OS 보안 저장소에서 토큰을 읽을 수 없습니다: {error}"
            )),
        }
    }

    fn clear_research_token(&self) -> Result<(), String> {
        match credential_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "OS 보안 저장소에서 토큰을 지울 수 없습니다: {error}"
            )),
        }
    }
}

impl SystemIntegration for DesktopSystemIntegration {
    fn startup_markdown_path(&self) -> Option<String> {
        std::env::args_os()
            .skip(1)
            .map(PathBuf::from)
            .find(|path| path.is_file() && is_markdown(path))
            .and_then(|path| path.canonicalize().ok().or(Some(path)))
            .map(|path| path.to_string_lossy().to_string())
    }
}

impl FileWatcherService {
    pub fn watch(&self, path: &str) -> Result<(), String> {
        let canonical = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("감시할 문서를 찾을 수 없습니다: {error}"))?;
        let canonical_path = canonical.to_string_lossy().to_string();
        let key = format!("document:{canonical_path}");
        let event_path = canonical_path.clone();
        let events = self.events.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                return;
            };
            if !event.paths.is_empty() {
                let payload = FileChangeEvent {
                    path: event_path.clone(),
                    kind: format!("{:?}", event.kind),
                };
                let _ = events.send(BackendEvent {
                    event: "external-file-change".to_string(),
                    payload: serde_json::to_value(payload).unwrap_or_else(|_| json!({})),
                });
            }
        })
        .map_err(|error| format!("파일 감시기를 시작할 수 없습니다: {error}"))?;
        watcher
            .watch(&canonical, RecursiveMode::NonRecursive)
            .map_err(|error| format!("문서를 감시할 수 없습니다: {error}"))?;
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "파일 감시기 잠금에 실패했습니다.")?;
        watchers.insert(key, watcher);
        Ok(())
    }

    pub fn unwatch(&self, path: &str) -> Result<(), String> {
        let path = PathBuf::from(path);
        let canonical = path
            .canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let key = format!("document:{canonical}");
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "파일 감시기 잠금에 실패했습니다.")?;
        watchers.remove(&key);
        Ok(())
    }

    pub fn watch_repository(&self, path: &str) -> Result<(), String> {
        let canonical = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("감시할 저장소를 찾을 수 없습니다: {error}"))?;
        if !canonical.is_dir() {
            return Err("감시할 저장소는 폴더여야 합니다.".to_string());
        }
        let canonical_path = canonical.to_string_lossy().to_string();
        let key = format!("repository:{canonical_path}");
        let events = self.events.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                return;
            };
            let Some(changed) = event.paths.first() else {
                return;
            };
            let payload = FileChangeEvent {
                path: changed.to_string_lossy().to_string(),
                kind: format!("{:?}", event.kind),
            };
            let _ = events.send(BackendEvent {
                event: "repository-change".to_string(),
                payload: serde_json::to_value(payload).unwrap_or_else(|_| json!({})),
            });
        })
        .map_err(|error| format!("저장소 감시기를 시작할 수 없습니다: {error}"))?;
        watcher
            .watch(&canonical, RecursiveMode::NonRecursive)
            .map_err(|error| format!("저장소를 감시할 수 없습니다: {error}"))?;
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "파일 감시기 잠금에 실패했습니다.")?;
        watchers.insert(key, watcher);
        Ok(())
    }

    pub fn unwatch_repository(&self, path: &str) -> Result<(), String> {
        let path = PathBuf::from(path);
        let canonical = path
            .canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let key = format!("repository:{canonical}");
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| "파일 감시기 잠금에 실패했습니다.")?;
        watchers.remove(&key);
        Ok(())
    }
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, RESEARCH_TOKEN_ACCOUNT)
        .map_err(|error| format!("OS 보안 저장소를 열 수 없습니다: {error}"))
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_extension_is_case_insensitive() {
        assert!(is_markdown(Path::new("/tmp/원고.MD")));
        assert!(is_markdown(Path::new("/tmp/notes.markdown")));
        assert!(!is_markdown(Path::new("/tmp/notes.txt")));
    }

    #[test]
    fn bundled_fonts_are_first_and_repository_duplicates_are_removed() {
        let families = BTreeMap::from([
            (
                "goorm sans code".to_string(),
                (true, "data:goorm".to_string()),
            ),
            ("pretendard".to_string(), (false, "data:a".to_string())),
            ("MaruBuri".to_string(), (false, "data:b".to_string())),
            (
                "Repository Serif".to_string(),
                (false, "data:c".to_string()),
            ),
        ]);
        let fonts = font_records(families);
        let names = fonts
            .iter()
            .map(|font| font.family.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            [
                "Goorm Sans Code",
                "MaruBuri",
                "Pretendard",
                "NanumGothicCoding",
                "Repository Serif"
            ]
        );
        assert!(fonts[..4].iter().all(|font| font.bundled));
        assert!(!fonts[4].bundled);
    }
}
