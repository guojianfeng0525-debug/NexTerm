//! JAR parsing and indexing.
//!
//! Reads a JAR's entries (zip) without extracting everything to memory.
//! Only entry metadata is indexed on open; class bytes / resources are read
//! lazily on demand. The original JAR is always read-only.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use zip::ZipArchive;

/// One indexed entry in the JAR.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarEntryInfo {
    pub entry_path: String,
    /// Class binary name (com.example.Foo) or the entry path for resources.
    pub class_name: String,
    pub package_name: String,
    pub kind: String, // "class" | "resource" | "meta-inf"
    pub is_inner_class: bool,
    pub size: u64,
    pub compressed_size: u64,
}

/// Index result: tree grouped by package + flat list.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarIndex {
    pub entries: Vec<JarEntryInfo>,
    pub class_count: usize,
    pub resource_count: usize,
    pub jar_hash: String,
    pub size: u64,
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// Read the raw bytes of a single entry from the JAR (lazy).
pub fn read_entry_bytes(jar_path: &Path, entry_path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(jar_path).map_err(|e| format!("open jar {}: {e}", jar_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = archive
        .by_name(entry_path)
        .map_err(|e| format!("entry {entry_path} not found: {e}"))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("read entry: {e}"))?;
    Ok(buf)
}

/// Compute the SHA-256 of the whole jar file (streamed).
pub fn hash_jar(jar_path: &Path) -> Result<String, String> {    let mut file = std::fs::File::open(jar_path).map_err(|e| format!("open jar: {e}"))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf).map_err(|e| format!("read jar: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Class file info parsed from a `.class` header (JD-GUI "class file info").
/// Returns (minor, major, java_version_label).
pub fn class_file_info(bytes: &[u8]) -> Result<(u16, u16, String), String> {
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err("Not a valid class file".into());
    }
    let minor = u16::from_be_bytes([bytes[4], bytes[5]]);
    let major = u16::from_be_bytes([bytes[6], bytes[7]]);
    // Java version from class-file major (45=Java 1.1 … 52=Java 8, 55=Java 11, …).
    let java_version = if (45..=64).contains(&major) {
        let release = major as i32 - 44; // 45→1 (1.1), 52→8, 55→11, 64→20
        format!("Java {}", release.max(1))
    } else {
        format!("Java (major {major})")
    };
    Ok((minor, major, java_version))
}

/// Full constant-pool extractor: super/interfaces plus string/field/method
/// references (mirrors JD-GUI's ClassFileIndexerProvider).
#[derive(Debug, Default, Clone)]
pub struct ClassPool {
    pub super_name: Option<String>,
    pub interfaces: Vec<String>,
    pub strings: Vec<String>,
    pub field_refs: Vec<String>,
    pub method_refs: Vec<String>,
    pub type_refs: Vec<String>,
    /// Every type/field/method reference with its owner class and descriptor,
    /// mirroring JD-GUI's printReference data. `internal_type_name` uses JVM
    /// internal (slash) form: "java/lang/String".
    pub refs: Vec<ClassRef>,
}

/// One reference found in the constant pool (JD-GUI ReferenceData equivalent).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassRef {
    /// JVM internal name of the referenced type: "java/lang/String".
    pub internal_type_name: String,
    /// Field/method name, or None for a pure type reference.
    pub name: Option<String>,
    /// "type" | "field" | "method".
    pub kind: String,
    /// JVM descriptor of the member (e.g. "(Ljava/lang/String;)V"), or None.
    pub descriptor: Option<String>,
}

/// Parse a class file's constant pool. Returns super/interfaces plus all
/// string constants, field refs, method refs and type refs.
pub fn parse_class_pool(bytes: &[u8]) -> Result<ClassPool, String> {
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err("Not a valid class file".into());
    }
    let mut off = 8usize;
    let read_u2 = |off: &mut usize| -> Result<u16, String> {
        if *off + 2 > bytes.len() {
            return Err("truncated class file".into());
        }
        let v = u16::from_be_bytes([bytes[*off], bytes[*off + 1]]);
        *off += 2;
        Ok(v)
    };
    let cp_count = read_u2(&mut off)? as usize;
    let mut utf8: Vec<Option<String>> = vec![None; cp_count.max(1)];
    let mut class_name: Vec<Option<usize>> = vec![None; cp_count.max(1)]; // Class → utf8
    let mut string_name: Vec<Option<usize>> = vec![None; cp_count.max(1)]; // String → utf8
    let mut name_and_type: Vec<Option<(u8, usize, usize, usize)>> = vec![None; cp_count.max(1)]; // (tag, class_utf8_idx, name_idx, desc_idx)
    let mut i = 1usize;
    while i < cp_count {
        if off >= bytes.len() {
            return Err("truncated constant pool".into());
        }
        let tag = bytes[off];
        off += 1;
        match tag {
            1 => {
                let len = read_u2(&mut off)? as usize;
                if off + len > bytes.len() {
                    return Err("truncated utf8".into());
                }
                utf8[i] = Some(String::from_utf8_lossy(&bytes[off..off + len]).into_owned());
                off += len;
            }
            7 => {
                let idx = read_u2(&mut off)? as usize;
                if idx < cp_count {
                    class_name[i] = Some(idx);
                }
            }
            8 => {
                let idx = read_u2(&mut off)? as usize;
                if idx < cp_count {
                    string_name[i] = Some(idx);
                }
            }
            9 | 10 | 11 => {
                // ref: class_index + name_and_type_index
                let ci = read_u2(&mut off)? as usize;
                let nt = read_u2(&mut off)? as usize;
                if ci < cp_count && nt < cp_count {
                    name_and_type[i] = Some((tag, ci, 0, nt)); // class_idx resolved in pass 2
                }
            }
            12 => {
                let ni = read_u2(&mut off)? as usize;
                let di = read_u2(&mut off)? as usize;
                if ni < cp_count && di < cp_count {
                    name_and_type[i] = Some((12, 0, ni, di));
                }
            }
            15 => {
                off += 1;
                let _ = read_u2(&mut off)?;
            }
            3 | 4 | 16 | 17 | 18 | 19 | 20 => {
                let _ = read_u2(&mut off)?;
            }
            5 | 6 => {
                let _ = read_u2(&mut off)?;
                let _ = read_u2(&mut off)?;
                i += 1;
            }
            _ => return Err(format!("unknown constant pool tag {tag} at {off}")),
        }
        i += 1;
    }
    let resolve_class = |idx: usize| -> Option<String> {
        let ci = class_name.get(idx).and_then(|v| *v)?;
        utf8.get(ci)?.clone()
    };
    // access_flags(2) this_class(2) super_class(2)
    let _ = read_u2(&mut off)?;
    let this_idx = read_u2(&mut off)? as usize;
    let super_idx = read_u2(&mut off)? as usize;
    let super_name = if super_idx == 0 { None } else { resolve_class(super_idx) };
    let iface_count = read_u2(&mut off)? as usize;
    let mut interfaces = Vec::new();
    for _ in 0..iface_count {
        let idx = read_u2(&mut off)? as usize;
        if let Some(name) = resolve_class(idx) {
            interfaces.push(name);
        }
    }

    let mut pool = ClassPool {
        super_name,
        interfaces,
        ..Default::default()
    };

    // Second pass: resolve strings, field/method refs, type refs and the
    // full ref list (JD-GUI printReference equivalent).
    // 9=Fieldref, 10=Methodref, 11=InterfaceMethodref, 12=NameAndType.
    let mut nat_name: Vec<Option<String>> = vec![None; cp_count.max(1)];
    let mut nat_desc: Vec<Option<String>> = vec![None; cp_count.max(1)];
    for idx in 1..cp_count {
        if let Some((12, _, ni, di)) = name_and_type[idx] {
            nat_name[idx] = utf8.get(ni).and_then(|v| v.clone());
            nat_desc[idx] = utf8.get(di).and_then(|v| v.clone());
        }
    }
    for idx in 1..cp_count {
        if let Some(ui) = string_name[idx] {
            if let Some(s) = utf8.get(ui).and_then(|v| v.as_ref()) {
                pool.strings.push(s.clone());
            }
        }
        if let Some((tag, class_idx, _, nt)) = name_and_type[idx] {
            if tag == 9 || tag == 10 || tag == 11 {
                if let Some(name) = nat_name.get(nt).and_then(|v| v.clone()) {
                    if tag == 9 {
                        pool.field_refs.push(name.clone());
                    } else {
                        pool.method_refs.push(name.clone());
                    }
                    // Resolve the owner class via its CONSTANT_Class → utf8.
                    let owner = class_name.get(class_idx).and_then(|v| *v).and_then(|ui| utf8.get(ui).and_then(|v| v.clone()));
                    let desc = nat_desc.get(nt).and_then(|v| v.clone());
                    if let Some(owner) = owner {
                        pool.refs.push(ClassRef {
                            internal_type_name: owner,
                            name: Some(name),
                            kind: if tag == 9 { "field".into() } else { "method".into() },
                            descriptor: desc,
                        });
                    }
                }
            }
        }
        if let Some(ci) = class_name[idx] {
            if idx != this_idx {
                if let Some(name) = utf8.get(ci).and_then(|v| v.as_ref()) {
                    pool.type_refs.push(name.clone());
                    // A pure type reference (CONSTANT_Class) → kind "type".
                    pool.refs.push(ClassRef {
                        internal_type_name: name.clone(),
                        name: None,
                        kind: "type".into(),
                        descriptor: None,
                    });
                }
            }
        }
    }
    Ok(pool)
}

/// Superclass / interfaces of a class file, parsed from the constant pool.
/// Returns (super_class_internal_name, interface_internal_names) using JVM
/// internal names (slash-separated, e.g. "java/lang/Object").
pub fn class_super(bytes: &[u8]) -> Result<(Option<String>, Vec<String>), String> {
    let pool = parse_class_pool(bytes)?;
    Ok((pool.super_name, pool.interfaces))
}

/// Class binary name from an entry path (com/example/Foo.class → com.example.Foo).
fn class_name_from_path(path: &str) -> String {
    let without_ext = path.strip_suffix(".class").unwrap_or(path);
    without_ext.replace('/', ".").replace('\\', ".")
}

/// List nested archive entries (jar/war/ear/zip) inside a zip — e.g. Spring
/// Boot "BOOT-INF/lib/spring-core.jar" or "WEB-INF/lib/xxx.jar". Mirrors
/// JD-GUI's recursive container model.
pub fn list_nested_archives(jar_path: &Path) -> Result<Vec<String>, String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        let lower = name.to_lowercase();
        if !entry.is_dir()
            && (lower.ends_with(".jar") || lower.ends_with(".war") || lower.ends_with(".ear") || lower.ends_with(".zip"))
            && !name.starts_with("META-INF/")
        {
            out.push(name);
        }
    }
    Ok(out)
}

/// Extract one entry from a zip to a destination path (for nested archives).
pub fn extract_entry(jar_path: &Path, entry_name: &str, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    let mut entry = archive
        .by_name(entry_name)
        .map_err(|e| format!("entry {entry_name}: {e}"))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mk dir: {e}"))?;
    }
    let mut out = std::fs::File::create(dest).map_err(|e| format!("create {dest:?}: {e}"))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy {entry_name}: {e}"))?;
    Ok(())
}

/// Extract + index nested archives (BOOT-INF/lib/*.jar etc.) in PARALLEL.
/// Returns (entry_name, extracted_path, JarIndex) for every archive that
/// extracted and indexed successfully. Mirrors JD-GUI's recursive containers
/// while keeping first-open latency acceptable for large fat jars.
pub fn extract_and_index_nested(main_jar: &Path, scratch_root: &Path) -> Vec<(String, String, JarIndex)> {
    let entries = match list_nested_archives(main_jar) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let _ = std::fs::remove_dir_all(scratch_root);
    let handles: Vec<_> = entries
        .into_iter()
        .enumerate()
        .map(|(i, ename)| {
            let main_jar = main_jar.to_path_buf();
            let scratch_root = scratch_root.to_path_buf();
            std::thread::spawn(move || {
                let safe = ename.replace('/', "__").replace('\\', "__");
                let dest = scratch_root.join(format!("{i}-{safe}"));
                if extract_entry(&main_jar, &ename, &dest).is_err() {
                    return None;
                }
                match index_jar(&dest) {
                    Ok(idx) => Some((ename, dest.display().to_string(), idx)),
                    Err(_) => {
                        let _ = std::fs::remove_file(&dest);
                        None
                    }
                }
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
}

fn package_name_from_path(path: &str) -> String {
    let without_ext = path.strip_suffix(".class").unwrap_or(path);
    match without_ext.rfind('/') {
        Some(i) => without_ext[..i].replace('/', "."),
        None => String::new(),
    }
}

/// Index a JAR file: list entries, classify, compute hash.
pub fn index_jar(jar_path: &Path) -> Result<JarIndex, String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("stat jar: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;

    let mut entries: Vec<JarEntryInfo> = Vec::new();
    let mut class_count = 0usize;
    let mut resource_count = 0usize;

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            // Directory entry — skip.
            continue;
        }
        let (kind, is_inner, class_name, package) = if name.ends_with(".class") {
            let cn = class_name_from_path(&name);
            let pkg = package_name_from_path(&name);
            let inner = cn.rsplit('$').count() > 1;
            class_count += 1;
            ("class", inner, cn, pkg)
        } else if name.starts_with("META-INF/") {
            resource_count += 1;
            ("meta-inf", false, name.clone(), String::new())
        } else {
            resource_count += 1;
            ("resource", false, name.clone(), String::new())
        };
        entries.push(JarEntryInfo {
            entry_path: name,
            class_name,
            package_name: package,
            kind: kind.to_string(),
            is_inner_class: is_inner,
            size: entry.size(),
            compressed_size: entry.compressed_size(),
        });
    }

    // Deterministic order: packages alphabetical, then entries.
    entries.sort_by(|a, b| a.entry_path.cmp(&b.entry_path));

    let jar_hash = hash_jar(jar_path)?;
    Ok(JarIndex {
        entries,
        class_count,
        resource_count,
        jar_hash,
        size: meta.len(),
    })
}

/// Build a package → entries tree (ordered).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageNode {
    pub name: String,
    pub classes: Vec<JarEntryInfo>,
    pub packages: BTreeMap<String, PackageNode>,
}

pub fn build_tree(entries: &[JarEntryInfo]) -> BTreeMap<String, PackageNode> {
    let mut root: BTreeMap<String, PackageNode> = BTreeMap::new();

    // Group classes by package, resources under a virtual "resources" root.
    let mut class_by_pkg: BTreeMap<String, Vec<&JarEntryInfo>> = BTreeMap::new();
    let mut resources: Vec<&JarEntryInfo> = Vec::new();

    for e in entries {
        if e.kind == "class" {
            class_by_pkg
                .entry(e.package_name.clone())
                .or_default()
                .push(e);
        } else {
            resources.push(e);
        }
    }

    // Insert resources under a synthetic "resources" package.
    if !resources.is_empty() {
        let node = root.entry("resources".to_string()).or_insert_with(|| PackageNode {
            name: "resources".to_string(),
            classes: Vec::new(),
            packages: BTreeMap::new(),
        });
        node.classes = resources.into_iter().cloned().collect();
    }

    for (pkg, mut classes) in class_by_pkg {
        classes.sort_by(|a, b| a.class_name.cmp(&b.class_name));
        let parts: Vec<&str> = pkg.split('.').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            // Default package classes attach at a "(default)" node.
            let key = "(default)".to_string();
            let node = root.entry(key.clone()).or_insert_with(|| PackageNode {
                name: key,
                classes: Vec::new(),
                packages: BTreeMap::new(),
            });
            node.classes = classes.into_iter().cloned().collect();
            continue;
        }
        // Walk/create nested nodes. Each node's `name` is the FULL package
        // path (e.g. "com.example"); the map key is the segment ("example").
        let mut cur_node: &mut PackageNode;
        let first_key = parts[0].to_string();
        cur_node = root.entry(first_key.clone()).or_insert_with(|| PackageNode {
            name: first_key.clone(),
            classes: Vec::new(),
            packages: BTreeMap::new(),
        });
        let mut acc = first_key;
        for part in &parts[1..] {
            acc.push('.');
            acc.push_str(part);
            let seg = part.to_string();
            let full = acc.clone();
            cur_node = cur_node
                .packages
                .entry(seg)
                .or_insert_with(|| PackageNode {
                    name: full,
                    classes: Vec::new(),
                    packages: BTreeMap::new(),
                });
        }
        cur_node.classes = classes.into_iter().cloned().collect();
    }

    root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jar(path: &std::path::Path, files: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            zip.start_file(*name, opts).unwrap();
            use std::io::Write;
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn index_basic_jar() {
        let dir = std::env::temp_dir().join(format!("jar-index-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jar");
        make_jar(
            &path,
            &[
                ("com/example/Foo.class", b"\xca\xfe\xba\xbe"),
                ("com/example/Foo$Inner.class", b"\xca\xfe\xba\xbe"),
                ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
                ("config.properties", b"a=b\n"),
            ],
        );
        let idx = index_jar(&path).unwrap();
        assert_eq!(idx.class_count, 2);
        assert_eq!(idx.resource_count, 2);
        let foo = idx.entries.iter().find(|e| e.entry_path == "com/example/Foo.class").unwrap();
        assert_eq!(foo.class_name, "com.example.Foo");
        assert_eq!(foo.package_name, "com.example");
        assert!(!foo.is_inner_class);
        let inner = idx.entries.iter().find(|e| e.entry_path == "com/example/Foo$Inner.class").unwrap();
        assert!(inner.is_inner_class);

        // Tree: package com.example with 2 classes.
        let tree = build_tree(&idx.entries);
        assert!(tree.contains_key("com"));
        let com = &tree["com"];
        assert!(com.packages.contains_key("example"));
        assert_eq!(com.packages["example"].name, "com.example");
        assert_eq!(com.packages["example"].classes.len(), 2);
        assert!(tree.contains_key("resources"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_entry_lazy() {
        let dir = std::env::temp_dir().join(format!("jar-read-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jar");
        make_jar(&path, &[("a/b/C.class", b"CLASSBYTES"), ("m.txt", b"hello")]);
        let bytes = read_entry_bytes(&path, "m.txt").unwrap();
        assert_eq!(bytes, b"hello");
        let cb = read_entry_bytes(&path, "a/b/C.class").unwrap();
        assert_eq!(cb, b"CLASSBYTES");
        assert!(read_entry_bytes(&path, "missing").is_err());
        std::fs::remove_file(&path).ok();
    }
}

// ── Source symbol extraction (for click-to-navigate) ──────────────────────

/// One method declaration found in decompiled source.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodSymbol {
    pub name: String,
    pub line: usize,
    pub signature: String,
}

/// Heuristically extract method declarations from Java source.
///
/// Matches lines like:
///   `public String greet(String name) {`
///   `private static final int MAX = 10;`   (field — skipped)
///   `public Foo() {`                        (constructor)
/// Handles multi-line signatures by scanning forward from a line ending in
/// `(` and collecting until `)` followed by `{` or `;`.
pub fn extract_methods(source: &str) -> Vec<MethodSymbol> {
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        // Skip comments/blank/annotations.
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with("/*")
            || trimmed.starts_with("*")
            || trimmed.starts_with("@")
            || trimmed.starts_with("*/")
        {
            i += 1;
            continue;
        }
        // A method declaration line contains '(' and typically a modifier or
        // return type before a name, ending with '{' (possibly after parens).
        if trimmed.contains('(') && !trimmed.starts_with("if ") && !trimmed.starts_with("for ")
            && !trimmed.starts_with("while ") && !trimmed.starts_with("switch ")
            && !trimmed.starts_with("catch") && !trimmed.starts_with("return ") {
            // Collect a multi-line signature.
            let mut sig = trimmed.to_string();
            let mut j = i;
            let mut paren_balance = count_parens(&sig);
            while paren_balance > 0 && j + 1 < lines.len() {
                j += 1;
                let next = lines[j].trim().to_string();
                paren_balance += count_parens(&next);
                sig.push(' ');
                sig.push_str(&next);
            }
            // Must end with '{' (method body) — declarations only.
            let ends_with_body = sig.trim_end().ends_with('{');
            // Name: word before first '('.
            if let Some(name) = method_name_from_sig(&sig) {
                if ends_with_body && !is_field_decl(&sig) {
                    out.push(MethodSymbol { name, line: i + 1, signature: sig.clone() });
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn count_parens(s: &str) -> i32 {
    s.chars().filter(|c| *c == '(').count() as i32 - s.chars().filter(|c| *c == ')').count() as i32
}

/// Extract the method/constructor name: token before the first '('.
fn method_name_from_sig(sig: &str) -> Option<String> {
    let before_paren = sig.split('(').next()?;
    let tokens: Vec<&str> = before_paren.split_whitespace().collect();
    // Last token is the name (possibly with generics on the type before).
    let name = tokens.last()?.trim();
    let name = name.trim_end_matches(')').trim_end_matches('{').trim();
    if name.is_empty() || name.contains('.') || name == "new" {
        return None;
    }
    // Reject if it looks like a type (starts uppercase) unless followed by (
    // e.g. `Foo()` constructor — keep those.
    if name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
        // Constructor: name matches class — keep.
    }
    Some(name.to_string())
}

/// A field declaration has `=` or ends with `;` before any `{`.
fn is_field_decl(sig: &str) -> bool {
    let body_start = sig.find('{').unwrap_or(sig.len());
    let before_body = &sig[..body_start];
    before_body.trim_end().ends_with(';') || before_body.contains('=')
}

#[cfg(test)]
mod symbol_tests {
    use super::*;

    #[test]
    fn extract_methods_basic() {
        let src = r#"package demo;
public class Foo {
    private String name = "x";
    public String greet(String who) {
        return name + who;
    }
    public static int add(int a,
                          int b) {
        return a + b;
    }
    public Foo() {
    }
}
"#;
        let methods = extract_methods(src);
        let names: Vec<&str> = methods.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"greet"), "got {names:?}");
        assert!(names.contains(&"add"), "got {names:?}");
        assert!(names.contains(&"Foo"), "constructor: got {names:?}");
        // Field `name` should NOT be extracted.
        assert!(!names.contains(&"name"), "field leaked: {names:?}");
        // add is on lines 7-9 → line should be 7.
        let add = methods.iter().find(|m| m.name == "add").unwrap();
        assert_eq!(add.line, 7);
    }

    #[test]
    fn ignores_control_flow() {
        let src = "public void f() {\n  if (x > 0) {\n    return;\n  }\n  for (int i = 0; i < 3; i++) {\n  }\n}\n";
        let methods = extract_methods(src);
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].name, "f");
    }
}

#[cfg(test)]
mod class_info_tests {
    use super::*;

    fn fake_class(major: u16, minor: u16) -> Vec<u8> {
        let mut b = vec![0xca, 0xfe, 0xba, 0xbe];
        b.extend_from_slice(&minor.to_be_bytes());
        b.extend_from_slice(&major.to_be_bytes());
        b.extend_from_slice(&[0; 64]); // constant pool + rest (not parsed)
        b
    }

    #[test]
    fn parses_java_8_class() {
        let (minor, major, label) = class_file_info(&fake_class(52, 0)).unwrap();
        assert_eq!(major, 52);
        assert_eq!(minor, 0);
        assert_eq!(label, "Java 8");
    }

    #[test]
    fn parses_java_17_class() {
        let (_, major, label) = class_file_info(&fake_class(61, 3)).unwrap();
        assert_eq!(major, 61);
        assert_eq!(label, "Java 17");
    }

    #[test]
    fn rejects_non_class_bytes() {
        assert!(class_file_info(&[0x00, 0x01, 0x02, 0x03]).is_err());
        assert!(class_file_info(b"").is_err());
    }

    #[test]
    fn unknown_major_has_fallback_label() {
        let (_, major, label) = class_file_info(&fake_class(99, 0)).unwrap();
        assert_eq!(major, 99);
        assert!(label.contains("99"), "label: {label}");
    }
}

#[cfg(test)]
mod class_super_tests {
    use super::*;

    /// Minimal valid class: just enough constant pool with this/super names.
    fn fake_class(super_name: Option<&str>, interfaces: &[&str]) -> Vec<u8> {
        let mut b = vec![0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34];
        // Constant pool: build entries for each distinct string.
        // We hand-craft: cp[1]=this "com/demo/Foo", cp[2]=super, cp[3..]=ifaces.
        let mut names: Vec<String> = vec!["com/demo/Foo".into()];
        if let Some(s) = super_name { names.push(s.into()); }
        for i in interfaces { names.push((*i).into()); }
        // 1 (index 0) + names.len() utf8 entries + names.len() class entries
        let cp_count = 1 + names.len() * 2;
        b.extend_from_slice(&(cp_count as u16).to_be_bytes());
        // utf8 entries at index 1..=names.len()
        let mut utf8_idx: Vec<usize> = Vec::new();
        for name in &names {
            utf8_idx.push(1 + utf8_idx.len());
            b.push(1); // CONSTANT_Utf8
            b.extend_from_slice(&(name.len() as u16).to_be_bytes());
            b.extend_from_slice(name.as_bytes());
        }
        // Class entries: this → utf8[1], super → utf8[2], ifaces → utf8[3..]
        let class_this = names.len() + 1; // next free index
        let mut class_idx: Vec<usize> = Vec::new();
        let push_class = |b: &mut Vec<u8>, utf8_i: usize| {
            b.push(7); // CONSTANT_Class
            b.extend_from_slice(&(utf8_i as u16).to_be_bytes());
        };
        push_class(&mut b, 1);
        class_idx.push(class_this);
        for i in 2..=names.len() {
            push_class(&mut b, i);
            class_idx.push(class_this + (i - 1));
        }
        // access_flags, this_class, super_class
        b.extend_from_slice(&0x0021u16.to_be_bytes()); // ACC_PUBLIC|ACC_SUPER
        b.extend_from_slice(&(class_idx[0] as u16).to_be_bytes());
        let super_cp = if super_name.is_some() { class_idx[1] } else { 0 };
        b.extend_from_slice(&(super_cp as u16).to_be_bytes());
        // interfaces
        b.extend_from_slice(&(interfaces.len() as u16).to_be_bytes());
        for i in 1..=interfaces.len() {
            b.extend_from_slice(&(class_idx[1 + i] as u16).to_be_bytes());
        }
        b
    }

    #[test]
    fn parses_super_and_interfaces() {
        let bytes = fake_class(Some("java/lang/Object"), &["java/io/Serializable"]);
        let (sup, ifaces) = class_super(&bytes).unwrap();
        assert_eq!(sup.as_deref(), Some("java/lang/Object"));
        assert_eq!(ifaces, vec!["java/io/Serializable".to_string()]);
    }

    #[test]
    fn no_super_is_none() {
        let bytes = fake_class(None, &[]);
        let (sup, ifaces) = class_super(&bytes).unwrap();
        assert_eq!(sup, None);
        assert!(ifaces.is_empty());
    }

    #[test]
    fn rejects_non_class() {
        assert!(class_super(b"nope").is_err());
    }
}
