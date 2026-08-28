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

use tauri::{AppHandle, Emitter, State};

use crate::decompile;
use crate::jar;
use crate::jar_db;

/// Shared state: path to the SQLite file + per-project cancellation flags.
/// A fresh `rusqlite::Connection` is opened per command — connections are not
/// `Clone` and cannot cross `await` points inside a `MutexGuard`.
/// One nested dependency jar (BOOT-INF/lib, WEB-INF/lib, ...) held in MEMORY
/// (JD-GUI indexes jars in memory; nothing is persisted to a database).
pub struct NestedJarData {
    pub id: String,
    pub entry_path: String,
    pub name: String,
    /// Maven coordinates (pom-opened dependency jars); empty for fat-jar
    /// nested jars.
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    /// The nested jar's bytes (read once from the parent zip).
    pub bytes: Vec<u8>,
    pub entries: Vec<jar::JarEntryInfo>,
    pub tree: std::collections::BTreeMap<String, jar::PackageNode>,
    pub class_count: usize,
}

/// In-memory index of one opened jar project. Rebuilt every time the jar is
/// opened; dropped when the project is closed — no jar_* DB writes at all.
pub struct MemoryIndex {
    pub project_id: String,
    pub name: String,
    pub jar_path: String,
    pub jar_hash: String,
    pub size: i64,
    pub class_count: usize,
    pub resource_count: usize,
    /// Main jar entries (classes/resources/module), indexed order.
    pub entries: Vec<jar::JarEntryInfo>,
    /// Main jar tree (package → classes/resources).
    pub main_tree: std::collections::BTreeMap<String, jar::PackageNode>,
    /// Nested dependency jars keyed by library id.
    pub nested: std::collections::HashMap<String, NestedJarData>,
    /// Every class name (dotted) across the main jar + nested jars — the
    /// clickability index (JD-GUI typeDeclarations equivalent).
    /// Populated at index build; consumers are tests + `jar_known_class_names`
    /// walks `entries` directly, so reads here are test-only for now.
    #[allow(dead_code)]
    pub class_names: std::collections::BTreeSet<String>,
}

impl MemoryIndex {
    /// Find a class entry by its binary name (com.foo.Bar); None when absent.
    fn find_class(&self, dotted: &str) -> Option<(String, &jar::JarEntryInfo)> {
        if let Some(e) = self
            .entries
            .iter()
            .find(|e| e.kind == "class" && e.class_name == dotted)
        {
            return Some((String::new(), e));
        }
        for (lib_id, n) in &self.nested {
            if let Some(e) = n
                .entries
                .iter()
                .find(|e| e.kind == "class" && e.class_name == dotted)
            {
                return Some((lib_id.clone(), e));
            }
        }
        None
    }

    /// Read a class entry's bytes from memory: the main jar file when
    /// `library_id` is empty, otherwise the nested jar's in-memory bytes.
    pub fn read_class_bytes(&self, library_id: &str, entry_path: &str) -> Result<Vec<u8>, String> {
        if library_id.is_empty() {
            jar::read_entry_bytes(std::path::Path::new(&self.jar_path), entry_path)
        } else {
            let n = self.nested.get(library_id).ok_or("Library not found")?;
            let mut cur = std::io::Cursor::new(&n.bytes);
            let mut archive =
                zip::ZipArchive::new(&mut cur).map_err(|e| format!("open nested jar: {e}"))?;
            let mut e = archive
                .by_name(entry_path)
                .map_err(|e| format!("entry {entry_path} not found: {e}"))?;
            let mut buf = Vec::with_capacity(e.size() as usize);
            use std::io::Read;
            e.read_to_end(&mut buf)
                .map_err(|e| format!("read entry: {e}"))?;
            Ok(buf)
        }
    }

    /// Stage the main archive's classes by JVM internal name, not their
    /// physical container path. This is essential for Spring Boot JARs where
    /// `BOOT-INF/classes/com/example/Foo.class` is requested by JD-Core as
    /// `com/example/Foo`.
    fn extract_main_classes_to(&self, dest_root: &Path) -> Result<(), String> {
        for entry in self.entries.iter().filter(|entry| entry.kind == "class") {
            let bytes = self.read_class_bytes("", &entry.entry_path)?;
            let internal_name = entry.class_name.replace('.', "/");
            let destination = dest_root.join(format!("{internal_name}.class"));
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("create classpath directory: {e}"))?;
            }
            std::fs::write(destination, bytes).map_err(|e| format!("write classpath entry: {e}"))?;
        }
        Ok(())
    }

    /// Extract same-directory classes of `entry_path` (JD-GUI ContainerLoader)
    /// from MEMORY into `dest_root` (package structure preserved).
    pub fn extract_sibling_classes_to(
        &self,
        library_id: &str,
        entry_path: &str,
        dest_root: &std::path::Path,
    ) -> Result<(), String> {
        let dir = match entry_path.rfind('/') {
            Some(i) => &entry_path[..i],
            None => "",
        };
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        use std::io::Write;
        if library_id.is_empty() {
            let file = std::fs::File::open(&self.jar_path).map_err(|e| format!("open jar: {e}"))?;
            let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
            for i in 0..archive.len() {
                let mut entry = match archive.by_index(i) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let name = entry.name().to_string();
                if name.ends_with(".class") && name.starts_with(&prefix) {
                    let dest = dest_root.join(&name);
                    if let Some(p) = dest.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    let mut out = match std::fs::File::create(&dest) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    if std::io::copy(&mut entry, &mut out).is_err() {
                        let _ = std::fs::remove_file(&dest);
                    }
                    let _ = out.flush();
                }
            }
        } else {
            let n = self.nested.get(library_id).ok_or("Library not found")?;
            let mut cur = std::io::Cursor::new(&n.bytes);
            let mut archive = zip::ZipArchive::new(&mut cur).map_err(|e| format!("zip: {e}"))?;
            for i in 0..archive.len() {
                let mut entry = match archive.by_index(i) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let name = entry.name().to_string();
                if name.ends_with(".class") && name.starts_with(&prefix) {
                    let dest = dest_root.join(&name);
                    if let Some(p) = dest.parent() {
                        let _ = std::fs::create_dir_all(p);
                    }
                    let mut out = match std::fs::File::create(&dest) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    if std::io::copy(&mut entry, &mut out).is_err() {
                        let _ = std::fs::remove_file(&dest);
                    }
                    let _ = out.flush();
                }
            }
        }
        Ok(())
    }
}

pub struct JarState {
    /// Path to the nexterm.db file (shared with the rest of the app — the jar
    /// feature no longer writes to it). Kept for `JarState::conn` callers
    /// outside the jar feature.
    #[allow(dead_code)]
    pub db_path: std::path::PathBuf,
    /// project_id → cancel flag for the active decompile.
    pub cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Where decompile scratch dirs live (temporary .class files).
    pub scratch: PathBuf,
    /// Tauri resource dir (bundled jdcore/ lives here). Resolved at startup so
    /// the jd-core wrapper jar is found on every platform, including Windows
    /// exe layout.
    pub resource_dir: Option<std::path::PathBuf>,
    /// Open jar projects: project_id → in-memory index (JD-GUI: no DB).
    pub indexes: Arc<Mutex<HashMap<String, Arc<MemoryIndex>>>>,
}

impl JarState {
    /// Locate the bundled jd-core wrapper jar, preferring the Tauri resource dir.
    pub fn decompiler_jar(&self) -> Result<std::path::PathBuf, String> {
        decompile::find_decompiler_jar_with(self.resource_dir.as_deref())
    }
}

impl JarState {
    /// Open a fresh connection to the shared SQLite file (kept for non-jar
    /// features; the jar feature is fully in-memory now).
    #[allow(dead_code)]
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

#[derive(Clone, serde::Serialize)]
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    project_id: String,
    phase: &'static str,
    completed: usize,
    total: usize,
    class_name: Option<String>,
    message: Option<String>,
}

enum ExportItem {
    Source {
        entry_path: String,
        class_name: String,
        fallback_entries: Vec<String>,
    },
    Resource {
        entry_path: String,
    },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFailure {
    entry_path: String,
    reason: String,
    fallback_entries: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportManifest {
    source_units: usize,
    grouped_inner_classes: usize,
    grouped_inner_class_entries: Vec<String>,
    resources: usize,
    failures: Vec<ExportFailure>,
}

fn source_unit_fallback_entries(index: &MemoryIndex, entry_path: &str) -> Vec<String> {
    let mut entries = vec![entry_path.to_string()];
    let Ok(bytes) = index.read_class_bytes("", entry_path) else {
        return entries;
    };
    for internal_name in jar::inner_classes_of(&bytes) {
        if index
            .entries
            .iter()
            .find(|entry| entry.kind == "class" && entry.class_name.replace('.', "/") == internal_name && entry.is_inner_class)
            .is_some()
        {
            if let Some(entry) = index.entries.iter().find(|entry| entry.kind == "class" && entry.class_name.replace('.', "/") == internal_name) {
                entries.push(entry.entry_path.clone());
            }
        }
    }
    entries.sort();
    entries.dedup();
    entries
}

fn write_fallback_classes(
    index: &MemoryIndex,
    entries: &[String],
    fallback_root: &Path,
) -> Vec<String> {
    let mut written = Vec::new();
    for entry_path in entries {
        let Ok(bytes) = index.read_class_bytes("", entry_path) else {
            continue;
        };
        let destination = fallback_root.join(entry_path);
        if let Some(parent) = destination.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(&destination, bytes).is_ok() {
            written.push(format!("fallback/{entry_path}"));
        }
    }
    written
}

fn emit_export_progress(
    app: &AppHandle,
    project_id: &str,
    phase: &'static str,
    completed: usize,
    total: usize,
    class_name: Option<String>,
    message: Option<String>,
) {
    let _ = app.emit(
        "jar://export-progress",
        ExportProgress {
            project_id: project_id.to_string(),
            phase,
            completed,
            total,
            class_name,
            message,
        },
    );
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

    // Heavy: index (spawn_blocking) — reads the zip metadata into memory.
    let path_for_index = path_buf.clone();
    let idx = tauri::async_runtime::spawn_blocking(move || jar::index_jar(&path_for_index))
        .await
        .map_err(|e| e.to_string())??;

    let name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled.jar".into());
    let id = format!("jar-{}", &idx.jar_hash[..16.min(idx.jar_hash.len())]);
    let now = jar_db::now_ms();

    // JD-GUI recursive container model: nested dependency jars (BOOT-INF/lib,
    // WEB-INF/lib, ...) are read INTO MEMORY (zip bytes) and indexed — nothing
    // is extracted to disk or persisted.
    let main_path = path_buf.clone();
    let pid = id.clone();
    let nested = tauri::async_runtime::spawn_blocking(move || -> Vec<NestedJarData> {
        let mut out = Vec::new();
        let file = match std::fs::File::open(&main_path) {
            Ok(f) => f,
            Err(_) => return out,
        };
        let mut archive = match zip::ZipArchive::new(file) {
            Ok(a) => a,
            Err(_) => return out,
        };
        let names = match jar::list_nested_archives(&main_path) {
            Ok(n) => n,
            Err(_) => return out,
        };
        use std::io::Read;
        for ename in names {
            let mut bytes = Vec::new();
            let mut entry = match archive.by_name(&ename) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entry.read_to_end(&mut bytes).is_err() {
                continue;
            }
            // Index from a borrowed slice; `bytes` is moved into the nested
            // data below, avoiding a full second copy of every nested jar.
            let mut cur = std::io::Cursor::new(bytes.as_slice());
            let nidx = match jar::index_jar_reader(&mut cur) {
                Ok(i) => i,
                Err(_) => continue,
            };
            let base = ename.rsplit('/').next().unwrap_or(&ename).to_string();
            let lib_id = format!(
                "{pid}:nested:{}",
                crate::jar::sha256_bytes(ename.as_bytes())
                    .get(..12)
                    .unwrap_or("n")
            );
            out.push(NestedJarData {
                id: lib_id,
                entry_path: ename.clone(),
                name: format!("[nested] {base}|{ename}"),
                group_id: String::new(),
                artifact_id: base.replace(".jar", ""),
                version: String::new(),
                bytes,
                entries: nidx.entries.clone(),
                tree: jar::build_tree(&nidx.entries),
                class_count: nidx.class_count,
            });
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?;

    // Clickability index: every class name across the main jar + nested jars
    // (JD-GUI typeDeclarations).
    let mut class_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in &idx.entries {
        if e.kind == "class" {
            class_names.insert(e.class_name.clone());
        }
    }
    for n in &nested {
        for e in &n.entries {
            if e.kind == "class" {
                class_names.insert(e.class_name.clone());
            }
        }
    }

    let main_tree = jar::build_tree(&idx.entries);
    let index = MemoryIndex {
        project_id: id.clone(),
        name: name.clone(),
        jar_path: path_buf.display().to_string(),
        jar_hash: idx.jar_hash.clone(),
        size: idx.size as i64,
        class_count: idx.class_count,
        resource_count: idx.resource_count,
        entries: idx.entries.clone(),
        main_tree: main_tree.clone(),
        nested: nested.into_iter().map(|n| (n.id.clone(), n)).collect(),
        class_names,
    };
    state
        .indexes
        .lock()
        .expect("indexes poisoned")
        .insert(id.clone(), Arc::new(index));

    Ok(ProjectSummary {
        id,
        name,
        jar_path: path_buf.display().to_string(),
        jar_hash: idx.jar_hash,
        size: idx.size as i64,
        class_count: idx.class_count as i64,
        resource_count: idx.resource_count as i64,
        class_tree: main_tree,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn jar_project_list(state: State<'_, JarState>) -> Result<Vec<ProjectSummary>, String> {
    let now = jar_db::now_ms();
    let indexes = state.indexes.lock().expect("indexes poisoned");
    Ok(indexes
        .values()
        .map(|ix| ProjectSummary {
            id: ix.project_id.clone(),
            name: ix.name.clone(),
            jar_path: ix.jar_path.clone(),
            jar_hash: ix.jar_hash.clone(),
            size: ix.size,
            class_count: ix.class_count as i64,
            resource_count: ix.resource_count as i64,
            class_tree: ix.main_tree.clone(),
            created_at: now,
            updated_at: now,
        })
        .collect())
}

#[tauri::command]
pub async fn jar_project_delete(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<(), String> {
    // Request cancellation before removing the index. Exports decompile via
    // JD-Core child processes while holding only an Arc clone of the index,
    // so this lets the current child exit before the scratch directory is
    // released.
    let cancel = state.cancel_flag(&project_id);
    cancel.store(true, Ordering::Relaxed);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    state
        .indexes
        .lock()
        .expect("indexes poisoned")
        .remove(&project_id);
    state.cancels.lock().expect("poisoned").remove(&project_id);
    let scratch = state.scratch.join(&project_id);
    tauri::async_runtime::spawn_blocking(move || match std::fs::remove_dir_all(scratch) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("remove project scratch: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn jar_project_reopen(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<ProjectSummary, String> {
    let now = jar_db::now_ms();
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    Ok(ProjectSummary {
        id: ix.project_id.clone(),
        name: ix.name.clone(),
        jar_path: ix.jar_path.clone(),
        jar_hash: ix.jar_hash.clone(),
        size: ix.size,
        class_count: ix.class_count as i64,
        resource_count: ix.resource_count as i64,
        class_tree: ix.main_tree.clone(),
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn jar_class_index(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<std::collections::BTreeMap<String, jar::PackageNode>, String> {
    // JD-GUI container model: the MAIN tree shows only the main jar's classes
    // (memory index); dependency jars are separate containers.
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    Ok(ix.main_tree.clone())
}

#[tauri::command]
pub async fn jar_class_search(
    project_id: String,
    query: String,
    state: State<'_, JarState>,
) -> Result<Vec<serde_json::Value>, String> {
    let q = query.to_lowercase();
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for e in ix
        .entries
        .iter()
        .chain(ix.nested.values().flat_map(|n| n.entries.iter()))
    {
        let name = e.class_name.to_lowercase();
        let pkg = e.package_name.to_lowercase();
        if name.contains(&q) || pkg.contains(&q) {
            out.push(serde_json::json!({
                "entryPath": e.entry_path,
                "className": e.class_name,
                "packageName": e.package_name,
                "kind": e.kind,
                "modified": false,
                "compileStatus": "none",
            }));
            if out.len() >= 200 {
                break;
            }
        }
    }
    Ok(out)
}

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
        } else if matches!(
            ch,
            '.' | '$' | '/' | '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '+' | '-' | '^' | '|'
        ) {
            re.push('\\');
            re.push(ch);
        } else {
            re.push(ch);
        }
    }
    re.push_str(".*");
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
    let pat = pattern.trim();
    if pat.is_empty() {
        return Ok(Vec::new());
    }
    let re = open_type_regexp(pat)?;
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let pids: Vec<String> = if scope.as_deref() == Some("all") {
        indexes.keys().cloned().collect()
    } else {
        vec![project_id.clone()]
    };
    let mut out = Vec::new();
    for pid in pids {
        let Some(ix) = indexes.get(&pid) else {
            continue;
        };
        for e in ix.entries.iter().filter(|e| e.kind == "class") {
            if re.is_match(simple_class_name(&e.class_name)) {
                out.push(serde_json::json!({
                    "entryPath": e.entry_path,
                    "className": e.class_name,
                    "packageName": e.package_name,
                    "libraryId": "",
                    "projectId": pid,
                    "projectName": ix.name,
                    "isInnerClass": e.is_inner_class,
                    "modified": false,
                }));
                if out.len() >= 500 {
                    return Ok(out);
                }
            }
        }
        for (lib_id, n) in &ix.nested {
            for e in n.entries.iter().filter(|e| e.kind == "class") {
                if re.is_match(simple_class_name(&e.class_name)) {
                    out.push(serde_json::json!({
                        "entryPath": e.entry_path,
                        "className": e.class_name,
                        "packageName": e.package_name,
                        "libraryId": lib_id,
                        "projectId": pid,
                        "projectName": n.name,
                        "isInnerClass": e.is_inner_class,
                        "modified": false,
                    }));
                    if out.len() >= 500 {
                        return Ok(out);
                    }
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
    _project_id: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::collections::BTreeSet;
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let mut names: BTreeSet<String> = BTreeSet::new();
    let mut simple: BTreeSet<String> = BTreeSet::new();
    for ix in indexes.values() {
        for e in ix
            .entries
            .iter()
            .chain(ix.nested.values().flat_map(|n| n.entries.iter()))
        {
            if e.kind == "class" {
                names.insert(e.class_name.clone());
                if let Some(s) = e.class_name.rsplit('.').next() {
                    simple.insert(s.to_string());
                }
            }
        }
    }
    Ok(serde_json::json!({
        "names": names.into_iter().collect::<Vec<_>>(),
        "simple": simple.into_iter().collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub async fn jar_method_location(
    project_id: String,
    class_internal_name: String, // slash form, e.g. "demo/Bar"
    method_name: String,
    _descriptor: Option<String>, // reserved for descriptor-accurate matching
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    

    // Resolve the declaring class: walk the super chain from the named type
    // (JD-GUI searchTypeHavingMember) against the in-memory index.
    fn resolve_member(
        indexes: &std::collections::HashMap<String, Arc<MemoryIndex>>,
        project_id: &str,
        type_internal: &str,
        method_name: &str,
        decompiler_jar: &std::path::Path,
        scratch: &std::path::Path,
        visited: &mut std::collections::HashSet<String>,
    ) -> Result<Option<(String, String, String, i64)>, String> {
        if !visited.insert(type_internal.to_string()) {
            return Ok(None); // cycle detected
        }
        let Some(ix) = indexes.get(project_id) else {
            return Ok(None);
        };
        let dotted = type_internal.replace('/', ".");
        let Some((library_id, entry)) = ix.find_class(&dotted) else {
            return Ok(None);
        };
        let bytes = match ix.read_class_bytes(&library_id, &entry.entry_path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let members = jar::class_members(&bytes);
        if members.methods.iter().any(|m| m == method_name) {
            let scratch_dir = scratch.join(project_id);
            let _ = std::fs::create_dir_all(&scratch_dir);
            let class_file =
                scratch_dir.join(format!("loc-{}.class", entry.entry_path.replace('/', "_")));
            if std::fs::write(&class_file, &bytes).is_ok() {
                let siblings_dir =
                    scratch_dir.join(format!("sib-{}", entry.entry_path.replace('/', "_")));
                let _ = std::fs::remove_dir_all(&siblings_dir);
                let _ =
                    ix.extract_sibling_classes_to(&library_id, &entry.entry_path, &siblings_dir);
                let classpath_arg = siblings_dir.display().to_string();
                let internal_name = entry
                    .entry_path
                    .strip_suffix(".class")
                    .unwrap_or(&entry.entry_path);
                if let Ok(res) = decompile::decompile_class_with_classpath(
                    &class_file,
                    decompiler_jar,
                    &classpath_arg,
                    internal_name,
                    None,
                ) {
                    let _ = std::fs::remove_file(&class_file);
                    let hit = jar::extract_methods(&res.source)
                        .into_iter()
                        .find(|m| m.name == method_name);
                    return Ok(Some((
                        entry.class_name.clone(),
                        entry.entry_path.clone(),
                        library_id,
                        hit.map(|m| m.line as i64).unwrap_or(1),
                    )));
                }
                let _ = std::fs::remove_file(&class_file);
            }
            return Ok(Some((
                entry.class_name.clone(),
                entry.entry_path.clone(),
                library_id,
                1,
            )));
        }
        let (sup, ifaces) = jar::class_super(&bytes).unwrap_or((None, Vec::new()));
        for parent in sup.iter().chain(ifaces.iter()) {
            if let Some(found) = resolve_member(
                indexes,
                project_id,
                parent,
                method_name,
                decompiler_jar,
                scratch,
                visited,
            )? {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }

    let decompiler_jar = state.decompiler_jar()?;
    let scratch = state.scratch.clone();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        match resolve_member(
            &indexes,
            &project_id,
            &class_internal_name,
            &method_name,
            &decompiler_jar,
            &scratch,
            &mut visited,
        )? {
            Some((class_name, entry_path, library_id, line)) => Ok(serde_json::json!({
                "entryPath": entry_path,
                "className": class_name,
                "libraryId": library_id,
                "line": line,
            })),
            None => Err(format!("Method not found: {method_name}")),
        }
    }
}

#[tauri::command]
pub async fn jar_type_hierarchy(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    let target_lib = library_id.clone().unwrap_or_default();

    let target_entry = if target_lib.is_empty() {
        ix.entries
            .iter()
            .find(|e| e.kind == "class" && e.entry_path == entry_path)
    } else {
        ix.nested.get(&target_lib).and_then(|n| {
            n.entries
                .iter()
                .find(|e| e.kind == "class" && e.entry_path == entry_path)
        })
    };
    let target_class_name = target_entry
        .map(|e| e.class_name.clone())
        .ok_or("Class not found")?;

    // Lazy subtype edges: scan every opened container's classes; each class's
    // super + interfaces become (super → this) edges (JD-GUI subTypeNames).
    let mut children: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let read_class = |ix: &MemoryIndex, e: &jar::JarEntryInfo| -> Option<Vec<u8>> {
        let lib = if ix.entries.iter().any(|x| std::ptr::eq(x, e)) {
            ""
        } else {
            ix.nested
                .values()
                .find(|n| n.entries.iter().any(|x| std::ptr::eq(x, e)))
                .map(|n| n.id.as_str())
                .unwrap_or("")
        };
        ix.read_class_bytes(lib, &e.entry_path).ok()
    };
    for e in ix
        .entries
        .iter()
        .chain(ix.nested.values().flat_map(|n| n.entries.iter()))
    {
        if e.kind != "class" {
            continue;
        }
        let Some(bytes) = read_class(ix, e) else {
            continue;
        };
        let Ok((sup, ifaces)) = jar::class_super(&bytes) else {
            continue;
        };
        for parent in sup.iter().chain(ifaces.iter()) {
            let pd = parent.replace('/', ".");
            children.entry(pd).or_default().push(e.class_name.clone());
        }
    }
    for v in children.values_mut() {
        v.sort();
        v.dedup();
    }

    fn ancestors(
        ix: &MemoryIndex,
        read: &dyn Fn(&MemoryIndex, &jar::JarEntryInfo) -> Option<Vec<u8>>,
        name: &str,
        out: &mut Vec<String>,
        visited: &mut std::collections::HashSet<String>,
    ) {
        if !visited.insert(name.to_string()) {
            return;
        }
        let Some((_, e)) = ix.find_class(name) else {
            return;
        };
        let Some(bytes) = read(ix, e) else { return };
        if let Ok((sup, _)) = jar::class_super(&bytes) {
            if let Some(p) = sup {
                out.push(p.clone());
                ancestors(ix, read, &p, out, visited);
            }
        }
    }
    let mut parent_chain: Vec<String> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    ancestors(
        ix,
        &read_class,
        &target_class_name,
        &mut parent_chain,
        &mut visited,
    );

    fn subtree(
        children: &std::collections::HashMap<String, Vec<String>>,
        name: &str,
        depth: usize,
        seen: &mut std::collections::HashSet<String>,
    ) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        if depth > 16 || !seen.insert(name.to_string()) {
            return out;
        }
        if let Some(kids) = children.get(name) {
            for k in kids {
                out.push(serde_json::json!({
                    "className": k,
                    "children": subtree(children, k, depth + 1, seen),
                }));
            }
        }
        out
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(target_class_name.clone());
    let sub_types = subtree(&children, &target_class_name, 0, &mut seen);

    let mut parent_subtypes: Vec<Vec<String>> = Vec::new();
    for p in &parent_chain {
        parent_subtypes.push(children.get(p).cloned().unwrap_or_default());
    }

    Ok(serde_json::json!({
        "target": target_class_name,
        "targetEntryPath": entry_path,
        "parents": parent_chain,
        "parentSubTypes": parent_subtypes,
        "subTypes": sub_types,
    }))
}

// JD-GUI SearchInConstantPoolsView flag bits (exact values from source).
const SEARCH_TYPE: u32 = 1;
const SEARCH_CONSTRUCTOR: u32 = 2;
const SEARCH_METHOD: u32 = 4;
const SEARCH_FIELD: u32 = 8;
const SEARCH_STRING: u32 = 16;
const SEARCH_MODULE: u32 = 32;
const SEARCH_DECLARATION: u32 = 64;
const SEARCH_REFERENCE: u32 = 128;

#[tauri::command]

/// JD-GUI SearchInConstantPoolsController.createPattern: a SIMPLE regular
/// expression from the user pattern — `*` → `.*`, `?` → `.`, `.` → `\.`,
/// every other character literal; matched with `Matcher.matches()`.
fn constant_pool_regexp(pattern: &str) -> Result<regex::Regex, String> {
    let mut re = String::new();
    for c in pattern.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            '.' => re.push_str("\\."),
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' => re.push(c),
            c => {
                re.push('\\');
                re.push(c);
            }
        }
    }
    let anchored = format!("^(?:{re})");
    regex::Regex::new(&anchored).map_err(|e| format!("bad pattern: {e}"))
}

/// Simple name of an internal type name ("java/util/Map$Entry" → "Entry").
fn simple_internal_name(internal: &str) -> &str {
    let slash = internal.rfind('/').map(|i| i + 1).unwrap_or(0);
    let dollar = internal.rfind('$').map(|i| i + 1).unwrap_or(0);
    &internal[slash.max(dollar)..]
}

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

#[tauri::command]
pub async fn jar_constant_search(
    project_id: String,
    pattern: String,
    flags: u32,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    use std::collections::BTreeMap;
    let pat = pattern.trim();
    if pat.is_empty() {
        return Ok(serde_json::json!({ "results": [] }));
    }
    let re = constant_pool_regexp(pat)?;
    let want = |bit: u32| flags & bit != 0;
    let want_type = want(SEARCH_TYPE);
    let want_ctor = want(SEARCH_CONSTRUCTOR);
    let want_method = want(SEARCH_METHOD);
    let want_field = want(SEARCH_FIELD);
    let want_string = want(SEARCH_STRING);
    let want_decl = want(SEARCH_DECLARATION);
    let want_ref = want(SEARCH_REFERENCE);
    let want_module = want(SEARCH_MODULE);
    let scan_strings = want_string && (want_decl || want_ref);

    let scan = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        let mut scopes: Vec<(Vec<u8>, String)> = Vec::new();
        if let Ok(b) = std::fs::read(&ix.jar_path) {
            scopes.push((b, String::new()));
        }
        for (lib_id, n) in &ix.nested {
            scopes.push((n.bytes.clone(), lib_id.clone()));
        }
        tauri::async_runtime::spawn_blocking(move || {
            let mut file_results: BTreeMap<String, serde_json::Value> = BTreeMap::new();
            for (jar_bytes, lib_id) in &scopes {
                let mut cur = std::io::Cursor::new(jar_bytes);
                let mut archive = match zip::ZipArchive::new(&mut cur) {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                for i in 0..archive.len() {
                    let mut entry = match archive.by_index(i) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    let name = entry.name().to_string();
                    if name.ends_with('/') {
                        continue;
                    }
                    if !want_decl && !want_ref {
                        break;
                    }
                    let bytes = {
                        let mut buf = Vec::with_capacity(entry.size() as usize);
                        use std::io::Read;
                        if entry.read_to_end(&mut buf).is_err() {
                            continue;
                        }
                        buf
                    };
                    let is_class = name.ends_with(".class");
                    let mut matches: Vec<serde_json::Value> = Vec::new();
                    if is_class {
                        if let Ok(pool) = jar::parse_class_pool(&bytes) {
                            if want_type {
                                for t in &pool.type_refs {
                                    if re.is_match(simple_internal_name(t)) {
                                        matches.push(
                                            serde_json::json!({ "kind": "type", "value": t }),
                                        );
                                    }
                                }
                            }
                            if want_string && scan_strings {
                                for s in &pool.strings {
                                    if re.is_match(s) {
                                        matches.push(
                                            serde_json::json!({ "kind": "string", "value": s }),
                                        );
                                    }
                                }
                            }
                            if want_method || want_field || want_ctor {
                                let members = jar::class_members(&bytes);
                                if want_method {
                                    for m in &members.methods {
                                        if re.is_match(m) {
                                            matches.push(
                                                serde_json::json!({ "kind": "method", "value": m }),
                                            );
                                        }
                                    }
                                }
                                if want_field {
                                    for f in &members.fields {
                                        if re.is_match(f) {
                                            matches.push(
                                                serde_json::json!({ "kind": "field", "value": f }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } else if want_string && scan_strings && name.ends_with(".properties")
                        || want_module && name.ends_with("module-info.class")
                    {
                        if want_string && scan_strings && name.ends_with(".properties") {
                            if let Ok(text) = String::from_utf8(bytes.clone()) {
                                if re.is_match(&text) {
                                    matches.push(
                                        serde_json::json!({ "kind": "string", "value": text }),
                                    );
                                }
                            }
                        }
                        if want_module && name.ends_with("module-info.class") {
                            if re.is_match(&name) {
                                matches
                                    .push(serde_json::json!({ "kind": "module", "value": name }));
                            }
                        }
                    }
                    if !matches.is_empty() {
                        let entry = file_results.entry(name.clone()).or_insert_with(|| {
                            serde_json::json!({
                                "entryPath": name,
                                "className": name,
                                "libraryId": lib_id,
                                "kind": "class",
                                "matches": Vec::<serde_json::Value>::new(),
                            })
                        });
                        if let Some(arr) = entry.get_mut("matches").and_then(|m| m.as_array_mut()) {
                            arr.extend(matches);
                        }
                    }
                    if file_results.len() >= 500 {
                        break;
                    }
                }
            }
            Ok::<_, String>(
                serde_json::json!({ "results": file_results.into_values().collect::<Vec<_>>() }),
            )
        })
    }
    .await
    .map_err(|e| e.to_string())??;
    Ok(scan)
}

#[tauri::command]
pub async fn jar_decompile(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    escape_unicode: Option<bool>,
    realign: Option<bool>,
    state: State<'_, JarState>,
) -> Result<ClassView, String> {
    let (is_inner, class_bytes) = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        let lib_id = library_id.clone().unwrap_or_default();
        let entry = if lib_id.is_empty() {
            ix.entries.iter().find(|e| e.entry_path == entry_path)
        } else {
            ix.nested
                .get(&lib_id)
                .and_then(|n| n.entries.iter().find(|e| e.entry_path == entry_path))
        }
        .ok_or_else(|| format!("Class not found in archive: {entry_path}"))?;
        let bytes = ix.read_class_bytes(&lib_id, &entry_path)?;
        (entry.is_inner_class, bytes)
    };
    if !class_bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err(format!(
            "Class {} is not a valid JVM class (missing CAFEBABE magic, {} bytes). It may be encrypted or corrupt.",
            entry_path,
            class_bytes.len()
        ));
    }
    let decompiler_jar = state.decompiler_jar()?;
    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);
    let scratch = state.scratch.join(&project_id);
    std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;
    let class_file = scratch.join(format!("{}.class", entry_path.replace('/', "_")));
    std::fs::write(&class_file, &class_bytes).map_err(|e| format!("write class: {e}"))?;

    let siblings_dir = scratch.join("siblings");
    let _ = std::fs::remove_dir_all(&siblings_dir);
    let lib_id = library_id.clone().unwrap_or_default();
    let classpath_arg = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        ix.extract_sibling_classes_to(&lib_id, &entry_path, &siblings_dir)
            .ok();
        siblings_dir.display().to_string()
    };

    let result = tauri::async_runtime::spawn_blocking({
        let jd = decompiler_jar.clone();
        let cf = class_file.clone();
        let cancel = cancel.clone();
        let cp = classpath_arg.clone();
        let internal_name = entry_path
            .strip_suffix(".class")
            .unwrap_or(&entry_path)
            .to_string();
        let mut opts = decompile::DecompileOptions::default();
        if let Some(v) = escape_unicode {
            opts.escape_unicode = v;
        }
        if let Some(v) = realign {
            opts.realign = v;
        }
        move || {
            decompile::decompile_class_with_options(
                &cf,
                &jd,
                &cp,
                &internal_name,
                opts,
                Some(cancel),
            )
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let source = result.source.clone();
    let _ = std::fs::remove_file(&class_file);
    let refs = result.refs;
    let methods: Vec<MethodLine> = jar::extract_methods(&source)
        .into_iter()
        .map(|m| MethodLine {
            name: m.name,
            line: m.line as i64,
        })
        .collect();
    Ok(ClassView {
        entry_path: entry_path.clone(),
        class_name: entry_path_to_class_name(&entry_path),
        package_name: entry_path_to_package(&entry_path),
        kind: "class".into(),
        is_inner_class: is_inner,
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
pub async fn jar_decompile_cancel(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<(), String> {
    let flag = state.cancel_flag(&project_id);
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

// ── Read resource text ────────────────────────────────────────────────────

#[tauri::command]
pub async fn jar_resource_read(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<String, String> {
    let lib_id = library_id.clone().unwrap_or_default();
    let bytes = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        ix.read_class_bytes(&lib_id, &entry_path)?
    };
    String::from_utf8(bytes).map_err(|_| "Resource is binary, not UTF-8 text.".into())
}


#[tauri::command]
pub async fn jar_library_index(
    project_id: String,
    library_id: String,
    state: State<'_, JarState>,
) -> Result<std::collections::BTreeMap<String, jar::PackageNode>, String> {
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    let n = ix.nested.get(&library_id).ok_or("Library not found")?;
    Ok(n.tree.clone())
}

#[tauri::command]
pub async fn jar_navigate(
    project_id: String,
    name: String,
    kind: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let indexes = state.indexes.lock().expect("indexes poisoned");
    if kind == "class" {
        let name_dotted = name.replace('/', ".");
        fn hits_for(ix: &MemoryIndex, pid: &str, name_dotted: &str) -> Vec<serde_json::Value> {
            let mut local: Vec<serde_json::Value> = Vec::new();
            let lib_of = |e: &jar::JarEntryInfo| -> String {
                if ix.entries.iter().any(|x| std::ptr::eq(x, e)) {
                    return String::new();
                }
                ix.nested
                    .values()
                    .find(|n| n.entries.iter().any(|x| std::ptr::eq(x, e)))
                    .map(|n| n.id.clone())
                    .unwrap_or_default()
            };
            if let Some((lib_id, e)) = ix.find_class(name_dotted) {
                local.push(serde_json::json!({
                    "kind": "class",
                    "className": e.class_name,
                    "entryPath": e.entry_path,
                    "libraryId": lib_id,
                    "projectId": pid,
                    "line": null,
                }));
            }
            if local.is_empty() {
                let simple = name_dotted
                    .rsplit('.')
                    .next()
                    .unwrap_or(name_dotted)
                    .to_string();
                for e in ix
                    .entries
                    .iter()
                    .chain(ix.nested.values().flat_map(|n| n.entries.iter()))
                {
                    if e.kind == "class" && e.class_name.rsplit('.').next() == Some(simple.as_str())
                    {
                        local.push(serde_json::json!({
                            "kind": "class",
                            "className": e.class_name,
                            "entryPath": e.entry_path,
                            "libraryId": lib_of(e),
                            "projectId": pid,
                            "line": null,
                        }));
                    }
                }
            }
            local
        }
        let mut hits: Vec<serde_json::Value> = Vec::new();
        if let Some(ix) = indexes.get(&project_id) {
            hits = hits_for(ix, &project_id, &name_dotted);
        }
        if hits.is_empty() {
            for (pid, ix) in indexes.iter() {
                if pid == &project_id {
                    continue;
                }
                hits = hits_for(ix, pid, &name_dotted);
                if !hits.is_empty() {
                    break;
                }
            }
        }
        if hits.is_empty() {
            return Err(format!("Class not found: {name}"));
        }
        if hits.len() == 1 {
            return Ok(hits.into_iter().next().unwrap());
        }
        return Ok(serde_json::json!({ "kind": "multiple", "candidates": hits }));
    }
    if kind == "method" {
        let simple = name.rsplit('.').next().unwrap_or(&name).to_string();
        let mut found: Option<serde_json::Value> = None;
        for (pid, ix) in indexes.iter() {
            if pid != &project_id {
                continue;
            }
            for e in ix
                .entries
                .iter()
                .chain(ix.nested.values().flat_map(|n| n.entries.iter()))
            {
                if e.kind != "class" {
                    continue;
                }
                let lib = if ix.entries.iter().any(|x| std::ptr::eq(x, e)) {
                    ""
                } else {
                    ix.nested
                        .values()
                        .find(|n| n.entries.iter().any(|x| std::ptr::eq(x, e)))
                        .map(|n| n.id.as_str())
                        .unwrap_or("")
                };
                let bytes = match ix.read_class_bytes(lib, &e.entry_path) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let members = jar::class_members(&bytes);
                if members.methods.iter().any(|m| m == &simple) {
                    found = Some(serde_json::json!({
                        "kind": "method",
                        "className": e.class_name,
                        "entryPath": e.entry_path,
                        "libraryId": lib.to_string(),
                        "projectId": pid,
                        "line": null,
                    }));
                    break;
                }
            }
            if found.is_some() {
                break;
            }
        }
        return match found {
            Some(v) => Ok(v),
            None => Err(format!("Method not found: {name}")),
        };
    }
    Err(format!("Unknown navigation kind: {kind}"))
}

#[tauri::command]
pub async fn jar_resource_bytes(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let lib_id = library_id.clone().unwrap_or_default();
    let bytes = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        ix.read_class_bytes(&lib_id, &entry_path)?
    };
    use base64::Engine;
    Ok(serde_json::json!({
        "bytes": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "size": bytes.len(),
        "isText": bytes.iter().all(|&b| b == b'\n' || b == b'\r' || b == b'\t' || (b >= 0x20 && b < 0x7f) || b >= 0x80),
    }))
}

#[tauri::command]
pub async fn jar_export_all(
    project_id: String,
    output_dir: String,
    write_metadata: Option<bool>,
    write_line_numbers: Option<bool>,
    escape_unicode: Option<bool>,
    realign: Option<bool>,
    app: AppHandle,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let (export_items, main_path, grouped_inner_class_entries) = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        let mut items = Vec::new();
        let mut grouped_inner_class_entries = Vec::new();
        for entry in &ix.entries {
            if entry.kind == "class" {
                if entry.is_inner_class {
                    grouped_inner_class_entries.push(entry.entry_path.clone());
                    continue;
                }
                items.push(ExportItem::Source {
                    entry_path: entry.entry_path.clone(),
                    class_name: entry.class_name.clone(),
                    fallback_entries: source_unit_fallback_entries(ix, &entry.entry_path),
                });
            } else {
                items.push(ExportItem::Resource {
                    entry_path: entry.entry_path.clone(),
                });
            }
        }
        (items, ix.jar_path.clone(), grouped_inner_class_entries)
    };
    let item_count = export_items.len();
    emit_export_progress(
        &app,
        &project_id,
        "preparing",
        0,
        item_count,
        None,
        None,
    );
    let decompiler_jar = state.decompiler_jar()?;
    let cancel = state.cancel_flag(&project_id);
    cancel.store(false, Ordering::Relaxed);
    let scratch_root = state.scratch.clone();
    let indexes = Arc::clone(&state.indexes);

    tauri::async_runtime::spawn_blocking(move || {
        let out = PathBuf::from(&output_dir);
        let want_zip = out
            .extension()
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
        let staging = if want_zip {
            let st = scratch_root.join(format!("{project_id}-export-src"));
            let _ = std::fs::remove_dir_all(&st);
            std::fs::create_dir_all(&st).map_err(|e| format!("create staging: {e}"))?;
            st
        } else {
            std::fs::create_dir_all(&out).map_err(|e| format!("create output dir: {e}"))?;
            out.clone()
        };

        let scratch = scratch_root.join(&project_id);
        std::fs::create_dir_all(&scratch).map_err(|e| format!("scratch: {e}"))?;

        let classpath = scratch.join("classpath");
        let fallback_root = staging.join("fallback");

        let mut exported = 0usize;
        let mut failed: Vec<String> = Vec::new();
        let mut source_units = 0usize;
        let mut resources = 0usize;
        let mut failures = Vec::new();

        // Clone the Arc'd index and drop the map lock immediately: the
        // export loop below runs a JD-Core child process per class and can
        // take minutes; holding the global `indexes` mutex for that long
        // blocks every other jar_* command (audit P0-1).
        let ix = {
            let indexes = indexes.lock().expect("indexes poisoned");
            Arc::clone(indexes.get(&project_id).ok_or("Project not found")?)
        };
        ix.extract_main_classes_to(&classpath)?;
        for (completed, item) in export_items.iter().enumerate() {
            let (entry, class_name, _fallback_entries) = match item {
                ExportItem::Source {
                    entry_path,
                    class_name,
                    fallback_entries,
                } => (entry_path, Some(class_name.clone()), Some(fallback_entries)),
                ExportItem::Resource { entry_path } => (entry_path, None, None),
            };
            if cancel.load(Ordering::Relaxed) {
                emit_export_progress(
                    &app,
                    &project_id,
                    "cancelled",
                    completed,
                    item_count,
                    None,
                    None,
                );
                return Err("Export cancelled".into());
            }
            emit_export_progress(
                &app,
                &project_id,
                "processing",
                completed,
                item_count,
                Some(class_name.clone().unwrap_or_else(|| entry.clone())),
                None,
            );
            if class_name.is_none() {
                let bytes = match jar::read_entry_bytes(Path::new(&main_path), entry) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        failed.push(entry.clone());
                        emit_export_progress(&app, &project_id, "failed", completed + 1, item_count, Some(entry.clone()), Some(error));
                        continue;
                    }
                };
                let dest = staging.join(entry);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match std::fs::write(&dest, bytes) {
                    Ok(()) => {
                        exported += 1;
                        resources += 1;
                    }
                    Err(error) => {
                        failed.push(entry.clone());
                        emit_export_progress(&app, &project_id, "failed", completed + 1, item_count, Some(entry.clone()), Some(format!("copy resource: {error}")));
                    }
                }
                emit_export_progress(&app, &project_id, "decompiling", completed + 1, item_count, Some(entry.clone()), None);
                continue;
            }

            let class_name = class_name.as_ref().expect("class item must have a name");
            let bytes = match ix.read_class_bytes("", entry) {
                Ok(b) => b,
                Err(error) => {
                    failed.push(class_name.clone());
                    emit_export_progress(
                        &app,
                        &project_id,
                        "failed",
                        completed + 1,
                        item_count,
                        Some(class_name.clone()),
                        Some(error),
                    );
                    continue;
                }
            };
            let class_file = scratch.join(format!("{}.class", entry.replace('/', "_")));
            if let Err(error) = std::fs::write(&class_file, &bytes) {
                failed.push(class_name.clone());
                emit_export_progress(
                    &app,
                    &project_id,
                    "failed",
                    completed + 1,
                    item_count,
                    Some(class_name.clone()),
                    Some(format!("write class: {error}")),
                );
                continue;
            }
            let internal_name = class_name.replace('.', "/");
            let mut saver_opts = decompile::DecompileOptions::saver();
            if let Some(v) = escape_unicode {
                saver_opts.escape_unicode = v;
            }
            if let Some(v) = realign {
                saver_opts.realign = v;
            }
            if let Some(wl) = write_line_numbers {
                saver_opts.line_numbers = wl;
            }
            let res = decompile::decompile_class_with_options(
                &class_file,
                &decompiler_jar,
                &classpath.display().to_string(),
                &internal_name,
                saver_opts,
                Some(cancel.clone()),
            );
            match res {
                Ok(res) => {
                    let mut out_src = res.source;
                    if write_metadata.unwrap_or(true) {
                        let location = main_path.replace('\\', "/");
                        let (minor, major, version_label) =
                            jar::class_file_info(&bytes).unwrap_or((0, 0, String::new()));
                        let mut meta = String::new();
                        meta.push_str("\n\n/* Location:              ");
                        meta.push_str(&location);
                        meta.push_str(&format!(
                            ":{entry}\n * Java compiler version: {version_label}"
                        ));
                        meta.push_str(&format!(" ({}", major));
                        meta.push_str(&format!(
                            ".{})\n * JD-Core Version:       1.1.3\n */",
                            minor
                        ));
                        out_src.push_str(&meta);
                    }
                    let rel_java = entry.replace(".class", ".java");
                    let dest = staging.join(&rel_java);
                    if let Some(parent) = dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match std::fs::write(&dest, &out_src) {
                        Ok(()) => {
                            exported += 1;
                            source_units += 1;
                        }
                        Err(error) => {
                            failed.push(class_name.clone());
                            emit_export_progress(
                                &app,
                                &project_id,
                                "failed",
                                completed + 1,
                                item_count,
                                Some(class_name.clone()),
                                Some(format!("write source: {error}")),
                            );
                        }
                    }
                }
                Err(error) => {
                    failed.push(class_name.clone());
                    emit_export_progress(
                        &app,
                        &project_id,
                        "failed",
                        completed + 1,
                        item_count,
                        Some(class_name.clone()),
                        Some(error),
                    );
                }
            }
            let _ = std::fs::remove_file(&class_file);
            emit_export_progress(
                &app,
                &project_id,
                "decompiling",
                completed + 1,
                item_count,
                Some(class_name.clone()),
                None,
            );
        }
        for item in &export_items {
            match item {
                ExportItem::Source {
                    entry_path,
                    class_name,
                    fallback_entries,
                } if failed.contains(class_name) => {
                    let fallback_entries = write_fallback_classes(&ix, fallback_entries, &fallback_root);
                    failures.push(ExportFailure {
                        entry_path: entry_path.clone(),
                        reason: "Source decompilation or write failed; original bytecode preserved".into(),
                        fallback_entries,
                    });
                }
                ExportItem::Resource { entry_path } if failed.contains(entry_path) => {
                    failures.push(ExportFailure {
                        entry_path: entry_path.clone(),
                        reason: "Resource copy failed".into(),
                        fallback_entries: Vec::new(),
                    });
                }
                _ => {}
            }
        }
        let manifest = ExportManifest {
            source_units,
            grouped_inner_classes: grouped_inner_class_entries.len(),
            grouped_inner_class_entries,
            resources,
            failures,
        };
        let manifest_path = staging.join("export-manifest.json");
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("serialize export manifest: {e}"))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| format!("write export manifest: {e}"))?;

        if want_zip {
            emit_export_progress(
                &app,
                &project_id,
                "packing",
                item_count,
                item_count,
                None,
                None,
            );
            let file = std::fs::File::create(&out).map_err(|e| format!("create zip: {e}"))?;
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            pack_dir_into_zip(&staging, "", &mut zip, opts)?;
            zip.finish().map_err(|e| format!("finish zip: {e}"))?;
            let _ = std::fs::remove_dir_all(&staging);
        }

        emit_export_progress(
            &app,
            &project_id,
            "completed",
            item_count,
            item_count,
            None,
            None,
        );

        Ok(serde_json::json!({
            "exported": exported,
            "total": item_count,
            "failed": failed.len(),
            "failedClasses": failed,
            "outputDir": output_dir,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Recursively pack a directory into a zip (export "Save All Sources" as zip).
fn pack_dir_into_zip(
    dir: &std::path::Path,
    prefix: &str,
    zip: &mut zip::ZipWriter<std::fs::File>,
    opts: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            pack_dir_into_zip(&path, &rel, zip, opts)?;
        } else {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            zip.start_file(rel.clone(), opts)
                .map_err(|e| format!("zip start {rel}: {e}"))?;
            use std::io::Write;
            zip.write_all(&bytes)
                .map_err(|e| format!("zip write {rel}: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn jar_libraries(
    project_id: String,
    state: State<'_, JarState>,
) -> Result<Vec<serde_json::Value>, String> {
    let indexes = state.indexes.lock().expect("indexes poisoned");
    let ix = indexes.get(&project_id).ok_or("Project not found")?;
    let mut libs: Vec<serde_json::Value> = ix
        .nested
        .values()
        .map(|n| {
            serde_json::json!({
                "id": n.id,
                "name": n.name,
                "groupId": "",
                "artifactId": n.entry_path.rsplit('/').next().unwrap_or("").replace(".jar", ""),
                "version": "",
                "jarPath": n.entry_path,
                "classCount": n.class_count,
                "editable": false,
            })
        })
        .collect();
    libs.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(libs)
}

/// Open a Maven pom.xml: the built main jar + dependency jars are indexed in
/// memory (JD-GUI: pom dependencies become read-only containers).
#[tauri::command]
pub async fn jar_pom_open(
    path: String,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let pom_path = PathBuf::from(&path);
    if !pom_path.is_file() {
        return Err(format!("pom.xml not found: {}", pom_path.display()));
    }
    let pom = crate::pom::parse_pom_file(&pom_path)?;
    let id = format!(
        "jar-pom-{}",
        crate::jar::sha256_bytes(
            format!("{}:{}:{}", pom.group_id, pom.artifact_id, pom.version).as_bytes()
        )
        .get(..16)
        .unwrap_or("pom")
    );

    let pom_dir = pom_path.parent().unwrap_or(Path::new("."));
    let main_jar = {
        let c1 = pom_dir
            .join("target")
            .join(format!("{}-{}.jar", pom.artifact_id, pom.version));
        let c2 = pom_dir.join(format!("{}-{}.jar", pom.artifact_id, pom.version));
        if c1.is_file() {
            Some(c1)
        } else if c2.is_file() {
            Some(c2)
        } else {
            None
        }
    };

    let mut main_entries: Vec<jar::JarEntryInfo> = Vec::new();
    let mut main_tree: std::collections::BTreeMap<String, jar::PackageNode> = Default::default();
    let mut main_hash = String::new();
    let mut main_size = 0i64;
    let mut class_count = 0usize;
    let mut resource_count = 0usize;
    if let Some(main) = &main_jar {
        if let Ok(idx) = jar::index_jar(main) {
            main_hash = idx.jar_hash.clone();
            main_size = idx.size as i64;
            class_count = idx.class_count;
            resource_count = idx.resource_count;
            main_entries = idx.entries.clone();
            main_tree = jar::build_tree(&idx.entries);
        }
    }

    let mut nested: std::collections::HashMap<String, NestedJarData> =
        std::collections::HashMap::new();
    let mut lib_summaries: Vec<serde_json::Value> = Vec::new();
    for dep in &pom.dependencies {
        let Some(jar_path) = &dep.jar_path else {
            continue;
        };
        let Ok(bytes) = std::fs::read(jar_path) else {
            continue;
        };
        let mut cur = std::io::Cursor::new(bytes.clone());
        let Ok(idx) = jar::index_jar_reader(&mut cur) else {
            continue;
        };
        let base = jar_path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(jar_path)
            .to_string();
        let lib_id = format!(
            "{}:dep:{}",
            id,
            crate::jar::sha256_bytes(jar_path.as_bytes())
                .get(..12)
                .unwrap_or("d")
        );
        let name = format!("{}-{}.jar", dep.artifact_id, dep.version);
        nested.insert(
            lib_id.clone(),
            NestedJarData {
                id: lib_id.clone(),
                entry_path: base.clone(),
                name: name.clone(),
                group_id: dep.group_id.clone(),
                artifact_id: dep.artifact_id.clone(),
                version: dep.version.clone(),
                bytes,
                entries: idx.entries.clone(),
                tree: jar::build_tree(&idx.entries),
                class_count: idx.class_count,
            },
        );
        lib_summaries.push(serde_json::json!({
            "id": lib_id, "name": name, "editable": false, "classCount": idx.class_count,
        }));
    }

    let mut class_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in &main_entries {
        if e.kind == "class" {
            class_names.insert(e.class_name.clone());
        }
    }
    for n in nested.values() {
        for e in &n.entries {
            if e.kind == "class" {
                class_names.insert(e.class_name.clone());
            }
        }
    }

    let name = format!("{}-{}", pom.artifact_id, pom.version);
    let index = MemoryIndex {
        project_id: id.clone(),
        name: name.clone(),
        jar_path: main_jar
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        jar_hash: main_hash,
        size: main_size,
        class_count,
        resource_count,
        entries: main_entries.clone(),
        main_tree: main_tree.clone(),
        nested,
        class_names,
    };
    state
        .indexes
        .lock()
        .expect("indexes poisoned")
        .insert(id.clone(), Arc::new(index));

    Ok(serde_json::json!({
        "projectId": id,
        "name": name,
        "pom": {
            "groupId": pom.group_id,
            "artifactId": pom.artifact_id,
            "version": pom.version,
            "resolvedCount": pom.resolved_count,
        },
        "libraries": lib_summaries,
        "classTree": main_tree,
    }))
}

#[tauri::command]
pub async fn jar_class_info(
    project_id: String,
    entry_path: String,
    library_id: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let lib_id = library_id.clone().unwrap_or_default();
    let bytes = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        ix.read_class_bytes(&lib_id, &entry_path)?
    };
    let (minor, major, java_version) = jar::class_file_info(&bytes)?;
    Ok(serde_json::json!({
        "className": entry_path_to_class_name(&entry_path),
        "javaVersion": java_version,
        "major": major,
        "minor": minor,
        "size": bytes.len(),
    }))
}

/// Download the Maven -sources.jar for a pom-opened dependency and extract it
/// under the scratch dir (cached by g:a:v). The library must have Maven
/// coordinates (pom-opened); fat-jar nested jars have none.
#[tauri::command]
pub async fn jar_maven_sources(
    project_id: String,
    library_id: String,
    filters: Option<String>,
    state: State<'_, JarState>,
) -> Result<serde_json::Value, String> {
    let (group_id, artifact_id, version) = {
        let indexes = state.indexes.lock().expect("indexes poisoned");
        let ix = indexes.get(&project_id).ok_or("Project not found")?;
        let n = ix.nested.get(&library_id).ok_or("Library not found")?;
        (n.group_id.clone(), n.artifact_id.clone(), n.version.clone())
    };
    if group_id.is_empty() || artifact_id.is_empty() || version.is_empty() {
        return Err("Library has no Maven coordinates (groupId:artifactId:version). Open via pom.xml to enable source download.".into());
    }
    if let Some(f) = filters {
        let f = f.trim();
        if !f.is_empty() {
            let allow: Vec<&str> = f
                .split_whitespace()
                .filter(|x| x.starts_with('+'))
                .map(|x| &x[1..])
                .collect();
            let deny: Vec<&str> = f
                .split_whitespace()
                .filter(|x| x.starts_with('-'))
                .map(|x| &x[1..])
                .collect();
            let hit = allow.iter().any(|p| group_id.starts_with(p));
            let blocked = deny.iter().any(|p| group_id.starts_with(p));
            let ok = (allow.is_empty() || hit) && !blocked;
            if !ok {
                return Err("Library group is filtered out by the Maven source filter.".into());
            }
        }
    }
    let cache_key = format!("{group_id}:{artifact_id}:{version}");
    let cache_key_safe = cache_key.replace([':', '.', '/'], "_");
    let extract_root = state.scratch.join(format!("maven-src-{cache_key_safe}"));
    let marker = extract_root.join(".ok");
    if !marker.exists() {
        let _ = std::fs::remove_dir_all(&extract_root);
        let _ = std::fs::create_dir_all(&extract_root);
        let url = format!(
            "https://repo1.maven.org/maven2/{}/{}/{}/{}-{}-sources.jar",
            group_id.replace('.', "/"),
            artifact_id,
            version,
            artifact_id,
            version,
        );
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let resp = reqwest::blocking::get(&url).map_err(|e| format!("download {url}: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "Maven sources download failed (HTTP {})",
                    resp.status()
                ));
            }
            resp.bytes()
                .map(|b| b.to_vec())
                .map_err(|e| format!("read body: {e}"))
        })
        .await
        .map_err(|e| e.to_string())??;
        {
            use std::io::Cursor;
            let mut archive = zip::ZipArchive::new(Cursor::new(&bytes))
                .map_err(|e| format!("sources.jar is not a valid zip: {e}"))?;
            for i in 0..archive.len() {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| format!("read zip entry {i}: {e}"))?;
                let name = entry.name().to_string();
                if entry.is_dir() || name.contains("META-INF/") {
                    continue;
                }
                if name.starts_with('/') || name.contains("..") {
                    continue;
                }
                let dest = extract_root.join(&name);
                if !dest.starts_with(&extract_root) {
                    continue;
                }
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let mut out = match std::fs::File::create(&dest) {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                use std::io::Write;
                let _ = std::io::copy(&mut entry, &mut out);
                let _ = out.flush();
            }
        }
        std::fs::write(&marker, "ok").map_err(|e| format!("write marker: {e}"))?;
    }
    Ok(serde_json::json!({
        "root": extract_root.display().to_string(),
        "groupId": group_id,
        "artifactId": artifact_id,
        "version": version,
    }))
}

/// Read a .java file from an extracted Maven sources root (path stays inside
/// the root — zip-slip style traversal is rejected).
#[tauri::command]
pub async fn jar_read_source_file(
    root: String,
    entry_path: String,
) -> Result<serde_json::Value, String> {
    let root_path = PathBuf::from(&root);
    let target = root_path.join(&entry_path);
    if !target.starts_with(&root_path) {
        return Err("Path escapes the sources root.".into());
    }
    if !target.is_file() {
        return Err(format!("Source file not found: {entry_path}"));
    }
    let text = std::fs::read_to_string(&target).map_err(|e| format!("read: {e}"))?;
    Ok(serde_json::json!({ "source": text }))
}

#[cfg(test)]
mod open_type_tests {
    // Ported behavior verified against the real JD-GUI 1.6.6 algorithm
    // (createRegExpPattern + match() on the SIMPLE class name).
    use super::{open_type_regexp, simple_class_name};

    fn matches(pattern: &str, class_name: &str) -> bool {
        open_type_regexp(pattern)
            .unwrap()
            .is_match(simple_class_name(class_name))
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
    fn inner_class_simple_name() {
        // $ keeps the last segment (JD-GUI OpenType matches the SIMPLE name).
        assert!(matches("entry", "java.util.Map$Entry"));
    }

    #[test]
    fn wildcards() {
        assert!(matches("st*", "java.lang.String"));
        assert!(matches("s?r", "java.lang.String"));
    }
}

#[cfg(test)]
mod memory_index_tests {
    use super::*;
    use std::path::Path;

    fn compile(dir: &Path, rel: &str, pkg: &str, body: &str) -> std::path::PathBuf {
        let src = dir.join(rel);
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, format!("package {pkg};\n{body}\n")).unwrap();
        let jdk = crate::compile::detect_jdk();
        assert!(jdk.found);
        let out = dir.join(format!("o-{}", src.file_name().unwrap().to_string_lossy()));
        std::fs::create_dir_all(&out).unwrap();
        assert!(
            std::process::Command::new(jdk.javac_path.as_deref().unwrap())
                .arg("-d")
                .arg(&out)
                .arg(&src)
                .status()
                .unwrap()
                .success()
        );
        out
    }
    fn copy_tree(src: &Path, base: &Path, dest: &Path) {
        if src.is_dir() {
            for f in std::fs::read_dir(src).unwrap() {
                copy_tree(&f.unwrap().path(), base, dest);
            }
        } else {
            let rel = src.strip_prefix(base).unwrap();
            let d = dest.join(rel);
            std::fs::create_dir_all(d.parent().unwrap()).unwrap();
            std::fs::copy(src, d).unwrap();
        }
    }

    #[test]
    fn memory_index_resolves_main_and_nested_classes() {
        let dir = std::env::temp_dir().join(format!("jar-memidx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let dep_out = compile(
            &dir,
            "com/dep/Util.java",
            "com.dep",
            "public class Util { public int f() { return 1; } }",
        );
        let dep_jar = dir.join("dep.jar");
        assert!(std::process::Command::new("jar")
            .arg("cf")
            .arg(&dep_jar)
            .arg("-C")
            .arg(&dep_out)
            .arg(".")
            .status()
            .unwrap()
            .success());

        let main_out = compile(
            &dir,
            "com/app/Main.java",
            "com.app",
            "public class Main { public int x = 1; }",
        );
        let staging = dir.join("stg");
        std::fs::create_dir_all(staging.join("BOOT-INF/classes")).unwrap();
        std::fs::create_dir_all(staging.join("BOOT-INF/lib")).unwrap();
        copy_tree(&main_out, &main_out, &staging.join("BOOT-INF/classes"));
        std::fs::copy(&dep_jar, staging.join("BOOT-INF/lib/dep.jar")).unwrap();
        let fat = dir.join("fat.jar");
        assert!(std::process::Command::new("jar")
            .arg("cf")
            .arg(&fat)
            .arg("-C")
            .arg(&staging)
            .arg(".")
            .status()
            .unwrap()
            .success());

        let idx = jar::index_jar(&fat).unwrap();
        let mut nested_map: std::collections::HashMap<String, NestedJarData> = Default::default();
        {
            use std::io::Read;
            let mut archive = zip::ZipArchive::new(std::fs::File::open(&fat).unwrap()).unwrap();
            for i in 0..archive.len() {
                let mut e = archive.by_index(i).unwrap();
                let name = e.name().to_string();
                if !name.ends_with(".jar") {
                    continue;
                }
                let mut bytes = Vec::new();
                e.read_to_end(&mut bytes).unwrap();
                let mut cur = std::io::Cursor::new(bytes.clone());
                let nidx = jar::index_jar_reader(&mut cur).unwrap();
                assert!(nidx.entries.iter().any(|x| x.class_name == "com.dep.Util"));
                nested_map.insert(
                    "n1".into(),
                    NestedJarData {
                        id: "n1".into(),
                        entry_path: name,
                        name: "[nested] dep.jar|BOOT-INF/lib/dep.jar".into(),
                        group_id: String::new(),
                        artifact_id: "dep".into(),
                        version: String::new(),
                        bytes,
                        entries: nidx.entries.clone(),
                        tree: jar::build_tree(&nidx.entries),
                        class_count: 1,
                    },
                );
            }
        }
        let mut class_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for e in &idx.entries {
            if e.kind == "class" {
                class_names.insert(e.class_name.clone());
            }
        }
        for n in nested_map.values() {
            for e in &n.entries {
                if e.kind == "class" {
                    class_names.insert(e.class_name.clone());
                }
            }
        }
        assert!(class_names.contains("com.app.Main"));
        assert!(class_names.contains("com.dep.Util"));

        let ix = MemoryIndex {
            project_id: "p".into(),
            name: "fat.jar".into(),
            jar_path: fat.display().to_string(),
            jar_hash: idx.jar_hash.clone(),
            size: 0,
            class_count: idx.class_count,
            resource_count: idx.resource_count,
            entries: idx.entries.clone(),
            main_tree: jar::build_tree(&idx.entries),
            nested: nested_map,
            class_names,
        };
        let (lib, entry) = ix.find_class("com.app.Main").expect("main class");
        assert_eq!(lib, "");
        assert_eq!(entry.entry_path, "BOOT-INF/classes/com/app/Main.class");
        let (lib, entry) = ix.find_class("com.dep.Util").expect("nested class");
        assert_eq!(lib, "n1");
        let bytes = ix.read_class_bytes("n1", &entry.entry_path).unwrap();
        assert!(bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]));
        let sib = dir.join("sib");
        ix.extract_sibling_classes_to("", "BOOT-INF/classes/com/app/Main.class", &sib)
            .ok();
        assert!(sib.join("BOOT-INF/classes/com/app/Main.class").is_file());
        println!("MEMORY-INDEX RESOLUTION PASS");
        std::fs::remove_dir_all(&dir).ok();
    }
}
