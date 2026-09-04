use anyhow::Result;
use russh::keys as russh_keys;
use russh::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::{load_private_key, Client, JumpConfig};

/// Configuration for a standalone SFTP connection (SSH transport, no PTY).
#[derive(Debug, Clone, Deserialize)]
pub struct SftpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SftpAuthMethod,
    /// Optional SSH jump host the SFTP connection is tunnelled through.
    pub jump: Option<JumpConfig>,
    pub host_key_fingerprint: Option<String>,
    #[serde(default = "default_host_key_verification")]
    pub host_key_verification: bool,
}

fn default_host_key_verification() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum SftpAuthMethod {
    Password {
        password: String,
    },
    PublicKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

/// A single file/directory entry returned from directory listings.
/// Used by both local and remote (SFTP/FTP) file operations.
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub modified: Option<String>,
    pub permissions: Option<String>,
    pub file_type: FileEntryType,
}

/// Backward-compatible alias for code that still references RemoteFileEntry.
pub type RemoteFileEntry = FileEntry;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum FileEntryType {
    File,
    Directory,
    Symlink,
}

pub(crate) async fn list_sftp_dir(sftp: &SftpSession, path: &str) -> Result<Vec<RemoteFileEntry>> {
    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list directory '{}': {}", path, e))?;

    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let attrs = entry.metadata();
        let file_type = if attrs.is_dir() {
            FileEntryType::Directory
        } else if attrs.is_symlink() {
            FileEntryType::Symlink
        } else {
            FileEntryType::File
        };

        result.push(RemoteFileEntry {
            name,
            size: attrs.size.unwrap_or(0),
            modified: attrs.mtime.map(|t| chrono_from_unix_timestamp(t as u64)),
            permissions: attrs.permissions.map(format_permissions),
            file_type,
        });
    }

    result.sort_by(|a, b| {
        let a_is_dir = matches!(a.file_type, FileEntryType::Directory);
        let b_is_dir = matches!(b.file_type, FileEntryType::Directory);
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Standalone SFTP client — opens an SSH connection and SFTP subsystem
/// channel without allocating a PTY.
pub struct StandaloneSftpClient {
    session: Option<Arc<client::Handle<Client>>>,
    /// Keeps the jump-host session alive for the lifetime of the connection.
    jump_handle: Option<client::Handle<Client>>,
    sftp: Option<SftpSession>,
}

impl StandaloneSftpClient {
    /// Default constructor + flat transfer wrappers form the client's public
    /// API surface (tests + future non-progress call sites); the commands
    /// layer currently goes through the `*_with_progress` variants.
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            session: None,
            jump_handle: None,
            sftp: None,
        }
    }

    /// Establish an SSH connection, authenticate, and open the SFTP subsystem.
    pub async fn connect(config: &SftpConfig) -> Result<Self> {
        let ssh_config = client::Config {
            preferred: russh::Preferred {
                key: std::borrow::Cow::Borrowed(crate::ssh::PREFERRED_HOST_KEY_ALGOS),
                compression: std::borrow::Cow::Borrowed(&[russh::compression::NONE]),
                ..russh::Preferred::DEFAULT
            },
            ..client::Config::default()
        };
        let connection_timeout = Duration::from_secs(10);
        let mut jump_handle: Option<client::Handle<Client>> = None;

        let mut ssh_session = if let Some(jump) = &config.jump {
            // Tunnel through the jump host, then run the SSH handshake over it.
            // Keep the jump session alive for the whole SFTP session.
            let tunnel = crate::jump::connect_via_jump(
                jump,
                &config.host,
                config.port,
                connection_timeout,
                None, // SFTP sessions rely on the target SSH session's keepalive
                3,
                config.host_key_verification,
            )
            .await?;
            jump_handle = Some(tunnel.session);
            tokio::time::timeout(
                connection_timeout,
                client::connect_stream(
                    Arc::new(ssh_config),
                    tunnel.stream,
                    Client::new(
                        config.host_key_fingerprint.clone(),
                        config.host_key_verification,
                    ),
                ),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "SFTP connection timed out after 10 seconds. Please check the host and network."
                )
            })?
            .map_err(|e| {
                anyhow::anyhow!(
                    "Failed to connect to {}:{}: {}",
                    config.host,
                    config.port,
                    e
                )
            })?
        } else {
            tokio::time::timeout(
                connection_timeout,
                client::connect(
                    Arc::new(ssh_config),
                    (&config.host[..], config.port),
                    Client::new(
                        config.host_key_fingerprint.clone(),
                        config.host_key_verification,
                    ),
                ),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "SFTP connection timed out after 10 seconds. Please check the host and network."
                )
            })?
            .map_err(|e| {
                anyhow::anyhow!(
                    "Failed to connect to {}:{}: {}",
                    config.host,
                    config.port,
                    e
                )
            })?
        };

        // Authenticate
        let authenticated = match &config.auth_method {
            SftpAuthMethod::Password { password } => ssh_session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| anyhow::anyhow!("SFTP password authentication failed: {}", e))?
                .success(),
            SftpAuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                // Load the key the same way the SSH connection path does (reads
                // the file content and normalises CRLF) — passing the raw path
                // string to decode_secret_key never worked.
                let key = load_private_key(key_path, passphrase.as_deref())?;

                ssh_session
                    .authenticate_publickey(
                        &config.username,
                        russh_keys::PrivateKeyWithHashAlg::new(
                            Arc::new(key),
                            Some(russh_keys::HashAlg::Sha256),
                        ),
                    )
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!(
                            "SFTP public key authentication failed: {}. The key may not be authorized on the server.",
                            e
                        )
                    })?
                    .success()
            }
        };

        if !authenticated {
            return Err(anyhow::anyhow!(
                "SFTP authentication failed. Please check your credentials."
            ));
        }

        let session = Arc::new(ssh_session);

        // Open an SFTP subsystem channel (no PTY)
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;

        Ok(Self {
            session: Some(session),
            jump_handle,
            sftp: Some(sftp),
        })
    }

    // Public API surface (tests + future non-progress call sites).
    #[allow(dead_code)]
    pub fn is_connected(&self) -> bool {
        self.session.is_some() && self.sftp.is_some()
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        // Drop SFTP session first
        self.sftp.take();
        // Disconnect SSH session
        if let Some(session) = self.session.take() {
            match Arc::try_unwrap(session) {
                Ok(session) => {
                    let _ = session
                        .disconnect(Disconnect::ByApplication, "", "English")
                        .await;
                }
                Err(arc_session) => {
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

    // ===== File Operations =====

    pub(crate) fn sftp_session(&self) -> Result<&SftpSession> {
        self.sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))
    }

    /// List directory contents at `path`.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<RemoteFileEntry>> {
        list_sftp_dir(self.sftp_session()?, path).await
    }

    /// Download a remote file to a local path. Returns bytes downloaded.
    // Public API surface (tests + future non-progress call sites).
    #[allow(dead_code)]
    pub async fn download_file(&self, remote_path: &str, local_path: &str) -> Result<u64> {
        self.download_file_with_progress(remote_path, local_path, |_, _| {})
            .await
    }

    /// Download with a progress callback `(total_bytes, transferred_bytes)`.
    /// The total is `None`-safe: we report an estimate when the remote size is
    /// unknown. Called after every read chunk (32 KiB).
    pub async fn download_file_with_progress(
        &self,
        remote_path: &str,
        local_path: &str,
        mut on_progress: impl FnMut(u64, u64) + Send,
    ) -> Result<u64> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        let mut remote_file = sftp
            .open(remote_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e))?;
        let total = remote_file
            .metadata()
            .await
            .map(|m| m.size.unwrap_or(0))
            .unwrap_or(0);

        let mut temp_buf = vec![0u8; 32768];
        let mut transferred: u64 = 0;

        let mut local_file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create local file '{}': {}", local_path, e))?;

        loop {
            let n = remote_file.read(&mut temp_buf).await?;
            if n == 0 {
                break;
            }
            local_file.write_all(&temp_buf[..n]).await?;
            transferred += n as u64;
            on_progress(total, transferred);
        }
        local_file.flush().await?;
        Ok(transferred)
    }

    /// Upload with a progress callback `(total_bytes, transferred_bytes)`.
    pub async fn upload_file_with_progress(
        &self,
        local_path: &str,
        remote_path: &str,
        mut on_progress: impl FnMut(u64, u64) + Send,
    ) -> Result<u64> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to open local file '{}': {}", local_path, e))?;
        let total_bytes = local_file
            .metadata()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to stat local file '{}': {}", local_path, e))?
            .len();

        let mut remote_file = sftp.create(remote_path).await.map_err(|e| {
            anyhow::anyhow!("Failed to create remote file '{}': {}", remote_path, e)
        })?;

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

        Ok(total_bytes)
    }

    // Public API surface (tests + future non-progress call sites).
    #[allow(dead_code)]
    pub async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<u64> {
        self.upload_file_with_progress(local_path, remote_path, |_, _| {})
            .await
    }

    /// Create a directory on the remote server.
    pub async fn create_dir(&self, path: &str) -> Result<()> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        sftp.create_dir(path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create directory '{}': {}", path, e))?;
        Ok(())
    }

    /// Rename a file or directory.
    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<()> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        sftp.rename(old_path, new_path).await.map_err(|e| {
            anyhow::anyhow!("Failed to rename '{}' to '{}': {}", old_path, new_path, e)
        })?;
        Ok(())
    }

    /// Delete a file on the remote server.
    pub async fn delete_file(&self, path: &str) -> Result<()> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        sftp.remove_file(path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete file '{}': {}", path, e))?;
        Ok(())
    }

    /// Delete a directory on the remote server.
    pub async fn delete_dir(&self, path: &str) -> Result<()> {
        let sftp = self
            .sftp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SFTP session not connected"))?;

        sftp.remove_dir(path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to delete directory '{}': {}", path, e))?;
        Ok(())
    }
}

/// Convert a Unix timestamp (seconds since epoch) to ISO 8601 string.
fn chrono_from_unix_timestamp(secs: u64) -> String {
    use std::time::UNIX_EPOCH;
    let time = UNIX_EPOCH + Duration::from_secs(secs);
    // Format as ISO 8601
    let datetime: std::time::SystemTime = time;
    let since_epoch = datetime.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since_epoch.as_secs();
    // Simple manual formatting: YYYY-MM-DD HH:MM:SS
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;

    // Calculate year/month/day from days since epoch (1970-01-01)
    let (year, month, day) = days_to_ymd(days as i64);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        year, month, day, hours, minutes, seconds
    )
}

fn days_to_ymd(mut days: i64) -> (i64, u32, u32) {
    // Algorithm to convert days since 1970-01-01 to y/m/d
    days += 719468; // shift to 0000-03-01
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Format Unix file permissions (mode bits) as a string like `rwxr-xr-x`.
fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in flags.iter() {
        if mode & bit != 0 {
            s.push(*ch);
        } else {
            s.push('-');
        }
    }
    s
}

// =============================================================================
// Unit tests — Task 4.3
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // ---- Helper function tests ----

    #[test]
    fn test_format_permissions_full() {
        assert_eq!(format_permissions(0o777), "rwxrwxrwx");
    }

    #[test]
    fn test_format_permissions_none() {
        assert_eq!(format_permissions(0o000), "---------");
    }

    #[test]
    fn test_format_permissions_typical_file() {
        assert_eq!(format_permissions(0o644), "rw-r--r--");
    }

    #[test]
    fn test_format_permissions_typical_dir() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
    }

    #[test]
    fn test_format_permissions_write_only() {
        assert_eq!(format_permissions(0o200), "-w-------");
    }

    #[test]
    fn test_chrono_from_unix_timestamp_epoch() {
        let result = chrono_from_unix_timestamp(0);
        assert_eq!(result, "1970-01-01 00:00:00");
    }

    #[test]
    fn test_chrono_from_unix_timestamp_known_date() {
        // 2024-01-01 00:00:00 UTC = 1704067200
        let result = chrono_from_unix_timestamp(1704067200);
        assert_eq!(result, "2024-01-01 00:00:00");
    }

    #[test]
    fn test_chrono_from_unix_timestamp_with_time() {
        // 2000-06-15 11:30:45 UTC = 961068645
        let result = chrono_from_unix_timestamp(961068645);
        assert_eq!(result, "2000-06-15 11:30:45");
    }

    #[test]
    fn test_days_to_ymd_epoch() {
        let (y, m, d) = days_to_ymd(0);
        assert_eq!((y, m, d), (1970, 1, 1));
    }

    #[test]
    fn test_days_to_ymd_known_date() {
        // 2024-01-01 = day 19723 from epoch
        let (y, m, d) = days_to_ymd(19723);
        assert_eq!((y, m, d), (2024, 1, 1));
    }

    // ---- StandaloneSftpClient unit tests ----

    #[test]
    fn test_new_client_is_disconnected() {
        let client = StandaloneSftpClient::new();
        assert!(!client.is_connected());
    }

    #[test]
    fn test_file_entry_type_serialization() {
        // Verify that FileEntryType variants serialize correctly
        let entry = RemoteFileEntry {
            name: "test.txt".to_string(),
            size: 1024,
            modified: Some("2024-01-01 00:00:00".to_string()),
            permissions: Some("rw-r--r--".to_string()),
            file_type: FileEntryType::File,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"name\":\"test.txt\""));
        assert!(json.contains("\"size\":1024"));
        assert!(json.contains("File"));
    }

    #[test]
    fn test_directory_entry_serialization() {
        let entry = RemoteFileEntry {
            name: "mydir".to_string(),
            size: 4096,
            modified: None,
            permissions: Some("rwxr-xr-x".to_string()),
            file_type: FileEntryType::Directory,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("Directory"));
        assert!(json.contains("\"modified\":null"));
    }

    #[test]
    fn test_symlink_entry_serialization() {
        let entry = RemoteFileEntry {
            name: "link".to_string(),
            size: 0,
            modified: None,
            permissions: None,
            file_type: FileEntryType::Symlink,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("Symlink"));
    }

    #[test]
    fn test_sftp_config_deserialization() {
        let json = r#"{"host":"10.0.0.1","port":22,"username":"admin","auth_method":{"type":"Password","password":"secret"}}"#;
        let config: SftpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.host, "10.0.0.1");
        assert_eq!(config.port, 22);
        assert_eq!(config.username, "admin");
        match config.auth_method {
            SftpAuthMethod::Password { password } => assert_eq!(password, "secret"),
            _ => panic!("Expected Password auth method"),
        }
    }

    #[test]
    fn test_sftp_config_publickey() {
        let json = r#"{"host":"server","port":2222,"username":"deploy","auth_method":{"type":"PublicKey","key_path":"/home/user/.ssh/id_rsa","passphrase":null}}"#;
        let config: SftpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.port, 2222);
        match config.auth_method {
            SftpAuthMethod::PublicKey {
                key_path,
                passphrase,
            } => {
                assert_eq!(key_path, "/home/user/.ssh/id_rsa");
                assert!(passphrase.is_none());
            }
            _ => panic!("Expected PublicKey auth method"),
        }
    }

    #[tokio::test]
    async fn test_disconnect_on_new_client_is_ok() {
        let mut client = StandaloneSftpClient::new();
        // Disconnecting a never-connected client should succeed
        let result = client.disconnect().await;
        assert!(result.is_ok());
        assert!(!client.is_connected());
    }
}
