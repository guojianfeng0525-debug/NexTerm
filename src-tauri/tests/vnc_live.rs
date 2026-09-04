//! Live VNC integration tests against a containerized x11vnc server.
//!
//! Skipped unless `VNC_TEST_HOST` is set. The fixture image lives in
//! `e2e/fixtures/vnc` (Alpine + Xvfb 1280x800 + openbox + xterm +
//! x11vnc, VNC-Auth password `vncpass`):
//!
//! ```sh
//! docker build -t nexterm-vnc-fixture:local e2e/fixtures/vnc
//! docker run -d --name nexterm-vnc -p 5900:5900 nexterm-vnc-fixture:local
//!
//! # Direct connection
//! VNC_TEST_HOST=127.0.0.1 VNC_TEST_PASS=vncpass \
//!   cargo test --test vnc_live -- --ignored --nocapture
//!
//! # Through an SSH jump host (e.g. the shared ssh fixture on :22222,
//! # test/testpass — the target address is resolved from inside the jump
//! # container, hence host.docker.internal)
//! VNC_TEST_HOST=127.0.0.1 VNC_TEST_PASS=vncpass \
//! VNC_JUMP_HOST=127.0.0.1 VNC_JUMP_PORT=22222 \
//! VNC_JUMP_USER=test VNC_JUMP_PASS=testpass \
//! VNC_JUMP_TARGET=host.docker.internal \
//!   cargo test --test vnc_live jump -- --ignored --nocapture
//! ```
//!
//! On success the composited screen is dumped to `/tmp/vnc-live-frame.bin`
//! (+ `/tmp/vnc-live-meta.json`) so the frame can be encoded to PNG and
//! visually verified.

use std::time::Duration;

use nexterm_lib::desktop_protocol::{DesktopEvent, DesktopProtocol, VncConfig};
use nexterm_lib::vnc_client::VncClient;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use nexterm_lib::desktop_protocol::JumpHostConfig;

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Compose dirty frames into a full-screen RGBA buffer (shared shape with
/// the RDP live test).
fn blit(buffer: &mut [u8], screen_w: usize, frame: &nexterm_lib::desktop_protocol::FrameUpdate) {
    let fw = frame.width as usize;
    let fh = frame.height as usize;
    for row in 0..fh {
        let dst_y = frame.y as usize + row;
        if dst_y >= 4096 {
            continue;
        }
        let dst_x = frame.x as usize;
        let copy = fw.min(screen_w.saturating_sub(dst_x));
        if copy == 0 {
            continue;
        }
        let src = row * fw * 4;
        let dst = (dst_y * screen_w + dst_x) * 4;
        let len = copy * 4;
        if src + len <= frame.rgba_data.len() && dst + len <= buffer.len() {
            buffer[dst..dst + len].copy_from_slice(&frame.rgba_data[src..src + len]);
        }
    }
}

struct Collected {
    width: u16,
    height: u16,
    frames: usize,
    distinct_values: usize,
}

/// Connect with `config`, run the frame loop briefly and analyse the
/// composited screen.
async fn connect_and_collect(config: &VncConfig, seconds: u64) -> Collected {
    let client = VncClient::connect(config)
        .await
        .expect("VNC connect failed");

    let (width, height) = client.desktop_size();
    println!("connected, desktop size {width}x{height}");

    // Exercise the complete keyboard path before requesting framebuffer
    // updates. The fixture's focused xterm should echo `aAAaa`:
    // plain a, Shift+a, Caps+a, Shift+Caps+a, then Caps off + a.
    async fn press(client: &VncClient, key_code: u32, caps_lock: Option<bool>) {
        client
            .send_key(key_code, true, caps_lock, None)
            .await
            .expect("key press failed");
        tokio::time::sleep(Duration::from_millis(40)).await;
        client
            .send_key(key_code, false, caps_lock, None)
            .await
            .expect("key release failed");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }

    if config.jump_host.is_some() {
        // Clear any keyboard text left by an earlier run against the same
        // fixture (Ctrl+C), making the echoed sequence deterministic.
        client
            .send_key(17, true, None, None)
            .await
            .expect("Control press failed");
        press(&client, 67, None).await; // Ctrl+C
        client
            .send_key(17, false, None, None)
            .await
            .expect("Control release failed");
        tokio::time::sleep(Duration::from_millis(120)).await;

        press(&client, 65, None).await; // a
        client
            .send_key(16, true, None, None)
            .await
            .expect("Shift press failed");
        press(&client, 65, None).await; // Shift+a -> A
        client
            .send_key(16, false, None, None)
            .await
            .expect("Shift release failed");
        // Windows can report the stale pre-toggle value on CapsLock itself.
        // The physical keydown advances the backend latch; the next derived
        // letter state then keeps the client latch authoritative.
        press(&client, 20, Some(false)).await; // CapsLock on
        press(&client, 65, Some(true)).await; // Caps+a -> A
        client
            .send_key(16, true, None, None)
            .await
            .expect("Shift press failed");
        press(&client, 65, Some(true)).await; // Shift+Caps+a -> a
        client
            .send_key(16, false, None, None)
            .await
            .expect("Shift release failed");
        press(&client, 20, Some(false)).await; // CapsLock off
        press(&client, 65, Some(false)).await; // a
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    client
        .start_frame_loop(tx, cancel.clone())
        .await
        .expect("frame loop failed to start");

    let mut buffer = vec![0u8; width as usize * height as usize * 4];
    let mut frames = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(Some(DesktopEvent::Frame(frame))) => {
                frames += 1;
                blit(&mut buffer, width as usize, &frame);
            }
            Ok(Some(DesktopEvent::Resized { width, height })) => {
                println!("resized to {width}x{height}");
            }
            Ok(Some(DesktopEvent::ClipboardText(text))) => {
                println!("clipboard: {text:?}");
            }
            Ok(Some(DesktopEvent::Terminated(reason))) => {
                panic!("session terminated early: {reason}");
            }
            Ok(None) => break,
            Err(_) => {}
        }
    }
    cancel.cancel();

    // Distinct byte values: a rendered desktop (windows, text, colors) has
    // far more than a blank screen.
    let mut values = [false; 256];
    for b in &buffer {
        values[*b as usize] = true;
    }
    let distinct_values = values.iter().filter(|&&v| v).count();

    // Persist for visual verification.
    let out = format!("/tmp/vnc-live-frame-{}.bin", config.port);
    std::fs::write(&out, &buffer).expect("dump frame");
    let meta = format!(
        "{{\"width\":{},\"height\":{},\"frames\":{},\"path\":\"{}\"}}",
        width, height, frames, out
    );
    std::fs::write("/tmp/vnc-live-meta.json", meta).expect("dump meta");

    Collected {
        width,
        height,
        frames,
        distinct_values,
    }
}

fn base_config() -> VncConfig {
    let host = env_opt("VNC_TEST_HOST").expect("VNC_TEST_HOST not set");
    VncConfig {
        host,
        port: std::env::var("VNC_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5900),
        password: env_opt("VNC_TEST_PASS"),
        color_depth: 24,
        jump_host: None,
    }
}

#[tokio::test]
#[ignore]
async fn vnc_direct_live() {
    let config = base_config();
    println!("connecting directly to {}:{}", config.host, config.port);
    let collected = connect_and_collect(&config, 8).await;

    println!(
        "frames: {}, distinct byte values: {}",
        collected.frames, collected.distinct_values
    );
    assert_eq!((collected.width, collected.height), (1280, 800));
    assert!(
        collected.frames >= 2,
        "expected multiple framebuffer updates"
    );
    assert!(
        collected.distinct_values >= 8,
        "screen looks blank ({} distinct values)",
        collected.distinct_values
    );
}

#[tokio::test]
#[ignore]
async fn vnc_jump_host_live() {
    let jump_host = env_opt("VNC_JUMP_HOST").expect("VNC_JUMP_HOST not set");
    let target_host =
        env_opt("VNC_JUMP_TARGET").unwrap_or_else(|| env_opt("VNC_TEST_HOST").unwrap());

    let mut config = base_config();
    // The target address is resolved from inside the jump container: use the
    // docker host alias unless overridden.
    config.host = target_host;
    let jump_port: u16 = std::env::var("VNC_JUMP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(22222);
    // Pin the fixture key explicitly; the product UI performs this probe as
    // part of first-use consent rather than trusting silently.
    let jump_fingerprint = nexterm_lib::ssh::probe_host_key(&jump_host, jump_port)
        .await
        .expect("probe jump-host key");
    config.jump_host = Some(JumpHostConfig {
        host: jump_host,
        port: Some(jump_port),
        username: env_opt("VNC_JUMP_USER"),
        password: env_opt("VNC_JUMP_PASS"),
        use_key: Some(false),
        key_path: None,
        passphrase: None,
        host_key_fingerprint: Some(jump_fingerprint),
    });

    println!(
        "connecting via jump {}:{:?} to {}:{}",
        config.jump_host.as_ref().unwrap().host,
        config.jump_host.as_ref().unwrap().port,
        config.host,
        config.port
    );
    let collected = connect_and_collect(&config, 8).await;

    println!(
        "frames: {}, distinct byte values: {}",
        collected.frames, collected.distinct_values
    );
    assert_eq!((collected.width, collected.height), (1280, 800));
    assert!(
        collected.frames >= 2,
        "expected multiple framebuffer updates"
    );
    assert!(
        collected.distinct_values >= 8,
        "screen looks blank ({} distinct values)",
        collected.distinct_values
    );
}
