//! MySQL experimental P0 runtime. It owns network sessions independently from
//! PostgreSQL and SQLite; no generic database runtime or IPC is introduced.

use mysql_async::{prelude::Queryable, Conn, OptsBuilder, Value};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, RwLock};

const MAX_QUERY_ROWS: usize = 1_000;

#[derive(Default)]
pub struct MysqlState {
    connections: RwLock<HashMap<String, Arc<Mutex<Conn>>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlConnectRequest {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlExecuteRequest {
    pub connection_id: String,
    pub sql: String,
    pub max_rows: Option<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlConnectionStatus {
    pub connection_id: String,
    pub connected: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlCatalogItem {
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub command_tags: Vec<String>,
    pub truncated: bool,
}

fn value_to_string(value: Value) -> Option<String> {
    match value {
        Value::NULL => None,
        Value::Bytes(value) => Some(
            String::from_utf8(value)
                .unwrap_or_else(|error| format!("<{} bytes>", error.into_bytes().len())),
        ),
        Value::Int(value) => Some(value.to_string()),
        Value::UInt(value) => Some(value.to_string()),
        Value::Float(value) => Some(value.to_string()),
        Value::Double(value) => Some(value.to_string()),
        Value::Date(year, month, day, hour, minute, second, micros) => Some(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{micros:06}"
        )),
        Value::Time(negative, days, hours, minutes, seconds, micros) => Some(format!(
            "{}{} {hours:02}:{minutes:02}:{seconds:02}.{micros:06}",
            if negative { "-" } else { "" },
            days
        )),
    }
}

async fn connection(state: &MysqlState, connection_id: &str) -> Result<Arc<Mutex<Conn>>, String> {
    state
        .connections
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| "MySQL connection is not active".to_string())
}

#[tauri::command]
pub async fn mysql_connect(
    request: MysqlConnectRequest,
    state: tauri::State<'_, MysqlState>,
) -> Result<MysqlConnectionStatus, String> {
    if request.connection_id.trim().is_empty()
        || request.host.trim().is_empty()
        || request.database.trim().is_empty()
        || request.username.trim().is_empty()
    {
        return Err("MySQL connection ID, host, database, and username are required".into());
    }
    let options = OptsBuilder::default()
        .ip_or_hostname(request.host)
        .tcp_port(request.port)
        .db_name(Some(request.database))
        .user(Some(request.username))
        .pass(request.password);
    let connection = tokio::time::timeout(std::time::Duration::from_secs(10), Conn::new(options))
        .await
        .map_err(|_| "MySQL connection timed out")?
        .map_err(|error| format!("Unable to connect to MySQL: {error}"))?;
    state.connections.write().await.insert(
        request.connection_id.clone(),
        Arc::new(Mutex::new(connection)),
    );
    Ok(MysqlConnectionStatus {
        connection_id: request.connection_id,
        connected: true,
    })
}

#[tauri::command]
pub async fn mysql_disconnect(
    connection_id: String,
    state: tauri::State<'_, MysqlState>,
) -> Result<(), String> {
    // Dropping the provider-owned connection closes this P0 session.
    state.connections.write().await.remove(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn mysql_catalog_objects(
    connection_id: String,
    state: tauri::State<'_, MysqlState>,
) -> Result<Vec<MysqlCatalogItem>, String> {
    let connection = connection(&state, &connection_id).await?;
    let mut connection = connection.lock().await;
    connection.query_map("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name", |name| MysqlCatalogItem { name }).await.map_err(|error| format!("Failed to list MySQL tables: {error}"))
}

#[tauri::command]
pub async fn mysql_execute(
    request: MysqlExecuteRequest,
    state: tauri::State<'_, MysqlState>,
) -> Result<MysqlQueryResult, String> {
    if request.sql.trim().is_empty() {
        return Err("SQL cannot be empty".into());
    }
    let limit = request
        .max_rows
        .unwrap_or(MAX_QUERY_ROWS)
        .clamp(1, MAX_QUERY_ROWS);
    let connection = connection(&state, &request.connection_id).await?;
    let mut connection = connection.lock().await;
    let mut result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        connection.query_iter(&request.sql),
    )
    .await
    .map_err(|_| "MySQL query timed out")?
    .map_err(|error| format!("MySQL query failed: {error}"))?;
    let columns = result
        .columns_ref()
        .iter()
        .map(|column| column.name_str().to_string())
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = result
        .next()
        .await
        .map_err(|error| format!("MySQL query failed: {error}"))?
    {
        if rows.len() == limit {
            truncated = true;
            // Explicitly drop the streaming result before the connection
            // goes back to the shared session: mysql_async's drop-based
            // cancellation is best-effort, and draining it here keeps the
            // next query on this connection from seeing leftover rows.
            drop(result);
            break;
        }
        rows.push(
            row.unwrap_raw()
                .into_iter()
                .map(|value| value.map(value_to_string).unwrap_or(None))
                .collect(),
        );
    }
    let command_tags = if columns.is_empty() {
        vec![format!("{} rows affected", connection.affected_rows())]
    } else {
        Vec::new()
    };
    Ok(MysqlQueryResult {
        columns,
        rows,
        command_tags,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_null_bigint_and_decimal_losslessly() {
        assert_eq!(
            value_to_string(Value::UInt(9_007_199_254_740_993)),
            Some("9007199254740993".into())
        );
        assert_eq!(
            value_to_string(Value::Bytes(b"1234567890.123456789".to_vec())),
            Some("1234567890.123456789".into())
        );
        assert_eq!(value_to_string(Value::NULL), None);
    }

    #[tokio::test]
    #[ignore = "requires MYSQL_E2E_URL"]
    async fn connects_to_mysql_fixture() {
        let url = std::env::var("MYSQL_E2E_URL").expect("MYSQL_E2E_URL must be configured");
        let mut connection =
            Conn::new(mysql_async::Opts::from_url(&url).expect("MYSQL_E2E_URL must be valid"))
                .await
                .expect("fixture connection must succeed");
        assert_eq!(
            connection
                .query_first::<u8, _>("SELECT 1")
                .await
                .expect("fixture query must succeed"),
            Some(1)
        );
    }
}
