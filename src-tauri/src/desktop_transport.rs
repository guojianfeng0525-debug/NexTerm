//! Shared desktop transport: opening a byte stream to an RDP/VNC target,
//! either directly over TCP or through an SSH jump-host tunnel.
//!
//! Both desktop protocol clients erase the stream behind
//! [`BoxedStream`] so direct and jump-tunnelled connections share one code
//! path. A jump channel is owned by its SSH session handle, so when the
//! connection goes through a jump host the session handle is kept alive in
//! [`OpenedStream`] — dropping it would tear the tunnel down.

use std::net::SocketAddr;

use anyhow::{Context as _, Result};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::desktop_protocol::JumpHostConfig;

/// Object-safe combined async stream bound.
pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite + Unpin + Send + Sync {}

/// Type-erased stream usable by both TCP and jump-tunnel connections.
pub type BoxedStream = Box<dyn AsyncReadWrite>;

/// An open stream plus everything that must outlive it.
pub struct OpenedStream {
    pub stream: BoxedStream,
    /// Local address of the connection (jump tunnels have no real socket;
    /// callers use a loopback placeholder when the field is `None`).
    pub local_addr: Option<SocketAddr>,
    /// SSH session handle backing the jump channel. The direct-tcpip channel
    /// stream boxed above stays valid only while this handle lives — it is
    /// never read, only dropped when the transport goes away.
    #[allow(dead_code)]
    jump_session: Option<russh::client::Handle<crate::ssh::Client>>,
}

impl OpenedStream {
    /// The address a protocol handshake should claim as its client address.
    pub fn client_addr(&self) -> SocketAddr {
        self.local_addr
            .unwrap_or_else(|| "127.0.0.1:0".parse().expect("valid loopback addr"))
    }
}

/// Connect to `host:port` directly, or tunnel through the SSH jump host when
/// `jump` is configured. Connection timeouts and keepalives mirror the SSH
/// connection path: 10s connect timeout, 15s keepalive interval (3 max
/// misses) so long idle desktop sessions survive.
pub async fn open_stream(
    host: &str,
    port: u16,
    jump: Option<&JumpHostConfig>,
) -> Result<OpenedStream> {
    if let Some(jump) = jump {
        let connection_timeout = std::time::Duration::from_secs(10);
        let tunnel = crate::jump::connect_via_jump(
            &ssh_jump_config(jump),
            host,
            port,
            connection_timeout,
            Some(std::time::Duration::from_secs(15)),
            3,
            false,
        )
        .await
        .with_context(|| format!("Failed to establish the jump-host tunnel to {host}:{port}"))?;

        // Split the tunnel: the channel stream feeds the protocol, the
        // session handle is retained so the channel stays open.
        let crate::jump::JumpTunnel { stream, session } = tunnel;
        tracing::debug!("Desktop transport: jump tunnel to {host}:{port} established");
        Ok(OpenedStream {
            stream: Box::new(stream),
            local_addr: None,
            jump_session: Some(session),
        })
    } else {
        let stream = TcpStream::connect((host, port))
            .await
            .with_context(|| format!("Failed to connect to {host}:{port}"))?;
        stream
            .set_nodelay(true)
            .context("Failed to set TCP_NODELAY")?;
        let local_addr = stream.local_addr().context("Failed to get local address")?;
        Ok(OpenedStream {
            stream: Box::new(stream),
            local_addr: Some(local_addr),
            jump_session: None,
        })
    }
}

/// Map the frontend jump-host fields onto the SSH module's `JumpConfig`.
pub fn ssh_jump_config(jump: &JumpHostConfig) -> crate::ssh::JumpConfig {
    use crate::ssh::AuthMethod;
    let auth_method = if jump.use_key.unwrap_or(false) {
        AuthMethod::PublicKey {
            key_path: jump.key_path.clone().unwrap_or_default(),
            passphrase: None,
        }
    } else {
        AuthMethod::Password {
            password: jump.password.clone().unwrap_or_default(),
        }
    };
    crate::ssh::JumpConfig {
        host: jump.host.clone(),
        port: jump.port.unwrap_or(22),
        username: jump.username.clone().unwrap_or_else(|| "root".to_owned()),
        auth_method,
        host_key_fingerprint: None,
    }
}
