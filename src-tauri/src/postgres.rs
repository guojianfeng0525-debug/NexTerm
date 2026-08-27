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
use std::future::Future;
use std::io::Cursor;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_postgres::{tls::MakeTlsConnect, Client, NoTls, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;
use tokio_util::sync::CancellationToken;

const MAX_QUERY_ROWS: usize = 1_000;
/// Upper bound for `postgres_catalog_search` limits. The SQL-completion
/// default stays at 100; the object navigator passes this cap so full object
/// listings (tables/views/materialized views) are not truncated. Kept in
/// sync with `postgres_catalog::CATALOG_GROUP_LIMIT`.
const CATALOG_SEARCH_LIMIT_MAX: usize = 10_000;
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub(crate) const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Grace period the cancel/timeout path waits for the in-flight query future
/// to settle after a server-side `pg_cancel_backend` (security constraint
/// §4.2.1). Past the grace the connection is torn down instead.
const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
/// Maximum bound parameters accepted by `postgres_execute_parameterized`
/// (security constraint §4.3.1).
const MAX_PARAMETER_COUNT: usize = 256;
/// Maximum size of a single bound parameter value (1 MiB).
const MAX_PARAMETER_VALUE_LEN: usize = 1024 * 1024;
/// Maximum SQL text length for the parameterized command (4 MiB).
const MAX_PARAMETERIZED_SQL_LEN: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct PostgresState {
    clients: RwLock<HashMap<String, Arc<Client>>>,
    /// In-progress transaction markers per connection: `None`/absent = no
    /// transaction, `Some("save")` = a `postgres_save_table_changes` run is in
    /// progress, `Some("manual")` = an explicit `postgres_transaction` begin.
    /// Short critical sections only; guards are never held across `.await`.
    pub(crate) txn_modes: std::sync::RwLock<HashMap<String, String>>,
    /// Backend pid per connection, fetched once at connect time with
    /// `SELECT pg_backend_pid()` so the cancel path can target it.
    backends: std::sync::RwLock<HashMap<String, i32>>,
    /// Connection parameters kept in memory so cancellation can run
    /// `pg_cancel_backend` over an independent connection. Never logged,
    /// never persisted; cleared on disconnect with the client itself.
    cancel_configs: RwLock<HashMap<String, Arc<PostgresConnectRequest>>>,
    /// Cancellation tokens for running long queries, keyed by connection and
    /// then by caller-provided run id. The cancel path only reads this map and
    /// triggers tokens — it never takes any transaction lock.
    running: std::sync::RwLock<HashMap<String, HashMap<u64, CancellationToken>>>,
}

impl PostgresState {
    /// Shared lookup used by the catalog-domain commands in `postgres_catalog.rs`.
    pub(crate) async fn client(
        &self,
        connection_id: &str,
    ) -> Result<Arc<Client>, String> {
        self.clients
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| "PostgreSQL connection is not active".to_string())
    }

    /// Whether the live connection was opened in read-only mode. The flag is
    /// read back from the saved connect request (`cancel_configs`), the same
    /// source the cancel path trusts — never from the frontend.
    pub(crate) async fn is_read_only(&self, connection_id: &str) -> Result<bool, String> {
        let configs = self.cancel_configs.read().await;
        let config = configs
            .get(connection_id)
            .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
        Ok(config.read_only)
    }
}

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Deserialize, Clone)]
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
    /// Optional caller-supplied run id. When present, the query can be
    /// cancelled through `postgres_cancel(connectionId, runId)`.
    #[serde(default)]
    pub run_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresExecuteParameterizedRequest {
    pub connection_id: String,
    pub sql: String,
    /// Bound via extended protocol; `None` = SQL NULL, `Some("")` = empty
    /// string (security §4.3.1 — values are never spliced into the SQL).
    pub params: Vec<Option<String>>,
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

/// One step of a transactional table-data save (M2/M3/M4, security §1.5
/// form B): the whole BEGIN..COMMIT runs inside a single command so no
/// interleaving IPC window exists. The frontend sends every row change as a
/// flat list; each step is validated against the table's live schema.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSaveStep {
    /// "update" | "insert" | "delete".
    pub kind: String,
    /// For update/delete: primary-key values locating the target row.
    #[serde(default)]
    pub key_values: HashMap<String, String>,
    /// For update: column -> new value (None = SQL NULL).
    #[serde(default)]
    pub changes: HashMap<String, Option<String>>,
    /// For insert: column -> value (absent columns keep server DEFAULT).
    #[serde(default)]
    pub values: HashMap<String, Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSaveTableChangesRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    /// Every update/insert/delete to run inside one transaction, in order.
    pub steps: Vec<PostgresSaveStep>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSaveTableChangesResult {
    /// Generated primary-key values per insert step (index-aligned; empty
    /// map when the table has no primary key or the step is not an insert).
    pub insert_primary_keys: Vec<HashMap<String, String>>,
    /// Affected-row count for each update/delete step (1 expected; a 0 or
    /// >1 fails the whole transaction — M3).
    pub affected_rows: Vec<u64>,
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
    // Fetch the backend pid once so `postgres_cancel` can target it later
    // without touching the running query's stream (security constraint
    // §4.2.1: pid must be captured at connect time).
    let pid = client
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .map_err(|error| format!("Failed to read PostgreSQL backend pid: {error}"))?
        .try_get::<_, i32>(0)
        .map_err(|error| format!("Failed to decode PostgreSQL backend pid: {error}"))?;
    {
        let mut clients = state.clients.write().await;
        clients.insert(request.connection_id.clone(), client);
    }
    state
        .cancel_configs
        .write()
        .await
        .insert(request.connection_id.clone(), Arc::new(request.clone()));
    if let Ok(mut backends) = state.backends.write() {
        backends.insert(request.connection_id.clone(), pid);
    }
    if let Ok(mut modes) = state.txn_modes.write() {
        modes.remove(&request.connection_id);
    }
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
    if let Ok(mut backends) = state.backends.write() {
        backends.remove(&connection_id);
    }
    if let Ok(mut modes) = state.txn_modes.write() {
        modes.remove(&connection_id);
    }
    if let Ok(mut running) = state.running.write() {
        // Trigger tokens so any waiting execute future wakes up, then drop
        // the registry entry (disconnect cleanup, security constraint §1.1).
        if let Some(tokens) = running.remove(&connection_id) {
            for (_, token) in tokens {
                token.cancel();
            }
        }
    }
    state.cancel_configs.write().await.remove(&connection_id);
    Ok(())
}

/// Shared helper: cancels the backend over an independent connection and then
/// waits for the query future to settle within `CANCEL_GRACE`. Returns `Ok(
/// ())` when the future settled (cancelled or completed); returns `Err` when
/// the backend did not respond to cancellation, in which case the caller must
/// tear the connection down (security constraint §4.2.1).
async fn cancel_and_settle(
    connection_id: &str,
    token: &CancellationToken,
    future: impl std::future::Future<Output = ()>,
) -> Result<(), String> {
    token.cancel();
    if settle_within_grace(future).await {
        return Ok(());
    }
    Err(format!(
        "PostgreSQL query on connection {connection_id} did not respond to cancellation within the grace period"
    ))
}

/// Races the query-completion future against `CANCEL_GRACE`. `true` = the
/// future settled (query finished or cancelled); `false` = grace expired and
/// the connection must be torn down.
async fn settle_within_grace(future: impl std::future::Future<Output = ()>) -> bool {
    tokio::time::timeout(CANCEL_GRACE, future).await.is_ok()
}

/// Drops a client from the registry so the server sees a disconnect and
/// aborts the in-flight query plus any open transaction (security constraint
/// §3.1 item 3: teardown is the only reliable fallback). `reason` explains
/// the reset in the returned error.
async fn teardown_connection(
    state: &PostgresState,
    connection_id: &str,
    reason: &str,
) -> String {
    state.clients.write().await.remove(connection_id);
    if let Ok(mut backends) = state.backends.write() {
        backends.remove(connection_id);
    }
    if let Ok(mut modes) = state.txn_modes.write() {
        modes.remove(connection_id);
    }
    if let Ok(mut running) = state.running.write() {
        if let Some(tokens) = running.remove(connection_id) {
            for (_, token) in tokens {
                token.cancel();
            }
        }
    }
    state.cancel_configs.write().await.remove(connection_id);
    format!("{reason}; connection reset to clear a stuck query")
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
    let token = register_run(&state, &request.connection_id, request.run_id);
    // The query future is raced against the cancellation token and the
    // 30s timeout. On cancellation the backend gets pg_cancel_backend over
    // an independent connection; if it still does not settle within the
    // grace period the connection is torn down (security constraint §4.2).
    let outcome = {
        let cancel_future = token.clone().cancelled_owned();
        let query_future = client.simple_query(&request.sql);
        tokio::pin!(cancel_future);
        tokio::pin!(query_future);
        let query_task = std::future::poll_fn(|cx| {
            if cancel_future.as_mut().poll(cx).is_ready() {
                return std::task::Poll::Ready(Err(ExecAbort::Cancelled));
            }
            match query_future.as_mut().poll(cx) {
                std::task::Poll::Ready(result) => std::task::Poll::Ready(Ok(result)),
                std::task::Poll::Pending => std::task::Poll::Pending,
            }
        });
        match tokio::time::timeout(QUERY_TIMEOUT, query_task).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err(ExecAbort::Cancelled),
            Err(_) => Err(ExecAbort::Timeout),
        }
    };
    let messages = match outcome {
        Ok(result) => result.map_err(|error| format!("PostgreSQL query failed: {error}"))?,
        Err(ExecAbort::Cancelled) => {
            let reason = "Query cancelled".to_string();
            unregister_run(&state, &request.connection_id, request.run_id);
            match cancel_and_settle(&request.connection_id, &token, std::future::pending()).await
            {
                Ok(()) => return Err(reason),
                Err(reset) => return Err(format!("{reason}; {reset}")),
            }
        }
        Err(ExecAbort::Timeout) => {
            let reason = "PostgreSQL query timed out".to_string();
            unregister_run(&state, &request.connection_id, request.run_id);
            let settled = settle_within_grace(std::future::pending::<()>()).await;
            if settled {
                return Err(reason);
            }
            let reset = teardown_connection(
                &state,
                &request.connection_id,
                "PostgreSQL query timed out and did not respond to cancellation",
            )
            .await;
            return Err(format!("{reason}; {reset}"));
        }
    };
    unregister_run(&state, &request.connection_id, request.run_id);
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

enum ExecAbort {
    Cancelled,
    Timeout,
}

/// Registers a cancellation token for a run so `postgres_cancel` can trigger
/// it. Returns the token (a fresh one when `run_id` is `None`, still returned
/// so the caller can race on it uniformly).
fn register_run(
    state: &PostgresState,
    connection_id: &str,
    run_id: Option<u64>,
) -> CancellationToken {
    let token = CancellationToken::new();
    if let Some(run_id) = run_id {
        if let Ok(mut running) = state.running.write() {
            running
                .entry(connection_id.to_string())
                .or_default()
                .insert(run_id, token.clone());
        }
    }
    token
}

/// Removes the run registration when the command finishes (success, error,
/// cancel, or timeout). Never panics on a missing entry.
fn unregister_run(state: &PostgresState, connection_id: &str, run_id: Option<u64>) {
    if let Some(run_id) = run_id {
        if let Ok(mut running) = state.running.write() {
            if let Some(tokens) = running.get_mut(connection_id) {
                tokens.remove(&run_id);
                if tokens.is_empty() {
                    running.remove(connection_id);
                }
            }
        }
    }
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
    // A table-save is mid-flight on this connection: a manual BEGIN would
    // nest into it and poison the save transaction (security §1.2 / §3).
    if request.action == "begin" {
        let modes = state
            .txn_modes
            .read()
            .map_err(|_| "Failed to read transaction state".to_string())?;
        if modes.get(&request.connection_id).map(String::as_str) == Some("save") {
            return Err("A table-save transaction is in progress; wait for it to finish before beginning a manual transaction".into());
        }
    }
    tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute(statement))
        .await
        .map_err(|_| "PostgreSQL transaction action timed out")?
        .map_err(|error| format!("PostgreSQL transaction action failed: {error}"))?;
    // Keep the in-memory transaction marker in sync so `postgres_save_table_changes`
    // can detect an open manual transaction without a DB-side status query.
    if let Ok(mut modes) = state.txn_modes.write() {
        match request.action.as_str() {
            "begin" => {
                modes.insert(request.connection_id.clone(), "manual".into());
            }
            _ => {
                modes.remove(&request.connection_id);
            }
        }
    }
    Ok(())
}

pub(crate) fn quote_identifier(value: &str) -> String {
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
                .map(|(key, _)| format!("{}::text", quote_identifier(key)))
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
pub(crate) fn single_statement(sql: &str) -> Result<&str, String> {
    let mut quote = None;
    let mut line_comment = false;
    let mut block_depth = 0usize;
    let mut dollar_tag: Option<&[u8]> = None;
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
        if let Some(tag) = dollar_tag {
            // Closing sequence is `$tag$`: the current byte must be `$`,
            // followed by the exact tag text, then another `$`.
            if *byte == b'$'
                && bytes[index + 1..].starts_with(tag)
                && bytes.get(index + 1 + tag.len()) == Some(&b'$')
            {
                dollar_tag = None;
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
            b'$' => {
                // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty).
                let tag_end = bytes[index + 1..]
                    .iter()
                    .position(|b| *b == b'$')
                    .map(|pos| index + 1 + pos);
                if let Some(tag_end) = tag_end {
                    let tag = &bytes[index + 1..tag_end];
                    if tag.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_') {
                        dollar_tag = Some(tag);
                        continue;
                    }
                }
            }
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

/// Returns the byte offset of the first non-noise character at/after `from`:
/// skips whitespace, line comments, and nested block comments. Used to trim
/// leading commentary off a statement range so `; SELECT` inside a leading
/// comment never becomes part of the statement text.
fn skip_leading_noise(sql: &str, from: usize) -> usize {
    let bytes = sql.as_bytes();
    let mut index = from;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        match (byte, next) {
            (b' ', _) | (b'\t', _) | (b'\n', _) | (b'\r', _) => index += 1,
            (b'-', Some(b'-')) => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            (b'/', Some(b'*')) => {
                let mut depth = 1usize;
                index += 2;
                while index < bytes.len() && depth > 0 {
                    let b = bytes[index];
                    let n = bytes.get(index + 1).copied();
                    match (b, n) {
                        (b'/', Some(b'*')) => {
                            depth += 1;
                            index += 2;
                        }
                        (b'*', Some(b'/')) => {
                            depth -= 1;
                            index += 2;
                        }
                        _ => index += 1,
                    }
                }
            }
            _ => break,
        }
    }
    index
}

/// Splits SQL text into statement byte ranges, honouring string literals,
/// single/double quotes, line comments, nested block comments, and
/// dollar-quoted strings (`$tag$ ... $tag$`). Leading noise (whitespace /
/// comments) and the trailing semicolon are excluded from each range. Returns
/// byte offsets (not UTF-16), so callers that feed a text editor must convert
/// (security §4.1: a semicolon inside a comment/string/dollar-quote must
/// never split the text).
fn split_sql_statements(sql: &str) -> Vec<(usize, usize)> {
    let mut statements = Vec::new();
    let mut cut = 0usize; // byte offset just after the previous `;`
    let mut quote: Option<u8> = None;
    let mut line_comment = false;
    let mut block_depth = 0usize;
    let mut dollar_tag: Option<&[u8]> = None;
    let bytes = sql.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_depth > 0 {
            if byte == b'/' && next == Some(b'*') {
                block_depth += 1;
                index += 2;
                continue;
            }
            if byte == b'*' && next == Some(b'/') {
                block_depth -= 1;
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(tag) = dollar_tag {
            // Closing sequence is `$tag$`: current byte `$` + exact tag + `$`.
            if byte == b'$'
                && bytes[index + 1..].starts_with(tag)
                && bytes.get(index + 1 + tag.len()) == Some(&b'$')
            {
                dollar_tag = None;
                index += 1 + tag.len() + 1;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(delimiter) = quote {
            if byte == delimiter {
                if delimiter == b'\'' && next == Some(b'\'') {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        match byte {
            b'-' if next == Some(b'-') => {
                line_comment = true;
                index += 2;
            }
            b'/' if next == Some(b'*') => {
                block_depth = 1;
                index += 2;
            }
            b'\'' | b'"' => {
                quote = Some(byte);
                index += 1;
            }
            b'$' => {
                let tag_end = bytes[index + 1..]
                    .iter()
                    .position(|b| *b == b'$')
                    .map(|pos| index + 1 + pos);
                if let Some(tag_end) = tag_end {
                    let tag = &bytes[index + 1..tag_end];
                    if tag.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_') {
                        dollar_tag = Some(tag);
                        index = tag_end + 1;
                        continue;
                    }
                }
                index += 1;
            }
            b';' => {
                let start = skip_leading_noise(sql, cut);
                let mut end = index;
                while end > start && sql.as_bytes()[end - 1].is_ascii_whitespace() {
                    end -= 1;
                }
                if start < end {
                    statements.push((start, end));
                }
                cut = index + 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    let start = skip_leading_noise(sql, cut);
    let mut end = sql.len();
    while end > start && sql.as_bytes()[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    if start < end {
        statements.push((start, end));
    }
    statements
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

/// M4: actively ROLLBACK after any save failure, and never swallow a failed
/// ROLLBACK — a stuck transaction would hold locks forever (security §3).
/// Returns the final error message to surface to the user.
async fn rollback_save(client: &Client, root: String) -> String {
    let rb = tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute("ROLLBACK")).await;
    match rb {
        Ok(Ok(_)) => root,
        Ok(Err(rb_err)) => format!(
            "{root}; ROLLBACK also failed: {rb_err} (connection should be reset)"
        ),
        Err(_) => format!("{root}; ROLLBACK timed out (connection should be reset)"),
    }
}

/// Clears the save-transaction marker on every exit path of
/// `postgres_save_table_changes` (successful COMMIT or rolled-back failure).
fn clear_save_marker(state: &PostgresState, connection_id: &str) {
    if let Ok(mut modes) = state.txn_modes.write() {
        if modes.get(connection_id).map(String::as_str) == Some("save") {
            modes.remove(connection_id);
        }
    }
}

#[tauri::command]
pub async fn postgres_save_table_changes(
    request: PostgresSaveTableChangesRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresSaveTableChangesResult, String> {
    if request.schema.trim().is_empty()
        || request.table.trim().is_empty()
        || request.steps.is_empty()
    {
        return Err("Schema, table, and at least one change are required".into());
    }
    let client = state
        .clients
        .read()
        .await
        .get(&request.connection_id)
        .cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    // Fail fast when a manual transaction is open: the save would silently
    // join it instead of owning its own transaction (security §1.2 / §3).
    // The authoritative source is the in-memory txn_modes marker, which
    // `postgres_transaction` maintains (a DB-side `SHOW transaction_status`
    // does not exist as a GUC and always errors).
    {
        let modes = state
            .txn_modes
            .read()
            .map_err(|_| "Failed to read transaction state".to_string())?;
        if modes.get(&request.connection_id).map(String::as_str) == Some("manual") {
            return Err(
                "A transaction is already in progress on this connection; commit or roll it back before saving".into(),
            );
        }
    }
    // Mark the connection as inside the save transaction so a concurrent
    // `postgres_transaction begin` cannot interleave (defense in depth).
    {
        let mut modes = state
            .txn_modes
            .write()
            .map_err(|_| "Failed to lock transaction state".to_string())?;
        modes.insert(request.connection_id.clone(), "save".into());
    }
    // Load schema once; every step reuses these whitelists.
    let column_types = load_column_types(&client, &request.schema, &request.table).await?;
    let primary_keys = load_primary_keys(&client, &request.schema, &request.table).await?;
    // M2: transaction markers and BEGIN..COMMIT stay inside this single
    // command, so no other IPC can interleave into the save transaction.
    let begin = tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute("BEGIN"))
        .await
        .map_err(|_| "PostgreSQL save timed out while starting the transaction")?
        .map_err(|error| format!("Failed to begin save transaction: {error}"))?;
    drop(begin);
    let mut insert_primary_keys = Vec::new();
    let mut affected_rows = Vec::new();
    for (index, step) in request.steps.iter().enumerate() {
        let outcome = match step.kind.as_str() {
            "update" => {
                if step.changes.is_empty() {
                    Err(format!("Save step {index}: update requires at least one changed value"))
                } else if primary_keys.is_empty()
                    || primary_keys
                        .iter()
                        .any(|(key, _)| !step.key_values.contains_key(key))
                {
                    Err(format!(
                        "Save step {index}: this table has no usable primary key for a safe update"
                    ))
                } else {
                    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Send + Sync>> =
                        Vec::new();
                    let mut assignments = Vec::new();
                    for (column, value) in &step.changes {
                        let data_type = column_types
                            .get(column)
                            .ok_or_else(|| format!("Save step {index}: unknown column {column}"))?;
                        values.push(match value {
                            Some(text) => Box::new(text.clone()),
                            None => Box::new(None::<String>),
                        });
                        assignments.push(format!(
                            "{} = ${}::text::{}",
                            quote_identifier(column),
                            values.len(),
                            data_type
                        ));
                    }
                    // Primary-key columns are immutable: they never appear in
                    // SET assignments (a change to them is rejected above via
                    // the frontend's keyNames filter) and are used only as
                    // WHERE predicates keyed by the already-bound change values.
                    let mut predicates = Vec::new();
                    for (key, data_type) in &primary_keys {
                        let key_value = step.key_values.get(key).ok_or_else(|| {
                            format!("Save step {index}: missing primary key value for {key}")
                        })?;
                        values.push(Box::new(key_value.clone()));
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
                    let row_count = tokio::time::timeout(
                        QUERY_TIMEOUT,
                        client.execute(&statement, &params),
                    )
                    .await
                    .map_err(|_| "PostgreSQL save timed out on an UPDATE")?
                    .map_err(|error| format!("Failed to update table row: {error}"))?;
                    // M3: affected-row validation — a concurrent delete/change
                    // must not silently lose this edit.
                    if row_count != 1 {
                        clear_save_marker(&state, &request.connection_id);
                        return Err(rollback_save(
                            &client,
                            format!(
                                "Save step {index}: expected exactly 1 row to update but affected {row_count}"
                            ),
                        )
                        .await);
                    }
                    Ok(row_count)
                }
            }
            "insert" => {
                if step.values.is_empty() {
                    Err(format!("Save step {index}: insert requires at least one column value"))
                } else {
                    let (statement, params) = build_insert_statement(
                        &request.schema,
                        &request.table,
                        &step.values,
                        &column_types,
                        &primary_keys,
                    )
                    .map_err(|error| format!("Save step {index}: {error}"))?;
                    let param_refs: Vec<Option<&str>> =
                        params.iter().map(|value| value.as_deref()).collect();
                    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = param_refs
                        .iter()
                        .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
                        .collect();
                    if primary_keys.is_empty() {
                        let row_count = tokio::time::timeout(
                            QUERY_TIMEOUT,
                            client.execute(&statement, &param_refs),
                        )
                        .await
                        .map_err(|_| "PostgreSQL save timed out on an INSERT")?
                        .map_err(|error| format!("Failed to insert table row: {error}"))?;
                        insert_primary_keys.push(HashMap::new());
                        Ok(row_count)
                    } else {
                        let row = tokio::time::timeout(
                            QUERY_TIMEOUT,
                            client.query_one(&statement, &param_refs),
                        )
                        .await
                        .map_err(|_| "PostgreSQL save timed out on an INSERT")?
                        .map_err(|error| format!("Failed to insert table row: {error}"))?;
                        let mut pk_map = HashMap::new();
                        for (key, _) in &primary_keys {
                            if let Ok(value) = row.try_get::<_, String>(0) {
                                pk_map.insert(key.clone(), value);
                            }
                        }
                        insert_primary_keys.push(pk_map);
                        Ok(1)
                    }
                }
            }
            "delete" => {
                if primary_keys.is_empty()
                    || primary_keys
                        .iter()
                        .any(|(key, _)| !step.key_values.contains_key(key))
                {
                    Err(format!(
                        "Save step {index}: this table has no usable primary key for a safe delete"
                    ))
                } else {
                    let (statement, params) = build_delete_statement(
                        &request.schema,
                        &request.table,
                        &primary_keys,
                        &step.key_values,
                    )
                    .map_err(|error| format!("Save step {index}: {error}"))?;
                    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
                        .iter()
                        .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
                        .collect();
                    let row_count = tokio::time::timeout(
                        QUERY_TIMEOUT,
                        client.execute(&statement, &param_refs),
                    )
                    .await
                    .map_err(|_| "PostgreSQL save timed out on a DELETE")?
                    .map_err(|error| format!("Failed to delete table row: {error}"))?;
                    if row_count != 1 {
                        clear_save_marker(&state, &request.connection_id);
                        return Err(rollback_save(
                            &client,
                            format!(
                                "Save step {index}: expected exactly 1 row to delete but affected {row_count}"
                            ),
                        )
                        .await);
                    }
                    Ok(row_count)
                }
            }
            other => Err(format!("Save step {index}: unknown operation {other}")),
        };
        match outcome {
            Ok(row_count) => affected_rows.push(row_count),
            Err(error) => {
                clear_save_marker(&state, &request.connection_id);
                return Err(rollback_save(&client, error).await);
            }
        }
    }
    let commit = tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute("COMMIT"))
        .await
        .map_err(|_| "PostgreSQL save timed out while committing")?
        .map_err(|error| format!("Failed to commit save transaction: {error}"))?;
    drop(commit);
    clear_save_marker(&state, &request.connection_id);
    Ok(PostgresSaveTableChangesResult {
        insert_primary_keys,
        affected_rows,
    })
}

#[tauri::command]
pub async fn postgres_cancel(
    connection_id: String,
    state: tauri::State<'_, PostgresState>,
) -> Result<(), String> {
    // Idempotent: cancelling a connection with no running query is a no-op
    // success (security §4.2.2). The cancel path never takes txn locks.
    // The running command's own cancel branch settles the query future
    // (cancel_and_settle -> teardown fallback); this command only triggers
    // the token and best-effort server-side pg_cancel_backend.
    let token = {
        let running = match state.running.read() {
            Ok(guard) => guard,
            Err(_) => return Ok(()),
        };
        running
            .get(&connection_id)
            .and_then(|runs| runs.values().next())
            .cloned()
    };
    let Some(token) = token else {
        return Ok(());
    };
    token.cancel();
    // cancel-first: send pg_cancel_backend over a short independent
    // connection so the in-flight query is aborted server-side. Failure to
    // open the cancel connection falls through — the running command's
    // teardown fallback still guarantees the query cannot outlive the UI.
    let pid = match state.backends.read() {
        Ok(guard) => guard.get(&connection_id).copied(),
        Err(_) => None,
    };
    let config = state
        .cancel_configs
        .read()
        .await
        .get(&connection_id)
        .cloned();
    if let (Some(pid), Some(config)) = (pid, config) {
        if let Ok(cancel_client) = open_client(&config).await {
            let _ = tokio::time::timeout(
                QUERY_TIMEOUT,
                cancel_client.execute("SELECT pg_cancel_backend($1)", &[&pid]),
            )
            .await;
        }
    }
    Ok(())
}

/// Validates a parameterized-query request against the security bounds
/// (security §4.3.1): SQL text <= 4 MiB, <= 256 bound parameters, each
/// value <= 1 MiB. Pure function so the bounds are unit-testable without a
/// live PostgreSQL client.
fn validate_parameterized_request(
    sql: &str,
    params: &[Option<String>],
) -> Result<(), String> {
    if sql.trim().is_empty() {
        return Err("SQL cannot be empty".into());
    }
    if sql.len() > MAX_PARAMETERIZED_SQL_LEN {
        return Err("SQL text exceeds the maximum length".into());
    }
    if params.len() > MAX_PARAMETER_COUNT {
        return Err(format!(
            "Too many bound parameters (max {MAX_PARAMETER_COUNT})"
        ));
    }
    for value in params {
        if let Some(text) = value {
            if text.len() > MAX_PARAMETER_VALUE_LEN {
                return Err("A bound parameter exceeds the maximum length".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn postgres_execute_parameterized(
    request: PostgresExecuteParameterizedRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresQueryResult, String> {
    validate_parameterized_request(&request.sql, &request.params)?;
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
    // Extended protocol: every value is bound as a parameter with an
    // UNKNOWN (inferred) type. None = SQL NULL; Some("") = empty string.
    // Parameter values never appear in logs or error text.
    let param_refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = request
        .params
        .iter()
        .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let rows = tokio::time::timeout(QUERY_TIMEOUT, client.query(&request.sql, &param_refs))
        .await
        .map_err(|_| "PostgreSQL parameterized query timed out")?
        .map_err(|error| format!("PostgreSQL query failed: {error}"))?;
    let mut columns = Vec::new();
    let mut data = Vec::new();
    let mut truncated = false;
    for (index, row) in rows.into_iter().enumerate() {
        if columns.is_empty() {
            columns = row
                .columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect();
        }
        if data.len() < limit {
            data.push(
                (0..row.len())
                    .map(|col| row.try_get::<_, Option<String>>(col).ok().flatten())
                    .collect(),
            );
        } else {
            truncated = true;
        }
        if index > limit {
            break;
        }
    }
    Ok(PostgresQueryResult {
        columns,
        rows: data,
        command_tags: Vec::new(),
        truncated,
    })
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
    // Completion defaults to 100 matches; the navigator passes a larger
    // explicit limit so full object listings are never truncated.
    let limit = request.limit.unwrap_or(100).clamp(1, CATALOG_SEARCH_LIMIT_MAX) as i64;
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
        build_where_clause, fingerprint_matches, single_statement, skip_leading_noise,
        split_sql_statements, validate_parameterized_request, PostgresFilterCondition,
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
            "INSERT INTO \"public\".\"users\" (\"name\") VALUES ($1::text::text) RETURNING \"id\"::text"
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

    // ---- B19: split_sql_statements (security §4.1) ----

    #[test]
    fn split_statements_honours_semicolons_in_strings_and_comments() {
        // Semicolons inside a string literal, a line comment, and a block
        // comment must never split the text (security §4.1).
        let sql = "SELECT 'a;b' AS v; -- comment; with semicolon\nSELECT 2; /* block; comment */ SELECT 3";
        let ranges = split_sql_statements(sql);
        assert_eq!(ranges.len(), 3);
        assert_eq!(&sql[ranges[0].0..ranges[0].1], "SELECT 'a;b' AS v");
        assert_eq!(&sql[ranges[1].0..ranges[1].1], "SELECT 2");
        assert_eq!(&sql[ranges[2].0..ranges[2].1], "SELECT 3");
    }

    #[test]
    fn split_statements_handles_nested_block_comments() {
        // Nested comments: only the outermost close ends the comment, so the
        // semicolon after it is a real boundary. The trailing comment after
        // `SELECT 1` is part of that statement's range (harmless to execute).
        let sql = "SELECT 1 /* outer /* inner */ still outer */; SELECT 2";
        let ranges = split_sql_statements(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].0..ranges[0].1], "SELECT 1 /* outer /* inner */ still outer */");
        assert_eq!(&sql[ranges[1].0..ranges[1].1], "SELECT 2");
    }

    #[test]
    fn split_statements_handles_dollar_quoting() {
        // Dollar-quoted bodies may contain semicolons and quotes that must be
        // treated as literal text, not statement boundaries.
        let sql = "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN; EXECUTE 'x;y'; END; $fn$ LANGUAGE plpgsql; SELECT 1";
        let ranges = split_sql_statements(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].0..ranges[0].1], "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN; EXECUTE 'x;y'; END; $fn$ LANGUAGE plpgsql");
        assert_eq!(&sql[ranges[1].0..ranges[1].1], "SELECT 1");
    }

    #[test]
    fn split_statements_tracks_byte_offsets_after_multibyte() {
        // UTF-16 (editor) offsets differ from byte offsets after multi-byte
        // characters; the splitter must report byte offsets (security §4.1
        // conversion trap).
        let sql = "SELECT '中文;分号' AS v; SELECT 2";
        let ranges = split_sql_statements(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].0..ranges[0].1], "SELECT '中文;分号' AS v");
        assert_eq!(&sql[ranges[1].0..ranges[1].1], "SELECT 2");
        // The second statement starts strictly after the first range end.
        assert!(ranges[1].0 > ranges[0].1);
    }

    #[test]
    fn split_statements_skips_trailing_whitespace_gaps() {
        let sql = "SELECT 1   ;   \n\t SELECT 2";
        let ranges = split_sql_statements(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].0..ranges[0].1], "SELECT 1");
        assert_eq!(&sql[ranges[1].0..ranges[1].1], "SELECT 2");
    }

    #[test]
    fn split_statements_empty_and_comment_only() {
        assert!(split_sql_statements("").is_empty());
        assert!(split_sql_statements("  \n\t ").is_empty());
        assert!(split_sql_statements("-- just a comment\n/* another */").is_empty());
    }

    // ---- B19: single_statement regression (bracket/quotes kept intact) ----

    #[test]
    fn single_statement_accepts_one_statement_with_dollar_quote() {
        let sql = "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN; END; $fn$ LANGUAGE plpgsql";
        let statement = single_statement(sql).unwrap();
        assert_eq!(statement, sql.trim());
    }

    #[test]
    fn single_statement_rejects_batch() {
        assert!(single_statement("SELECT 1; SELECT 2").is_err());
    }

    // ---- B19: parameterized-request security bounds (security §4.3.1) ----

    #[test]
    fn parameterized_accepts_valid_request() {
        assert!(validate_parameterized_request("SELECT $1", &[Some("x".into())]).is_ok());
        assert!(validate_parameterized_request("SELECT $1", &[None]).is_ok());
        assert!(validate_parameterized_request("SELECT 1", &[]).is_ok());
    }

    #[test]
    fn parameterized_rejects_empty_sql() {
        assert!(validate_parameterized_request("   ", &[]).is_err());
        assert!(validate_parameterized_request("", &[]).is_err());
    }

    #[test]
    fn parameterized_rejects_too_many_params() {
        let params: Vec<Option<String>> = vec![Some("x".into()); 257];
        assert!(validate_parameterized_request("SELECT $1", &params).is_err());
    }

    #[test]
    fn parameterized_rejects_oversized_value_and_sql() {
        let big: String = "x".repeat(1024 * 1024 + 1);
        assert!(validate_parameterized_request("SELECT $1", &[Some(big)]).is_err());
        let huge_sql: String = "x".repeat(4 * 1024 * 1024 + 1);
        assert!(validate_parameterized_request(&huge_sql, &[]).is_err());
    }

    #[test]
    fn parameterized_distinguishes_none_from_empty() {
        // Both pass the validator; the semantic difference (NULL vs '') is
        // enforced by the extended-protocol binding, not by this validator.
        assert!(validate_parameterized_request("SELECT $1", &[None]).is_ok());
        assert!(validate_parameterized_request("SELECT $1", &[Some("".into())]).is_ok());
    }
}
