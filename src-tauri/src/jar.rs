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

/// Convert `\uXXXX` escapes back to the real character.
///
/// History: CFR emits non-ASCII characters as `\uXXXX` escapes regardless of
/// output encoding, and this unescaped them. The engine is now jd-core (JD-GUI
/// 1.1.3), which emits real characters by default ("escape unicode
/// characters" preference off), so this is NO LONGER applied to decompiler
/// output — applying it would corrupt a literal `\uXXXX` string constant.
/// Retained as a utility (used by tests) for any future escaped output.
/// A literal `\\u` (double backslash) is kept as-is, and only 4-hex-digit
/// escapes are converted — mirroring Java string-literal semantics.
pub fn unescape_unicode_literals(src: &str) -> String {
    let bytes: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '\\' {
            // "\\" (escaped backslash) — keep both; the next \u is literal
            // text, not an escape we should convert.
            if i + 1 < bytes.len() && bytes[i + 1] == '\\' {
                out.push('\\');
                out.push('\\');
                i += 2;
                continue;
            }
            // "\uXXXX" with exactly 4 hex digits → the real character.
            if i + 5 < bytes.len() && bytes[i + 1] == 'u' {
                let hex = &bytes[i + 2..i + 6];
                if hex.iter().all(|h| h.is_ascii_hexdigit()) {
                    let cp = u32::from_str_radix(&hex.iter().collect::<String>(), 16).unwrap_or(0);
                    if let Some(ch) = char::from_u32(cp) {
                        out.push(ch);
                        i += 6;
                        continue;
                    }
                }
            }
            // Lone backslash or non-hex "\u" — keep it.
            out.push(c);
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Read the raw bytes of a single entry from the JAR (lazy).
pub fn read_entry_bytes(jar_path: &Path, entry_path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("open jar {}: {e}", jar_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut entry = archive.by_name(entry_path).map_err(|e| {
        format!(
            "entry {entry_path} not found in {}: {e}",
            jar_path.display()
        )
    })?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("read entry: {e}"))?;
    Ok(buf)
}

/// Compute the SHA-256 of the whole jar file (streamed).
pub fn hash_jar(jar_path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(jar_path).map_err(|e| format!("open jar: {e}"))?;
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
/// JD-GUI ClassFileTreeNodeFactoryProvider.makeTip + ClassFilePage.save:
///   major >= 49 → (major - 44)          (49→5, 52→8, 55→11, …)
///   major 45..48 → "1." + (major - 44)  (45→1.1, 46→1.2, 47→1.3, 48→1.4)
pub fn class_file_info(bytes: &[u8]) -> Result<(u16, u16, String), String> {
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return Err("Not a valid class file".into());
    }
    let minor = u16::from_be_bytes([bytes[4], bytes[5]]);
    let major = u16::from_be_bytes([bytes[6], bytes[7]]);
    let java_version = if major >= 49 {
        let release = major as i32 - 44; // 49→5, 52→8, 55→11, 61→17
        format!("Java {}", release)
    } else if (45..=48).contains(&major) {
        // JD-GUI legacy "1.x" display: 45→1.1, 46→1.2, 47→1.3, 48→1.4.
        format!("1.{}", major as i32 - 44)
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
    /// "type" | "field" | "method" | "constructor".
    pub kind: String,
    /// JVM descriptor of the member (e.g. "(Ljava/lang/String;)V"), or None.
    pub descriptor: Option<String>,
    /// Owner internal name passed by jd-core (the class containing the
    /// reference), or None for parse_class_pool refs.
    pub owner: Option<String>,
    /// Exact start offset in the DECOMPILED SOURCE text (JD-GUI hyperlinks:
    /// stringBuffer.length() at printReference time). 0 when unknown
    /// (parse_class_pool refs have no position).
    pub offset: usize,
    /// Length of the referenced token in the source text (name.length()).
    pub len: usize,
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
            9..=11 => {
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
    let super_name = if super_idx == 0 {
        None
    } else {
        resolve_class(super_idx)
    };
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
                    let owner = class_name
                        .get(class_idx)
                        .and_then(|v| *v)
                        .and_then(|ui| utf8.get(ui).and_then(|v| v.clone()));
                    let desc = nat_desc.get(nt).and_then(|v| v.clone());
                    if let Some(owner) = owner {
                        pool.refs.push(ClassRef {
                            internal_type_name: owner,
                            name: Some(name),
                            kind: if tag == 9 {
                                "field".into()
                            } else {
                                "method".into()
                            },
                            descriptor: desc,
                            owner: None,
                            offset: 0,
                            len: 0,
                        });
                    }
                }
            }
        }
        if let Some(ci) = class_name[idx] {
            // JD-GUI ClassFileIndexerProvider typeReferenceSet: EVERY
            // CONSTANT_Class (including this_class) is a type reference;
            // array classes are unpacked to their element type
            // ("[Lcom/foo/Bar;" → "com/foo/Bar", "[I" → skipped).
            if let Some(name) = utf8.get(ci).and_then(|v| v.as_ref()) {
                if let Some(stripped) = unpack_array_type(name) {
                    pool.type_refs.push(stripped);
                }
                // The clickable-reference list mirrors JD-GUI printReference:
                // a reference to the page's own type is not a link (the
                // declaration IS the page), so we keep it out of `refs`.
                if idx != this_idx && !name.starts_with('[') {
                    pool.refs.push(ClassRef {
                        internal_type_name: name.clone(),
                        name: None,
                        kind: "type".into(),
                        descriptor: None,
                        owner: None,
                        offset: 0,
                        len: 0,
                    });
                }
            }
        }
    }
    Ok(pool)
}

/// JD-GUI array-class unpacking: "[Lcom/foo/Bar;" → Some("com/foo/Bar"),
/// "[[Ljava/lang/String;" → Some("java/lang/String"), "[I" → None.
/// Mirrors SignatureReader.acceptType → visitClassType in the indexer.
/// JD-GUI array-class unpacking: "[Lcom/foo/Bar;" → Some("com/foo/Bar"),
/// "[[Ljava/lang/String;" → Some("java/lang/String"), "[I" → None.
/// Mirrors SignatureReader.acceptType → visitClassType in the indexer; the
/// `[` prefix is stripped recursively for multi-dimensional arrays.
fn unpack_array_type(name: &str) -> Option<String> {
    let mut rest = name;
    while let Some(r) = rest.strip_prefix('[') {
        rest = r;
    }
    if rest != name {
        // It was an array descriptor → the element class type.
        if let Some(elem) = rest.strip_prefix('L') {
            if let Some(semi) = elem.find(';') {
                return Some(elem[..semi].to_string());
            }
        }
        return None; // primitive array ([I) has no class type
    }
    // Not an array — the type name itself.
    Some(name.to_string())
}

/// Superclass / interfaces of a class file, parsed from the constant pool.
/// Returns (super_class_internal_name, interface_internal_names) using JVM
/// internal names (slash-separated, e.g. "java/lang/Object").
pub fn class_super(bytes: &[u8]) -> Result<(Option<String>, Vec<String>), String> {
    let pool = parse_class_pool(bytes)?;
    Ok((pool.super_name, pool.interfaces))
}

/// Parse the InnerClasses attribute of a class file and return the INTERNAL
/// names of every nested class declared there (e.g. "com/example/Foo$Bar").
/// Mirrors JD-GUI's `JarContainerEntryUtil.populateInnerTypePaths`, which
/// reads the InnerClasses attribute via ASM instead of relying on the `$` in
/// the file name — a class whose name merely contains `$` but is not declared
/// as an inner class (e.g. obfuscated output) must stay visible in the tree.
pub fn inner_classes_of(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return out;
    }
    let mut off = 8usize;
    let read_u2 = |off: &mut usize| -> Option<u16> {
        if *off + 2 > bytes.len() {
            return None;
        }
        let v = u16::from_be_bytes([bytes[*off], bytes[*off + 1]]);
        *off += 2;
        Some(v)
    };
    let read_u4 = |off: &mut usize| -> Option<u32> {
        if *off + 4 > bytes.len() {
            return None;
        }
        let v = u32::from_be_bytes([
            bytes[*off],
            bytes[*off + 1],
            bytes[*off + 2],
            bytes[*off + 3],
        ]);
        *off += 4;
        Some(v)
    };
    let skip = |off: &mut usize, n: usize| -> Option<()> {
        if *off + n > bytes.len() {
            return None;
        }
        *off += n;
        Some(())
    };

    // Wrap the whole parse in a closure returning Option<Vec<String>> so we
    // can use `?` on malformed input and fall back to an empty result.
    let mut parse = || -> Option<Vec<String>> {
        let mut names: Vec<String> = Vec::new();
        let cp_count = read_u2(&mut off)? as usize;
        let mut utf8: Vec<Option<String>> = vec![None; cp_count.max(1)];
        let mut class_name: Vec<Option<usize>> = vec![None; cp_count.max(1)]; // Class → utf8
        let mut i = 1usize;
        while i < cp_count {
            if off >= bytes.len() {
                return None;
            }
            let tag = bytes[off];
            off += 1;
            match tag {
                1 => {
                    let len = read_u2(&mut off)? as usize;
                    skip(&mut off, len)?;
                    utf8[i] = Some(String::from_utf8_lossy(&bytes[off - len..off]).into_owned());
                }
                7 => {
                    let idx = read_u2(&mut off)? as usize;
                    if idx < cp_count {
                        class_name[i] = Some(idx);
                    }
                }
                3 | 4 | 9 | 10 | 11 | 12 | 17 | 18 => {
                    skip(&mut off, 4)?;
                }
                8 | 16 | 19 | 20 => {
                    skip(&mut off, 2)?;
                }
                15 => {
                    skip(&mut off, 3)?;
                }
                5 | 6 => {
                    i += 1;
                    skip(&mut off, 8)?;
                }
                _ => return None,
            }
            i += 1;
        }
        // access_flags this_class super_class interfaces
        skip(&mut off, 6)?;
        let iface_count = read_u2(&mut off)? as usize;
        skip(&mut off, iface_count * 2)?;
        // fields
        let field_count = read_u2(&mut off)? as usize;
        for _ in 0..field_count {
            skip(&mut off, 6)?;
            let attr_count = read_u2(&mut off)? as usize;
            for _ in 0..attr_count {
                skip(&mut off, 2)?;
                let len = read_u4(&mut off)? as usize;
                skip(&mut off, len)?;
            }
        }
        // methods
        let method_count = read_u2(&mut off)? as usize;
        for _ in 0..method_count {
            skip(&mut off, 6)?;
            let attr_count = read_u2(&mut off)? as usize;
            for _ in 0..attr_count {
                skip(&mut off, 2)?;
                let len = read_u4(&mut off)? as usize;
                skip(&mut off, len)?;
            }
        }
        // class attributes → find InnerClasses
        let attr_count = read_u2(&mut off)? as usize;
        for _ in 0..attr_count {
            let name_idx = read_u2(&mut off)? as usize;
            let len = read_u4(&mut off)? as usize;
            let is_inner = utf8
                .get(name_idx)
                .map(|v| v.as_deref() == Some("InnerClasses"))
                .unwrap_or(false);
            if off + len > bytes.len() {
                return None;
            }
            if is_inner {
                let mut p = off;
                let number_of_classes = read_u2(&mut p)? as usize;
                for _ in 0..number_of_classes {
                    let inner_info = read_u2(&mut p)? as usize;
                    skip(&mut p, 6)?; // outer_class_info_index, inner_name_index, access_flags
                    if inner_info < cp_count {
                        if let Some(ui) = class_name.get(inner_info).and_then(|v| *v) {
                            if let Some(name) = utf8.get(ui).and_then(|v| v.clone()) {
                                names.push(name);
                            }
                        }
                    }
                }
            }
            off += len;
        }
        Some(names)
    };

    out = parse().unwrap_or_default();
    out
}

/// Declared members of a class, read from the bytecode (fields + methods).
/// Mirrors JD-GUI's ClassFileIndexerProvider.ClassIndexer: field names land in
/// fieldDeclarations, method names in methodDeclarations (`<init>` constructors
/// in constructorDeclarations, `<clinit>` skipped). Used by the JD-GUI
/// "searchTypeHavingMember" resolution — a reference is a link only when the
/// member exists on the type or one of its supertypes.
#[derive(Debug, Default, Clone)]
pub struct ClassMembers {
    pub fields: Vec<String>,
    pub methods: Vec<String>,
    pub constructors: Vec<String>,
    /// Fully-qualified exception types declared by methods (from the Exceptions
    /// attribute) — JD-GUI ClassFileIndexerProvider.ClassIndexer.visitMethod
    /// adds each exception to typeReferenceSet.
    pub exceptions: Vec<String>,
    /// Reference types extracted from generic signatures of fields/methods
    /// (JD-GUI SignatureIndexer.visitClassType).
    pub signature_types: Vec<String>,
}

pub fn class_members(bytes: &[u8]) -> ClassMembers {
    let mut out = ClassMembers::default();
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return out;
    }
    let mut off = 8usize;
    let read_u2 = |off: &mut usize| -> Option<u16> {
        if *off + 2 > bytes.len() {
            return None;
        }
        let v = u16::from_be_bytes([bytes[*off], bytes[*off + 1]]);
        *off += 2;
        Some(v)
    };
    let read_u4 = |off: &mut usize| -> Option<u32> {
        if *off + 4 > bytes.len() {
            return None;
        }
        let v = u32::from_be_bytes([
            bytes[*off],
            bytes[*off + 1],
            bytes[*off + 2],
            bytes[*off + 3],
        ]);
        *off += 4;
        Some(v)
    };
    let skip = |off: &mut usize, n: usize| -> Option<()> {
        if *off + n > bytes.len() {
            return None;
        }
        *off += n;
        Some(())
    };

    let mut parse = || -> Option<ClassMembers> {
        let mut members = ClassMembers::default();
        let cp_count = read_u2(&mut off)? as usize;
        let mut utf8: Vec<Option<String>> = vec![None; cp_count.max(1)];
        let mut class_name: Vec<Option<usize>> = vec![None; cp_count.max(1)]; // Class → utf8
        let mut i = 1usize;
        while i < cp_count {
            if off >= bytes.len() {
                return None;
            }
            let tag = bytes[off];
            off += 1;
            match tag {
                1 => {
                    let len = read_u2(&mut off)? as usize;
                    skip(&mut off, len)?;
                    utf8[i] = Some(String::from_utf8_lossy(&bytes[off - len..off]).into_owned());
                }
                7 => {
                    let idx = read_u2(&mut off)? as usize;
                    if idx < cp_count {
                        class_name[i] = Some(idx);
                    }
                }
                9 | 10 | 11 | 12 | 3 | 4 | 16 | 17 | 18 | 19 | 20 => {
                    skip(&mut off, 4)?;
                }
                15 => {
                    skip(&mut off, 3)?;
                }
                5 | 6 => {
                    i += 1;
                    skip(&mut off, 8)?;
                }
                _ => return None,
            }
            i += 1;
        }
        // access_flags this_class super_class interfaces
        skip(&mut off, 6)?;
        let iface_count = read_u2(&mut off)? as usize;
        skip(&mut off, iface_count * 2)?;
        // fields: access_flags(2) name_index(2) descriptor_index(2) attributes
        let field_count = read_u2(&mut off)? as usize;
        for _ in 0..field_count {
            skip(&mut off, 2)?; // access_flags
            let name_idx = read_u2(&mut off)? as usize;
            let desc_idx = read_u2(&mut off)? as usize;
            if let Some(name) = utf8.get(name_idx).and_then(|v| v.clone()) {
                members.fields.push(name);
            }
            // JD-GUI: field descriptor types are type references even without
            // a Signature attribute ("Ljava/lang/String;" → java/lang/String).
            if let Some(desc) = utf8.get(desc_idx).and_then(|v| v.clone()) {
                extract_signature_types(&desc, &mut members.signature_types);
            }
            let attr_count = read_u2(&mut off)? as usize;
            for _ in 0..attr_count {
                let attr_name_idx = read_u2(&mut off)? as usize;
                let len = read_u4(&mut off)? as usize;
                let attr_name = utf8
                    .get(attr_name_idx)
                    .and_then(|v| v.clone())
                    .unwrap_or_default();
                if attr_name == "Signature" && off + 2 <= bytes.len() {
                    let sig_idx = read_u2(&mut off)? as usize;
                    if let Some(sig) = utf8.get(sig_idx).and_then(|v| v.clone()) {
                        extract_signature_types(&sig, &mut members.signature_types);
                    }
                    skip(&mut off, len.saturating_sub(2))?;
                } else if attr_name == "RuntimeVisibleAnnotations"
                    || attr_name == "RuntimeInvisibleAnnotations"
                {
                    {
                        let astart = off;
                        let aend = astart + len;
                        let num = read_u2(&mut off)? as usize;
                        let mut remaining = len.saturating_sub(2);
                        for _ in 0..num {
                            if remaining < 2 || off + 2 > aend {
                                break;
                            }
                            let type_idx = read_u2(&mut off)? as usize;
                            remaining = remaining.saturating_sub(2);
                            if let Some(desc) = utf8.get(type_idx).and_then(|v| v.clone()) {
                                extract_signature_types(&desc, &mut members.signature_types);
                            }
                            if remaining < 2 {
                                break;
                            }
                            let _num_pairs = read_u2(&mut off)? as usize;
                            remaining = remaining.saturating_sub(2);
                        }
                        let consumed = off.saturating_sub(astart);
                        if consumed < len {
                            skip(&mut off, len - consumed)?;
                        }
                    }
                } else {
                    skip(&mut off, len)?;
                }
            }
        }
        // methods: access_flags(2) name_index(2) descriptor_index(2) attributes
        let method_count = read_u2(&mut off)? as usize;
        for _ in 0..method_count {
            skip(&mut off, 2)?; // access_flags
            let name_idx = read_u2(&mut off)? as usize;
            let desc_idx = read_u2(&mut off)? as usize;
            if let Some(name) = utf8.get(name_idx).and_then(|v| v.clone()) {
                if name == "<init>" {
                    members.constructors.push(name);
                } else if name != "<clinit>" {
                    members.methods.push(name);
                }
            }
            // JD-GUI: method descriptor parameter/return types are type
            // references ("(Ljava/lang/String;)V" → java/lang/String).
            if let Some(desc) = utf8.get(desc_idx).and_then(|v| v.clone()) {
                extract_signature_types(&desc, &mut members.signature_types);
            }
            let attr_count = read_u2(&mut off)? as usize;
            for _ in 0..attr_count {
                let attr_name_idx = read_u2(&mut off)? as usize;
                let len = read_u4(&mut off)? as usize;
                let attr_name = utf8
                    .get(attr_name_idx)
                    .and_then(|v| v.clone())
                    .unwrap_or_default();
                if attr_name == "Exceptions" {
                    // Exceptions_attribute { u2 number_of_exceptions; u2 exception_index_table[number]; }
                    if off + 2 <= bytes.len() {
                        let num = read_u2(&mut off)? as usize;
                        let mut remaining = len.saturating_sub(2);
                        for _ in 0..num {
                            if remaining < 2 || off + 2 > bytes.len() {
                                break;
                            }
                            let class_idx = read_u2(&mut off)? as usize;
                            remaining = remaining.saturating_sub(2);
                            if let Some(ci) = class_name.get(class_idx).and_then(|v| *v) {
                                if let Some(ename) = utf8.get(ci).and_then(|v| v.clone()) {
                                    members.exceptions.push(ename);
                                }
                            }
                        }
                        skip(&mut off, remaining)?;
                    } else {
                        skip(&mut off, len)?;
                    }
                } else if attr_name == "Signature" && off + 2 <= bytes.len() {
                    let sig_idx = read_u2(&mut off)? as usize;
                    if let Some(sig) = utf8.get(sig_idx).and_then(|v| v.clone()) {
                        extract_signature_types(&sig, &mut members.signature_types);
                    }
                    skip(&mut off, len.saturating_sub(2))?;
                } else if attr_name == "RuntimeVisibleAnnotations"
                    || attr_name == "RuntimeInvisibleAnnotations"
                {
                    // JD-GUI AnnotationIndexer: annotation descriptors are
                    // type references. Structure: u2 num_annotations; then
                    // per annotation: u2 type_index; u2 num_pairs; pairs…
                    {
                        let astart = off;
                        let aend = astart + len;
                        let num = read_u2(&mut off)? as usize;
                        let mut remaining = len.saturating_sub(2);
                        for _ in 0..num {
                            if remaining < 2 || off + 2 > aend {
                                break;
                            }
                            let type_idx = read_u2(&mut off)? as usize;
                            remaining = remaining.saturating_sub(2);
                            if let Some(desc) = utf8.get(type_idx).and_then(|v| v.clone()) {
                                extract_signature_types(&desc, &mut members.signature_types);
                            }
                            if remaining < 2 {
                                break;
                            }
                            let _num_pairs = read_u2(&mut off)? as usize;
                            remaining = remaining.saturating_sub(2);
                        }
                        let consumed = off.saturating_sub(astart);
                        if consumed < len {
                            skip(&mut off, len - consumed)?;
                        }
                    }
                } else {
                    skip(&mut off, len)?;
                }
            }
        }
        // Class-level attributes (after fields & methods): annotations.
        let class_attr_count = read_u2(&mut off)? as usize;
        for _ in 0..class_attr_count {
            let attr_name_idx = read_u2(&mut off)? as usize;
            let len = read_u4(&mut off)? as usize;
            let attr_name = utf8
                .get(attr_name_idx)
                .and_then(|v| v.clone())
                .unwrap_or_default();
            if attr_name == "RuntimeVisibleAnnotations"
                || attr_name == "RuntimeInvisibleAnnotations"
            {
                let astart = off;
                let aend = astart + len;
                let num = read_u2(&mut off)? as usize;
                let mut remaining = len.saturating_sub(2);
                for _ in 0..num {
                    if remaining < 2 || off + 2 > aend {
                        break;
                    }
                    let type_idx = read_u2(&mut off)? as usize;
                    remaining = remaining.saturating_sub(2);
                    if let Some(desc) = utf8.get(type_idx).and_then(|v| v.clone()) {
                        extract_signature_types(&desc, &mut members.signature_types);
                    }
                    if remaining < 2 {
                        break;
                    }
                    let _num_pairs = read_u2(&mut off)? as usize;
                    remaining = remaining.saturating_sub(2);
                }
                let consumed = off.saturating_sub(astart);
                if consumed < len {
                    skip(&mut off, len - consumed)?;
                }
            } else {
                skip(&mut off, len)?;
            }
        }
        Some(members)
    };

    out = parse().unwrap_or_default();
    out
}

/// Extract reference types from a Java generic signature, mirroring
/// JD-GUI's SignatureIndexer.visitClassType: every "L...;" class type
/// (including inside generics / arrays) is a type reference. We use a
/// lightweight scanner that walks the signature and collects class names.
fn extract_signature_types(sig: &str, out: &mut Vec<String>) {
    let bytes: Vec<char> = sig.chars().collect();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if c == 'L' {
            // Read until ';' or '<' (generic start) or ':' (bounds).
            let mut j = i + 1;
            let mut name = String::new();
            while j < bytes.len() {
                let ch = bytes[j];
                if ch == ';' || ch == '<' || ch == ':' {
                    break;
                }
                name.push(ch);
                j += 1;
            }
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

/// Extract the module name from a module-info.class byte stream. The module
/// name is a CONSTANT_Utf8 whose content is a dotted name; we locate the
/// first non-package, non-keyword dotted string that looks like a module name
/// (matches JD-GUI's javaModuleDeclarations index key).
pub fn module_name_from_bytes(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 10 || !bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
        return None;
    }
    // Scan the constant pool for Utf8 entries; the module name is typically
    // the longest dotted string that is not a class path / keyword.
    let mut off = 8usize;
    let read_u2 = |off: &mut usize| -> Option<u16> {
        if *off + 2 > bytes.len() {
            return None;
        }
        let v = u16::from_be_bytes([bytes[*off], bytes[*off + 1]]);
        *off += 2;
        Some(v)
    };
    let cp_count = read_u2(&mut off)? as usize;
    let mut i = 1usize;
    let mut best: Option<String> = None;
    while i < cp_count {
        if off >= bytes.len() {
            return best;
        }
        let tag = bytes[off];
        off += 1;
        match tag {
            1 => {
                let len = read_u2(&mut off)? as usize;
                if off + len > bytes.len() {
                    return best;
                }
                let s = String::from_utf8_lossy(&bytes[off..off + len]).into_owned();
                off += len;
                // A module name is a dotted identifier without '/' (class
                // paths contain '/') and not a JVM keyword.
                if s.contains('.')
                    && !s.contains('/')
                    && !matches!(
                        s.as_str(),
                        "module"
                            | "requires"
                            | "exports"
                            | "opens"
                            | "uses"
                            | "provides"
                            | "with"
                            | "to"
                            | "transitive"
                            | "static"
                            | "java"
                    )
                    && best.as_ref().map(|b| s.len() > b.len()).unwrap_or(true)
                {
                    best = Some(s);
                }
            }
            7 | 8 | 16 | 19 | 20 => {
                let _ = read_u2(&mut off)?;
            }
            9 | 10 | 11 | 12 | 3 | 4 | 17 | 18 => {
                let _ = read_u2(&mut off)?;
                let _ = read_u2(&mut off)?;
            }
            15 => {
                off += 1;
                let _ = read_u2(&mut off)?;
            }
            5 | 6 => {
                i += 1;
                let _ = read_u2(&mut off)?;
                let _ = read_u2(&mut off)?;
                let _ = read_u2(&mut off)?;
                let _ = read_u2(&mut off)?;
            }
            _ => return best,
        }
        i += 1;
    }
    best
}

/// Class binary name from an entry path (com/example/Foo.class → com.example.Foo).
///
/// JD-GUI's typeDeclarations index is keyed by the class's REAL internal name
/// (read from the class bytes via ASM), NOT by the archive entry path. In a
/// Spring Boot fat jar the entry lives under BOOT-INF/classes/… while the
/// class's internal name is com/…/Foo — deriving the name from the entry path
/// would produce "BOOT-INF.classes.com…" and break every click-to-jump (the
/// bytecode references use the real internal name). Strip the well-known
/// container class prefixes so the indexed name matches the real one.
fn class_name_from_path(path: &str) -> String {
    let without_ext = path.strip_suffix(".class").unwrap_or(path);
    let stripped = ["BOOT-INF/classes/", "WEB-INF/classes/", "BOOT-INF/"]
        .iter()
        .find_map(|p| without_ext.strip_prefix(p))
        .unwrap_or(without_ext);
    stripped.replace(['/', '\\'], ".")
}

/// Resolve a JVM internal name to the physical entry path in the same archive
/// source root as `declaring_path`. A Spring Boot class lives at
/// `BOOT-INF/classes/com/example/Foo.class`, while its InnerClasses metadata
/// refers to it only as `com/example/Foo`.
fn entry_path_for_internal_name(
    declaring_path: &str,
    declaring_internal_name: &str,
    internal_name: &str,
) -> Option<String> {
    let suffix = format!("{declaring_internal_name}.class");
    let prefix = declaring_path.strip_suffix(&suffix)?;
    Some(format!("{prefix}{internal_name}.class"))
}

/// List nested archive entries (jar/war/ear/zip) inside a zip — e.g. Spring
/// Boot "BOOT-INF/lib/spring-core.jar" or "WEB-INF/lib/xxx.jar". Mirrors
/// JD-GUI's recursive container model.
pub fn list_nested_archives(jar_path: &Path) -> Result<Vec<String>, String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        let lower = name.to_lowercase();
        if !entry.is_dir()
            && (lower.ends_with(".jar")
                || lower.ends_with(".war")
                || lower.ends_with(".ear")
                || lower.ends_with(".zip"))
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
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
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

/// Extract every .class file in the same DIRECTORY as `entry_path` into
/// `dest_root` (preserving the package path). Mirrors JD-GUI's
/// ContainerLoader: CFR is given this dir as an extra classpath so it can
/// resolve same-package and inner classes while decompiling one file.
pub fn extract_sibling_classes(
    jar_path: &Path,
    entry_path: &str,
    dest_root: &Path,
) -> Result<(), String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    let dir = match entry_path.rfind('/') {
        Some(i) => &entry_path[..i],
        None => "",
    };
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    // Collect names first (borrow ends), then read each by name.
    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if name.ends_with(".class") && name.starts_with(&prefix) {
            names.push(name);
        }
    }
    use std::io::Write;
    for name in names {
        let dest = dest_root.join(&name);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut entry = match archive.by_name(&name) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut out = match std::fs::File::create(&dest) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if std::io::copy(&mut entry, &mut out).is_err() {
            let _ = std::fs::remove_file(&dest);
        }
        let _ = out.flush();
    }
    Ok(())
}

/// Extract EVERY `.class` entry of a JAR into `dest_root`, preserving the
/// entry's package structure. Mirrors JD-GUI's ContainerLoader, which can
/// resolve any class of the container (outer classes, inner classes, same-
/// package types) while decompiling one entry. Used by Save All Sources so
/// inner classes are fully decompiled instead of becoming empty placeholders.
pub fn extract_all_classes(jar_path: &Path, dest_root: &Path) -> Result<(), String> {
    let file = std::fs::File::open(jar_path)
        .map_err(|e| format!("Cannot open JAR {}: {e}", jar_path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    use std::io::Write;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if !name.ends_with(".class") {
            continue;
        }
        let dest = dest_root.join(&name);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
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
    Ok(())
}

/// Extract + index nested archives (BOOT-INF/lib/*.jar etc.) in PARALLEL.
/// Returns (entry_name, extracted_path, JarIndex) for every archive that
/// extracted and indexed successfully. Mirrors JD-GUI's recursive containers
/// while keeping first-open latency acceptable for large fat jars.
pub fn extract_and_index_nested(
    main_jar: &Path,
    scratch_root: &Path,
) -> Vec<(String, String, JarIndex)> {
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
                let safe = ename.replace(['/', '\\'], "__");
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
    handles
        .into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .collect()
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
    let meta = file.metadata().map_err(|e| format!("stat jar: {e}"))?;
    let mut idx = index_jar_reader(&mut std::io::BufReader::new(file))?;
    idx.jar_hash = hash_jar(jar_path)?;
    idx.size = meta.len();
    Ok(idx)
}

/// Index a JAR from any reader (memory `Cursor`, nested jars inside a fat jar,
/// etc.) — JD-GUI indexes jars in memory, never persisting to a database.
/// `jar_hash`/`size` are left empty (caller computes from the file).
pub fn index_jar_reader<R: std::io::Read + std::io::Seek>(
    reader: &mut R,
) -> Result<JarIndex, String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Invalid JAR (zip) format: {e}"))?;
    let mut raw: Vec<(String, u64, u64)> = Vec::new(); // (name, size, csize)
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        raw.push((name, entry.size(), entry.compressed_size()));
    }

    // Collect outer class paths of every `$` entry: "a/b/Foo$Bar.class" → "a/b/Foo.class".
    let mut potential_outer: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (name, _, _) in &raw {
        if !name.ends_with(".class") {
            continue;
        }
        let base = &name[..name.len() - 6]; // strip ".class"
        let last_sep = base.rfind('/').map(|i| i + 1).unwrap_or(0);
        if let Some(dollar_rel) = base[last_sep..].find('$') {
            let cut = last_sep + dollar_rel;
            potential_outer.insert(format!("{}.class", &base[..cut]));
        }
    }

    // Read every potential outer class's InnerClasses attribute: those names
    // are the real inner classes (JD-GUI populateInnerTypePaths).
    let mut inner_type_paths: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    for outer in &potential_outer {
        let bytes = {
            let mut e = match archive.by_name(outer) {
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
        let outer_internal_name = class_name_from_path(outer).replace('.', "/");
        for inner in inner_classes_of(&bytes) {
            if let Some(path) = entry_path_for_internal_name(outer, &outer_internal_name, &inner) {
                inner_type_paths.insert(path);
            }
        }
    }

    // JD-GUI's JarContainerEntryUtil has a second pass for entries that were
    // not declared by their inferred outer. Anonymous and local classes can
    // still describe themselves through their own InnerClasses attribute.
    // Do not use '$' as proof by itself: only hide an entry after bytecode
    // metadata confirms it is an inner type.
    for (name, _, _) in &raw {
        if !name.ends_with(".class") || !name.contains('$') || inner_type_paths.contains(name) {
            continue;
        }
        let bytes = {
            let mut entry = match archive.by_name(name) {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let mut buffer = Vec::with_capacity(entry.size() as usize);
            use std::io::Read;
            if entry.read_to_end(&mut buffer).is_err() {
                continue;
            }
            buffer
        };
        let entry_internal_name = class_name_from_path(name).replace('.', "/");
        for inner in inner_classes_of(&bytes) {
            if let Some(path) = entry_path_for_internal_name(name, &entry_internal_name, &inner) {
                inner_type_paths.insert(path);
            }
        }
    }

    let mut entries: Vec<JarEntryInfo> = Vec::new();
    let mut class_count = 0usize;
    let mut resource_count = 0usize;

    for (name, size, csize) in raw {
        // JD-GUI: module-info.class is excluded from the class INDEX but
        // still shown in the tree as a special module node
        // (ModuleInfoFileTreeNodeFactoryProvider). We keep it with
        // kind="module" and count it as a resource-like entry.
        if name == "module-info.class" || name.ends_with("/module-info.class") {
            resource_count += 1;
            entries.push(JarEntryInfo {
                entry_path: name,
                class_name: "module-info".to_string(),
                package_name: String::new(),
                kind: "module".to_string(),
                is_inner_class: false,
                size,
                compressed_size: csize,
            });
            continue;
        }
        let (kind, is_inner, class_name, package) = if name.ends_with(".class") {
            let cn = class_name_from_path(&name);
            let pkg = package_name_from_path(&name);
            // JD-GUI: only `$` entries DECLARED in an outer's InnerClasses are
            // hidden; a bare `$` in the file name is not enough.
            let inner = name.contains('$') && inner_type_paths.contains(&name);
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
            size,
            compressed_size: csize,
        });
    }

    // Deterministic order: packages alphabetical, then entries.
    entries.sort_by(|a, b| a.entry_path.cmp(&b.entry_path));

    Ok(JarIndex {
        entries,
        class_count,
        resource_count,
        jar_hash: String::new(),
        size: 0,
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

    // JD-GUI tree: classes group by package; resources hang under their own
    // directory path (META-INF/MANIFEST.MF lives under META-INF, a root-level
    // config.properties under the root) — no synthetic "resources" package.
    let mut class_by_pkg: BTreeMap<String, Vec<&JarEntryInfo>> = BTreeMap::new();
    let mut resource_dirs: BTreeMap<String, Vec<&JarEntryInfo>> = BTreeMap::new();

    for e in entries {
        if e.kind == "class" {
            class_by_pkg
                .entry(e.package_name.clone())
                .or_default()
                .push(e);
        } else if e.kind == "module" {
            // JD-GUI module-info.class: a root-level module node.
            root.entry("(module)".to_string())
                .or_insert_with(|| PackageNode {
                    name: "(module)".to_string(),
                    classes: Vec::new(),
                    packages: BTreeMap::new(),
                })
                .classes
                .push(e.clone());
        } else {
            // Directory = everything before the last '/'.
            let dir = e
                .entry_path
                .rfind('/')
                .map(|i| &e.entry_path[..i])
                .unwrap_or("")
                .to_string();
            resource_dirs.entry(dir).or_default().push(e);
        }
    }

    // Helper: walk-or-create a chain of package nodes from dot-separated parts.
    // Each node's `name` is its OWN segment (JD-GUI PackageTreeNodeFactory:
    // a directory node shows the directory name, not the full path); package
    // aggregation (frontend aggregatePackages) joins segments when collapsing
    // a single-child chain.
    fn ensure_path<'a>(
        root: &'a mut BTreeMap<String, PackageNode>,
        parts: &[&str],
    ) -> &'a mut PackageNode {
        let mut cur: &mut PackageNode =
            root.entry(parts[0].to_string())
                .or_insert_with(|| PackageNode {
                    name: parts[0].to_string(),
                    classes: Vec::new(),
                    packages: BTreeMap::new(),
                });
        for part in &parts[1..] {
            let seg = part.to_string();
            cur = cur
                .packages
                .entry(seg.clone())
                .or_insert_with(|| PackageNode {
                    name: seg,
                    classes: Vec::new(),
                    packages: BTreeMap::new(),
                });
        }
        cur
    }

    // Insert resources under their directory chain (slash → dot for node names,
    // but keep display consistent with package nodes).
    for (dir, mut res) in resource_dirs {
        res.sort_by(|a, b| a.entry_path.cmp(&b.entry_path));
        if dir.is_empty() {
            // Root-level resources: attach to a "(resources)" node at root.
            let node = root
                .entry("(resources)".to_string())
                .or_insert_with(|| PackageNode {
                    name: "(resources)".to_string(),
                    classes: Vec::new(),
                    packages: BTreeMap::new(),
                });
            node.classes = res.into_iter().cloned().collect();
            continue;
        }
        let parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
        let node = ensure_path(&mut root, &parts);
        node.classes = res.into_iter().cloned().collect();
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
        let node = ensure_path(&mut root, &parts);
        node.classes = classes.into_iter().cloned().collect();
    }

    root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jar(path: &std::path::Path, files: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            zip.start_file(*name, opts).unwrap();
            use std::io::Write;
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn index_basic_jar() {
        // Real javac output: com/example/Foo declares inner class Foo$Inner
        // (InnerClasses attribute), com/example/Obj has no inner classes.
        let foo_class: Vec<u8> = hex::decode("cafebabe0000003d00160a000200030700040c000500060100106a6176612f6c616e672f4f626a6563740100063c696e69743e010003282956070008010015636f6d2f6578616d706c652f466f6f24496e6e65720a0007000a0c0005000b010014284c636f6d2f6578616d706c652f466f6f3b295607000d01000f636f6d2f6578616d706c652f466f6f010004436f646501000f4c696e654e756d6265725461626c6501000372756e01000a536f7572636546696c65010008466f6f2e6a61766101000b4e6573744d656d6265727301000c496e6e6572436c6173736573010005496e6e65720021000c00020000000000020001000500060001000e0000001d00010001000000052ab70001b100000001000f000000060001000000020001001000060001000e00000022000300020000000abb0007592ab700094cb100000001000f00000006000100000004000300110000000200120013000000040001000700140000000a00010007000c00150001").unwrap();
        let foo_inner: Vec<u8> = hex::decode("cafebabe0000003d001709000200030700040c00050006010015636f6d2f6578616d706c652f466f6f24496e6e65720100067468697324300100114c636f6d2f6578616d706c652f466f6f3b0a0008000907000a0c000b000c0100106a6176612f6c616e672f4f626a6563740100063c696e69743e010003282956010014284c636f6d2f6578616d706c652f466f6f3b2956010004436f646501000f4c696e654e756d6265725461626c6501000a536f7572636546696c65010008466f6f2e6a6176610100084e657374486f737407001401000f636f6d2f6578616d706c652f466f6f01000c496e6e6572436c6173736573010005496e6e657200210002000800000001101000050006000000010001000b000d0001000e00000022000200020000000a2a2bb500012ab70007b100000001000f0000000600010000000300030010000000020011001200000002001300150000000a00010002001300160001").unwrap();
        let obj_class: Vec<u8> = hex::decode("cafebabe0000003d000f0a000200030700040c000500060100106a6176612f6c616e672f4f626a6563740100063c696e69743e01000328295607000801000f636f6d2f6578616d706c652f4f626a0100017801000149010004436f646501000f4c696e654e756d6265725461626c6501000a536f7572636546696c650100084f626a2e6a6176610021000700020000000100010009000a000000010001000500060001000b0000001d00010001000000052ab70001b100000001000c000000060001000000020001000d00000002000e").unwrap();
        // JD-GUI semantics: inner-class detection reads the InnerClasses
        // attribute of the outer class. Foo$Inner IS declared → hidden.
        let inner_of_foo = inner_classes_of(&foo_class);
        assert!(inner_of_foo.contains(&"com/example/Foo$Inner".to_string()));

        let dir = std::env::temp_dir().join(format!("jar-index-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jar");
        make_jar(
            &path,
            &[
                ("com/example/Foo.class", &foo_class),
                ("com/example/Foo$Inner.class", &foo_inner),
                ("com/example/Obj.class", &obj_class),
                ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
                ("config.properties", b"a=b\n"),
            ],
        );
        let idx = index_jar(&path).unwrap();
        assert_eq!(idx.class_count, 3);
        assert_eq!(idx.resource_count, 2);
        let foo = idx
            .entries
            .iter()
            .find(|e| e.entry_path == "com/example/Foo.class")
            .unwrap();
        assert_eq!(foo.class_name, "com.example.Foo");
        assert_eq!(foo.package_name, "com.example");
        assert!(!foo.is_inner_class);
        let inner = idx
            .entries
            .iter()
            .find(|e| e.entry_path == "com/example/Foo$Inner.class")
            .unwrap();
        assert!(inner.is_inner_class);
        let obj = idx
            .entries
            .iter()
            .find(|e| e.entry_path == "com/example/Obj.class")
            .unwrap();
        assert!(!obj.is_inner_class);

        // Tree: package com.example with 3 classes. Each node shows its OWN
        // segment (JD-GUI), not the accumulated path.
        let tree = build_tree(&idx.entries);
        assert!(tree.contains_key("com"));
        let com = &tree["com"];
        assert_eq!(com.name, "com");
        assert!(com.packages.contains_key("example"));
        assert_eq!(com.packages["example"].name, "example");
        assert_eq!(com.packages["example"].classes.len(), 3);
        // JD-GUI resource placement: META-INF/MANIFEST.MF under META-INF,
        // root-level config.properties under the (resources) node.
        assert!(tree.contains_key("META-INF"));
        assert_eq!(tree["META-INF"].classes.len(), 1);
        assert!(tree.contains_key("(resources)"));
        assert_eq!(tree["(resources)"].classes.len(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn index_jar_dollar_name_without_innerclasses_stays_visible() {
        // A class whose FILE NAME contains `$` but is NOT declared as an inner
        // class (no outer class's InnerClasses attribute mentions it) must
        // remain visible — JD-GUI removeInnerTypeEntries only hides entries
        // that a real InnerClasses attribute declares. This is the obfuscated /
        // unusual-naming case the naive `$` heuristic gets wrong.
        let weird: Vec<u8> = hex::decode("cafebabe0000003d000f0a000200030700040c000500060100106a6176612f6c616e672f4f626a6563740100063c696e69743e01000328295607000801001a636f6d2f6578616d706c652f5765697264244e6f74496e6e65720100017901000149010004436f646501000f4c696e654e756d6265725461626c6501000a536f7572636546696c650100135765697264244e6f74496e6e65722e6a6176610021000700020000000100010009000a000000010001000500060001000b0000001d00010001000000052ab70001b100000001000c000000060001000000020001000d00000002000e").unwrap();
        assert!(inner_classes_of(&weird).is_empty());

        let dir = std::env::temp_dir().join(format!("jar-dollar-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jar");
        make_jar(&path, &[("com/example/Weird$NotInner.class", &weird)]);
        let idx = index_jar(&path).unwrap();
        assert_eq!(idx.class_count, 1);
        let e = &idx.entries[0];
        assert_eq!(e.entry_path, "com/example/Weird$NotInner.class");
        assert!(
            !e.is_inner_class,
            "a $ name without InnerClasses declaration must stay visible"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_entry_lazy() {
        let dir = std::env::temp_dir().join(format!("jar-read-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jar");
        make_jar(
            &path,
            &[("a/b/C.class", b"CLASSBYTES"), ("m.txt", b"hello")],
        );
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
        if trimmed.contains('(')
            && !trimmed.starts_with("if ")
            && !trimmed.starts_with("for ")
            && !trimmed.starts_with("while ")
            && !trimmed.starts_with("switch ")
            && !trimmed.starts_with("catch")
            && !trimmed.starts_with("return ")
        {
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
            // Body check: a declaration is a method when it opens a body '{'
            // somewhere (jd-core emits empty methods as `{}` on one line, CFR
            // used `{ }`, user edits may keep one-line bodies) OR when it is
            // an abstract/interface declaration ending in ';' (no body — e.g.
            // `String getUserName(long id);`). Fields and anonymous-class
            // initializers are filtered by is_field_decl below (the '='
            // before the body/end).
            let has_body = sig.contains('{');
            let is_abstract = sig.trim_end().ends_with(';');
            // Name: word before first '('.
            if let Some(name) = method_name_from_sig(&sig) {
                if (has_body || is_abstract) && !is_field_decl(&sig) {
                    out.push(MethodSymbol {
                        name,
                        line: i + 1,
                        signature: sig.clone(),
                    });
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
    if name
        .chars()
        .next()
        .map(|c| c.is_uppercase())
        .unwrap_or(false)
    {
        // Constructor: name matches class — keep.
    }
    Some(name.to_string())
}

/// A field declaration has `=` or ends with `;` before any `{`.
fn is_field_decl(sig: &str) -> bool {
    // A declaration whose pre-body part contains an assignment is a field /
    // anonymous-class initializer, never a method. (Interface/abstract method
    // declarations end in ';' but contain no '=' — they are methods.)
    let body_start = sig.find('{').unwrap_or(sig.len());
    let before_body = &sig[..body_start];
    before_body.contains('=')
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

    #[test]
    fn detects_jdcore_single_line_empty_bodies() {
        // jd-core emits empty methods as `public void beta() {}` on one line
        // (CFR used `{ }`), so the body check must accept both forms, and
        // one-line bodies with statements too.
        let src = "public class Self {\n  public void alpha() { beta(); }\n  public void beta() {}\n  public void gamma() { }\n}\n";
        let methods = extract_methods(src);
        let names: Vec<&str> = methods.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"alpha"), "one-line body missed: {names:?}");
        assert!(
            names.contains(&"beta"),
            "single-line {{}} missed: {names:?}"
        );
        assert!(
            names.contains(&"gamma"),
            "single-line {{ }} missed: {names:?}"
        );
        // An anonymous-class field initializer must NOT be a method.
        let src2 = "public class X {\n  private Runnable r = new Runnable() { public void run() {} };\n}\n";
        let methods2 = extract_methods(src2);
        assert!(
            methods2
                .iter()
                .all(|m| m.name != "run" && m.name != "Runnable"),
            "anonymous field leaked: {:?}",
            methods2
        );
    }

    #[test]
    fn extracts_descriptor_and_annotation_types() {
        // Real javac demo.Ann: @Deprecated class, @SuppressWarnings field,
        // @Deprecated method param (String). Expect java/lang/Deprecated and
        // java/lang/String in signature_types (JD-GUI scans descriptors +
        // annotation descriptors).
        let ann: Vec<u8> = hex::decode("cafebabe0000003d00150a000200030700040c000500060100106a6176612f6c616e672f4f626a6563740100063c696e69743e01000328295607000801000864656d6f2f416e6e0100017801000149010004436f646501000f4c696e654e756d6265725461626c650100016d010015284c6a6176612f6c616e672f537472696e673b295601000a4465707265636174656401001952756e74696d6556697369626c65416e6e6f746174696f6e730100164c6a6176612f6c616e672f446570726563617465643b01002252756e74696d6556697369626c65506172616d65746572416e6e6f746174696f6e7301000a536f7572636546696c65010008416e6e2e6a6176610021000700020000000100020009000a000000020001000500060001000b0000001d00010001000000052ab70001b100000001000c000000060001000000030001000d000e0004000b000000190000000200000001b100000001000c00000006000100000007000f000000000010000000060001001100000012000000070100010011000000030013000000020014000f00000000001000000006000100110000").unwrap();
        let members = class_members(&ann);
        assert!(
            members
                .signature_types
                .iter()
                .any(|t| t == "java/lang/Deprecated"),
            "annotation type missing: {:?}",
            members.signature_types
        );
        assert!(
            members
                .signature_types
                .iter()
                .any(|t| t == "java/lang/String"),
            "descriptor type missing: {:?}",
            members.signature_types
        );
    }
}

#[cfg(test)]
mod unescape_tests {
    use super::*;

    #[test]
    fn converts_unicode_escapes_to_characters() {
        // CFR output for "你好，世界！"
        let src = r#"private String greeting = "\u4f60\u597d\uff0c\u4e16\u754c\uff01";"#;
        assert_eq!(
            unescape_unicode_literals(src),
            "private String greeting = \"你好，世界！\";"
        );
    }

    #[test]
    fn keeps_literal_backslash_escapes() {
        // "\\u0041" is a literal \u0041 text, NOT the character 'A'.
        let src = r#"String s = "\\u0041";"#;
        assert_eq!(unescape_unicode_literals(src), r#"String s = "\\u0041";"#);
    }

    #[test]
    fn keeps_ascii_and_non_hex_u() {
        assert_eq!(
            unescape_unicode_literals("hello \\q world"),
            "hello \\q world"
        );
        assert_eq!(unescape_unicode_literals("plain"), "plain");
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
        // JD-GUI: major >= 49 always shows (major - 44), no upper bound.
        let (_, major, label) = class_file_info(&fake_class(99, 0)).unwrap();
        assert_eq!(major, 99);
        assert_eq!(label, "Java 55");
    }

    #[test]
    fn legacy_45_to_48_uses_1x_label() {
        // JD-GUI ClassFileTreeNodeFactoryProvider.makeTip: 45..48 → "1.x".
        assert_eq!(class_file_info(&fake_class(45, 3)).unwrap().2, "1.1");
        assert_eq!(class_file_info(&fake_class(46, 0)).unwrap().2, "1.2");
        assert_eq!(class_file_info(&fake_class(47, 0)).unwrap().2, "1.3");
        assert_eq!(class_file_info(&fake_class(48, 0)).unwrap().2, "1.4");
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
        if let Some(s) = super_name {
            names.push(s.into());
        }
        for i in interfaces {
            names.push((*i).into());
        }
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
        let super_cp = if super_name.is_some() {
            class_idx[1]
        } else {
            0
        };
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

#[cfg(test)]
mod module_name_tests {
    use super::*;

    /// Real javac module-info.class for `module com.example.mymod {}`.
    const MODULE_INFO: &str = "cafebabe00000035000a07000201000b6d6f64756c652d696e666f01000a536f7572636546696c650100106d6f64756c652d696e666f2e6a6176610100064d6f64756c65130007010011636f6d2e6578616d706c652e6d796d6f641300090100096a6176612e626173658000000100000000000000000002000300000002000400050000001600060000000000010008800000000000000000000000";

    #[test]
    fn extracts_module_name() {
        let bytes = hex::decode(MODULE_INFO).unwrap();
        assert_eq!(
            module_name_from_bytes(&bytes).as_deref(),
            Some("com.example.mymod")
        );
    }

    #[test]
    fn invalid_bytes_returns_none() {
        assert!(module_name_from_bytes(b"junk").is_none());
        assert!(module_name_from_bytes(&[]).is_none());
    }
}

#[cfg(test)]
mod unpack_array_tests {
    use super::*;

    #[test]
    fn unpacks_arrays_recursively() {
        assert_eq!(
            unpack_array_type("com/foo/Bar").as_deref(),
            Some("com/foo/Bar")
        );
        assert_eq!(
            unpack_array_type("[Lcom/foo/Bar;").as_deref(),
            Some("com/foo/Bar")
        );
        assert_eq!(
            unpack_array_type("[[Ljava/lang/String;").as_deref(),
            Some("java/lang/String")
        );
        assert_eq!(unpack_array_type("[[[Ldemo/X;").as_deref(), Some("demo/X"));
        assert_eq!(unpack_array_type("[I"), None); // primitive array
        assert_eq!(unpack_array_type("[[I"), None);
    }
}
