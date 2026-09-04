//! SQLite storage backend, organized per module with proper normalized tables.
//!
//! Every application domain owns a dedicated table with typed columns
//! (e.g. `connections` has one row per saved connection with `id`, `host`,
//! `port`, `username`, ...). Sensitive values are encrypted by the frontend
//! (AES-GCM with the app-password-derived key) before they are written, so
//! password columns only ever hold ciphertext blobs. Only `preferences` and
//! `workspace` remain generic key-value tables (their data is inherently a
//! key-value map / a serialized layout tree).
//!
//! The old single-value-per-key layout (each module table was `key`/`value`)
//! is detected on startup and renamed to `<name>_legacy` so the frontend can
//! migrate its data into the normalized tables before `drop_legacy_tables`
//! removes them.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, DatabaseName, Row};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::sync::{Arc, Mutex};
use tauri::State;

type DocumentResourceRow = (String, String, String, Vec<u8>);
type DocumentListRow = (String, String, String, i64, i64, i64, i64);

/// Allow-listed normalized tables. Table names are validated against this
/// list before being interpolated into SQL, so no injection is possible.
pub const TABLES: [&str; 40] = [
    "connections",
    "folders",
    "active_connections",
    "profiles",
    "vault_records",
    "app_lock",
    "command_usage",
    "command_history",
    "command_stats",
    "toolbox_apps",
    "tunnels",
    "services",
    "service_orchestrations",
    "notes",
    "api_collections",
    "api_environments",
    "api_request_history",
    "postgres_connections",
    "database_sqlite_connections",
    "database_mysql_connections",
    // Preferences — normalized single-row tables (no JSON blob columns).
    "app_settings",
    "layout_config",
    "terminal_appearance",
    "editor_config",
    // Workspace layout — groups / tabs / grid tree / meta.
    "workspace_meta",
    "workspace_groups",
    "workspace_tabs",
    "workspace_grid_nodes",
    // Documents module — metadata + canonical model versions + resources.
    "documents",
    "document_versions",
    "document_resources",
    // JAR decompiler module — projects / classes / builds / libraries / symbols.
    "jar_projects",
    "jar_classes",
    "jar_builds",
    "jar_libraries",
    "jar_symbols",
    "jar_subtypes",
    "jar_preferences",
    "jar_recent_files",
    "jar_find_history",
];

/// Tables whose legacy key-value layout collides with a new normalized table
/// name and therefore must be renamed before creating the new schema.
const LEGACY_RENAME: [&str; 6] = [
    "connections",
    "profiles",
    "app_lock",
    "command_history",
    "preferences",
    "workspace",
];

/// Legacy key-value tables kept until the frontend migrates their data.
const LEGACY_TABLES: [&str; 9] = [
    "connections_legacy",
    "profiles_legacy",
    "app_lock_legacy",
    "command_history_legacy",
    "preferences_legacy",
    "workspace_legacy",
    "vault",
    "toolbox",
    "api_debug",
];

pub struct DbState {
    conn: Mutex<Connection>,
}

const BACKUP_ITERATIONS: u32 = 150_000;
const BACKUP_MAGIC: &str = "nexterm-encrypted-backup";

#[derive(serde::Serialize, serde::Deserialize)]
struct EncryptedBackup {
    format: String,
    version: u8,
    salt: String,
    payload: String,
}

impl DbState {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("Failed to open database: {}", e))?;
        rename_legacy_kv_tables(&conn)?;
        conn.execute_batch(CREATE_SQL)
            .map_err(|e| format!("Failed to init tables: {}", e))?;
        // Drop the very first single-table layout if it somehow still exists.
        let _ = conn.execute_batch("DROP TABLE IF EXISTS kv_store;");
        // documents.content (base64 original file) was removed by the model
        // redesign — drop the obsolete columns so old databases converge.
        for legacy_col in ["content", "edited_content"] {
            if table_columns(&conn, "documents")
                .map(|cols| cols.iter().any(|c| c == legacy_col))
                .unwrap_or(false)
            {
                let _ = conn.execute_batch(&format!(
                    "ALTER TABLE \"documents\" DROP COLUMN {legacy_col};"
                ));
            }
        }
        // documents.type (old field) → documents.kind (model redesign).
        {
            let cols = table_columns(&conn, "documents").unwrap_or_default();
            if cols.iter().any(|c| c == "type") && !cols.iter().any(|c| c == "kind") {
                let _ = conn.execute_batch("ALTER TABLE \"documents\" RENAME COLUMN type TO kind;");
            }
        }
        // Schema evolution for databases created before a column existed.
        // `CREATE TABLE IF NOT EXISTS` never alters existing tables, so any
        // column added after a release must be back-filled here.
        // NOTE: old databases may retain a legacy `compression` column on
        // `connections` (SSH zlib compression was removed in FEATURE BATCH 16).
        // It is a historical ghost column — no code reads or writes it — and is
        // intentionally left in place; see release notes. Do not add a DROP
        // COLUMN migration for it.
        for (table, column, ddl) in [
            ("connections", "jump_host", "jump_host TEXT"),
            ("connections", "jump_port", "jump_port INTEGER"),
            ("connections", "jump_username", "jump_username TEXT"),
            ("connections", "jump_password", "jump_password TEXT"),
            (
                "connections",
                "jump_use_key",
                "jump_use_key INTEGER NOT NULL DEFAULT 0",
            ),
            ("connections", "default_directory", "default_directory TEXT"),
            (
                "connections",
                "terminal_encoding",
                "terminal_encoding TEXT NOT NULL DEFAULT 'utf-8'",
            ),
            (
                "connections",
                "terminal_startup_mode",
                "terminal_startup_mode TEXT NOT NULL DEFAULT 'safe'",
            ),
            (
                "connections",
                "host_key_fingerprint",
                "host_key_fingerprint TEXT",
            ),
            (
                "connections",
                "jump_host_key_fingerprint",
                "jump_host_key_fingerprint TEXT",
            ),
            ("toolbox_apps", "args", "args TEXT"),
            ("toolbox_apps", "work_dir", "work_dir TEXT"),
            ("tunnels", "jump_host", "jump_host TEXT"),
            ("tunnels", "jump_port", "jump_port INTEGER"),
            ("tunnels", "jump_username", "jump_username TEXT"),
            ("tunnels", "jump_password", "jump_password TEXT"),
            (
                "tunnels",
                "jump_host_key_fingerprint",
                "jump_host_key_fingerprint TEXT",
            ),
            (
                "postgres_connections",
                "ssh_private_key_path",
                "ssh_private_key_path TEXT",
            ),
            (
                "postgres_connections",
                "ssh_connection_id",
                "ssh_connection_id TEXT",
            ),
            (
                "app_settings",
                "command_suggestions",
                "command_suggestions INTEGER NOT NULL DEFAULT 1",
            ),
            (
                "app_settings",
                "suggestion_debounce_ms",
                "suggestion_debounce_ms INTEGER NOT NULL DEFAULT 50",
            ),
            (
                "app_settings",
                "suggestion_tui_gate_enabled",
                "suggestion_tui_gate_enabled INTEGER NOT NULL DEFAULT 1",
            ),
            (
                "documents",
                "head_version",
                "head_version INTEGER NOT NULL DEFAULT 0",
            ),
            ("documents", "source_hash", "source_hash TEXT"),
            // JAR decompiler module migrations.
            (
                "jar_classes",
                "library_id",
                "library_id TEXT NOT NULL DEFAULT ''",
            ),
            // B22 connection accent color (accentColor per profile).
            ("postgres_connections", "color", "color TEXT"),
            ("database_sqlite_connections", "color", "color TEXT"),
            ("database_mysql_connections", "color", "color TEXT"),
        ] {
            ensure_column(&conn, table, column, ddl)?;
        }
        Ok(DbState {
            conn: Mutex::new(conn),
        })
    }

    // ── Documents module (canonical model + versioned parts) ──────────────

    /// Write a document version atomically: metadata row + model version +
    /// resources (BLOBs). `expect_head` guards optimistic concurrency.
    #[allow(clippy::too_many_arguments)] // Domain transaction parameters mirror the document package format.
    pub fn documents_write(
        &self,
        id: &str,
        name: &str,
        kind: &str,
        size: i64,
        source_hash: Option<&str>,
        version: i64,
        expect_head: Option<i64>,
        model: &str,
        model_hash: &str,
        resources: &[(String, String, String, Vec<u8>, String)],
    ) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        if let Some(expected) = expect_head {
            let cur: i64 = tx
                .query_row(
                    "SELECT head_version FROM documents WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| format!("read head_version: {e}"))?;
            if cur != expected {
                return Err(format!(
                    "version conflict: head is {cur}, expected {expected}"
                ));
            }
        }

        tx.execute(
            "INSERT INTO documents (id, name, kind, size, source_hash, head_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name, kind=excluded.kind, size=excluded.size,
               source_hash=excluded.source_hash, head_version=excluded.head_version,
               updated_at=excluded.updated_at",
            rusqlite::params![id, name, kind, size, source_hash, version, now_ms(), now_ms()],
        )
        .map_err(|e| format!("upsert documents: {e}"))?;

        tx.execute(
            "INSERT INTO document_versions (id, document_id, version, model, model_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![format!("{id}-v{version}"), id, version, model, model_hash, now_ms()],
        )
        .map_err(|e| format!("insert document_versions: {e}"))?;

        // Canonical document models can be several MiB. Keep a bounded,
        // useful undo history instead of retaining every snapshot forever.
        tx.execute(
            "DELETE FROM document_versions WHERE document_id = ?1 AND version <= ?2",
            rusqlite::params![id, version.saturating_sub(3)],
        )
        .map_err(|e| format!("prune document_versions: {e}"))?;

        for (resource_id, kind_res, mime, data, sha) in resources {
            tx.execute(
                "INSERT INTO document_resources (id, document_id, resource_id, kind, mime, data, sha256)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   kind=excluded.kind, mime=excluded.mime, data=excluded.data, sha256=excluded.sha256",
                rusqlite::params![
                    format!("{id}-{resource_id}"),
                    id,
                    resource_id,
                    kind_res,
                    mime,
                    data,
                    sha
                ],
            )
            .map_err(|e| format!("upsert document_resources: {e}"))?;
        }

        tx.commit().map_err(|e| e.to_string())
    }

    /// Remove all but the newest document versions, returning the deleted row count.
    pub fn documents_prune_versions(&self, keep: u32) -> Result<usize, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM document_versions WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY document_id ORDER BY version DESC
                    ) AS rank
                    FROM document_versions
                ) WHERE rank > ?1
            )",
            [keep],
        )
        .map_err(|e| format!("prune document versions: {e}"))
    }

    fn backup_key(password: &str, salt: &[u8]) -> [u8; 32] {
        let mut key = [0u8; 32];
        pbkdf2_hmac::<sha2_10::Sha256>(password.as_bytes(), salt, BACKUP_ITERATIONS, &mut key);
        key
    }

    fn temp_backup_path(prefix: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("{prefix}-{}-{stamp}.db", std::process::id()))
    }

    /// Create a consistent SQLite snapshot and encrypt it directly to a backup file.
    pub fn export_encrypted_backup(
        &self,
        password: &str,
        output_path: &std::path::Path,
    ) -> Result<(), String> {
        if password.len() < 8 {
            return Err("backup password must be at least 8 characters".to_string());
        }
        let temp = Self::temp_backup_path("nexterm-backup");
        let result = (|| {
            // Hold the connection lock only for the snapshot itself; the
            // PBKDF2 key derivation + encryption + file write below are
            // CPU/IO-heavy and must not block concurrent small writes
            // (row_upsert etc.) on the same lock (audit P0-2).
            {
                let conn = self
                    .conn
                    .lock()
                    .map_err(|_| "db lock poisoned".to_string())?;
                conn.backup(DatabaseName::Main, &temp, None)
                    .map_err(|e| format!("snapshot database: {e}"))?;
            }
            let bytes = std::fs::read(&temp).map_err(|e| format!("read snapshot: {e}"))?;
            let mut salt = [0u8; 16];
            let mut nonce = [0u8; 12];
            OsRng.fill_bytes(&mut salt);
            OsRng.fill_bytes(&mut nonce);
            let key = Self::backup_key(password, &salt);
            let encrypted = Aes256Gcm::new_from_slice(&key)
                .map_err(|e| format!("create cipher: {e}"))?
                .encrypt(Nonce::from_slice(&nonce), bytes.as_ref())
                .map_err(|_| "encrypt backup".to_string())?;
            let mut payload = nonce.to_vec();
            payload.extend(encrypted);
            let envelope = EncryptedBackup {
                format: BACKUP_MAGIC.to_string(),
                version: 1,
                salt: BASE64.encode(salt),
                payload: BASE64.encode(payload),
            };
            let json =
                serde_json::to_vec(&envelope).map_err(|e| format!("serialize backup: {e}"))?;
            std::fs::write(output_path, json).map_err(|e| format!("write backup: {e}"))
        })();
        let _ = std::fs::remove_file(&temp);
        result
    }

    /// Restore a complete encrypted SQLite snapshot. The caller must relaunch
    /// afterwards so the source backup's app-lock metadata is reloaded.
    pub fn restore_encrypted_backup(
        &self,
        password: &str,
        input_path: &std::path::Path,
    ) -> Result<(), String> {
        let raw = std::fs::read(input_path).map_err(|e| format!("read backup: {e}"))?;
        let envelope: EncryptedBackup =
            serde_json::from_slice(&raw).map_err(|_| "invalid backup file".to_string())?;
        if envelope.format != BACKUP_MAGIC || envelope.version != 1 {
            return Err("unsupported backup format".to_string());
        }
        let salt = BASE64
            .decode(envelope.salt)
            .map_err(|_| "invalid backup salt".to_string())?;
        let payload = BASE64
            .decode(envelope.payload)
            .map_err(|_| "invalid backup payload".to_string())?;
        if salt.len() != 16 || payload.len() <= 12 {
            return Err("invalid backup data".to_string());
        }
        let key = Self::backup_key(password, &salt);
        let bytes = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| format!("create cipher: {e}"))?
            .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
            .map_err(|_| "incorrect backup password or corrupted backup".to_string())?;
        let temp = Self::temp_backup_path("nexterm-restore");
        let result = (|| {
            std::fs::write(&temp, bytes).map_err(|e| format!("stage backup: {e}"))?;
            let source = Connection::open(&temp).map_err(|e| format!("open backup: {e}"))?;
            let integrity: String = source
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .map_err(|e| format!("verify backup: {e}"))?;
            if integrity != "ok" {
                return Err("backup integrity check failed".to_string());
            }
            drop(source);
            let mut conn = self
                .conn
                .lock()
                .map_err(|_| "db lock poisoned".to_string())?;
            conn.restore(
                DatabaseName::Main,
                &temp,
                None::<fn(rusqlite::backup::Progress)>,
            )
            .map_err(|e| format!("restore database: {e}"))
        })();
        let _ = std::fs::remove_file(&temp);
        result
    }

    /// Document kind ('docx' | 'xlsx'), if present.
    pub fn documents_kind(&self, doc_id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT kind FROM documents WHERE id = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let mut rows = stmt.query([doc_id]).map_err(|e| format!("query: {e}"))?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some(row.get(0).map_err(|e| e.to_string())?))
        } else {
            Ok(None)
        }
    }

    /// Read a model version. `version: None` reads the head.
    pub fn documents_read_model(
        &self,
        doc_id: &str,
        version: Option<i64>,
    ) -> Result<Option<(i64, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match version {
            Some(v) => (
                "SELECT version, model FROM document_versions WHERE document_id = ?1 AND version = ?2",
                vec![Box::new(doc_id), Box::new(v)],
            ),
            None => (
                "SELECT version, model FROM document_versions WHERE document_id = ?1 ORDER BY version DESC LIMIT 1",
                vec![Box::new(doc_id)],
            ),
        };
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {e}"))?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params))
            .map_err(|e| format!("query: {e}"))?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some((
                row.get(0).map_err(|e| e.to_string())?,
                row.get(1).map_err(|e| e.to_string())?,
            )))
        } else {
            Ok(None)
        }
    }

    /// All resources for a document (resource_id, kind, mime, data).
    pub fn documents_resources(&self, doc_id: &str) -> Result<Vec<DocumentResourceRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT resource_id, kind, mime, data FROM document_resources WHERE document_id = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map([doc_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|e| format!("query: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Version list: (version, created_at) newest first.
    pub fn documents_versions(&self, doc_id: &str) -> Result<Vec<(i64, i64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT version, created_at FROM document_versions WHERE document_id = ?1 ORDER BY version DESC")
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map([doc_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| format!("query: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Delete a document and all its versions/resources.
    pub fn documents_delete(&self, doc_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM document_versions WHERE document_id = ?1",
            [doc_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM document_resources WHERE document_id = ?1",
            [doc_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM documents WHERE id = ?1", [doc_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Metadata rows for the documents list.
    pub fn documents_list(&self) -> Result<Vec<DocumentListRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "db lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, kind, size, head_version, created_at, updated_at FROM documents ORDER BY created_at DESC")
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .map_err(|e| format!("query: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Detect legacy `key`/`value` tables whose name collides with a normalized
/// table and rename them to `<name>_legacy` so the new schema can be created
/// and the old data preserved for frontend migration.
fn rename_legacy_kv_tables(conn: &Connection) -> Result<(), String> {
    for table in LEGACY_RENAME {
        let exists: bool = conn
            .prepare(&format!(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '{}'",
                table
            ))
            .map_err(|e| e.to_string())?
            .exists([])
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        let columns = table_columns(conn, table)?;
        // Legacy layout starts with a `key` column; the new one never does.
        if columns.first().map(String::as_str) != Some("key") {
            continue;
        }
        let legacy = format!("{}_legacy", table);
        let legacy_exists: bool = conn
            .prepare(&format!(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '{}'",
                legacy
            ))
            .map_err(|e| e.to_string())?
            .exists([])
            .map_err(|e| e.to_string())?;
        if legacy_exists {
            // Already renamed on a previous launch — drop any stale duplicate.
            let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\";", table));
        } else {
            conn.execute_batch(&format!(
                "ALTER TABLE \"{}\" RENAME TO \"{}\";",
                table, legacy
            ))
            .map_err(|e| format!("Failed to rename legacy table {}: {}", table, e))?;
        }
    }
    Ok(())
}

fn validate_table(table: &str) -> Result<(), String> {
    if TABLES.contains(&table) {
        Ok(())
    } else {
        Err(format!("unknown table: {}", table))
    }
}

fn pk_column(table: &str) -> Result<&'static str, String> {
    Ok(match table {
        "connections" => "id",
        "folders" => "id",
        "active_connections" => "tab_id",
        "profiles" => "id",
        "vault_records" => "id",
        "app_lock" => "id",
        "command_usage" => "command",
        "command_history" => "command",
        "command_stats" => "command",
        "toolbox_apps" => "id",
        "tunnels" => "id",
        "services" => "id",
        "service_orchestrations" => "id",
        "notes" => "id",
        "api_collections" => "id",
        "api_environments" => "id",
        "api_request_history" => "id",
        "postgres_connections" => "id",
        "database_sqlite_connections" => "id",
        "database_mysql_connections" => "id",
        "app_settings" => "id",
        "layout_config" => "id",
        "terminal_appearance" => "id",
        "editor_config" => "id",
        "workspace_meta" => "id",
        "workspace_groups" => "group_id",
        "workspace_tabs" => "tab_id",
        "workspace_grid_nodes" => "node_id",
        "documents" => "id",
        "document_versions" => "id",
        "document_resources" => "id",
        "jar_preferences" => "id",
        "jar_recent_files" => "id",
        "jar_find_history" => "id",
        _ => return Err(format!("unknown table: {}", table)),
    })
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{}\")", table))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Add a column to an existing table when it is missing. Used for schema
/// evolution on databases created before a column existed.
fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    let columns = table_columns(conn, table)?;
    if !columns.iter().any(|c| c == column) {
        conn.execute_batch(&format!("ALTER TABLE \"{}\" ADD COLUMN {};", table, ddl))
            .map_err(|e| format!("Failed to add column {} to {}: {}", column, table, e))?;
    }
    Ok(())
}

fn json_to_sql(v: &JsonValue) -> SqlValue {
    match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(*b as i64),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                SqlValue::Null
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        // Nested arrays/objects are stored as JSON text.
        JsonValue::Array(_) | JsonValue::Object(_) => SqlValue::Text(v.to_string()),
    }
}

fn row_to_json(row: &Row, names: &[String]) -> rusqlite::Result<JsonMap<String, JsonValue>> {
    let mut map = JsonMap::new();
    for (i, name) in names.iter().enumerate() {
        let value = match row.get_ref(i)? {
            ValueRef::Null => JsonValue::Null,
            ValueRef::Integer(n) => JsonValue::Number(n.into()),
            ValueRef::Real(r) => serde_json::Number::from_f64(r)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(_) => JsonValue::Null,
        };
        map.insert(name.clone(), value);
    }
    Ok(map)
}

/// Upsert one row into a normalized table. `row` must contain the primary key
/// column with a non-empty value; other columns are validated against the
/// actual table schema.
#[tauri::command]
pub fn row_upsert(
    table: String,
    row: JsonMap<String, JsonValue>,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    upsert_row(&conn, &table, &row)
}

fn upsert_row(
    conn: &Connection,
    table: &str,
    row: &JsonMap<String, JsonValue>,
) -> Result<(), String> {
    validate_table(table)?;
    let pk = pk_column(table)?.to_string();
    let columns = table_columns(conn, table)?;

    let mut names: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    let mut has_pk = false;
    for col in &columns {
        if let Some(v) = row.get(col) {
            if *col == pk {
                has_pk = true;
                // Primary keys may be numeric (e.g. `id: 1` for single-row
                // tables) or strings. Only null / empty strings are invalid.
                let pk_invalid = v.is_null() || v.as_str().is_some_and(|s| s.is_empty());
                if pk_invalid {
                    return Err(format!("primary key '{}' must be non-empty", pk));
                }
            }
            names.push(col.clone());
            params.push(json_to_sql(v));
        }
    }
    if !has_pk {
        return Err(format!("row is missing the primary key column '{}'", pk));
    }
    if names.is_empty() {
        return Err("row has no known columns".to_string());
    }

    let quoted: Vec<String> = names.iter().map(|c| format!("\"{}\"", c)).collect();
    let placeholders: Vec<String> = (1..=names.len()).map(|i| format!("?{}", i)).collect();
    let assigns: Vec<String> = names
        .iter()
        .map(|c| format!("\"{}\" = excluded.\"{}\"", c, c))
        .collect();
    // `command_stats` uses a composite PRIMARY KEY (command, scope) — the
    // single-column ON CONFLICT(pk) clause would not match any unique index.
    let conflict_clause = if table == "command_stats" {
        "ON CONFLICT(\"command\",\"scope\") DO UPDATE SET".to_string()
    } else {
        format!("ON CONFLICT(\"{}\") DO UPDATE SET", pk)
    };
    let sql = format!(
        "INSERT INTO \"{}\" ({}) VALUES ({}) {} {}",
        table,
        quoted.join(", "),
        placeholders.join(", "),
        conflict_clause,
        assigns.join(", ")
    );
    conn.execute(&sql, params_from_iter(params.iter()))
        .map_err(|e| {
            tracing::error!(
                "row_upsert failed for {} ({} cols: {}) -> {}",
                table,
                names.len(),
                names.join(","),
                e
            );
            format!("upsert: {}", e)
        })?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplaceRequest {
    pub meta: JsonMap<String, JsonValue>,
    pub groups: Vec<JsonMap<String, JsonValue>>,
    pub tabs: Vec<JsonMap<String, JsonValue>>,
    pub grid_nodes: Vec<JsonMap<String, JsonValue>>,
}

/// Atomically replace the normalized terminal-workspace tables.
///
/// The old frontend flow cleared four tables and then issued many independent
/// upserts. A crash or SQLite error between those IPCs could leave a partially
/// cleared workspace. This command performs all deletes and inserts in one
/// SQLite transaction, so persisted state is either the complete old snapshot
/// or the complete new snapshot.
#[tauri::command]
pub fn workspace_replace(
    request: WorkspaceReplaceRequest,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    replace_workspace(&mut conn, &request)
}

fn replace_workspace(
    conn: &mut Connection,
    request: &WorkspaceReplaceRequest,
) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|e| format!("failed to begin workspace transaction: {e}"))?;

    for table in [
        "workspace_meta",
        "workspace_groups",
        "workspace_tabs",
        "workspace_grid_nodes",
    ] {
        transaction
            .execute(&format!("DELETE FROM \"{table}\""), [])
            .map_err(|e| format!("failed to clear workspace table {table}: {e}"))?;
    }

    upsert_row(&transaction, "workspace_meta", &request.meta)?;
    for row in &request.groups {
        upsert_row(&transaction, "workspace_groups", row)?;
    }
    for row in &request.tabs {
        upsert_row(&transaction, "workspace_tabs", row)?;
    }
    for row in &request.grid_nodes {
        upsert_row(&transaction, "workspace_grid_nodes", row)?;
    }

    transaction
        .commit()
        .map_err(|e| format!("failed to commit workspace transaction: {e}"))
}

/// Read one row by primary key.
#[tauri::command]
pub fn row_get(
    table: String,
    key: String,
    state: State<'_, Arc<DbState>>,
) -> Result<Option<JsonMap<String, JsonValue>>, String> {
    validate_table(&table)?;
    let pk = pk_column(&table)?.to_string();
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    let sql = format!("SELECT * FROM \"{}\" WHERE \"{}\" = ?1", table, pk);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query_map([&key], |row| row_to_json(row, &names))
        .map_err(|e| format!("query: {}", e))?;
    if let Some(row) = rows.next() {
        return Ok(Some(row.map_err(|e| format!("row: {}", e))?));
    }
    Ok(None)
}

/// List every row in a normalized table.
#[tauri::command]
pub fn row_list(
    table: String,
    state: State<'_, Arc<DbState>>,
) -> Result<Vec<JsonMap<String, JsonValue>>, String> {
    validate_table(&table)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    let sql = format!("SELECT * FROM \"{}\"", table);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |row| row_to_json(row, &names))
        .map_err(|e| format!("query: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("rows: {}", e))?;
    Ok(rows)
}

/// Delete one row by primary key.
#[tauri::command]
pub fn row_delete(
    table: String,
    key: String,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    validate_table(&table)?;
    let pk = pk_column(&table)?.to_string();
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    let sql = format!("DELETE FROM \"{}\" WHERE \"{}\" = ?1", table, pk);
    conn.execute(&sql, [&key])
        .map_err(|e| format!("delete: {}", e))?;
    Ok(())
}

/// Delete every row in a normalized table (used for full-state rewrites).
#[tauri::command]
pub fn row_clear(table: String, state: State<'_, Arc<DbState>>) -> Result<(), String> {
    validate_table(&table)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    let sql = format!("DELETE FROM \"{}\"", table);
    conn.execute_batch(&sql)
        .map_err(|e| format!("clear: {}", e))?;
    Ok(())
}

/// Read a value from a legacy key-value table (migration only).
#[tauri::command]
pub fn legacy_db_get(
    table: String,
    key: String,
    state: State<'_, Arc<DbState>>,
) -> Result<Option<String>, String> {
    if !LEGACY_TABLES.contains(&table.as_str()) {
        return Err(format!("not a legacy table: {}", table));
    }
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    let sql = format!("SELECT value FROM \"{}\" WHERE key = ?1", table);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
    let mut rows = stmt
        .query_map([&key], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query: {}", e))?;
    if let Some(row) = rows.next() {
        return Ok(Some(row.map_err(|e| format!("row: {}", e))?));
    }
    Ok(None)
}

/// Drop the legacy key-value tables after the frontend migrated their data
/// into the normalized tables.
#[tauri::command]
pub fn drop_legacy_tables(state: State<'_, Arc<DbState>>) -> Result<(), String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS connections_legacy; \
         DROP TABLE IF EXISTS profiles_legacy; \
         DROP TABLE IF EXISTS app_lock_legacy; \
         DROP TABLE IF EXISTS command_history_legacy; \
         DROP TABLE IF EXISTS preferences_legacy; \
         DROP TABLE IF EXISTS workspace_legacy; \
         DROP TABLE IF EXISTS vault; \
         DROP TABLE IF EXISTS toolbox; \
         DROP TABLE IF EXISTS api_debug;",
    )
    .map_err(|e| format!("drop legacy tables: {}", e))?;
    Ok(())
}

/// Rebuild SQLite after a bulk retention purge. This intentionally requires an
/// explicit caller instead of running during startup, because VACUUM needs an
/// exclusive lock and temporarily as much free disk space as the database.
#[tauri::command]
pub async fn database_vacuum(state: State<'_, Arc<DbState>>) -> Result<(), String> {
    // VACUUM needs the exclusive lock and can run for minutes on large
    // databases; run it on the blocking pool so the async runtime (and the
    // rest of the IPC surface) stays responsive (audit P0-2).
    let db = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().map_err(|_| "db lock poisoned".to_string())?;
        conn.execute_batch("VACUUM")
            .map_err(|e| format!("vacuum: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn documents_prune_versions(state: State<'_, Arc<DbState>>) -> Result<usize, String> {
    state.documents_prune_versions(3)
}

#[tauri::command]
pub async fn export_encrypted_backup(
    password: String,
    output_path: String,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    // PBKDF2 (150k iterations) + AES-GCM are CPU-heavy: keep them off the
    // async runtime workers (audit P0-2).
    let db = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        db.export_encrypted_backup(&password, std::path::Path::new(&output_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_encrypted_backup(
    password: String,
    input_path: String,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    let db = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        db.restore_encrypted_backup(&password, std::path::Path::new(&input_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Retain only the most recently used learned command rows. This avoids
/// unbounded growth without rebuilding the database file on every eviction.
#[tauri::command]
pub fn prune_command_stats(limit: u32, state: State<'_, Arc<DbState>>) -> Result<(), String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "db lock poisoned".to_string())?;
    conn.execute(
        "DELETE FROM command_stats WHERE rowid IN (
            SELECT rowid FROM command_stats
            ORDER BY last_used DESC
            LIMIT -1 OFFSET ?1
        )",
        [limit],
    )
    .map_err(|e| format!("prune command stats: {e}"))?;
    Ok(())
}

const CREATE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS "connections" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'SSH',
  folder TEXT,
  profile_id TEXT,
  created_at TEXT NOT NULL,
  last_connected TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  tags TEXT,
  description TEXT,
  auth_method TEXT,
  password TEXT,
  private_key_path TEXT,
  passphrase TEXT,
  ftps_enabled INTEGER NOT NULL DEFAULT 0,
  proxy_type TEXT,
  proxy_host TEXT,
  proxy_port INTEGER,
  proxy_username TEXT,
  proxy_password TEXT,
  jump_host TEXT,
  jump_port INTEGER,
  jump_username TEXT,
  jump_password TEXT,
  jump_use_key INTEGER NOT NULL DEFAULT 0,
  host_key_fingerprint TEXT,
  jump_host_key_fingerprint TEXT,
  default_directory TEXT,
  terminal_encoding TEXT NOT NULL DEFAULT 'utf-8',
  terminal_startup_mode TEXT NOT NULL DEFAULT 'safe',
  keep_alive INTEGER NOT NULL DEFAULT 0,
  keep_alive_interval INTEGER,
  server_alive_count_max INTEGER,
  domain TEXT,
  rdp_resolution TEXT,
  vnc_color_depth TEXT,
  vnc_password TEXT,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS "folders" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL UNIQUE,
  parent_path TEXT,
  created_at TEXT NOT NULL,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS "active_connections" (
  tab_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  order_num INTEGER NOT NULL DEFAULT 0,
  original_connection_id TEXT,
  tab_type TEXT,
  protocol TEXT
);
CREATE TABLE IF NOT EXISTS "profiles" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT '',
  auth_method TEXT NOT NULL DEFAULT 'password',
  password TEXT,
  private_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  tags TEXT
);
CREATE TABLE IF NOT EXISTS "vault_records" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  address TEXT,
  username TEXT,
  password TEXT,
  category TEXT,
  notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "app_lock" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "command_usage" (
  command TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "command_history" (
  command TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "command_stats" (
  command TEXT NOT NULL,
  scope TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  selection_count INTEGER NOT NULL DEFAULT 0,
  rejection_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (command, scope)
);
CREATE TABLE IF NOT EXISTS "toolbox_apps" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  args TEXT,
  work_dir TEXT,
  icon_path TEXT,
  category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "tunnels" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
  listen_port INTEGER NOT NULL,
  remote_host TEXT NOT NULL DEFAULT '',
  remote_port INTEGER NOT NULL,
  jump_host TEXT,
  jump_port INTEGER,
  jump_username TEXT,
  jump_password TEXT,
  jump_host_key_fingerprint TEXT,
  group_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "services" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  work_dir TEXT,
  args TEXT,
  env TEXT,
  group_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "service_orchestrations" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "notes" (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "api_collections" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  group_name TEXT,
  request TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "api_environments" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  variables TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "api_request_history" (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "postgres_connections" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  group_name TEXT,
  environment TEXT NOT NULL DEFAULT 'development',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 5432,
  database_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password TEXT,
  color TEXT,
  default_schema TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  auto_commit INTEGER NOT NULL DEFAULT 1,
  ssl_mode TEXT NOT NULL DEFAULT 'prefer',
  ssl_root_cert TEXT,
  ssl_client_cert TEXT,
  ssl_client_key TEXT,
  ssl_key_passphrase TEXT,
  ssh_enabled INTEGER NOT NULL DEFAULT 0,
  ssh_connection_id TEXT,
  ssh_host TEXT,
  ssh_port INTEGER,
  ssh_username TEXT,
  ssh_auth_method TEXT,
  ssh_password TEXT,
  ssh_private_key TEXT,
  ssh_private_key_path TEXT,
  ssh_private_key_passphrase TEXT,
  ssh_host_key_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "database_sqlite_connections" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  group_name TEXT,
  environment TEXT NOT NULL DEFAULT 'development',
  file_path TEXT NOT NULL DEFAULT '',
  read_only INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "database_mysql_connections" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  group_name TEXT,
  environment TEXT NOT NULL DEFAULT 'development',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 3306,
  database_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password TEXT,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "jar_preferences" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  font_size REAL NOT NULL DEFAULT 12,
  single_line_tabs INTEGER NOT NULL DEFAULT 0,
  escape_unicode INTEGER NOT NULL DEFAULT 0,
  realign_line_numbers INTEGER NOT NULL DEFAULT 0,
  write_line_numbers INTEGER NOT NULL DEFAULT 1,
  write_metadata INTEGER NOT NULL DEFAULT 1,
  maven_enabled INTEGER NOT NULL DEFAULT 1,
  maven_filters TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "jar_recent_files" (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "jar_find_history" (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "app_settings" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  language TEXT NOT NULL DEFAULT 'auto',
  theme TEXT NOT NULL DEFAULT 'dark',
  auto_reconnect INTEGER NOT NULL DEFAULT 1,
  log_level TEXT NOT NULL DEFAULT 'info',
  max_log_size INTEGER NOT NULL DEFAULT 100,
  save_passwords INTEGER NOT NULL DEFAULT 0,
  auto_lock_timeout INTEGER NOT NULL DEFAULT 30,
  host_key_verification INTEGER NOT NULL DEFAULT 1,
  enable_notifications INTEGER NOT NULL DEFAULT 1,
  show_connection_manager INTEGER NOT NULL DEFAULT 1,
  show_system_monitor INTEGER NOT NULL DEFAULT 1,
  show_status_bar INTEGER NOT NULL DEFAULT 1,
  connection_timeout INTEGER NOT NULL DEFAULT 30,
  keep_alive_interval INTEGER NOT NULL DEFAULT 60,
  default_protocol TEXT NOT NULL DEFAULT 'SSH',
  new_session_shortcut TEXT,
  close_session_shortcut TEXT,
  next_tab_shortcut TEXT,
  previous_tab_shortcut TEXT,
  follow_terminal_directory INTEGER NOT NULL DEFAULT 1,
  show_resources INTEGER NOT NULL DEFAULT 0,
  command_suggestions INTEGER NOT NULL DEFAULT 1,
  suggestion_debounce_ms INTEGER NOT NULL DEFAULT 50,
  suggestion_tui_gate_enabled INTEGER NOT NULL DEFAULT 1,
  api_active_env TEXT NOT NULL DEFAULT '',
  vault_salt TEXT,
  vault_iterations INTEGER,
  vault_verifier TEXT,
  vault_created_at INTEGER,
  vault_updated_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "layout_config" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  left_sidebar_visible INTEGER NOT NULL DEFAULT 1,
  left_sidebar_size REAL NOT NULL DEFAULT 15,
  right_sidebar_visible INTEGER NOT NULL DEFAULT 1,
  right_sidebar_size REAL NOT NULL DEFAULT 20,
  bottom_panel_visible INTEGER NOT NULL DEFAULT 1,
  bottom_panel_size REAL NOT NULL DEFAULT 30,
  zen_mode INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "terminal_appearance" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  font_size REAL NOT NULL DEFAULT 14,
  font_family TEXT NOT NULL DEFAULT 'Menlo, Monaco, monospace',
  line_height REAL NOT NULL DEFAULT 1.2,
  letter_spacing REAL NOT NULL DEFAULT 0,
  cursor_style TEXT NOT NULL DEFAULT 'block',
  cursor_blink INTEGER NOT NULL DEFAULT 1,
  theme TEXT NOT NULL DEFAULT 'vs-code-dark',
  scrollback INTEGER NOT NULL DEFAULT 10000,
  allow_transparency INTEGER NOT NULL DEFAULT 0,
  opacity REAL NOT NULL DEFAULT 1,
  background_image TEXT NOT NULL DEFAULT '',
  background_image_opacity INTEGER NOT NULL DEFAULT 100,
  background_image_blur INTEGER NOT NULL DEFAULT 0,
  background_image_position TEXT NOT NULL DEFAULT 'cover',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "editor_config" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'oneDark',
  font_size INTEGER NOT NULL DEFAULT 14,
  font_family TEXT NOT NULL DEFAULT "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
  line_numbers INTEGER NOT NULL DEFAULT 1,
  word_wrap INTEGER NOT NULL DEFAULT 1,
  tab_size INTEGER NOT NULL DEFAULT 2,
  highlight_active_line INTEGER NOT NULL DEFAULT 1,
  fold_gutter INTEGER NOT NULL DEFAULT 1,
  bracket_matching INTEGER NOT NULL DEFAULT 1,
  match_brackets INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "workspace_meta" (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_group_id TEXT NOT NULL DEFAULT '',
  next_group_id INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "workspace_groups" (
  group_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0,
  active_tab_id TEXT,
  direction TEXT,
  size REAL NOT NULL DEFAULT 1,
  parent_id TEXT
);
CREATE TABLE IF NOT EXISTS "workspace_tabs" (
  tab_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  tab_type TEXT,
  protocol TEXT,
  host TEXT,
  username TEXT,
  original_connection_id TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected',
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  editor_file_path TEXT,
  editor_connection_id TEXT,
  tools_tab_view TEXT
);
CREATE TABLE IF NOT EXISTS "workspace_grid_nodes" (
  node_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  direction TEXT,
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  size REAL NOT NULL DEFAULT 1,
  group_id TEXT
);
CREATE TABLE IF NOT EXISTS "documents" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT,
  head_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "document_versions" (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  model TEXT NOT NULL,
  model_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "document_resources" (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  data BLOB NOT NULL,
  sha256 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "jar_projects" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  jar_path TEXT NOT NULL DEFAULT '',
  jar_hash TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  class_count INTEGER NOT NULL DEFAULT 0,
  resource_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "jar_classes" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  library_id TEXT NOT NULL DEFAULT '',
  entry_path TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  package_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'class',
  is_inner_class INTEGER NOT NULL DEFAULT 0,
  modified_source TEXT,
  modified INTEGER NOT NULL DEFAULT 0,
  compile_status TEXT NOT NULL DEFAULT 'none',
  compile_output TEXT,
  compile_timestamp INTEGER,
  source_hash TEXT
);
CREATE TABLE IF NOT EXISTS "jar_builds" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  output_path TEXT NOT NULL DEFAULT '',
  built_at INTEGER NOT NULL,
  result TEXT NOT NULL DEFAULT 'ok',
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_jar_classes_project ON jar_classes(project_id);
CREATE INDEX IF NOT EXISTS idx_jar_builds_project ON jar_builds(project_id);
CREATE TABLE IF NOT EXISTS "jar_libraries" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  artifact_id TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  jar_path TEXT NOT NULL DEFAULT '',
  jar_hash TEXT NOT NULL DEFAULT '',
  class_count INTEGER NOT NULL DEFAULT 0,
  editable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "jar_symbols" (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'method',
  line INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS "jar_subtypes" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  super_name TEXT NOT NULL,
  sub_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jar_libraries_project ON jar_libraries(project_id);
CREATE INDEX IF NOT EXISTS idx_jar_symbols_class ON jar_symbols(class_id);
CREATE INDEX IF NOT EXISTS idx_jar_symbols_name ON jar_symbols(name);
CREATE INDEX IF NOT EXISTS idx_jar_symbols_project ON jar_symbols(project_id);
CREATE INDEX IF NOT EXISTS idx_jar_subtypes_super ON jar_subtypes(super_name);
CREATE INDEX IF NOT EXISTS idx_jar_subtypes_sub ON jar_subtypes(sub_name);
CREATE INDEX IF NOT EXISTS idx_jar_subtypes_project ON jar_subtypes(project_id);
"#;

#[cfg(test)]
mod upsert_tests {
    use super::*;
    use serde_json::json;

    fn open_test_db() -> DbState {
        // Unique file per invocation: tests run in parallel threads and a
        // shared path caused "disk I/O error" / "readonly database" races.
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "nexterm-db-test-{}-{}.db",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = std::fs::remove_file(&path);

        DbState::open(&path).expect("open test db")
    }

    fn upsert_raw(
        state: &DbState,
        table: &str,
        row: JsonMap<String, JsonValue>,
    ) -> Result<(), String> {
        let pk = pk_column(table)?.to_string();
        let conn = state.conn.lock().map_err(|_| "lock".to_string())?;
        let columns = table_columns(&conn, table)?;
        let mut names: Vec<String> = Vec::new();
        let mut params: Vec<SqlValue> = Vec::new();
        for col in &columns {
            if let Some(v) = row.get(col) {
                names.push(col.clone());
                params.push(json_to_sql(v));
            }
        }
        let quoted: Vec<String> = names.iter().map(|c| format!("\"{}\"", c)).collect();
        let placeholders: Vec<String> = (1..=names.len()).map(|i| format!("?{}", i)).collect();
        let assigns: Vec<String> = names
            .iter()
            .map(|c| format!("\"{}\" = excluded.\"{}\"", c, c))
            .collect();
        let sql = format!(
            "INSERT INTO \"{}\" ({}) VALUES ({}) ON CONFLICT(\"{}\") DO UPDATE SET {}",
            table,
            quoted.join(", "),
            placeholders.join(", "),
            pk,
            assigns.join(", ")
        );
        conn.execute(&sql, params_from_iter(params.iter()))
            .map_err(|e| format!("upsert: {}", e))?;
        Ok(())
    }

    #[test]
    fn workspace_replace_rolls_back_when_any_row_is_invalid() {
        let state = open_test_db();
        let request = WorkspaceReplaceRequest {
            meta: serde_json::from_value(json!({
                "id": 1,
                "active_group_id": "g1",
                "next_group_id": 2,
                "updated_at": 1
            }))
            .unwrap(),
            groups: vec![serde_json::from_value(json!({
                "group_id": "g1",
                "position": 0,
                "active_tab_id": "t1"
            }))
            .unwrap()],
            tabs: vec![serde_json::from_value(json!({
                "tab_id": "t1",
                "group_id": "g1",
                "position": 0,
                "name": "Terminal"
            }))
            .unwrap()],
            grid_nodes: vec![serde_json::from_value(json!({
                "node_id": "0",
                "type": "leaf",
                "direction": null,
                "parent_id": null,
                "position": 0,
                "size": 1,
                "group_id": "g1"
            }))
            .unwrap()],
        };
        {
            let mut conn = state.conn.lock().unwrap();
            replace_workspace(&mut conn, &request).expect("initial workspace replace");
        }

        let invalid = WorkspaceReplaceRequest {
            meta: serde_json::from_value(json!({
                "id": 1,
                "active_group_id": "g2",
                "next_group_id": 3,
                "updated_at": 2
            }))
            .unwrap(),
            groups: Vec::new(),
            // Missing `tab_id` (the table's primary key) must reject and roll
            // back the already-cleared/deleted workspace rows.
            tabs: vec![JsonMap::new()],
            grid_nodes: Vec::new(),
        };
        {
            let mut conn = state.conn.lock().unwrap();
            let error = replace_workspace(&mut conn, &invalid).unwrap_err();
            assert!(error.contains("primary key"));
        }

        let conn = state.conn.lock().unwrap();
        let tabs: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_tabs", [], |row| row.get(0))
            .unwrap();
        let active_group: String = conn
            .query_row(
                "SELECT active_group_id FROM workspace_meta WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tabs, 1, "failed replacement must preserve the old snapshot");
        assert_eq!(active_group, "g1");
    }

    #[test]
    fn upsert_connection_row_with_all_columns() {
        let state = open_test_db();
        let mut row = serde_json::Map::new();
        row.insert("id".into(), json!("conn-1"));
        row.insert("name".into(), json!("Test Server"));
        row.insert("host".into(), json!("192.168.1.1"));
        row.insert("port".into(), json!(22));
        row.insert("username".into(), json!("root"));
        row.insert("protocol".into(), json!("SSH"));
        row.insert("folder".into(), json!("All Connections/Personal"));
        row.insert("created_at".into(), json!("2026-01-01T00:00:00Z"));
        row.insert("last_connected".into(), json!("2026-01-01T00:00:00Z"));
        row.insert("auth_method".into(), json!("password"));
        row.insert("password".into(), json!("encrypted-blob"));
        row.insert("proxy_type".into(), json!("http"));
        row.insert("proxy_host".into(), json!("proxy.local"));
        row.insert("jump_host".into(), json!("bastion.local"));
        row.insert("jump_port".into(), json!(22));
        row.insert("jump_username".into(), json!("jumpuser"));
        row.insert("jump_password".into(), json!("encrypted-jump"));
        row.insert("jump_use_key".into(), json!(0));
        row.insert("sort_order".into(), json!(3));
        upsert_raw(&state, "connections", row).expect("upsert must succeed");

        let conn = state.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM connections WHERE id='conn-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "connection row must be persisted");
    }

    #[test]
    fn creates_and_upserts_sqlite_connection_profiles_without_reserved_names() {
        let state = open_test_db();
        let mut row = serde_json::Map::new();
        row.insert("id".into(), json!("sqlite-profile"));
        row.insert("name".into(), json!("Fixture SQLite"));
        row.insert("environment".into(), json!("test"));
        row.insert("file_path".into(), json!("/tmp/fixture.db"));
        row.insert("read_only".into(), json!(0));
        row.insert("created_at".into(), json!(1));
        row.insert("updated_at".into(), json!(1));
        upsert_raw(&state, "database_sqlite_connections", row)
            .expect("SQLite profile upsert must succeed");

        let conn = state.conn.lock().unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM database_sqlite_connections WHERE id='sqlite-profile'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Fixture SQLite");
    }

    /// Mirrors the frontend `connToRow` + `persistConnection` output (every
    /// column of the connections table, encrypted fields as opaque strings).
    #[test]
    fn upsert_full_connection_row_mirroring_frontend() {
        let state = open_test_db();
        let mut row = serde_json::Map::new();
        row.insert("id".into(), json!("conn-full"));
        row.insert("name".into(), json!("Full"));
        row.insert("host".into(), json!("h"));
        row.insert("port".into(), json!(2222));
        row.insert("username".into(), json!("u"));
        row.insert("protocol".into(), json!("SSH"));
        row.insert("folder".into(), json!("All Connections/Work"));
        row.insert("profile_id".into(), JsonValue::Null);
        row.insert("created_at".into(), json!("2026-01-01T00:00:00.000Z"));
        row.insert("last_connected".into(), json!("2026-01-02T00:00:00.000Z"));
        row.insert("favorite".into(), json!(0));
        row.insert("color".into(), JsonValue::Null);
        row.insert("tags".into(), JsonValue::Null);
        row.insert("description".into(), JsonValue::Null);
        row.insert("auth_method".into(), json!("password"));
        row.insert("password".into(), json!("cipher"));
        row.insert("private_key_path".into(), JsonValue::Null);
        row.insert("passphrase".into(), json!("cipher2"));
        row.insert("ftps_enabled".into(), json!(0));
        row.insert("proxy_type".into(), json!("http"));
        row.insert("proxy_host".into(), json!("proxy.local"));
        row.insert("proxy_port".into(), json!(8080));
        row.insert("proxy_username".into(), JsonValue::Null);
        row.insert("proxy_password".into(), json!("cipher3"));
        row.insert("jump_host".into(), json!("bastion.local"));
        row.insert("jump_port".into(), json!(22));
        row.insert("jump_username".into(), json!("ju"));
        row.insert("jump_password".into(), json!("cipher4"));
        row.insert("jump_use_key".into(), json!(0));
        row.insert("keep_alive".into(), json!(1));
        row.insert("keep_alive_interval".into(), json!(60));
        row.insert("server_alive_count_max".into(), json!(3));
        row.insert("domain".into(), JsonValue::Null);
        row.insert("rdp_resolution".into(), JsonValue::Null);
        row.insert("vnc_color_depth".into(), JsonValue::Null);
        row.insert("vnc_password".into(), json!("cipher5"));
        row.insert("sort_order".into(), JsonValue::Null);
        upsert_raw(&state, "connections", row).expect("full-row upsert must succeed");

        let conn = state.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM connections WHERE id='conn-full'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrates_old_jar_classes_library_id() {
        // Simulate a DB created before jar_classes had library_id.
        use std::sync::atomic::{AtomicU32, Ordering};
        static C: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "nexterm-db-jarmig-{}-{}.db",
            std::process::id(),
            C.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS "jar_classes" (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  entry_path TEXT NOT NULL,
                  class_name TEXT NOT NULL DEFAULT '',
                  package_name TEXT NOT NULL DEFAULT '',
                  kind TEXT NOT NULL DEFAULT 'class',
                  is_inner_class INTEGER NOT NULL DEFAULT 0,
                  original_decompiled TEXT,
                  modified_source TEXT,
                  modified INTEGER NOT NULL DEFAULT 0,
                  compile_status TEXT NOT NULL DEFAULT 'none',
                  compile_output TEXT,
                  compile_timestamp INTEGER,
                  source_hash TEXT
                );
                "#,
            )
            .unwrap();
            conn.execute("INSERT INTO jar_classes (id, project_id, entry_path, class_name) VALUES ('x', 'p', 'A.class', 'A')", [])
                .unwrap();
        }
        // Open triggers migration.
        let state = DbState::open(&path).expect("open migrates");
        let conn = state.conn.lock().unwrap();
        let cols = table_columns(&conn, "jar_classes").unwrap();
        assert!(
            cols.iter().any(|c| c == "library_id"),
            "library_id column missing: {cols:?}"
        );
        // Existing row is readable with library_id default ''.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM jar_classes WHERE library_id = ''",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn encrypted_backup_round_trips_without_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("source.db");
        let backup_path = dir.path().join("backup.nexbackup");
        let state = DbState::open(&db_path).unwrap();
        {
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO command_usage (command, count) VALUES (?1, 1)",
                ["sensitive test command"],
            )
            .unwrap();
        }

        state
            .export_encrypted_backup("correct horse battery staple", &backup_path)
            .unwrap();
        let exported = std::fs::read_to_string(&backup_path).unwrap();
        assert!(!exported.contains("sensitive test command"));

        {
            let conn = state.conn.lock().unwrap();
            conn.execute("DELETE FROM command_usage", []).unwrap();
        }
        state
            .restore_encrypted_backup("correct horse battery staple", &backup_path)
            .unwrap();
        let conn = state.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM command_usage", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
