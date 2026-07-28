use fontdb::Database;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const CREDENTIAL_SERVICE: &str = "com.tain.researchwriter";
const RESEARCH_TOKEN_ACCOUNT: &str = "research-agent-token";
const BUNDLED_FONTS: [(&str, bool); 3] = [
    ("Pretendard", false),
    ("MaruBuri", false),
    ("NanumGothicCoding", true),
];

pub trait FontService: Send + Sync {
    fn list(&self) -> Result<Vec<FontRecord>, String>;
}

pub trait CredentialStore: Send + Sync {
    fn set_research_token(&self, token: &str) -> Result<(), String>;
    fn research_token(&self) -> Result<Option<String>, String>;
    fn clear_research_token(&self) -> Result<(), String>;
}

pub trait SystemIntegration: Send + Sync {
    fn startup_markdown_path(&self) -> Option<String>;
}

#[derive(Default)]
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

#[derive(Default)]
pub struct FileWatcherService {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRecord {
    pub family: String,
    pub monospaced: bool,
    pub bundled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangeEvent {
    path: String,
    kind: String,
}

impl FontService for SystemFontService {
    fn list(&self) -> Result<Vec<FontRecord>, String> {
        let mut database = Database::new();
        database.load_system_fonts();
        let mut families: BTreeMap<String, bool> = BTreeMap::new();
        for face in database.faces() {
            for (family, _) in &face.families {
                families
                    .entry(family.trim().to_string())
                    .and_modify(|monospaced| *monospaced |= face.monospaced)
                    .or_insert(face.monospaced);
            }
        }

        Ok(font_records(families))
    }
}

fn font_records(families: BTreeMap<String, bool>) -> Vec<FontRecord> {
    let mut result = BUNDLED_FONTS
        .into_iter()
        .map(|(family, monospaced)| FontRecord {
            family: family.to_string(),
            monospaced,
            bundled: true,
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
            .map(|(family, monospaced)| FontRecord {
                family,
                monospaced,
                bundled: false,
            }),
    );
    result
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
    pub fn watch(&self, app: AppHandle, path: &str) -> Result<(), String> {
        let canonical = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("감시할 문서를 찾을 수 없습니다: {error}"))?;
        let key = canonical.to_string_lossy().to_string();
        let event_path = key.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                return;
            };
            if !event.paths.is_empty() {
                let _ = app.emit(
                    "external-file-change",
                    FileChangeEvent {
                        path: event_path.clone(),
                        kind: format!("{:?}", event.kind),
                    },
                );
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
        let key = path
            .canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
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
    fn bundled_fonts_are_first_and_system_duplicates_are_removed() {
        let families = BTreeMap::from([
            ("pretendard".to_string(), false),
            ("MaruBuri".to_string(), false),
            ("System Serif".to_string(), false),
        ]);
        let fonts = font_records(families);
        let names = fonts
            .iter()
            .map(|font| font.family.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            [
                "Pretendard",
                "MaruBuri",
                "NanumGothicCoding",
                "System Serif"
            ]
        );
        assert!(fonts[..3].iter().all(|font| font.bundled));
        assert!(!fonts[3].bundled);
    }
}
