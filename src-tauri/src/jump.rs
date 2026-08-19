//! SSH jump host (bastion) tunnelling shared by the SSH connection path and
//! the remote-tunnel feature.
//!
//! A jump host is a regular SSH server that we first authenticate to; a
//! direct-tcpip channel is then opened on it towards the real target, and the
//! payload runs inside that channel. This is the SSH equivalent of OpenSSH's
//! `ProxyJump`.

use crate::ssh::{load_private_key, AuthMethod, Client, JumpConfig, PREFERRED_HOST_KEY_ALGOS};
use anyhow::Result;
use russh::*;
use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

/// An established tunnel through a jump host.
///
/// The `session` handle must stay alive for as long as `stream` is used —
/// the direct-tcpip channel is owned by that session, and dropping the handle
/// would tear the tunnel down.
pub struct JumpTunnel {
    pub stream: ChannelStream<client::Msg>,
    pub session: client::Handle<Client>,
}

/// Establish a stream to `target_host:target_port` tunnelled through an SSH
/// jump host. Mirrors the connection flow of `SshClient::connect` so both
/// features behave identically (same timeouts, same auth handling, same
/// error wording).
///
/// `keepalive` keeps the jump session alive during long idle tunnels (russh
/// sends keepalives on the interval and closes after `keepalive_max` missed
/// replies); `nodelay` disables Nagle for lower latency, matching the main
/// SSH session.
pub async fn connect_via_jump(
    jump: &JumpConfig,
    target_host: &str,
    target_port: u16,
    connection_timeout: Duration,
    keepalive: Option<Duration>,
    keepalive_max: usize,
) -> Result<JumpTunnel> {
    let ssh_config = client::Config {
        preferred: russh::Preferred {
            key: Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
            ..russh::Preferred::DEFAULT
        },
        keepalive_interval: keepalive,
        keepalive_max,
        nodelay: true,
        ..client::Config::default()
    };

    // 1) Connect to the jump host.
    let mut jump_session = tokio::time::timeout(
        connection_timeout,
        client::connect(
            Arc::new(ssh_config),
            (&jump.host[..], jump.port),
            Client,
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Jump host connection timed out after 3 seconds. Please check the jump host address and network connectivity."))?
    .map_err(|e| anyhow::anyhow!("Failed to connect to jump host {}:{}: {}", jump.host, jump.port, e))?;

    // 2) Authenticate on the jump host.
    let authenticated = match &jump.auth_method {
        AuthMethod::Password { password } => jump_session
            .authenticate_password(&jump.username, password)
            .await
            .map_err(|e| anyhow::anyhow!("Jump host password authentication failed: {}", e))?
            .success(),
        AuthMethod::PublicKey {
            key_path,
            passphrase,
        } => {
            let key = load_private_key(key_path, passphrase.as_deref())?;
            jump_session
                .authenticate_publickey(
                    &jump.username,
                    russh::keys::PrivateKeyWithHashAlg::new(
                        Arc::new(key),
                        Some(russh::keys::HashAlg::Sha256),
                    ),
                )
                .await
                .map_err(|e| anyhow::anyhow!("Jump host public key authentication failed: {}", e))?
                .success()
        }
    };
    if !authenticated {
        return Err(anyhow::anyhow!(
            "Jump host authentication failed. Please check the jump host credentials."
        ));
    }

    // 3) Open a direct-tcpip channel to the target and expose it as a stream.
    let channel = tokio::time::timeout(
        connection_timeout,
        jump_session.channel_open_direct_tcpip(
            target_host,
            target_port as u32,
            "127.0.0.1",
            0,
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Timed out opening the jump channel to {}:{}", target_host, target_port))?
    .map_err(|e| anyhow::anyhow!("Failed to open the jump channel to {}:{}: {}", target_host, target_port, e))?;

    Ok(JumpTunnel {
        stream: channel.into_stream(),
        session: jump_session,
    })
}
