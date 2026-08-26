//! Real jump-host integration test against Docker SSH containers.
//!
//! Environment:
//!   - Jump host: 127.0.0.1:2223 (mw-ssh-b, user test / testpass123)
//!   - Target:    172.17.0.4:2222 (mw-ssh-c, user test / testpass123)
//! The jump host can reach the target over the Docker bridge network.
//!
//! Run with:
//!   cargo test --test jump_integration -- --ignored --nocapture
use nexterm_lib::ssh::{AuthMethod, SshClient, SshConfig, JumpConfig};

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
    println!("connect result: {:?}", connect_result.as_ref().map(|_| "OK").map_err(|e| e.to_string()));
    assert!(connect_result.is_ok(), "connect failed: {:?}", connect_result.err());

    // Give the session a moment; then try opening a PTY shell exactly like the app does.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    println!("== create_pty_session ==");
    let pty = client.create_pty_session(80, 24, None).await;
    println!("create_pty_session result: {:?}", pty.as_ref().map(|_| "OK").map_err(|e| e.to_string()));
    assert!(pty.is_ok(), "create_pty_session failed: {:?}", pty.err());

    // Smoke-test the shell by sending a command and reading a bit of output.
    let pty = pty.unwrap();
    let _ = pty.input_tx.send(b"echo JUMP_SMOKE_OK\r".to_vec()).await;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        pty.output_rx.lock().await.recv(),
    )
    .await;
    println!("first output: {:?}", out.as_ref().map(|opt| opt.as_ref().map(|d| String::from_utf8_lossy(d).to_string())));
    assert!(out.is_ok(), "no output from shell: {:?}", out.err());

    let _ = client.disconnect().await;
    println!("== done ==");
}
