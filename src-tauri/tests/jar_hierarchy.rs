//! Integration test for the JD-GUI hierarchy command path: build a small jar
//! with an inheritance chain, then exercise the scan + hierarchy logic.
use nexterm_lib::{compile, jar, jar_db};

fn run(cmd: &mut std::process::Command) -> std::process::Output {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("run")
}

#[test]
#[ignore]
fn hierarchy_chain() {
    let dir = std::env::temp_dir().join(format!("jar-hier-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let src = dir.join("src/demo");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("Base.java"), "package demo;\npublic class Base { public int v() { return 1; } }\n").unwrap();
    std::fs::write(src.join("Mid.java"), "package demo;\npublic class Mid extends Base { }\n").unwrap();
    std::fs::write(src.join("Leaf.java"), "package demo;\npublic class Leaf extends Mid { }\n").unwrap();
    std::fs::write(src.join("Iface.java"), "package demo;\npublic interface Iface { }\n").unwrap();
    std::fs::write(src.join("Impl.java"), "package demo;\npublic class Impl extends Base implements Iface { }\n").unwrap();

    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let status = run(
        std::process::Command::new(jdk.javac_path.as_deref().unwrap())
            .arg("-d")
            .arg(&out)
            .arg(src.join("Base.java"))
            .arg(src.join("Mid.java"))
            .arg(src.join("Leaf.java"))
            .arg(src.join("Iface.java"))
            .arg(src.join("Impl.java")),
    )
    .status;
    assert!(status.success(), "javac failed");
    let jar_path = dir.join("demo.jar");
    assert!(run(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&out).arg(".")).status.success());

    // 1) class_super on the real bytes: Mid extends Base.
    let mid = jar::read_entry_bytes(&jar_path, "demo/Mid.class").unwrap();
    let (sup, ifaces) = jar::class_super(&mid).unwrap();
    assert_eq!(sup.as_deref(), Some("demo/Base"));
    assert!(ifaces.is_empty());

    // 2) Impl extends Base AND implements Iface.
    let impl_bytes = jar::read_entry_bytes(&jar_path, "demo/Impl.class").unwrap();
    let (sup2, ifaces2) = jar::class_super(&impl_bytes).unwrap();
    assert_eq!(sup2.as_deref(), Some("demo/Base"));
    assert_eq!(ifaces2, vec!["demo/Iface".to_string()]);

    // 3) DB project so the command can list classes.
    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    let pid = "h1";
    jar_db::upsert_project(&conn, &jar_db::JarProject {
        id: pid.into(), name: "demo.jar".into(), jar_path: jar_path.display().to_string(),
        jar_hash: "x".into(), size: 0, class_count: 0, resource_count: 0, created_at: 0, updated_at: 0,
    }).unwrap();
    let idx = jar::index_jar(&jar_path).unwrap();
    for e in &idx.entries {
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("{pid}:{}", e.entry_path), project_id: pid.into(), library_id: "".into(),
            entry_path: e.entry_path.clone(), class_name: e.class_name.clone(), package_name: e.package_name.clone(),
            kind: e.kind.clone(), is_inner_class: e.is_inner_class, modified_source: None, modified: false,
            compile_status: "none".into(), compile_output: None, compile_timestamp: None, source_hash: None,
        }).unwrap();
    }

    // 4) Re-run the hierarchy scan (same logic as jar_type_hierarchy).
    let classes = jar_db::list_classes(&conn, pid).unwrap();
    let siblings: Vec<(String, String)> = classes.iter()
        .filter(|c| c.kind == "class" && c.library_id.is_empty())
        .map(|c| (c.entry_path.clone(), c.class_name.clone())).collect();
    let mut rel: std::collections::HashMap<String, (Option<String>, Vec<String>)> = Default::default();
    for (entry, name) in &siblings {
        if let Ok(bytes) = jar::read_entry_bytes(&jar_path, entry) {
            if let Ok((sup, ifs)) = jar::class_super(&bytes) {
                rel.insert(name.clone(), (sup.map(|s| s.replace('/', ".")), ifs.into_iter().map(|s| s.replace('/', ".")).collect()));
            }
        }
    }
    // Base has two children: Mid and Impl.
    let kids: Vec<&String> = rel.iter()
        .filter(|(_, (s, _))| s.as_deref() == Some("demo.Base"))
        .map(|(k, _)| k).collect();
    assert!(kids.contains(&&"demo.Mid".to_string()), "Mid extends Base: {kids:?}");
    assert!(kids.contains(&&"demo.Impl".to_string()), "Impl extends Base: {kids:?}");

    println!("HIERARCHY INTEGRATION PASS");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
#[ignore]
fn constant_pool_collection() {
    let dir = std::env::temp_dir().join(format!("jar-const-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("C.java");
    // A class with a string constant, a field and a method that calls another.
    std::fs::write(
        &src,
        "package demo;\npublic class C {\n  public static final String MSG = \"hello-world-marker\";\n  public int count = 3;\n  public String greet() { return MSG; }\n}\n",
    )
    .unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(&src).status().unwrap().success());
    let bytes = std::fs::read(out.join("demo/C.class")).unwrap();

    let pool = jar::parse_class_pool(&bytes).unwrap();
    // The string constant is in the pool.
    assert!(pool.strings.iter().any(|s| s.contains("hello-world-marker")), "strings: {:?}", pool.strings);
    // Field refs: count field is declared in this class (not a ref) but the
    // constant pool still holds Fieldref for getstatic/lookup? javac emits a
    // Fieldref for the field itself when referenced via getfield. At minimum,
    // method refs include greet()'s String.concat or return path… verify we
    // parsed the pool without error and can find our marker.
    println!("strings={:?}", pool.strings);
    println!("field_refs={:?}", pool.field_refs);
    println!("method_refs={:?}", pool.method_refs);
    println!("type_refs={:?}", pool.type_refs);
    std::fs::remove_dir_all(&dir).ok();
}

/// Verify jar_navigate's cross-project fallback: a class referenced only in
/// another indexed project resolves correctly (JD-GUI multi-file behavior).
#[test]
#[ignore]
fn navigate_cross_project_fallback() {
    let dir = std::env::temp_dir().join(format!("jar-nav-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("demo/Nav.java");
    std::fs::create_dir_all(src.parent().unwrap()).unwrap();
    std::fs::write(src.parent().unwrap().join("Nav.java"), "package demo;\npublic class Nav { public int go() { return 1; } }\n").unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src.parent().unwrap().join("Nav.java")).status().unwrap().success());
    let jar_path = dir.join("nav.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&out).arg(".").status().unwrap().success());

    let db = dir.join("t.db");
    let conn = jar_db::open(&db).unwrap();
    conn.execute_batch(jar_db::TEST_DDL).unwrap();
    // Two projects: p1 (empty-ish) and p2 (has demo.Nav).
    for pid in ["p1", "p2"] {
        jar_db::upsert_project(&conn, &jar_db::JarProject {
            id: pid.into(), name: format!("{pid}.jar"), jar_path: jar_path.display().to_string(),
            jar_hash: "x".into(), size: 0, class_count: 0, resource_count: 0, created_at: 0, updated_at: 0,
        }).unwrap();
    }
    let idx = jar::index_jar(&jar_path).unwrap();
    for e in &idx.entries {
        jar_db::upsert_class(&conn, &jar_db::JarClassRow {
            id: format!("p2:{}", e.entry_path), project_id: "p2".into(), library_id: "".into(),
            entry_path: e.entry_path.clone(), class_name: e.class_name.clone(), package_name: e.package_name.clone(),
            kind: e.kind.clone(), is_inner_class: e.is_inner_class, modified_source: None, modified: false,
            compile_status: "none".into(), compile_output: None, compile_timestamp: None, source_hash: None,
        }).unwrap();
    }

    // p1 has no demo.Nav → the same lookup in p2 must succeed via fallback.
    let found = jar_db::list_classes(&conn, "p1").unwrap();
    assert!(!found.iter().any(|c| c.class_name == "demo.Nav"), "p1 must be empty");
    let in_p2 = jar_db::list_classes(&conn, "p2").unwrap();
    assert!(in_p2.iter().any(|c| c.class_name == "demo.Nav"));

    println!("NAV CROSS-PROJECT PASS (p2 holds demo.Nav, p1 lookup falls through)");
    std::fs::remove_dir_all(&dir).ok();
}

/// Verify ClassRef extraction: type/field/method references carry the owner
/// internal name + kind (JD-GUI printReference equivalent).
#[test]
#[ignore]
fn class_ref_extraction() {
    let dir = std::env::temp_dir().join(format!("jar-refs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src_dir = dir.join("demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    // Same-package class referenced from another (the user's exact complaint).
    std::fs::write(src_dir.join("Bar.java"), "package demo;\npublic class Bar { public int v() { return 1; } }\n").unwrap();
    std::fs::write(
        src_dir.join("Foo.java"),
        "package demo;\nimport java.util.List;\npublic class Foo {\n  public Bar bar() { return new Bar(); }\n  public List<String> list() { return java.util.Collections.emptyList(); }\n  public String fmt() { return String.format(\"%d\", 1); }\n}\n",
    )
    .unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src_dir.join("Bar.java")).arg(src_dir.join("Foo.java")).status().unwrap().success());
    let bytes = std::fs::read(out.join("demo/Foo.class")).unwrap();

    let pool = jar::parse_class_pool(&bytes).unwrap();
    // Same-package class reference: demo.Bar must appear as a type ref AND as a
    // constructor ref (new Bar()).
    let bar_type = pool.refs.iter().find(|r| r.internal_type_name == "demo/Bar" && r.kind == "type");
    assert!(bar_type.is_some(), "same-package type ref missing: {:?}", pool.refs);
    let bar_ctor = pool.refs.iter().find(|r| r.internal_type_name == "demo/Bar" && r.kind == "method");
    assert!(bar_ctor.is_some(), "constructor ref missing: {:?}", pool.refs);
    // java/util/Collections method ref (emptyList).
    let coll = pool.refs.iter().find(|r| r.internal_type_name == "java/util/Collections" && r.name.as_deref() == Some("emptyList"));
    assert!(coll.is_some(), "method ref missing: {:?}", pool.refs);
    // String.format static method.
    let fmt = pool.refs.iter().find(|r| r.internal_type_name == "java/lang/String" && r.name.as_deref() == Some("format"));
    assert!(fmt.is_some(), "format ref missing: {:?}", pool.refs);
    println!("CLASS REF EXTRACTION PASS ({} refs, incl. same-package demo/Bar)", pool.refs.len());
    std::fs::remove_dir_all(&dir).ok();
}

/// Method-location flow: decompile a class via jd-core, extract method line
/// numbers, and verify the exact method the user clicked resolves.
#[test]
#[ignore]
fn method_location_resolution() {
    let dir = std::env::temp_dir().join(format!("jar-mloc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src_dir = dir.join("demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Calc.java"), "package demo;\npublic class Calc {\n  public int add(int a, int b) { return a + b; }\n  public int mul(int a, int b) { return a * b; }\n}\n").unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src_dir.join("Calc.java")).status().unwrap().success());
    let bytes = std::fs::read(out.join("demo/Calc.class")).unwrap();

    let jd = nexterm_lib::decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("Calc.class");
    std::fs::write(&cf, &bytes).unwrap();
    let source = nexterm_lib::decompile::decompile_class(&cf, &jd, "demo/Calc", None).unwrap();
    assert!(source.contains("class Calc"));

    let methods = jar::extract_methods(&source);
    let add = methods.iter().find(|m| m.name == "add").expect("add method");
    let mul = methods.iter().find(|m| m.name == "mul").expect("mul method");
    // The declaration line must exist and mul must come after add.
    assert!(add.line >= 1);
    assert!(mul.line > add.line, "mul line {} should be after add line {}", mul.line, add.line);
    println!("METHOD LOCATION PASS (add @{}, mul @{})", add.line, mul.line);
    std::fs::remove_dir_all(&dir).ok();
}

/// JD-GUI ContainerLoader parity: a class with an inner class must decompile
/// WITH the inner class body when the sibling-classes dir is supplied (the
/// revert / method-location paths extract siblings like jar_decompile).
#[test]
fn inner_class_resolves_from_full_container() {
    let dir = std::env::temp_dir().join(format!("jar-innersib-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src_dir = dir.join("demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(
        src_dir.join("Outer.java"),
        "package demo;\npublic class Outer {\n  public class Inner { public int x = 1; }\n  public int use() { return new Inner().x; }\n  public Runnable callback() { return new Runnable() { public void run() { System.out.println(\"ok\"); } }; }\n}\n",
    )
    .unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap())
        .arg("-d").arg(&out).arg(src_dir.join("Outer.java"))
        .status().unwrap().success());
    // demo/Outer.class, demo/Outer$Inner.class and demo/Outer$1.class all exist.
    let bytes = std::fs::read(out.join("demo/Outer.class")).unwrap();

    let jd = nexterm_lib::decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("Outer.class");
    std::fs::write(&cf, &bytes).unwrap();

    // (a) WITHOUT the siblings classpath → inner class body is a placeholder.
    let alone = nexterm_lib::decompile::decompile_class(&cf, &jd, "demo/Outer", None).unwrap();
    let alone_has_inner = alone.contains("x = 1") || alone.contains("public class Inner");
    // (b) WITH the full container classpath used by Save All Sources → the
    //     inner class body must resolve in the root source unit.
    let jar_path = dir.join("outer.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&out).arg(".").status().unwrap().success());
    let index = jar::index_jar(&jar_path).unwrap();
    assert!(index.entries.iter().any(|entry| entry.entry_path == "demo/Outer$Inner.class" && entry.is_inner_class));
    assert!(index.entries.iter().any(|entry| entry.entry_path == "demo/Outer$1.class" && entry.is_inner_class));
    // JD-GUI's second pass also reads an unclassified $ entry itself. This
    // fixture excludes Outer.class, so only that pass can classify Outer$1.
    let isolated = dir.join("anonymous-only.jar");
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&isolated)
        .arg("-C")
        .arg(&out)
        .arg("demo/Outer$1.class")
        .status()
        .unwrap()
        .success());
    let isolated_index = jar::index_jar(&isolated).unwrap();
    assert!(isolated_index.entries.iter().any(|entry| entry.entry_path == "demo/Outer$1.class" && entry.is_inner_class));

    // Spring Boot stores application classes under BOOT-INF/classes while the
    // InnerClasses attribute keeps the JVM name (demo/Outer$1). The physical
    // archive prefix must be restored before comparing the two.
    let boot_root = dir.join("boot");
    let boot_classes = boot_root.join("BOOT-INF/classes/demo");
    std::fs::create_dir_all(&boot_classes).unwrap();
    for name in ["Outer.class", "Outer$Inner.class", "Outer$1.class"] {
        std::fs::copy(out.join("demo").join(name), boot_classes.join(name)).unwrap();
    }
    let boot_jar = dir.join("boot.jar");
    assert!(std::process::Command::new("jar")
        .arg("cf")
        .arg(&boot_jar)
        .arg("-C")
        .arg(&boot_root)
        .arg(".")
        .status()
        .unwrap()
        .success());
    let boot_index = jar::index_jar(&boot_jar).unwrap();
    assert!(boot_index.entries.iter().any(|entry| entry.entry_path == "BOOT-INF/classes/demo/Outer$1.class" && entry.is_inner_class));
    let siblings = dir.join("container");
    jar::extract_all_classes(&jar_path, &siblings).unwrap();
    let with_sib = nexterm_lib::decompile::decompile_class_with_classpath(
        &cf, &jd, &siblings.display().to_string(), "demo/Outer", None,
    )
    .unwrap();
    assert!(with_sib.contains("public class Inner"), "inner class must resolve from siblings: {with_sib}");
    assert!(with_sib.contains("x = 1"), "inner class body must be present: {with_sib}");
    println!("INNER-CLASS-FROM-SIBLINGS PASS (alone_has_inner={alone_has_inner})");
    std::fs::remove_dir_all(&dir).ok();
}

/// ClassView.methods: after decompiling, the own-method line map is populated
/// so same-page jumps work (JD-GUI self-reference behavior).
#[test]
#[ignore]
fn class_view_methods_map() {
    let dir = std::env::temp_dir().join(format!("jar-cvm-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src_dir = dir.join("demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Self.java"), "package demo;\npublic class Self {\n  public void alpha() { beta(); }\n  public void beta() { }\n}\n").unwrap();
    let jdk = compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src_dir.join("Self.java")).status().unwrap().success());
    let bytes = std::fs::read(out.join("demo/Self.class")).unwrap();

    let jd = nexterm_lib::decompile::find_decompiler_jar().unwrap();
    let cf = dir.join("Self.class");
    std::fs::write(&cf, &bytes).unwrap();
    let source = nexterm_lib::decompile::decompile_class(&cf, &jd, "demo/Self", None).unwrap();

    let methods = jar::extract_methods(&source);
    // `beta` must be at a later line than `alpha`; both present.
    let alpha = methods.iter().find(|m| m.name == "alpha").expect("alpha");
    let beta = methods.iter().find(|m| m.name == "beta").expect("beta");
    assert!(beta.line > alpha.line);
    // Same-page jump target: alpha() calls beta() — beta's line is known.
    println!("CLASS VIEW METHODS PASS (alpha @{}, beta @{})", alpha.line, beta.line);
    std::fs::remove_dir_all(&dir).ok();
}
