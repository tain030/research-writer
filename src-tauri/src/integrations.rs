use crate::database::MetadataDb;
use crate::platform::{CredentialStore, PlatformServices};
use reqwest::Client;
use roxmltree::Document;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

const ZOTERO_BASE: &str = "http://127.0.0.1:23119";
const RESEARCH_ENDPOINT_SETTING: &str = "research_agent_endpoint";
const RESEARCH_ROOT_SETTING: &str = "research_workspace_root";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroStatus {
    pub available: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroItem {
    pub key: String,
    pub item_type: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: String,
    pub publication: String,
    pub publisher: String,
    pub doi: String,
    pub url: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncthingStatus {
    pub available: bool,
    pub folder_id: Option<String>,
    pub folder_path: Option<String>,
    pub state: String,
    pub connected_devices: usize,
    pub need_bytes: u64,
    pub conflict_files: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchConnectionStatus {
    pub configured: bool,
    pub reachable: bool,
    pub endpoint: Option<String>,
    pub authenticated: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchWorkspaceStatus {
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSource {
    #[serde(alias = "source_id")]
    pub id: String,
    pub title: String,
    pub url: String,
    pub publisher: String,
    #[serde(alias = "checked_at", alias = "accessed_at")]
    pub checked_at: String,
    #[serde(alias = "source_tier")]
    pub classification: String,
    #[serde(alias = "citation_markdown")]
    pub citation_markdown: String,
    #[serde(default, alias = "source_card")]
    pub summary: String,
}

#[derive(Debug, Deserialize)]
struct SyncthingFolder {
    id: String,
    path: String,
}

pub async fn zotero_status() -> ZoteroStatus {
    let client = local_client();
    match client
        .get(format!("{ZOTERO_BASE}/api/users/0/items"))
        .query(&[("v", "3"), ("limit", "1")])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => ZoteroStatus {
            available: true,
            message: "Zotero 로컬 라이브러리에 연결되었습니다.".to_string(),
        },
        Ok(response) if response.status().as_u16() == 403 => ZoteroStatus {
            available: false,
            message: "Zotero 설정에서 ‘다른 응용 프로그램이 이 컴퓨터의 Zotero와 통신하도록 허용’을 켜주세요."
                .to_string(),
        },
        _ => ZoteroStatus {
            available: false,
            message: "Zotero가 실행 중인지 확인해주세요.".to_string(),
        },
    }
}

pub async fn zotero_search(query: &str) -> Result<Vec<ZoteroItem>, String> {
    let response = local_client()
        .get(format!("{ZOTERO_BASE}/api/users/0/items"))
        .query(&[
            ("v", "3"),
            ("q", query.trim()),
            ("limit", "50"),
            ("itemType", "-attachment"),
            ("sort", "dateModified"),
            ("direction", "desc"),
        ])
        .send()
        .await
        .map_err(|error| format!("Zotero에 연결할 수 없습니다: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Zotero가 요청을 거절했습니다: HTTP {}",
            response.status()
        ));
    }
    let rows = response
        .json::<Vec<Value>>()
        .await
        .map_err(|error| format!("Zotero 응답을 읽을 수 없습니다: {error}"))?;
    Ok(rows.iter().filter_map(zotero_item_from_value).collect())
}

pub fn format_zotero_citation(
    item: &ZoteroItem,
    style: &str,
    locator: Option<&str>,
    prefix: Option<&str>,
    suffix: Option<&str>,
) -> String {
    let authors = if item.authors.is_empty() {
        item.publisher
            .trim()
            .to_string()
            .or_else_if_empty("저자 미상")
    } else {
        item.authors.join(", ")
    };
    let year = item.year.trim().or_else_if_empty("발행연도 미상");
    let publication = item.publication.trim();
    let locator = locator
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(", {value}"))
        .unwrap_or_default();
    let link = if !item.doi.trim().is_empty() {
        format!(
            "https://doi.org/{}",
            item.doi.trim().trim_start_matches("https://doi.org/")
        )
    } else {
        item.url.trim().to_string()
    };
    let link_part = if link.is_empty() {
        String::new()
    } else {
        format!(", {link}")
    };
    let core = match style {
        "apa" => format!(
            "{authors} ({year}). {}.{}{link_part}",
            item.title.trim(),
            if publication.is_empty() {
                String::new()
            } else {
                format!(" *{publication}*.")
            }
        ),
        "chicago" => format!(
            "{authors}. “{}.” {} ({year}){locator}{link_part}.",
            item.title.trim(),
            if publication.is_empty() {
                item.publisher.trim().to_string()
            } else {
                format!("*{publication}*")
            }
        ),
        _ => format!(
            "{authors}, “{},” {} ({year}){locator}{link_part}.",
            item.title.trim(),
            if publication.is_empty() {
                item.publisher.trim().to_string()
            } else {
                format!("*{publication}*")
            }
        ),
    };
    let leading = prefix.unwrap_or_default().trim();
    let separator = if leading.is_empty() { "" } else { " " };
    let trailing = suffix
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(" {value}"))
        .unwrap_or_default();
    format!("{leading}{separator}{}{trailing}", core.trim())
}

pub async fn syncthing_status(document_path: &str) -> SyncthingStatus {
    let Some(config) = read_syncthing_config() else {
        return SyncthingStatus {
            available: false,
            folder_id: None,
            folder_path: None,
            state: "unavailable".to_string(),
            connected_devices: 0,
            need_bytes: 0,
            conflict_files: Vec::new(),
            message: "로컬 Syncthing 설정을 찾지 못했습니다.".to_string(),
        };
    };
    let client = local_client();
    let folders = match client
        .get(format!("{}/rest/config/folders", config.base_url))
        .header("X-API-Key", &config.api_key)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<Vec<SyncthingFolder>>()
            .await
            .unwrap_or_default(),
        _ => {
            return SyncthingStatus {
                available: false,
                folder_id: None,
                folder_path: None,
                state: "unreachable".to_string(),
                connected_devices: 0,
                need_bytes: 0,
                conflict_files: Vec::new(),
                message: "Syncthing 로컬 API에 연결할 수 없습니다.".to_string(),
            };
        }
    };
    let document = canonical_or_original(Path::new(document_path));
    let matching = folders
        .into_iter()
        .filter_map(|folder| {
            let path = canonical_or_original(Path::new(&folder.path));
            document.starts_with(&path).then_some((folder, path))
        })
        .max_by_key(|(_, path)| path.components().count());
    let Some((folder, folder_path)) = matching else {
        return SyncthingStatus {
            available: true,
            folder_id: None,
            folder_path: None,
            state: "not-synced".to_string(),
            connected_devices: connected_syncthing_devices(&client, &config).await,
            need_bytes: 0,
            conflict_files: Vec::new(),
            message: "이 원고는 Syncthing 폴더 밖에 있습니다.".to_string(),
        };
    };
    let status = client
        .get(format!("{}/rest/db/status", config.base_url))
        .header("X-API-Key", &config.api_key)
        .query(&[("folder", folder.id.as_str())])
        .send()
        .await
        .ok()
        .and_then(|response| response.error_for_status().ok());
    let payload = match status {
        Some(response) => response.json::<Value>().await.unwrap_or_else(|_| json!({})),
        None => json!({}),
    };
    let need_bytes = payload
        .get("needBytes")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let state = payload
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or(if need_bytes == 0 { "idle" } else { "syncing" })
        .to_string();
    let conflicts = find_syncthing_conflicts(&folder_path);
    SyncthingStatus {
        available: true,
        folder_id: Some(folder.id),
        folder_path: Some(folder_path.to_string_lossy().to_string()),
        state: state.clone(),
        connected_devices: connected_syncthing_devices(&client, &config).await,
        need_bytes,
        conflict_files: conflicts,
        message: if need_bytes == 0 && state == "idle" {
            "동기화됨".to_string()
        } else {
            "Syncthing이 변경 사항을 동기화하고 있습니다.".to_string()
        },
    }
}

pub fn configure_research_agent(
    db: &MetadataDb,
    platform: &PlatformServices,
    endpoint: &str,
    token: &str,
) -> Result<(), String> {
    let normalized = normalize_research_endpoint(endpoint)?;
    db.set_setting(RESEARCH_ENDPOINT_SETTING, &normalized)?;
    platform.credentials.set_research_token(token)
}

pub fn clear_research_agent(db: &MetadataDb, platform: &PlatformServices) -> Result<(), String> {
    db.set_setting(RESEARCH_ENDPOINT_SETTING, "")?;
    platform.credentials.clear_research_token()
}

pub fn configure_research_workspace(db: &MetadataDb, path: &str) -> Result<(), String> {
    let root = PathBuf::from(path.trim());
    if !root.is_absolute() || !root.is_dir() {
        return Err("Research 작업 폴더는 존재하는 절대경로여야 합니다.".to_string());
    }
    db.set_setting(
        RESEARCH_ROOT_SETTING,
        &canonical_or_original(&root).to_string_lossy(),
    )
}

pub fn research_workspace_status(db: &MetadataDb) -> ResearchWorkspaceStatus {
    match research_workspace_root(db) {
        Some(path) if path.is_dir() => ResearchWorkspaceStatus {
            available: true,
            path: Some(path.to_string_lossy().to_string()),
            message: "로컬 Research 출처 카드를 사용할 수 있습니다.".to_string(),
        },
        Some(path) => ResearchWorkspaceStatus {
            available: false,
            path: Some(path.to_string_lossy().to_string()),
            message: "설정한 Research 작업 폴더를 찾을 수 없습니다.".to_string(),
        },
        None => ResearchWorkspaceStatus {
            available: false,
            path: None,
            message: "로컬 Research 작업 폴더를 선택할 수 있습니다.".to_string(),
        },
    }
}

pub async fn research_connection_status(
    db: &MetadataDb,
    platform: &PlatformServices,
) -> ResearchConnectionStatus {
    let endpoint = db
        .get_setting(RESEARCH_ENDPOINT_SETTING)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty());
    let Some(endpoint) = endpoint else {
        return ResearchConnectionStatus {
            configured: false,
            reachable: false,
            endpoint: None,
            authenticated: false,
            message: "Research Agent를 연결하면 깊은 조사를 요청할 수 있습니다.".to_string(),
        };
    };
    let reachable = local_client()
        .get(format!("{endpoint}/health"))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success());
    let token = platform.credentials.research_token().ok().flatten();
    let authenticated = if let Some(token) = token {
        research_request(&endpoint, &token, "/research-folders")
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    } else {
        false
    };
    ResearchConnectionStatus {
        configured: true,
        reachable,
        endpoint: Some(endpoint),
        authenticated,
        message: if authenticated {
            "Research Agent에 안전하게 연결되었습니다.".to_string()
        } else if reachable {
            "서버에는 연결했지만 인증 토큰을 확인할 수 없습니다.".to_string()
        } else {
            "Research Agent 서버에 연결할 수 없습니다.".to_string()
        },
    }
}

pub async fn research_folders(
    db: &MetadataDb,
    platform: &PlatformServices,
) -> Result<Value, String> {
    if let Ok((endpoint, token)) = research_credentials(db, platform)
        && let Ok(response) = research_request(&endpoint, &token, "/research-folders")
            .send()
            .await
        && response.status().is_success()
    {
        return parse_research_response(response).await;
    }
    local_research_folders(db)
}

pub async fn research_sources(
    db: &MetadataDb,
    platform: &PlatformServices,
    slug: &str,
) -> Result<Vec<ResearchSource>, String> {
    validate_slug(slug)?;
    if let Ok((endpoint, token)) = research_credentials(db, platform)
        && let Ok(response) = research_request(
            &endpoint,
            &token,
            &format!("/research-folders/{slug}/sources"),
        )
        .send()
        .await
        && response.status().is_success()
    {
        let payload = parse_research_response(response).await?;
        let rows = payload
            .get("sources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        return Ok(rows
            .into_iter()
            .filter_map(|row| serde_json::from_value::<ResearchSource>(row).ok())
            .collect());
    }
    let root = research_workspace_root(db)
        .filter(|path| path.is_dir())
        .ok_or_else(|| {
            "서버 출처 API를 사용할 수 없고 로컬 Research 작업 폴더도 없습니다.".to_string()
        })?;
    local_research_sources(&root, slug)
}

pub async fn start_research(
    db: &MetadataDb,
    platform: &PlatformServices,
    topic: &str,
) -> Result<Value, String> {
    if topic.trim().chars().count() < 3 {
        return Err("조사 주제를 조금 더 구체적으로 적어주세요.".to_string());
    }
    let (endpoint, token) = research_credentials(db, platform)?;
    let response = local_client()
        .post(format!("{endpoint}/research-folders/start"))
        .bearer_auth(token)
        .json(&json!({ "topic": topic.trim() }))
        .send()
        .await
        .map_err(|error| format!("Research Agent에 조사를 요청할 수 없습니다: {error}"))?;
    parse_research_response(response).await
}

fn zotero_item_from_value(value: &Value) -> Option<ZoteroItem> {
    let data = value.get("data")?;
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let authors = data
        .get("creators")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|creator| {
            let name = creator
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
            let first = creator
                .get("firstName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let last = creator
                .get("lastName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let full = format!("{first} {last}").trim().to_string();
            (!full.is_empty()).then_some(full)
        })
        .collect::<Vec<_>>();
    let date = data
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let year = date
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .unwrap_or("")
        .to_string();
    Some(ZoteroItem {
        key: value
            .get("key")
            .or_else(|| data.get("key"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        item_type: data
            .get("itemType")
            .and_then(Value::as_str)
            .unwrap_or("document")
            .to_string(),
        title,
        authors,
        year,
        publication: data
            .get("publicationTitle")
            .or_else(|| data.get("blogTitle"))
            .or_else(|| data.get("websiteTitle"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        publisher: data
            .get("publisher")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        doi: data
            .get("DOI")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        url: data
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        date,
    })
}

struct SyncthingConfig {
    base_url: String,
    api_key: String,
}

fn read_syncthing_config() -> Option<SyncthingConfig> {
    for path in syncthing_config_paths() {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(document) = Document::parse(&content) else {
            continue;
        };
        let Some(gui) = document.descendants().find(|node| node.has_tag_name("gui")) else {
            continue;
        };
        let Some(api_key) = gui
            .children()
            .find(|node| node.has_tag_name("apikey"))
            .and_then(|node| node.text())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let api_key = api_key.trim().to_string();
        let Some(address) = gui
            .children()
            .filter(|node| node.has_tag_name("address"))
            .filter_map(|node| node.text())
            .map(str::trim)
            .find(|value| !value.is_empty() && !value.starts_with("unix"))
        else {
            continue;
        };
        let base_url = if address.starts_with("http://") || address.starts_with("https://") {
            address.to_string()
        } else {
            format!("http://{address}")
        };
        return Some(SyncthingConfig { base_url, api_key });
    }
    None
}

fn syncthing_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/state/syncthing/config.xml"));
        paths.push(home.join(".config/syncthing/config.xml"));
        paths.push(home.join("Library/Application Support/Syncthing/config.xml"));
    }
    if let Some(local) = dirs::data_local_dir() {
        paths.push(local.join("Syncthing/config.xml"));
    }
    paths
}

async fn connected_syncthing_devices(client: &Client, config: &SyncthingConfig) -> usize {
    let payload = match client
        .get(format!("{}/rest/system/connections", config.base_url))
        .header("X-API-Key", &config.api_key)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            response.json::<Value>().await.unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    };
    payload
        .get("connections")
        .and_then(Value::as_object)
        .map(|connections| {
            connections
                .values()
                .filter(|connection| {
                    connection
                        .get("connected")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or_default()
}

fn find_syncthing_conflicts(root: &Path) -> Vec<String> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".sync-conflict-")
        })
        .take(50)
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn research_workspace_root(db: &MetadataDb) -> Option<PathBuf> {
    if let Ok(Some(path)) = db.get_setting(RESEARCH_ROOT_SETTING)
        && !path.trim().is_empty()
    {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("RESEARCH_WRITER_RESEARCH_ROOT")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Some(path);
    }
    dirs::home_dir()
        .map(|home| home.join("Research"))
        .filter(|path| path.is_dir())
}

fn local_research_folders(db: &MetadataDb) -> Result<Value, String> {
    let root = research_workspace_root(db)
        .filter(|path| path.is_dir())
        .ok_or_else(|| {
            "Research Agent 연결 또는 로컬 Research 작업 폴더가 필요합니다.".to_string()
        })?;
    let mut folders = fs::read_dir(&root)
        .map_err(|error| format!("Research 작업 폴더를 읽을 수 없습니다: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let slug = entry.file_name().to_string_lossy().to_string();
            if validate_slug(&slug).is_err()
                || !entry.path().join("_work/source_index.jsonl").is_file()
            {
                return None;
            }
            let title = research_folder_title(&entry.path()).unwrap_or_else(|| slug.clone());
            let source_count = count_jsonl_rows(&entry.path().join("_work/source_index.jsonl"));
            Some(json!({
                "slug": slug,
                "title": title,
                "stage": "local",
                "source_count": source_count
            }))
        })
        .collect::<Vec<_>>();
    folders.sort_by(|left, right| {
        left.get("title")
            .and_then(Value::as_str)
            .cmp(&right.get("title").and_then(Value::as_str))
    });
    Ok(json!({ "research_folders": folders, "source": "local" }))
}

fn local_research_sources(root: &Path, slug: &str) -> Result<Vec<ResearchSource>, String> {
    validate_slug(slug)?;
    let folder = root.join(slug);
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Research 작업 폴더를 확인할 수 없습니다: {error}"))?;
    let canonical_folder = folder
        .canonicalize()
        .map_err(|_| "선택한 리서치 폴더를 찾을 수 없습니다.".to_string())?;
    if !canonical_folder.starts_with(&canonical_root) {
        return Err("Research 작업 폴더 밖의 출처는 읽을 수 없습니다.".to_string());
    }
    let index = canonical_folder.join("_work/source_index.jsonl");
    let file =
        fs::File::open(&index).map_err(|error| format!("출처 색인을 읽을 수 없습니다: {error}"))?;
    let cards = canonical_folder.join("_work/source_cards");
    let mut sources = Vec::new();
    for line in BufReader::new(file).lines().take(1_000) {
        let Ok(line) = line else {
            continue;
        };
        if line.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = text_field(&row, &["source_id", "id"]);
        if id.is_empty() {
            continue;
        }
        let title = text_field(&row, &["title", "name"]).or_else_if_empty(&id);
        let url = text_field(&row, &["canonical_url", "url"]);
        let publisher = text_field(&row, &["publisher"]);
        let checked_at = text_field(&row, &["accessed_at", "checked_at", "modified_at"]);
        let source_tier = text_field(&row, &["source_tier", "classification"]);
        let reliability = text_field(&row, &["reliability"]);
        let classification = [source_tier.as_str(), reliability.as_str()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
        let summary = read_source_card(&cards, &id).unwrap_or_default();
        let citation_markdown = research_citation(
            &title,
            &publisher,
            &text_field(&row, &["published_at"]),
            &url,
            &checked_at,
        );
        sources.push(ResearchSource {
            id,
            title,
            url,
            publisher,
            checked_at,
            classification,
            citation_markdown,
            summary,
        });
    }
    Ok(sources)
}

fn research_folder_title(folder: &Path) -> Option<String> {
    let brief = fs::read_to_string(folder.join("brief.md")).ok()?;
    brief
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn count_jsonl_rows(path: &Path) -> usize {
    fs::File::open(path)
        .ok()
        .map(BufReader::new)
        .map(|reader| reader.lines().map_while(Result::ok).count())
        .unwrap_or_default()
}

fn text_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn source_card_context(content: &str) -> String {
    let body = content
        .find("## 핵심 요약")
        .map(|index| &content[index..])
        .unwrap_or(content);
    body.chars().take(6_000).collect()
}

fn read_source_card(cards: &Path, source_id: &str) -> Option<String> {
    if source_id.is_empty()
        || source_id.starts_with('.')
        || !source_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return None;
    }
    let canonical_cards = cards.canonicalize().ok()?;
    let card = cards.join(format!("{source_id}.md")).canonicalize().ok()?;
    if !card.starts_with(canonical_cards) {
        return None;
    }
    fs::read_to_string(card)
        .ok()
        .map(|content| source_card_context(&content))
}

fn research_citation(
    title: &str,
    publisher: &str,
    published_at: &str,
    url: &str,
    checked_at: &str,
) -> String {
    let author = publisher.trim().or_else_if_empty("발행처 미상");
    let year = published_at
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .unwrap_or("발행연도 미상");
    let mut citation = format!("{author}, “{},” {year}", title.trim());
    if !url.trim().is_empty() {
        citation.push_str(&format!(", {}", url.trim()));
    }
    if !checked_at.trim().is_empty() {
        let date = checked_at.trim().chars().take(10).collect::<String>();
        citation.push_str(&format!(" (확인 {date})"));
    }
    citation.push('.');
    citation
}

fn local_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| Client::new())
}

fn research_credentials(
    db: &MetadataDb,
    platform: &PlatformServices,
) -> Result<(String, String), String> {
    let endpoint = db
        .get_setting(RESEARCH_ENDPOINT_SETTING)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Research Agent 주소를 먼저 설정해주세요.".to_string())?;
    let token = platform
        .credentials
        .research_token()?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Research Agent 인증 토큰을 다시 입력해주세요.".to_string())?;
    Ok((endpoint, token))
}

fn normalize_research_endpoint(value: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(value.trim())
        .map_err(|_| "Research Agent 주소가 올바른 URL이 아닙니다.".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Research Agent 주소에는 계정 정보, 쿼리 또는 조각을 넣을 수 없습니다.".to_string(),
        );
    }
    let host = parsed.host_str().unwrap_or_default();
    let local_http =
        parsed.scheme() == "http" && matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost");
    if parsed.scheme() != "https" && !local_http {
        return Err("Research Agent 주소는 HTTPS 또는 로컬호스트 HTTP여야 합니다.".to_string());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn research_request(endpoint: &str, token: &str, path: &str) -> reqwest::RequestBuilder {
    local_client()
        .get(format!("{}{}", endpoint.trim_end_matches('/'), path))
        .bearer_auth(token)
}

async fn parse_research_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Research Agent 응답을 읽을 수 없습니다: {error}"))?;
    if status.is_success() {
        Ok(payload)
    } else {
        let detail = payload
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("요청이 실패했습니다.");
        Err(format!("Research Agent 오류(HTTP {status}): {detail}"))
    }
}

fn validate_slug(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('.')
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("리서치 식별자가 올바르지 않습니다.".to_string());
    }
    Ok(())
}

trait EmptyFallback {
    fn or_else_if_empty(self, fallback: &str) -> String;
}

impl EmptyFallback for String {
    fn or_else_if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

impl EmptyFallback for &str {
    fn or_else_if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    #[test]
    fn formats_a_portable_research_footnote_body() {
        let item = ZoteroItem {
            key: "ABC".to_string(),
            item_type: "journalArticle".to_string(),
            title: "Local-first writing".to_string(),
            authors: vec!["Kim Tain".to_string()],
            year: "2026".to_string(),
            publication: "Writing Systems".to_string(),
            publisher: String::new(),
            doi: "10.1000/example".to_string(),
            url: String::new(),
            date: "2026-07-01".to_string(),
        };
        let citation = format_zotero_citation(&item, "research", Some("p. 14"), None, None);
        assert_eq!(
            citation,
            "Kim Tain, “Local-first writing,” *Writing Systems* (2026), p. 14, https://doi.org/10.1000/example."
        );
    }

    #[test]
    fn parses_zotero_creators_and_year() {
        let item = zotero_item_from_value(&json!({
            "key": "K1",
            "data": {
                "itemType": "book",
                "title": "테스트",
                "date": "2024-05",
                "creators": [{"firstName": "길동", "lastName": "홍"}]
            }
        }))
        .unwrap();
        assert_eq!(item.authors, vec!["길동 홍"]);
        assert_eq!(item.year, "2024");
    }

    #[test]
    fn reads_local_research_index_and_source_card() {
        let directory = tempdir().unwrap();
        let research = directory.path().join("topic");
        fs::create_dir_all(research.join("_work/source_cards")).unwrap();
        fs::write(
            research.join("_work/source_index.jsonl"),
            serde_json::to_string(&json!({
                "source_id": "S001",
                "title": "Official guidance",
                "canonical_url": "https://example.com/guidance",
                "publisher": "Example Authority",
                "published_at": "2025-06-01",
                "accessed_at": "2026-07-28",
                "source_tier": "primary",
                "reliability": "A"
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            research.join("_work/source_cards/S001.md"),
            "# S001\n\n## 메타데이터\n\n- private path\n\n## 핵심 요약\n\n공식 지침의 범위를 설명한다.\n",
        )
        .unwrap();

        let sources = local_research_sources(directory.path(), "topic").unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].classification, "primary / A");
        assert!(sources[0].summary.starts_with("## 핵심 요약"));
        assert!(!sources[0].summary.contains("private path"));
        assert_eq!(
            sources[0].citation_markdown,
            "Example Authority, “Official guidance,” 2025, https://example.com/guidance (확인 2026-07-28)."
        );
    }

    #[test]
    fn validates_research_agent_transport_and_host() {
        assert_eq!(
            normalize_research_endpoint("https://research.example/api/").unwrap(),
            "https://research.example/api"
        );
        assert!(normalize_research_endpoint("http://127.0.0.1:18000").is_ok());
        assert!(normalize_research_endpoint("http://127.0.0.1.attacker.example").is_err());
        assert!(normalize_research_endpoint("https://user:secret@example.com").is_err());
    }

    #[test]
    fn source_card_reader_rejects_path_traversal() {
        let directory = tempdir().unwrap();
        let cards = directory.path().join("cards");
        fs::create_dir(&cards).unwrap();
        fs::write(directory.path().join("secret.md"), "private").unwrap();

        assert!(read_source_card(&cards, "../secret").is_none());
    }

    #[test]
    fn finds_syncthing_conflict_copies() {
        let directory = tempdir().unwrap();
        let conflict = directory
            .path()
            .join("draft.sync-conflict-20260728-135900-DEVICE.md");
        fs::write(&conflict, "other device").unwrap();
        fs::write(directory.path().join("draft.md"), "current").unwrap();

        assert_eq!(
            find_syncthing_conflicts(directory.path()),
            vec![conflict.to_string_lossy().to_string()]
        );
    }
}
