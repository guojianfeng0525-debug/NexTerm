//! Nested-archive indexing (Spring Boot BOOT-INF/lib style): build a fat jar
//! that embeds another jar, then verify list_nested_archives + extraction +
//! DB indexing of the nested library.
use nexterm_lib::{compile, jar, jar_db};

fn run(cmd: &mut std::process::Command) -> std::process::Output {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("run")
}

#[test]
#[ignore]
fn nested_archive_flow() {
    let dir = std::env::temp_dir().join(format!("jar-nested-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // 1) Build an inner jar with one class.
    let src = dir.join("inner/com/dep");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("Dep.java"), "package com.dep;\npublic class Dep { public int calc() { return 7; } }\n").unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let inner_out = dir.join("inner-out");
    std::fs::create_dir_all(&inner_out).unwrap();
    assert!(run(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&inner_out).arg(src.join("Dep.java"))).status.success());
    let inner_jar = dir.join("dep-lib.jar");
    assert!(run(std::process::Command::new("jar").arg("cf").arg(&inner_jar).arg("-C").arg(&inner_out).arg(".")).status.success());

    // 2) Embed it in a "fat" jar under BOOT-INF/lib/ + one top-level class.
    let app_src = dir.join("app/Hello.java");
    std::fs::create_dir_all(app_src.parent().unwrap()).unwrap();
    std::fs::write(&app_src, "public class Hello { public String hi() { return \"hi\"; } }\n").unwrap();
    let app_out = dir.join("app-out");
    std::fs::create_dir_all(&app_out).unwrap();
    assert!(run(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&app_out).arg(&app_src)).status.success());
    let fat_jar = dir.join("fat.jar");
    {
        use std::process::Stdio;
        // Manually assemble: classes at root + BOOT-INF/lib/dep-lib.jar + manifest.
        let mut cmd = std::process::Command::new("jar");
        cmd.arg("cf").arg(&fat_jar);
        let entries = [
            app_out.join("Hello.class"),
            inner_jar.clone(),
        ];
        for e in &entries {
            cmd.arg("-C").arg(e.parent().unwrap()).arg(e.file_name().unwrap());
        }
        // Add nested under BOOT-INF/lib using a second jar invocation? Simpler:
        // use zip tooling: append via 'zip' if available, else reconstruct.
        let status = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).status();
        assert!(status.unwrap().success());
    }

    // The plain `jar cf` puts dep-lib.jar at the ROOT, not BOOT-INF/lib. Use
    // Python zipfile to build a proper BOOT-INF/lib layout for determinism.
    let fat2 = dir.join("fat2.jar");
    let py = format!(
        "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.write(sys.argv[2],'Hello.class')\nz.write(sys.argv[3],'BOOT-INF/lib/dep-lib.jar')\nz.writestr('META-INF/MANIFEST.MF','Manifest-Version: 1.0\\n')\nz.close()\n"
    );
    let ok = std::process::Command::new("python3").arg("-c").arg(&py).arg(&fat2).arg(app_out.join("Hello.class")).arg(&inner_jar).status().unwrap().success();
    assert!(ok, "python zip assembly failed");

    // 3) list_nested_archives finds BOOT-INF/lib/dep-lib.jar.
    let nested = jar::list_nested_archives(&fat2).unwrap();
    assert!(nested.iter().any(|n| n == "BOOT-INF/lib/dep-lib.jar"), "nested entries: {nested:?}");

    // 4) Extract + index as library.
    let extracted = dir.join("scratch/extracted.jar");
    jar::extract_entry(&fat2, "BOOT-INF/lib/dep-lib.jar", &extracted).unwrap();
    let idx = jar::index_jar(&extracted).unwrap();
    assert!(idx.entries.iter().any(|e| e.class_name == "com.dep.Dep"), "Dep class indexed");

    // 5) DB flow: project + nested library row.
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "fat";
    jar_db::upsert_project(&conn, &jar_db::JarProject {
        id: pid.into(), name: "fat.jar".into(), jar_path: fat2.display().to_string(),
        jar_hash: "x".into(), size: 0, class_count: 0, resource_count: 0, created_at: 0, updated_at: 0,
    }).unwrap();
    let lib_id = "fat:nested:abc";
    jar_db::upsert_library(&conn, &jar_db::JarLibrary {
        id: lib_id.into(), project_id: pid.into(), name: "[nested] dep-lib.jar|BOOT-INF/lib/dep-lib.jar".into(),
        group_id: String::new(), artifact_id: "dep-lib".into(), version: String::new(),
        jar_path: extracted.display().to_string(), jar_hash: idx.jar_hash.clone(), class_count: idx.class_count as i64, editable: false,
    }).unwrap();
    for e in &idx.entries {
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("{lib_id}:{}", e.entry_path), project_id: pid.into(), library_id: lib_id.into(),
            entry_path: e.entry_path.clone(), class_name: e.class_name.clone(), package_name: e.package_name.clone(),
            kind: e.kind.clone(), is_inner_class: e.is_inner_class, modified_source: None, modified: false,
            compile_status: "none".into(), compile_output: None, compile_timestamp: None, source_hash: None,
        }).unwrap();
    }
    // Search must find the nested class across the project (Open Type scope).
    let classes = jar_db::list_classes(&conn, pid).unwrap();
    assert!(classes.iter().any(|c| c.class_name == "com.dep.Dep" && c.library_id == lib_id), "nested class indexed under lib");

    println!("NESTED ARCHIVE FLOW PASS (BOOT-INF/lib/dep-lib.jar → com.dep.Dep)");
    std::fs::remove_dir_all(&dir).ok();
}
