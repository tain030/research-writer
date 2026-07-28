use crate::document::hash_text;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

const AI_MODEL: &str = "gpt-5.6-terra";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(240);
type PendingRequests = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

pub struct CodexBridge {
    process: Mutex<Option<BridgeProcess>>,
    pending: PendingRequests,
    events: Arc<(Mutex<VecDeque<EventRecord>>, Condvar)>,
    next_request_id: AtomicU64,
    next_event_id: Arc<AtomicU64>,
    run_lock: Mutex<()>,
    session_directory: PathBuf,
}

struct BridgeProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Clone)]
struct EventRecord {
    sequence: u64,
    message: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccountStatus {
    pub codex_installed: bool,
    pub codex_version: Option<String>,
    pub authenticated: bool,
    pub account_type: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLoginStart {
    pub login_id: String,
    pub login_type: String,
    pub url: String,
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSourceContext {
    pub id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWritingRequest {
    pub action: String,
    #[serde(default)]
    pub selection: String,
    #[serde(default)]
    pub document_context: String,
    #[serde(default)]
    pub style_reference: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub sources: Vec<AiSourceContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWritingResponse {
    pub replacement: String,
    pub rationale: String,
    pub citations: Vec<String>,
    pub warnings: Vec<String>,
    pub original_hash: String,
    pub model: String,
}

impl CodexBridge {
    pub fn new(session_directory: PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new((Mutex::new(VecDeque::new()), Condvar::new())),
            next_request_id: AtomicU64::new(10),
            next_event_id: Arc::new(AtomicU64::new(0)),
            run_lock: Mutex::new(()),
            session_directory,
        }
    }

    pub fn account_status(&self) -> AiAccountStatus {
        let Some(binary) = resolve_codex_binary() else {
            return AiAccountStatus {
                codex_installed: false,
                codex_version: None,
                authenticated: false,
                account_type: None,
                email: None,
                plan_type: None,
                message:
                    "Codex CLI를 찾지 못했습니다. 설치 후 앱을 다시 열거나 경로를 설정해주세요."
                        .to_string(),
            };
        };
        let version = codex_version(&binary);
        match self.send_request("account/read", json!({ "refreshToken": false })) {
            Ok(result) => {
                let account = result.get("account");
                let account_type = account
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let authenticated = account_type.is_some();
                AiAccountStatus {
                    codex_installed: true,
                    codex_version: version,
                    authenticated,
                    account_type,
                    email: account
                        .and_then(|value| value.get("email"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    plan_type: account
                        .and_then(|value| value.get("planType"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    message: if authenticated {
                        "ChatGPT OAuth로 Codex에 연결되었습니다.".to_string()
                    } else {
                        "AI 작문 보조를 사용하려면 ChatGPT로 로그인해주세요.".to_string()
                    },
                }
            }
            Err(error) => AiAccountStatus {
                codex_installed: true,
                codex_version: version,
                authenticated: false,
                account_type: None,
                email: None,
                plan_type: None,
                message: error,
            },
        }
    }

    pub fn start_login(&self, device_code: bool) -> Result<AiLoginStart, String> {
        let login_type = if device_code {
            "chatgptDeviceCode"
        } else {
            "chatgpt"
        };
        let result = self.send_request(
            "account/login/start",
            if device_code {
                json!({ "type": login_type })
            } else {
                json!({
                    "type": login_type,
                    "appBrand": "codex",
                    "useHostedLoginSuccessPage": true,
                    "codexStreamlinedLogin": true
                })
            },
        )?;
        let url = result
            .get("authUrl")
            .or_else(|| result.get("verificationUrl"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex가 로그인 주소를 반환하지 않았습니다.".to_string())?;
        Ok(AiLoginStart {
            login_id: result
                .get("loginId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            login_type: login_type.to_string(),
            url: url.to_string(),
            user_code: result
                .get("userCode")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        })
    }

    pub fn run_writing_assistant(
        &self,
        request: &AiWritingRequest,
    ) -> Result<AiWritingResponse, String> {
        let _run_guard = self
            .run_lock
            .lock()
            .map_err(|_| "AI 실행 잠금에 실패했습니다.".to_string())?;
        validate_ai_request(request)?;
        let account = self.send_request("account/read", json!({ "refreshToken": false }))?;
        if account.get("account").is_none_or(Value::is_null) {
            return Err("AI 작문 보조를 사용하려면 먼저 ChatGPT로 로그인해주세요.".to_string());
        }
        std::fs::create_dir_all(&self.session_directory)
            .map_err(|error| format!("AI 임시 작업 폴더를 만들 수 없습니다: {error}"))?;
        let marker = self.next_event_id.load(Ordering::SeqCst);
        let effort = if matches!(request.action.as_str(), "complete" | "shorten" | "rewrite") {
            "low"
        } else {
            "high"
        };
        let thread_result = self.send_request(
            "thread/start",
            json!({
                "serviceName": "research_writer",
                "model": AI_MODEL,
                "cwd": self.session_directory.to_string_lossy(),
                "approvalPolicy": "never",
                "ephemeral": true,
                "baseInstructions": base_instructions(),
                "developerInstructions": "Use no tools. Work only with text explicitly supplied by the client. Never read files, run commands, or access the network.",
                "config": {
                    "default_permissions": "research-writer-text-only",
                    "permissions": {
                        "research-writer-text-only": {
                            "description": "Minimal runtime and empty workspace access for text-only writing assistance.",
                            "filesystem": {
                                ":minimal": "read",
                                ":workspace_roots": { ".": "read" }
                            },
                            "network": { "enabled": false }
                        }
                    }
                }
            }),
        )?;
        let thread_id = thread_result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex가 대화 식별자를 반환하지 않았습니다.".to_string())?
            .to_string();
        let turn_result = self.send_request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": build_prompt(request) }],
                "effort": effort,
                "approvalPolicy": "never",
                "outputSchema": output_schema()
            }),
        )?;
        let turn_id = turn_result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex가 작업 식별자를 반환하지 않았습니다.".to_string())?
            .to_string();
        let output = self.wait_for_turn(marker, &thread_id, &turn_id)?;
        let mut parsed = parse_ai_output(&output)?;
        parsed.original_hash = hash_text(&request.selection);
        parsed.model = AI_MODEL.to_string();
        Ok(parsed)
    }

    fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_started()?;
        let request_id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Codex 응답 대기열 잠금에 실패했습니다.".to_string())?
            .insert(request_id, sender);
        let stdin = {
            let process = self
                .process
                .lock()
                .map_err(|_| "Codex 프로세스 잠금에 실패했습니다.".to_string())?;
            process
                .as_ref()
                .map(|process| process.stdin.clone())
                .ok_or_else(|| "Codex App Server가 실행되지 않았습니다.".to_string())?
        };
        let message = json!({ "method": method, "id": request_id, "params": params });
        if let Err(error) = write_message(&stdin, &message) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(error);
        }
        let response = receiver
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| format!("Codex 응답 시간이 초과되었습니다: {method}"))??;
        if let Some(error) = response.get("error") {
            return Err(format_rpc_error(error));
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex 응답에 result가 없습니다.".to_string())
    }

    fn ensure_started(&self) -> Result<(), String> {
        let mut process_guard = self
            .process
            .lock()
            .map_err(|_| "Codex 프로세스 잠금에 실패했습니다.".to_string())?;
        if let Some(process) = process_guard.as_mut() {
            match process.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => {
                    *process_guard = None;
                }
            }
        }
        let binary = resolve_codex_binary().ok_or_else(|| {
            "Codex CLI를 찾지 못했습니다. RESEARCH_WRITER_CODEX_BIN을 설정할 수 있습니다."
                .to_string()
        })?;
        std::fs::create_dir_all(&self.session_directory)
            .map_err(|error| format!("Codex 임시 폴더를 만들 수 없습니다: {error}"))?;
        let mut child = Command::new(binary)
            .arg("app-server")
            .args(["--disable", "shell_tool"])
            .args(["--disable", "unified_exec"])
            .args(["--disable", "apps"])
            .args(["--disable", "browser_use"])
            .args(["--disable", "computer_use"])
            .args(["--disable", "image_generation"])
            .args(["--disable", "multi_agent"])
            .args(["--disable", "plugins"])
            .args(["--disable", "hooks"])
            .args(["-c", "web_search=\"disabled\""])
            .args(["-c", "history.persistence=\"none\""])
            .args(["-c", "allow_login_shell=false"])
            .args(["-c", "mcp_servers={}"])
            .current_dir(&self.session_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Codex App Server를 시작할 수 없습니다: {error}"))?;
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                "Codex 입력 스트림을 열 수 없습니다.".to_string()
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex 출력 스트림을 열 수 없습니다.".to_string())?;
        let mut reader = BufReader::new(stdout);
        write_message(
            &stdin,
            &json!({
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "research_writer",
                        "title": "Research Writer",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
        )?;
        let mut line = String::new();
        let initialized = loop {
            line.clear();
            let count = reader
                .read_line(&mut line)
                .map_err(|error| format!("Codex 초기 응답을 읽을 수 없습니다: {error}"))?;
            if count == 0 {
                break false;
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if message.get("id").and_then(Value::as_u64) == Some(1) {
                if let Some(error) = message.get("error") {
                    return Err(format_rpc_error(error));
                }
                break true;
            }
        };
        if !initialized {
            return Err("Codex App Server가 초기화 중 종료되었습니다.".to_string());
        }
        write_message(&stdin, &json!({ "method": "initialized", "params": {} }))?;

        let pending = self.pending.clone();
        let events = self.events.clone();
        let sequence = self.next_event_id.clone();
        let reader_stdin = stdin.clone();
        std::thread::Builder::new()
            .name("research-writer-codex-reader".to_string())
            .spawn(move || {
                read_codex_messages(reader, reader_stdin, pending, events, sequence);
            })
            .map_err(|error| format!("Codex 응답 스레드를 시작할 수 없습니다: {error}"))?;
        *process_guard = Some(BridgeProcess { child, stdin });
        Ok(())
    }

    fn wait_for_turn(&self, marker: u64, thread_id: &str, turn_id: &str) -> Result<String, String> {
        let deadline = Instant::now() + TURN_TIMEOUT;
        let mut last_sequence = marker;
        let mut output = String::new();
        let (events_lock, changed) = &*self.events;
        let mut events = events_lock
            .lock()
            .map_err(|_| "Codex 이벤트 대기열 잠금에 실패했습니다.".to_string())?;
        loop {
            let mut completed: Option<Value> = None;
            let mut failure: Option<String> = None;
            for record in events.iter() {
                if record.sequence <= last_sequence {
                    continue;
                }
                last_sequence = last_sequence.max(record.sequence);
                let method = record
                    .message
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let params = record.message.get("params").unwrap_or(&Value::Null);
                if method == "item/agentMessage/delta"
                    && params.get("threadId").and_then(Value::as_str) == Some(thread_id)
                    && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
                    && let Some(delta) = params.get("delta").and_then(Value::as_str)
                {
                    output.push_str(delta);
                }
                if method == "error"
                    && params.get("threadId").and_then(Value::as_str) == Some(thread_id)
                    && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
                {
                    failure = Some(
                        params
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex 작업이 실패했습니다.")
                            .to_string(),
                    );
                }
                if method == "turn/completed"
                    && params.get("threadId").and_then(Value::as_str) == Some(thread_id)
                    && params.pointer("/turn/id").and_then(Value::as_str) == Some(turn_id)
                {
                    completed = Some(params.clone());
                }
            }
            if let Some(error) = failure {
                return Err(error);
            }
            if let Some(completed) = completed {
                let status = completed
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !matches!(status, "completed" | "complete") {
                    let error = completed
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex가 작문 보조를 완료하지 못했습니다.");
                    return Err(error.to_string());
                }
                if output.trim().is_empty() {
                    output = completed_agent_message(&completed).unwrap_or_default();
                }
                return Ok(output);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("AI 작문 보조 시간이 초과되었습니다.".to_string());
            }
            let timeout = deadline
                .saturating_duration_since(now)
                .min(Duration::from_secs(5));
            let (guard, _) = changed
                .wait_timeout(events, timeout)
                .map_err(|_| "Codex 이벤트 대기에 실패했습니다.".to_string())?;
            events = guard;
        }
    }
}

impl Drop for CodexBridge {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut()
            && let Some(process) = process.as_mut()
        {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

fn read_codex_messages(
    reader: BufReader<std::process::ChildStdout>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRequests,
    events: Arc<(Mutex<VecDeque<EventRecord>>, Condvar)>,
    sequence: Arc<AtomicU64>,
) {
    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("method").is_some() && message.get("id").is_some() {
            let _ = write_message(
                &stdin,
                &json!({
                    "id": message.get("id").cloned().unwrap_or(Value::Null),
                    "error": { "code": -32601, "message": "Research Writer does not expose client tools." }
                }),
            );
            continue;
        }
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Ok(mut pending) = pending.lock()
                && let Some(sender) = pending.remove(&id)
            {
                let _ = sender.send(Ok(message));
            }
            continue;
        }
        let event_id = sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let (event_lock, changed) = &*events;
        if let Ok(mut queue) = event_lock.lock() {
            queue.push_back(EventRecord {
                sequence: event_id,
                message,
            });
            while queue.len() > 8_000 {
                queue.pop_front();
            }
            changed.notify_all();
        }
    }
    if let Ok(mut requests) = pending.lock() {
        for (_, sender) in requests.drain() {
            let _ = sender.send(Err("Codex App Server 연결이 종료되었습니다.".to_string()));
        }
    }
}

fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Codex 입력 스트림 잠금에 실패했습니다.".to_string())?;
    serde_json::to_writer(&mut *stdin, message)
        .map_err(|error| format!("Codex 요청을 직렬화할 수 없습니다: {error}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Codex에 요청을 보낼 수 없습니다: {error}"))
}

fn resolve_codex_binary() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("RESEARCH_WRITER_CODEX_BIN") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let executables: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    };
    if let Some(path_value) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path_value) {
            for executable in executables {
                let candidate = directory.join(executable);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let home = dirs::home_dir()?;
    let mut direct_directories = vec![
        home.join(".local/bin"),
        home.join(".local/share/pnpm"),
        home.join("Library/pnpm"),
        home.join(".cargo/bin"),
        home.join("AppData/Roaming/npm"),
        home.join("AppData/Local/pnpm"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(path) = dirs::data_dir().map(|path| path.join("npm")) {
        direct_directories.push(path);
    }
    if let Some(path) = dirs::data_local_dir().map(|path| path.join("pnpm")) {
        direct_directories.push(path);
    }
    if let Some(path) = direct_directories
        .into_iter()
        .flat_map(|directory| {
            executables
                .iter()
                .map(move |executable| directory.join(executable))
        })
        .find(|candidate| candidate.is_file())
    {
        return Some(path);
    }
    for executable in executables {
        if let Some(path) = newest_nested_binary(
            &home.join(".codex/packages/standalone/releases"),
            "bin",
            executable,
        ) {
            return Some(path);
        }
    }
    executables.iter().find_map(|executable| {
        newest_nested_binary(&home.join(".nvm/versions/node"), "bin", executable)
    })
}

fn newest_nested_binary(root: &Path, subdirectory: &str, executable: &str) -> Option<PathBuf> {
    let mut candidates = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let version = entry
                .file_name()
                .to_string_lossy()
                .trim_start_matches('v')
                .split('-')
                .next()
                .unwrap_or_default()
                .split('.')
                .filter_map(|part| part.parse::<u64>().ok())
                .collect::<Vec<_>>();
            let path = entry.path().join(subdirectory).join(executable);
            path.is_file().then_some((version, path))
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop().map(|(_, path)| path)
}

fn codex_version(binary: &Path) -> Option<String> {
    Command::new(binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
}

fn base_instructions() -> &'static str {
    "You are a precise research-writing assistant embedded in a local Markdown editor. \
     You edit or continue only the text supplied in the user message. Never use tools, \
     never inspect the filesystem, never browse, and never invent sources. Preserve the \
     author's language, Markdown structure, factual scope, and citation markers. Return \
     only the JSON object required by the output schema."
}

fn validate_ai_request(request: &AiWritingRequest) -> Result<(), String> {
    let supported = [
        "complete",
        "rewrite",
        "shorten",
        "expand",
        "style",
        "logic",
        "counterargument",
        "evidence",
    ];
    if !supported.contains(&request.action.as_str()) {
        return Err("지원하지 않는 AI 작문 동작입니다.".to_string());
    }
    if request.action != "complete" && request.selection.trim().is_empty() {
        return Err("먼저 다듬을 문장을 선택해주세요.".to_string());
    }
    if request.document_context.chars().count() > 60_000 {
        return Err("AI에 전달할 문맥이 너무 깁니다. 현재 섹션만 선택해주세요.".to_string());
    }
    Ok(())
}

fn build_prompt(request: &AiWritingRequest) -> String {
    let action = match request.action.as_str() {
        "complete" => {
            "Continue naturally from the cursor. Return at most 80 tokens and do not repeat existing text."
        }
        "rewrite" => "Rewrite the selection for clarity while preserving meaning and Markdown.",
        "shorten" => {
            "Shorten the selection without losing claims, qualifications, or citation markers."
        }
        "expand" => {
            "Expand the selection with clearer reasoning, but add no unsupported facts or citations."
        }
        "style" => {
            "Rewrite the selection to match the supplied style reference without copying its facts."
        }
        "logic" => {
            "Improve logical flow. Put the improved prose in replacement and summarize logical issues in rationale."
        }
        "counterargument" => {
            "Strengthen the text by integrating the most important plausible counterargument without inventing facts."
        }
        "evidence" => {
            "Strengthen the wording using only the supplied source cards. Cite source IDs in citations and never cite another source."
        }
        _ => "Edit the selection.",
    };
    let selection = truncate_chars(&request.selection, 30_000);
    let document_context = truncate_chars(&request.document_context, 40_000);
    let style_reference = truncate_chars(&request.style_reference, 12_000);
    let sources = request
        .sources
        .iter()
        .take(15)
        .map(|source| {
            format!(
                "[SOURCE {}] {}\n{}",
                source.id,
                source.title,
                truncate_chars(&source.content, 4_000)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "TASK\n{action}\n\nUSER INSTRUCTIONS\n{}\n\nSELECTED TEXT\n<<<\n{selection}\n>>>\n\nDOCUMENT CONTEXT\n<<<\n{document_context}\n>>>\n\nSTYLE REFERENCE\n<<<\n{style_reference}\n>>>\n\nALLOWED SOURCE CARDS\n<<<\n{sources}\n>>>\n\nReturn replacement as complete Markdown for the selected range. \
         For completion, replacement must contain only text to insert at the cursor. \
         Keep citations empty unless allowed source cards were supplied and actually used.",
        truncate_chars(&request.instructions, 4_000)
    )
}

fn output_schema() -> Value {
    json!({
        "type": "object",
        "required": ["replacement", "rationale", "citations", "warnings"],
        "properties": {
            "replacement": { "type": "string" },
            "rationale": { "type": "string" },
            "citations": { "type": "array", "items": { "type": "string" } },
            "warnings": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": false
    })
}

fn parse_ai_output(output: &str) -> Result<AiWritingResponse, String> {
    let trimmed = output.trim();
    let unwrapped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let value = serde_json::from_str::<Value>(unwrapped)
        .map_err(|error| format!("AI 응답 형식이 올바르지 않습니다: {error}"))?;
    Ok(AiWritingResponse {
        replacement: value
            .get("replacement")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        rationale: value
            .get("rationale")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        citations: string_array(value.get("citations")),
        warnings: string_array(value.get("warnings")),
        original_hash: String::new(),
        model: String::new(),
    })
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        value.chars().take(limit).collect::<String>() + "\n[…문맥 생략…]"
    }
}

fn completed_agent_message(completed: &Value) -> Option<String> {
    completed
        .pointer("/turn/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find_map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                return None;
            }
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
}

fn format_rpc_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(|message| format!("Codex 오류: {message}"))
        .unwrap_or_else(|| format!("Codex 오류: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn prompt_contains_only_explicit_context_and_source_ids() {
        let prompt = build_prompt(&AiWritingRequest {
            action: "evidence".to_string(),
            selection: "주장".to_string(),
            document_context: "현재 절".to_string(),
            style_reference: String::new(),
            instructions: String::new(),
            sources: vec![AiSourceContext {
                id: "S003".to_string(),
                title: "공식 문서".to_string(),
                content: "검증된 내용".to_string(),
            }],
        });
        assert!(prompt.contains("[SOURCE S003]"));
        assert!(!prompt.contains("/home/"));
    }

    #[test]
    fn parses_schema_constrained_response() {
        let parsed = parse_ai_output(
            r#"{"replacement":"새 문장","rationale":"명확화","citations":["S1"],"warnings":[]}"#,
        )
        .unwrap();
        assert_eq!(parsed.replacement, "새 문장");
        assert_eq!(parsed.citations, vec!["S1"]);
    }

    #[test]
    fn finds_the_numerically_newest_nested_codex_binary() {
        let directory = tempfile::tempdir().unwrap();
        for version in ["0.99.0-platform", "0.145.0-platform"] {
            let bin = directory.path().join(version).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("codex"), version).unwrap();
        }

        let selected = newest_nested_binary(directory.path(), "bin", "codex").unwrap();
        assert!(selected.starts_with(directory.path().join("0.145.0-platform")));
    }
}
