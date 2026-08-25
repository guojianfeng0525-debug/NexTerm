use crate::proxy::ProxyConfig;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use russh::keys::{self, decode_secret_key, PublicKeyBase64};
use sha2_10::{Digest, Sha256};
use russh::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Preferred host-key algorithms advertised to the server, ordered from most to
/// least preferred.  RSA variants (including the legacy `ssh-rsa` / SHA-1) are
/// included so that older servers that only offer RSA host keys are still
/// reachable.  The `rsa` feature on `russh` (enabled by default) must be on
/// for the RSA entries to have any effect.
pub static PREFERRED_HOST_KEY_ALGOS: &[keys::Algorithm] = &[
    keys::Algorithm::Ed25519,
    keys::Algorithm::Ecdsa {
        curve: keys::EcdsaCurve::NistP256,
    },
    keys::Algorithm::Ecdsa {
        curve: keys::EcdsaCurve::NistP521,
    },
    keys::Algorithm::Rsa {
        hash: Some(keys::HashAlg::Sha256),
    },
    keys::Algorithm::Rsa {
        hash: Some(keys::HashAlg::Sha512),
    },
    keys::Algorithm::Rsa { hash: None },
];

const BASH_VERSION_PROBE: &str = r#"printf '__NEXTERM_BASH_VERSION__%s' "${BASH_VERSION-}""#;
const BASH_VERSION_MARKER: &str = "__NEXTERM_BASH_VERSION__";
const BASH_SHELL_INTEGRATION_PREFIX: &str = r#" stty echo; __nexterm_report_cwd(){ local p=${PWD//%/%25}; p=${p// /%20}; p=${p//#/%23}; p=${p//\?/%3F}; printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$p"; }; "#;
const BASH_SHELL_INTEGRATION_SUFFIX: &str = "printf '\\r\\033[2K'\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BashVersion {
    pub(crate) major: u32,
    pub(crate) minor: u32,
}

pub(crate) fn bash_version_from_probe(output: &str) -> Option<BashVersion> {
    let version = output.rsplit_once(BASH_VERSION_MARKER)?.1.trim();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some(BashVersion { major, minor })
}

pub(crate) fn bash_shell_integration_command(version: BashVersion) -> Vec<u8> {
    let prompt_command = if version >= (BashVersion { major: 5, minor: 1 }) {
        r#"if declare -p PROMPT_COMMAND &>/dev/null; then PROMPT_COMMAND=("${PROMPT_COMMAND[@]}" __nexterm_report_cwd); else PROMPT_COMMAND=(__nexterm_report_cwd); fi; "#
    } else {
        r#"if [[ -n ${PROMPT_COMMAND-} ]]; then PROMPT_COMMAND+=$'\n__nexterm_report_cwd'; else PROMPT_COMMAND=__nexterm_report_cwd; fi; "#
    };

    format!(
        "{}{}{}",
        BASH_SHELL_INTEGRATION_PREFIX, prompt_command, BASH_SHELL_INTEGRATION_SUFFIX
    )
    .into_bytes()
}

/// Compression algorithms to advertise, ordered so zlib is preferred over none.
///
/// Order matters: russh negotiates the first algorithm that the server also
/// lists, so zlib must come before none for compression to actually take
/// effect. `zlib@openssh.com` covers servers using OpenSSH's "delayed"
/// compression. Requires russh's `flate2` feature, which is enabled by default.
pub fn compression_preferences(enabled: bool) -> &'static [russh::compression::Name] {
    if enabled {
        &[
            russh::compression::ZLIB,
            russh::compression::ZLIB_LEGACY,
            russh::compression::NONE,
        ]
    } else {
        &[russh::compression::NONE]
    }
}

/// Canonical OpenSSH-compatible SHA-256 host-key fingerprint.
pub fn host_key_fingerprint(key: &keys::PublicKey) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key.public_key_bytes())))
}

struct HostKeyProbeClient(Arc<std::sync::Mutex<Option<String>>>);

impl client::Handler for HostKeyProbeClient {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKey) -> Result<bool, Self::Error> {
        if let Ok(mut observed) = self.0.lock() {
            *observed = Some(host_key_fingerprint(key));
        }
        Ok(true)
    }
}

/// Obtain a server's public host-key fingerprint without authenticating.
pub async fn probe_host_key(host: &str, port: u16) -> Result<String> {
    let observed = Arc::new(std::sync::Mutex::new(None));
    let config = Arc::new(client::Config {
        preferred: russh::Preferred {
            key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
            ..russh::Preferred::DEFAULT
        },
        nodelay: true,
        ..client::Config::default()
    });
    let session = tokio::time::timeout(
        Duration::from_secs(10),
        client::connect(config, (host, port), HostKeyProbeClient(Arc::clone(&observed))),
    )
    .await
    .map_err(|_| anyhow::anyhow!("SSH host-key probe timed out"))??;
    let _ = session.disconnect(Disconnect::ByApplication, "", "English").await;
    let fingerprint = observed
        .lock()
        .map_err(|_| anyhow::anyhow!("SSH host-key probe failed"))?
        .clone()
        .ok_or_else(|| anyhow::anyhow!("SSH server did not provide a host key"));
    fingerprint
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Enable zlib compression negotiation (default: true, matching the UI).
    pub compression: bool,
    /// Keepalive interval in seconds. `None` disables keepalive.
    pub keepalive_interval: Option<u64>,
    /// Max missed keepalive replies before the connection is closed.
    pub keepalive_max: Option<u32>,
    /// Optional HTTP/SOCKS proxy tunnel. `None` connects directly.
    pub proxy: Option<ProxyConfig>,
    /// Optional SSH jump host (bastion / ProxyJump). When set, the SSH
    /// handshake to `host` runs over a direct-tcpip channel opened on the
    /// jump host. `None` connects directly (or via `proxy` when set).
    pub jump: Option<JumpConfig>,
    pub host_key_fingerprint: Option<String>,
    pub host_key_verification: bool,
}

/// SSH jump host (bastion) configuration. The connection to the target host
/// is tunnelled through this host's SSH session via `channel_open_direct_tcpip`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// How the jump host authenticates the user.
    pub auth_method: AuthMethod,
    pub host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct SshSession {
    pub id: String,
    pub config: SshConfig,
    pub connected: bool,
}

pub struct SshClient {
    session: Option<Arc<client::Handle<Client>>>,
    /// Keeps the jump-host session alive for the lifetime of the connection.
    /// The direct-tcpip channel used for the target handshake is owned by this
    /// session, so dropping it would tear down the tunnel.
    jump_handle: Option<client::Handle<Client>>,
}

// PTY session handle for interactive shell
pub struct PtySession {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub output_rx: Arc<tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>>,
    pub channel_id: ChannelId,
    /// Sender for resize requests (cols, rows) — forwarded to the SSH channel
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    /// Cancellation token — cancelled when this session is torn down.
    /// The WebSocket reader task should select on this to stop promptly.
    pub cancel: CancellationToken,
}

pub struct Client {
    expected_fingerprint: Option<String>,
    verification_enabled: bool,
}

impl Client {
    pub fn new(expected_fingerprint: Option<String>, verification_enabled: bool) -> Self {
        Self { expected_fingerprint, verification_enabled }
    }
}

// russh 0.62's `Handler` trait uses native `impl Future` methods (RPITIT), so
// `#[async_trait]` must NOT be applied here — it would produce a signature
// that no longer matches the trait.
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        if !self.verification_enabled {
            return Ok(true);
        }
        let fingerprint = host_key_fingerprint(server_public_key);
        // Existing unpinned connections remain usable while the frontend
        // performs its first-use confirmation. Once a fingerprint is stored,
        // a changed server key is always rejected before authentication.
        Ok(self.expected_fingerprint.as_ref().is_none_or(|expected| expected == &fingerprint))
    }

    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        // Normal teardown is routine — the offline resource probe opens and
        // closes sessions constantly. russh maps ANY clean end-of-connection
        // (including our own disconnect()) to Error::Disconnect, so that is
        // debug-level; only genuine transport failures deserve a warning.
        match &reason {
            russh::client::DisconnectReason::ReceivedDisconnect(info) => {
                tracing::debug!("[ssh] SSH session closed: {:?}", info);
            }
            russh::client::DisconnectReason::Error(e) => {
                if matches!(e, russh::Error::Disconnect) {
                    tracing::debug!("[ssh] SSH session ended (Disconnect)");
                } else {
                    tracing::warn!("[ssh] SSH session disconnected with error: {e}");
                }
            }
        }
        Ok(())
    }
}

impl SshClient {
    pub fn new() -> Self {
        Self {
            session: None,
            jump_handle: None,
        }
    }

    pub async fn connect(&mut self, config: &SshConfig) -> Result<()> {
        let keepalive_interval = config.keepalive_interval.map(Duration::from_secs);

        // russh 0.62 bug: when a *jump-host* session negotiates zlib
        // compression, the direct-tcpip channel used to tunnel the target SSH
        // handshake breaks — the target session dies with "early eof" /
        // "channel closed" right after connect_stream returns. The tunnel is
        // already encrypted, so per-hop compression is redundant; disable it
        // for the whole connection when a jump host is in use (both the jump
        // hop and the target leg). Direct connections keep zlib compression.
        let use_compression = config.compression && config.jump.is_none();

        let ssh_config = client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(PREFERRED_HOST_KEY_ALGOS),
                compression: std::borrow::Cow::Borrowed(compression_preferences(use_compression)),
                ..russh::Preferred::DEFAULT
            },
            // Send a keepalive on the user-configured interval. After the
            // configured number of missed replies russh closes the connection,
            // preventing the server from silently dropping idle sessions.
            keepalive_interval,
            keepalive_max: config.keepalive_max.unwrap_or(3) as usize,
            // russh 0.62: disable Nagle's algorithm for lower-latency
            // interactive traffic (applies to the target session AND the
            // jump-hop session, which shares this config).
            nodelay: true,
            ..client::Config::default()
        };
        // russh `Config` is not `Clone`; share one instance across every hop.
        let ssh_config = Arc::new(ssh_config);

        // The target leg of a jump connection must not re-enable compression
        // independently — reuse the same (compression-disabled) config.
        let jump_target_config = Arc::clone(&ssh_config);

        // Connection timeout: 3 seconds
        let connection_timeout = Duration::from_secs(3);

        let mut ssh_session = if let Some(jump) = &config.jump {
            // --- SSH jump host (bastion) ---
            // 1) Connect to the jump host.
            tracing::info!("[ssh] connecting via jump host {}:{}", jump.host, jump.port);
            let mut jump_session = tokio::time::timeout(
                connection_timeout,
                client::connect(
                    Arc::clone(&ssh_config),
                    (&jump.host[..], jump.port),
                    Client::new(jump.host_key_fingerprint.clone(), config.host_key_verification),
                ),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Jump host connection timed out after 3 seconds. Please check the jump host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to jump host {}:{}: {}", jump.host, jump.port, e))?;

            // 2) Authenticate on the jump host.
            let jump_authenticated = match &jump.auth_method {
                AuthMethod::Password { password } => jump_session
                    .authenticate_password(&jump.username, password)
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!("Jump host password authentication failed: {}", e)
                    })?
                    .success(),
                AuthMethod::PublicKey {
                    key_path,
                    passphrase,
                } => {
                    let key = load_private_key(key_path, passphrase.as_deref())?;
                    jump_session
                        .authenticate_publickey(
                            &jump.username,
                            keys::PrivateKeyWithHashAlg::new(
                                Arc::new(key),
                                Some(keys::HashAlg::Sha256),
                            ),
                        )
                        .await
                        .map_err(|e| {
                            anyhow::anyhow!("Jump host public key authentication failed: {}", e)
                        })?
                        .success()
                }
            };
            if !jump_authenticated {
                return Err(anyhow::anyhow!(
                    "Jump host authentication failed. Please check the jump host credentials."
                ));
            }

            // 3) Open a direct-tcpip channel to the target host through the
            //    jump host, then run the target SSH handshake over it.
            tracing::info!(
                "[ssh] opening direct-tcpip channel to target {}:{} via jump",
                config.host,
                config.port
            );
            let channel = tokio::time::timeout(
                connection_timeout,
                jump_session.channel_open_direct_tcpip(
                    &config.host,
                    config.port as u32,
                    "127.0.0.1",
                    0,
                ),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "Timed out opening the jump channel to {}:{}",
                    config.host,
                    config.port
                )
            })?
            .map_err(|e| {
                anyhow::anyhow!(
                    "Failed to open the jump channel to {}:{}: {}",
                    config.host,
                    config.port,
                    e
                )
            })?;

            let session = tokio::time::timeout(
                connection_timeout,
                client::connect_stream(
                    Arc::clone(&jump_target_config),
                    channel.into_stream(),
                    Client::new(config.host_key_fingerprint.clone(), config.host_key_verification),
                ),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?;

            // 4) Keep the jump session alive for the whole connection — the
            //    direct-tcpip channel is owned by it, so dropping it would
            //    tear down the tunnel.
            self.jump_handle = Some(jump_session);
            session
        } else if let Some(proxy) = &config.proxy {
            // Tunnel through the proxy first, then hand the established stream
            // to russh so the SSH handshake runs over the tunnel.
            let stream = crate::proxy::connect_via_proxy(
                proxy,
                &config.host,
                config.port,
                connection_timeout,
            )
            .await
            .map_err(|e| anyhow::anyhow!("Proxy connection failed: {e}"))?;
            tokio::time::timeout(
                connection_timeout,
                client::connect_stream(Arc::clone(&ssh_config), stream, Client::new(config.host_key_fingerprint.clone(), config.host_key_verification)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?
        } else {
            tokio::time::timeout(
                connection_timeout,
                client::connect(
                    Arc::clone(&ssh_config),
                    (&config.host[..], config.port),
                    Client::new(config.host_key_fingerprint.clone(), config.host_key_verification),
                ),
            )
            .await
            .map_err(|_| anyhow::anyhow!("Connection timed out after 3 seconds. Please check the host address and network connectivity."))?
            .map_err(|e| anyhow::anyhow!("Failed to connect to {}:{}: {}", config.host, config.port, e))?
        };

        let authenticated = match &config.auth_method {
            AuthMethod::Password { password } => ssh_session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("Password authentication failed: {}", e))?
                .success(),
            AuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                let key = load_private_key(key_path, passphrase.as_deref())?;

                ssh_session
                    .authenticate_publickey(
                        &config.username,
                        keys::PrivateKeyWithHashAlg::new(
                            Arc::new(key),
                            Some(keys::HashAlg::Sha256),
                        ),
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("Public key authentication failed: {}. The key may not be authorized on the server.", e))?
                    .success()
            }
        };

        if !authenticated {
            return Err(anyhow::anyhow!(
                "Authentication failed. Please check your credentials and try again."
            ));
        }

        self.session = Some(Arc::new(ssh_session));
        Ok(())
    }

    // Changed to &self instead of &mut self to allow concurrent access
    pub async fn execute_command(&self, command: &str) -> Result<String> {
        if let Some(session) = &self.session {
            let mut channel = session.channel_open_session().await?;
            channel.exec(true, command).await?;

            let mut output = String::new();
            let mut code = None;
            let mut eof_received = false;
            let mut server_closed = false;

            // Bound the exec so a remote that never sends EOF/Close (vim,
            // sleep, tail -f) cannot hang the command (and the read lock the
            // callers hold) forever.
            let exec_result = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    match channel.wait().await {
                        Some(ChannelMsg::Data { ref data }) => {
                            output.push_str(&String::from_utf8_lossy(data));
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            output.push_str(&String::from_utf8_lossy(data));
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            code = Some(exit_status);
                            if eof_received {
                                break;
                            }
                        }
                        Some(ChannelMsg::Eof) => {
                            eof_received = true;
                            if code.is_some() {
                                break;
                            }
                        }
                        Some(ChannelMsg::Close) | None => {
                            server_closed = true;
                            break;
                        }
                        _ => {}
                    }
                }
            })
            .await;

            if exec_result.is_err() {
                let _ = channel.close().await;
                return Err(anyhow::anyhow!(
                    "Command timed out after 30 seconds: {}",
                    command
                ));
            }

            // Send SSH_MSG_CHANNEL_CLOSE if the server hasn't already closed the channel.
            // Without this, russh's session keeps the channel in its internal map until
            // the session is torn down, causing per-poll memory growth.
            if !server_closed {
                let _ = channel.close().await;
            }

            // Success only with an explicit exit code 0; a channel that closed
            // without an exit status is a failure even if it emitted output
            // (server killed / OOM / dropped channel).
            match code {
                Some(0) => Ok(output),
                Some(c) => Err(anyhow::anyhow!("Command failed with code: {}", c)),
                None => Err(anyhow::anyhow!(
                    "Command finished without an exit status (may have been killed)"
                )),
            }
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            // Try to unwrap Arc, if we're the only owner
            match Arc::try_unwrap(session) {
                Ok(session) => {
                    session
                        .disconnect(Disconnect::ByApplication, "", "English")
                        .await?;
                }
                Err(arc_session) => {
                    // Other references exist, just drop our reference
                    drop(arc_session);
                }
            }
        }
        // Close the jump-host session so the tunnel is torn down too.
        if let Some(jump) = self.jump_handle.take() {
            let _ = jump
                .disconnect(Disconnect::ByApplication, "", "English")
                .await;
        }
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    /// Create a persistent PTY shell session (like ttyd)
    /// This enables interactive commands like vim, less, more, top, etc.
    pub async fn create_pty_session(
        &self,
        cols: u32,
        rows: u32,
        default_directory: Option<&str>,
    ) -> Result<PtySession> {
        if let Some(session) = &self.session {
            let bash_version = tokio::time::timeout(
                Duration::from_secs(2),
                self.execute_command(BASH_VERSION_PROBE),
            )
            .await
            .inspect_err(|_| tracing::debug!("[ssh] bash version probe timed out"))
            .ok()
            .and_then(|r| {
                if let Err(e) = &r {
                    tracing::debug!("[ssh] bash version probe failed: {e}");
                }
                r.ok()
            })
            .and_then(|output| bash_version_from_probe(&output));

            // Open a new SSH channel
            let mut channel = session.channel_open_session().await.map_err(|e| {
                anyhow::anyhow!("Failed to open PTY channel (session may have dropped): {e}")
            })?;
            // Request PTY with terminal type and dimensions
            // Similar to ttyd's approach: xterm-256color terminal
            channel
                .request_pty(
                    true,             // want_reply
                    "xterm-256color", // terminal type (like ttyd)
                    cols,             // columns
                    rows,             // rows
                    0,                // pixel_width (not used)
                    0,                // pixel_height (not used)
                    &[],
                )
                .await
                .map_err(|e| anyhow::anyhow!("Failed to request PTY on the session: {e}"))?;

            // Servers that accept these standard SSH environment requests use
            // UTF-8 for their interactive session. Servers that reject
            // AcceptEnv keep their configured locale, preserving compatibility.
            let _ = channel.set_env(false, "LANG", "C.UTF-8").await;
            let _ = channel.set_env(false, "LC_CTYPE", "C.UTF-8").await;

            // A `cd` written after request_shell goes through readline and is
            // therefore saved in the remote shell's Up-arrow history. For
            // Bash sessions start the login shell through an exec request
            // after changing directory instead: the setup command never
            // reaches readline, while ~/.bash_profile semantics are retained.
            let default_directory = default_directory.map(str::trim).filter(|dir| !dir.is_empty());
            if let (Some(dir), Some(_)) = (default_directory, bash_version) {
                let escaped = dir.replace('\'', "'\\''");
                channel
                    .exec(true, format!("cd -- '{}' && exec \"${{SHELL:-/bin/bash}}\" -l", escaped))
                    .await
                    .map_err(|e| anyhow::anyhow!("Failed to start shell in default directory: {e}"))?;
            } else {
                channel
                    .request_shell(true)
                    .await
                    .map_err(|e| anyhow::anyhow!("Failed to start shell on the session: {e}"))?;
            }

            // Create channels for bidirectional communication (like ttyd's pty_buf)
            // Increased capacity for better buffering during fast input
            let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1000); // Increased from 100
            let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(128); // Bounded: back-pressure to SSH window

            let channel_id = channel.id();

            // Clone channel for input task.
            // Do not inject shell integration or a fallback `cd` through this
            // writer: both are interactive input and can pollute remote shell
            // history. The safe exec startup above is the only automatic
            // default-directory mechanism.
            let mut input_channel = channel.make_writer();

            // Create a channel for resize requests
            let (resize_tx, mut resize_rx) = mpsc::channel::<(u32, u32)>(16);

            // Spawn task to handle input (frontend → SSH)
            // This is similar to ttyd's pty_write and INPUT command handling
            // Key: immediate write + flush for responsiveness
            tokio::spawn(async move {
                let mut writer = input_channel;
                while let Some(data) = input_rx.recv().await {
                    // Write data immediately
                    if let Err(e) = writer.write_all(&data).await {
                        eprintln!("[PTY] Failed to send data to SSH: {}", e);
                        break;
                    }
                    // Critical: flush immediately after write (like ttyd)
                    // This ensures data is sent to PTY without buffering delay
                    if let Err(e) = writer.flush().await {
                        eprintln!("[PTY] Failed to flush data to SSH: {}", e);
                        break;
                    }
                }
            });

            // Spawn task to handle output (SSH → frontend) AND resize requests.
            // The channel must stay in this task because `wait()` requires `&mut self`,
            // but we also need `window_change()` which only requires `&self`.
            // We use `tokio::select!` to multiplex between output reading and resize.
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = channel.wait() => {
                            match msg {
                                Some(ChannelMsg::Data { data }) => {
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::ExtendedData { data, .. }) => {
                                    // stderr data (also send to output)
                                    if output_tx.send(data.to_vec()).await.is_err() {
                                        break;
                                    }
                                }
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                    eprintln!("[PTY] Channel closed");
                                    break;
                                }
                                Some(ChannelMsg::ExitStatus { exit_status }) => {
                                    eprintln!("[PTY] Process exited with status: {}", exit_status);
                                }
                                _ => {}
                            }
                        }
                        resize = resize_rx.recv() => {
                            match resize {
                                Some((cols, rows)) => {
                                    if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                        eprintln!("[PTY] Failed to send window change: {}", e);
                                    } else {
                                        eprintln!("[PTY] Window changed to {}x{}", cols, rows);
                                    }
                                }
                                None => {
                                    // resize channel closed, session is being torn down
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            Ok(PtySession {
                input_tx,
                output_rx: Arc::new(tokio::sync::Mutex::new(output_rx)),
                channel_id,
                resize_tx,
                cancel: CancellationToken::new(),
            })
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub(crate) async fn open_sftp_session(&self) -> Result<SftpSession> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Not connected"))?;
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
    }

    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        self.download_file_with_progress(remote_path, local_path, |_, _| {}).await
    }

    pub async fn download_file_with_progress(
        &self,
        remote_path: &str,
        local_path: &str,
        mut on_progress: impl FnMut(u64, u64) + Send,
    ) -> Result<u64> {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;

            let total_bytes = remote_file.metadata().await
                .map(|metadata| metadata.size.unwrap_or(0))
                .unwrap_or(0);
            let mut local_file = tokio::fs::File::create(local_path).await?;
            let mut temp_buf = vec![0u8; 32768];
            let mut transferred = 0u64;

            loop {
                let n = remote_file.read(&mut temp_buf).await?;
                if n == 0 {
                    break;
                }
                local_file.write_all(&temp_buf[..n]).await?;
                transferred += n as u64;
                on_progress(total_bytes, transferred);
            }
            local_file.flush().await?;
            Ok(transferred)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn download_file_to_memory(&self, remote_path: &str) -> Result<Vec<u8>> {
        if let Some(session) = &self.session {
            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Open remote file for reading
            let mut remote_file = sftp.open(remote_path).await?;

            // Read file content
            let mut buffer = Vec::new();
            let mut temp_buf = vec![0u8; 8192];

            loop {
                let n = remote_file.read(&mut temp_buf).await?;
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp_buf[..n]);
            }

            Ok(buffer)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        self.upload_file_with_progress(local_path, remote_path, |_, _| {}).await
    }

    pub async fn upload_file_with_progress(
        &self,
        local_path: &str,
        remote_path: &str,
        mut on_progress: impl FnMut(u64, u64) + Send,
    ) -> Result<u64> {
        if let Some(session) = &self.session {
            let mut local_file = tokio::fs::File::open(local_path).await?;
            let total_bytes = local_file.metadata().await?.len();

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            let mut buffer = vec![0u8; 32768];
            let mut transferred = 0u64;
            loop {
                let read = local_file.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                remote_file.write_all(&buffer[..read]).await?;
                transferred += read as u64;
                on_progress(total_bytes, transferred);
            }

            remote_file.flush().await?;

            Ok(transferred)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn upload_file_from_bytes(&self, data: &[u8], remote_path: &str) -> Result<u64> {
        if let Some(session) = &self.session {
            let total_bytes = data.len() as u64;

            // Open SFTP subsystem
            let channel = session.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            let sftp = SftpSession::new(channel.into_stream()).await?;

            // Create remote file for writing
            let mut remote_file = sftp.create(remote_path).await?;

            // Write data in chunks
            let mut offset = 0;
            let chunk_size = 8192;

            while offset < data.len() {
                let end = std::cmp::min(offset + chunk_size, data.len());
                remote_file.write_all(&data[offset..end]).await?;
                offset = end;
            }

            remote_file.flush().await?;

            Ok(total_bytes)
        } else {
            Err(anyhow::anyhow!("Not connected"))
        }
    }

    pub async fn rename_remote_file(&self, old_path: &str, new_path: &str) -> Result<()> {
        let sftp = self.open_sftp_session().await?;
        sftp.rename(old_path, new_path).await?;
        Ok(())
    }

    pub async fn remove_remote_file(&self, path: &str) -> Result<()> {
        let sftp = self.open_sftp_session().await?;
        sftp.remove_file(path).await?;
        Ok(())
    }
}

/// Load and decode an SSH private key, expanding `~` and normalising CRLF line
/// endings so keys created or edited on Windows (which use `\r\n`) are parsed
/// correctly by russh's PEM / OpenSSH decoder. Used both for the target
/// host and for the jump host when it authenticates with a public key.
pub(crate) fn load_private_key(
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<keys::PrivateKey> {
    // Expand tilde in path — use dirs::home_dir() for cross-platform support
    // (HOME is not set on Windows; USERPROFILE is used instead).
    let expanded_path = if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy();
            key_path.replacen('~', &home_str, 1)
        } else {
            key_path.to_string()
        }
    } else {
        key_path.to_string()
    };

    // Check if file exists
    if !std::path::Path::new(&expanded_path).exists() {
        return Err(anyhow::anyhow!(
            "SSH key file not found: {}. Please check the file path and try again.",
            key_path
        ));
    }

    let key_content = std::fs::read_to_string(&expanded_path)
        .map_err(|e| anyhow::anyhow!("Failed to read SSH key file {}: {}", key_path, e))?;
    let key_content = key_content.replace("\r\n", "\n");

    // decode_secret_key takes the key *content* as a &str.
    decode_secret_key(&key_content, passphrase).map_err(|e| {
        if e.to_string().contains("encrypted") || e.to_string().contains("passphrase") {
            anyhow::anyhow!(
                "Failed to decrypt SSH key. The key may be encrypted. Please provide the correct passphrase."
            )
        } else {
            anyhow::anyhow!(
                "Failed to load SSH key from {}: {}. Ensure the file is a valid SSH private key (RSA, Ed25519, or ECDSA).",
                key_path, e
            )
        }
    })
}

#[cfg(test)]
mod tests;
