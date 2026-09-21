//! Live streaming log tests against a real container.
//!
//! Skipped unless `LOG_STREAM_LIVE=1`. Reuses the topology-probe debian
//! fixture (ssh root/probepass):
//!
//! ```sh
//! docker build -t nexterm-probe-web:local e2e/fixtures/topology-probe/debian
//! LOG_STREAM_LIVE=1 cargo test --test log_stream_live -- --ignored --nocapture
//! ```
//!
//! What is proven here that unit tests cannot: the full
//! channel-open → exec → chunked reads → event throttle → explicit channel
//! close lifecycle of `SshClient::exec_stream`, including that a stopped
//! `tail -f` really releases the remote process (no leaked tail on the
//! server) and that new file content keeps arriving while the stream runs.

use std::time::Duration;

use nexterm_lib::ssh::{AuthMethod, SshClient, SshConfig, StreamEnd};
use tokio_util::sync::CancellationToken;

const IMAGE: &str = "nexterm-probe-web:local";

fn live_enabled() -> bool {
    std::env::var("LOG_STREAM_LIVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn image_exists() -> bool {
    std::process::Command::new("docker")
        .args(["image", "inspect", IMAGE])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn sh(cmd: &str) {
    let out = std::process::Command::new("sh").arg("-c").arg(cmd).output().expect("sh");
    assert!(
        out.status.success(),
        "command failed: {cmd}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
#[ignore]
async fn exec_stream_delivers_chunks_and_stops_cleanly() {
    if !live_enabled() || !image_exists() {
        eprintln!("skipping: set LOG_STREAM_LIVE=1 and build the fixture image (see module docs)");
        return;
    }
    sh("docker rm -f nt-log-stream >/dev/null 2>&1 || true; \
        docker run -d --rm --name nt-log-stream -p 127.0.0.1:19122:22 nexterm-probe-web:local >/dev/null");
    let _guard = CleanupGuard;

    // Wait for sshd.
    for _ in 0..60 {
        if std::process::Command::new("sh")
            .arg("-c")
            .arg("nc -z -w1 127.0.0.1 19122 && echo ok || true")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("ok"))
            .unwrap_or(false)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let config = SshConfig {
        host: "127.0.0.1".into(),
        port: 19122,
        username: "root".into(),
        auth_method: AuthMethod::Password { password: "probepass".into() },
        keepalive_interval: Some(15),
        keepalive_max: Some(3),
        proxy: None,
        jump: None,
        host_key_fingerprint: None,
        host_key_verification: false,
    };
    let mut client = SshClient::new();
    client.connect(&config).await.expect("ssh connect");
    let session = client.session_handle().expect("session handle");

    // Seed the log file and start tail -f.
    client
        .execute_command("printf 'line-1\\nline-2\\n' > /tmp/stream.log")
        .await
        .expect("seed log");

    let cancel = CancellationToken::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let tail_cancel = cancel.clone();
    let stream_session = session.clone();
    let stream_task = tokio::spawn(async move {
        let mut received = String::new();
        let result = SshClient::exec_stream(
            &stream_session,
            "tail -f /tmp/stream.log",
            tail_cancel,
            |chunk| {
                received.push_str(&chunk);
                let _ = tx.send(received.clone());
            },
        )
        .await;
        result
    });

    // Initial content must arrive.
    let mut saw_initial = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if let Ok(snapshot) = rx.try_recv() {
            if snapshot.contains("line-1") && snapshot.contains("line-2") {
                saw_initial = true;
                break;
            }
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    assert!(saw_initial, "tail -f must deliver the initial lines");

    // Append and see the new line arrive.
    client
        .execute_command("echo line-3 >> /tmp/stream.log")
        .await
        .expect("append");
    let mut saw_appended = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if let Ok(snapshot) = rx.try_recv() {
            if snapshot.contains("line-3") {
                saw_appended = true;
                break;
            }
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    assert!(saw_appended, "appended line must stream through");

    // Stop: the task must observe Cancelled promptly.
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(5), stream_task)
        .await
        .expect("stream task finishes after cancel")
        .expect("join ok");
    assert_eq!(result.expect("exec_stream ok"), StreamEnd::Cancelled);

    // The remote tail process must be gone (channel close → SIGHUP to tail).
    tokio::time::sleep(Duration::from_millis(500)).await;
    let procs = client
        .execute_command("ps -ef | grep 'tail -f /tmp/stream.log' | grep -v grep || true")
        .await
        .expect("ps");
    assert!(
        procs.trim().is_empty(),
        "stopped stream must not leak a remote tail process, ps output: {procs}"
    );

    client.disconnect().await.ok();
}

struct CleanupGuard;
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg("docker rm -f nt-log-stream >/dev/null 2>&1 || true")
            .status();
    }
}
