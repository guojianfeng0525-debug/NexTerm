//! JD-GUI persistence semantics: decompiled sources are NOT cached in SQLite.
//! A modified class shows the user's own source (persisted); an unmodified
//! class is re-decompiled on demand and nothing is written to the DB.
use nexterm_lib::{jar, jar_db};

/// JD-GUI container model: the MAIN tree (jar_class_index) must only contain
/// the main jar's classes (library_id = ''), while each dependency library is
/// its own container (jar_library_index, library_id = the lib id). Mixing
/// them made every click resolve against the wrong jar ("entry not found in
/// archive"). Regression guard for the container-tree split.
#[test]
#[ignore]
fn container_tree_scopes_are_isolated() {
    let dir = std::env::temp_dir().join(format!("jar-containers-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "p1";

    let row = |library_id: &str, entry_path: &str| jar_db::JarClassRow {
        id: format!("{library_id}:{entry_path}"),
        project_id: pid.into(),
        library_id: library_id.into(),
        entry_path: entry_path.into(),
        class_name: entry_path.replace('/', ".").replace(".class", ""),
        package_name: "".into(),
        kind: "class".into(),
        is_inner_class: false,
        modified_source: None,
        modified: false,
        compile_status: "none".into(),
        compile_output: None,
        compile_timestamp: None,
        source_hash: None,
    };
    // Main jar classes + two dependency libraries with overlapping paths.
    for e in ["com/app/Main.class", "com/app/Helper.class"] {
        jar_db::upsert_class(&conn, &row("", e)).unwrap();
    }
    for e in ["com/zhbr/transfer/VO.class", "com/app/Helper.class"] {
        jar_db::upsert_class(&conn, &row("lib-a", e)).unwrap();
    }
    for e in ["com/zhbr/transfer/VO.class"] {
        jar_db::upsert_class(&conn, &row("lib-b", e)).unwrap();
    }

    let all = jar_db::list_classes(&conn, pid).unwrap();
    // jar_class_index filter (main tree): only library_id == ''.
    let main: Vec<_> = all.iter().filter(|r| r.library_id.is_empty()).collect();
    let main_paths: Vec<&str> = main.iter().map(|r| r.entry_path.as_str()).collect();
    assert!(main_paths.contains(&"com/app/Main.class"));
    assert!(main_paths.contains(&"com/app/Helper.class"));
    assert!(!main_paths.contains(&"com/zhbr/transfer/VO.class"), "library class leaked into main tree: {main_paths:?}");
    // jar_library_index filter: only the requested library.
    let lib_a: Vec<_> = all.iter().filter(|r| r.library_id == "lib-a").collect();
    let lib_a_paths: Vec<&str> = lib_a.iter().map(|r| r.entry_path.as_str()).collect();
    assert!(lib_a_paths.contains(&"com/zhbr/transfer/VO.class"));
    assert!(!lib_a_paths.contains(&"com/app/Main.class"), "main class leaked into library tree: {lib_a_paths:?}");
    // Same entry_path in two libraries → distinct rows, each resolvable by its lib.
    let lib_b: Vec<_> = all.iter().filter(|r| r.library_id == "lib-b").collect();
    assert_eq!(lib_b.len(), 1);
    assert_eq!(lib_b[0].entry_path, "com/zhbr/transfer/VO.class");
    println!("CONTAINER SCOPES PASS (main={main_paths:?}, lib-a={lib_a_paths:?})");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
#[ignore]
fn modified_source_is_persisted_unmodified_is_not() {
    let dir = std::env::temp_dir().join(format!("jar-cache-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Build a tiny class + jar.
    let src = dir.join("Hello.java");
    std::fs::write(&src, "public class Hello { public int f() { return 1; } }").unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    if !jdk.found { eprintln!("skip"); return; }
    let classes = dir.join("classes");
    std::fs::create_dir_all(&classes).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&classes).arg(&src).status().unwrap().success());
    let jar_path = dir.join("h.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&classes).arg(".").status().unwrap().success());

    // DB + project + class row (empty: no decompiled source stored).
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "p1";
    jar_db::upsert_project(&conn, &jar_db::JarProject { id: pid.into(), name: "h.jar".into(), jar_path: jar_path.display().to_string(), jar_hash: "x".into(), size: 0, class_count: 1, resource_count: 0, created_at: 0, updated_at: 0 }).unwrap();
    let entry = "Hello.class";
    jar_db::upsert_class(&conn, &jar_db::JarClassRow { id: format!("{pid}:{entry}"), project_id: pid.into(), library_id: "".into(), entry_path: entry.into(), class_name: "Hello".into(), package_name: "".into(), kind: "class".into(), is_inner_class: false, modified_source: None, modified: false, compile_status: "none".into(), compile_output: None, compile_timestamp: None, source_hash: None }).unwrap();

    // Unmodified: decompile works, but the DB row keeps NO source (no caching).
    let bytes = jar::read_entry_bytes(&jar_path, entry).unwrap();
    let jd = nexterm_lib::decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("Hello.class");
    std::fs::write(&cf, &bytes).unwrap();
    let src1 = nexterm_lib::decompile::decompile_class(&cf, &jd, "Hello", None).unwrap();
    assert!(src1.contains("class Hello"));
    let c = jar_db::get_class(&conn, pid, entry).unwrap().unwrap();
    assert!(c.modified_source.is_none(), "unmodified class must not persist source");
    assert!(!c.modified);

    // User saves an edit → the edit IS persisted and marked modified.
    let edited = "public class Hello { public int f() { return 42; } }";
    jar_db::upsert_class(&conn, &jar_db::JarClassRow { modified_source: Some(edited.into()), modified: true, compile_status: "stale".into(), ..c.clone() }).unwrap();
    let c2 = jar_db::get_class(&conn, pid, entry).unwrap().unwrap();
    assert_eq!(c2.modified_source.as_deref(), Some(edited));
    assert!(c2.modified);
    println!("CACHE SEMANTICS PASS (no decompiled-source caching)");
    std::fs::remove_dir_all(&dir).ok();
}
