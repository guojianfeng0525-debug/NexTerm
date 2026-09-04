//! Real jump-host integration test against Docker SSH containers.
//!
//! Environment:
//!   - Jump host: 127.0.0.1:2223 (mw-ssh-b, user test / testpass123)
//!   - Target:    172.17.0.4:2222 (mw-ssh-c, user test / testpass123)
//!     跳板机可以通过 Docker bridge 网络访问目标主机。
//!
//! Run with:
//!   cargo test --test jump_integration -- --ignored --nocapture
use nexterm_lib::ssh::{AuthMethod, JumpConfig, SshClient, SshConfig};

const JUMP_HOST: &str = "127.0.0.1";
const JUMP_PORT: u16 = 2223;
const JUMP_USER: &str = "test";
const JUMP_PASS: &str = "testpass123";

const TARGET_HOST: &str = "172.17.0.4";
const TARGET_PORT: u16 = 2222;
const TARGET_USER: &str = "test";
const TARGET_PASS: &str = "testpass123";

fn jump_config() -> JumpConfig {
    JumpConfig {
        host: JUMP_HOST.to_string(),
        port: JUMP_PORT,
        username: JUMP_USER.to_string(),
        auth_method: AuthMethod::Password {
            password: JUMP_PASS.to_string(),
        },
        host_key_fingerprint: None,
    }
}

#[tokio::test]
#[ignore]
async fn connect_through_jump_and_open_pty() {
    let config = SshConfig {
        host: TARGET_HOST.to_string(),
        port: TARGET_PORT,
        username: TARGET_USER.to_string(),
        auth_method: AuthMethod::Password {
            password: TARGET_PASS.to_string(),
        },
        keepalive_interval: Some(60),
        keepalive_max: Some(3),
        proxy: None,
        jump: Some(jump_config()),
        host_key_fingerprint: None,
        host_key_verification: false,
    };

    let mut client = SshClient::new();
    println!("== connect (jump {JUMP_HOST}:{JUMP_PORT} -> target {TARGET_HOST}:{TARGET_PORT}) ==");
    let connect_result = client.connect(&config).await;
    println!(
        "connect result: {:?}",
        connect_result
            .as_ref()
            .map(|_| "OK")
            .map_err(|e| e.to_string())
    );
    assert!(
        connect_result.is_ok(),
        "connect failed: {:?}",
        connect_result.err()
    );

    // Give the session a moment; then try opening a PTY shell exactly like the app does.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    println!("== create_pty_session ==");
    let pty = client.create_pty_session(80, 24, None).await;
    println!(
        "create_pty_session result: {:?}",
        pty.as_ref().map(|_| "OK").map_err(|e| e.to_string())
    );
    assert!(pty.is_ok(), "create_pty_session failed: {:?}", pty.err());

    // Smoke-test the shell by sending a command and reading a bit of output.
    let pty = pty.unwrap();
    let _ = pty.input_tx.send(b"echo JUMP_SMOKE_OK\r".to_vec()).await;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        pty.output_rx.lock().await.recv(),
    )
    .await;
    println!(
        "first output: {:?}",
        out.as_ref()
            .map(|opt| opt.as_ref().map(|d| String::from_utf8_lossy(d).to_string()))
    );
    assert!(out.is_ok(), "no output from shell: {:?}", out.err());

    let _ = client.disconnect().await;
    println!("== done ==");
}

/// Probe the TARGET host's fingerprint through the jump fixture
/// (e2e/fixtures/ssh-jump on 127.0.0.1:22022, jumpuser/jumppass).
///
/// The target is the jump container's own sshd on its Docker bridge IP
/// (172.17.0.3:22) — reachable only from the Docker network, NOT from the
/// host. This mirrors the real ProxyJump scenario: a direct probe times out
/// while the jump-tunnelled probe succeeds.
///
/// Run with:
///   docker run -d --name nexterm-ssh-jump -p 22022:22 nexterm-ssh-jump-fixture:local
///   PROBE_JUMP_IP=172.17.0.3 cargo test --test jump_integration probe_target_fingerprint -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn probe_target_fingerprint_through_jump() {
    let target_ip = std::env::var("PROBE_JUMP_IP").unwrap_or_else(|_| "172.17.0.3".to_string());
    let jump = JumpConfig {
        host: "127.0.0.1".to_string(),
        port: 22022,
        username: "jumpuser".to_string(),
        auth_method: AuthMethod::Password {
            password: "jumppass".to_string(),
        },
        host_key_fingerprint: None,
    };

    // Direct probe to the Docker-bridge IP must fail — the host cannot route
    // into the bridge network (this is the user-reported bug scenario).
    let direct = nexterm_lib::ssh::probe_host_key(&target_ip, 22).await;
    assert!(
        direct.is_err(),
        "direct probe unexpectedly succeeded: {:?}",
        direct
    );

    // Through the jump tunnel it must succeed and return a fingerprint.
    let via_jump = nexterm_lib::ssh::probe_host_key_via_jump(&target_ip, 22, &jump).await;
    assert!(
        via_jump.is_ok(),
        "jump probe failed: {:?}",
        via_jump.as_ref().err()
    );
    let fingerprint = via_jump.unwrap();
    assert!(!fingerprint.is_empty(), "empty fingerprint");
    println!("target {target_ip}:22 fingerprint via jump: {fingerprint}");
}
