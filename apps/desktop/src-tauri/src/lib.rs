mod settings;
mod network;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

const PROTOCOL_VERSION: u32 = 2;
static ACCEPTANCE_LOG_LOCK: Mutex<()> = Mutex::new(());

type PendingResult = Result<Value, String>;

struct ChildSlot {
    generation: u64,
    child: CommandChild,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: String,
    pid: Option<u32>,
    generation: u64,
    protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

struct RuntimeManagerInner {
    network: network::Network,
    configuration_lock: tokio::sync::Mutex<()>,
    child: Mutex<Option<ChildSlot>>,
    pending: Mutex<HashMap<String, oneshot::Sender<PendingResult>>>,
    status: Mutex<RuntimeStatus>,
    next_request_id: AtomicU64,
    next_generation: AtomicU64,
}

#[derive(Clone)]
struct RuntimeManager(Arc<RuntimeManagerInner>);

impl Default for RuntimeManager {
    fn default() -> Self {
        Self(Arc::new(RuntimeManagerInner {
            network: network::Network::default(),
            configuration_lock: tokio::sync::Mutex::new(()),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            status: Mutex::new(RuntimeStatus {
                state: "stopped".into(),
                pid: None,
                generation: 0,
                protocol_version: PROTOCOL_VERSION,
                last_error: None,
            }),
            next_request_id: AtomicU64::new(1),
            next_generation: AtomicU64::new(1),
        }))
    }
}

impl RuntimeManager {
    fn status(&self) -> RuntimeStatus {
        self.0.status.lock().expect("status lock poisoned").clone()
    }

    fn set_status(&self, status: RuntimeStatus) {
        *self.0.status.lock().expect("status lock poisoned") = status;
    }

    #[cfg(debug_assertions)]
    fn dev_runtime_path() -> Result<PathBuf, String> {
        let dev_root = std::env::var_os("PCHAT_DEV_ROOT")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("PCHAT_DEV_ROOT 必须指定构建输出的绝对目录")?;
        let path = dev_root
            .join("build")
            .join("pchat")
            .join("runtime")
            .join("main.mjs");
        if path.is_file() {
            Ok(path)
        } else {
            Err(format!("找不到已构建的 Runtime：{}", path.display()))
        }
    }

    #[cfg(not(debug_assertions))]
    fn node_compatible_path(path: PathBuf) -> PathBuf {
        let raw = path.to_string_lossy();
        if let Some(network_path) = raw.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{network_path}"))
        } else if let Some(local_path) = raw.strip_prefix(r"\\?\") {
            PathBuf::from(local_path)
        } else {
            path
        }
    }

    fn start(&self, app: &AppHandle) -> Result<RuntimeStatus, String> {
        let mut child_guard = self.0.child.lock().map_err(|_| "child lock poisoned")?;
        if child_guard.is_some() {
            return Ok(self.status());
        }

        let generation = self.0.next_generation.fetch_add(1, Ordering::SeqCst);
        self.set_status(RuntimeStatus {
            state: "starting".into(),
            pid: None,
            generation,
            protocol_version: PROTOCOL_VERSION,
            last_error: None,
        });

        #[cfg(debug_assertions)]
        let command = app
            .shell()
            .command("node")
            .arg(Self::dev_runtime_path()?);

        #[cfg(not(debug_assertions))]
        let command = app
            .shell()
            .sidecar("pchat-node")
            .map_err(|error| error.to_string())?
            .arg(Self::node_compatible_path(
                app.path()
                    .resolve("runtime/main.mjs", tauri::path::BaseDirectory::Resource)
                    .map_err(|error| error.to_string())?,
            ));

        let command = command.env("PCHAT_STATE_DIRECTORY", settings::state_directory());
        let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
        let pid = child.pid();
        *child_guard = Some(ChildSlot { generation, child });
        drop(child_guard);

        self.set_status(RuntimeStatus {
            state: "starting".into(),
            pid: Some(pid),
            generation,
            protocol_version: PROTOCOL_VERSION,
            last_error: None,
        });

        let manager = self.clone();
        let event_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        manager.handle_stdout(&event_app, &bytes, generation)
                    }
                    CommandEvent::Stderr(_bytes) => {
                        let error = "后台报告运行异常".to_owned();
                        manager.record_error(generation, error);
                    }
                    CommandEvent::Error(_error) => {
                        let error = "后台进程通信异常".to_owned();
                        manager.record_error(generation, error);
                    }
                    CommandEvent::Terminated(payload) => {
                        manager.handle_terminated(generation, payload.code);
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(self.status())
    }

    fn handle_stdout(&self, app: &AppHandle, bytes: &[u8], generation: u64) {
        if self.status().generation != generation { return; }
        let line = String::from_utf8_lossy(bytes);
        let parsed: Value = match serde_json::from_str(line.trim()) {
            Ok(value) => value,
            Err(error) => {
                self.record_error(generation, format!("Runtime 返回了无效消息：{error}"));
                return;
            }
        };

        if parsed.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64) { self.record_error(generation, "后台协议版本不匹配".into()); return; }
        match parsed.get("kind").and_then(Value::as_str) {
            Some("runtime.ready") => {
                let pid = parsed.get("pid").and_then(Value::as_u64).map(|value| value as u32);
                self.set_status(RuntimeStatus {
                    state: "running".into(),
                    pid,
                    generation,
                    protocol_version: PROTOCOL_VERSION,
                    last_error: None,
                });
            }
            Some("runtime.response") => {
                if let Some(request_id) = parsed.get("requestId").and_then(Value::as_str) {
                    if let Some(sender) = self
                        .0
                        .pending
                        .lock()
                        .expect("pending lock poisoned")
                        .remove(request_id)
                    {
                        let result = if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
                            Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(parsed
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Runtime 请求失败")
                                .to_owned())
                        };
                        let _ = sender.send(result);
                    }
                }
            }
            Some("runtime.event") => {
                if let Err(error) = app.emit("pchat://runtime-event", parsed.clone()) {
                    self.record_error(generation, format!("无法转发 Runtime 事件：{error}"));
                }
            }
            Some("host.request") => self.handle_host_request(&parsed, generation),
            _ => self.record_error(generation, "Runtime 返回了未知消息类型".into()),
        }
    }

    fn handle_host_request(&self, message: &Value, generation: u64) {
        let request_id = message["requestId"].as_str().unwrap_or("").to_owned();
        if request_id.is_empty() || request_id.len() > 200 { return; }
        let method = message["method"].as_str().unwrap_or("").to_owned();
        let params = message["params"].clone();
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = manager.0.network.handle(&method, params).await;
            if manager.status().generation != generation { return; }
            let response = match result {
                Ok(value) => json!({"kind":"host.response","protocolVersion":2,"requestId":request_id,"ok":true,"result":value}),
                Err(error) => json!({"kind":"host.response","protocolVersion":2,"requestId":request_id,"ok":false,"error":if error == "REJECTED" {"REJECTED"} else {"OUTCOME_UNKNOWN"}}),
            };
            let _ = manager.write_message(&response);
        });
    }

    fn write_message(&self, message: &Value) -> Result<(), String> {
        let encoded = format!(
            "{}\n",
            serde_json::to_string(message).map_err(|error| error.to_string())?
        );
        self.0
            .child
            .lock()
            .map_err(|_| "child lock poisoned")?
            .as_mut()
            .ok_or_else(|| "Runtime 未运行".to_owned())?
            .child
            .write(encoded.as_bytes())
            .map_err(|error| error.to_string())
    }

    fn record_error(&self, generation: u64, error: String) {
        let current = self.status();
        if current.generation == generation {
            self.set_status(RuntimeStatus {
                state: current.state,
                pid: current.pid,
                generation,
                protocol_version: PROTOCOL_VERSION,
                last_error: Some(error),
            });
        }
    }

    fn handle_terminated(&self, generation: u64, code: Option<i32>) {
        let mut child = self.0.child.lock().expect("child lock poisoned");
        if child.as_ref().map(|slot| slot.generation) == Some(generation) {
            self.0.network.cancel_all();
            *child = None;
            self.set_status(RuntimeStatus {
                state: if code == Some(0) { "stopped" } else { "failed" }.into(),
                pid: None,
                generation,
                protocol_version: PROTOCOL_VERSION,
                last_error: code.and_then(|value| {
                    (value != 0).then(|| format!("Runtime 异常退出，代码 {value}"))
                }),
            });
            let pending = std::mem::take(
                &mut *self.0.pending.lock().expect("pending lock poisoned"),
            );
            for (_, sender) in pending {
                let _ = sender.send(Err("Runtime 已退出".into()));
            }
        }
    }

    async fn request(&self, app: &AppHandle, method: &str, params: Option<Value>) -> PendingResult {
        self.start(app)?;
        let request_id = format!(
            "host-{}",
            self.0.next_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let mut message = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "method": method,
        });
        if let Some(params) = params {
            message["params"] = params;
        }
        let (sender, receiver) = oneshot::channel();
        self.0
            .pending
            .lock()
            .map_err(|_| "pending lock poisoned")?
            .insert(request_id.clone(), sender);

        let write_result = self.write_message(&message);

        if let Err(error) = write_result {
            self.0
                .pending
                .lock()
                .expect("pending lock poisoned")
                .remove(&request_id);
            return Err(error);
        }

        match tokio::time::timeout(Duration::from_secs(if method == "configuration.collect" { 600 } else { 15 }), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Runtime 响应通道已关闭".into()),
            Err(_) => {
                self.0
                    .pending
                    .lock()
                    .expect("pending lock poisoned")
                    .remove(&request_id);
                Err("Runtime 响应超时".into())
            }
        }
    }

    async fn stop(&self, app: &AppHandle) -> Result<Value, String> {
        if self.0.child.lock().map_err(|_| "child lock poisoned")?.is_none() {
            return Ok(json!({ "alreadyStopped": true }));
        }

        let response = self.request(app, "runtime.shutdown", Some(json!({}))).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        self.force_kill();
        response
    }

    fn force_kill(&self) {
        self.0.network.cancel_all();
        if let Ok(mut guard) = self.0.child.lock() {
            if let Some(slot) = guard.take() {
                let _ = slot.child.kill();
            }
        }
    }
}

#[tauri::command]
fn p0_runtime_status(runtime: State<'_, RuntimeManager>) -> RuntimeStatus {
    runtime.status()
}

#[tauri::command]
fn p0_runtime_start(app: AppHandle, runtime: State<'_, RuntimeManager>) -> Result<RuntimeStatus, String> {
    runtime.start(&app)
}





#[tauri::command]
async fn p0_runtime_stop(app: AppHandle, runtime: State<'_, RuntimeManager>) -> PendingResult {
    runtime.stop(&app).await
}

#[tauri::command]
async fn p0_explicit_exit(app: AppHandle, runtime: State<'_, RuntimeManager>) -> Result<(), String> {
    let _ = runtime.stop(&app).await;
    app.exit(0);
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 Pchat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Pchat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::new().menu(&menu).on_menu_event(|app, event| {
        match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => { let app = app.clone(); tauri::async_runtime::spawn(async move { let runtime = app.state::<RuntimeManager>(); let _ = runtime.stop(&app).await; app.exit(0); }); },
            _ => {}
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let temp_directory = settings::state_directory().join("temp");
    std::fs::create_dir_all(&temp_directory).expect("无法创建临时目录");
    std::env::set_var("TEMP", &temp_directory);
    std::env::set_var("TMP", &temp_directory);
    let webview_directory = settings::state_directory().join("webview");
    std::fs::create_dir_all(&webview_directory).expect("无法创建本地数据目录");
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview_directory);
    let runtime = RuntimeManager::default();
    let runtime_for_setup = runtime.clone();
    let runtime_for_exit = runtime.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(runtime)
        .setup(move |app| {
            build_tray(app)?;
            runtime_for_setup
                .start(app.handle())
                .map_err(std::io::Error::other)?;

            if std::env::var("PCHAT_ACCEPTANCE_PROBE").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                let manager = runtime_for_setup.clone();
                tauri::async_runtime::spawn(async move {
                    for _ in 0..60 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let log = std::fs::read_to_string(settings::state_directory().join("acceptance.ndjson")).unwrap_or_default();
                        if log.contains("ListRoles") && log.contains("ListConversations") && log.contains("harness.subscribe") {
                            let ok = manager.stop(&handle).await.is_ok();
                            handle.exit(if ok { 0 } else { 1 });
                            return;
                        }
                    }
                    let _ = manager.stop(&handle).await;
                    handle.exit(1);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pchat_runtime_request,
            pchat_connection_options,
            pchat_save_connection,
            pchat_collect_corpus,
            pchat_confirm_corpus,
            p0_runtime_status,
            p0_runtime_start,




            p0_runtime_stop,
            p0_explicit_exit,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pchat desktop host");

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            runtime_for_exit.force_kill();
        }
    });
}


#[tauri::command]
async fn pchat_runtime_request(app: AppHandle, runtime: State<'_, RuntimeManager>, request: Value) -> PendingResult {
    let id = request["requestId"].as_str().filter(|s| !s.is_empty() && s.len() <= 200).ok_or("请求标识无效")?;
    let method = request["method"].as_str().ok_or("请求类型无效")?;
    if request["protocolVersion"] != 2 || !["harness.request", "harness.subscribe", "harness.unsubscribe"].contains(&method) { return Err("请求不被允许".into()); }
    let result = runtime.request(&app, method, Some(request["params"].clone())).await;
    if std::env::var("PCHAT_ACCEPTANCE_PROBE").as_deref() == Ok("1") {
        if let Ok(value) = &result {
            use std::io::Write;
            let operation = request["params"]["query"]["type"].as_str().unwrap_or(method);
            if value["result"]["ok"] == true || value["subscribed"] == true {
                let _guard = ACCEPTANCE_LOG_LOCK.lock().map_err(|_| "验收记录不可用")?;
                if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(settings::state_directory().join("acceptance.ndjson")) {
                    let _ = writeln!(log, "{}", json!({"operation":operation,"ok":true}));
                }
            }
        }
    }
    Ok(match result {
        Ok(result) => json!({"kind":"runtime.response","protocolVersion":2,"requestId":id,"ok":true,"result":result}),
        Err(_) => json!({"kind":"runtime.response","protocolVersion":2,"requestId":id,"ok":false,"error":"RUNTIME_UNAVAILABLE"}),
    })
}

#[tauri::command]
fn pchat_connection_options() -> PendingResult { settings::connection_options() }

#[tauri::command]
async fn pchat_save_connection(app: AppHandle, runtime: State<'_, RuntimeManager>, input: settings::ConnectionInput) -> Result<(), String> {
    let _configuration = runtime.0.configuration_lock.lock().await;
    settings::save_connection(input)?;
    runtime.stop(&app).await?;
    runtime.start(&app)?;
    Ok(())
}

#[tauri::command]
async fn pchat_collect_corpus(app: AppHandle, runtime: State<'_, RuntimeManager>, input: Value) -> PendingResult {
    runtime.request(&app, "configuration.collect", Some(input)).await
}

#[tauri::command]
async fn pchat_confirm_corpus(app: AppHandle, runtime: State<'_, RuntimeManager>, input: Value) -> PendingResult {
    let _configuration = runtime.0.configuration_lock.lock().await;
    let result = runtime.request(&app, "configuration.confirm", Some(input)).await?;
    runtime.stop(&app).await?;
    runtime.start(&app)?;
    Ok(result)
}
