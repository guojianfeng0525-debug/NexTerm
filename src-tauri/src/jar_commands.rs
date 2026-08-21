//! JAR decompiler — Tauri command layer.
//!
//! Wires jar.rs (parsing), decompile.rs (CFR), compile.rs (javac),
//! builder.rs (JAR rebuild) and jar_db.rs (SQLite) into async commands.
//! Heavy work (indexing, decompile, compile, build) runs on the blocking
//! pool; quick SQLite access runs inline.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::builder;
use crate::compile;
use crate::decompile;
use crate::jar;
use crate::jar_db;

/// Shared state: path to the SQLite file + per-project cancellation flags.
/// A fresh `rusqlite::Connection` is opened per command — connections are not
/// `Clone` and cannot cross `await` points inside a `MutexGuard`.
pub struct JarState {
    /// Path to the nexterm.db file (shared with the rest of the app).
    pub db_path: std::path::PathBuf,
    /// project_id → cancel flag for the active decompile/compile/build.
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Where decompile/compile scratch dirs live.
    pub scratch: PathBuf,
    /// Tauri resource dir (bundled cfr/ lives here). Resolved at startup so
    /// the CFR jar is found on every platform, including Windows exe layout.
    pub resource_dir: Option<std::path::PathBuf>,
}

impl JarState {
    /// Locate the bundled CFR jar, preferring the Tauri resource dir.
    pub fn cfr_jar(&self) -> Result<std::path::PathBuf, String> {
        decompile::find_cfr_jar_with(self.resource_dir.as_deref())
    }
}

impl JarState {
    /// Open a fresh connection to the shared SQLite file.
    pub fn conn(&self) -> Result<rusqlite::Connection, String> {
        jar_db::open(&self.db_path)
    }

    fn cancel_flag(&self, project_id: &str) -> Arc<AtomicBool> {
        let mut map = self.cancels.lock().expect("cancels poisoned");
        map.entry(project_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }
}

// ── Response types ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub jar_path: String,
    pub jar_hash: String,
    pub size: i64,
    pub class_count: i64,
    pub resource_count: i64,
    pub class_tree: std::collections::BTreeMap<String, jar::PackageNode>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassView {
    pub entry_path: String,
    pub class_name: String,
    pub package_name: String,
    pub kind: String,
    pub is_inner_class: bool,
    pub source: String,
    pub original_source: Option<String>,
    pub modified: bool,
    pub compile_status: String,
    pub compile_output: Option<String>,
    /// Bytecode-level references (JD-GUI printReference equivalent): every
    /// type/field/method the class points at, with exact internal names.
    pub refs: Vec<jar::ClassRef>,
    /// This class's own method declarations (name → source line), used to
    /// jump to a method inside the current editor (JD-GUI: references to the
    /// class itself resolve within the same page, no new tab).
    pub methods: Vec<MethodLine>,
}

/// A method declaration of the currently-open class.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodLine {
    pub name: String,
    pub line: i64,
}

// ── Open / list / delete project ──────────────────────────────────────────

#[tauri::command]
pub async fn jar_project_open(
    path: String,
    state: State<'_, JarState>,
) -> Result<ProjectSummary, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_file() {
        return Err(format!("JAR file not found: {}", path_buf.display()));
    }

    // Heavy: index (spawn_blocking).
    let path_for_index = path_buf.clone();
    let idx = tauri::async_runtime::spawn_blocking(move || jar::index_jar(&path_for_index))
        .await
        .map_err(|e| e.to_string())??;

    let mut conn = state.conn()?;

    let name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled.jar".into());
    let id = format!("jar-{}", &idx.jar_hash[..16.min(idx.jar_hash.len())]);

    let existing = jar_db::get_project(&conn, &id)?;
    let now = jar_db::now_ms();
    let (created_at, updated_at) = match &existing {
        Some(p) => (p.created_at, now),
        None => (now, now),
    };

    let hash_changed = existing
        .as_ref()
        .map(|p| p.jar_hash != idx.jar_hash)
        .unwrap_or(true);
    if hash_changed {
        jar_db::delete_classes_for_project(&conn, &id)?;
        let project = jar_db::JarProject {
            id: id.clone(),
            name: name.clone(),
            jar_path: path_buf.display().to_string(),
            jar_hash: idx.jar_hash.clone(),
            size: idx.size as i64,
            class_count: idx.class_count as i64,
            resource_count: idx.resource_count as i64,
            created_at,
            updated_at,
        };
        jar_db::upsert_project(&conn, &project)?;

        // Batch insert all classes in one transaction (large jars: thousands
        // of rows — per-row autocommit is the main first-open cost).
        {
            let tx = conn
                .transaction()
                .map_err(|e| format!("begin tx: {e}"))?;
            {
                let mut insert = tx
                    .prepare(
                        "INSERT OR REPLACE INTO jar_classes
                           (id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
                            modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash)
                         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, NULL, 0, 'none', NULL, NULL, NULL)",
                    )
                    .map_err(|e| format!("prepare insert: {e}"))?;
                for e in &idx.entries {
                    insert
                        .execute(rusqlite::params![
                            format!("{id}:{}", e.entry_path),
                            id,
                            e.entry_path,
                            e.class_name,
                            e.package_name,
                            e.kind,
                            e.is_inner_class,
                        ])
                        .map_err(|er| format!("insert class: {er}"))?;
                }
            }
            tx.commit().map_err(|e| format!("commit tx: {e}"))?;
        }
    } else {
        jar_db::upsert_project(
            &conn,
            &jar_db::JarProject {
                id: id.clone(),
                name: name.clone(),
                jar_path: path_buf.display().to_string(),
                jar_hash: idx.jar_hash.clone(),
                size: idx.size as i64,
                class_count: idx.class_count as i64,
                resource_count: idx.resource_count as i64,
                created_at,
                updated_at,
            },
        )?;
    }

    // Index nested archives (Spring Boot BOOT-INF/lib/*.jar, WEB-INF/lib/*.jar).
    // Mirrors JD-GUI's recursive container model: nested jars become read-only
    // libraries so their classes are navigable / searchable. Extraction +
    // indexing run in parallel; inserts are batched in a transaction.
    if hash_changed {
        let main_path = path_buf.clone();
        let scratch_root = state.scratch.join(format!("{id}-nested"));
        let nested = tauri::async_runtime::spawn_blocking(move || {
            jar::extract_and_index_nested(&main_path, &scratch_root)
        })
        .await
        .map_err(|e| e.to_string())?;

        let mut conn = state.conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin tx: {e}"))?;
        {
            let mut insert = tx
                .prepare(
                    "INSERT OR REPLACE INTO jar_classes
                       (id, project_id, library_id, entry_path, class_name, package_name, kind, is_inner_class,
                        modified_source, modified, compile_status, compile_output, compile_timestamp, source_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, 'none', NULL, NULL, NULL)",
                )
                .map_err(|e| format!("prepare insert: {e}"))?;
            for (ename, extracted, nested_idx) in &nested {
                let lib_id = format!(
                    "{id}:nested:{}",
                    crate::jar::sha256_bytes(ename.as_bytes()).get(..12).unwrap_or("n")
                );
                let base_name = ename.rsplit('/').next().unwrap_or(ename);
                let lib = jar_db::JarLibrary {
                    id: lib_id.clone(),
                    project_id: id.clone(),
                    name: format!("[nested] {base_name}|{ename}"),
                    group_id: String::new(),
                    artifact_id: base_name.replace(".jar", ""),
                    version: String::new(),
                    jar_path: extracted.clone(),
                    jar_hash: nested_idx.jar_hash.clone(),
                    class_count: nested_idx.class_count as i64,
                    editable: false,
                };
                jar_db::upsert_library(&tx, &lib)?;
                for e in &nested_idx.entries {
                    insert
                        .execute(rusqlite::params![
                            format!("{lib_id}:{}", e.entry_path),
                            id,
                            lib_id,
                            e.entry_path,
                            e.class_name,
                            e.package_name,
                            e.kind,
                            e.is_inner_class,
                        ])
                        .map_err(|er| format!("insert class: {er}"))?;
                }
            }
        }
        tx.commit().map_err(|e| format!("commit tx: {e}"))?;
    }

    let tree = jar::build_tree(&idx.entries);
    Ok(ProjectSummary {
        id,
        name,
        jar_path: path_buf.display().to_string(),
        jar_hash: idx.jar_hash,
        size: idx.size as i64,
        class_count: idx.class_count as i64,
        resource_count: idx.resource_count as i64,
        class_tree: tree,
        created_at,
        updated_at,
    })
}

#[tauri::command]
pub async fn jar_project_list(state: State<'_, JarState>) -> Result<Vec<ProjectSummary>, String> {
    let conn = state.conn()?;
    let projects = jar_db::list_projects(&conn)?;
    Ok(projects
        .into_iter()
        .map(|p| ProjectSummary {
            id: p.id,
            name: p.name,
            jar_path: p.jar_path,
            jar_hash: p.jar_hash,
            size: p.size,
            class_count: p.class_count,
            resource_count: p.resource_count,
            class_tree: Default::default(),
            created_at: p.created_at,
            updated_at: p.updated_at,
        })
        .collect())
}

#[tauri::command]
pub async fn jar_project_delete(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<(), String> {
    let conn = state.conn()?;
    jar_db::delete_project(&conn, &project_id)?;
    state.cancels.lock().expect("poisoned").remove(&project_id);
    Ok(())
}

// ── Class tree / search ───────────────────────────────────────────────────

/// Reopen a previously-indexed project from the DB (no re-indexing). Used by
/// cross-project Open Type navigation (JD-GUI: every open file is navigable).
#[tauri::command]
pub async fn jar_project_reopen(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<ProjectSummary, String> {
    let conn = state.conn()?;
    let p = jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM jar_classes WHERE project_id = ?1 AND kind = 'class'",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("count classes: {e}"))?;
    let res_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM jar_classes WHERE project_id = ?1 AND kind != 'class'",
            [&project_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("count resources: {e}"))?;
    // Nested libraries live in the scratch dir, which is wiped on restart.
    // Re-extract any missing nested jar from the main archive so navigation
    // to their classes keeps working (JD-GUI semantics).
    for lib in jar_db::list_libraries(&conn, &project_id)? {
        let lib_path = PathBuf::from(&lib.jar_path);
        if lib.name.starts_with("[nested]") && !lib_path.exists() {
            if let Some(ename) = restore_nested_entry_name(&lib.name) {
                let main_path = PathBuf::from(&p.jar_path);
                if main_path.is_file() {
                    let _ = jar::extract_entry(&main_path, &ename, &lib_path);
                }
            }
        }
    }
    Ok(ProjectSummary {
        id: p.id,
        name: p.name,
        jar_path: p.jar_path,
        jar_hash: p.jar_hash,
        size: p.size,
        class_count: count,
        resource_count: res_count,
        class_tree: Default::default(),
        created_at: p.created_at,
        updated_at: p.updated_at,
    })
}

/// Recover the original nested-archive entry name from the library display
/// name ("[nested] spring-core.jar" → "BOOT-INF/lib/spring-core.jar" is not
/// recoverable from the name alone, so we store it in the name suffix).
fn restore_nested_entry_name(name: &str) -> Option<String> {
    // We append the entry name after a marker when creating the library.
    let s = name.strip_prefix("[nested] ")?;
    if let Some(idx) = s.rfind('|') {
        return Some(s[idx + 1..].to_string());
    }
    None
}

#[tauri::command]
pub async fn jar_class_index(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<std::collections::BTreeMap<String, jar::PackageNode>, String> {
    let conn = state.conn()?;
    let rows = jar_db::list_classes(&conn, &project_id)?;
    let infos: Vec<jar::JarEntryInfo> = rows
        .into_iter()
        .map(|r| jar::JarEntryInfo {
            entry_path: r.entry_path,
            class_name: r.class_name,
            package_name: r.package_name,
            kind: r.kind,
            is_inner_class: r.is_inner_class,
            size: 0,
            compressed_size: 0,
        })
        .collect();
    Ok(jar::build_tree(&infos))
}

#[tauri::command]
pub async fn jar_class_search(
    project_id: String,
    query: String,
    state: State<'_, JarState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.conn()?;
    let q = query.to_lowercase();
    let rows = jar_db::list_classes(&conn, &project_id)?;
    Ok(rows
        .into_iter()
        .filter(|r| {
            let name = r.class_name.to_lowercase();
            let pkg = r.package_name.to_lowercase();
            name.contains(&q) || pkg.contains(&q)
        })
        .take(200)
        .map(|r| {
            serde_json::json!({
                "entryPath": r.entry_path,
                "className": r.class_name,
                "packageName": r.package_name,
                "kind": r.kind,
                "modified": r.modified,
                "compileStatus": r.compile_status,
            })
        })
        .collect::<Vec<_>>())
}

// ── Open Type (Ctrl+T): global type search across main jar + libraries ────

/// JD-GUI Open Type smart matching: build a regexp from the pattern.
/// Rules (from jd-gui OpenTypeController.createRegExpPattern):
///   '*'        matches 0 or N characters
///   '?'        matches 1 character
///   lower case matches insensitive case
///   upper case matches upper case (and acts as a word boundary)
/// JD-GUI Open Type smart matching (exact port of
/// OpenTypeController.createRegExpPattern + match()):
///   - lower case matches case-insensitively ([cC])
///   - upper case matches exactly; a ".*" is inserted before it when i > 1
///   - '*' matches 0..N chars, '?' matches 1 char
///   - the whole SIMPLE class name (package stripped) must match (matches())
fn open_type_regexp(pattern: &str) -> Result<regex::Regex, String> {
    let mut re = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 1 {
                re.push_str(".*");
            }
            re.push(ch);
        } else if ch.is_ascii_lowercase() {
            re.push('[');
            re.push(ch);
            re.push(ch.to_ascii_uppercase());
            re.push(']');
        } else if ch == '*' {
            re.push_str(".*");
        } else if ch == '?' {
            re.push('.');
        } else if matches!(ch, '.' | '$' | '/' | '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '+' | '-' | '^' | '|') {
            re.push('\\');
            re.push(ch);
        } else {
            re.push(ch);
        }
    }
    re.push_str(".*");
    // Java's Matcher.matches() = whole input must match → anchor both ends.
    let anchored = format!("^(?:{})$", re);
    regex::Regex::new(&anchored).map_err(|e| format!("bad pattern: {e}"))
}

/// Simple class name (JD-GUI strips the package and inner-class prefix):
/// "java.util.Map$Entry" → "Entry", "cn.hutool.StrUtil" → "StrUtil".
fn simple_class_name(class_name: &str) -> &str {
    let dot = class_name.rfind('.').map(|i| i + 1).unwrap_or(0);
    let dollar = class_name.rfind('$').map(|i| i + 1).unwrap_or(0);
    &class_name[dot.max(dollar)..]
}

#[tauri::command]
pub async fn jar_open_type(
    project_id: String,
    pattern: String,
    scope: Option<String>,
    state: State<'_, JarState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.conn()?;
    let pat = pattern.trim();
    if pat.is_empty() {
        return Ok(Vec::new());
    }
    let re = open_type_regexp(pat)?;
    // JD-GUI Open Type searches across every open file. We persist each opened
    // jar's index, so scope=all searches every known project (incl. libraries).
    let projects: Vec<(String, String)> = if scope.as_deref() == Some("all") {
        jar_db::list_projects(&conn)?
            .into_iter()
            .map(|p| (p.id, p.name))
            .collect()
    } else {
        vec![(project_id.clone(), String::new())]
    };
    let mut out = Vec::new();
    for (pid, pname) in projects {
        let rows = jar_db::list_classes(&conn, &pid)?;
        for r in rows.into_iter().filter(|r| r.kind == "class") {
            if re.is_match(simple_class_name(&r.class_name)) {
                out.push(serde_json::json!({
                    "entryPath": r.entry_path,
                    "className": r.class_name,
                    "packageName": r.package_name,
                    "libraryId": r.library_id,
                    "projectId": pid,
                    "projectName": pname,
                    "isInnerClass": r.is_inner_class,
                    "modified": r.modified,
                }));
                if out.len() >= 500 {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

/// Every class name known across all indexed projects and libraries (main
/// jars, pom deps and nested archives). The frontend uses this to decide
/// whether a bytecode reference is resolvable — mirrors JD-GUI's
/// IndexesUtil.containsInternalTypeName over every open container.
#[tauri::command]
pub async fn jar_known_class_names(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::collections::BTreeSet;
    let conn = state.conn()?;
    // All projects + the current project's libraries.
    let mut project_ids: Vec<String> = jar_db::list_projects(&conn)?.into_iter().map(|p| p.id).collect();
    if !project_ids.iter().any(|id| id == &project_id) {
        project_ids.push(project_id.clone());
    }
    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut simple: BTreeSet<String> = BTreeSet::new();
    for pid in project_ids {
        let rows = jar_db::list_classes(&conn, &pid)?;
        for r in rows.into_iter().filter(|r| r.kind == "class") {
            names.insert(r.class_name.clone());
            if let Some(s) = r.class_name.rsplit('.').next() {
                simple.insert(s.to_string());
            }
            // Slash form too, so bytecode internalTypeName matches directly.
            names.insert(r.class_name.replace('.', "/"));
        }
    }
    Ok(serde_json::json!({
        "names": names.into_iter().collect::<Vec<_>>(),
        "simple": simple.into_iter().collect::<Vec<_>>(),
    }))
}

/// Locate a method declaration inside a class, returning its source line.
/// Mirrors JD-GUI: clicking a method reference opens the owning class and
/// jumps to the declaration (fragment = type-method-descriptor).
#[tauri::command]
pub async fn jar_method_location(
    project_id: String,
    class_internal_name: String, // slash form, e.g. "demo/Bar"
    method_name: String,
    _descriptor: Option<String>, // reserved for descriptor-accurate matching
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::path::Path as FsPath;
    let conn = state.conn()?;
    // Resolve the class to an entry path (dotted class name → jar row).
    let dotted = class_internal_name.replace('/', ".");
    let row = jar_db::list_classes(&conn, &project_id)?
        .into_iter()
        .find(|c| c.class_name == dotted && c.kind == "class")
        .ok_or_else(|| format!("Class not found: {dotted}"))?;
    let entry_path = row.entry_path.clone();
    let jar_path = if row.library_id.is_empty() {
        jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?.jar_path
    } else {
        jar_db::get_library(&conn, &project_id, &row.library_id)?.ok_or("Library not found")?.jar_path
    };

    let bytes = tauri::async_runtime::spawn_blocking({
        let p = jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(FsPath::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;

    let cfr = state.cfr_jar()?;
    let scratch = state.scratch.join(&project_id);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let class_file = scratch.join(format!("loc-{}.class", entry_path.replace('/', "_")));
    std::fs::write(&class_file, &bytes).map_err(|e| format!("write class: {e}"))?;
    let source = tauri::async_runtime::spawn_blocking({
        let cf = class_file.clone();
        let cfr = cfr.clone();
        move || decompile::decompile_class(&cf, &cfr, None)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&class_file);

    let methods = crate::jar::extract_methods(&source);
    let hit = methods.iter().find(|m| m.name == method_name).cloned();
    let line = hit.map(|m| m.line).unwrap_or(1);

    Ok(serde_json::json!({
        "entryPath": entry_path,
        "className": dotted,
        "libraryId": row.library_id,
        "line": line,
    }))
}

/// Build a full class hierarchy (parents + subclasses) for one class.
/// Scans every class in the project (main jar + libraries) once, reading the
/// constant pool super/interfaces — mirrors JD-GUI's subTypeNames index.
#[tauri::command]
pub async fn jar_type_hierarchy(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;

    let conn = state.conn()?;
    let jar_path = if let Some(lib_id) = &library_id {
        jar_db::get_library(&conn, &project_id, lib_id)?.ok_or("Library not found")?.jar_path
    } else {
        jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?.jar_path
    };

    // Collect every class in the same jar (target + its jar siblings).
    let classes = jar_db::list_classes(&conn, &project_id)?;
    let siblings: Vec<(String, String)> = classes
        .iter()
        .filter(|c| c.kind == "class" && c.library_id == library_id.clone().unwrap_or_default())
        .map(|c| (c.entry_path.clone(), c.class_name.clone()))
        .collect();

    let target_class_name = classes
        .iter()
        .find(|c| c.entry_path == entry_path && c.library_id == library_id.clone().unwrap_or_default())
        .map(|c| c.class_name.clone())
        .ok_or("Class not found")?;

    // Scan jar: class_name (dotted) → (super dotted, interfaces dotted).
    let jar_path2 = jar_path.clone();
    let entries2 = siblings.clone();
    let scan = tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&jar_path2).map_err(|e| format!("open jar: {e}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
        let mut result: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
        for (entry, class_name) in &entries2 {
            let bytes = {
                let mut e = match archive.by_name(entry) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let mut buf = Vec::with_capacity(e.size() as usize);
                use std::io::Read;
                if e.read_to_end(&mut buf).is_err() {
                    continue;
                }
                buf
            };
            if let Ok((sup, ifaces)) = crate::jar::class_super(&bytes) {
                let to_dotted = |s: String| s.replace('/', ".");
                result.insert(
                    class_name.clone(),
                    (sup.map(to_dotted), ifaces.into_iter().map(to_dotted).collect()),
                );
            }
        }
        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Build children map (parent → children) from the scan.
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (name, (sup, _)) in &scan {
        if let Some(p) = sup {
            children.entry(p.clone()).or_default().push(name.clone());
        }
    }
    for v in children.values_mut() {
        v.sort();
    }

    // Walk up to the root of the hierarchy.
    fn ancestors<'a>(
        name: &str,
        scan: &'a HashMap<String, (Option<String>, Vec<String>)>,
        out: &mut Vec<String>,
    ) {
        if let Some((Some(p), _)) = scan.get(name) {
            out.push(p.clone());
            ancestors(p, scan, out);
        }
    }
    let mut parent_chain: Vec<String> = Vec::new();
    ancestors(&target_class_name, &scan, &mut parent_chain);

    // Walk down: full subtree under the target.
    fn subtree(name: &str, children: &HashMap<String, Vec<String>>, depth: usize) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        if let Some(kids) = children.get(name) {
            for k in kids {
                if depth > 16 {
                    break; // safety
                }
                out.push(serde_json::json!({
                    "className": k,
                    "children": subtree(k, children, depth + 1),
                }));
            }
        }
        out
    }

    Ok(serde_json::json!({
        "target": target_class_name,
        "targetEntryPath": entry_path,
        "parents": parent_chain,
        "subTypes": subtree(&target_class_name, &children, 0),
    }))
}

// ── Search in constant pools (Ctrl+Shift+S): JD-GUI cross-jar search ──────

/// Search string constants / field refs / method refs across all classes of
/// the project (main jar + libraries). Mirrors JD-GUI Search in Constant Pools.
#[tauri::command]
pub async fn jar_constant_search(
    project_id: String,
    pattern: String,
    flags: u32, // bit0=strings, bit1=fields, bit2=methods
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::collections::HashSet;

    let conn = state.conn()?;
    let pat = pattern.trim().to_lowercase();
    if pat.is_empty() {
        return Ok(serde_json::json!({ "results": [] }));
    }

    // Gather every jar in scope: main + libraries.
    let mut scopes: Vec<(String, String)> = Vec::new(); // (jar_path, library_id)
    if let Some(p) = jar_db::get_project(&conn, &project_id)? {
        scopes.push((p.jar_path, String::new()));
    }
    for lib in jar_db::list_libraries(&conn, &project_id)? {
        scopes.push((lib.jar_path, lib.id));
    }

    let want_strings = flags & 1 != 0;
    let want_fields = flags & 2 != 0;
    let want_methods = flags & 4 != 0;

    let scan = tauri::async_runtime::spawn_blocking(move || {
        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (jar_path, lib_id) in &scopes {
            let file = match std::fs::File::open(jar_path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut archive = match zip::ZipArchive::new(file) {
                Ok(a) => a,
                Err(_) => continue,
            };
            for i in 0..archive.len() {
                let mut entry = match archive.by_index(i) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let name = entry.name().to_string();
                if !name.ends_with(".class") {
                    continue;
                }
                let mut buf = Vec::with_capacity(entry.size() as usize);
                use std::io::Read;
                if entry.read_to_end(&mut buf).is_err() {
                    continue;
                }
                let pool = match crate::jar::parse_class_pool(&buf) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let class_name = name.strip_suffix(".class").unwrap_or(&name).replace('/', ".");
                if want_strings {
                    for s in &pool.strings {
                        if s.to_lowercase().contains(&pat) {
                            let key = format!("s:{lib_id}:{s}");
                            if seen.insert(key) {
                                results.push(serde_json::json!({
                                    "kind": "string", "value": s, "className": class_name, "libraryId": lib_id,
                                }));
                            }
                        }
                    }
                }
                if want_fields {
                    for f in &pool.field_refs {
                        if f.to_lowercase().contains(&pat) {
                            let key = format!("f:{lib_id}:{class_name}:{f}");
                            if seen.insert(key) {
                                results.push(serde_json::json!({
                                    "kind": "field", "value": f, "className": class_name, "libraryId": lib_id,
                                }));
                            }
                        }
                    }
                }
                if want_methods {
                    for m in &pool.method_refs {
                        if m.to_lowercase().contains(&pat) {
                            let key = format!("m:{lib_id}:{class_name}:{m}");
                            if seen.insert(key) {
                                results.push(serde_json::json!({
                                    "kind": "method", "value": m, "className": class_name, "libraryId": lib_id,
                                }));
                            }
                        }
                    }
                }
                if results.len() >= 500 {
                    break;
                }
            }
            if results.len() >= 500 {
                break;
            }
        }
        Ok::<_, String>(results)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(serde_json::json!({ "results": scan }))
}

// ── Decompile (JD-GUI semantics: no caching — re-decompile on demand) ─────

#[tauri::command]
pub async fn jar_decompile(
    project_id: String,
    entry_path: String,
    state: State<'_, JarState>,
) -> Result<ClassView, String> {
    // 1) User-modified? Show the user's source directly (no re-decompile).
    {
        let conn = state.conn()?;
        if let Some(c) = jar_db::get_class(&conn, &project_id, &entry_path)? {
            if let Some(src) = c.modified_source.clone() {
                let methods: Vec<MethodLine> = jar::extract_methods(&src)
                    .into_iter()
                    .map(|m| MethodLine { name: m.name, line: m.line as i64 })
                    .collect();
                return Ok(ClassView {
                    entry_path: entry_path.clone(),
                    class_name: c.class_name.clone(),
                    package_name: c.package_name.clone(),
                    kind: "class".into(),
                    is_inner_class: c.is_inner_class,
                    source: src.clone(),
                    original_source: Some(src),
                    modified: true,
                    compile_status: c.compile_status.clone(),
                    compile_output: c.compile_output.clone(),
                    refs: Vec::new(),
                    methods,
                });
            }
        }
    }

    // 2) Otherwise re-decompile from the original JAR (never cached).
    let project = {
        let conn = state.conn()?;
        jar_db::get_project(&conn, &project_id)?
    }
    .ok_or("Project not found")?;

    let class_bytes = tauri::async_runtime::spawn_blocking({
        let p = project.jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(Path::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;

    // A valid .class file starts with CAFEBABE — fail fast with a clear
    // message instead of letting CFR silently produce nothing.
    if !class_bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err(format!(
            "Class {} is not a valid JVM class (missing CAFEBABE magic, {} bytes). It may be encrypted or corrupt.",
            entry_path,
            class_bytes.len()
        ));
    }

    let cfr_jar = state.cfr_jar()?;
    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);

    let scratch = state.scratch.join(&project_id);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let class_file = scratch.join(format!("{}.class", entry_path.replace('/', "_")));
    std::fs::write(&class_file, &class_bytes).map_err(|e| format!("write class: {e}"))?;

    let source = tauri::async_runtime::spawn_blocking({
        let cfr = cfr_jar.clone();
        let cf = class_file.clone();
        let cancel = cancel.clone();
        move || decompile::decompile_class(&cf, &cfr, Some(cancel))
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = std::fs::remove_file(&class_file);

    // Bytecode-level references for click-to-jump (JD-GUI printReference).
    let refs = jar::parse_class_pool(&class_bytes)
        .map(|pool| pool.refs)
        .unwrap_or_default();
    // Own method declarations (name → line) for same-page method jumps.
    let methods: Vec<MethodLine> = jar::extract_methods(&source)
        .into_iter()
        .map(|m| MethodLine { name: m.name, line: m.line as i64 })
        .collect();

    let inner = entry_path.rsplit('$').count() > 1;
    let ret_entry = entry_path.clone();
    Ok(ClassView {
        entry_path: ret_entry,
        class_name: entry_path_to_class_name(&entry_path),
        package_name: entry_path_to_package(&entry_path),
        kind: "class".into(),
        is_inner_class: inner,
        source: source.clone(),
        original_source: Some(source),
        modified: false,
        compile_status: "none".into(),
        compile_output: None,
        refs,
        methods,
    })
}

#[tauri::command]
pub async fn jar_decompile_cancel(project_id: String, state: State<'_, JarState>) -> Result<(), String> {
    let flag = state.cancel_flag(&project_id);
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

// ── Read resource text ────────────────────────────────────────────────────

#[tauri::command]
pub async fn jar_resource_read(
    project_id: String,
    entry_path: String,
    state: State<'_, JarState>,
) -> Result<String, String> {
    let project = {
        let conn = state.conn()?;
        jar_db::get_project(&conn, &project_id)?
    }
    .ok_or("Project not found")?;

    let bytes = tauri::async_runtime::spawn_blocking({
        let p = project.jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(Path::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;

    String::from_utf8(bytes).map_err(|_| "Resource is binary, not UTF-8 text.".into())
}

// ── Save / revert ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn jar_class_save(
    project_id: String,
    entry_path: String,
    source: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let conn = state.conn()?;
    let source_hash = crate::jar::sha256_bytes(source.as_bytes());
    let id = format!("{project_id}:{entry_path}");

    let c = jar_db::get_class_by_id(&conn, &id)?.ok_or("Class not indexed")?;
    jar_db::upsert_class(
        &conn,
        &jar_db::JarClassRow {
            modified_source: Some(source),
            modified: true,
            compile_status: "stale".into(),
            compile_output: None,
            compile_timestamp: None,
            source_hash: Some(source_hash),
            ..c
        },
    )?;
    Ok(serde_json::json!({ "saved": true, "modified": true }))
}

#[tauri::command]
pub async fn jar_class_revert(
    project_id: String,
    entry_path: String,
    version: Option<i64>,
    state: State<'_, JarState>,
) -> Result<ClassView, String> {
    let conn = state.conn()?;
    let id = format!("{project_id}:{entry_path}");
    let c = jar_db::get_class_by_id(&conn, &id)?.ok_or("Class not indexed")?;

    // JD-GUI semantics: "revert" discards the user's edit and restores the
    // original class. Version history is not persisted (no caching), so a
    // specific version request is no longer supported.
    if version.is_some() {
        return Err("Version history is not persisted (decompiled sources are re-generated on demand).".into());
    }

    jar_db::upsert_class(
        &conn,
        &jar_db::JarClassRow {
            modified_source: None,
            modified: false,
            compile_status: "none".into(),
            compile_output: None,
            compile_timestamp: None,
            source_hash: None,
            ..c.clone()
        },
    )?;

    // Re-decompile the original class to hand back its pristine source.
    let project = jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?;
    let bytes = tauri::async_runtime::spawn_blocking({
        let p = project.jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(Path::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;
    if !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err(format!("Class {entry_path} is not a valid JVM class (missing CAFEBABE magic)."));
    }
    let cfr = state.cfr_jar()?;
    let scratch = state.scratch.join(&project_id);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let class_file = scratch.join(format!("revert-{}.class", entry_path.replace('/', "_")));
    std::fs::write(&class_file, &bytes).map_err(|e| format!("write class: {e}"))?;
    let source = tauri::async_runtime::spawn_blocking({
        let cf = class_file.clone();
        let cfr = cfr.clone();
        move || decompile::decompile_class(&cf, &cfr, None)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&class_file);

    let refs = jar::parse_class_pool(&bytes).map(|pool| pool.refs).unwrap_or_default();
    let methods: Vec<MethodLine> = jar::extract_methods(&source)
        .into_iter()
        .map(|m| MethodLine { name: m.name, line: m.line as i64 })
        .collect();

    Ok(ClassView {
        entry_path,
        class_name: c.class_name,
        package_name: c.package_name,
        kind: "class".into(),
        is_inner_class: c.is_inner_class,
        source: source.clone(),
        original_source: Some(source),
        modified: false,
        compile_status: "none".into(),
        compile_output: None,
        refs,
        methods,
    })
}

#[tauri::command]
pub async fn jar_project_reset(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<(), String> {
    let conn = state.conn()?;
    let classes = jar_db::list_classes(&conn, &project_id)?;
    for c in classes {
        jar_db::upsert_class(
            &conn,
            &jar_db::JarClassRow {
                modified_source: None,
                modified: false,
                compile_status: "none".into(),
                compile_output: None,
                compile_timestamp: None,
                source_hash: None,
                ..c.clone()
            },
        )?;
    }
    Ok(())
}

// ── JDK detect / compile ──────────────────────────────────────────────────

#[tauri::command]
pub async fn jar_jdk_detect() -> Result<compile::JdkInfo, String> {
    tauri::async_runtime::spawn_blocking(compile::detect_jdk)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn jar_compile(
    project_id: String,
    entry_path: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let jdk = compile::detect_jdk();
    if !jdk.found {
        return Err(jdk.error.unwrap_or("JDK not found".into()));
    }
    let javac = jdk.javac_path.clone().ok_or("javac missing")?;

    let project = {
        let conn = state.conn()?;
        jar_db::get_project(&conn, &project_id)?
    }
    .ok_or("Project not found")?;

    // Collect sources (only modified classes need compiling).
    let (sources, classpath) = {
        let conn = state.conn()?;
        let modified = jar_db::list_modified_classes(&conn, &project_id)?;
        let mut srcs = Vec::new();
        for c in &modified {
            if let Some(entry) = entry_path.as_ref() {
                if &c.entry_path != entry {
                    continue;
                }
            }
            let src = c
                .modified_source
                .clone()
                .ok_or_else(|| format!("No source for {}", c.entry_path))?;
            let java_rel = c.entry_path.replace(".class", ".java");
            srcs.push((java_rel, src));
        }
        (srcs, project.jar_path.clone())
    };

    if sources.is_empty() {
        return Ok(serde_json::json!({ "success": false, "diagnostics": [], "message": "No modified classes to compile." }));
    }

    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);
    let scratch = state.scratch.join(format!("{project_id}-compile"));
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let out = scratch.join("out");
    let _ = std::fs::remove_dir_all(&out);

    let result = tauri::async_runtime::spawn_blocking({
        let javac = javac.clone();
        let cp = classpath.clone();
        let sc = scratch.clone();
        move || compile::compile_sources(&javac, &sources, Some(&cp), &sc)
    })
    .await
    .map_err(|e| e.to_string())??;

    let diags = result.diagnostics.clone();
    let compile_succeeded = result.success;

    {
        let conn = state.conn()?;
        let modified = jar_db::list_modified_classes(&conn, &project_id)?;
        for c in &modified {
            // Compiled output is NOT persisted (JD-GUI semantics): it lives in
            // the scratch dir and is regenerated by jar_build on demand.
            jar_db::upsert_class(
                &conn,
                &jar_db::JarClassRow {
                    compile_status: if compile_succeeded { "ok".into() } else { "error".into() },
                    compile_output: Some(
                        diags
                            .iter()
                            .map(|d| format!("{}:{}:{}: {}", d.file, d.line, d.column, d.message))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    compile_timestamp: Some(jar_db::now_ms()),
                    ..c.clone()
                },
            )?;
        }
    }

    Ok(serde_json::json!({
        "success": result.success,
        "diagnostics": diags.iter().map(|d| serde_json::json!({
            "file": d.file, "line": d.line, "column": d.column, "level": d.level, "message": d.message,
        })).collect::<Vec<_>>(),
        "classCount": result.classes.len(),
    }))
}

#[tauri::command]
pub async fn jar_compile_cancel(project_id: String, state: State<'_, JarState>) -> Result<(), String> {
    let flag = state.cancel_flag(&project_id);
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

// ── Build ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn jar_build(
    project_id: String,
    output_path: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let project = {
        let conn = state.conn()?;
        jar_db::get_project(&conn, &project_id)?
    }
    .ok_or("Project not found")?;

    // Collect modified sources; recompile them (JD-GUI semantics: compiled
    // bytes are never persisted — rebuild regenerates them on demand).
    let (sources, modified_rows) = {
        let conn = state.conn()?;
        let rows = jar_db::list_classes(&conn, &project_id)?;
        let mut srcs = Vec::new();
        for c in &rows {
            if c.modified && c.kind == "class" {
                let src = c
                    .modified_source
                    .clone()
                    .ok_or_else(|| format!("No source for {}", c.entry_path))?;
                srcs.push((c.entry_path.replace(".class", ".java"), src));
            }
        }
        (srcs, rows)
    };

    // Recompile all modified classes.
    let jdk = compile::detect_jdk();
    if !jdk.found {
        return Err(jdk.error.unwrap_or("JDK not found".into()));
    }
    let javac = jdk.javac_path.clone().ok_or("javac missing")?;
    let scratch = state.scratch.join(format!("{project_id}-build"));
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let out = scratch.join("out");
    let _ = std::fs::remove_dir_all(&out);

    let compiled = tauri::async_runtime::spawn_blocking({
        let javac = javac.clone();
        let cp = project.jar_path.clone();
        let sc = scratch.clone();
        let srcs = sources.clone();
        move || compile::compile_sources(&javac, &srcs, Some(&cp), &sc)
    })
    .await
    .map_err(|e| e.to_string())??;

    if !compiled.success {
        let diag = compiled
            .diagnostics
            .iter()
            .map(|d| format!("{}:{}:{}: {}", d.file, d.line, d.column, d.message))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("Build aborted — compilation failed:\n{diag}"));
    }

    // Map compiled output → overrides (rel .class path → bytes).
    let overrides: HashMap<String, Vec<u8>> = compiled
        .classes
        .iter()
        .map(|(rel, bytes)| (rel.clone(), bytes.clone()))
        .collect();
    // Guard: every modified class must have a compiled artifact.
    for c in &modified_rows {
        if c.modified && c.kind == "class" {
            if !overrides.contains_key(&c.entry_path) {
                return Err(format!(
                    "Class {} was modified but produced no compiled output — build aborted.",
                    c.class_name
                ));
            }
        }
    }
    let deletions: Vec<String> = Vec::new();
    let additions: Vec<(String, Vec<u8>)> = Vec::new();

    let out_path = PathBuf::from(&output_path);
    let original = PathBuf::from(&project.jar_path);
    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);

    let build_result = tauri::async_runtime::spawn_blocking(move || {
        builder::build_jar(&original, &overrides, &deletions, &additions, &out_path)
    })
    .await
    .map_err(|e| e.to_string())?;

    let detail = match &build_result {
        Ok(_) => "ok".to_string(),
        Err(e) => e.clone(),
    };
    let ok = build_result.is_ok();
    {
        let conn = state.conn()?;
        jar_db::insert_build(
            &conn,
            &project_id,
            &output_path,
            if ok { "ok" } else { "error" },
            Some(&detail),
        )?;
    }

    build_result.map(|size| serde_json::json!({ "success": true, "size": size, "outputPath": output_path }))
}

#[tauri::command]
pub async fn jar_build_cancel(project_id: String, state: State<'_, JarState>) -> Result<(), String> {
    let flag = state.cancel_flag(&project_id);
    flag.store(true, Ordering::Relaxed);
    Ok(())
}


// ── POM project (dependencies as read-only libraries) ─────────────────────

/// Open a pom.xml: index the main jar (if any) + all resolved dependency
/// jars as read-only libraries. Returns the project summary with the main
/// class tree; dependency trees are available via jar_libraries + jar_class_index.
#[tauri::command]
pub async fn jar_pom_open(
    path: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let pom_path = PathBuf::from(&path);
    if !pom_path.is_file() {
        return Err(format!("pom.xml not found: {}", pom_path.display()));
    }

    // Parse pom (fast, inline).
    let pom = crate::pom::parse_pom_file(&pom_path)?;

    // Project id: from pom groupId:artifactId:version.
    let id = format!(
        "jar-pom-{}",
        crate::jar::sha256_bytes(
            format!("{}:{}:{}", pom.group_id, pom.artifact_id, pom.version).as_bytes()
        )
        .get(..16)
        .unwrap_or("pom")
    );

    let conn = state.conn()?;
    let now = jar_db::now_ms();
    let existing = jar_db::get_project(&conn, &id)?;
    let (created_at, updated_at) = match &existing {
        Some(p) => (p.created_at, now),
        None => (now, now),
    };

    // Look for a built jar in target/ (best effort) as the editable main jar.
    let pom_dir = pom_path.parent().unwrap_or(Path::new("."));
    let main_jar = {
        let c1 = pom_dir.join("target").join(format!("{}-{}.jar", pom.artifact_id, pom.version));
        let c2 = pom_dir.join(format!("{}-{}.jar", pom.artifact_id, pom.version));
        if c1.is_file() {
            Some(c1)
        } else if c2.is_file() {
            Some(c2)
        } else {
            None
        }
    };

    let project = jar_db::JarProject {
        id: id.clone(),
        name: format!("{}-{}", pom.artifact_id, pom.version),
        jar_path: main_jar.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
        jar_hash: "".into(),
        size: 0,
        class_count: 0,
        resource_count: 0,
        created_at,
        updated_at,
    };
    jar_db::upsert_project(&conn, &project)?;

    // Clear previous libraries + their classes.
    jar_db::delete_libraries_for_project(&conn, &id)?;
    // Delete classes for libraries (keep main project classes? simplest: reset all).
    conn.execute("DELETE FROM jar_classes WHERE project_id = ?1", [&id])
        .map_err(|e| format!("clear classes: {e}"))?;
    conn.execute("DELETE FROM jar_symbols WHERE project_id = ?1", [&id])
        .map_err(|e| format!("clear symbols: {e}"))?;

    let mut lib_summaries = Vec::new();

    // 1) Main jar (editable).
    if let Some(main) = &main_jar {
        let path_for_index = main.clone();
        let idx = tauri::async_runtime::spawn_blocking(move || jar::index_jar(&path_for_index))
            .await
            .map_err(|e| e.to_string())??;
        for e in &idx.entries {
            let row = jar_db::JarClassRow {
                id: format!("{id}:{}", e.entry_path),
                project_id: id.clone(),
                library_id: "".into(),
                entry_path: e.entry_path.clone(),
                class_name: e.class_name.clone(),
                package_name: e.package_name.clone(),
                kind: e.kind.clone(),
                is_inner_class: e.is_inner_class,
                modified_source: None,
                modified: false,
                compile_status: "none".into(),
                compile_output: None,
                compile_timestamp: None,
                source_hash: None,
            };
            jar_db::upsert_class(&conn, &row)?;
        }
        lib_summaries.push(serde_json::json!({
            "id": "", "name": project.name, "editable": true, "classCount": idx.class_count,
        }));
    }

    // 2) Dependency jars (read-only libraries).
    let dep_jars: Vec<(String, String, String, String)> = pom
        .dependencies
        .iter()
        .filter_map(|d| {
            d.jar_path
                .clone()
                .map(|p| (p, d.group_id.clone(), d.artifact_id.clone(), d.version.clone()))
        })
        .collect();

    for (jar_path_str, group, artifact, version) in dep_jars {
        let jar_path = PathBuf::from(&jar_path_str);
        let path_for_index = jar_path.clone();
        let idx = match tauri::async_runtime::spawn_blocking(move || jar::index_jar(&path_for_index))
            .await
            .map_err(|e| e.to_string())?
        {
            Ok(i) => i,
            Err(_) => continue, // unreadable dep — skip
        };
        let lib_id = format!(
            "{id}:dep:{}",
            crate::jar::sha256_bytes(jar_path_str.as_bytes()).get(..12).unwrap_or("d")
        );
        let lib = jar_db::JarLibrary {
            id: lib_id.clone(),
            project_id: id.clone(),
            name: format!("{artifact}-{version}.jar"),
            group_id: group,
            artifact_id: artifact,
            version,
            jar_path: jar_path_str.clone(),
            jar_hash: idx.jar_hash.clone(),
            class_count: idx.class_count as i64,
            editable: false,
        };
        jar_db::upsert_library(&conn, &lib)?;
        for e in &idx.entries {
            let row = jar_db::JarClassRow {
                id: format!("{lib_id}:{}", e.entry_path),
                project_id: id.clone(),
                library_id: lib_id.clone(),
                entry_path: e.entry_path.clone(),
                class_name: e.class_name.clone(),
                package_name: e.package_name.clone(),
                kind: e.kind.clone(),
                is_inner_class: e.is_inner_class,
                modified_source: None,
                modified: false,
                compile_status: "none".into(),
                compile_output: None,
                compile_timestamp: None,
                source_hash: None,
            };
            jar_db::upsert_class(&conn, &row)?;
        }
        lib_summaries.push(serde_json::json!({
            "id": lib_id, "name": lib.name, "editable": false, "classCount": idx.class_count,
        }));
    }

    // 3) Main class tree (project_id = "").
    let tree = jar_db::list_classes(&conn, &id)?
        .into_iter()
        .filter(|c| c.library_id.is_empty())
        .map(|r| jar::JarEntryInfo {
            entry_path: r.entry_path,
            class_name: r.class_name,
            package_name: r.package_name,
            kind: r.kind,
            is_inner_class: r.is_inner_class,
            size: 0,
            compressed_size: 0,
        })
        .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "projectId": id,
        "name": project.name,
        "pom": {
            "groupId": pom.group_id,
            "artifactId": pom.artifact_id,
            "version": pom.version,
            "resolvedCount": pom.resolved_count,
        },
        "libraries": lib_summaries,
        "classTree": jar::build_tree(&tree),
    }))
}

/// List libraries (dependency jars) for a project.
#[tauri::command]
pub async fn jar_libraries(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.conn()?;
    let libs = jar_db::list_libraries(&conn, &project_id)?;
    Ok(libs
        .into_iter()
        .map(|l| {
            serde_json::json!({
                "id": l.id,
                "name": l.name,
                "groupId": l.group_id,
                "artifactId": l.artifact_id,
                "version": l.version,
                "jarPath": l.jar_path,
                "classCount": l.class_count,
                "editable": l.editable,
            })
        })
        .collect())
}

/// Index the class tree of a specific library (dependency jar).
#[tauri::command]
pub async fn jar_library_index(
    project_id: String,
    library_id: String,
    state: State<'_, JarState>,
) -> Result<std::collections::BTreeMap<String, jar::PackageNode>, String> {
    let conn = state.conn()?;
    let rows = jar_db::list_classes(&conn, &project_id)?;
    let infos: Vec<jar::JarEntryInfo> = rows
        .into_iter()
        .filter(|r| r.library_id == library_id)
        .map(|r| jar::JarEntryInfo {
            entry_path: r.entry_path,
            class_name: r.class_name,
            package_name: r.package_name,
            kind: r.kind,
            is_inner_class: r.is_inner_class,
            size: 0,
            compressed_size: 0,
        })
        .collect();
    Ok(jar::build_tree(&infos))
}

/// Navigate to a class or method by name across the project + libraries.
/// `kind` is "class" or "method". Returns the target class (and line for
/// methods) so the frontend can open it and scroll.
#[tauri::command]
pub async fn jar_navigate(
    project_id: String,
    name: String,
    kind: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let conn = state.conn()?;
    let rows = jar_db::list_classes(&conn, &project_id)?;

    if kind == "class" {
        // Exact class-name match (binary name), prefer main project then libs.
        let target = rows
            .iter()
            .filter(|c| c.kind == "class")
            .find(|c| c.class_name == name || c.class_name.ends_with(&format!(".{name}")))
            .or_else(|| {
                rows.iter()
                    .filter(|c| c.kind == "class")
                    .find(|c| c.class_name.split('.').next_back() == Some(name.as_str()))
            });
        let Some(c) = target else {
            // JD-GUI: a reference may resolve to a class in another open file.
            // Fall back to every indexed project before giving up.
            for p in jar_db::list_projects(&conn)? {
                if p.id == project_id {
                    continue;
                }
                let rows2 = jar_db::list_classes(&conn, &p.id)?;
                if let Some(c2) = rows2.iter().find(|c| c.kind == "class" && c.class_name == name) {
                    return Ok(serde_json::json!({
                        "kind": "class",
                        "className": c2.class_name,
                        "entryPath": c2.entry_path,
                        "libraryId": c2.library_id,
                        "projectId": p.id,
                        "line": null,
                    }));
                }
            }
            return Err(format!("Class not found: {name}"));
        };
        return Ok(serde_json::json!({
            "kind": "class",
            "className": c.class_name,
            "entryPath": c.entry_path,
            "libraryId": c.library_id,
            "projectId": project_id,
            "line": null,
        }));
    }

    if kind == "method" {
        // Find a method symbol named `name`; prefer main project.
        let symbols = jar_db::find_symbols_by_name(&conn, &project_id, &name)?;
        if !symbols.is_empty() {
            // Prefer non-library (main project) then first.
            let primary = symbols
                .iter()
                .find(|s| !s["libraryId"].is_null())
                .or_else(|| symbols.first())
                .cloned()
                .unwrap_or_else(|| symbols[0].clone());
            return Ok(serde_json::json!({
                "kind": "method",
                "className": primary["className"],
                "entryPath": primary["entryPath"],
                "libraryId": primary["libraryId"],
                "projectId": project_id,
                "line": primary["line"],
            }));
        }
        // Cross-project fallback (JD-GUI resolves references across open files).
        for p in jar_db::list_projects(&conn)? {
            if p.id == project_id {
                continue;
            }
            let syms = jar_db::find_symbols_by_name(&conn, &p.id, &name)?;
            if let Some(s) = syms.first() {
                return Ok(serde_json::json!({
                    "kind": "method",
                    "className": s["className"],
                    "entryPath": s["entryPath"],
                    "libraryId": s["libraryId"],
                    "projectId": p.id,
                    "line": s["line"],
                }));
            }
        }
        return Err(format!("Method not found: {name}"));
    }

    Err(format!("Unknown navigation kind: {kind}"))
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn entry_path_to_class_name(entry_path: &str) -> String {
    let without_ext = entry_path.strip_suffix(".class").unwrap_or(entry_path);
    without_ext.replace('/', ".").replace('\\', ".")
}

fn entry_path_to_package(entry_path: &str) -> String {
    let without_ext = entry_path.strip_suffix(".class").unwrap_or(entry_path);
    match without_ext.rfind('/') {
        Some(i) => without_ext[..i].replace('/', "."),
        None => String::new(),
    }
}

// ── JD-GUI style: resource bytes + export-all + class info ────────────────

/// Read a resource as raw bytes (for image/binary preview). Returns base64.
#[tauri::command]
pub async fn jar_resource_bytes(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    // Resolve the jar path: main project or a library.
    let conn = state.conn()?;
    let jar_path = if let Some(lib_id) = &library_id {
        let lib = jar_db::get_library(&conn, &project_id, lib_id)?
            .ok_or("Library not found")?;
        lib.jar_path
    } else {
        let p = jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?;
        p.jar_path
    };

    let bytes = tauri::async_runtime::spawn_blocking({
        let p = jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(Path::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;

    use base64::Engine;
    Ok(serde_json::json!({
        "bytes": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "size": bytes.len(),
        "isText": bytes.iter().all(|&b| b == b'\n' || b == b'\r' || b == b'\t' || (b >= 0x20 && b < 0x7f) || b >= 0x80),
    }))
}

/// Recursively add a directory tree into a zip archive (used by export-all).
fn pack_dir_into_zip(
    dir: &Path,
    prefix: &str,
    zip: &mut zip::ZipWriter<std::fs::File>,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("read staging: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let name = if prefix.is_empty() {
            e.file_name().to_string_lossy().into_owned()
        } else {
            format!("{prefix}/{}", e.file_name().to_string_lossy())
        };
        if path.is_dir() {
            pack_dir_into_zip(&path, &name, zip, opts)?;
        } else {
            let data = std::fs::read(&path).map_err(|e| format!("read staging file: {e}"))?;
            zip.start_file(name, opts).map_err(|e| format!("zip entry: {e}"))?;
            use std::io::Write;
            zip.write_all(&data).map_err(|e| format!("zip write: {e}"))?;
        }
    }
    Ok(())
}

/// Export the decompiled source of ALL classes in the project (main jar +
/// libraries) to a directory. Returns per-file results. Cancellable.
#[tauri::command]
pub async fn jar_export_all(
    project_id: String,
    output_dir: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let conn = state.conn()?;
    let classes = jar_db::list_classes(&conn, &project_id)?;
    let class_files: Vec<(String, String, String)> = classes
        .iter()
        .filter(|c| c.kind == "class")
        .map(|c| (c.library_id.clone(), c.entry_path.clone(), c.class_name.clone()))
        .collect();
    let class_count = class_files.len();
    drop(conn);

    let out = PathBuf::from(&output_dir);
    let want_zip = out.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false);
    // When exporting a zip, write sources to a staging dir first, then pack.
    let staging = if want_zip {
        let s = state.scratch.join(format!("{project_id}-export-src"));
        let _ = std::fs::remove_dir_all(&s);
        std::fs::create_dir_all(&s).map_err(|e| format!("create staging: {e}"))?;
        s
    } else {
        std::fs::create_dir_all(&out).map_err(|e| format!("create output dir: {e}"))?;
        out.clone()
    };

    let cfr_jar = state.cfr_jar()?;
    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);

    // Resolve jar per library id.
    let resolve_jar = |conn: &rusqlite::Connection, lib_id: &str| -> Result<String, String> {
        if lib_id.is_empty() {
            Ok(jar_db::get_project(conn, &project_id)?.ok_or("Project not found")?.jar_path)
        } else {
            Ok(jar_db::get_library(conn, &project_id, lib_id)?.ok_or("Library not found")?.jar_path)
        }
    };

    let mut exported = 0usize;
    let mut failed: Vec<String> = Vec::new();

    // Group by jar to batch reads.
    let conn = state.conn()?;
    let mut by_jar: std::collections::HashMap<String, Vec<&(String, String, String)>> =
        std::collections::HashMap::new();
    for c in &class_files {
        let jar = resolve_jar(&conn, &c.0)?;
        by_jar.entry(jar).or_default().push(c);
    }
    drop(conn);

    for (jar_path, entries) in by_jar {
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled".into());
        }
        let scratch = state.scratch.join(format!("{project_id}-export"));
        std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;

        for c in &entries {
            if cancel.load(Ordering::Relaxed) {
                return Err("Export cancelled".into());
            }
            // Read class bytes.
            let bytes = match jar::read_entry_bytes(Path::new(&jar_path), &c.1) {
                Ok(b) => b,
                Err(_) => {
                    failed.push(c.2.clone());
                    continue;
                }
            };
            let class_file = scratch.join(format!("{}.class", c.1.replace('/', "_")));
            if std::fs::write(&class_file, &bytes).is_err() {
                failed.push(c.2.clone());
                continue;
            }
            match decompile::decompile_class(&class_file, &cfr_jar, Some(cancel.clone())) {
                Ok(src) => {
                    // Write to staging/output preserving package structure.
                    let rel_java = c.1.replace(".class", ".java");
                    let dest = staging.join(&rel_java);
                    if let Some(parent) = dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if std::fs::write(&dest, &src).is_ok() {
                        exported += 1;
                    } else {
                        failed.push(c.2.clone());
                    }
                }
                Err(_) => failed.push(c.2.clone()),
            }
            let _ = std::fs::remove_file(&class_file);
        }
    }

    // Pack into a zip when requested.
    if want_zip {
        let file = std::fs::File::create(&out).map_err(|e| format!("create zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        pack_dir_into_zip(&staging, "", &mut zip, opts)?;
        zip.finish().map_err(|e| format!("finish zip: {e}"))?;
        let _ = std::fs::remove_dir_all(&staging);
    }

    jar_db::insert_build(
        &state.conn()?,
        &project_id,
        &output_dir,
        if failed.is_empty() { "ok" } else { "partial" },
        Some(&format!("exported {exported}/{class_count}, failed {}", failed.len())),
    )?;

    Ok(serde_json::json!({
        "exported": exported,
        "total": class_count,
        "failed": failed.len(),
        "failedClasses": failed.iter().take(20).collect::<Vec<_>>(),
        "outputDir": output_dir,
    }))
}

/// Class file info: version, access flags (JD-GUI's class info view).
#[tauri::command]
pub async fn jar_class_info(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let conn = state.conn()?;
    let jar_path = if let Some(lib_id) = &library_id {
        jar_db::get_library(&conn, &project_id, lib_id)?.ok_or("Library not found")?.jar_path
    } else {
        jar_db::get_project(&conn, &project_id)?.ok_or("Project not found")?.jar_path
    };

    let bytes = tauri::async_runtime::spawn_blocking({
        let p = jar_path.clone();
        let e = entry_path.clone();
        move || jar::read_entry_bytes(Path::new(&p), &e)
    })
    .await
    .map_err(|e| e.to_string())??;

    let (minor, major, java_version) = jar::class_file_info(&bytes)?;

    Ok(serde_json::json!({
        "className": entry_path_to_class_name(&entry_path),
        "javaVersion": java_version,
        "major": major,
        "minor": minor,
        "size": bytes.len(),
    }))
}

#[cfg(test)]
mod open_type_tests {
    // Ported behavior verified against the real JD-GUI 1.6.6 algorithm
    // (createRegExpPattern + match() on the SIMPLE class name).
    use super::{open_type_regexp, simple_class_name};

    fn matches(pattern: &str, class_name: &str) -> bool {
        open_type_regexp(pattern).unwrap().is_match(simple_class_name(class_name))
    }

    #[test]
    fn simple_substring() {
        assert!(matches("str", "java.lang.String"));
        assert!(!matches("str", "java.lang.Integer"));
    }

    #[test]
    fn upper_case_rules() {
        // Two leading uppercase chars are kept verbatim (no .* between).
        assert!(!matches("ST", "java.lang.String"));
        // Upper case after lowercase splits the name.
        assert!(matches("StrU", "cn.hutool.core.util.StrUtil"));
    }

    #[test]
    fn lower_case_ignores_case() {
        assert!(matches("string", "java.lang.String"));
        // ALL-upper pattern requires the literal sequence: "STRING" has no .*
        // separators between S,T,R,… so it must match the name verbatim.
        assert!(!matches("STRING", "java.lang.String"));
    }

    #[test]
    fn wildcards() {
        assert!(matches("*Map", "java.util.HashMap"));
        assert!(matches("Hash*", "java.util.HashMap"));
        // '?' matches exactly one char: HashMap has 's' where 'p' is expected.
        assert!(!matches("Ha?p", "java.util.HashMap"));
    }

    #[test]
    fn inner_classes() {
        // Simple name of Map$Entry is "Entry" — the pattern targets the name
        // with the package stripped, matching JD-GUI's substring(lastIndex).
        assert!(matches("Entry", "java.util.Map$Entry"));
    }

    #[test]
    fn simple_name_strips_package_and_inner() {
        assert_eq!(simple_class_name("java.util.Map$Entry"), "Entry");
        assert_eq!(simple_class_name("cn.hutool.StrUtil"), "StrUtil");
        assert_eq!(simple_class_name("Foo"), "Foo");
    }
}
