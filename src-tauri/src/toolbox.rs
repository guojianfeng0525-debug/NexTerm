//! Toolbox backend: local app launching, TCP port tunnels and local service
//! (middleware) process management.
//!
//! ## Tunnels
//! A tunnel binds a local TCP port and forwards every accepted connection to a
//! remote `host:port`. Each tunnel runs as an independent Tokio task cancelled
//! via a `CancellationToken`.
//!
//! ## Services
//! A service spawns a child process through the platform shell
//! (`sh -c` on Unix, `cmd /C` on Windows), streams stdout/stderr lines back to
//! the frontend via `service://output` events and keeps a small ring buffer so
//! the UI can re-read recent output after switching tabs.

use crate::ssh::JumpConfig;
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fmt::Display;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Maximum number of output lines kept per service.
const MAX_SERVICE_LOG_LINES: usize = 1000;
/// Maximum number of output lines returned by `service_logs`.
const SERVICE_LOG_READ_LINES: usize = 500;
/// Default maximum response preview returned over IPC (1 MiB).
const API_RESPONSE_PREVIEW_BYTES: usize = 1024 * 1024;
/// An API request must never retain more than this many response bytes in memory.
const API_RESPONSE_HARD_LIMIT_BYTES: usize = 100 * 1024 * 1024;
/// File uploads are buffered for Tauri IPC and reqwest multipart construction.
const API_MULTIPART_FILE_LIMIT_BYTES: usize = 25 * 1024 * 1024;
const API_MULTIPART_FILE_MAX_BASE64_CHARS: usize = 4 * API_MULTIPART_FILE_LIMIT_BYTES.div_ceil(3);
/// Maximum inbound WebSocket frame preview sent to the API debugger UI.
const API_WS_MESSAGE_PREVIEW_BYTES: usize = 1024 * 1024;
static NEXT_WS_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_API_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────────────────────────────────────

pub struct TunnelHandle {
    token: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
    /// In-flight per-connection tasks, shared so tunnel_stop can cancel them
    /// (previously they leaked and kept forwarding after the tunnel stopped).
    conn_tasks: Arc<tokio::sync::Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>>,
}

pub struct ServiceHandle {
    pid: u32,
    started_at: u64,
    stop_tx: mpsc::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
    logs: Arc<Mutex<VecDeque<ServiceLogLine>>>,
}

pub struct WsHandle {
    tx: mpsc::Sender<WsCommand>,
    token: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
    instance_id: u64,
}

enum WsCommand {
    Text(String),
    Close,
}

#[derive(Default)]
pub struct ToolboxState {
    tunnels: Mutex<HashMap<String, TunnelHandle>>,
    services: Mutex<HashMap<String, ServiceHandle>>,
    ws: Arc<Mutex<HashMap<String, WsHandle>>>,
    api_requests: Mutex<HashMap<String, CancellationToken>>,
}

impl ToolboxState {
    /// Cancel all tunnels and stop all services. Called on app exit.
    pub fn shutdown_all(&self) {
        let mut tunnels = self.tunnels.lock().expect("tunnel state poisoned");
        for (_, handle) in tunnels.drain() {
            handle.token.cancel();
            handle.task.abort();
        }

        let mut services = self.services.lock().expect("service state poisoned");
        for (_, handle) in services.drain() {
            let _ = handle.stop_tx.try_send(());
            // Kill the process tree (taskkill /T /F on Windows) BEFORE aborting
            // the task: abort only drops the child wrapper via kill_on_drop,
            // which leaves grandchildren (node/python servers) holding ports.
            #[cfg(windows)]
            {
                let pid = handle.pid;
                if pid != 0 {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
            handle.task.abort();
        }

        let mut ws = self.ws.lock().expect("ws state poisoned");
        for (_, handle) in ws.drain() {
            handle.token.cancel();
            handle.task.abort();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch local app
// ─────────────────────────────────────────────────────────────────────────────

/// Split an argument string into tokens, honoring double quotes
/// (e.g. `--path "/my dir/x" -v` → ["--path", "/my dir/x", "-v"]).
/** True when the path points to a Windows batch script (.bat / .cmd).
 *  Windows-only: call sites live inside `#[cfg(windows)]` blocks. */
#[cfg(windows)]
fn is_batch_script(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// Build the Windows `cmd /C` command line for a batch script, quoting the
/// script path when it contains spaces and using `call` so the script runs
/// correctly through cmd.exe (a bare quoted path would be treated as a
/// program name by cmd, not a script).
#[cfg(windows)]
fn batch_invocation(path: &str, args: &[String]) -> String {
    let quoted = if path.contains(' ') {
        format!("\"{}\"", path)
    } else {
        path.to_string()
    };
    if args.is_empty() {
        format!("call {}", quoted)
    } else {
        format!("call {} {}", quoted, args.join(" "))
    }
}

fn split_args(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                // A doubled quote is an escaped quote character.
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ' ' | '\t' if !in_quotes => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchAppRequest {
    pub path: String,
    pub args: Option<String>,
    pub cwd: Option<String>,
}

/// Launch a local application. On macOS, `.app` bundles are opened with `open`;
/// any other executable is spawned directly. If direct spawning fails the
/// platform default opener (`open` / `xdg-open`) is used as a fallback.
#[tauri::command]
pub async fn launch_app(request: LaunchAppRequest) -> Result<(), String> {
    let path = request.path.trim().to_string();
    if path.is_empty() {
        return Err("App path is empty".into());
    }
    let args = split_args(request.args.as_deref().unwrap_or(""));

    // macOS .app bundles must be launched through `open`.
    #[cfg(target_os = "macos")]
    {
        if path.ends_with(".app") {
            let mut cmd = std::process::Command::new("open");
            cmd.arg("-n").arg(&path);
            if !args.is_empty() {
                cmd.arg("--args").args(&args);
            }
            if let Some(cwd) = &request.cwd {
                cmd.current_dir(cwd);
            }
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .stdin(std::process::Stdio::null());
            return cmd
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to launch '{}': {}", path, e));
        }
    }

    // Windows batch scripts (.bat/.cmd) cannot be spawned directly with
    // CreateProcess — they must run through cmd.exe. Handle them up front so
    // the args/cwd are preserved (the generic fallback below would drop args).
    #[cfg(windows)]
    {
        if is_batch_script(&path) {
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(batch_invocation(&path, &args));
            if let Some(cwd) = &request.cwd {
                c.current_dir(cwd);
            }
            c.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .stdin(std::process::Stdio::null());
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            c.creation_flags(0x0000_0008 | 0x0000_0200);
            return c
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to launch batch script '{}': {}", path, e));
        }
    }

    let mut cmd = std::process::Command::new(&path);
    cmd.args(&args);
    if let Some(cwd) = &request.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());

    // Detach the child so closing NexTerm does not take the app down with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }

    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(e) => {
            // Fallback: hand the path to the platform opener.
            // Windows exe/lnk files fall back to `cmd /C start "" <path>` —
            // the path MUST be double-quoted or paths containing spaces are
            // mis-parsed by cmd (this was breaking apps saved from the
            // picker, e.g. "C:\Program Files\...").
            #[cfg(target_os = "windows")]
            {
                let quoted = format!("\"{}\"", path.replace('"', "\\\""));
                let mut start = std::process::Command::new("cmd");
                start.arg("/C").arg("start").arg("").arg(&quoted);
                if let Some(cwd) = &request.cwd {
                    start.current_dir(cwd);
                }
                return start.spawn().map(|_| ()).map_err(|e2| {
                    format!(
                        "Failed to launch '{}': {} (fallback 'cmd /C start' also failed: {})",
                        path, e, e2
                    )
                });
            }
            #[cfg(not(target_os = "windows"))]
            {
                let opener = if cfg!(target_os = "macos") {
                    Some("open")
                } else if cfg!(target_os = "linux") {
                    Some("xdg-open")
                } else {
                    None
                };
                match opener {
                    Some(program) => std::process::Command::new(program)
                        .arg(&path)
                        .spawn()
                        .map(|_| ())
                        .map_err(|e2| {
                            format!(
                                "Failed to launch '{}': {} (fallback '{}' also failed: {})",
                                path, e, program, e2
                            )
                        }),
                    None => Err(format!("Failed to launch '{}': {}", path, e)),
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote tunnels (local port → remote host:port)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStartRequest {
    pub id: String,
    pub name: String,
    pub bind_address: String,
    pub listen_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// Optional SSH jump host. When set, remote connections are tunnelled
    /// through this host instead of connecting directly.
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_username: Option<String>,
    pub jump_password: Option<String>,
    /// User-approved SSH host-key fingerprint. Jump tunnels fail closed when
    /// this is missing; unauthenticated first-use connections are not allowed.
    pub jump_host_key_fingerprint: Option<String>,
}

/// Map the tunnel request's jump fields into a `JumpConfig`, or `None` when
/// no jump host is configured. The jump host authenticates with a password.
fn build_tunnel_jump(request: &TunnelStartRequest) -> Result<Option<JumpConfig>, String> {
    let host = request.jump_host.clone().filter(|h| !h.trim().is_empty());
    let Some(host) = host else {
        return Ok(None);
    };
    let username = request
        .jump_username
        .clone()
        .filter(|u| !u.trim().is_empty())
        .ok_or("Jump host username is required")?;
    let host_key_fingerprint = request
        .jump_host_key_fingerprint
        .clone()
        .filter(|fingerprint| !fingerprint.trim().is_empty())
        .ok_or("Jump host SSH fingerprint is required before starting the tunnel")?;
    Ok(Some(JumpConfig {
        host,
        port: request.jump_port.unwrap_or(22),
        username,
        auth_method: crate::ssh::AuthMethod::Password {
            password: request
                .jump_password
                .clone()
                .ok_or("Jump host password is required")?,
        },
        host_key_fingerprint: Some(host_key_fingerprint),
    }))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEventPayload {
    pub id: String,
    pub message: String,
}

/// Start a tunnel. The listener is bound inside this command so port conflicts
/// surface as an immediate, user-visible error instead of a silent failure.
#[tauri::command]
pub async fn tunnel_start(
    request: TunnelStartRequest,
    app: AppHandle,
    state: State<'_, ToolboxState>,
) -> Result<TunnelStatus, String> {
    let bind_addr = format!("{}:{}", request.bind_address, request.listen_port);
    // Bind first: a failed bind leaves any existing tunnel with the same id running.
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("Failed to bind {}: {}", bind_addr, e))?;

    // Validate the full configuration BEFORE touching the existing instance so
    // a failed restart never kills a running tunnel with nothing to replace it.
    let task_jump = build_tunnel_jump(&request)?;

    // Stop any existing tunnel with the same id now that the new listener is ready.
    let old_tunnel = {
        let mut tunnels = state.tunnels.lock().expect("tunnel state poisoned");
        tunnels.remove(&request.id)
    };
    if let Some(old) = old_tunnel {
        old.token.cancel();
        // The connection-task mutex is async; waiting here removes the
        // try-lock race that could leave active forwards behind.
        let tasks = old.conn_tasks.lock().await;
        for task in tasks.iter() {
            task.abort();
        }
        drop(tasks);
        old.task.abort();
    }

    let remote_addr = format!("{}:{}", request.remote_host, request.remote_port);
    let token = CancellationToken::new();
    let conn_tasks: Arc<tokio::sync::Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let emit_app = app.clone();
    let emit_app2 = app.clone();
    let id = request.id.clone();
    let name = request.name.clone();

    // Copies owned by the tunnel task; the originals stay usable after spawn.
    let task_token = token.clone();
    let task_id = id.clone();
    let task_name = name.clone();
    let task_remote = remote_addr.clone();
    let task_remote_host = request.remote_host.clone();
    let task_remote_port = request.remote_port;

    let task_conn_tasks = Arc::clone(&conn_tasks);
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = task_token.cancelled() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((mut client, _peer)) => {
                            // Prune finished connection tasks to keep the vec small.
                            {
                                let mut tasks = task_conn_tasks.lock().await;
                                tasks.retain(|t| !t.inner().is_finished());
                            }
                            let remote = task_remote.clone();
                            let e_app = emit_app.clone();
                            let conn_id = task_id.clone();
                            let jump = task_jump.clone();
                            let rhost = task_remote_host.clone();
                            let rport = task_remote_port;
                            let conn_cancel = task_token.clone();
                            let conn = tauri::async_runtime::spawn(async move {
                                let _ = e_app.emit(
                                    "tunnel://activity",
                                    TunnelEventPayload {
                                        id: conn_id.clone(),
                                        message: format!("{} connected ← {}", remote, client_peer(&client)),
                                    },
                                );
                                let operation = async {
                                    match jump {
                                        Some(jump) => {
                                            // Tunnel through the jump host. The session
                                            // handle is kept alive for the whole copy.
                                            match crate::jump::connect_via_jump(
                                                &jump,
                                                &rhost,
                                                rport,
                                                Duration::from_secs(3),
                                                Some(Duration::from_secs(60)),
                                                3,
                                                true,
                                            )
                                            .await
                                            {
                                                Ok(mut tunnel) => {
                                                    let _session = tunnel.session;
                                                    tokio::io::copy_bidirectional(
                                                        &mut client,
                                                        &mut tunnel.stream,
                                                    )
                                                    .await
                                                    .map(|_| ())
                                                }
                                                Err(e) => Err(std::io::Error::other(e.to_string())),
                                            }
                                        }
                                        None => {
                                            match TcpStream::connect(&remote).await {
                                                Ok(mut server) => {
                                                    tokio::io::copy_bidirectional(&mut client, &mut server)
                                                        .await
                                                        .map(|_| ())
                                                }
                                                Err(e) => Err(e),
                                            }
                                        }
                                    }
                                };
                                // The tunnel token is shared with every accepted
                                // connection so shutdown_all/tunnel_stop can cancel
                                // in-flight copies without relying on task-abort races.
                                let result = tokio::select! {
                                    _ = conn_cancel.cancelled() => None,
                                    result = operation => Some(result),
                                };
                                if let Some(Err(e)) = result {
                                    let _ = e_app.emit(
                                        "tunnel://error",
                                        TunnelEventPayload {
                                            id: conn_id.clone(),
                                            message: format!("Failed to connect to {}: {}", remote, e),
                                        },
                                    );
                                }
                            });
                            task_conn_tasks.lock().await.push(conn);
                        }
                        Err(e) => {
                            let _ = emit_app2.emit(
                                "tunnel://error",
                                TunnelEventPayload {
                                    id: task_id.clone(),
                                    message: format!("Failed to accept connection: {}", e),
                                },
                            );
                        }
                    }
                }
            }
        }

        {
            let tasks = task_conn_tasks.lock().await;
            for conn_task in tasks.iter() {
                conn_task.abort();
            }
        }
        tracing::info!("Tunnel '{}' ({}) stopped", task_name, task_id);
    });

    state.tunnels.lock().expect("tunnel state poisoned").insert(
        request.id.clone(),
        TunnelHandle {
            token,
            task,
            conn_tasks,
        },
    );

    tracing::info!("Tunnel '{}' started: {} → {}", name, bind_addr, remote_addr);
    Ok(TunnelStatus {
        id: request.id,
        active: true,
    })
}

fn client_peer(client: &TcpStream) -> String {
    client
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "unknown".into())
}

#[tauri::command]
pub async fn tunnel_stop(id: String, state: State<'_, ToolboxState>) -> Result<(), String> {
    let removed = state
        .tunnels
        .lock()
        .expect("tunnel state poisoned")
        .remove(&id);
    match removed {
        Some(handle) => {
            handle.token.cancel();
            // Cancel in-flight connection tasks too — otherwise copy_bidirectional
            // keeps forwarding on open sockets after the tunnel is stopped.
            let tasks = handle.conn_tasks.lock().await;
            for task in tasks.iter() {
                task.abort();
            }
            drop(tasks);
            handle.task.abort();
            Ok(())
        }
        None => Err(format!("Tunnel '{}' is not running", id)),
    }
}

/// List the ids of currently running tunnels.
#[tauri::command]
pub async fn tunnel_list(state: State<'_, ToolboxState>) -> Result<Vec<TunnelStatus>, String> {
    let tunnels = state.tunnels.lock().expect("tunnel state poisoned");
    Ok(tunnels
        .keys()
        .map(|id| TunnelStatus {
            id: id.clone(),
            active: true,
        })
        .collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Local services (middleware)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceStartRequest {
    pub id: String,
    pub name: String,
    /// Full command line executed through the platform shell.
    pub command: String,
    /// Optional extra arguments appended to the command line.
    pub args: Option<String>,
    pub cwd: Option<String>,
    /// Optional environment variables as "KEY=VALUE" strings.
    pub env: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub id: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOutputPayload {
    pub id: String,
    pub line: String,
    pub stream: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLogLine {
    pub stream: String,
    pub line: String,
    pub timestamp: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Kill a service's process tree.
///
/// On Windows the child is a `cmd` wrapper whose grandchildren (e.g. a `node`
/// server) survive a plain kill and keep the port bound. `taskkill /T /F`
/// walks the whole tree by PID. Elsewhere a normal kill + reap suffices.
async fn kill_process_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    {
        let pid = child.id().unwrap_or(0);
        if pid != 0 {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            let _ = child.wait().await;
            return;
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Start a service process and begin streaming its output.
#[tauri::command]
pub async fn service_start(
    request: ServiceStartRequest,
    app: AppHandle,
    state: State<'_, ToolboxState>,
) -> Result<ServiceStatus, String> {
    if request.command.trim().is_empty() {
        return Err("Command is empty".into());
    }

    // Build the full command line: command + optional args.
    // On Windows, a batch-script command (possibly with spaces in its path) is
    // wrapped so cmd.exe executes it correctly via `call`.
    let full_command = {
        #[cfg(windows)]
        {
            let parsed_args = request.args.as_deref().map(split_args).unwrap_or_default();
            if is_batch_script(&request.command) {
                batch_invocation(&request.command, &parsed_args)
            } else if parsed_args.is_empty() {
                request.command.clone()
            } else {
                format!("{} {}", request.command, parsed_args.join(" "))
            }
        }
        #[cfg(not(windows))]
        {
            match request.args.as_deref() {
                Some(args) if !args.trim().is_empty() => format!("{} {}", request.command, args),
                _ => request.command.clone(),
            }
        }
    };

    // Build the platform shell invocation.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = TokioCommand::new("cmd");
        // CREATE_NO_WINDOW: run the service in the background without popping
        // up a console (black) window.
        c.creation_flags(0x0800_0000);
        c.arg("/C").arg(&full_command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = TokioCommand::new("sh");
        c.arg("-c").arg(&full_command);
        c
    };

    if let Some(cwd) = &request.cwd {
        if !cwd.trim().is_empty() {
            cmd.current_dir(cwd);
        }
    }
    if let Some(env) = &request.env {
        for kv in env {
            if let Some((key, value)) = kv.split_once('=') {
                let key = key.trim();
                if !key.is_empty() {
                    cmd.env(key, value.trim());
                }
            }
        }
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        // Ensure an aborted/dropped task actually kills the child process —
        // otherwise a service restart or app shutdown leaves orphaned
        // processes running (tokio's default kill_on_drop is false).
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start '{}': {}", full_command, e))?;

    // Give the child a moment; if it exits immediately the command likely
    // failed (wrong path / missing program), so report the real reason
    // instead of pretending the service is running.
    //
    // One Windows caveat: `cmd /C gui-app.exe` returns immediately *without*
    // waiting for GUI-subsystem programs (cmd only waits for console
    // programs). A zero exit code then means "the command was found and
    // launched (possibly detached)", not "it crashed" — so only a non-zero
    // exit is treated as a startup failure.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    if let Some(status) = child.try_wait().map_err(|e| format!("wait: {}", e))? {
        let code = status.code();
        if cfg!(windows) && code == Some(0) {
            // The wrapper (cmd) exited but the service may still be running
            // detached (typical for GUI-subsystem services on Windows).
            tracing::info!(
                "service '{}' ({}): cmd wrapper exited 0 immediately; assuming detached service",
                request.name,
                request.id
            );
        } else {
            let mut reason = String::new();
            let stderr = child.stderr.take();
            if let Some(mut err) = stderr {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let _ = err.read_to_end(&mut buf).await;
                reason = String::from_utf8_lossy(&buf).trim().to_string();
            }
            return Err(format!(
                "'{}' exited immediately with status {}: {}",
                full_command,
                status,
                if reason.is_empty() {
                    "check the command path and arguments".to_string()
                } else {
                    reason
                }
            ));
        }
    }

    // The new instance is up — only now retire any previous instance with
    // the same id (a failed spawn above must not kill the running one).
    {
        let mut services = state.services.lock().expect("service state poisoned");
        if let Some(old) = services.remove(&request.id) {
            let _ = old.stop_tx.try_send(());
            old.task.abort();
        }
    }

    let pid = child.id().unwrap_or(0);
    let started_at = now_ms();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let logs: Arc<Mutex<VecDeque<ServiceLogLine>>> = Arc::new(Mutex::new(VecDeque::new()));
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let (line_tx, mut line_rx) = mpsc::channel::<(String, String)>(256);

    // Reader tasks forward output lines into the shared channel.
    if let Some(out) = stdout {
        let tx = line_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if tx.send(("stdout".to_string(), line)).await.is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        let tx = line_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if tx.send(("stderr".to_string(), line)).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(line_tx);

    let emit_app = app.clone();
    let logs_for_task = logs.clone();
    let id = request.id.clone();
    let name = request.name.clone();
    let mut child_owned = child;

    let task = tauri::async_runtime::spawn(async move {
        let mut exited = false;
        loop {
            tokio::select! {
                _ = stop_rx.recv() => break,
                maybe_line = line_rx.recv() => {
                    match maybe_line {
                        Some((stream, line)) => {
                            let ts = now_ms();
                            {
                                let mut buf = logs_for_task.lock().expect("service logs poisoned");
                                if buf.len() >= MAX_SERVICE_LOG_LINES {
                                    buf.pop_front();
                                }
                                buf.push_back(ServiceLogLine { stream: stream.clone(), line: line.clone(), timestamp: ts });
                            }
                            let _ = emit_app.emit(
                                "service://output",
                                ServiceOutputPayload { id: id.clone(), line, stream },
                            );
                        }
                        None => {
                            // All readers closed (process exited) — wait for the child to reap.
                            let _ = child_owned.wait().await;
                            exited = true;
                            break;
                        }
                    }
                }
                _ = child_owned.wait() => {
                    exited = true;
                    break;
                }
            }
        }

        if !exited {
            kill_process_tree(&mut child_owned).await;
        }
        let _ = emit_app.emit(
            "service://exited",
            ServiceOutputPayload {
                id: id.clone(),
                line: "process exited".to_string(),
                stream: "stderr".to_string(),
            },
        );
        tracing::info!("Service '{}' stopped", name);
    });

    state
        .services
        .lock()
        .expect("service state poisoned")
        .insert(
            request.id.clone(),
            ServiceHandle {
                pid,
                started_at,
                stop_tx,
                task,
                logs,
            },
        );

    Ok(ServiceStatus {
        id: request.id,
        running: true,
        pid: Some(pid),
        started_at: Some(started_at),
    })
}

#[tauri::command]
pub async fn service_stop(id: String, state: State<'_, ToolboxState>) -> Result<(), String> {
    let removed = state
        .services
        .lock()
        .expect("service state poisoned")
        .remove(&id);
    let Some(handle) = removed else {
        return Err(format!("Service '{}' is not running", id));
    };

    // Deliver the stop signal reliably. `try_send` was previously used and
    // silently failed when the receiver was busy (the task was polling a
    // child wait / line read), leaving the process running while the UI
    // reported "stopped" — the classic "port still in use" on restart.
    handle
        .stop_tx
        .send(())
        .await
        .map_err(|_| format!("Failed to signal service '{}' to stop", id))?;

    // Wait for the task to actually finish (the task kills the child and
    // reaps it). Give it a bounded grace period so a wedged process surfaces
    // as an error instead of a false "stopped".
    match tokio::time::timeout(std::time::Duration::from_secs(5), handle.task).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("Service '{}' task failed: {e}", id)),
        Err(_) => Err(format!(
            "Service '{}' did not stop within 5s (process may still be running)",
            id
        )),
    }
}

#[tauri::command]
pub async fn service_list(state: State<'_, ToolboxState>) -> Result<Vec<ServiceStatus>, String> {
    let mut services = state.services.lock().expect("service state poisoned");
    // Drop entries whose task already finished (process exited on its own).
    services.retain(|_, handle| !handle.task.inner().is_finished());
    Ok(services
        .iter()
        .map(|(id, handle)| ServiceStatus {
            id: id.clone(),
            running: true,
            pid: Some(handle.pid),
            started_at: Some(handle.started_at),
        })
        .collect())
}

/// Return the most recent buffered output lines of a service.
#[tauri::command]
pub async fn service_logs(
    id: String,
    state: State<'_, ToolboxState>,
) -> Result<Vec<ServiceLogLine>, String> {
    let services = state.services.lock().expect("service state poisoned");
    match services.get(&id) {
        Some(handle) => {
            let buf = handle.logs.lock().expect("service logs poisoned");
            Ok(buf
                .iter()
                .rev()
                .take(SERVICE_LOG_READ_LINES)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect())
        }
        None => Ok(Vec::new()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// API debugger: REST requests + WebSocket client
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub request_id: Option<String>,
    pub method: String,
    pub url: String,
    pub headers: Option<Vec<(String, String)>>,
    pub body: Option<String>,
    /// Structured application/x-www-form-urlencoded fields. Kept separate from
    /// `body` so existing raw-body callers remain compatible.
    pub form_fields: Option<Vec<(String, String)>>,
    /// Structured multipart form fields and base64-encoded file contents.
    pub multipart: Option<ApiMultipartBody>,
    pub timeout_ms: Option<u64>,
    /// Maximum response bytes returned to the UI. Defaults to 1 MiB and is
    /// capped at 100 MiB to keep a debugger request from exhausting memory.
    pub response_size_limit_bytes: Option<usize>,
    /// Certificate validation is enabled by default. This opt-out exists only
    /// for explicitly debugging development servers with self-signed certs.
    pub insecure_skip_tls_verify: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiMultipartBody {
    pub fields: Option<Vec<(String, String)>>,
    pub files: Option<Vec<ApiMultipartFile>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiMultipartFile {
    pub field_name: String,
    pub file_name: String,
    pub data_base64: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_is_base64: bool,
    pub duration_ms: u64,
    /// Number of response bytes included in `body`, before base64 encoding.
    pub body_size_bytes: usize,
    /// Server-provided Content-Length, when available.
    pub content_length: Option<u64>,
    /// True when the response exceeded the configured preview limit.
    pub truncated: bool,
    /// Reserved for a future explicit download-to-file mode. No files are
    /// written implicitly by the API debugger.
    pub download_file_path: Option<String>,
}

fn response_size_limit(requested: Option<usize>) -> Result<usize, String> {
    let limit = requested.unwrap_or(API_RESPONSE_PREVIEW_BYTES);
    if limit == 0 {
        return Err("Response size limit must be greater than zero".to_string());
    }
    Ok(limit.min(API_RESPONSE_HARD_LIMIT_BYTES))
}

/// Collect no more than `limit` bytes from a response stream. Reading stops as
/// soon as a surplus byte is observed, rather than buffering the whole body.
async fn read_response_preview<S, B, E>(
    mut stream: S,
    limit: usize,
    cancellation: &CancellationToken,
) -> Result<(Vec<u8>, bool), String>
where
    S: futures::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: Display,
{
    let mut bytes = Vec::with_capacity(limit.min(API_RESPONSE_PREVIEW_BYTES));

    loop {
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Err("Request cancelled".to_string()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|error| format!("Failed to read response body: {error}"))?;
        let chunk = chunk.as_ref();
        let remaining = limit.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(chunk);
        if bytes.len() == limit {
            // A further poll distinguishes an exactly-limit response from a
            // truncated one when Content-Length is unavailable.
            return match tokio::select! {
                _ = cancellation.cancelled() => return Err("Request cancelled".to_string()),
                chunk = stream.next() => chunk,
            } {
                Some(Ok(_)) => Ok((bytes, true)),
                Some(Err(error)) => Err(format!("Failed to read response body: {error}")),
                None => Ok((bytes, false)),
            };
        }
    }

    Ok((bytes, false))
}

/// Send an HTTP request from the API debugger.
#[tauri::command]
pub async fn api_request(
    request: ApiRequest,
    state: State<'_, ToolboxState>,
) -> Result<ApiResponse, String> {
    let request_id = request.request_id.clone().unwrap_or_else(|| {
        format!(
            "api-{}",
            NEXT_API_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    let cancellation = CancellationToken::new();
    state
        .api_requests
        .lock()
        .map_err(|_| "api request state poisoned".to_string())?
        .insert(request_id.clone(), cancellation.clone());
    let result = api_request_inner(request, cancellation.clone()).await;
    state
        .api_requests
        .lock()
        .map_err(|_| "api request state poisoned".to_string())?
        .remove(&request_id);
    result
}

#[tauri::command]
pub fn api_request_cancel(
    request_id: String,
    state: State<'_, ToolboxState>,
) -> Result<(), String> {
    if let Some(token) = state
        .api_requests
        .lock()
        .map_err(|_| "api request state poisoned".to_string())?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}

async fn api_request_inner(
    request: ApiRequest,
    cancellation: CancellationToken,
) -> Result<ApiResponse, String> {
    let response_limit = response_size_limit(request.response_size_limit_bytes)?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(request.insecure_skip_tls_verify.unwrap_or(false))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {}", request.method))?;

    let mut req = client.request(method, &request.url);
    if let Some(headers) = &request.headers {
        for (key, value) in headers {
            if !key.trim().is_empty() {
                req = req.header(key.trim(), value.trim());
            }
        }
    }
    if let Some(multipart) = request.multipart {
        let mut form = reqwest::multipart::Form::new();
        for (name, value) in multipart.fields.unwrap_or_default() {
            if !name.trim().is_empty() {
                form = form.text(name, value);
            }
        }
        for file in multipart.files.unwrap_or_default() {
            if file.field_name.trim().is_empty() {
                return Err("Multipart file field name is required".to_string());
            }
            if file.file_name.trim().is_empty() {
                return Err("Multipart file name is required".to_string());
            }
            if file.data_base64.len() > API_MULTIPART_FILE_MAX_BASE64_CHARS {
                return Err(format!(
                    "Multipart file '{}' exceeds the {} MiB limit",
                    file.file_name,
                    API_MULTIPART_FILE_LIMIT_BYTES / (1024 * 1024)
                ));
            }
            let data = base64::engine::general_purpose::STANDARD
                .decode(file.data_base64)
                .map_err(|_| {
                    format!(
                        "Multipart file '{}' has invalid base64 data",
                        file.file_name
                    )
                })?;
            if data.len() > API_MULTIPART_FILE_LIMIT_BYTES {
                return Err(format!(
                    "Multipart file '{}' exceeds the {} MiB limit",
                    file.file_name,
                    API_MULTIPART_FILE_LIMIT_BYTES / (1024 * 1024)
                ));
            }
            let mut part = reqwest::multipart::Part::bytes(data).file_name(file.file_name);
            if let Some(content_type) = file.content_type.filter(|value| !value.trim().is_empty()) {
                part = part.mime_str(&content_type).map_err(|_| {
                    format!("Multipart file has invalid content type: {content_type}")
                })?;
            }
            form = form.part(file.field_name, part);
        }
        req = req.multipart(form);
    } else if let Some(fields) = request.form_fields {
        req = req.form(&fields);
    } else if let Some(body) = &request.body {
        if !body.trim().is_empty() {
            req = req.body(body.clone());
        }
    }
    let timeout_ms = request.timeout_ms.unwrap_or(30_000);
    if timeout_ms == 0 {
        return Err("Request timeout must be greater than zero".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms);
    req = req.timeout(timeout);

    let start = Instant::now();
    let resp = tokio::select! {
        _ = cancellation.cancelled() => return Err("Request cancelled".to_string()),
        response = req.send() => response.map_err(|e| format!("Request failed: {}", e))?,
    };
    let status = resp.status();
    let content_length = resp.content_length();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let (bytes, mut truncated) =
        read_response_preview(resp.bytes_stream(), response_limit, &cancellation).await?;
    truncated |= content_length.is_some_and(|length| length > response_limit as u64);
    let duration_ms = start.elapsed().as_millis() as u64;
    let body_size_bytes = bytes.len();

    let (body, body_is_base64) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(error) => (
            base64::engine::general_purpose::STANDARD.encode(error.into_bytes()),
            true,
        ),
    };

    Ok(ApiResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        body_is_base64,
        duration_ms,
        body_size_bytes,
        content_length,
        truncated,
        download_file_path: None,
    })
}

#[cfg(test)]
mod api_request_tests {
    use super::*;

    #[test]
    fn response_size_limit_defaults_and_caps() {
        assert_eq!(
            response_size_limit(None).unwrap(),
            API_RESPONSE_PREVIEW_BYTES
        );
        assert_eq!(
            response_size_limit(Some(usize::MAX)).unwrap(),
            API_RESPONSE_HARD_LIMIT_BYTES
        );
        assert!(response_size_limit(Some(0)).is_err());
    }

    #[tokio::test]
    async fn response_preview_stops_at_limit() {
        let stream = futures::stream::iter(vec![
            Ok::<_, &'static str>(b"abc".to_vec()),
            Ok(b"def".to_vec()),
        ]);
        let (body, truncated) = read_response_preview(stream, 4, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(body, b"abcd");
        assert!(truncated);
    }

    #[tokio::test]
    async fn response_preview_marks_exact_complete_body() {
        let stream = futures::stream::iter(vec![Ok::<_, &'static str>(b"abcd".to_vec())]);
        let (body, truncated) = read_response_preview(stream, 4, &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(body, b"abcd");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn response_preview_stops_when_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let stream = futures::stream::pending::<Result<Vec<u8>, &'static str>>();
        let error = read_response_preview(stream, 4, &token).await.unwrap_err();
        assert_eq!(error, "Request cancelled");
    }

    #[test]
    fn websocket_text_preview_respects_byte_limit_without_splitting_utf8() {
        let text = format!("{}x", "a".repeat(API_WS_MESSAGE_PREVIEW_BYTES));
        let (preview, truncated) = truncate_ws_text(&text);
        assert_eq!(preview.len(), API_WS_MESSAGE_PREVIEW_BYTES);
        assert!(truncated);

        let text = format!("{}é", "a".repeat(API_WS_MESSAGE_PREVIEW_BYTES - 1));
        let (preview, truncated) = truncate_ws_text(&text);
        assert_eq!(preview.len(), API_WS_MESSAGE_PREVIEW_BYTES - 1);
        assert!(truncated);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsMessagePayload {
    pub id: String,
    pub data: String,
    pub timestamp: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsStatusPayload {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    pub reason: Option<String>,
}

fn truncate_ws_text(text: &str) -> (String, bool) {
    if text.len() <= API_WS_MESSAGE_PREVIEW_BYTES {
        return (text.to_string(), false);
    }

    let mut end = API_WS_MESSAGE_PREVIEW_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn close_reason(frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> String {
    match frame {
        Some(frame) if frame.reason.is_empty() => {
            format!("Peer closed the connection ({})", frame.code)
        }
        Some(frame) => format!(
            "Peer closed the connection ({}: {})",
            frame.code, frame.reason
        ),
        None => "Peer closed the connection".to_string(),
    }
}

/// Open a WebSocket client connection. Inbound messages are pushed to the
/// frontend via the `api://ws-message` event; state changes via `api://ws-status`.
#[tauri::command]
pub async fn api_ws_connect(
    id: String,
    url: String,
    app: AppHandle,
    state: State<'_, ToolboxState>,
) -> Result<(), String> {
    // Close any existing connection with the same id.
    {
        let mut ws = state.ws.lock().expect("ws state poisoned");
        if let Some(old) = ws.remove(&id) {
            if old.tx.try_send(WsCommand::Close).is_err() {
                old.token.cancel();
            }
        }
    }

    // Enforce the same limit at the protocol layer so an oversized peer frame
    // is rejected before it can become an unbounded application message.
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(API_WS_MESSAGE_PREVIEW_BYTES))
        .max_frame_size(Some(API_WS_MESSAGE_PREVIEW_BYTES));
    let (ws_stream, _) = tokio_tungstenite::connect_async_with_config(&url, Some(ws_config), false)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;
    let (mut write, mut read) = ws_stream.split();
    let (tx, mut rx) = mpsc::channel::<WsCommand>(64);
    let token = CancellationToken::new();
    let task_token = token.clone();
    let ws_state = Arc::clone(&state.ws);
    let emit_app = app.clone();
    let emit_app2 = app.clone();
    let task_id = id.clone();
    let instance_id = NEXT_WS_INSTANCE_ID.fetch_add(1, Ordering::Relaxed);

    let task = tauri::async_runtime::spawn(async move {
        let _ = emit_app.emit(
            "api://ws-status",
            WsStatusPayload {
                id: task_id.clone(),
                status: "connected".into(),
                error: None,
                reason: None,
            },
        );
        let closed_reason = loop {
            tokio::select! {
                _ = task_token.cancelled() => {
                    let _ = write.send(tokio_tungstenite::tungstenite::Message::Close(None)).await;
                    break "Closed locally".to_string();
                }
                command = rx.recv() => {
                    match command {
                        Some(WsCommand::Text(message)) => {
                            if let Err(error) = write.send(tokio_tungstenite::tungstenite::Message::Text(message.into())).await {
                                let message = format!("WebSocket write failed: {error}");
                                let _ = emit_app.emit("api://ws-status", WsStatusPayload {
                                    id: task_id.clone(), status: "error".into(), error: Some(message.clone()), reason: None,
                                });
                                break message;
                            }
                        }
                        Some(WsCommand::Close) => {
                            let _ = write.send(tokio_tungstenite::tungstenite::Message::Close(None)).await;
                            break "Closed locally".to_string();
                        }
                        None => {
                            break "WebSocket command channel closed".to_string();
                        }
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let (data, truncated) = truncate_ws_text(&text);
                            let _ = emit_app.emit(
                                "api://ws-message",
                                WsMessagePayload { id: task_id.clone(), data, timestamp: now_ms(), truncated },
                            );
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(bin))) => {
                            let truncated = bin.len() > API_WS_MESSAGE_PREVIEW_BYTES;
                            let data = base64::engine::general_purpose::STANDARD.encode(&bin[..bin.len().min(API_WS_MESSAGE_PREVIEW_BYTES)]);
                            let _ = emit_app.emit(
                                "api://ws-message",
                                WsMessagePayload { id: task_id.clone(), data, timestamp: now_ms(), truncated },
                            );
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                            if let Err(error) = write.send(tokio_tungstenite::tungstenite::Message::Pong(payload)).await {
                                let message = format!("WebSocket pong failed: {error}");
                                let _ = emit_app.emit("api://ws-status", WsStatusPayload {
                                    id: task_id.clone(), status: "error".into(), error: Some(message.clone()), reason: None,
                                });
                                break message;
                            }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(frame))) => {
                            break close_reason(frame);
                        }
                        Some(Err(error)) => {
                            let message = format!("WebSocket read failed: {error}");
                            let _ = emit_app.emit("api://ws-status", WsStatusPayload {
                                id: task_id.clone(), status: "error".into(), error: Some(message.clone()), reason: None,
                            });
                            break message;
                        }
                        None => {
                            break "WebSocket connection ended unexpectedly".to_string();
                        }
                        _ => {}
                    }
                }
            }
        };
        // A reader can exit independently of the explicit close command. Only
        // remove this task's entry so a newer connection with the same ID wins.
        let mut connections = ws_state.lock().expect("ws state poisoned");
        if connections
            .get(&task_id)
            .is_some_and(|handle| handle.instance_id == instance_id)
        {
            connections.remove(&task_id);
        }
        drop(connections);
        let _ = emit_app2.emit(
            "api://ws-status",
            WsStatusPayload {
                id: task_id.clone(),
                status: "closed".into(),
                error: None,
                reason: Some(closed_reason),
            },
        );
    });

    state.ws.lock().expect("ws state poisoned").insert(
        id,
        WsHandle {
            tx,
            token,
            task,
            instance_id,
        },
    );
    Ok(())
}

/// Send a text message on an open WebSocket connection.
#[tauri::command]
pub async fn api_ws_send(
    id: String,
    message: String,
    state: State<'_, ToolboxState>,
) -> Result<(), String> {
    // Clone the sender and drop the lock before awaiting so the future stays Send.
    let tx = {
        let ws = state.ws.lock().expect("ws state poisoned");
        match ws.get(&id) {
            Some(handle) => handle.tx.clone(),
            None => return Err("WebSocket connection not found".into()),
        }
    };
    tx.send(WsCommand::Text(message))
        .await
        .map_err(|_| "WebSocket is closed".into())
}

/// Close a WebSocket connection.
#[tauri::command]
pub async fn api_ws_close(id: String, state: State<'_, ToolboxState>) -> Result<(), String> {
    let removed = state.ws.lock().expect("ws state poisoned").remove(&id);
    if let Some(handle) = removed {
        if handle.tx.try_send(WsCommand::Close).is_err() {
            handle.token.cancel();
        }
    }
    Ok(())
}

/// Extract an application's icon as a PNG data URL.
///
/// - macOS: reads the `.icns` from an `.app` bundle (or an `.icns`/image file
///   directly) and converts it to PNG via `sips`.
/// - Windows: uses `System.Drawing.Icon.ExtractAssociatedIcon` (PowerShell) to
///   pull the icon embedded in an exe/dll and saves it as PNG.
///
/// Returns `data:image/png;base64,...` so the frontend can render it directly
/// without any fs permissions or temp-file lifecycle.
#[tauri::command]
pub async fn extract_app_icon(path: String) -> Result<String, String> {
    fn data_url(bytes: &[u8]) -> String {
        use base64::Engine as _;
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }
    fn file_data_url(p: &std::path::Path) -> Result<String, String> {
        std::fs::read(p)
            .map(|b| data_url(&b))
            .map_err(|e| format!("Failed to read {}: {}", p.display(), e))
    }

    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    // macOS `.app` bundles are directories — allow them through so the
    // bundle-icon branch below can run; any other directory is rejected.
    let is_macos_app =
        cfg!(target_os = "macos") && p.extension().and_then(|e| e.to_str()) == Some("app");
    if p.is_dir() && !is_macos_app {
        return Err(format!("Expected a file, got a directory: {}", path));
    }

    // Common image extensions can be served directly.
    if let Some(ext) = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
    {
        if matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
        ) {
            return file_data_url(p);
        }
    }

    let tmp = std::env::temp_dir().join(format!("nexterm-icon-{}.png", std::process::id()));

    #[cfg(target_os = "macos")]
    {
        let icns = if p.extension().and_then(|e| e.to_str()) == Some("icns") {
            p.to_path_buf()
        } else if p.extension().and_then(|e| e.to_str()) == Some("app") {
            // Locate the bundle's icon: Contents/Resources/*.icns
            let res_dir = p.join("Contents/Resources");
            let mut found: Option<std::path::PathBuf> = None;
            if let Ok(entries) = std::fs::read_dir(&res_dir) {
                for entry in entries.flatten() {
                    if entry.path().extension().and_then(|e| e.to_str()) == Some("icns") {
                        found = Some(entry.path());
                        break;
                    }
                }
            }
            found.ok_or_else(|| format!("No .icns found inside {}", path))?
        } else {
            return Err(format!("Unsupported icon source: {}", path));
        };

        let out = std::process::Command::new("sips")
            .args([
                "-s",
                "format",
                "png",
                icns.to_str().unwrap_or_default(),
                "--out",
                tmp.to_str().unwrap_or_default(),
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "sips failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        if !tmp.exists() {
            return Err("sips produced no output".into());
        }
        let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        return Ok(data_url(&bytes));
    }

    #[cfg(windows)]
    {
        let ps = format!(
            "Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Icon]::ExtractAssociatedIcon('{}'); $b=$i.ToBitmap(); $b.Save('{}'); $i.Dispose(); $b.Dispose()",
            path.replace('\'', "''"),
            tmp.to_str().unwrap_or_default().replace('\'', "''")
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "icon extraction failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        if !tmp.exists() {
            return Err("Failed to extract icon from the file".into());
        }
        let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        return Ok(data_url(&bytes));
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (&tmp, &file_data_url);
        Err("Icon extraction is not supported on this platform".into())
    }
}

#[cfg(test)]
mod icon_tests {
    use super::*;

    #[tokio::test]
    async fn extract_app_icon_rejects_missing_path() {
        let err = extract_app_icon("/nonexistent/definitely-missing.app".into())
            .await
            .unwrap_err();
        assert!(err.contains("Path not found"), "got: {err}");
    }

    #[tokio::test]
    async fn extract_app_icon_rejects_directories() {
        let dir = std::env::temp_dir();
        let err = extract_app_icon(dir.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(err.contains("directory"), "got: {err}");
    }

    #[tokio::test]
    async fn extract_app_icon_serves_plain_png_directly() {
        // A tiny 1x1 transparent PNG.
        let png = [
            0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let path = std::env::temp_dir().join("nexterm-icon-test.png");
        std::fs::write(&path, png).expect("write test png");
        let data_url = extract_app_icon(path.to_string_lossy().into_owned())
            .await
            .expect("should read png directly");
        let _ = std::fs::remove_file(&path);
        assert!(
            data_url.starts_with("data:image/png;base64,"),
            "got prefix: {}",
            &data_url[..40.min(data_url.len())]
        );
    }
}

#[cfg(test)]
mod tunnel_jump_tests {
    use super::*;

    fn request(jump_host: Option<&str>) -> TunnelStartRequest {
        TunnelStartRequest {
            id: "t1".into(),
            name: "test".into(),
            bind_address: "127.0.0.1".into(),
            listen_port: 9000,
            remote_host: "db.example.com".into(),
            remote_port: 5432,
            jump_host: jump_host.map(|s| s.to_string()),
            jump_port: None,
            jump_username: Some("jumpuser".into()),
            jump_password: Some("jumppass".into()),
            jump_host_key_fingerprint: Some("SHA256:test".into()),
        }
    }

    #[test]
    fn no_jump_when_host_empty() {
        assert!(build_tunnel_jump(&request(None)).unwrap().is_none());
        assert!(build_tunnel_jump(&request(Some("  "))).unwrap().is_none());
    }

    #[test]
    fn builds_password_jump() {
        let jump = build_tunnel_jump(&request(Some("bastion.example.com")))
            .unwrap()
            .unwrap();
        assert_eq!(jump.host, "bastion.example.com");
        assert_eq!(jump.port, 22);
        assert_eq!(jump.username, "jumpuser");
        match jump.auth_method {
            crate::ssh::AuthMethod::Password { password } => assert_eq!(password, "jumppass"),
            _ => panic!("expected password auth"),
        }
        assert_eq!(jump.host_key_fingerprint.as_deref(), Some("SHA256:test"));
    }

    #[test]
    fn requires_jump_username() {
        let mut req = request(Some("bastion.example.com"));
        req.jump_username = None;
        let err = build_tunnel_jump(&req).unwrap_err();
        assert!(err.contains("Jump host username is required"));
    }

    #[test]
    fn requires_jump_password() {
        let mut req = request(Some("bastion.example.com"));
        req.jump_password = None;
        let err = build_tunnel_jump(&req).unwrap_err();
        assert!(err.contains("Jump host password is required"));
    }

    #[test]
    fn respects_custom_jump_port() {
        let mut req = request(Some("bastion.example.com"));
        req.jump_port = Some(2222);
        let jump = build_tunnel_jump(&req).unwrap().unwrap();
        assert_eq!(jump.port, 2222);
    }

    #[test]
    fn requires_jump_fingerprint() {
        let mut req = request(Some("bastion.example.com"));
        req.jump_host_key_fingerprint = None;
        let error = build_tunnel_jump(&req).unwrap_err();
        assert!(error.contains("fingerprint is required"));
    }
}

#[cfg(all(test, windows))]
mod batch_script_tests {
    use super::*;

    #[test]
    fn detects_batch_extensions_case_insensitively() {
        assert!(is_batch_script("run.bat"));
        assert!(is_batch_script("deploy.BAT"));
        assert!(is_batch_script("C:\\Tools\\start.cmd"));
        assert!(is_batch_script("C:\\Program Files\\My Tool\\run.bat"));
        assert!(!is_batch_script("app.exe"));
        assert!(!is_batch_script("script.sh"));
        assert!(!is_batch_script("run.bat.exe"));
        assert!(!is_batch_script(""));
    }

    #[test]
    fn batch_invocation_quotes_spaced_paths_and_keeps_args() {
        // Path with spaces → quoted, wrapped in `call`.
        let args = ["--port", "3000"].map(String::from).to_vec();
        let cmd = batch_invocation("C:\\Program Files\\App\\start.bat", &args);
        assert_eq!(
            cmd,
            "call \"C:\\Program Files\\App\\start.bat\" --port 3000"
        );

        // Simple path, no args.
        assert_eq!(batch_invocation("run.bat", &[]), "call run.bat");

        // Arguments with spaces survive as-is (user is responsible for quoting).
        let quoted_args = ["\"my script.js\"", "-x"].map(String::from).to_vec();
        assert_eq!(
            batch_invocation("C:\\Tools\\x.cmd", &quoted_args),
            "call C:\\Tools\\x.cmd \"my script.js\" -x"
        );
    }
}

#[cfg(test)]
mod split_args_tests {
    use super::*;

    #[test]
    fn split_args_handles_quotes() {
        assert_eq!(split_args("--port 3000 -v"), vec!["--port", "3000", "-v"]);
        assert_eq!(
            split_args("\"my script.js\" --flag"),
            vec!["my script.js", "--flag"]
        );
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("  "), Vec::<String>::new());
    }
}
