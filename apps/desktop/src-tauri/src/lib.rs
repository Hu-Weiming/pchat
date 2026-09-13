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

const PROTOCOL_VERSION: u32 = 1;

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
                    CommandEvent::Stderr(bytes) => {
                        let error = String::from_utf8_lossy(&bytes).into_owned();
                        eprintln!("[p0-runtime stderr] {error}");
                        manager.record_error(generation, error);
                    }
                    CommandEvent::Error(error) => {
                        eprintln!("[p0-runtime error] {error}");
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
        let line = String::from_utf8_lossy(bytes);
        let parsed: Value = match serde_json::from_str(line.trim()) {
            Ok(value) => value,
            Err(error) => {
                self.record_error(generation, format!("Runtime 返回了无效消息：{error}"));
                return;
            }
        };

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
        let request_id = message
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let result = match message.get("method").and_then(Value::as_str) {
            Some("provider.send") => Self::provider_capability(
                message.get("params").cloned().unwrap_or(Value::Null),
            ),
            _ => Err("Host 拒绝未知能力请求".into()),
        };

        let response = match result {
            Ok(value) => json!({
                "kind": "host.response",
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": true,
                "result": value,
            }),
            Err(error) => json!({
                "kind": "host.response",
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": false,
                "error": error,
            }),
        };

        if let Err(error) = self.write_message(&response) {
            self.record_error(generation, error);
        }
    }

    fn provider_capability(params: Value) -> PendingResult {
        let connection_id = params
            .get("connectionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "缺少 connectionId".to_owned())?;
        let operation = params
            .get("operation")
            .and_then(Value::as_str)
            .ok_or_else(|| "缺少 provider operation".to_owned())?;

        if connection_id != "deepseek:personal-default" {
            return Err("未批准的 connectionId 已被 Host 拒绝".into());
        }
        if operation != "chat.completions" {
            return Err("未批准的供应商操作已被 Host 拒绝".into());
        }

        // P0 只验证能力边界。真实密钥将由系统凭证库按 handle 读取，
        // 只在 Host 内注入，不进入 Runtime、UI、数据库或日志。
        let credential_value = "p0-fake-secret-never-serialized";
        let credential_injected = !credential_value.is_empty();
        Ok(json!({
            "connectionId": connection_id,
            "provider": "deepseek",
            "endpoint": "https://api.deepseek.com/chat/completions",
            "credentialInjected": credential_injected,
            "networkPerformed": false,
        }))
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

        match tokio::time::timeout(Duration::from_secs(5), receiver).await {
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

        let response = self.request(app, "shutdown", None).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        self.force_kill();
        response
    }

    fn force_kill(&self) {
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
async fn p0_runtime_ping(app: AppHandle, runtime: State<'_, RuntimeManager>) -> PendingResult {
    runtime.request(&app, "ping", None).await
}

#[tauri::command]
async fn p0_sqlite_probe(app: AppHandle, runtime: State<'_, RuntimeManager>) -> PendingResult {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("p0-storage-probes");
    runtime
        .request(
            &app,
            "sqliteProbe",
            Some(json!({ "dataDirectory": data_directory })),
        )
        .await
}

#[tauri::command]
async fn p0_stream_probe(app: AppHandle, runtime: State<'_, RuntimeManager>) -> PendingResult {
    runtime.request(&app, "streamProbe", None).await
}

#[tauri::command]
async fn p0_provider_policy_probe(
    app: AppHandle,
    runtime: State<'_, RuntimeManager>,
) -> PendingResult {
    runtime.request(&app, "providerPolicyProbe", None).await
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
            "quit" => app.exit(0),
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

            let app_handle = app.handle().clone();
            let self_test_runtime = runtime_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                match self_test_runtime.request(&app_handle, "ping", None).await {
                    Ok(result) => eprintln!("[p0-self-test] private IPC ping passed: {result}"),
                    Err(error) => eprintln!("[p0-self-test] private IPC ping failed: {error}"),
                }
                match self_test_runtime
                    .request(&app_handle, "streamProbe", None)
                    .await
                {
                    Ok(result) => eprintln!("[p0-self-test] streaming events passed: {result}"),
                    Err(error) => eprintln!("[p0-self-test] streaming events failed: {error}"),
                }
                match self_test_runtime
                    .request(&app_handle, "providerPolicyProbe", None)
                    .await
                {
                    Ok(result) => eprintln!("[p0-self-test] provider policy passed: {result}"),
                    Err(error) => eprintln!("[p0-self-test] provider policy failed: {error}"),
                }
                if let Ok(data_directory) = app_handle.path().app_data_dir() {
                    match self_test_runtime
                        .request(
                            &app_handle,
                            "sqliteProbe",
                            Some(json!({
                                "dataDirectory": data_directory.join("p0-storage-probes")
                            })),
                        )
                        .await
                    {
                        Ok(result) => eprintln!("[p0-self-test] SQLite migration passed: {result}"),
                        Err(error) => eprintln!("[p0-self-test] SQLite migration failed: {error}"),
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            p0_runtime_status,
            p0_runtime_start,
            p0_runtime_ping,
            p0_sqlite_probe,
            p0_stream_probe,
            p0_provider_policy_probe,
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

#[cfg(test)]
mod tests {
    use super::RuntimeManager;
    use serde_json::json;

    #[test]
    fn provider_capability_returns_only_sanitized_metadata() {
        let result = RuntimeManager::provider_capability(json!({
            "connectionId": "deepseek:personal-default",
            "operation": "chat.completions",
        }))
        .expect("approved provider connection should pass");
        let serialized = serde_json::to_string(&result).expect("result should serialize");

        assert!(serialized.contains("credentialInjected"));
        assert!(!serialized.contains("p0-fake-secret-never-serialized"));
    }

    #[test]
    fn provider_capability_rejects_unknown_connections() {
        let result = RuntimeManager::provider_capability(json!({
            "connectionId": "attacker:arbitrary-host",
            "operation": "chat.completions",
        }));

        assert!(result.is_err());
    }

    #[test]
    fn provider_capability_rejects_unknown_operations() {
        let result = RuntimeManager::provider_capability(json!({
            "connectionId": "deepseek:personal-default",
            "operation": "arbitrary.http",
        }));

        assert!(result.is_err());
    }
}
