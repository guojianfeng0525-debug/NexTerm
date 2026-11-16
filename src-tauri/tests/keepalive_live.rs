//! Live keepalive + shell-integration tests against real Docker SSH servers.
//!
//! Fixture image: `e2e/fixtures/ssh-idle` (Debian + OpenSSH + zsh + fish,
//! users testuser/testpass123 (bash), zshuser/zshpass123 (zsh),
//! fishuser/fishpass123 (fish)).
//!
//! ```sh
//! docker build -t nexterm-ssh-idle:latest e2e/fixtures/ssh-idle
//! docker network create nexterm-idle-net
//! # Default sshd (no idle timeout)
//! docker run -d --name nexterm-ssh-idle --network nexterm-idle-net \
//!   -p 2222:22 nexterm-ssh-idle:latest
//! # Aggressive server: probes the client every 5s, kills after 2 missed
//! docker run -d --name nexterm-ssh-idle-aggressive --network nexterm-idle-net \
//!   -p 2223:22 nexterm-ssh-idle:latest \
//!   /usr/sbin/sshd -D -e -o ClientAliveInterval=5 -o ClientAliveCountMax=2
//! # Idle-killing middlebox (simulates NAT/firewall idle reaping)
//! docker run -d --name nexterm-ssh-idle-proxy --network nexterm-idle-net \
//!   -p 2300:2300 nexterm-ssh-idle:latest \
//!   socat -T10 TCP-LISTEN:2300,fork,reuseaddr TCP:nexterm-ssh-idle:22
//!
//! NEXTERM_IDLE_SSH_HOST=127.0.0.1 \
//!   cargo test --test keepalive_live -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Skipped unless `NEXTERM_IDLE_SSH_HOST` is set.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use nexterm_lib::connection_manager::ConnectionManager;
use nexterm_lib::ssh::{AuthMethod, PtySession, SshClient, SshConfig};
use nexterm_lib::websocket_server::{WebSocketServer, WsMessage};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn host() -> String {
    env_opt("NEXTERM_IDLE_SSH_HOST").unwrap_or_else(|| "127.0.0.1".into())
}

fn ssh_port() -> u16 {
    env_opt("NEXTERM_IDLE_SSH_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2222)
}

fn aggressive_port() -> u16 {
    env_opt("NEXTERM_IDLE_SSH_AGGRESSIVE_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2223)
}

fn proxy_port() -> u16 {
    env_opt("NEXTERM_IDLE_SSH_PROXY_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2300)
}

fn config_for(port: u16, username: &str, password: &str, keepalive: Option<u64>) -> SshConfig {
    SshConfig {
        host: host(),
        port,
        username: username.into(),
        auth_method: AuthMethod::Password {
            password: password.into(),
        },
        keepalive_interval: keepalive,
        keepalive_max: keepalive.map(|_| 20),
        proxy: None,
        jump: None,
        host_key_fingerprint: None,
        host_key_verification: false,
    }
}

/// How long the idle windows last. Every kill mechanism in the fixtures
/// fires well within this budget (aggressive sshd: ~15 s, socat -T10: 10 s),
/// so surviving the window proves keepalive traffic actually flowed.
const IDLE_WINDOW: Duration = Duration::from_secs(45);

async fn assert_session_still_usable(client: &mut SshClient, label: &str) {
    assert!(
        client.is_connected(),
        "{label}: SSH transport should still be alive after the idle window"
    );
    let marker = format!("nexterm-alive-{}", std::process::id());
    let output = client
        .execute_command(&format!("echo {marker}"))
        .await
        .unwrap_or_else(|e| panic!("{label}: command after idle failed: {e}"));
    assert!(
        output.contains(&marker),
        "{label}: unexpected command output: {output:?}"
    );
}

// ---------------------------------------------------------------------------
// 1. Server-driven idle kill (ClientAliveInterval) must not drop the session
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn idle_session_survives_aggressive_client_alive_probes() {
    let mut client = SshClient::new();
    client
        .connect(&config_for(
            aggressive_port(),
            "testuser",
            "testpass123",
            Some(5),
        ))
        .await
        .expect("connect to aggressive sshd");
    println!("== connected to aggressive sshd (ClientAliveInterval=5, CountMax=2) ==");
    println!("== idling {}s ==", IDLE_WINDOW.as_secs());
    tokio::time::sleep(IDLE_WINDOW).await;
    assert_session_still_usable(&mut client, "aggressive-sshd").await;
    client.disconnect().await.unwrap();
}

// ---------------------------------------------------------------------------
// 2. Middlebox idle kill (socat -T10): client keepalive traffic must keep
//    the tunnel alive; without keepalive the tunnel must demonstrably die
//    (control case validating the fixture itself).
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn keepalive_traffic_survives_idle_killing_middlebox() {
    let mut client = SshClient::new();
    client
        .connect(&config_for(proxy_port(), "testuser", "testpass123", Some(5)))
        .await
        .expect("connect through socat idle killer with keepalive");
    println!("== connected via socat -T10 with 5s keepalive; idling {}s ==", IDLE_WINDOW.as_secs());
    tokio::time::sleep(IDLE_WINDOW).await;
    assert_session_still_usable(&mut client, "idle-middlebox-protected").await;
    client.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore]
async fn without_keepalive_the_idle_middlebox_kills_the_tunnel() {
    let mut client = SshClient::new();
    client
        .connect(&config_for(proxy_port(), "testuser", "testpass123", None))
        .await
        .expect("connect through socat idle killer without keepalive");
    println!("== connected via socat -T10 with keepalive DISABLED; expecting reap ==");
    // 30 s = 3x the socat inactivity timeout.
    tokio::time::sleep(Duration::from_secs(30)).await;
    let alive = client.is_connected();
    let command_works = client.execute_command("echo probe").await.is_ok();
    assert!(
        !(alive && command_works),
        "control case failed: the idle middlebox should have reaped the keepalive-less tunnel \
         (alive={alive}, command_works={command_works})"
    );
}

// ---------------------------------------------------------------------------
// 3. Full stack: ConnectionManager + WebSocketServer + a WS client behaving
//    like the frontend. The whole pipeline must survive an idle window.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn full_stack_pty_session_survives_idle_over_websocket() {
    let manager = std::sync::Arc::new(ConnectionManager::new());
    manager
        .create_connection(
            "live".into(),
            config_for(ssh_port(), "testuser", "testpass123", Some(5)),
        )
        .await
        .expect("create SSH connection");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = std::sync::Arc::new(WebSocketServer::new(manager.clone()));
    tokio::spawn(async move {
        let _ = server.serve_listener(listener).await;
    });

    let (mut ws, _) = connect_async(&url).await.expect("ws connect");
    ws.send(Message::Text(
        serde_json::to_string(&WsMessage::StartPty {
            connection_id: "live".into(),
            cols: 80,
            rows: 24,
            default_directory: None,
            resume_generation: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut generation = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while generation.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("timed out waiting for PtyStarted")
            .unwrap()
            .unwrap();
        if let Message::Text(text) = msg {
            if let WsMessage::PtyStarted {
                connection_id,
                generation: gen,
                resumed,
            } = serde_json::from_str::<WsMessage>(&text).unwrap()
            {
                assert_eq!(connection_id, "live");
                assert!(!resumed);
                generation = Some(gen);
            }
        }
    }
    let generation = generation.unwrap();
    // Seed the flow-control pipeline like the frontend does on PtyStarted
    // (INITIAL_WINDOW credits); the reader blocks on the semaphore otherwise
    // and never flushes the initial prompt.
    for _ in 0..2 {
        ws.send(Message::Text(
            serde_json::to_string(&WsMessage::Resume {
                connection_id: "live".into(),
            })
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    }
    let idle_secs: u64 = std::env::var("NEXTERM_IDLE_WINDOW_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(40);
    println!("== full stack connected (generation {generation}); idling {idle_secs}s ==");

    // Idle: keep reading, ACK every binary frame with a Resume credit
    // exactly like the frontend does, and flush queued pongs so the server's
    // 45s pong watchdog sees us alive (browsers flush pongs natively; a
    // bare tungstenite client must flush explicitly). No Error frame may
    // arrive during the window.
    let idle_deadline = tokio::time::Instant::now() + Duration::from_secs(idle_secs);
    let mut saw_error: Option<String> = None;
    while tokio::time::Instant::now() < idle_deadline {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;
        match msg {
            Err(_) => continue, // 2s tick: loop re-checks the deadline
            Ok(None) => panic!("websocket closed during idle"),
            Ok(Some(Ok(Message::Binary(_)))) => {
                ws.send(Message::Text(
                    serde_json::to_string(&WsMessage::Resume {
                        connection_id: "live".into(),
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
            }
            Ok(Some(Ok(Message::Text(text)))) => {
                if let WsMessage::Error { message } = serde_json::from_str(&text).unwrap() {
                    saw_error = Some(message);
                    break;
                }
            }
            // Ping/Pong/Close frames: tungstenite queues the automatic pong
            // on read; flush it or the server watchdog reaps the transport.
            Ok(Some(Ok(_))) => {
                ws.flush().await.unwrap();
            }
            Ok(Some(Err(e))) => panic!("ws error during idle: {e}"),
        }
    }
    assert!(
        saw_error.is_none(),
        "no Error frame may arrive during idle, got: {:?}",
        saw_error
    );

    // The remote shell must still be the SAME interactive session.
    let marker = format!("still-alive-{generation}");
    ws.send(Message::Text(
        serde_json::to_string(&WsMessage::Input {
            connection_id: "live".into(),
            data: format!("echo {marker}\n").into_bytes(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let echo_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut terminal_output = Vec::new();
    let mut echoed = false;
    while !echoed {
        let remaining = echo_deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for echo output");
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("timed out waiting for echo output")
            .unwrap()
            .unwrap();
        match msg {
            Message::Binary(frame) => {
                let id_len = u16::from_be_bytes([frame[1], frame[2]]) as usize;
                terminal_output.extend_from_slice(&frame[3 + id_len..]);
                ws.send(Message::Text(
                    serde_json::to_string(&WsMessage::Resume {
                        connection_id: "live".into(),
                    })
                    .unwrap()
                    .into(),
                ))
                .await
                .unwrap();
                if String::from_utf8_lossy(&terminal_output).contains(&marker) {
                    echoed = true;
                }
            }
            Message::Text(text) => {
                if let WsMessage::Error { message } = serde_json::from_str(&text).unwrap() {
                    panic!("error frame after idle: {message}");
                }
            }
            // Ping frames: flush the queued pong (see idle loop note).
            _ => {
                ws.flush().await.unwrap();
            }
        }
    }
    assert!(
        manager.is_ssh_connection_alive("live").await,
        "SSH connection must still be alive after idle"
    );
    println!("== same shell still interactive after 40s idle ==");

    ws.send(Message::Text(
        serde_json::to_string(&WsMessage::Close {
            connection_id: "live".into(),
            generation: Some(generation),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.close(None).await;
    manager.close_connection("live").await.unwrap();
    assert!(!manager.is_ssh_connection_alive("live").await);
}

// ---------------------------------------------------------------------------
// 4. Shell integration (OSC 7 cwd reporting) across bash / zsh / fish —
//    the mechanism the file browser's directory-following depends on.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Executed-command reporting (OSC 7777 + base64) across bash / zsh / fish
//    — the mechanism the command-history/record feature depends on. The hook
//    reports the EXACT submitted line: multi-line, CJK, history-recalled.
// ---------------------------------------------------------------------------

/// Pull every complete OSC 7777 report out of `buf` (in place) and decode it.
fn drain_command_reports(buf: &mut Vec<u8>) -> Vec<String> {
    use base64::Engine as _;
    let mut commands = Vec::new();
    loop {
        let text = String::from_utf8_lossy(buf);
        let Some(start) = text.find("\x1b]7777;") else { break };
        let payload_start = start + "\x1b]7777;".len();
        let Some(end) = text[payload_start..].find(|c| c == '\x1b' || c == '\x07') else {
            break; // incomplete — wait for more output
        };
        let end = payload_start + end;
        let terminator_len = if text[end..].starts_with("\x1b\\") { 2 } else { 1 };
        let payload = &text[payload_start..end];
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(payload) {
            if let Ok(command) = String::from_utf8(decoded) {
                commands.push(command);
            }
        }
        buf.drain(..end + terminator_len);
    }
    buf.shrink_to_fit();
    commands
}

/// Read PTY output until `want` reports have arrived, returning all of them.
async fn read_command_reports(pty: &PtySession, want: usize) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut buf: Vec<u8> = Vec::new();
    let mut reports: Vec<String> = Vec::new();
    while reports.len() < want {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for {want} command reports; got {reports:?}; output tail: {:?}",
            String::from_utf8_lossy(&buf)
        );
        let chunk = tokio::time::timeout(remaining, pty.output_rx.lock().await.recv())
            .await
            .expect("timed out waiting for command report output")
            .expect("PTY output channel closed");
        buf.extend_from_slice(&chunk);
        reports.extend(drain_command_reports(&mut buf));
    }
    reports
}

async fn assert_no_command_report(pty: &PtySession, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    let mut buf: Vec<u8> = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let chunk = tokio::time::timeout(remaining, pty.output_rx.lock().await.recv()).await;
        if let Ok(Some(data)) = chunk {
            buf.extend_from_slice(&data);
        }
    }
    let reports = drain_command_reports(&mut buf);
    assert!(
        reports.is_empty(),
        "no command report expected in this window, got {reports:?}"
    );
}

async fn assert_shell_reports_commands(username: &str, password: &str, dedup_on_recall: bool) {
    std::env::set_var("LC_ALL", "C.UTF-8");
    let mut client = SshClient::new();
    client
        .connect(&config_for(ssh_port(), username, password, Some(5)))
        .await
        .expect("connect");

    let pty = client.create_pty_session(80, 24, None).await.expect("pty");

    // Plain command — exact text, first report.
    pty.input_tx
        .send(b"echo nexterm-one\n".to_vec())
        .await
        .unwrap();
    let reports = read_command_reports(&pty, 1).await;
    assert_eq!(reports[0], "echo nexterm-one", "[{username}]");

    // CJK + spaces survive exactly.
    pty.input_tx
        .send("echo '中文 probe 42'\n".as_bytes().to_vec())
        .await
        .unwrap();
    let reports = read_command_reports(&pty, 1).await;
    assert_eq!(reports[0], "echo '中文 probe 42'", "[{username}]");

    // Multi-line command (line continuation) reported as ONE entry.
    pty.input_tx
        .send(b"echo nexterm-\\\nmulti-line\n".to_vec())
        .await
        .unwrap();
    let reports = read_command_reports(&pty, 1).await;
    assert!(
        reports[0].contains("nexterm-") && reports[0].contains("multi-line"),
        "[{username}] multi-line command must be reported whole: {:?}",
        reports[0]
    );

    // Empty Enter submits nothing — no report.
    pty.input_tx.send(b"\n".to_vec()).await.unwrap();
    assert_no_command_report(&pty, Duration::from_secs(2)).await;

    // Arrow-Up + Enter re-executes the last command. zsh/fish always report
    // the re-submission. bash follows the user's HISTCONTROL: the fixture's
    // Debian default .bashrc sets `ignoredups`, so the immediate recall is
    // not re-numbered and correctly stays silent (no phantom record).
    pty.input_tx.send(b"\x1b[A\r".to_vec()).await.unwrap();
    if dedup_on_recall {
        assert_no_command_report(&pty, Duration::from_secs(3)).await;
    } else {
        let reports = read_command_reports(&pty, 1).await;
        assert!(
            reports[0].contains("multi-line"),
            "[{username}] history-recalled command must be reported: {:?}",
            reports[0]
        );
    }
    println!("[{username}] executed-command reports verified (OSC 7777)");

    let _ = pty.input_tx.send(b"exit\n".to_vec()).await;
    client.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore]
async fn bash_shell_reports_executed_commands() {
    assert_shell_reports_commands("testuser", "testpass123", true).await;
}

#[tokio::test]
#[ignore]
async fn zsh_shell_reports_executed_commands() {
    assert_shell_reports_commands("zshuser", "zshpass123", false).await;
}

#[tokio::test]
#[ignore]
async fn fish_shell_reports_executed_commands() {
    assert_shell_reports_commands("fishuser", "fishpass123", false).await;
}

async fn read_until_osc7(pty: &PtySession) -> Vec<u8> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut output = Vec::new();
    // Succeed as soon as a complete OSC 7 appears anywhere in the buffer —
    // shells usually emit more prompt bytes right after the terminator, so
    // requiring the buffer to END with ESC-\ would wait forever.
    while !output
        .windows(b"]7;file://".len())
        .any(|window| window == b"]7;file://")
    {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for OSC 7 report; received so far: {:?}",
            String::from_utf8_lossy(&output)
        );
        let chunk = tokio::time::timeout(remaining, pty.output_rx.lock().await.recv()).await;
        match chunk {
            Ok(Some(data)) => output.extend_from_slice(&data),
            Ok(None) => panic!(
                "PTY output channel closed; received so far: {:?}",
                String::from_utf8_lossy(&output)
            ),
            Err(_) => panic!(
                "timed out waiting for OSC 7; received so far: {:?}",
                String::from_utf8_lossy(&output)
            ),
        }
    }
    output
}

/// Read PTY output until an OSC 7 report matching `expected_path` arrives.
/// Prompt redraws can emit several reports (still pointing at the previous
/// directory), so intermediate ones are tolerated. Accumulates RAW bytes and
/// only converts per whole buffer — a multi-byte UTF-8 path split across SSH
/// data chunks would otherwise be corrupted by per-chunk lossy conversion.
async fn read_until_osc7_path(pty: &PtySession, expected_path: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut output = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let chunk = tokio::time::timeout(remaining, pty.output_rx.lock().await.recv()).await;
        match chunk {
            Ok(Some(data)) => output.extend_from_slice(&data),
            Ok(None) => panic!(
                "PTY output channel closed; received so far: {:?}",
                String::from_utf8_lossy(&output)
            ),
            Err(_) => panic!(
                "timed out waiting for OSC 7 path {expected_path:?}; received so far: {:?}",
                String::from_utf8_lossy(&output)
            ),
        }
        if osc7_paths(&String::from_utf8_lossy(&output))
            .iter()
            .any(|path| path == expected_path)
        {
            return;
        }
    }
}

/// Extract every path from OSC 7 reports: `file://<host><path>ESC \`.
fn osc7_paths(output: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut rest = output;
    while let Some(idx) = rest.find("]7;file://") {
        rest = &rest[idx + "]7;file://".len()..];
        let Some(end) = rest.find('\x1b') else { break };
        let report = &rest[..end];
        if let Some(slash) = report.find('/') {
            paths.push(report[slash..].to_string());
        }
        rest = &rest[end..];
    }
    paths
}

async fn assert_shell_reports_cwd(username: &str, password: &str) {
    // The fixture container only ships the C.UTF-8 locale. create_pty_session
    // propagates the CLIENT locale (OpenSSH `SendEnv LANG` semantics); pin it
    // here so the propagated value is valid on the server (a developer host's
    // e.g. en_US.UTF-8 is not installed in the minimal fixture).
    std::env::set_var("LC_ALL", "C.UTF-8");
    let mut client = SshClient::new();
    client
        .connect(&config_for(ssh_port(), username, password, Some(5)))
        .await
        .expect("connect");

    // Default start: the first OSC 7 must report the login directory.
    let pty = client.create_pty_session(80, 24, None).await.expect("pty");
    let first = read_until_osc7(&pty).await;
    let first = String::from_utf8_lossy(&first);
    println!("[{username}] first OSC 7: {:?}", first);
    assert!(
        first.contains(&format!("/home/{username}")),
        "[{username}] first OSC 7 should report the login directory, got: {first:?}"
    );

    // cd must be reported too — with the exact percent escapes for special
    // characters (a misparsed substitution shows up as a wrong path).
    pty.input_tx
        .send(b"cd '/srv/release files/\xe5\xad\x90\xe7\x9b\xae\xe5\xbd\x95'\n".to_vec())
        .await
        .unwrap();
    read_until_osc7_path(&pty, "/srv/release%20files/\u{5b50}\u{76ee}\u{5f55}").await;
    println!("[{username}] cd reported via OSC 7");

    // default_directory must take effect without polluting shell history.
    let pty2 = client
        .create_pty_session(80, 24, Some("/srv"))
        .await
        .expect("pty with default directory");
    read_until_osc7_path(&pty2, "/srv").await;
    println!("[{username}] default directory reported via OSC 7");

    // A VANISHED directory (e.g. the pre-disconnect cwd was deleted while
    // offline) must degrade to the login directory — the shell may not die
    // into a reconnect loop.
    let pty3 = client
        .create_pty_session(80, 24, Some("/nonexistent-nexterm-dir"))
        .await
        .expect("pty with vanished directory");
    read_until_osc7_path(&pty3, &format!("/home/{username}")).await;
    println!("[{username}] vanished directory degrades to login directory");
    let _ = pty3.input_tx.send(b"exit\n".to_vec()).await;

    let _ = pty.input_tx.send(b"exit\n".to_vec()).await;
    let _ = pty2.input_tx.send(b"exit\n".to_vec()).await;
    client.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore]
async fn bash_shell_reports_working_directory() {
    assert_shell_reports_cwd("testuser", "testpass123").await;
}

#[tokio::test]
#[ignore]
async fn zsh_shell_reports_working_directory() {
    assert_shell_reports_cwd("zshuser", "zshpass123").await;
}

#[tokio::test]
#[ignore]
async fn fish_shell_reports_working_directory() {
    assert_shell_reports_cwd("fishuser", "fishpass123").await;
}
