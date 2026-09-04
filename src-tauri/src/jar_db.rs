//! JAR decompiler module — SQLite persistence layer.
//!
//! Stores project metadata, user modifications (modified_source only), symbol
//! navigation index and build logs. Decompiled sources are deliberately NOT
//! cached: the original JAR stays the single source of truth and every class is
//! re-decompiled on demand (JD-GUI semantics), so the DB stays tiny. Only the
//! user's own edits are persisted.

use rusqlite::{params, Connection, OptionalExtension};

pub type JarBuildRow = (String, i64, String, Option<String>);
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct JarProject {
    pub id: String,
    pub name: String,
    pub jar_path: String,
    pub jar_hash: String,
    pub size: i64,
    pub class_count: i64,
    pub resource_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct JarClassRow {
    pub id: String,
    pub project_id: String,
    pub library_id: String,
    pub entry_path: String,
    pub class_name: String,
    pub package_name: String,
    pub kind: String,
    pub is_inner_class: bool,
    pub modified_source: Option<String>,
    pub modified: bool,
    pub compile_status: String,
    pub compile_output: Option<String>,
    pub compile_timestamp: Option<i64>,
    pub source_hash: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JarLibrary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub jar_path: String,
    pub jar_hash: String,
    pub class_count: i64,
    pub editable: bool,
}

#[derive(Debug, Clone)]
pub struct JarSymbol {
    pub id: String,
    pub class_id: String,
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub line: i64,
    pub signature: String,
}

/// Open a connection (caller keeps it; DbState already holds one, but the jar
/// module uses its own for transaction isolation).
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open jar db: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("pragma: {e}"))?;
    // Idempotent migrations for DBs created by older app versions. CREATE
    // TABLE IF NOT EXISTS never alters existing tables, so apply them here
    // (each is a no-op when already applied).
    //
    // 1) jar_classes gained a library_id column.
    let _ = conn.execute(
        "ALTER TABLE jar_classes ADD COLUMN library_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    // 2) jar_classes dropped the original_decompiled column: decompiled
    //    sources are no longer cached (JD-GUI semantics, keeps the DB small).
    let _ = conn.execute(
        "ALTER TABLE jar_classes DROP COLUMN original_decompiled",
        [],
    );
    // 3) jar_versions table (compiled-byte history) is gone; compilation
    //    output is regenerated on demand.
    let _ = conn.execute("DROP TABLE IF EXISTS jar_versions", []);
    Ok(conn)
}

pub fn upsert_project(conn: &Connection, p: &JarProject) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jar_projects (id, name, jar_path, jar_hash, size, class_count, resource_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, jar_path = excluded.jar_path, jar_hash = excluded.jar_hash,
           size = excluded.size, class_count = excluded.class_count,
           resource_count = excluded.resource_count, updated_at = excluded.updated_at",
        params![p.id, p.name, p.jar_path, p.jar_hash, p.size, p.class_count, p.resource_count, p.created_at, p.updated_at],
    )
    .map_err(|e| format!("upsert jar_projects: {e}"))?;
    Ok(())
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<JarProject>, String> {
    conn.query_row(
        "SELECT id, name, jar_path, jar_hash, size, class_count, resource_count, created_at, updated_at
         FROM jar_projects WHERE id = ?1",
        [id],
        |r| {
            Ok(JarProject {
                id: r.get(0)?,
                name: r.get(1)?,
                jar_path: r.get(2)?,
                jar_hash: r.get(3)?,
                size: r.get(4)?,
                class_count: r.get(5)?,
                resource_count: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("get jar_projects: {e}"))
}

pub fn list_projects(conn: &Connection) -> Result<Vec<JarProject>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, jar_path, jar_hash, size, class_count, resource_count, created_at, updated_at FROM jar_projects ORDER BY updated_at DESC")
        .map_err(|e| format!("prepare list projects: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(JarProject {
                id: r.get(0)?,
                name: r.get(1)?,
                jar_path: r.get(2)?,
                jar_hash: r.get(3)?,
                size: r.get(4)?,
                class_count: r.get(5)?,
                resource_count: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })
        .map_err(|e| format!("query projects: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect projects: {e}"))?;
    Ok(rows)
}

pub fn delete_project(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM jar_projects WHERE id = ?1", [id])
        .map_err(|e| format!("delete project: {e}"))?;
    Ok(())
}

pub fn upsert_class(conn: &Connection, c: &JarClassRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jar_classes
           (id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
            modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, library_id = excluded.library_id, entry_path = excluded.entry_path,
           class_name = excluded.class_name, package_name = excluded.package_name,
           kind = excluded.kind, is_inner_class = excluded.is_inner_class,
           modified_source = excluded.modified_source, modified = excluded.modified,
           compile_status = excluded.compile_status, compile_output = excluded.compile_output,
           compile_timestamp = excluded.compile_timestamp, source_hash = excluded.source_hash",
        params![
            c.id,
            c.project_id,
            c.library_id,
            c.entry_path,
            c.class_name,
            c.package_name,
            c.kind,
            if c.is_inner_class { 1 } else { 0 },
            c.modified_source,
            if c.modified { 1 } else { 0 },
            c.compile_status,
            c.compile_output,
            c.compile_timestamp,
            c.source_hash,
        ],
    )
    .map_err(|e| format!("upsert jar_classes: {e}"))?;
    Ok(())
}

pub fn get_class(
    conn: &Connection,
    project_id: &str,
    entry_path: &str,
) -> Result<Option<JarClassRow>, String> {
    conn.query_row(
        "SELECT id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
                modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash
         FROM jar_classes WHERE project_id = ?1 AND entry_path = ?2",
        params![project_id, entry_path],
        |r| {
            Ok(JarClassRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                library_id: r.get(2)?,
                entry_path: r.get(3)?,
                class_name: r.get(4)?,
                package_name: r.get(5)?,
                kind: r.get(6)?,
                is_inner_class: r.get::<_, i64>(7)? != 0,
                modified_source: r.get(8)?,
                modified: r.get::<_, i64>(9)? != 0,
                compile_status: r.get(10)?,
                compile_output: r.get(11)?,
                compile_timestamp: r.get(12)?,
                source_hash: r.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("get jar_classes: {e}"))
}

pub fn get_class_by_id(conn: &Connection, id: &str) -> Result<Option<JarClassRow>, String> {
    conn.query_row(
        "SELECT id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
                modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash
         FROM jar_classes WHERE id = ?1",
        [id],
        |r| {
            Ok(JarClassRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                library_id: r.get(2)?,
                entry_path: r.get(3)?,
                class_name: r.get(4)?,
                package_name: r.get(5)?,
                kind: r.get(6)?,
                is_inner_class: r.get::<_, i64>(7)? != 0,
                modified_source: r.get(8)?,
                modified: r.get::<_, i64>(9)? != 0,
                compile_status: r.get(10)?,
                compile_output: r.get(11)?,
                compile_timestamp: r.get(12)?,
                source_hash: r.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("get jar_classes by id: {e}"))
}

pub fn list_classes(conn: &Connection, project_id: &str) -> Result<Vec<JarClassRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
                         modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash
                  FROM jar_classes WHERE project_id = ?1")
        .map_err(|e| format!("prepare list classes: {e}"))?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok(JarClassRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                library_id: r.get(2)?,
                entry_path: r.get(3)?,
                class_name: r.get(4)?,
                package_name: r.get(5)?,
                kind: r.get(6)?,
                is_inner_class: r.get::<_, i64>(7)? != 0,
                modified_source: r.get(8)?,
                modified: r.get::<_, i64>(9)? != 0,
                compile_status: r.get(10)?,
                compile_output: r.get(11)?,
                compile_timestamp: r.get(12)?,
                source_hash: r.get(13)?,
            })
        })
        .map_err(|e| format!("query classes: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect classes: {e}"))?;
    Ok(rows)
}

pub fn list_modified_classes(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<JarClassRow>, String> {
    Ok(list_classes(conn, project_id)?
        .into_iter()
        .filter(|c| c.modified && c.kind == "class")
        .collect())
}

pub fn delete_classes_for_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM jar_classes WHERE project_id = ?1",
        [project_id],
    )
    .map_err(|e| format!("delete classes: {e}"))?;
    Ok(())
}

pub fn insert_build(
    conn: &Connection,
    project_id: &str,
    output_path: &str,
    result: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jar_builds (project_id, output_path, built_at, result, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, output_path, now_ms(), result, detail],
    )
    .map_err(|e| format!("insert jar_builds: {e}"))?;
    Ok(())
}

pub fn list_builds(conn: &Connection, project_id: &str) -> Result<Vec<JarBuildRow>, String> {
    let mut stmt = conn
        .prepare("SELECT output_path, built_at, result, detail FROM jar_builds WHERE project_id = ?1 ORDER BY built_at DESC LIMIT 50")
        .map_err(|e| format!("prepare builds: {e}"))?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| format!("query builds: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect builds: {e}"))?;
    Ok(rows)
}

/// Minimal schema for tests (mirrors the jar_* tables created by db.rs).
/// Public so integration tests (tests/*.rs) build the same schema.
#[allow(dead_code)]
pub const TEST_DDL: &str = r#"
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
"#;

// ── Jar libraries (dependency jars) ───────────────────────────────────────

pub fn upsert_library(conn: &Connection, l: &JarLibrary) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jar_libraries (id, project_id, name, group_id, artifact_id, version, jar_path, jar_hash, class_count, editable)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, group_id = excluded.group_id, artifact_id = excluded.artifact_id,
           version = excluded.version, jar_path = excluded.jar_path, jar_hash = excluded.jar_hash,
           class_count = excluded.class_count, editable = excluded.editable",
        params![
            l.id,
            l.project_id,
            l.name,
            l.group_id,
            l.artifact_id,
            l.version,
            l.jar_path,
            l.jar_hash,
            l.class_count,
            if l.editable { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("upsert jar_libraries: {e}"))?;
    Ok(())
}

pub fn list_libraries(conn: &Connection, project_id: &str) -> Result<Vec<JarLibrary>, String> {
    let mut stmt = conn
        .prepare("SELECT id, project_id, name, group_id, artifact_id, version, jar_path, jar_hash, class_count, editable FROM jar_libraries WHERE project_id = ?1 ORDER BY name")
        .map_err(|e| format!("prepare libraries: {e}"))?;
    let rows = stmt
        .query_map([project_id], |r| {
            Ok(JarLibrary {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                group_id: r.get(3)?,
                artifact_id: r.get(4)?,
                version: r.get(5)?,
                jar_path: r.get(6)?,
                jar_hash: r.get(7)?,
                class_count: r.get(8)?,
                editable: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|e| format!("query libraries: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect libraries: {e}"))?;
    Ok(rows)
}

pub fn get_library(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> Result<Option<JarLibrary>, String> {
    conn.query_row(
        "SELECT id, project_id, name, group_id, artifact_id, version, jar_path, jar_hash, class_count, editable FROM jar_libraries WHERE project_id = ?1 AND id = ?2",
        params![project_id, id],
        |r| {
            Ok(JarLibrary {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                group_id: r.get(3)?,
                artifact_id: r.get(4)?,
                version: r.get(5)?,
                jar_path: r.get(6)?,
                jar_hash: r.get(7)?,
                class_count: r.get(8)?,
                editable: r.get::<_, i64>(9)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| format!("get jar_libraries: {e}"))
}

pub fn delete_libraries_for_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM jar_libraries WHERE project_id = ?1",
        [project_id],
    )
    .map_err(|e| format!("delete libraries: {e}"))?;
    Ok(())
}

// ── Symbols (method declarations for navigation) ──────────────────────────

pub fn upsert_symbol(conn: &Connection, s: &JarSymbol) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jar_symbols (id, class_id, project_id, name, kind, line, signature)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           class_id = excluded.class_id, name = excluded.name, kind = excluded.kind,
           line = excluded.line, signature = excluded.signature",
        params![
            s.id,
            s.class_id,
            s.project_id,
            s.name,
            s.kind,
            s.line,
            s.signature
        ],
    )
    .map_err(|e| format!("upsert jar_symbols: {e}"))?;
    Ok(())
}

pub fn delete_symbols_for_class(conn: &Connection, class_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM jar_symbols WHERE class_id = ?1", [class_id])
        .map_err(|e| format!("delete symbols: {e}"))?;
    Ok(())
}

/// Delete every symbol row of a project (used before re-indexing).
pub fn delete_symbols_for_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM jar_symbols WHERE project_id = ?1",
        [project_id],
    )
    .map_err(|e| format!("delete symbols: {e}"))?;
    Ok(())
}

/// Bulk insert symbols. Mirrors JD-GUI's methodDeclarations/fieldDeclarations
/// indexes: every declared method/field name of a class becomes a symbol row,
/// so click-to-navigate by member name works across the whole project.
/// Accepts a `&Connection` or a `&Transaction` (via Deref).
pub fn insert_symbols_batch(
    conn: &rusqlite::Connection,
    project_id: &str,
    class_id: &str,
    members: &crate::jar::ClassMembers,
    line_for: &dyn Fn(&str, &str) -> i64,
) -> Result<(), String> {
    {
        let mut insert = conn
            .prepare(
                "INSERT OR REPLACE INTO jar_symbols (id, class_id, project_id, name, kind, line, signature)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| format!("prepare symbol insert: {e}"))?;
        let mut push = |name: &str, kind: &str, line: i64| -> Result<(), String> {
            let id = format!("{class_id}|{kind}|{name}");
            insert
                .execute(params![id, class_id, project_id, name, kind, line, ""])
                .map_err(|e| format!("insert symbol {name}: {e}"))?;
            Ok(())
        };
        for m in &members.methods {
            push(m, "method", line_for(m, "method"))?;
        }
        for f in &members.fields {
            push(f, "field", line_for(f, "field"))?;
        }
        if !members.constructors.is_empty() {
            push("<init>", "constructor", 0)?;
        }
    }
    Ok(())
}

pub fn list_symbols_for_class(conn: &Connection, class_id: &str) -> Result<Vec<JarSymbol>, String> {
    let mut stmt = conn
        .prepare("SELECT id, class_id, project_id, name, kind, line, signature FROM jar_symbols WHERE class_id = ?1 ORDER BY line")
        .map_err(|e| format!("prepare symbols: {e}"))?;
    let rows = stmt
        .query_map([class_id], |r| {
            Ok(JarSymbol {
                id: r.get(0)?,
                class_id: r.get(1)?,
                project_id: r.get(2)?,
                name: r.get(3)?,
                kind: r.get(4)?,
                line: r.get(5)?,
                signature: r.get(6)?,
            })
        })
        .map_err(|e| format!("query symbols: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect symbols: {e}"))?;
    Ok(rows)
}

/// Find symbols by name across a project (for click-to-navigate).
pub fn find_symbols_by_name(
    conn: &Connection,
    project_id: &str,
    name: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare("SELECT s.id, s.class_id, s.project_id, s.name, s.kind, s.line, s.signature, c.class_name, c.entry_path, c.library_id
                  FROM jar_symbols s JOIN jar_classes c ON c.id = s.class_id
                  WHERE s.project_id = ?1 AND s.name = ?2 LIMIT 50")
        .map_err(|e| format!("prepare find symbols: {e}"))?;
    let rows = stmt
        .query_map(params![project_id, name], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "classId": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(3)?,
                "kind": r.get::<_, String>(4)?,
                "line": r.get::<_, i64>(5)?,
                "signature": r.get::<_, String>(6)?,
                "className": r.get::<_, String>(7)?,
                "entryPath": r.get::<_, String>(8)?,
                "libraryId": r.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| format!("query find symbols: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect find symbols: {e}"))?;
    Ok(rows)
}

// ── Subtypes (JD-GUI subTypeNames index) ─────────────────────────────────

/// Clear the subtype index of a project (before re-indexing).
pub fn delete_subtypes_for_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM jar_subtypes WHERE project_id = ?1",
        [project_id],
    )
    .map_err(|e| format!("delete subtypes: {e}"))?;
    Ok(())
}

/// Bulk insert super→sub edges. `edges` = (super_name, sub_name) pairs using
/// dotted class names.
pub fn insert_subtype_edges_batch(
    conn: &rusqlite::Connection,
    project_id: &str,
    edges: &[(String, String)],
) -> Result<(), String> {
    if edges.is_empty() {
        return Ok(());
    }
    {
        let mut insert = conn
            .prepare(
                "INSERT OR REPLACE INTO jar_subtypes (id, project_id, super_name, sub_name)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("prepare subtype insert: {e}"))?;
        for (sup, sub) in edges {
            let id = format!("{project_id}|{sup}|{sub}");
            insert
                .execute(params![id, project_id, sup, sub])
                .map_err(|e| format!("insert subtype {sup}→{sub}: {e}"))?;
        }
    }
    Ok(())
}

/// Subtypes of a type (its direct children) across the project.
pub fn list_subtype_names(
    conn: &Connection,
    project_id: &str,
    super_name: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT sub_name FROM jar_subtypes WHERE project_id = ?1 AND super_name = ?2 ORDER BY sub_name")
        .map_err(|e| format!("prepare list subtypes: {e}"))?;
    let rows = stmt
        .query_map(params![project_id, super_name], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query subtypes: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect subtypes: {e}"))?;
    Ok(rows)
}

/// The superclass of a type (single edge; used for the parent chain).
pub fn list_super_names(
    conn: &Connection,
    project_id: &str,
    sub_name: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT super_name FROM jar_subtypes WHERE project_id = ?1 AND sub_name = ?2")
        .map_err(|e| format!("prepare list supers: {e}"))?;
    let rows = stmt
        .query_map(params![project_id, sub_name], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query supers: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect supers: {e}"))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn test_conn() -> Connection {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("jar-db-test-{}-{n}.db", std::process::id()));
        let conn = open(&path).unwrap();
        conn.execute_batch(TEST_DDL).unwrap();
        conn
    }

    #[test]
    fn project_crud() {
        let conn = test_conn();
        let p = JarProject {
            id: "p1".into(),
            name: "app.jar".into(),
            jar_path: "/tmp/app.jar".into(),
            jar_hash: "abc".into(),
            size: 100,
            class_count: 2,
            resource_count: 1,
            created_at: 1,
            updated_at: 1,
        };
        upsert_project(&conn, &p).unwrap();
        let got = get_project(&conn, "p1").unwrap().unwrap();
        assert_eq!(got.name, "app.jar");
        assert_eq!(list_projects(&conn).unwrap().len(), 1);
        delete_project(&conn, "p1").unwrap();
        assert!(get_project(&conn, "p1").unwrap().is_none());
    }

    #[test]
    fn class_modification_crud() {
        let conn = test_conn();
        let p = JarProject {
            id: "p1".into(),
            name: "app.jar".into(),
            jar_path: "/tmp/app.jar".into(),
            jar_hash: "abc".into(),
            size: 100,
            class_count: 1,
            resource_count: 0,
            created_at: 1,
            updated_at: 1,
        };
        upsert_project(&conn, &p).unwrap();
        let c = JarClassRow {
            id: "p1:com/example/Foo.class".into(),
            project_id: "p1".into(),
            library_id: "".into(),
            entry_path: "com/example/Foo.class".into(),
            class_name: "com.example.Foo".into(),
            package_name: "com.example".into(),
            kind: "class".into(),
            is_inner_class: false,
            modified_source: None,
            modified: false,
            compile_status: "none".into(),
            compile_output: None,
            compile_timestamp: None,
            source_hash: None,
        };
        upsert_class(&conn, &c).unwrap();
        assert_eq!(list_classes(&conn, "p1").unwrap().len(), 1);
        assert!(list_modified_classes(&conn, "p1").unwrap().is_empty());

        // 保存修改后的源码后，对应行应标记为已修改。
        let c2 = JarClassRow {
            modified_source: Some("public class Foo { int x; }".into()),
            modified: true,
            compile_status: "stale".into(),
            source_hash: Some(crate::jar::sha256_bytes(b"public class Foo { int x; }")),
            ..c.clone()
        };
        upsert_class(&conn, &c2).unwrap();
        let got = get_class(&conn, "p1", "com/example/Foo.class")
            .unwrap()
            .unwrap();
        assert!(got.modified);
        assert_eq!(
            got.modified_source.as_deref(),
            Some("public class Foo { int x; }")
        );
        assert_eq!(list_modified_classes(&conn, "p1").unwrap().len(), 1);
    }
}
