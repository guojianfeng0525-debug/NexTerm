//! Proactive protocol and TCP defaults, independent of WebView visibility.
use socket2::{SockRef, TcpKeepalive};
use std::{io, time::Duration};
use tokio::net::TcpStream;

pub(crate) const MIN_INTERVAL: u64 = 5;
pub(crate) const DEFAULT_INTERVAL: u64 = 15;
pub(crate) const DEFAULT_MAX: u32 = 20;

pub(crate) fn interval_seconds(seconds: u64) -> u64 {
    if seconds == 0 {
        DEFAULT_INTERVAL
    } else {
        seconds.max(MIN_INTERVAL)
    }
}

pub(crate) fn configure_tcp(stream: &TcpStream) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(DEFAULT_INTERVAL))
        .with_interval(Duration::from_secs(DEFAULT_INTERVAL));
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    let keepalive = keepalive.with_retries(DEFAULT_MAX);
    SockRef::from(stream).set_tcp_keepalive(&keepalive)
}

pub(crate) async fn connect_tcp(host: &str, port: u16) -> io::Result<TcpStream> {
    let stream = TcpStream::connect((host, port)).await?;
    configure_tcp(&stream)?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tcp_transport_enables_kernel_keepalive() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = connect_tcp("127.0.0.1", listener.local_addr().unwrap().port())
            .await
            .unwrap();
        assert!(SockRef::from(&stream).keepalive().unwrap());
        assert!(stream.nodelay().unwrap());
    }

    #[tokio::test]
    async fn protocol_heartbeat_keeps_idle_ssh_alive_without_terminal_input() {
        use crate::ssh::{test_server, SshClient};
        use std::sync::atomic::Ordering;
        // The server closes idle transports after 7 s. The configured 5 s
        // protocol heartbeat must keep the original connection alive past it.
        let server = test_server::spawn(Duration::from_secs(7)).await;
        let control = test_server::spawn(Duration::from_secs(7)).await;
        let mut unprotected = SshClient::new();
        let mut control_config = control.config.clone();
        control_config.keepalive_interval = None;
        unprotected.connect(&control_config).await.unwrap();
        let mut client = SshClient::new();
        client.connect(&server.config).await.unwrap();
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert!(client.is_connected());
        assert!(
            !unprotected.is_connected(),
            "The idle control must actually expire"
        );
        client.create_pty_session(80, 24, None).await.unwrap();
        assert_eq!(server.input_bytes.load(Ordering::SeqCst), 0);
        client.disconnect().await.unwrap();
        assert!(!client.is_connected());
    }
}
