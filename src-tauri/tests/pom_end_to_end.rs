//! End-to-end: Maven dependency library → click a class → decompile; and the
//! method-location flow (click a service method in a controller, resolve the
//! interface method in the library). Reproduces jar_pom_open's library
//! indexing + jar_decompile's jar resolution + resolve_member's decompile.
use std::path::Path;

use nexterm_lib::{decompile, jar, jar_db, pom};

fn make_java_jar(
    dir: &Path,
    rel_src: &str,
    pkg_dotted: &str,
    name: &str,
    body: &str,
    cp: &[&Path],
) -> std::path::PathBuf {
    let src_path = dir.join(rel_src);
    std::fs::create_dir_all(src_path.parent().unwrap()).unwrap();
    std::fs::write(&src_path, format!("package {pkg_dotted};\n{body}\n")).unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join(format!("out-{name}"));
    std::fs::create_dir_all(&out).unwrap();
    let mut cmd = std::process::Command::new(jdk.javac_path.as_deref().unwrap());
    if !cp.is_empty() {
        let cps: Vec<String> = cp.iter().map(|p| p.display().to_string()).collect();
        cmd.arg("-cp").arg(cps.join(":"));
    }
    let jc = cmd.arg("-d").arg(&out).arg(&src_path).output().unwrap();
    assert!(
        jc.status.success(),
        "javac failed for {name}: {}",
        String::from_utf8_lossy(&jc.stderr)
    );
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
fn pom_library_click_and_service_method_location() {
    let dir = std::env::temp_dir().join(format!("jar-pome2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Fake local Maven repo: com/zhbr/common-util/1.0/common-util-1.0.jar with
    // PageUtils (class) + UserService (interface with getUserName).
    let repo = dir.join("m2/repository");
    let dep_jar_path = repo.join("com/zhbr/common-util/1.0/common-util-1.0.jar");
    std::fs::create_dir_all(dep_jar_path.parent().unwrap()).unwrap();
    // Build the dep jar in a scratch dir, then move it into the repo layout.
    let dep_scratch = dir.join("dep-src");
    let _ = make_java_jar(
        &dep_scratch,
        "com/zhbr/pscs/common/util/mybatisplus/utils/PageUtils.java",
        "com.zhbr.pscs.common.util.mybatisplus.utils",
        "PageUtils",
        "public class PageUtils { public static String build(int page) { return \"p\" + page; } }",
        &[],
    );
    let _ = make_java_jar(
        &dep_scratch,
        "com/zhbr/app/UserService.java",
        "com.zhbr.app",
        "UserService",
        "public interface UserService { String getUserName(long id); }",
        &[],
    );
    let dep_jar = dep_scratch.join("PageUtils.jar");
    std::fs::copy(&dep_jar, &dep_jar_path).unwrap();
    // The interface lives in the same jar: rebuild a combined jar.
    let out_dir = dir.join("dep-combined");
    std::fs::create_dir_all(&out_dir).unwrap();
    fn copy_tree(src: &Path, base: &Path, dest_root: &Path) {
        if src.is_dir() {
            for f in std::fs::read_dir(src).unwrap() {
                copy_tree(&f.unwrap().path(), base, dest_root);
            }
        } else {
            let rel = src.strip_prefix(base).unwrap();
            let dest = dest_root.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::copy(src, dest).unwrap();
        }
    }
    for out_sub in ["out-PageUtils", "out-UserService"] {
        let base = dep_scratch.join(out_sub);
        copy_tree(&base, &base, &out_dir);
    }
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&dep_jar_path)
        .arg("-C")
        .arg(&out_dir)
        .arg(".")
        .status()
        .unwrap()
        .success());

    // Main jar: UserController injecting UserService.
    let svc_out = dep_scratch.join("out-UserService");
    let main_jar = make_java_jar(
        &dir,
        "com/zhbr/app/UserController.java",
        "com.zhbr.app",
        "UserController",
        "public class UserController { private final UserService service; public UserController(UserService s) { this.service = s; } public String handle(long id) { return service.getUserName(id); } }",
        &[&svc_out],
    );

    // DB: project + library (as jar_pom_open would) + rows.
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "jar-pom-e2e";
    jar_db::upsert_project(
        &conn,
        &jar_db::JarProject {
            id: pid.into(),
            name: "app-1.0".into(),
            jar_path: main_jar.display().to_string(),
            jar_hash: "m".into(),
            size: 0,
            class_count: 1,
            resource_count: 0,
            created_at: 0,
            updated_at: 0,
        },
    )
    .unwrap();
    // Library row + classes, indexed from the fake-repo jar (the pom resolver
    // would produce exactly this path).
    let resolved = pom::resolve_dependency_jar(&repo, "com.zhbr", "common-util", "1.0")
        .expect("dependency jar resolves in fake repo");
    assert_eq!(resolved, dep_jar_path);
    let lib_id = format!("{pid}:dep:e2e");
    jar_db::upsert_library(
        &conn,
        &jar_db::JarLibrary {
            id: lib_id.clone(),
            project_id: pid.into(),
            name: "common-util-1.0.jar".into(),
            group_id: "com.zhbr".into(),
            artifact_id: "common-util".into(),
            version: "1.0".into(),
            jar_path: resolved.display().to_string(),
            jar_hash: "d".into(),
            class_count: 2,
            editable: false,
        },
    )
    .unwrap();
    let dep_idx = jar::index_jar(&dep_jar_path).unwrap();
    assert!(
        dep_idx
            .entries
            .iter()
            .any(|e| e.class_name.ends_with("PageUtils")),
        "PageUtils indexed"
    );
    assert!(
        dep_idx
            .entries
            .iter()
            .any(|e| e.class_name.ends_with("UserService")),
        "UserService indexed"
    );
    for e in &dep_idx.entries {
        jar_db::upsert_class(
            &conn,
            &jar_db::JarClassRow {
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
            },
        )
        .unwrap();
    }
    let main_idx = jar::index_jar(&main_jar).unwrap();
    for e in &main_idx.entries {
        if e.kind != "class" {
            continue;
        }
        jar_db::upsert_class(
            &conn,
            &jar_db::JarClassRow {
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
            },
        )
        .unwrap();
    }

    // 1) Click a library class: resolve jar via get_library, read, decompile.
    let lib = jar_db::get_library(&conn, pid, &lib_id)
        .unwrap()
        .expect("library");
    let page_utils_entry = dep_idx
        .entries
        .iter()
        .find(|e| e.class_name.ends_with("PageUtils"))
        .unwrap()
        .entry_path
        .clone();
    let bytes = jar::read_entry_bytes(Path::new(&lib.jar_path), &page_utils_entry).unwrap();
    let jd = decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("PageUtils.class");
    std::fs::write(&cf, &bytes).unwrap();
    let src = decompile::decompile_class(
        &cf,
        &jd,
        page_utils_entry.strip_suffix(".class").unwrap(),
        None,
    )
    .unwrap();
    assert!(src.contains("class PageUtils"), "source: {src}");
    println!("POM LIB CLICK PASS");

    // 2) Service method location: UserController calls service.getUserName();
    //    resolve the interface method inside the library jar (resolve_member
    //    equivalent: find row → get_library → read → class_members → decompile
    //    → extract_methods line).
    let all = jar_db::list_classes(&conn, pid).unwrap();
    eprintln!(
        "CLASSES: {:?}",
        all.iter()
            .map(|r| (&r.library_id, &r.class_name, &r.kind))
            .collect::<Vec<_>>()
    );
    let dotted = "com.zhbr.app.UserService";
    let row = all
        .iter()
        .find(|c| c.class_name == dotted && c.kind == "class" && c.library_id.is_empty())
        .or_else(|| {
            all.iter()
                .find(|c| c.class_name == dotted && c.kind == "class")
        })
        .expect("UserService row");
    assert_eq!(row.library_id, lib_id, "UserService lives in the library");
    let jar_path = if row.library_id.is_empty() {
        main_jar.clone()
    } else {
        std::path::PathBuf::from(
            jar_db::get_library(&conn, pid, &row.library_id)
                .unwrap()
                .unwrap()
                .jar_path,
        )
    };
    let svc_bytes = jar::read_entry_bytes(&jar_path, &row.entry_path).unwrap();
    let members = jar::class_members(&svc_bytes);
    assert!(
        members.methods.iter().any(|m| m == "getUserName"),
        "interface method indexed: {:?}",
        members.methods
    );
    let svc_cf = dir.join("UserService.class");
    std::fs::write(&svc_cf, &svc_bytes).unwrap();
    let internal = row.entry_path.strip_suffix(".class").unwrap();
    let svc_src = decompile::decompile_class(&svc_cf, &jd, internal, None).unwrap();
    let hit = jar::extract_methods(&svc_src)
        .into_iter()
        .find(|m| m.name == "getUserName");
    assert!(hit.is_some(), "getUserName line found in: {svc_src}");
    println!("SERVICE METHOD LOCATION PASS (line {})", hit.unwrap().line);
    std::fs::remove_dir_all(&dir).ok();
}

/// User scenario: controller injects a service that lives in the MAIN jar
/// (no external dependency). Clicking the service method must resolve the
/// interface method declaration.
#[test]
#[ignore]
fn main_jar_service_method_location() {
    let dir = std::env::temp_dir().join(format!("jar-mainsvc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let svc_src = dir.join("svc-src/com/zhbr/app/Service.java");
    std::fs::create_dir_all(svc_src.parent().unwrap()).unwrap();
    std::fs::write(
        &svc_src,
        "package com.zhbr.app;\npublic interface Service { void methodB(long id); }\n",
    )
    .unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let svc_out = dir.join("svc-out");
    std::fs::create_dir_all(&svc_out).unwrap();
    assert!(
        std::process::Command::new(jdk.javac_path.as_deref().unwrap())
            .arg("-d")
            .arg(&svc_out)
            .arg(&svc_src)
            .status()
            .unwrap()
            .success()
    );
    // Controller referencing service.methodB (compile against the interface).
    let ctl_src = dir.join("ctl-src/com/zhbr/app/Controller.java");
    std::fs::create_dir_all(ctl_src.parent().unwrap()).unwrap();
    std::fs::write(&ctl_src, "package com.zhbr.app;\npublic class Controller { private final Service a; public Controller(Service a) { this.a = a; } public void go(long id) { a.methodB(id); } }\n").unwrap();
    let ctl_out = dir.join("ctl-out");
    std::fs::create_dir_all(&ctl_out).unwrap();
    assert!(
        std::process::Command::new(jdk.javac_path.as_deref().unwrap())
            .arg("-cp")
            .arg(&svc_out)
            .arg("-d")
            .arg(&ctl_out)
            .arg(&ctl_src)
            .status()
            .unwrap()
            .success()
    );
    // Main jar with both.
    let main_jar = dir.join("main.jar");
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&main_jar)
        .arg("-C")
        .arg(&svc_out)
        .arg(".")
        .arg("-C")
        .arg(&ctl_out)
        .arg(".")
        .status()
        .unwrap()
        .success());

    // Controller's constant pool must carry the method ref owner.
    let ctl_bytes = jar::read_entry_bytes(&main_jar, "com/zhbr/app/Controller.class").unwrap();
    let pool = jar::parse_class_pool(&ctl_bytes).unwrap();
    let b = pool
        .refs
        .iter()
        .find(|r| r.name.as_deref() == Some("methodB"))
        .expect("methodB ref");
    assert_eq!(
        b.internal_type_name, "com/zhbr/app/Service",
        "owner is the service interface"
    );

    // jd-core wrapper refs: the decompiled Controller must carry the methodB
    // reference with its EXACT source position (JD-GUI hyperlink semantics).
    let ctl_cf = dir.join("Controller.class");
    std::fs::write(&ctl_cf, &ctl_bytes).unwrap();
    let ctl_jd = decompile::find_decompiler_jar().unwrap();
    let ctl_res =
        decompile::decompile_class(&ctl_cf, &ctl_jd, "com/zhbr/app/Controller", None).unwrap();
    let pos_ref = ctl_res
        .refs
        .iter()
        .find(|r| r.kind == "method" && r.name.as_deref() == Some("methodB"))
        .expect("methodB position ref");
    assert_eq!(pos_ref.internal_type_name, "com/zhbr/app/Service");
    assert!(
        pos_ref.offset > 0 && pos_ref.len == "methodB".len(),
        "offset={} len={}",
        pos_ref.offset,
        pos_ref.len
    );
    let src_text = &ctl_res.source[pos_ref.offset..pos_ref.offset + pos_ref.len];
    assert_eq!(
        src_text, "methodB",
        "position must point at the token: {src_text}"
    );
    println!(
        "POSITION-BOUND REF PASS (offset={}, len={})",
        pos_ref.offset, pos_ref.len
    );

    // resolve_member equivalent: find Service row (main jar), decompile, find
    // the interface method line.
    let jd = decompile::find_decompiler_jar().unwrap();
    let svc_bytes = jar::read_entry_bytes(&main_jar, "com/zhbr/app/Service.class").unwrap();
    let cf = dir.join("Service.class");
    std::fs::write(&cf, &svc_bytes).unwrap();
    let src = decompile::decompile_class(&cf, &jd, "com/zhbr/app/Service", None).unwrap();
    let hit = jar::extract_methods(&src)
        .into_iter()
        .find(|m| m.name == "methodB");
    assert!(hit.is_some(), "interface method line found in: {src}");
    println!(
        "MAIN-JAR SERVICE METHOD LOCATION PASS (line {})",
        hit.unwrap().line
    );
    std::fs::remove_dir_all(&dir).ok();
}
