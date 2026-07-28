mod codex;
mod database;
mod document;
mod integrations;
mod platform;

use codex::{AiAccountStatus, AiLoginStart, AiWritingRequest, AiWritingResponse, CodexBridge};
use database::{MetadataDb, RecentDocument, SearchResult, StoredVersion, VersionSummary};
use document::{DocumentPayload, MergeResult, SaveDocumentRequest, SaveDocumentResult};
use integrations::{
    ResearchConnectionStatus, ResearchSource, ResearchWorkspaceStatus, SyncthingStatus, ZoteroItem,
    ZoteroStatus,
};
use platform::{FontRecord, FontService, PlatformServices, SystemIntegration};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, State};

struct AppState {
    database: MetadataDb,
    platform: PlatformServices,
    codex: Arc<CodexBridge>,
}

#[tauri::command]
fn read_document(path: String, state: State<'_, AppState>) -> Result<DocumentPayload, String> {
    let document = document::read_document(Path::new(&path))?;
    state.database.touch_recent(&document.path)?;
    Ok(document)
}

#[tauri::command]
fn save_document(
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> Result<SaveDocumentResult, String> {
    let result = document::save_document(&request)?;
    if result.status == "saved" {
        state.database.touch_recent(&request.path)?;
    }
    Ok(result)
}

#[tauri::command]
fn convert_document_to_utf8(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentPayload, String> {
    let current = document::read_document(Path::new(&path))?;
    state
        .database
        .snapshot(&current.path, &current.content, "conversion", None)?;
    document::convert_document_to_utf8(Path::new(&path))
}

#[tauri::command]
fn merge_three_way(base: String, local: String, remote: String) -> MergeResult {
    document::merge_three_way(&base, &local, &remote)
}

#[tauri::command]
fn parent_directory(path: String) -> Result<String, String> {
    database::parent_directory(&path)
}

#[tauri::command]
fn startup_document(state: State<'_, AppState>) -> Option<String> {
    state.platform.system.startup_markdown_path()
}

#[tauri::command]
fn list_fonts(state: State<'_, AppState>) -> Result<Vec<FontRecord>, String> {
    state.platform.fonts.list()
}

#[tauri::command]
fn watch_document(
    app: tauri::AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.platform.watchers.watch(app, &path)
}

#[tauri::command]
fn unwatch_document(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.platform.watchers.unwatch(&path)
}

#[tauri::command]
fn create_version(
    path: String,
    content: String,
    kind: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<VersionSummary, String> {
    state
        .database
        .snapshot(&path, &content, &kind, name.as_deref())
}

#[tauri::command]
fn list_versions(path: String, state: State<'_, AppState>) -> Result<Vec<VersionSummary>, String> {
    state.database.list_versions(&path)
}

#[tauri::command]
fn load_version(id: String, state: State<'_, AppState>) -> Result<StoredVersion, String> {
    state.database.load_version(&id)
}

#[tauri::command]
fn recent_documents(state: State<'_, AppState>) -> Result<Vec<RecentDocument>, String> {
    state.database.recent_documents()
}

#[tauri::command]
fn index_workspace(root: String, state: State<'_, AppState>) -> Result<usize, String> {
    state.database.index_workspace(Path::new(&root))
}

#[tauri::command]
fn search_workspace(
    root: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    state.database.search(Path::new(&root), &query)
}

#[tauri::command]
async fn ai_account_status(state: State<'_, AppState>) -> Result<AiAccountStatus, String> {
    let codex = state.codex.clone();
    tauri::async_runtime::spawn_blocking(move || codex.account_status())
        .await
        .map_err(|error| format!("AI 계정 확인 작업이 중단되었습니다: {error}"))
}

#[tauri::command]
async fn ai_login_start(
    device_code: bool,
    state: State<'_, AppState>,
) -> Result<AiLoginStart, String> {
    let codex = state.codex.clone();
    tauri::async_runtime::spawn_blocking(move || codex.start_login(device_code))
        .await
        .map_err(|error| format!("AI 로그인 작업이 중단되었습니다: {error}"))?
}

#[tauri::command]
async fn run_ai_writing(
    request: AiWritingRequest,
    state: State<'_, AppState>,
) -> Result<AiWritingResponse, String> {
    let codex = state.codex.clone();
    tauri::async_runtime::spawn_blocking(move || codex.run_writing_assistant(&request))
        .await
        .map_err(|error| format!("AI 작문 작업이 중단되었습니다: {error}"))?
}

#[tauri::command]
async fn zotero_status() -> ZoteroStatus {
    integrations::zotero_status().await
}

#[tauri::command]
async fn zotero_search(query: String) -> Result<Vec<ZoteroItem>, String> {
    integrations::zotero_search(&query).await
}

#[tauri::command]
fn format_zotero_citation(
    item: ZoteroItem,
    style: String,
    locator: Option<String>,
    prefix: Option<String>,
    suffix: Option<String>,
) -> String {
    integrations::format_zotero_citation(
        &item,
        &style,
        locator.as_deref(),
        prefix.as_deref(),
        suffix.as_deref(),
    )
}

#[tauri::command]
async fn syncthing_status(path: String) -> SyncthingStatus {
    integrations::syncthing_status(&path).await
}

#[tauri::command]
fn configure_research_agent(
    endpoint: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    integrations::configure_research_agent(&state.database, &state.platform, &endpoint, &token)
}

#[tauri::command]
fn clear_research_agent(state: State<'_, AppState>) -> Result<(), String> {
    integrations::clear_research_agent(&state.database, &state.platform)
}

#[tauri::command]
fn configure_research_workspace(path: String, state: State<'_, AppState>) -> Result<(), String> {
    integrations::configure_research_workspace(&state.database, &path)
}

#[tauri::command]
fn research_workspace_status(state: State<'_, AppState>) -> ResearchWorkspaceStatus {
    integrations::research_workspace_status(&state.database)
}

#[tauri::command]
async fn research_connection_status(
    state: State<'_, AppState>,
) -> Result<ResearchConnectionStatus, String> {
    Ok(integrations::research_connection_status(&state.database, &state.platform).await)
}

#[tauri::command]
async fn research_folders(state: State<'_, AppState>) -> Result<Value, String> {
    integrations::research_folders(&state.database, &state.platform).await
}

#[tauri::command]
async fn research_sources(
    slug: String,
    state: State<'_, AppState>,
) -> Result<Vec<ResearchSource>, String> {
    integrations::research_sources(&state.database, &state.platform, &slug).await
}

#[tauri::command]
async fn start_research(topic: String, state: State<'_, AppState>) -> Result<Value, String> {
    integrations::start_research(&state.database, &state.platform, &topic).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let database = MetadataDb::open(&data_directory.join("metadata.sqlite3"))
                .map_err(std::io::Error::other)?;
            let session_directory = data_directory.join("ai-session");
            app.manage(AppState {
                database,
                platform: PlatformServices::default(),
                codex: Arc::new(CodexBridge::new(session_directory)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_document,
            save_document,
            convert_document_to_utf8,
            merge_three_way,
            parent_directory,
            startup_document,
            list_fonts,
            watch_document,
            unwatch_document,
            create_version,
            list_versions,
            load_version,
            recent_documents,
            index_workspace,
            search_workspace,
            ai_account_status,
            ai_login_start,
            run_ai_writing,
            zotero_status,
            zotero_search,
            format_zotero_citation,
            syncthing_status,
            configure_research_agent,
            clear_research_agent,
            configure_research_workspace,
            research_workspace_status,
            research_connection_status,
            research_folders,
            research_sources,
            start_research
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
