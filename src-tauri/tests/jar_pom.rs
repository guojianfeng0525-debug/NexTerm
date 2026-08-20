//! POM project integration test — parse a real pom, resolve local deps,
//! index main jar + dependency jars, navigate a symbol.
use std::path::Path;

use nexterm_lib::{jar, jar_db, pom};

#[test]
#[ignore]
fn pom_dependencies_and_navigation() {
    let dir = std::env::temp_dir().join(format!("jar-pom-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Build a tiny main jar.
    let src = dir.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("Main.java"),
        "package demo;\npublic class Main {\n  public String hi() { return \"hi\"; }\n}\n",
    )
    .unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("target");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src.join("Main.java")).status().unwrap().success());
    let main_jar = out.join("demo-app-1.0.0.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&main_jar).arg("-C").arg(&out).arg(".").status().unwrap().success());

    // Write a pom referencing a local-repo dependency (hutool exists in dev).
    let pom_path = dir.join("pom.xml");
    let pom_xml = r#"<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>demo-app</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>cn.hutool</groupId>
      <artifactId>hutool-all</artifactId>
      <version>5.8.25</version>
    </dependency>
  </dependencies>
</project>"#;
    std::fs::write(&pom_path, pom_xml).unwrap();

    // Parse + resolve.
    let info = pom::parse_pom_file(&pom_path).unwrap();
    assert_eq!(info.artifact_id, "demo-app");
    assert_eq!(info.dependencies.len(), 1);
    let dep = &info.dependencies[0];
    assert!(dep.jar_path.is_some(), "hutool jar should resolve: {dep:?}");
    let dep_jar = Path::new(dep.jar_path.as_deref().unwrap());
    assert!(dep_jar.is_file());

    // Index the dependency jar.
    let dep_idx = jar::index_jar(dep_jar).unwrap();
    assert!(dep_idx.class_count > 0, "hutool has classes");
    // Find a known hutool class (cn.hutool.core.util.StrUtil).
    let has_strutil = dep_idx.entries.iter().any(|e| e.class_name == "cn.hutool.core.util.StrUtil");
    assert!(has_strutil, "hutool StrUtil should exist");

    // Full DB flow: project + library + classes.
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(&format!(
        r#"
CREATE TABLE IF NOT EXISTS jar_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', jar_path TEXT NOT NULL DEFAULT '', jar_hash TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, class_count INTEGER NOT NULL DEFAULT 0, resource_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jar_classes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, library_id TEXT NOT NULL DEFAULT '', entry_path TEXT NOT NULL, class_name TEXT NOT NULL DEFAULT '', package_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'class', is_inner_class INTEGER NOT NULL DEFAULT 0, modified_source TEXT, modified INTEGER NOT NULL DEFAULT 0, compile_status TEXT NOT NULL DEFAULT 'none', compile_output TEXT, compile_timestamp INTEGER, source_hash TEXT);
CREATE TABLE IF NOT EXISTS jar_builds (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, output_path TEXT NOT NULL DEFAULT '', built_at INTEGER NOT NULL, result TEXT NOT NULL DEFAULT 'ok', detail TEXT);
CREATE TABLE IF NOT EXISTS jar_libraries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '', artifact_id TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', jar_path TEXT NOT NULL DEFAULT '', jar_hash TEXT NOT NULL DEFAULT '', class_count INTEGER NOT NULL DEFAULT 0, editable INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS jar_symbols (id TEXT PRIMARY KEY, class_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'method', line INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL DEFAULT '');
"#
    ))
    .unwrap();

    let pid = "pom-test";
    jar_db::upsert_project(&conn, &jar_db::JarProject {
        id: pid.into(), name: "demo-app".into(), jar_path: main_jar.display().to_string(),
        jar_hash: "x".into(), size: 0, class_count: 0, resource_count: 0, created_at: 0, updated_at: 0,
    }).unwrap();
    let lib_id = "lib-hutool";
    jar_db::upsert_library(&conn, &jar_db::JarLibrary {
        id: lib_id.into(), project_id: pid.into(), name: "hutool-all-5.8.25.jar".into(),
        group_id: "cn.hutool".into(), artifact_id: "hutool-all".into(), version: "5.8.25".into(),
        jar_path: dep_jar.display().to_string(), jar_hash: dep_idx.jar_hash.clone(), class_count: dep_idx.class_count as i64, editable: false,
    }).unwrap();

    // Insert a few dep classes (StrUtil + a method symbol).
    for e in dep_idx.entries.iter().filter(|e| e.class_name == "cn.hutool.core.util.StrUtil" || e.class_name == "cn.hutool.core.util.StrUtil$Builder") {
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("{lib_id}:{}", e.entry_path), project_id: pid.into(), library_id: lib_id.into(),
            entry_path: e.entry_path.clone(), class_name: e.class_name.clone(), package_name: e.package_name.clone(),
            kind: e.kind.clone(), is_inner_class: e.is_inner_class, modified_source: None,
            modified: false, compile_status: "none".into(), compile_output: None, compile_timestamp: None, source_hash: None,
        }).unwrap();
    }
    // Method symbol: StrUtil.isEmpty on line 5.
    jar_db::upsert_symbol(&conn, &jar_db::JarSymbol {
        id: "sym1".into(), class_id: format!("{lib_id}:cn/hutool/core/util/StrUtil.class"), project_id: pid.into(),
        name: "isEmpty".into(), kind: "method".into(), line: 5, signature: "public static boolean isEmpty(CharSequence str)".into(),
    }).unwrap();

    // Navigate class.
    let found = jar_db::list_classes(&conn, pid).unwrap();
    let strutil = found.iter().find(|c| c.class_name == "cn.hutool.core.util.StrUtil").expect("StrUtil indexed");
    assert_eq!(strutil.library_id, lib_id);

    // Navigate method by name.
    let syms = jar_db::find_symbols_by_name(&conn, pid, "isEmpty").unwrap();
    assert_eq!(syms.len(), 1);
    assert_eq!(syms[0]["line"], 5);
    assert_eq!(syms[0]["className"], "cn.hutool.core.util.StrUtil");

    std::fs::remove_dir_all(&dir).ok();
    println!("POM INTEGRATION PASS");
}
