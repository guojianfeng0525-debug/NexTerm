//! End-to-end test through the real DB + pipeline modules (no Tauri).
//!
//! Exercises the same code paths as the Tauri commands:
//!   open (index + DB rows) → decompile (CFR) → save (version + modified)
//!   → compile (javac) → build (new JAR) → original untouched.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use nexterm_lib::jar_db;
use nexterm_lib::{builder, compile, decompile, jar};

fn run(cmd: &mut std::process::Command) -> std::process::Output {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("run")
}

#[test]
#[ignore]
fn command_chain() {
    let dir = std::env::temp_dir().join(format!("jar-chain-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Build a real jar with two classes.
    let src = dir.join("src/com/app");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("App.java"),
        "package com.app;\npublic class App {\n  public int compute(int x) { return x * 2; }\n}\n",
    )
    .unwrap();
    std::fs::write(
        src.join("Helper.java"),
        "package com.app;\npublic class Helper {\n  public static String greet(String n) { return \"Hi \" + n; }\n}\n",
    )
    .unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let javac = jdk.javac_path.unwrap();
    let classes = dir.join("classes");
    std::fs::create_dir_all(&classes).unwrap();
    assert!(run(std::process::Command::new(&javac).arg("-d").arg(&classes).arg(src.join("App.java")).arg(src.join("Helper.java"))).status.success());
    let jar_path = dir.join("app.jar");
    assert!(run(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&classes).arg(".")).status.success());

    // DB.
    let db_path = dir.join("test.db");
    let conn = jar_db::open(&db_path).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();

    // 1) Open: index + insert rows.
    let idx = jar::index_jar(&jar_path).unwrap();
    let id = format!("jar-{}", &idx.jar_hash[..16]);
    jar_db::upsert_project(
        &conn,
        &jar_db::JarProject {
            id: id.clone(),
            name: "app.jar".into(),
            jar_path: jar_path.display().to_string(),
            jar_hash: idx.jar_hash.clone(),
            size: idx.size as i64,
            class_count: idx.class_count as i64,
            resource_count: idx.resource_count as i64,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    for e in &idx.entries {
        jar_db::upsert_class(
            &conn,
            &jar_db::JarClassRow {
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
            },
        )
        .unwrap();
    }
    let all_classes = jar_db::list_classes(&conn, &id).unwrap();
    assert_eq!(all_classes.iter().filter(|c| c.kind == "class").count(), 2);
    assert_eq!(all_classes.iter().filter(|c| c.kind == "meta-inf").count(), 1);

    // 2) Decompile App via CFR (JD-GUI: re-decompile, never cached in DB).
    let cfr = decompile::find_cfr_jar().unwrap();
    let class_bytes = jar::read_entry_bytes(&jar_path, "com/app/App.class").unwrap();
    let scratch = dir.join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let cf = scratch.join("App.class");
    std::fs::write(&cf, &class_bytes).unwrap();
    let source = decompile::decompile_class(&cf, &cfr, None).unwrap();
    assert!(source.contains("class App"));

    // 3) Save a modification: x * 2 → x * 3 (persisted; no version history).
    let modified = source.replace("x * 2", "x * 3");
    let id_app = format!("{id}:com/app/App.class");
    let c = jar_db::get_class_by_id(&conn, &id_app).unwrap().unwrap();
    jar_db::upsert_class(
        &conn,
        &jar_db::JarClassRow {
            modified_source: Some(modified.clone()),
            modified: true,
            compile_status: "stale".into(),
            compile_output: None,
            compile_timestamp: None,
            source_hash: Some(jar::sha256_bytes(modified.as_bytes())),
            ..c.clone()
        },
    )
    .unwrap();
    assert_eq!(jar_db::list_modified_classes(&conn, &id).unwrap().len(), 1);

    // 4) Compile the modified source (output NOT persisted — regenerated on build).
    let comp_dir = dir.join("compile");
    let res = compile::compile_sources(
        &javac,
        &[("com/app/App.java".to_string(), modified.clone())],
        Some(&jar_path.display().to_string()),
        &comp_dir,
    )
    .unwrap();
    assert!(res.success, "compile failed: {:?}", res.diagnostics);
    let new_bytes = res.classes.iter().find(|(p, _)| p == "com/app/App.class").unwrap().1.clone();

    // 5) Build new jar (compile output in memory, no versions table involved).
    let out_jar = dir.join("app-modified.jar");
    let mut overrides = HashMap::new();
    overrides.insert("com/app/App.class".to_string(), new_bytes);
    builder::build_jar(&jar_path, &overrides, &[], &[], &out_jar).unwrap();
    jar_db::insert_build(&conn, &id, &out_jar.display().to_string(), "ok", None).unwrap();

    // 6) Verify.
    let orig = jar::read_entry_bytes(&jar_path, "com/app/App.class").unwrap();
    let new = jar::read_entry_bytes(&out_jar, "com/app/App.class").unwrap();
    assert_ne!(orig, new);
    let orig_helper = jar::read_entry_bytes(&jar_path, "com/app/Helper.class").unwrap();
    let new_helper = jar::read_entry_bytes(&out_jar, "com/app/Helper.class").unwrap();
    assert_eq!(orig_helper, new_helper, "unmodified Helper must be byte-identical");
    assert_eq!(jar_db::list_builds(&conn, &id).unwrap().len(), 1);

    std::fs::remove_dir_all(&dir).ok();
    println!("COMMAND CHAIN PASS");
}
