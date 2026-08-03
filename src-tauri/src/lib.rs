mod assets;
mod codex;
mod database;
mod document;
mod integrations;
mod manuscript;
mod platform;

use codex::{AiGrammarRequest, AiWritingRequest, CodexBridge};
use database::MetadataDb;
use document::SaveDocumentRequest;
use integrations::ZoteroItem;
use platform::{BackendEvent, FontService, PlatformServices, SystemIntegration};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};

pub struct AppState {
    database: MetadataDb,
    platform: PlatformServices,
    codex: Arc<CodexBridge>,
}

impl AppState {
    fn open(data_directory: &Path, events: mpsc::Sender<BackendEvent>) -> Result<Self, String> {
        Ok(Self {
            database: MetadataDb::open(&data_directory.join("metadata.sqlite3"))?,
            platform: PlatformServices::new(events),
            codex: Arc::new(CodexBridge::new(data_directory.join("ai-session"))),
        })
    }

    fn repository_path(&self) -> Result<Option<PathBuf>, String> {
        Ok(manuscript::repository_status(&self.database)?
            .path
            .map(PathBuf::from))
    }
}

fn required<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let value = args
        .get(key)
        .cloned()
        .ok_or_else(|| format!("{key} 인수가 없습니다."))?;
    serde_json::from_value(value)
        .map_err(|error| format!("{key} 인수가 올바르지 않습니다: {error}"))
}

fn optional<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("{key} 인수가 올바르지 않습니다: {error}")),
    }
}

fn output<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("응답을 만들 수 없습니다: {error}"))
}

pub async fn dispatch(state: Arc<AppState>, command: &str, args: Value) -> Result<Value, String> {
    match command {
        "import_manuscript_asset" => output(assets::import_asset(
            &state.database,
            &required::<String>(&args, "documentPath")?,
            &required::<String>(&args, "sourcePath")?,
        )?),
        "read_manuscript_asset" => output(assets::read_asset(
            &state.database,
            &required::<String>(&args, "documentPath")?,
            &required::<String>(&args, "relativePath")?,
        )?),
        "get_runtime_platform" => output(std::env::consts::OS),
        "read_document" => {
            let document = document::read_document(Path::new(&required::<String>(&args, "path")?))?;
            state.database.touch_recent(&document.path)?;
            manuscript::remember_document_if_in_repository(&state.database, &document.path)?;
            output(document)
        }
        "save_document" => {
            let request = required::<SaveDocumentRequest>(&args, "request")?;
            let result = document::save_document(&request)?;
            if result.status == "saved" {
                state.database.touch_recent(&request.path)?;
            }
            output(result)
        }
        "convert_document_to_utf8" => {
            let path = required::<String>(&args, "path")?;
            let current = document::read_document(Path::new(&path))?;
            state
                .database
                .snapshot(&current.path, &current.content, "conversion", None)?;
            output(document::convert_document_to_utf8(Path::new(&path))?)
        }
        "merge_three_way" => output(document::merge_three_way(
            &required::<String>(&args, "base")?,
            &required::<String>(&args, "local")?,
            &required::<String>(&args, "remote")?,
        )),
        "startup_document" => output(state.platform.system.startup_markdown_path()),
        "list_fonts" => {
            let repository = state.repository_path()?;
            output(state.platform.fonts.list(repository.as_deref())?)
        }
        "import_repository_font" => {
            let repository = state
                .repository_path()?
                .ok_or_else(|| "폰트를 가져오려면 먼저 저장소를 열어주세요.".to_string())?;
            let source_path = required::<String>(&args, "sourcePath")?;
            output(
                state
                    .platform
                    .fonts
                    .import(&repository, Path::new(&source_path))?,
            )
        }
        "watch_document" => {
            state
                .platform
                .watchers
                .watch(&required::<String>(&args, "path")?)?;
            Ok(Value::Null)
        }
        "unwatch_document" => {
            state
                .platform
                .watchers
                .unwatch(&required::<String>(&args, "path")?)?;
            Ok(Value::Null)
        }
        "watch_repository" => {
            state
                .platform
                .watchers
                .watch_repository(&required::<String>(&args, "path")?)?;
            Ok(Value::Null)
        }
        "unwatch_repository" => {
            state
                .platform
                .watchers
                .unwatch_repository(&required::<String>(&args, "path")?)?;
            Ok(Value::Null)
        }
        "create_version" => output(state.database.snapshot(
            &required::<String>(&args, "path")?,
            &required::<String>(&args, "content")?,
            &required::<String>(&args, "kind")?,
            optional::<String>(&args, "name")?.as_deref(),
        )?),
        "list_versions" => output(
            state
                .database
                .list_versions(&required::<String>(&args, "path")?)?,
        ),
        "load_version" => output(
            state
                .database
                .load_version(&required::<String>(&args, "id")?)?,
        ),
        "recent_documents" => output(state.database.recent_documents()?),
        "repository_status" => output(manuscript::repository_status(&state.database)?),
        "open_repository" => output(manuscript::open_repository(
            &state.database,
            &required::<String>(&args, "path")?,
        )?),
        "close_repository" => output(manuscript::close_repository(&state.database)?),
        "list_repository_documents" => output(manuscript::list_documents(&state.database)?),
        "create_repository_document" => output(manuscript::create_document(&state.database)?),
        "rename_repository_document" => output(manuscript::rename_document(
            &state.database,
            &required::<String>(&args, "path")?,
            &required::<String>(&args, "newName")?,
        )?),
        "trash_repository_document" => {
            manuscript::trash_document(&state.database, &required::<String>(&args, "path")?)?;
            Ok(Value::Null)
        }
        "clear_repository_last_document" => {
            manuscript::clear_last_document(&state.database)?;
            Ok(Value::Null)
        }
        "register_exit_guard" | "complete_app_exit" => Ok(Value::Null),
        "index_workspace" => output(state.database.index_workspace(Path::new(&required::<
            String,
        >(
            &args, "root",
        )?))?),
        "search_workspace" => output(state.database.search(
            Path::new(&required::<String>(&args, "root")?),
            &required::<String>(&args, "query")?,
        )?),
        "ai_account_status" => {
            let codex = state.codex.clone();
            output(
                tokio::task::spawn_blocking(move || codex.account_status())
                    .await
                    .map_err(|error| format!("AI 계정 확인 작업이 중단되었습니다: {error}"))?,
            )
        }
        "ai_login_start" => {
            let codex = state.codex.clone();
            let device_code = required::<bool>(&args, "deviceCode")?;
            output(
                tokio::task::spawn_blocking(move || codex.start_login(device_code))
                    .await
                    .map_err(|error| format!("AI 로그인 작업이 중단되었습니다: {error}"))??,
            )
        }
        "run_ai_writing" => {
            let codex = state.codex.clone();
            let request = required::<AiWritingRequest>(&args, "request")?;
            output(
                tokio::task::spawn_blocking(move || codex.run_writing_assistant(&request))
                    .await
                    .map_err(|error| format!("AI 작문 작업이 중단되었습니다: {error}"))??,
            )
        }
        "run_ai_grammar_check" => {
            let codex = state.codex.clone();
            let request = required::<AiGrammarRequest>(&args, "request")?;
            output(
                tokio::task::spawn_blocking(move || codex.run_grammar_check(&request))
                    .await
                    .map_err(|error| format!("AI 문법 검사 작업이 중단되었습니다: {error}"))??,
            )
        }
        "zotero_status" => output(integrations::zotero_status().await),
        "zotero_search" => {
            output(integrations::zotero_search(&required::<String>(&args, "query")?).await?)
        }
        "format_zotero_citation" => output(integrations::format_zotero_citation(
            &required::<ZoteroItem>(&args, "item")?,
            &required::<String>(&args, "style")?,
            optional::<String>(&args, "locator")?.as_deref(),
            optional::<String>(&args, "prefix")?.as_deref(),
            optional::<String>(&args, "suffix")?.as_deref(),
        )),
        "syncthing_status" => {
            output(integrations::syncthing_status(&required::<String>(&args, "path")?).await)
        }
        "configure_research_agent" => {
            integrations::configure_research_agent(
                &state.database,
                &state.platform,
                &required::<String>(&args, "endpoint")?,
                &required::<String>(&args, "token")?,
            )?;
            Ok(Value::Null)
        }
        "clear_research_agent" => {
            integrations::clear_research_agent(&state.database, &state.platform)?;
            Ok(Value::Null)
        }
        "configure_research_workspace" => {
            integrations::configure_research_workspace(
                &state.database,
                &required::<String>(&args, "path")?,
            )?;
            Ok(Value::Null)
        }
        "research_workspace_status" => {
            output(integrations::research_workspace_status(&state.database))
        }
        "research_connection_status" => {
            output(integrations::research_connection_status(&state.database, &state.platform).await)
        }
        "research_folders" => {
            output(integrations::research_folders(&state.database, &state.platform).await?)
        }
        "research_sources" => output(
            integrations::research_sources(
                &state.database,
                &state.platform,
                &required::<String>(&args, "slug")?,
            )
            .await?,
        ),
        "start_research" => output(
            integrations::start_research(
                &state.database,
                &state.platform,
                &required::<String>(&args, "topic")?,
            )
            .await?,
        ),
        _ => Err(format!("알 수 없는 백엔드 명령입니다: {command}")),
    }
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

fn data_directory() -> PathBuf {
    std::env::var_os("RESEARCH_WRITER_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|path| path.join("com.tain.researchwriter")))
        .unwrap_or_else(|| PathBuf::from(".research-writer"))
}

pub fn run() {
    let (event_sender, event_receiver) = mpsc::channel::<BackendEvent>();
    let (output_sender, output_receiver) = mpsc::channel::<Value>();
    let state = match AppState::open(&data_directory(), event_sender) {
        Ok(state) => Arc::new(state),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        for message in output_receiver {
            if serde_json::to_writer(&mut lock, &message).is_err() {
                break;
            }
            if lock.write_all(b"\n").is_err() || lock.flush().is_err() {
                break;
            }
        }
    });
    let event_output = output_sender.clone();
    let event_forwarder = std::thread::spawn(move || {
        for event in event_receiver {
            let _ = event_output.send(json!({
                "event": event.event,
                "payload": event.payload,
            }));
        }
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime must start");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ =
                    output_sender.send(json!({ "id": Value::Null, "error": error.to_string() }));
                continue;
            }
        };
        let request_state = state.clone();
        let request_output = output_sender.clone();
        runtime.spawn(async move {
            let response = match dispatch(request_state, &request.command, request.args).await {
                Ok(result) => json!({ "id": request.id, "result": result }),
                Err(error) => json!({ "id": request.id, "error": error }),
            };
            let _ = request_output.send(response);
        });
    }
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
    drop(state);
    drop(output_sender);
    let _ = event_forwarder.join();
    let _ = writer.join();
}
