//! Spring Boot fat jar: BOOT-INF/classes (main code) + BOOT-INF/lib/*.jar
//! (embedded dependency jars). JD-GUI's recursive container model treats each
//! nested jar as a read-only container. Regression: clicking / jumping to a
//! class from an embedded dependency must resolve against the EXTRACTED nested
//! jar, never against the fat jar (whose entry has a BOOT-INF/classes prefix).
use std::path::Path;

use nexterm_lib::{decompile, jar, jar_db};

fn compile_java(dir: &Path, rel: &str, pkg: &str, body: &str) {
    let src = dir.join(rel);
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(&src, format!("package {pkg};\n{body}\n")).unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join(format!("out-{}", src.file_name().unwrap().to_string_lossy()));
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d")
        .arg(&out)
        .arg(&src)
        .status()
        .unwrap()
        .success());
}

#[test]
#[ignore]
fn fat_jar_nested_dependency_class_decompiles() {
    let dir = std::env::temp_dir().join(format!("jar-fat-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Embedded dependency jar: com/zhbr/pscs/common/util/mybatisplus/utils/R.class
    let dep_src = dir.join("dep-src");
    compile_java(
        &dep_src,
        "com/zhbr/pscs/common/util/mybatisplus/utils/R.java",
        "com.zhbr.pscs.common.util.mybatisplus.utils",
        "public class R { public static R ok() { return new R(); } public int code = 200; }",
    );
    let dep_out = dir.join("dep-out");
    std::fs::create_dir_all(&dep_out).unwrap();
    // javac -d dep-out with package structure (dep_src is flat source root).
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d")
        .arg(&dep_out)
        .arg(dep_src.join("com/zhbr/pscs/common/util/mybatisplus/utils/R.java"))
        .status()
        .unwrap()
        .success());
    let dep_jar = dir.join("common-util.jar");
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&dep_jar)
        .arg("-C")
        .arg(&dep_out)
        .arg(".")
        .status()
        .unwrap()
        .success());

    // Main code under BOOT-INF/classes.
    let main_src = dir.join("main-src");
    compile_java(
        &main_src,
        "com/zhbr/app/App.java",
        "com.zhbr.app",
        "public class App { public static void main(String[] a) {} }",
    );
    let main_out = dir.join("main-out");
    std::fs::create_dir_all(&main_out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d")
        .arg(&main_out)
        .arg(main_src.join("com/zhbr/app/App.java"))
        .status()
        .unwrap()
        .success());

    // Assemble the fat jar: BOOT-INF/classes/** + BOOT-INF/lib/common-util.jar.
    let fat = dir.join("app-0.0.1.jar");
    let staging = dir.join("staging");
    let boot = staging.join("BOOT-INF");
    std::fs::create_dir_all(boot.join("classes")).unwrap();
    std::fs::create_dir_all(boot.join("lib")).unwrap();
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
    copy_tree(&main_out, &main_out, &boot.join("classes"));
    std::fs::copy(&dep_jar, boot.join("lib/common-util.jar")).unwrap();
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&fat)
        .arg("-C")
        .arg(&staging)
        .arg(".")
        .status()
        .unwrap()
        .success());

    // 1) Index the fat jar: main classes (library_id = '') + nested libs.
    let idx = jar::index_jar(&fat).unwrap();
    assert!(
        idx.entries.iter().any(|e| e.entry_path == "BOOT-INF/classes/com/zhbr/app/App.class"),
        "main class indexed with BOOT-INF prefix"
    );
    let scratch_root = dir.join("scratch");
    let nested = jar::extract_and_index_nested(&fat, &scratch_root);
    assert!(!nested.is_empty(), "nested jar extracted");
    let (nested_entry, nested_jar_path, nested_idx) = &nested[0];
    assert!(nested_entry.ends_with("common-util.jar"), "nested: {nested_entry}");
    let r_entry = nested_idx
        .entries
        .iter()
        .find(|e| e.class_name.ends_with(".R") || e.class_name == "R")
        .map(|e| e.entry_path.clone())
        .expect("R.class indexed inside the nested jar");
    assert!(!r_entry.starts_with("BOOT-INF/"), "nested entry has NO BOOT-INF prefix: {r_entry}");

    // 2) DB rows mirroring jar_project_open.
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "jar-fat01";
    jar_db::upsert_project(&conn, &jar_db::JarProject {
        id: pid.into(),
        name: "app-0.0.1.jar".into(),
        jar_path: fat.display().to_string(),
        jar_hash: "f".into(),
        size: 0,
        class_count: 1,
        resource_count: 0,
        created_at: 0,
        updated_at: 0,
    })
    .unwrap();
    let nested_lib_id = format!("{pid}:nested:abcdef123456");
    jar_db::upsert_library(&conn, &jar_db::JarLibrary {
        id: nested_lib_id.clone(),
        project_id: pid.into(),
        name: format!("[nested] common-util.jar|{nested_entry}"),
        group_id: String::new(),
        artifact_id: "common-util".into(),
        version: String::new(),
        jar_path: nested_jar_path.clone(),
        jar_hash: nested_idx.jar_hash.clone(),
        class_count: nested_idx.class_count as i64,
        editable: false,
    })
    .unwrap();
    for e in &nested_idx.entries {
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("{nested_lib_id}:{}", e.entry_path),
            project_id: pid.into(),
            library_id: nested_lib_id.clone(),
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
        })
        .unwrap();
    }

    // 3) jar_navigate("R") → the nested-lib row (entry has NO BOOT-INF prefix).
    let all = jar_db::list_classes(&conn, pid).unwrap();
    let r_row = all
        .iter()
        .find(|c| c.class_name.ends_with(".R"))
        .expect("R row found");
    assert_eq!(r_row.library_id, nested_lib_id);

    // 4) jar_decompile: resolve_jar_path(library_id) → get_library → read → decompile.
    let lib = jar_db::get_library(&conn, pid, &r_row.library_id).unwrap().expect("nested lib");
    assert_ne!(lib.jar_path, fat.display().to_string(), "must resolve to the EXTRACTED nested jar");
    let bytes = jar::read_entry_bytes(Path::new(&lib.jar_path), &r_row.entry_path).unwrap();
    assert!(bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]), "magic ok");
    let jd = decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("R.class");
    std::fs::write(&cf, &bytes).unwrap();
    let src = decompile::decompile_class(&cf, &jd, r_row.entry_path.strip_suffix(".class").unwrap(), None).unwrap();
    assert!(src.contains("class R"), "source: {src}");
    assert!(src.contains("ok"), "static factory: {src}");
    println!("FAT-JAR NESTED DEP CLASS PASS (nested={nested_entry}, entry={})", r_row.entry_path);
    std::fs::remove_dir_all(&dir).ok();
}

/// JD-GUI typeDeclarations index equivalence: jar_known_class_names must
/// contain EVERY type of every OPENED container (main jar + nested libs),
/// keyed by the FULL internal name — that is what makes references clickable.
#[test]
#[ignore]
fn known_names_index_covers_nested_library_types() {
    let dir = std::env::temp_dir().join(format!("jar-kn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);

    // Nested dep jar with com/zhbr/pscs/.../R.class.
    let dep_src = dir.join("ds");
    std::fs::create_dir_all(dep_src.join("com/zhbr/pscs/common/util/mybatisplus/utils")).unwrap();
    std::fs::write(
        dep_src.join("com/zhbr/pscs/common/util/mybatisplus/utils/R.java"),
        "package com.zhbr.pscs.common.util.mybatisplus.utils; public class R { public int code = 1; }",
    )
    .unwrap();
    let dep_out = dir.join("do");
    std::fs::create_dir_all(&dep_out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d").arg(&dep_out).arg(dep_src.join("com/zhbr/pscs/common/util/mybatisplus/utils/R.java"))
        .status().unwrap().success());
    let dep_jar = dir.join("common-util.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&dep_jar).arg("-C").arg(&dep_out).arg(".").status().unwrap().success());

    // Main fat jar with BOOT-INF/classes App + BOOT-INF/lib/common-util.jar.
    let main_src = dir.join("ms");
    std::fs::create_dir_all(main_src.join("com/zhbr/app")).unwrap();
    std::fs::write(main_src.join("com/zhbr/app/App.java"), "package com.zhbr.app; public class App {}").unwrap();
    let main_out = dir.join("mo");
    std::fs::create_dir_all(&main_out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d").arg(&main_out).arg(main_src.join("com/zhbr/app/App.java"))
        .status().unwrap().success());
    let staging = dir.join("stg");
    std::fs::create_dir_all(staging.join("BOOT-INF/classes")).unwrap();
    std::fs::create_dir_all(staging.join("BOOT-INF/lib")).unwrap();
    fn cp(src: &Path, base: &Path, dest: &Path) {
        if src.is_dir() {
            for f in std::fs::read_dir(src).unwrap() {
                cp(&f.unwrap().path(), base, dest);
            }
        } else {
            let rel = src.strip_prefix(base).unwrap();
            let d = dest.join(rel);
            std::fs::create_dir_all(d.parent().unwrap()).unwrap();
            std::fs::copy(src, d).unwrap();
        }
    }
    cp(&main_out, &main_out, &staging.join("BOOT-INF/classes"));
    std::fs::copy(&dep_jar, staging.join("BOOT-INF/lib/common-util.jar")).unwrap();
    let fat = dir.join("app.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&fat).arg("-C").arg(&staging).arg(".").status().unwrap().success());

    // Index main + nested (jar_project_open equivalence).
    let idx = jar::index_jar(&fat).unwrap();
    let nested = jar::extract_and_index_nested(&fat, &dir.join("scratch"));
    assert!(!nested.is_empty());
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "jar-kn";
    jar_db::upsert_project(&conn, &jar_db::JarProject { id: pid.into(), name: "app.jar".into(), jar_path: fat.display().to_string(), jar_hash: "k".into(), size: 0, class_count: 1, resource_count: 0, created_at: 0, updated_at: 0 }).unwrap();
    for e in &idx.entries {
        if e.kind != "class" {
            continue;
        }
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("{pid}:{}", e.entry_path),
            project_id: pid.into(),
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
        }).unwrap();
    }
    for (ename, extracted, nested_idx) in &nested {
        let lib_id = format!("{pid}:nested:{}", &sha12(ename));
        jar_db::upsert_library(&conn, &jar_db::JarLibrary { id: lib_id.clone(), project_id: pid.into(), name: format!("[nested] {}", ename.rsplit('/').next().unwrap()), group_id: String::new(), artifact_id: String::new(), version: String::new(), jar_path: extracted.clone(), jar_hash: nested_idx.jar_hash.clone(), class_count: nested_idx.class_count as i64, editable: false }).unwrap();
        for e in &nested_idx.entries {
            if e.kind != "class" {
                continue;
            }
            jar_db::upsert_class(&conn, &jar_db::JarClassRow {
                id: format!("{lib_id}:{}", e.entry_path),
                project_id: pid.into(),
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
            }).unwrap();
        }
    }

    // jar_known_class_names equivalence: collect ALL class names (dotted +
    // slash internal form) across the project's containers.
    let rows = jar_db::list_classes(&conn, pid).unwrap();
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for r in rows.iter().filter(|r| r.kind == "class") {
        names.insert(r.class_name.clone());
        names.insert(r.class_name.replace('.', "/"));
    }
    assert!(names.contains("com.zhbr.app.App"), "main class indexed");
    assert!(names.contains("com.zhbr.pscs.common.util.mybatisplus.utils.R"), "nested dep class indexed (dotted)");
    assert!(names.contains("com/zhbr/pscs/common/util/mybatisplus/utils/R"), "nested dep class indexed (slash internal form)");
    println!("KNOWN-NAMES INDEX PASS ({} types)", names.len());
    std::fs::remove_dir_all(&dir).ok();
}

fn sha12(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())[..12].to_string()
}
