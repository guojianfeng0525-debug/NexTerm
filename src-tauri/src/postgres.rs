//! Native PostgreSQL session management. The command boundary is deliberately
//! narrow: configuration stays on the frontend, while live clients and query
//! results remain in backend memory.

use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use russh::{client, keys::{PublicKeyBase64, PublicKey}, Preferred};
use sha2_10::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage, tls::MakeTlsConnect};
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
pub struct PostgresTableDataRequest {
    pub connection_id: String,
    pub schema: String,
    pub table: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresTableDataResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub primary_key_columns: Vec<String>,
    pub nullable_columns: Vec<String>,
    pub truncated: bool,
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
    pub trusted: bool,
}

struct FingerprintClient {
    expected: Option<String>,
    observed: Arc<std::sync::Mutex<Option<String>>>,
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
        Ok(self.expected.as_ref().is_none_or(|expected| expected == &fingerprint))
    }
}

async fn open_verified_jump(request: &PostgresConnectRequest, ssh: &PostgresSshConfig) -> Result<(russh::ChannelStream<client::Msg>, client::Handle<FingerprintClient>), String> {
    if ssh.host.trim().is_empty() || ssh.username.trim().is_empty() {
        return Err("SSH host and username are required".into());
    }
    let observed = Arc::new(std::sync::Mutex::new(None));
    let handler = FingerprintClient { expected: ssh.host_key_fingerprint.clone().filter(|value| !value.trim().is_empty()), observed };
    let config = Arc::new(client::Config {
        preferred: Preferred { key: std::borrow::Cow::Borrowed(crate::ssh::PREFERRED_HOST_KEY_ALGOS), ..Preferred::DEFAULT },
        nodelay: true,
        ..client::Config::default()
    });
    let mut session = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (&ssh.host[..], ssh.port), handler))
        .await.map_err(|_| "SSH jump connection timed out")?
        .map_err(|_| "SSH host key fingerprint changed. Refusing to connect.".to_string())?;
    let authenticated = match ssh.auth_method.as_str() {
        "password" => session.authenticate_password(&ssh.username, ssh.password.as_deref().ok_or_else(|| "SSH password is required".to_string())?)
            .await.map_err(|error| format!("SSH password authentication failed: {error}"))?.success(),
        "privateKey" => {
            let key = if let Some(private_key) = ssh.private_key.as_deref().filter(|value| !value.is_empty()) {
                russh::keys::decode_secret_key(private_key, ssh.private_key_passphrase.as_deref())
                    .map_err(|error| format!("Unable to decode SSH private key: {error}"))?
            } else {
                crate::ssh::load_private_key(
                    ssh.private_key_path.as_deref().ok_or_else(|| "Saved SSH private-key path is required".to_string())?,
                    ssh.private_key_passphrase.as_deref(),
                ).map_err(|error| format!("Unable to load SSH private key: {error}"))?
            };
            session.authenticate_publickey(&ssh.username, russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), Some(russh::keys::HashAlg::Sha256)))
                .await.map_err(|error| format!("SSH private-key authentication failed: {error}"))?.success()
        }
        _ => return Err("Unsupported SSH authentication method".into()),
    };
    if !authenticated {
        return Err("SSH jump authentication failed".into());
    }
    let channel = tokio::time::timeout(CONNECT_TIMEOUT, session.channel_open_direct_tcpip(&request.host, request.port as u32, "127.0.0.1", 0))
        .await.map_err(|_| "Timed out opening SSH channel to PostgreSQL" )?
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
    if request.connection_id.trim().is_empty() || request.host.trim().is_empty() || request.database.trim().is_empty() || request.username.trim().is_empty() {
        return Err("Connection name, host, database, and username are required".into());
    }
    let mut config = tokio_postgres::Config::new();
    config.host(&request.host).port(request.port).dbname(&request.database).user(&request.username);
    if let Some(password) = &request.password {
        config.password(password);
    }
    Ok(config)
}

fn certificates(pem: &str, field: &str) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    rustls_pemfile::certs(&mut Cursor::new(pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid {field} PEM certificate: {error}"))
}

fn tls_connector(request: &PostgresConnectRequest) -> Result<MakeRustlsConnect, String> {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(pem) = request.ssl_root_cert.as_deref().filter(|value| !value.trim().is_empty()) {
        for certificate in certificates(pem, "CA")? {
            roots.add(certificate).map_err(|error| format!("Invalid CA certificate: {error}"))?;
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
    let config = match (request.ssl_client_cert.as_deref(), request.ssl_client_key.as_deref()) {
        (Some(cert), Some(key)) if !cert.trim().is_empty() && !key.trim().is_empty() => {
            let certificates = certificates(cert, "client")?;
            let key = rustls_pemfile::private_key(&mut Cursor::new(key.as_bytes()))
                .map_err(|error| format!("Invalid client private key: {error}"))?
                .ok_or_else(|| "Client private key PEM does not contain a supported key".to_string())?;
            rustls::ClientConfig::builder().with_root_certificates(roots).with_client_auth_cert(certificates, key)
                .map_err(|error| format!("Invalid client TLS identity: {error}"))?
        }
        (None, None) | (Some(""), None) | (None, Some("")) | (Some(""), Some("")) => {
            rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth()
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
            let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, config.connect_raw(stream, NoTls))
                .await.map_err(|_| "PostgreSQL connection through SSH timed out")?
                .map_err(|error| format!("PostgreSQL connection through SSH failed: {error}"))?;
            tauri::async_runtime::spawn(async move {
                let _jump_session = session;
                if let Err(error) = connection.await { tracing::warn!("PostgreSQL SSH connection ended: {error}"); }
            });
            client
        } else {
            let mut connector = tls_connector(request)?;
            let tls = <MakeRustlsConnect as MakeTlsConnect<russh::ChannelStream<client::Msg>>>::make_tls_connect(&mut connector, &request.host)
                .map_err(|error| format!("Unable to configure PostgreSQL TLS: {error}"))?;
            let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, config.connect_raw(stream, tls))
                .await.map_err(|_| "PostgreSQL TLS connection through SSH timed out")?
                .map_err(|error| format!("PostgreSQL TLS connection through SSH failed: {error}"))?;
            tauri::async_runtime::spawn(async move {
                let _jump_session = session;
                if let Err(error) = connection.await { tracing::warn!("PostgreSQL TLS SSH connection ended: {error}"); }
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
        let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, config.connect(tls_connector(request)?))
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
    state.clients.write().await.insert(request.connection_id.clone(), client);
    Ok(PostgresConnectionStatus { connection_id: request.connection_id, connected: true, database: request.database, server_version })
}

#[tauri::command]
pub async fn postgres_disconnect(connection_id: String, state: tauri::State<'_, PostgresState>) -> Result<(), String> {
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
    let client = state.clients.read().await.get(&request.connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let limit = request.max_rows.unwrap_or(MAX_QUERY_ROWS).clamp(1, MAX_QUERY_ROWS);
    let messages = tokio::time::timeout(QUERY_TIMEOUT, client.simple_query(&request.sql)).await
        .map_err(|_| "PostgreSQL query timed out" )?
        .map_err(|error| format!("PostgreSQL query failed: {error}"))?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut command_tags = Vec::new();
    let mut truncated = false;
    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|column| column.name().to_string()).collect();
                }
                if rows.len() < limit {
                    rows.push((0..row.len()).map(|index| row.get(index).map(str::to_owned)).collect());
                } else {
                    truncated = true;
                }
            }
            SimpleQueryMessage::CommandComplete(count) => command_tags.push(count.to_string()),
            _ => {}
        }
    }
    Ok(PostgresQueryResult { columns, rows, command_tags, truncated })
}

#[tauri::command]
pub async fn postgres_explain(
    request: PostgresExecuteRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresQueryResult, String> {
    let sql = single_statement(&request.sql)?;
    let client = state.clients.read().await.get(&request.connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let messages = tokio::time::timeout(QUERY_TIMEOUT, client.simple_query(&format!("EXPLAIN {sql}"))).await
        .map_err(|_| "PostgreSQL EXPLAIN timed out")?
        .map_err(|error| format!("PostgreSQL EXPLAIN failed: {error}"))?;
    let mut rows = Vec::new();
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            rows.push((0..row.len()).map(|index| row.get(index).map(str::to_owned)).collect());
        }
    }
    Ok(PostgresQueryResult { columns: vec!["QUERY PLAN".into()], rows, command_tags: Vec::new(), truncated: false })
}

#[tauri::command]
pub async fn postgres_transaction(
    request: PostgresTransactionRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<(), String> {
    let client = state.clients.read().await.get(&request.connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let statement = match request.action.as_str() {
        "begin" => "BEGIN",
        "commit" => "COMMIT",
        "rollback" => "ROLLBACK",
        _ => return Err("Unsupported PostgreSQL transaction action".into()),
    };
    tokio::time::timeout(QUERY_TIMEOUT, client.batch_execute(statement)).await
        .map_err(|_| "PostgreSQL transaction action timed out")?
        .map_err(|error| format!("PostgreSQL transaction action failed: {error}"))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
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
            if *byte == b'\n' { line_comment = false; }
            continue;
        }
        if block_depth > 0 {
            if *byte == b'/' && next == Some(b'*') { block_depth += 1; }
            if *byte == b'*' && next == Some(b'/') { block_depth -= 1; }
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
    if statement.is_empty() { Err("SQL cannot be empty".into()) } else { Ok(statement) }
}

#[tauri::command]
pub async fn postgres_table_data(
    request: PostgresTableDataRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<PostgresTableDataResult, String> {
    if request.schema.trim().is_empty() || request.table.trim().is_empty() {
        return Err("Schema and table are required".into());
    }
    let client = state.clients.read().await.get(&request.connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let limit = request.limit.unwrap_or(100).clamp(1, 1_000);
    let offset = request.offset.unwrap_or(0);
    let relation = format!("{}.{}", quote_identifier(&request.schema), quote_identifier(&request.table));
    let key_rows = client.query(
        "SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table primary key: {error}"))?;
    let primary_key_columns: Vec<String> = key_rows.into_iter().filter_map(|row| row.try_get::<_, String>(0).ok()).collect();
    let nullable_rows = client.query(
        "SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull ORDER BY a.attnum",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table nullability: {error}"))?;
    let nullable_columns: Vec<String> = nullable_rows.into_iter().filter_map(|row| row.try_get::<_, String>(0).ok()).collect();
    // A stable order is required for reliable paging. Tables without a primary
    // key remain browseable but cannot promise stable page boundaries.
    let order = if primary_key_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", primary_key_columns.iter().map(|column| quote_identifier(column)).collect::<Vec<_>>().join(", "))
    };
    // The identifiers are quoted locally and all numeric controls are bounded.
    // This endpoint is intentionally limited to a single relation, not arbitrary SQL.
    let messages = client.simple_query(&format!("SELECT * FROM {relation}{order} LIMIT {limit} OFFSET {offset}")).await
        .map_err(|error| format!("Failed to load table data: {error}"))?;
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            if columns.is_empty() { columns = row.columns().iter().map(|column| column.name().to_string()).collect(); }
            rows.push((0..row.len()).map(|index| row.get(index).map(str::to_owned)).collect());
        }
    }
    Ok(PostgresTableDataResult { columns, truncated: rows.len() == limit, rows, primary_key_columns, nullable_columns })
}

#[tauri::command]
pub async fn postgres_table_update(
    request: PostgresTableUpdateRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<u64, String> {
    if request.schema.trim().is_empty() || request.table.trim().is_empty() || request.changes.is_empty() {
        return Err("Schema, table, and at least one changed value are required".into());
    }
    let client = state.clients.read().await.get(&request.connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let key_rows = client.query(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2 ORDER BY k.ord",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to validate table primary key: {error}"))?;
    let keys: Vec<(String, String)> = key_rows.into_iter().map(|row| {
        Ok((
            row.try_get(0).map_err(|error| format!("Failed to decode primary key: {error}"))?,
            row.try_get(1).map_err(|error| format!("Failed to decode primary key type: {error}"))?,
        ))
    }).collect::<Result<_, String>>()?;
    if keys.is_empty() || keys.iter().any(|(key, _)| !request.key_values.contains_key(key)) {
        return Err("This table has no usable primary key for a safe update".into());
    }
    let column_rows = client.query(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
        &[&request.schema, &request.table],
    ).await.map_err(|error| format!("Failed to load table column types: {error}"))?;
    let column_types: HashMap<String, String> = column_rows.into_iter().map(|row| {
        Ok((
            row.try_get(0).map_err(|error| format!("Failed to decode table column: {error}"))?,
            row.try_get(1).map_err(|error| format!("Failed to decode table column type: {error}"))?,
        ))
    }).collect::<Result<_, String>>()?;
    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Send + Sync>> = Vec::new();
    let mut assignments = Vec::new();
    for (column, value) in &request.changes {
        let data_type = column_types.get(column).ok_or_else(|| format!("Unknown table column: {column}"))?;
        values.push(Box::new(value.clone()));
        assignments.push(format!("{} = ${}::text::{}", quote_identifier(column), values.len(), data_type));
    }
    let mut predicates = Vec::new();
    for (key, data_type) in &keys {
        values.push(Box::new(request.key_values[key].clone()));
        predicates.push(format!("{} = ${}::text::{}", quote_identifier(key), values.len(), data_type));
    }
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = values.iter()
        .map(|value| value.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let statement = format!("UPDATE {}.{} SET {} WHERE {}", quote_identifier(&request.schema), quote_identifier(&request.table), assignments.join(", "), predicates.join(" AND "));
    client.execute(&statement, &params).await.map_err(|error| format!("Failed to update table row: {error}"))
}

#[tauri::command]
pub async fn postgres_catalog_schemas(connection_id: String, state: tauri::State<'_, PostgresState>) -> Result<Vec<String>, String> {
    let client = state.clients.read().await.get(&connection_id).cloned()
        .ok_or_else(|| "PostgreSQL connection is not active".to_string())?;
    let rows = client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname", &[])
        .await.map_err(|error| format!("Failed to load schemas: {error}"))?;
    rows.into_iter().map(|row| row.try_get(0).map_err(|error| format!("Failed to decode schema: {error}"))).collect()
}

#[tauri::command]
pub async fn postgres_catalog_search(
    request: PostgresCatalogSearchRequest,
    state: tauri::State<'_, PostgresState>,
) -> Result<Vec<PostgresCatalogItem>, String> {
    let client = state.clients.read().await.get(&request.connection_id).cloned()
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
    rows.into_iter().map(|row| {
        let schema: String = row.try_get(0).map_err(|error| format!("Failed to decode catalog schema: {error}"))?;
        let name: String = row.try_get(1).map_err(|error| format!("Failed to decode catalog item: {error}"))?;
        let detail: String = row.try_get(2).map_err(|error| format!("Failed to decode catalog detail: {error}"))?;
        Ok(PostgresCatalogItem {
            kind: request.kind.clone(), schema: Some(schema), name,
            relation: if request.kind == "column" { request.relation.clone() } else { None },
            data_type: if request.kind == "column" || request.kind == "type" { Some(detail.clone()) } else { None },
            signature: if request.kind == "function" { Some(detail.clone()) } else { None },
            relation_kind: if request.kind == "relation" { Some(detail) } else { None },
        })
    }).collect()
}

#[tauri::command]
pub async fn postgres_ssh_fingerprint(
    request: PostgresSshFingerprintRequest,
) -> Result<PostgresSshFingerprintResponse, String> {
    if request.host.trim().is_empty() {
        return Err("SSH host is required".into());
    }
    let observed = Arc::new(std::sync::Mutex::new(None));
    let handler = FingerprintClient { expected: request.expected_fingerprint.clone(), observed: Arc::clone(&observed) };
    let config = Arc::new(client::Config { preferred: Preferred::DEFAULT, ..client::Config::default() });
    let result = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (&request.host[..], request.port), handler))
        .await
        .map_err(|_| "SSH host-key probe timed out")?;
    let fingerprint = observed.lock().map_err(|_| "SSH fingerprint probe failed".to_string())?.clone()
        .ok_or_else(|| "SSH server did not provide a host key".to_string())?;
    if request.expected_fingerprint.is_some() {
        result.map_err(|_| "SSH host key fingerprint changed. Refusing to connect.".to_string())?;
    } else {
        // The connection is intentionally dropped after probing an untrusted key.
        let _ = result;
    }
    Ok(PostgresSshFingerprintResponse { trusted: request.expected_fingerprint.is_some(), fingerprint })
}

#[cfg(test)]
mod tests {
    use super::single_statement;

    #[test]
    fn explain_accepts_one_statement_with_a_trailing_semicolon() {
        assert_eq!(single_statement("SELECT ';' AS value;").unwrap(), "SELECT ';' AS value");
    }

    #[test]
    fn explain_rejects_a_statement_batch() {
        assert!(single_statement("SELECT 1; DELETE FROM records").is_err());
    }
}
