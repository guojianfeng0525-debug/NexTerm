//! Native PostgreSQL session management. The command boundary is deliberately
//! narrow: configuration stays on the frontend, while live clients and query
//! results remain in backend memory.

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use russh::{
    client,
    keys::{PublicKey, PublicKeyBase64},
    Preferred,
};
use serde::{Deserialize, Serialize};
use sha2_10::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_postgres::{tls::MakeTlsConnect, Client, NoTls, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

const MAX_QUERY_ROWS: usize = 1_000;
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
pub struct PostgresState {
    clients: RwLock<HashMap<String, Arc<Client>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Option<String>,
    pub ssl_mode: String,
    pub ssl_root_cert: Option<String>,
    pub ssl_client_cert: Option<String>,
    pub ssl_client_key: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    pub ssh: Option<PostgresSshConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_path: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub host_key_fingerprint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresExecuteRequest {
    pub connection_id: String,
    pub sql: String,
    pub max_rows: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTransactionRequest {
    pub connection_id: String,
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresFilterCondition {
    pub column: String,
    /// One of: eq, neq, gt, gte, lt, lte, like, isNull, isNotNull.
    pub operator: String,
    /// Bound as text and cast to the column type by PostgreSQL. Ignored by
    /// `isNull` / `isNotNull`.
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableFilter {
    /// "AND" or "OR" between all conditions (no nested groups).
    pub logic: String,
    pub conditions: Vec<PostgresFilterCondition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSortClause {
    pub column: String,
    /// "asc" or "desc".
    pub direction: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDataRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    /// Server-side filter applied to the paged query (table tab only).
    pub filter: Option<PostgresTableFilter>,
    /// Explicit ORDER BY clauses; a primary-key tie-breaker is appended
    /// automatically for stable paging.
    pub order_by: Option<Vec<PostgresSortClause>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableUpdateRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    pub key_values: HashMap<String, String>,
    pub changes: HashMap<String, Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableInsertRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    /// Only explicitly edited columns are sent; absent columns fall back to
    /// the server-side DEFAULT instead of being forced to NULL.
    pub values: HashMap<String, Option<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableInsertResult {
    /// Generated primary-key values, populated only when the table has a
    /// primary key and the statement uses `RETURNING`.
    pub primary_key_values: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDeleteRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    pub key_values: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDataResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub primary_key_columns: Vec<String>,
    pub nullable_columns: Vec<String>,
    pub truncated: bool,
    /// Formatted server types aligned with `columns` (e.g. `int4`, `text`).
    pub column_types: Vec<String>,
    /// Column comments aligned with `columns`; empty string when absent.
    pub column_comments: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresCatalogSearchRequest {
    pub connection_id: String,
    pub kind: String,
    pub prefix: Option<String>,
    pub schema: Option<String>,
    pub relation: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSshFingerprintRequest {
    pub host: String,
    pub port: u16,
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSshFingerprintResponse {
    pub fingerprint: String,
}

struct FingerprintClient {
    expected: Option<String>,
    observed: Arc<std::sync::Mutex<Option<String>>>,
}

/// A probe is deliberately separate from the tunnel handler: it observes a
/// first-use key so the renderer can request consent, but it never authenticates
/// or opens a PostgreSQL forwarding channel.
struct FingerprintProbeClient {
    observed: Arc<std::sync::Mutex<Option<String>>>,
}

/// PostgreSQL SSH tunnels must always be pinned before authentication.  The
/// renderer obtains a first-use fingerprint through `postgres_ssh_fingerprint`,
/// asks for explicit consent, persists it on the PostgreSQL profile, and then
/// retries this connection with the resulting pin.
fn fingerprint_matches(expected: Option<&str>, actual: &str) -> bool {
    expected.is_some_and(|value| value == actual)
}

fn ssh_fingerprint(key: &PublicKey) -> String {
    let digest = Sha256::digest(key.public_key_bytes());
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

impl client::Handler for FingerprintClient {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = ssh_fingerprint(key);
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(fingerprint_matches(self.expected.as_deref(), &fingerprint))
    }
}

impl client::Handler for FingerprintProbeClient {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(ssh_fingerprint(key));
        }
        Ok(true)
    }
}

async fn open_verified_jump(
    request: &PostgresConnectRequest,
    ssh: &PostgresSshConfig,
) -> Result<
    (
        russh::ChannelStream<client::Msg>,
        client::Handle<FingerprintClient>,
    ),
    String,
> {
    if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() {
        return Err("SSH host and username are required".into());
    }
    let expected = ssh
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "SSH host-key trust is required before opening a PostgreSQL tunnel".to_string()
        })?;
    let observed = Arc::new(std::sync::Mutex::new(None));
    let handler = FingerprintClient {
        expected: Some(expected),
        observed,
    };
    let config = Arc::new(client::Config {
        preferred: Preferred {
            key: std::borrow::Cow::Borrowed(crate::ssh::PREFERRED_HOST_KEY_ALGOS),
            // Postgres tunnels use a direct-tcpip channel; russh 0.62 may close
            // it early on zlib negotiation, so disable SSH compression like the
            // other tunnel paths (src/ssh/mod.rs, src/jump.rs, src/sftp_client.rs).
            compression: std::borrow::Cow::Borrowed(&[russh::compression::NONE]),
            ..Preferred::DEFAULT
        },
        nodelay: true,
        ..client::Config::default()
    });
    let mut session = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (&ssh.host[..], ssh.port), handler),
    )
    .await
    .map_err(|_| "SSH jump connection timed out")?
    .map_err(|_| "SSH host key fingerprint changed. Refusing to connect.".to_string())?;
    let authenticated = match ssh.auth_method.as_str() {
        "password" => session
            .authenticate_password(
                &ssh.username,
                ssh.password
                    .as_deref()
                    .ok_or_else(|| "SSH password is required".to_string())?,
            )
            .await
            .map_err(|error| format!("SSH password authentication failed: {error}"))?
            .success(),
        "privateKey" => {
            let key = if let Some(private_key) =
                ssh.private_key.as_deref().filter(|value| !value.is_empty())
            {
                russh::keys::decode_secret_key(private_key, ssh.private_key_passphrase.as_deref())
                    .map_err(|error| format!("Unable to decode SSH private key: {error}"))?
            } else {
                crate::ssh::load_private_key(
                    ssh.private_key_path
                        .as_deref()
                        .ok_or_else(|| "Saved SSH private-key path is required".to_string())?,
                    ssh.private_key_passphrase.as_deref(),
                )
                .map_err(|error| format!("Unable to load SSH private key: {error}"))?
            };
            session
                .authenticate_publickey(
                    &ssh.username,
                    russh::keys::PrivateKeyWithHashAlg::new(
                        Arc::new(key),
                        Some(russh::keys::HashAlg::Sha256),
                    ),
                )
                .await
                .map_err(|error| format!("SSH private-key authentication failed: {error}"))?
                .success()
        }
        _ => return Err("Unsupported SSH authentication method".into()),
    };
    if !authenticated {
        return Err("SSH jump authentication failed".into());
    }
    let channel = tokio::time::timeout(
        CONNECT_TIMEOUT,
        session.channel_open_direct_tcpip(&request.host, request.port as u32, "127.0.0.1", 0),
    )
    .await
    .map_err(|_| "Timed out opening SSH channel to PostgreSQL")?
    .map_err(|error| format!("Failed to open SSH channel to PostgreSQL: {error}"))?;
    Ok((channel.into_stream(), session))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresCatalogItem {
    pub kind: String,
    pub schema: Option<String>,
    pub name: String,
    pub relation: Option<String>,
    pub data_type: Option<String>,
    pub signature: Option<String>,
    pub relation_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresConnectionStatus {
    pub connection_id: String,
    pub connected: bool,
    pub database: String,
    pub server_version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub command_tags: Vec<String>,
    pub truncated: bool,
}

fn config(request: &PostgresConnectRequest) -> Result<tokio_postgres::Config, String> {
    if request.connection_id.trim().is_empty()
        || request.host.trim().is_empty()
        || request.database.trim().is_empty()
        || request.username.trim().is_empty()
    {
        return Err("Connection name, host, database, and username are required".into());
    }
    let mut config = tokio_postgres::Config::new();
    config
        .host(&request.host)
        .port(request.port)
        .dbname(&request.database)
        .user(&request.username);
    if let Some(password) = &request.password {
        config.password(password);
    }
    Ok(config)
}

fn certificates(
    pem: &str,
    field: &str,
) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    rustls_pemfile::certs(&mut Cursor::new(pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid {field} PEM certificate: {error}"))
}

fn tls_connector(request: &PostgresConnectRequest) -> Result<MakeRustlsConnect, String> {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(pem) = request
        .ssl_root_cert
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        for certificate in certificates(pem, "CA")? {
            roots
                .add(certificate)
                .map_err(|error| format!("Invalid CA certificate: {error}"))?;
        }
    } else {
        let result = rustls_native_certs::load_native_certs();
        for error in result.errors {
            tracing::warn!("Unable to load a native certificate: {error}");
        }
        for certificate in result.certs {
            if let Err(error) = roots.add(certificate) {
                tracing::warn!("Unable to add a native certificate: {error}");
            }
        }
    }
    if roots.is_empty() {
        return Err("No trusted TLS root certificates are available".into());
    }
    let config = match (
        request.ssl_client_cert.as_deref(),
        request.ssl_client_key.as_deref(),
    ) {
        (Some(cert), Some(key)) if !cert.trim().is_empty() && !key.trim().is_empty() => {
            let certificates = certificates(cert, "client")?;
            let key = rustls_pemfile::private_key(&mut Cursor::new(key.as_bytes()))
                .map_err(|error| format!("Invalid client private key: {error}"))?
                .ok_or_else(|| {
                    "Client private key PEM does not contain a supported key".to_string()
                })?;
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_client_auth_cert(certificates, key)
                .map_err(|error| format!("Invalid client TLS identity: {error}"))?
        }
        (None, None) | (Some(""), None) | (None, Some("")) | (Some(""), Some("")) => {
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth()
        }
        _ => return Err("Both client certificate and private key are required for mTLS".into()),
    };
    Ok(MakeRustlsConnect::new(config))
}

async fn open_client(request: &PostgresConnectRequest) -> Result<Arc<Client>, String> {
    let config = config(request)?;
    if let Some(ssh) = &request.ssh {
        let (stream, session) = open_verified_jump(request, ssh).await?;
        let client = if request.ssl_mode == "disable" {
            let (client, connection) =
                tokio::time::timeout(CONNECT_TIMEOUT, config.connect_raw(stream, NoTls))
                    .await
                    .map_err(|_| "PostgreSQL connection through SSH timed out")?
                    .map_err(|error| {
                        format!("PostgreSQL connection through SSH failed: {error}")
                    })?;
            tauri::async_runtime::spawn(async move {
                let _jump_session = session;
                if let Err(error) = connection.await {
                    tracing::warn!("PostgreSQL SSH connection ended: {error}");
                }
            });
            client
        } else {
            let mut connector = tls_connector(request)?;
            let tls = <MakeRustlsConnect as MakeTlsConnect<russh::ChannelStream<client::Msg>>>::make_tls_connect(&mut connector, &request.host)
                .map_err(|error| format!("Unable to configure PostgreSQL TLS: {error}"))?;
            let (client, connection) =
                tokio::time::timeout(CONNECT_TIMEOUT, config.connect_raw(stream, tls))
                    .await
                    .map_err(|_| "PostgreSQL TLS connection through SSH timed out")?
                    .map_err(|error| {
                        format!("PostgreSQL TLS connection through SSH failed: {error}")
                    })?;
            tauri::async_runtime::spawn(async move {
                let _jump_session = session;
                if let Err(error) = connection.await {
                    tracing::warn!("PostgreSQL TLS SSH connection ended: {error}");
                }
            });
            client
        };
        return Ok(Arc::new(client));
    }
    let connect_plain = || async {
        let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, config.connect(NoTls))
            .await
            .map_err(|_| "PostgreSQL connection timed out")?
            .map_err(|error| format!("PostgreSQL connection failed: {error}"))?;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = connection.await {
                tracing::warn!("PostgreSQL connection ended: {error}");
            }
        });
        Ok::<Client, String>(client)
    };
    let connect_tls = || async {
        // Rustls verifies both the certificate chain and the configured host name.
        // `require` is intentionally at least as strict as verify-full rather than
        // allowing an insecure certificate-validation bypass.
        let (client, connection) =
            tokio::time::timeout(CONNECT_TIMEOUT, config.connect(tls_connector(request)?))
                .await
                .map_err(|_| "PostgreSQL TLS connection timed out")?
                .map_err(|error| format!("PostgreSQL TLS connection failed: {error}"))?;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = connection.await {
                tracing::warn!("PostgreSQL TLS connection ended: {error}");
            }
        });
        Ok::<Client, String>(client)
    };
    let client = match request.ssl_mode.as_str() {
        "disable" => connect_plain().await?,
        "allow" => match connect_plain().await {
            Ok(client) => client,
            Err(_) => connect_tls().await?,
        },
        "prefer" => match connect_tls().await {
            Ok(client) => client,
            Err(_) => connect_plain().await?,
        },
        "require" | "verify-ca" | "verify-full" => connect_tls().await?,
        _ => return Err("Unsupported PostgreSQL SSL mode".into()),
    };
    Ok(Arc::new(client))
}

#[tauri::command]
pub async fn postgres_connect(
    request: PostgresConnectRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresConnectionStatus, String> {
    let client = open_client(&request).await?;
    if request.read_only {
        client
            .batch_execute("SET default_transaction_read_only = on")
            .await
            .map_err(|error| format!("Failed to enable PostgreSQL read-only mode: {error}"))?;
    }
    let server_version = client
        .query_one("SHOW server_version", &[])
        .await
        .map_err(|error| format!("Failed to read PostgreSQL server version: {error}"))?
        .try_get::<_, String>(0)
        .map_err(|error| format!("Failed to decode PostgreSQL server version: {error}"))?;
    state
        .clients
        .write()
        .await
        .insert(request.connection_id.clone(), client);
    Ok(PostgresConnectionStatus {
        connection_id: request.connection_id,
        connected: true,
        database: request.database,
        server_version,
    })
}

#[tauri::command]
pub async fn postgres_disconnect(
    connection_id: String,
    state: tauri::State<'_, PostgresState>,
) -> Result<(), String> {
    state.clients.write().await.remove(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn postgres_execute(
    request: PostgresExecuteRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresQueryResult, String> {
    if request.sql.trim().is_empty() {
        return Err("SQL cannot be empty".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let limit = request
        .max_rows
        .unwrap_or(MAX_QUERY_ROWS)
        .clamp(1, MAX_QUERY_ROWS);
    let messages = tokio::time::timeout(QUERY_TIMEOUT, client.simple_query(&request.sql))
        .await
        .map_err(|_| "PostgreSQL query timed out")?
        .map_err(|error| format!("PostgreSQL query failed: {error}"))?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut command_tags = Vec::new();
    let mut truncated = false;
    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row
                        .columns()
                        .iter()
                        .map(|column| column.name().to_string())
                        .collect();
                }
                if rows.len() < limit {
                    rows.push(
                        (0..row.len())
                            .map(|index| row.get(index).map(str::to_owned))
                            .collect(),
                    );
                } else {
                    truncated = true;
                }
            }
            SimpleQueryMessage::CommandComplete(count) => command_tags.push(count.to_string()),
            _ => {}
        }
    }
    Ok(PostgresQueryResult {
        columns,
        rows,
        command_tags,
        truncated,
    })
}

#[tauri::command]
pub async fn postgres_explain(
    request: PostgresExecuteRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresQueryResult, String> {
    let sql = single_statement(&request.sql)?;
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let messages = tokio::time::timeout(
        QUERY_TIMEOUT,
        client.simple_query(&format!("EXPLAIN {sql}")),
    )
    .await
    .map_err(|_| "PostgreSQL EXPLAIN timed out")?
    .map_err(|error| format!("PostgreSQL EXPLAIN failed: {error}"))?;
    let mut rows = Vec::new();
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            rows.push(
                (0..row.len())
                    .map(|index| row.get(index).map(str::to_owned))
                    .collect(),
            );
        }
    }
    Ok(PostgresQueryResult {
        columns: vec!["QUERY PLAN".into()],
        rows,
        command_tags: Vec::new(),
        truncated: false,
    })
}

#[tauri::command]
pub async fn postgres_transaction(
    request: PostgresTransactionRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<(), String> {
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let statement = match request.action.as_str() {
        "begin" => "BEGIN",
        "commit" => "COMMIT",
        "rollback" => "ROLLBACK",
        _ => return Err("Unsupported PostgreSQL transaction action".into()),
    };
    tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute(statement))
        .await
        .map_err(|_| "PostgreSQL transaction action timed out")?
        .map_err(|error| format!("PostgreSQL transaction action failed: {error}"))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Loads primary-key column names and their formatted server types in key order.
async fn load_primary_keys(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = client
        .query(
            "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord",
            &[&schema, &table],
        )
        .await
        .map_err(|error| format!("Failed to load table primary key: {error}"))?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get(0)
                    .map_err(|error| format!("Failed to decode primary key: {error}"))?,
                row.try_get(1)
                    .map_err(|error| format!("Failed to decode primary key type: {error}"))?,
            ))
        })
        .collect()
}

/// Loads every live column name and its formatted server type.
async fn load_column_types(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = client
        .query(
            "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
            &[&schema, &table],
        )
        .await
        .map_err(|error| format!("Failed to load table column types: {error}"))?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get(0)
                    .map_err(|error| format!("Failed to decode table column: {error}"))?,
                row.try_get(1)
                    .map_err(|error| format!("Failed to decode table column type: {error}"))?,
            ))
        })
        .collect()
}

/// Loads every live column (name, formatted type, comment) in definition
/// order. A single catalog query avoids per-column round-trips.
async fn load_column_metadata(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<(String, String, Option<String>)>, String> {
    let rows = client
        .query(
            "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), pg_catalog.col_description(c.oid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
        .map_err(|error| format!("Failed to load table column metadata: {error}"))?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get(0)
                    .map_err(|error| format!("Failed to decode table column: {error}"))?,
                row.try_get(1)
                    .map_err(|error| format!("Failed to decode table column type: {error}"))?,
                row.try_get(2)
                    .map_err(|error| format!("Failed to decode table column comment: {error}"))?,
            ))
        })
        .collect()
}

/// Maximum number of AND/OR conditions accepted by build_where_clause.
const MAX_FILTER_CONDITIONS: usize = 32;
/// Maximum length of a single bound filter value (64 KiB).
const MAX_FILTER_VALUE_LEN: usize = 64 * 1024;
/// Maximum number of explicit ORDER BY columns.
const MAX_ORDER_BY_COLUMNS: usize = 8;

/// `format_type` output is trusted server data, but it is interpolated into
/// SQL text (`$n::text::<type>`), so only ASCII-safe type spellings are
/// allowed. Comment markers, quotes, and backslashes never appear in legal
/// type names; allowing them would open `--`, `/*`, and string escapes.
fn validate_cast_type(data_type: &str) -> Result<(), String> {
    if data_type.is_empty()
        || !data_type.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b" _(),[]\".".contains(&b)
        })
    {
        return Err("Unsafe column type name from catalog".into());
    }
    Ok(())
}

/// Builds a parameterized WHERE clause from whitelisted conditions. Every
/// column must exist in the table's live column set; operators are restricted
/// to the supported set; values are bound as text and cast to the column type
/// by PostgreSQL. Returns `(clause, params)` where clause is empty for no
/// conditions.
///
/// NULL semantics (security constraint §2.2/§5): value operators (`eq`,
/// `neq`, `gt`, `gte`, `lt`, `lte`, `like`) require a concrete `Some` value —
/// a `None` is rejected, never silently coerced to `""`. `None`/NULL in SQL is
/// expressed only via `isNull` / `isNotNull`, which bind no parameter.
fn build_where_clause(
    filter: &PostgresTableFilter,
    column_types: &HashMap<String, String>,
) -> Result<(String, Vec<Option<String>>), String> {
    if filter.conditions.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    if filter.conditions.len() > MAX_FILTER_CONDITIONS {
        return Err(format!(
            "Too many filter conditions (max {MAX_FILTER_CONDITIONS})"
        )
        .into());
    }
    let logic = match filter.logic.as_str() {
        "AND" => " AND ",
        "OR" => " OR ",
        _ => return Err("Filter logic must be AND or OR".into()),
    };
    let mut params: Vec<Option<String>> = Vec::new();
    let mut predicates = Vec::new();
    for condition in &filter.conditions {
        let data_type = column_types
            .get(&condition.column)
            .ok_or_else(|| format!("Unknown filter column: {}", condition.column))?;
        validate_cast_type(data_type)?;
        let column = quote_identifier(&condition.column);
        let predicate = match condition.operator.as_str() {
            "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" => {
                let value = condition.value.as_ref().ok_or_else(|| {
                    format!(
                        "Filter operator {} requires a value",
                        condition.operator
                    )
                })?;
                if value.len() > MAX_FILTER_VALUE_LEN {
                    return Err("Filter value exceeds the maximum length".into());
                }
                params.push(Some(value.clone()));
                let symbol = match condition.operator.as_str() {
                    "eq" => "=",
                    "neq" => "<>",
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    "lte" => "<=",
                    // LIKE patterns bind as plain text without casting to the
                    // column type (security constraint §2.1): `%`/`_` are
                    // interpreted by PostgreSQL, never escaped.
                    _ => "LIKE",
                };
                if condition.operator == "like" {
                    format!("{column} {symbol} ${}::text", params.len())
                } else {
                    format!("{column} {symbol} ${}::text::{}", params.len(), data_type)
                }
            }
            "isNull" => format!("{column} IS NULL"),
            "isNotNull" => format!("{column} IS NOT NULL"),
            _ => return Err(format!("Unsupported filter operator: {}", condition.operator)),
        };
        predicates.push(predicate);
    }
    Ok((format!(" WHERE {}", predicates.join(logic)), params))
}

/// Builds an ORDER BY clause from whitelisted columns/directions, appending a
/// primary-key tie-breaker for stable paging. Returns empty when no explicit
/// sort is requested and the table has no primary key.
fn build_order_by_clause(
    order_by: &[PostgresSortClause],
    valid_columns: &HashSet<String>,
    primary_key_columns: &[String],
) -> Result<String, String> {
    if order_by.len() > MAX_ORDER_BY_COLUMNS {
        return Err(format!(
            "Too many ORDER BY columns (max {MAX_ORDER_BY_COLUMNS})"
        )
        .into());
    }
    let mut clauses = Vec::new();
    for clause in order_by {
        if !valid_columns.contains(&clause.column) {
            return Err(format!("Unknown order column: {}", clause.column));
        }
        let direction = match clause.direction.as_str() {
            "asc" => "ASC",
            "desc" => "DESC",
            _ => return Err(format!("Unsupported sort direction: {}", clause.direction)),
        };
        clauses.push(format!("{} {}", quote_identifier(&clause.column), direction));
    }
    for key in primary_key_columns {
        clauses.push(format!("{} ASC", quote_identifier(key)));
    }
    if clauses.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(" ORDER BY {}", clauses.join(", ")))
    }
}

/// Builds a parameterized single-row INSERT. Only the provided columns are
/// written; absent columns keep their server-side DEFAULT. Values are cast
/// through `::text::<type>` so string transport cannot lose precision.
fn build_insert_statement(
    schema: &str,
    table: &str,
    values: &HashMap<String, Option<String>>,
    column_types: &HashMap<String, String>,
    primary_keys: &[(String, String)],
) -> Result<(String, Vec<Option<String>>), String> {
    let mut params: Vec<Option<String>> = Vec::new();
    let mut columns = Vec::new();
    let mut placeholders = Vec::new();
    for (column, value) in values {
        let data_type = column_types
            .get(column)
            .ok_or_else(|| format!("Unknown table column: {column}"))?;
        params.push(value.clone());
        columns.push(quote_identifier(column));
        placeholders.push(format!("${}::text::{}", params.len(), data_type));
    }
    let returning = if primary_keys.is_empty() {
        String::new()
    } else {
        format!(
            " RETURNING {}",
            primary_keys
                .iter()
                .map(|(key, _)| quote_identifier(key))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let statement = format!(
        "INSERT INTO {}.{} ({}) VALUES ({}){}",
        quote_identifier(schema),
        quote_identifier(table),
        columns.join(", "),
        placeholders.join(", "),
        returning
    );
    Ok((statement, params))
}

/// Builds a parameterized DELETE keyed by a complete primary-key value set.
fn build_delete_statement(
    schema: &str,
    table: &str,
    keys: &[(String, String)],
    key_values: &HashMap<String, String>,
) -> Result<(String, Vec<String>), String> {
    if keys.is_empty() || keys.iter().any(|(key, _)| !key_values.contains_key(key)) {
        return Err("This table has no usable primary key for a safe delete".into());
    }
    let mut params = Vec::new();
    let mut predicates = Vec::new();
    for (key, data_type) in keys {
        params.push(key_values[key].clone());
        predicates.push(format!(
            "{} = ${}::text::{}",
            quote_identifier(key),
            params.len(),
            data_type
        ));
    }
    let statement = format!(
        "DELETE FROM {}.{} WHERE {}",
        quote_identifier(schema),
        quote_identifier(table),
        predicates.join(" AND ")
    );
    Ok((statement, params))
}

/// EXPLAIN must not turn a semicolon-separated batch into an execution path.
/// Semicolons inside identifiers, string literals, or comments are preserved.
fn single_statement(sql: &str) -> Result<&str, String> {
    let mut quote = None;
    let mut line_comment = false;
    let mut block_depth = 0usize;
    let bytes = sql.as_bytes();

    for (index, byte) in bytes.iter().enumerate() {
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if *byte == b'\n' {
                line_comment = false;
            }
            continue;
        }
        if block_depth > 0 {
            if *byte == b'/' && next == Some(b'*') {
                block_depth += 1;
            }
            if *byte == b'*' && next == Some(b'/') {
                block_depth -= 1;
            }
            continue;
        }
        if let Some(delimiter) = quote {
            if *byte == delimiter {
                if delimiter == b'\'' && next == Some(b'\'') {
                    continue;
                }
                quote = None;
            }
            continue;
        }
        match *byte {
            b'-' if next == Some(b'-') => line_comment = true,
            b'/' if next == Some(b'*') => block_depth = 1,
            b'\'' | b'"' => quote = Some(*byte),
            b';' if sql[index + 1..].trim().is_empty() => return Ok(sql[..index].trim()),
            b';' => return Err("EXPLAIN accepts exactly one SQL statement".into()),
            _ => {}
        }
    }
    let statement = sql.trim();
    if statement.is_empty() {
        Err("SQL cannot be empty".into())
    } else {
        Ok(statement)
    }
}

#[tauri::command]
pub async fn postgres_table_data(
    request: PostgresTableDataRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresTableDataResult, String> {
    if request.schema.trim().is_empty() || request.table.trim().is_empty() {
        return Err("Schema and table are required".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let limit = request.limit.unwrap_or(100).clamp(1, 1_000);
    // Offset is bounded to prevent unbounded deep scans over filtered result
    // sets (security constraint §4).
    let offset = request.offset.unwrap_or(0).min(1_000_000);
    let relation = format!(
        "{}.{}",
        quote_identifier(&request.schema),
        quote_identifier(&request.table)
    );
    let key_rows = client.query(
        "SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table primary key: {error}"))?;
    let primary_key_columns: Vec<String> = key_rows
        .into_iter()
        .filter_map(|row| row.try_get::<_, String>(0).ok())
        .collect();
    let nullable_rows = client.query(
        "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull ORDER BY a.attnum",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table nullability: {error}"))?;
    let nullable_columns: Vec<String> = nullable_rows
        .into_iter()
        .filter_map(|row| row.try_get::<_, String>(0).ok())
        .collect();
    // Column metadata drives the identifier whitelist, typed casts, and the
    // Show Field Type / Show Comment columns. A single catalog query keeps
    // this cheap even for wide tables. The metadata query is required: safe
    // SQL construction (whitelist + cast targets) depends on it, so the old
    // simple_query browse path is intentionally removed (security §6.1).
    let metadata = load_column_metadata(&client, &request.schema, &request.table).await?;
    let mut types: HashMap<String, String> = HashMap::new();
    let mut comments: HashMap<String, Option<String>> = HashMap::new();
    for (name, data_type, comment) in &metadata {
        types.insert(name.clone(), data_type.clone());
        comments.insert(name.clone(), comment.clone());
    }
    let valid_columns: HashSet<String> = types.keys().cloned().collect();
    // WHERE is fully parameterized; identifiers are whitelisted against the
    // table's live column set, so no user text reaches the SQL.
    let (where_sql, where_params) = match &request.filter {
        Some(filter) => build_where_clause(filter, &types)?,
        None => (String::new(), Vec::new()),
    };
    let order_sql = build_order_by_clause(
        request.order_by.as_deref().unwrap_or(&[]),
        &valid_columns,
        &primary_key_columns,
    )?;
    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Send + Sync>> = where_params
        .into_iter()
        .map(|value| Box::new(value) as Box<dyn tokio_postgres::types::ToSql + Send + Sync>)
        .collect();
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = values
        .iter()
        .map(|value| value.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    // Values travel as text so the grid keeps its string transport for every
    // column type. The cast happens on the server, and WHERE values are cast
    // to the column type through the same text path used by postgres_table_update.
    let select_columns = metadata
        .iter()
        .map(|(name, _, _)| format!("{}::text", quote_identifier(name)))
        .collect::<Vec<_>>()
        .join(", ");
    // Fetch limit+1 rows so `truncated` can distinguish "exactly a full page"
    // from "more rows remain" even when WHERE/ORDER BY change the result set.
    let statement = format!(
        "SELECT {select_columns} FROM {relation}{where_sql}{order_sql} LIMIT {} OFFSET {}",
        limit + 1,
        offset
    );
    let fetched = tokio::time::timeout(
        QUERY_TIMEOUT,
        client.query(&statement, &params),
    )
    .await
    .map_err(|_| "PostgreSQL table data query timed out")?
    .map_err(|error| format!("Failed to load table data: {error}"))?;
    let truncated = fetched.len() > limit;
    let rows = fetched
        .into_iter()
        .take(limit)
        .map(|row| {
            (0..row.len())
                .map(|index| row.try_get::<_, Option<String>>(index).ok().flatten())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let columns: Vec<String> = metadata
        .iter()
        .map(|(name, _, _)| name.clone())
        .collect();
    let column_types: Vec<String> = columns
        .iter()
        .map(|name| types.get(name).cloned().unwrap_or_default())
        .collect();
    let column_comments: Vec<String> = columns
        .iter()
        .map(|name| comments.get(name).cloned().flatten().unwrap_or_default())
        .collect();
    Ok(PostgresTableDataResult {
        columns,
        truncated,
        rows,
        primary_key_columns,
        nullable_columns,
        column_types,
        column_comments,
    })
}

#[tauri::command]
pub async fn postgres_table_update(
    request: PostgresTableUpdateRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<u64, String> {
    if request.schema.trim().is_empty()
        || request.table.trim().is_empty()
        || request.changes.is_empty()
    {
        return Err("Schema, table, and at least one changed value are required".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let key_rows = client.query(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to validate table primary key: {error}"))?;
    let keys: Vec<(String, String)> = key_rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get(0)
                    .map_err(|error| format!("Failed to decode primary key: {error}"))?,
                row.try_get(1)
                    .map_err(|error| format!("Failed to decode primary key type: {error}"))?,
            ))
        })
        .collect::<Result<_, String>>()?;
    if keys.is_empty()
        || keys
            .iter()
            .any(|(key, _)| !request.key_values.contains_key(key))
    {
        return Err("This table has no usable primary key for a safe update".into());
    }
    let column_rows = client.query(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table column types: {error}"))?;
    let column_types: HashMap<String, String> = column_rows
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get(0)
                    .map_err(|error| format!("Failed to decode table column: {error}"))?,
                row.try_get(1)
                    .map_err(|error| format!("Failed to decode table column type: {error}"))?,
            ))
        })
        .collect::<Result<_, String>>()?;
    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Send + Sync>> = Vec::new();
    let mut assignments = Vec::new();
    for (column, value) in &request.changes {
        let data_type = column_types
            .get(column)
            .ok_or_else(|| format!("Unknown table column: {column}"))?;
        values.push(Box::new(value.clone()));
        assignments.push(format!(
            "{} = ${}::text::{}",
            quote_identifier(column),
            values.len(),
            data_type
        ));
    }
    let mut predicates = Vec::new();
    for (key, data_type) in &keys {
        values.push(Box::new(request.key_values[key].clone()));
        predicates.push(format!(
            "{} = ${}::text::{}",
            quote_identifier(key),
            values.len(),
            data_type
        ));
    }
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = values
        .iter()
        .map(|value| value.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let statement = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        quote_identifier(&request.schema),
        quote_identifier(&request.table),
        assignments.join(", "),
        predicates.join(" AND ")
    );
    client
        .execute(&statement, &params)
        .await
        .map_err(|error| format!("Failed to update table row: {error}"))
}

#[tauri::command]
pub async fn postgres_table_insert(
    request: PostgresTableInsertRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresTableInsertResult, String> {
    if request.schema.trim().is_empty()
        || request.table.trim().is_empty()
        || request.values.is_empty()
    {
        return Err("Schema, table, and at least one column value are required".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let column_types = load_column_types(&client, &request.schema, &request.table).await?;
    let primary_keys = load_primary_keys(&client, &request.schema, &request.table).await?;
    let (statement, params) = build_insert_statement(
        &request.schema,
        &request.table,
        &request.values,
        &column_types,
        &primary_keys,
    )?;
    let param_refs: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = param_refs
        .iter()
        .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    if primary_keys.is_empty() {
        client
            .execute(&statement, &param_refs)
            .await
            .map_err(|error| format!("Failed to insert table row: {error}"))?;
        return Ok(PostgresTableInsertResult {
            primary_key_values: HashMap::new(),
        });
    }
    let row = client
        .query_one(&statement, &param_refs)
        .await
        .map_err(|error| format!("Failed to insert table row: {error}"))?;
    let mut primary_key_values = HashMap::new();
    for (index, (key, _)) in primary_keys.iter().enumerate() {
        if let Ok(value) = row.try_get::<_, String>(index) {
            primary_key_values.insert(key.clone(), value);
        }
    }
    Ok(PostgresTableInsertResult {
        primary_key_values,
    })
}

#[tauri::command]
pub async fn postgres_table_delete(
    request: PostgresTableDeleteRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<u64, String> {
    if request.schema.trim().is_empty()
        || request.table.trim().is_empty()
        || request.key_values.is_empty()
    {
        return Err("Schema, table, and key values are required".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let primary_keys = load_primary_keys(&client, &request.schema, &request.table).await?;
    let (statement, params) = build_delete_statement(
        &request.schema,
        &request.table,
        &primary_keys,
        &request.key_values,
    )?;
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    client
        .execute(&statement, &param_refs)
        .await
        .map_err(|error| format!("Failed to delete table row: {error}"))
}

#[tauri::command]
pub async fn postgres_catalog_schemas(
    connection_id: String,
    state: tauri::State<'_, PostgresState>,
) -> Result<Vec<String>, String> {
    let client = state
        .clients
        .read()
        .await
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let rows = client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname", &[])
        .await.map_err(|error| format!("Failed to load schemas: {error}"))?;
    rows.into_iter()
        .map(|row| {
            row.try_get(0)
                .map_err(|error| format!("Failed to decode schema: {error}"))
        })
        .collect()
}

#[tauri::command]
pub async fn postgres_catalog_search(
    request: PostgresCatalogSearchRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<Vec<PostgresCatalogItem>, String> {
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let limit = request.limit.unwrap_or(100).clamp(1, 100) as i64;
    let prefix = format!("{}%", request.prefix.unwrap_or_default());
    let rows = match request.kind.as_str() {
        "relation" => client.query(
            "SELECT n.nspname, c.relname, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p') AND has_schema_privilege(n.oid, 'USAGE') AND ($1::text IS NULL OR n.nspname = $1) AND c.relname ILIKE $2 ORDER BY n.nspname, c.relname LIMIT $3",
            &[&request.schema, &prefix, &limit],
        ).await,
        "column" => {
            let schema = request.schema.as_deref().ok_or_else(|| "Schema is required for column completion".to_string())?;
            let relation = request.relation.as_deref().ok_or_else(|| "Relation is required for column completion".to_string())?;
            client.query(
                "SELECT n.nspname, a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE $3 ORDER BY a.attnum LIMIT $4",
                &[&schema, &relation, &prefix, &limit],
            ).await
        }
        "function" => client.query(
            "SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE has_schema_privilege(n.oid, 'USAGE') AND ($1::text IS NULL OR n.nspname = $1) AND p.proname ILIKE $2 ORDER BY n.nspname, p.proname LIMIT $3",
            &[&request.schema, &prefix, &limit],
        ).await,
        "type" => client.query(
            "SELECT n.nspname, t.typname, t.typtype::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE has_schema_privilege(n.oid, 'USAGE') AND ($1::text IS NULL OR n.nspname = $1) AND t.typname ILIKE $2 ORDER BY n.nspname, t.typname LIMIT $3",
            &[&request.schema, &prefix, &limit],
        ).await,
        _ => return Err("Unsupported PostgreSQL catalog item kind".into()),
    }.map_err(|error| format!("Failed to search PostgreSQL catalog: {error}"))?;
    rows.into_iter()
        .map(|row| {
            let schema: String = row
                .try_get(0)
                .map_err(|error| format!("Failed to decode catalog schema: {error}"))?;
            let name: String = row
                .try_get(1)
                .map_err(|error| format!("Failed to decode catalog item: {error}"))?;
            let detail: String = row
                .try_get(2)
                .map_err(|error| format!("Failed to decode catalog detail: {error}"))?;
            Ok(PostgresCatalogItem {
                kind: request.kind.clone(),
                schema: Some(schema),
                name,
                relation: if request.kind == "column" {
                    request.relation.clone()
                } else {
                    None
                },
                data_type: if request.kind == "column" || request.kind == "type" {
                    Some(detail.clone())
                } else {
                    None
                },
                signature: if request.kind == "function" {
                    Some(detail.clone())
                } else {
                    None
                },
                relation_kind: if request.kind == "relation" {
                    Some(detail)
                } else {
                    None
                },
            })
        })
        .collect()
}

#[tauri::command]
pub async fn postgres_ssh_fingerprint(
    request: PostgresSshFingerprintRequest,
) -> Result<PostgresSshFingerprintResponse, String> {
    if request.host.trim().is_empty() {
        return Err("SSH host is required".into());
    }
    let observed = Arc::new(std::sync::Mutex::new(None));
    let handler = FingerprintProbeClient {
        observed: Arc::clone(&observed),
    };
    let config = Arc::new(client::Config {
        // Mirror the SSH-side probe negotiation (src/ssh/mod.rs) so both ends
        // advertise the same host-key algorithm boundary for a given server.
        preferred: Preferred {
            key: std::borrow::Cow::Borrowed(crate::ssh::PREFERRED_HOST_KEY_ALGOS),
            // Also mirror the SSH-side compression policy: never negotiate zlib
            // on the direct-tcpip channel used for Postgres tunnels.
            compression: std::borrow::Cow::Borrowed(&[russh::compression::NONE]),
            ..Preferred::DEFAULT
        },
        nodelay: true,
        ..client::Config::default()
    });
    let result = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (&request.host[..], request.port), handler),
    )
    .await
    .map_err(|_| "SSH host-key probe timed out")?;
    let fingerprint = observed
        .lock()
        .map_err(|_| "SSH fingerprint probe failed".to_string())?
        .clone()
        .ok_or_else(|| "SSH server did not provide a host key".to_string())?;
    if !fingerprint_matches(request.expected_fingerprint.as_deref(), &fingerprint)
        && request.expected_fingerprint.is_some()
    {
        return Err("SSH host key fingerprint changed. Refusing to connect.".to_string());
    }
    // Close the probe session explicitly (mirrors src/ssh/mod.rs) instead of
    // dropping it mid-negotiation; connect errors are tolerated here since the
    // observed fingerprint above is the actual probe result.
    if let Ok(session) = result {
        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await;
    }
    Ok(PostgresSshFingerprintResponse { fingerprint })
}

#[cfg(test)]
mod tests {
    use super::{
        build_delete_statement, build_insert_statement, build_order_by_clause,
        build_where_clause, fingerprint_matches, single_statement, PostgresFilterCondition,
        PostgresSortClause, PostgresTableFilter,
    };
    use std::collections::{HashMap, HashSet};

    fn column_types() -> HashMap<String, String> {
        HashMap::from([
            ("id".to_string(), "integer".to_string()),
            ("name".to_string(), "text".to_string()),
            ("score".to_string(), "numeric".to_string()),
            ("note".to_string(), "text".to_string()),
        ])
    }

    #[test]
    fn where_clause_binds_values_with_typed_casts() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some("Alice".to_string()),
            }],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        assert_eq!(clause, " WHERE \"name\" = $1::text::text");
        assert_eq!(params, vec![Some("Alice".to_string())]);
    }

    #[test]
    fn where_clause_or_logic_joins_predicates() {
        let filter = PostgresTableFilter {
            logic: "OR".to_string(),
            conditions: vec![
                PostgresFilterCondition {
                    column: "category".to_string(),
                    operator: "eq".to_string(),
                    value: Some("a".to_string()),
                },
                PostgresFilterCondition {
                    column: "category".to_string(),
                    operator: "eq".to_string(),
                    value: Some("b".to_string()),
                },
            ],
        };
        let mut types = column_types();
        types.insert("category".to_string(), "text".to_string());
        let (clause, params) = build_where_clause(&filter, &types).unwrap();
        assert_eq!(
            clause,
            " WHERE \"category\" = $1::text::text OR \"category\" = $2::text::text"
        );
        assert_eq!(params, vec![Some("a".to_string()), Some("b".to_string())]);
    }

    #[test]
    fn where_clause_supports_full_operator_set() {
        let operators = [
            ("eq", "="),
            ("neq", "<>"),
            ("gt", ">"),
            ("gte", ">="),
            ("lt", "<"),
            ("lte", "<="),
        ];
        for (operator, symbol) in operators {
            let filter = PostgresTableFilter {
                logic: "AND".to_string(),
                conditions: vec![PostgresFilterCondition {
                    column: "score".to_string(),
                    operator: operator.to_string(),
                    value: Some("10".to_string()),
                }],
            };
            let (clause, _) = build_where_clause(&filter, &column_types()).unwrap();
            assert_eq!(
                clause,
                format!(" WHERE \"score\" {symbol} $1::text::numeric"),
                "operator {operator}"
            );
        }
    }

    #[test]
    fn where_clause_null_operators_bind_no_value() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![
                PostgresFilterCondition {
                    column: "note".to_string(),
                    operator: "isNull".to_string(),
                    value: None,
                },
                PostgresFilterCondition {
                    column: "name".to_string(),
                    operator: "isNotNull".to_string(),
                    value: None,
                },
            ],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        assert_eq!(
            clause,
            " WHERE \"note\" IS NULL AND \"name\" IS NOT NULL"
        );
        assert!(params.is_empty());
    }

    #[test]
    fn where_clause_rejects_null_value_on_value_operators() {
        // Security constraint §2.2/§5: a value operator with `value: null`
        // must be rejected, never coerced to IS NULL or `""`.
        for operator in ["eq", "neq", "gt", "gte", "lt", "lte", "like"] {
            let filter = PostgresTableFilter {
                logic: "AND".to_string(),
                conditions: vec![PostgresFilterCondition {
                    column: "name".to_string(),
                    operator: operator.to_string(),
                    value: None,
                }],
            };
            assert!(
                build_where_clause(&filter, &column_types()).is_err(),
                "operator {operator} with value:null must be rejected"
            );
        }
    }

    #[test]
    fn where_clause_distinguishes_none_from_empty_string() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some(String::new()),
            }],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        assert_eq!(clause, " WHERE \"name\" = $1::text::text");
        assert_eq!(params, vec![Some(String::new())]);
    }

    #[test]
    fn where_clause_value_operators_require_a_value() {
        for operator in ["eq", "neq", "gt", "gte", "lt", "lte", "like"] {
            let filter = PostgresTableFilter {
                logic: "AND".to_string(),
                conditions: vec![PostgresFilterCondition {
                    column: "score".to_string(),
                    operator: operator.to_string(),
                    value: None,
                }],
            };
            assert!(
                build_where_clause(&filter, &column_types()).is_err(),
                "operator {operator} without a value must be rejected"
            );
        }
    }

    #[test]
    fn where_clause_like_binds_pattern_verbatim() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "like".to_string(),
                value: Some("%O'Brien%".to_string()),
            }],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        // LIKE values bind as text and are not cast to the column type
        // (security constraint §2.1), so `%`/`_` stay pattern characters.
        assert_eq!(clause, " WHERE \"name\" LIKE $1::text");
        assert_eq!(params, vec![Some("%O'Brien%".to_string())]);
    }

    #[test]
    fn where_clause_rejects_too_many_conditions() {
        let conditions = (0..33)
            .map(|index| PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some(format!("v{index}")),
            })
            .collect();
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions,
        };
        assert!(build_where_clause(&filter, &column_types()).is_err());
    }

    #[test]
    fn where_clause_rejects_oversized_value() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some("x".repeat(64 * 1024 + 1)),
            }],
        };
        assert!(build_where_clause(&filter, &column_types()).is_err());
    }

    #[test]
    fn where_clause_rejects_unsafe_cast_type_from_catalog() {
        // The cast target is interpolated into SQL text; a polluted catalog
        // name must be blocked by the character-set guard.
        let mut types = column_types();
        types.insert("name".to_string(), "text; DROP TABLE x --".to_string());
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some("x".to_string()),
            }],
        };
        assert!(build_where_clause(&filter, &types).is_err());
    }

    #[test]
    fn where_clause_rejects_unknown_column() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "missing".to_string(),
                operator: "eq".to_string(),
                value: Some("x".to_string()),
            }],
        };
        assert!(build_where_clause(&filter, &column_types()).is_err());
    }

    #[test]
    fn where_clause_rejects_unknown_operator() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "regex".to_string(),
                value: Some("x".to_string()),
            }],
        };
        assert!(build_where_clause(&filter, &column_types()).is_err());
    }

    #[test]
    fn where_clause_rejects_unknown_logic() {
        let filter = PostgresTableFilter {
            logic: "XOR".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some("x".to_string()),
            }],
        };
        assert!(build_where_clause(&filter, &column_types()).is_err());
    }

    #[test]
    fn where_clause_empty_conditions_yields_no_clause() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        assert_eq!(clause, "");
        assert!(params.is_empty());
    }

    #[test]
    fn where_clause_treats_injection_value_as_literal_parameter() {
        let filter = PostgresTableFilter {
            logic: "AND".to_string(),
            conditions: vec![PostgresFilterCondition {
                column: "name".to_string(),
                operator: "eq".to_string(),
                value: Some("x' OR '1'='1".to_string()),
            }],
        };
        let (clause, params) = build_where_clause(&filter, &column_types()).unwrap();
        assert_eq!(clause, " WHERE \"name\" = $1::text::text");
        assert_eq!(params, vec![Some("x' OR '1'='1".to_string())]);
    }

    #[test]
    fn order_by_whitelists_columns_and_directions() {
        let valid: HashSet<String> =
            HashSet::from(["name".to_string(), "score".to_string()]);
        let clauses = vec![
            PostgresSortClause {
                column: "score".to_string(),
                direction: "desc".to_string(),
            },
            PostgresSortClause {
                column: "name".to_string(),
                direction: "asc".to_string(),
            },
        ];
        let sql = build_order_by_clause(&clauses, &valid, &[]).unwrap();
        assert_eq!(sql, " ORDER BY \"score\" DESC, \"name\" ASC");
    }

    #[test]
    fn order_by_appends_primary_key_tie_breaker() {
        let valid: HashSet<String> = HashSet::from(["score".to_string()]);
        let clauses = vec![PostgresSortClause {
            column: "score".to_string(),
            direction: "asc".to_string(),
        }];
        let sql = build_order_by_clause(&clauses, &valid, &["id".to_string()]).unwrap();
        assert_eq!(sql, " ORDER BY \"score\" ASC, \"id\" ASC");
    }

    #[test]
    fn order_by_empty_without_primary_key_yields_no_clause() {
        let sql = build_order_by_clause(&[], &HashSet::new(), &[]).unwrap();
        assert_eq!(sql, "");
    }

    #[test]
    fn order_by_rejects_unknown_column() {
        let clauses = vec![PostgresSortClause {
            column: "missing".to_string(),
            direction: "asc".to_string(),
        }];
        assert!(build_order_by_clause(&clauses, &HashSet::new(), &[]).is_err());
    }

    #[test]
    fn order_by_rejects_unknown_direction() {
        let valid: HashSet<String> = HashSet::from(["name".to_string()]);
        let clauses = vec![PostgresSortClause {
            column: "name".to_string(),
            direction: "sideways".to_string(),
        }];
        assert!(build_order_by_clause(&clauses, &valid, &[]).is_err());
    }

    #[test]
    fn order_by_rejects_too_many_columns() {
        let valid: HashSet<String> = (0..10)
            .map(|index| format!("col{index}"))
            .collect();
        let clauses: Vec<PostgresSortClause> = (0..9)
            .map(|index| PostgresSortClause {
                column: format!("col{index}"),
                direction: "asc".to_string(),
            })
            .collect();
        assert!(build_order_by_clause(&clauses, &valid, &[]).is_err());
    }

    #[test]
    fn explain_accepts_one_statement_with_a_trailing_semicolon() {
        assert_eq!(
            single_statement("SELECT ';' AS value;").unwrap(),
            "SELECT ';' AS value"
        );
    }

    #[test]
    fn explain_rejects_a_statement_batch() {
        assert!(single_statement("SELECT 1; DELETE FROM records").is_err());
    }

    #[test]
    fn postgres_ssh_host_key_requires_a_pin_and_rejects_mismatch() {
        let fingerprint = "SHA256:canonical-fingerprint";
        assert!(fingerprint_matches(Some(fingerprint), fingerprint));
        assert!(!fingerprint_matches(Some("SHA256:other-key"), fingerprint));
        assert!(!fingerprint_matches(None, fingerprint));
    }

    #[test]
    fn insert_statement_quotes_identifiers_and_casts_values() {
        let mut values = HashMap::new();
        values.insert("name".to_string(), Some("O'Brien".to_string()));
        let mut types = HashMap::new();
        types.insert("name".to_string(), "text".to_string());
        types.insert("age".to_string(), "integer".to_string());
        let (statement, params) = build_insert_statement(
            "public",
            "users",
            &values,
            &types,
            &[("id".to_string(), "integer".to_string())],
        )
        .unwrap();
        assert_eq!(
            statement,
            "INSERT INTO \"public\".\"users\" (\"name\") VALUES ($1::text::text) RETURNING \"id\""
        );
        assert_eq!(params, vec![Some("O'Brien".to_string())]);
    }

    #[test]
    fn insert_statement_multi_column_uses_typed_casts_for_each_value() {
        let mut values = HashMap::new();
        values.insert("name".to_string(), Some("Ada".to_string()));
        values.insert("age".to_string(), Some("36".to_string()));
        let mut types = HashMap::new();
        types.insert("name".to_string(), "text".to_string());
        types.insert("age".to_string(), "integer".to_string());
        let (statement, mut params) =
            build_insert_statement("public", "users", &values, &types, &[]).unwrap();
        assert!(statement.contains("\"name\""));
        assert!(statement.contains("\"age\""));
        assert_eq!(statement.matches("::text::text").count(), 1);
        assert_eq!(statement.matches("::text::integer").count(), 1);
        assert!(!statement.contains("RETURNING"));
        params.sort();
        assert_eq!(
            params,
            vec![Some("36".to_string()), Some("Ada".to_string())]
        );
    }

    #[test]
    fn insert_statement_rejects_unknown_column() {
        let mut values = HashMap::new();
        values.insert("missing".to_string(), Some("x".to_string()));
        let result = build_insert_statement(
            "public",
            "users",
            &values,
            &HashMap::new(),
            &[],
        );
        assert!(result.is_err());
    }

    #[test]
    fn insert_statement_without_primary_key_omits_returning() {
        let mut values = HashMap::new();
        values.insert("name".to_string(), Some("Ada".to_string()));
        let mut types = HashMap::new();
        types.insert("name".to_string(), "text".to_string());
        let (statement, _) = build_insert_statement("public", "log", &values, &types, &[]).unwrap();
        assert!(!statement.contains("RETURNING"));
    }

    #[test]
    fn insert_statement_encodes_null_value() {
        let mut values = HashMap::new();
        values.insert("deleted_at".to_string(), None);
        let mut types = HashMap::new();
        types.insert("deleted_at".to_string(), "timestamp".to_string());
        let (statement, params) =
            build_insert_statement("public", "users", &values, &types, &[]).unwrap();
        assert!(statement.contains("$1::text::timestamp"));
        assert_eq!(params, vec![None]);
    }

    #[test]
    fn delete_statement_requires_full_primary_key() {
        let mut keys = HashMap::new();
        keys.insert("id".to_string(), "7".to_string());
        assert!(build_delete_statement(
            "public",
            "users",
            &[("id".to_string(), "integer".to_string()), ("tenant".to_string(), "integer".to_string())],
            &keys,
        )
        .is_err());
    }

    #[test]
    fn delete_statement_quotes_predicates_and_casts() {
        let mut keys = HashMap::new();
        keys.insert("id".to_string(), "7".to_string());
        let (statement, params) = build_delete_statement(
            "public",
            "users",
            &[("id".to_string(), "integer".to_string())],
            &keys,
        )
        .unwrap();
        assert_eq!(
            statement,
            "DELETE FROM \"public\".\"users\" WHERE \"id\" = $1::text::integer"
        );
        assert_eq!(params, vec!["7".to_string()]);
    }
}
