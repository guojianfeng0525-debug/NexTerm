//! Live RDP integration test against a containerized xRDP server.
//!
//! Skipped unless `RDP_TEST_HOST` is set. The fixture image lives in
//! `e2e/fixtures/xrdp` (Debian + xrdp + openbox + xterm, credentials
//! rdpuser/rdppass):
//!
//! ```sh
//! docker build -t nexterm-xrdp-fixture:local e2e/fixtures/xrdp
//! docker run -d --name nexterm-xrdp -p 3389:3389 nexterm-xrdp-fixture:local
//! RDP_TEST_HOST=127.0.0.1 RDP_TEST_USER=rdpuser RDP_TEST_PASS=rdppass \
//!   cargo test --test rdp_live -- --ignored --nocapture
//! ```
//!
//! On success the composited first screen is dumped to
//! `/tmp/rdp-live-frame.bin` (+ `/tmp/rdp-live-meta.json`) so the frame can
//! be encoded to PNG and visually verified.

use std::time::Duration;

use nexterm_lib::desktop_protocol::{DesktopEvent, DesktopProtocol};
use nexterm_lib::rdp_client::RdpClient;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

/// Compose dirty frames into a full-screen RGBA buffer.
fn blit(buffer: &mut [u8], screen_w: usize, frame: &nexterm_lib::desktop_protocol::FrameUpdate) {
    let fw = frame.width as usize;
    let fh = frame.height as usize;
    for row in 0..fh {
        let dst_y = frame.y as usize + row;
        if dst_y >= screen_w {
            continue;
        }
        let dst_x = frame.x as usize;
        let copy = fw.min(screen_w.saturating_sub(dst_x));
        if copy == 0 {
            continue;
        }
        let src = row * fw * 4;
        let dst = (dst_y * screen_w + dst_x) * 4;
        buffer[dst..dst + copy * 4].copy_from_slice(&frame.rgba_data[src..src + copy * 4]);
    }
}

/// Count distinct byte values across the buffer — a uniform (all-black or
/// all-white) screen means nothing was actually rendered.
fn distinct_byte_values(buffer: &[u8]) -> usize {
    let mut seen = [false; 256];
    for &b in buffer {
        seen[b as usize] = true;
    }
    seen.iter().filter(|s| **s).count()
}

#[tokio::test]
#[ignore = "requires a live xRDP server (see module docs)"]
async fn connects_to_real_xrdp_and_renders_first_screen() {
    let host = std::env::var("RDP_TEST_HOST").unwrap_or_default();
    if host.is_empty() {
        eprintln!("RDP_TEST_HOST not set — skipping live RDP test");
        return;
    }
    let port: u16 = env_or("RDP_TEST_PORT", "3389")
        .parse()
        .expect("valid RDP_TEST_PORT");
    let username = env_or("RDP_TEST_USER", "rdpuser");
    let password = env_or("RDP_TEST_PASS", "rdppass");
    let width: u16 = 1280;
    let height: u16 = 720;

    let config = nexterm_lib::desktop_protocol::RdpConfig {
        host,
        port,
        username,
        password,
        domain: None,
        width,
        height,
        jump_host: None,
    };

    // Full connection sequence: X.224 → TLS → NLA/CredSSP → capabilities.
    let mut client = RdpClient::connect(&config)
        .await
        .expect("RDP connection (NLA auth against the containerized xRDP)");

    let (screen_w, screen_h) = client.desktop_size();
    eprintln!("connected; desktop size {screen_w}x{screen_h}");
    assert!(screen_w >= 640, "unreasonable desktop width {screen_w}");
    assert!(screen_h >= 480, "unreasonable desktop height {screen_h}");

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
    let cancel = CancellationToken::new();
    client
        .start_frame_loop(event_tx, cancel.clone())
        .await
        .expect("start frame loop");

    // Exercise the input path: press/release "A" and move the pointer into
    // the xterm window area. The session must survive these.
    client
        .send_key(0x41, true, None, None)
        .await
        .expect("key press");
    client
        .send_key(0x41, false, None, None)
        .await
        .expect("key release");
    client
        .send_pointer(400, 300, 0)
        .await
        .expect("pointer move");

    // Collect frames for up to 15 s; openbox + xterm should paint quickly.
    let mut screen = vec![0u8; screen_w as usize * screen_h as usize * 4];
    let mut frame_count = 0usize;
    let mut saw_clipboard_cap = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        let Ok(event) = tokio::time::timeout_at(deadline, event_rx.recv()).await else {
            break;
        };
        match event {
            Some(DesktopEvent::Frame(frame)) => {
                blit(&mut screen, screen_w as usize, &frame);
                frame_count += 1;
                // The first full-screen paint usually arrives as one frame;
                // keep draining until the deadline for the xterm to appear.
            }
            Some(DesktopEvent::ClipboardText(_)) => {
                saw_clipboard_cap = true;
            }
            Some(DesktopEvent::Resized { width, height }) => {
                eprintln!("server resized to {width}x{height}");
            }
            Some(DesktopEvent::Terminated(reason)) => {
                panic!("session terminated early: {reason}");
            }
            None => break,
        }
    }

    eprintln!("received {frame_count} frame(s)");
    assert!(frame_count > 0, "no graphics frames arrived within 15 s");

    let distinct = distinct_byte_values(&screen);
    eprintln!("distinct byte values in composited screen: {distinct}");
    assert!(
        distinct >= 8,
        "screen looks uniform ({distinct} distinct bytes) — nothing was rendered"
    );

    // Dump the composited screen for PNG encoding + visual verification.
    std::fs::write("/tmp/rdp-live-frame.bin", &screen).expect("write frame dump");
    std::fs::write(
        "/tmp/rdp-live-meta.json",
        format!(
            r#"{{"width": {screen_w}, "height": {screen_h}, "frames": {frame_count}, "clipboard_cap": {saw_clipboard_cap}}}"#
        ),
    )
    .expect("write meta");

    // Clipboard advertise → remote paste request round-trip must not break
    // the session (verified implicitly: disconnect afterwards succeeds).
    client
        .set_clipboard("NexTerm RDP live test ✓".to_owned())
        .await
        .expect("set clipboard");
    tokio::time::sleep(Duration::from_millis(300)).await;

    client.disconnect().await.expect("graceful disconnect");
    eprintln!("live RDP test PASSED ({screen_w}x{screen_h}, {frame_count} frames)");
}

/// RDP over an SSH jump-host tunnel: same assertions as the direct test,
/// but the X.224/TLS/NLA traffic runs inside a direct-tcpip channel of the
/// jump SSH session (OpenSSH `ProxyJump` equivalent).
///
/// Requires the jump fixture (`e2e/fixtures/ssh-jump`, jumpuser/jumppass)
/// and the xRDP fixture reachable from inside the jump container — on Docker
/// Desktop `host.docker.internal` resolves to the host that publishes :3389:
///
/// ```sh
/// RDP_TEST_HOST=host.docker.internal RDP_TEST_USER=rdpuser RDP_TEST_PASS=rdppass \
/// RDP_JUMP_HOST=127.0.0.1 RDP_JUMP_PORT=22022 RDP_JUMP_USER=jumpuser RDP_JUMP_PASS=jumppass \
///   cargo test --test rdp_live jump -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "requires a live xRDP server behind a jump host (see module docs)"]
async fn connects_to_xrdp_through_jump_host() {
    let host = std::env::var("RDP_TEST_HOST").unwrap_or_default();
    if host.is_empty() {
        eprintln!("RDP_TEST_HOST not set — skipping live RDP jump test");
        return;
    }
    let jump_host = std::env::var("RDP_JUMP_HOST").unwrap_or_default();
    if jump_host.is_empty() {
        eprintln!("RDP_JUMP_HOST not set — skipping live RDP jump test");
        return;
    }
    let port: u16 = env_or("RDP_TEST_PORT", "3389")
        .parse()
        .expect("valid RDP_TEST_PORT");

    let jump_port: u16 = std::env::var("RDP_JUMP_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(22022);
    // Live integration tests pin the current fixture key before authentication;
    // product code obtains this consent through the connection dialog.
    let jump_fingerprint = nexterm_lib::ssh::probe_host_key(&jump_host, jump_port)
        .await
        .expect("probe jump-host key");

    let config = nexterm_lib::desktop_protocol::RdpConfig {
        host,
        port,
        username: env_or("RDP_TEST_USER", "rdpuser"),
        password: env_or("RDP_TEST_PASS", "rdppass"),
        domain: None,
        width: 1280,
        height: 720,
        jump_host: Some(nexterm_lib::desktop_protocol::JumpHostConfig {
            host: jump_host,
            port: Some(jump_port),
            username: Some(env_or("RDP_JUMP_USER", "jumpuser")),
            password: Some(env_or("RDP_JUMP_PASS", "jumppass")),
            use_key: Some(false),
            key_path: None,
            passphrase: None,
            host_key_fingerprint: Some(jump_fingerprint),
        }),
    };

    eprintln!(
        "connecting via jump to {}:{} (NLA)",
        config.host, config.port
    );
    let mut client = RdpClient::connect(&config)
        .await
        .expect("RDP connection through the jump-host tunnel");

    let (screen_w, screen_h) = client.desktop_size();
    eprintln!("connected; desktop size {screen_w}x{screen_h}");
    assert!(
        screen_w >= 640 && screen_h >= 480,
        "unreasonable desktop size"
    );

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DesktopEvent>();
    let cancel = CancellationToken::new();
    client
        .start_frame_loop(event_tx, cancel.clone())
        .await
        .expect("start frame loop");

    let mut screen = vec![0u8; screen_w as usize * screen_h as usize * 4];
    let mut frame_count = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        let Ok(event) = tokio::time::timeout_at(deadline, event_rx.recv()).await else {
            break;
        };
        match event {
            Some(DesktopEvent::Frame(frame)) => {
                blit(&mut screen, screen_w as usize, &frame);
                frame_count += 1;
            }
            Some(DesktopEvent::Terminated(reason)) => panic!("session terminated early: {reason}"),
            Some(_) => {}
            None => break,
        }
    }
    cancel.cancel();

    eprintln!("received {frame_count} frame(s) through the tunnel");
    assert!(frame_count > 0, "no graphics frames arrived within 15 s");
    let distinct = distinct_byte_values(&screen);
    eprintln!("distinct byte values in composited screen: {distinct}");
    assert!(
        distinct >= 8,
        "screen looks uniform ({distinct} distinct bytes)"
    );

    // Dump the composited tunnel screen for PNG encoding + visual verification.
    std::fs::write("/tmp/rdp-jump-frame.bin", &screen).expect("write frame dump");
    std::fs::write(
        "/tmp/rdp-jump-meta.json",
        format!(r#"{{"width": {screen_w}, "height": {screen_h}, "frames": {frame_count}}}"#),
    )
    .expect("write meta");

    client.disconnect().await.expect("graceful disconnect");
    eprintln!("live RDP jump test PASSED ({screen_w}x{screen_h}, {frame_count} frames)");
}
