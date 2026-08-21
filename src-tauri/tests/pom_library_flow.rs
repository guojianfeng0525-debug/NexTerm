//! Regression: clicking a class inside a DEPENDENCY LIBRARY container must
//! decompile it from that library's jar (JD-GUI container model). Reproduces
//! the exact data flow of jar_pom_open → jar_library_index → jar_decompile:
//! library rows are indexed with library_id = the lib id, the tree comes from
//! jar_library_index, and decompile resolves the jar via get_library.
use std::path::Path;

use nexterm_lib::{decompile, jar, jar_db};

fn make_class_jar(dir: &Path, pkg_dotted: &str, name: &str) -> std::path::PathBuf {
    let pkg_dir = pkg_dotted.replace('.', "/");
    let src_dir = dir.join(&pkg_dir);
    std::fs::create_dir_all(&src_dir).unwrap();
    let src = src_dir.join(format!("{name}.java"));
    std::fs::write(
        &src,
        format!("package {pkg_dotted};\npublic class {name} {{ public String hi() {{ return \"ok\"; }} }}\n"),
    )
    .unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join(format!("out-{name}"));
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d")
        .arg(&out)
        .arg(&src)
        .status()
        .unwrap()
        .success());
    let jar_path = dir.join(format!("{name}.jar"));
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&jar_path)
        .arg("-C")
        .arg(&out)
        .arg(".")
        .status()
        .unwrap()
        .success());
    jar_path
}

#[test]
#[ignore]
fn library_class_decompile_resolves_from_library_jar() {
    let dir = std::env::temp_dir().join(format!("jar-libflow-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Dependency library jar: com/zhbr/pscs/common/util/mybatisplus/utils/PageUtils.class
    let dep_jar = make_class_jar(&dir, "com.zhbr.pscs.common.util.mybatisplus.utils", "PageUtils");
    // Main jar: com/zhbr/app/Main.class
    let main_jar = make_class_jar(&dir, "com.zhbr.app", "Main");

    // DB: project + library + rows (exactly as jar_pom_open writes them).
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "jar-pom-abcdef1234567890";
    jar_db::upsert_project(&conn, &jar_db::JarProject {
        id: pid.into(),
        name: "app-1.0".into(),
        jar_path: main_jar.display().to_string(),
        jar_hash: "main".into(),
        size: 0,
        class_count: 1,
        resource_count: 0,
        created_at: 0,
        updated_at: 0,
    })
    .unwrap();
    let lib_id = format!("{pid}:dep:{}", crate_sha(&dep_jar));
    jar_db::upsert_library(&conn, &jar_db::JarLibrary {
        id: lib_id.clone(),
        project_id: pid.into(),
        name: "common-util-1.0.jar".into(),
        group_id: "com.zhbr".into(),
        artifact_id: "common-util".into(),
        version: "1.0".into(),
        jar_path: dep_jar.display().to_string(),
        jar_hash: "dep".into(),
        class_count: 1,
        editable: false,
    })
    .unwrap();
    // Index the dep jar and insert its classes under the library id.
    let dep_idx = jar::index_jar(&dep_jar).unwrap();
    let entry = dep_idx
        .entries
        .iter()
        .find(|e| e.class_name.ends_with("PageUtils"))
        .expect("PageUtils indexed")
        .entry_path
        .clone();
    for e in &dep_idx.entries {
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
        })
        .unwrap();
    }
    // Main jar classes (library_id = '').
    let main_idx = jar::index_jar(&main_jar).unwrap();
    for e in &main_idx.entries {
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
        })
        .unwrap();
    }

    // 1) Container isolation (jar_class_index filter): the main tree must NOT
    //    contain the library's PageUtils.
    let all = jar_db::list_classes(&conn, pid).unwrap();
    let main_paths: Vec<&str> = all.iter().filter(|r| r.library_id.is_empty()).map(|r| r.entry_path.as_str()).collect();
    assert!(!main_paths.iter().any(|p| p.contains("PageUtils")), "library class leaked into main tree: {main_paths:?}");
    // 2) jar_library_index tree contains PageUtils with the library id.
    let lib_rows: Vec<_> = all.iter().filter(|r| r.library_id == lib_id).collect();
    assert!(lib_rows.iter().any(|r| r.entry_path.contains("PageUtils")), "PageUtils missing from library rows");

    // 3) jar_decompile flow: resolve the library jar, read bytes, decompile.
    let lib = jar_db::get_library(&conn, pid, &lib_id).unwrap().expect("library found");
    let bytes = jar::read_entry_bytes(Path::new(&lib.jar_path), &entry).unwrap();
    assert!(bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]), "magic ok");
    let jd = decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("PageUtils.class");
    std::fs::write(&cf, &bytes).unwrap();
    let internal = entry.strip_suffix(".class").unwrap();
    let src = decompile::decompile_class(&cf, &jd, internal, None).unwrap();
    assert!(src.contains("class PageUtils"), "source: {src}");
    println!("LIBRARY CLASS FLOW PASS (entry={entry}, lib={lib_id})");
    std::fs::remove_dir_all(&dir).ok();
}

fn crate_sha(p: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(std::fs::read(p).unwrap());
    hex::encode(h.finalize())[..12].to_string()
}
