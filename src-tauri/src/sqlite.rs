//! SQLite P0 provider runtime. It owns local-file sessions only and does not
//! share PostgreSQL's network client lifecycle or transport semantics.

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, sync::Mutex};

const MAX_QUERY_ROWS: usize = 1_000;

#[derive(Default)]
pub struct SqliteState {
    connections: Mutex<HashMap<String, Connection>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteConnectRequest {
    pub connection_id: String,
    pub file_path: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteExecuteRequest {
    pub connection_id: String,
    pub sql: String,
    pub max_rows: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteConnectionStatus {
    pub connection_id: String,
    pub connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteCatalogItem {
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub command_tags: Vec<String>,
    pub truncated: bool,
}

fn open_existing(path: &str, read_only: bool) -> Result<Connection, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        return Err("SQLite database file is required".into());
    }
    let metadata = std::fs::metadata(path).map_err(|error| format!("Unable to access SQLite database file: {error}"))?;
    if !metadata.is_file() {
        return Err("SQLite database path must be an existing file".into());
    }
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    Connection::open_with_flags(path, flags).map_err(|error| format!("Unable to open SQLite database: {error}"))
}

fn value_to_string(value: ValueRef<'_>) -> Result<Option<String>, String> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(value) => Ok(Some(value.to_string())),
        ValueRef::Real(value) => Ok(Some(value.to_string())),
        ValueRef::Text(value) => std::str::from_utf8(value)
            .map(|value| Some(value.to_owned()))
            .map_err(|error| format!("SQLite text is not UTF-8: {error}")),
        ValueRef::Blob(value) => Ok(Some(format!("<{} bytes>", value.len()))),
    }
}

#[tauri::command]
pub fn sqlite_connect(request: SqliteConnectRequest, state: tauri::State<'_, SqliteState>) -> Result<SqliteConnectionStatus, String> {
    if request.connection_id.trim().is_empty() {
        return Err("SQLite connection ID is required".into());
    }
    let connection = open_existing(&request.file_path, request.read_only)?;
    state.connections.lock().map_err(|_| "SQLite session state is unavailable")?
        .insert(request.connection_id.clone(), connection);
    Ok(SqliteConnectionStatus { connection_id: request.connection_id, connected: true })
}

#[tauri::command]
pub fn sqlite_disconnect(connection_id: String, state: tauri::State<'_, SqliteState>) -> Result<(), String> {
    state.connections.lock().map_err(|_| "SQLite session state is unavailable")?.remove(&connection_id);
    Ok(())
}

#[tauri::command]
pub fn sqlite_catalog_objects(connection_id: String, state: tauri::State<'_, SqliteState>) -> Result<Vec<SqliteCatalogItem>, String> {
    let connections = state.connections.lock().map_err(|_| "SQLite session state is unavailable")?;
    let connection = connections.get(&connection_id).ok_or_else(|| "SQLite connection is not active".to_string())?;
    let mut statement = connection.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|error| format!("Failed to list SQLite objects: {error}"))?;
    let items = statement.query_map([], |row| Ok(SqliteCatalogItem { name: row.get(0)? }))
        .map_err(|error| format!("Failed to list SQLite objects: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode SQLite objects: {error}"))?;
    Ok(items)
}

#[tauri::command]
pub fn sqlite_execute(request: SqliteExecuteRequest, state: tauri::State<'_, SqliteState>) -> Result<SqliteQueryResult, String> {
    if request.sql.trim().is_empty() { return Err("SQL cannot be empty".into()); }
    let limit = request.max_rows.unwrap_or(MAX_QUERY_ROWS).clamp(1, MAX_QUERY_ROWS);
    let connections = state.connections.lock().map_err(|_| "SQLite session state is unavailable")?;
    let connection = connections.get(&request.connection_id).ok_or_else(|| "SQLite connection is not active".to_string())?;
    let mut statement = connection.prepare(&request.sql).map_err(|error| format!("SQLite query failed: {error}"))?;
    let columns = statement.column_names().iter().map(ToString::to_string).collect::<Vec<_>>();
    if columns.is_empty() {
        let changed = statement.execute([]).map_err(|error| format!("SQLite command failed: {error}"))?;
        return Ok(SqliteQueryResult { columns, rows: Vec::new(), command_tags: vec![format!("{changed} rows affected")], truncated: false });
    }
    let mut rows = statement.query([]).map_err(|error| format!("SQLite query failed: {error}"))?;
    let mut values = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(|error| format!("SQLite query failed: {error}"))? {
        if values.len() == limit { truncated = true; break; }
        let mut result_row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            result_row.push(value_to_string(row.get_ref(index).map_err(|error| format!("Failed to decode SQLite value: {error}"))?)?);
        }
        values.push(result_row);
    }
    Ok(SqliteQueryResult { columns, rows: values, command_tags: Vec::new(), truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn opens_existing_file_lists_metadata_and_preserves_nulls() {
        let file = NamedTempFile::new().unwrap();
        let connection = open_existing(file.path().to_str().unwrap(), false).unwrap();
        connection.execute_batch("CREATE TABLE users (id INTEGER, name TEXT); INSERT INTO users VALUES (9007199254740993, NULL);").unwrap();
        let mut statement = connection.prepare("SELECT id, name FROM users").unwrap();
        let row = statement.query_row([], |row| Ok((value_to_string(row.get_ref(0)?).unwrap(), value_to_string(row.get_ref(1)?).unwrap()))).unwrap();
        assert_eq!(row.0.as_deref(), Some("9007199254740993"));
        assert_eq!(row.1, None);
    }

    #[test]
    fn refuses_missing_and_directory_paths() {
        assert!(open_existing("/definitely/not/a/sqlite/file.db", false).is_err());
        assert!(open_existing(std::env::temp_dir().to_str().unwrap(), false).is_err());
    }
}
