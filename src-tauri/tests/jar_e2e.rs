//! End-to-end JAR decompiler integration test.
//!
//! Builds a real JAR with javac, then exercises the full pipeline through the
//! backend modules directly:
//!   index → decompile (CFR) → modify source → save → compile → rebuild →
//!   verify original JAR untouched.
//!
//! Run: cargo test --test jar_e2e -- --ignored --nocapture
use std::collections::HashMap;

use nexterm_lib::builder;
use nexterm_lib::compile;
use nexterm_lib::decompile;
use nexterm_lib::jar;

fn run(cmd: &mut std::process::Command) -> std::process::Output {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("run command")
}

#[test]
#[ignore]
fn full_pipeline() {
    // ── Setup: build a real JAR with two classes. ──
    let dir = std::env::temp_dir().join(format!("jar-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src_dir = dir.join("src/com/demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(
        src_dir.join("Greeter.java"),
        "package com.demo;\npublic class Greeter {\n  private String prefix = \"Hello\";\n  public String greet(String name) {\n    return prefix + \", \" + name + \"!\";\n  }\n}\n",
    )
    .unwrap();
    std::fs::write(
        src_dir.join("Util.java"),
        "package com.demo;\npublic class Util {\n  public static int add(int a, int b) { return a + b; }\n}\n",
    )
    .unwrap();

    let jdk = compile::detect_jdk();
    assert!(jdk.found, "JDK required for e2e test");
    let javac = jdk.javac_path.unwrap();

    let out_dir = dir.join("classes");
    std::fs::create_dir_all(&out_dir).unwrap();
    let status = run(std::process::Command::new(&javac)
        .arg("-d")
        .arg(&out_dir)
        .arg(src_dir.join("Greeter.java"))
        .arg(src_dir.join("Util.java")))
    .status;
    assert!(status.success(), "javac failed");

    // Pack the JAR (include a resource + META-INF).
    let jar_path = dir.join("demo.jar");
    let jar_status = run(std::process::Command::new("jar")
        .arg("cf")
        .arg(&jar_path)
        .arg("-C")
        .arg(&out_dir)
        .arg("."));
    assert!(jar_status.status.success(), "jar failed");
    // ── 1) Index. ──
    let idx = jar::index_jar(&jar_path).unwrap();
    assert_eq!(idx.class_count, 2);
    assert!(idx
        .entries
        .iter()
        .any(|e| e.entry_path == "com/demo/Greeter.class"));

    // ── 2) Decompile Greeter with CFR. ──
    let jd = decompile::find_decompiler_jar().unwrap();
    let class_bytes = jar::read_entry_bytes(&jar_path, "com/demo/Greeter.class").unwrap();
    let scratch = dir.join("decomp");
    std::fs::create_dir_all(&scratch).unwrap();
    let class_file = scratch.join("Greeter.class");
    std::fs::write(&class_file, &class_bytes).unwrap();
    let source = decompile::decompile_class(&class_file, &jd, "com/demo/Greeter", None).unwrap();
    assert!(source.contains("class Greeter"), "decompiled: {source}");
    assert!(source.contains("greet"), "decompiled: {source}");

    // ── 3) Modify the source: change "Hello" → "Hi" and add a method. ──
    // CFR may rename params (name → string) and emit `this.prefix`, so match
    // loosely on stable substrings.
    let modified = source
        .replace("\"Hello\"", "\"Hi\"")
        .replace("public String greet(", "public String greet2(")
        .replace("+ \", \" + ", "+ \"~\" + ");

    // ── 4) Compile the modified source with the original jar on classpath. ──
    let comp_dir = dir.join("compile");
    let result = compile::compile_sources(
        &javac,
        &[("com/demo/Greeter.java".to_string(), modified.clone())],
        Some(&jar_path.display().to_string()),
        &comp_dir,
    )
    .unwrap();
    assert!(
        result.success,
        "modified compile failed: {:?}",
        result.diagnostics
    );
    let greeter_class = result
        .classes
        .iter()
        .find(|(p, _)| p == "com/demo/Greeter.class")
        .expect("Greeter.class compiled")
        .1
        .clone();

    // ── 5) Rebuild the JAR. ──
    let out_jar = dir.join("demo-modified.jar");
    let mut overrides = HashMap::new();
    overrides.insert("com/demo/Greeter.class".to_string(), greeter_class);
    builder::build_jar(&jar_path, &overrides, &[], &[], &out_jar).unwrap();

    // ── 6) Verify: original JAR untouched, new JAR has modified class. ──
    let orig_greeter = jar::read_entry_bytes(&jar_path, "com/demo/Greeter.class").unwrap();
    let new_greeter = jar::read_entry_bytes(&out_jar, "com/demo/Greeter.class").unwrap();
    assert_ne!(
        orig_greeter, new_greeter,
        "class should differ after modification"
    );
    // Util unchanged.
    let orig_util = jar::read_entry_bytes(&jar_path, "com/demo/Util.class").unwrap();
    let new_util = jar::read_entry_bytes(&out_jar, "com/demo/Util.class").unwrap();
    assert_eq!(
        orig_util, new_util,
        "unmodified class must be byte-identical"
    );

    // ── 7) Decompile the rebuilt class → confirm modification persisted. ──
    let new_class_file = scratch.join("GreeterNew.class");
    std::fs::write(&new_class_file, &new_greeter).unwrap();
    let redec = decompile::decompile_class(&new_class_file, &jd, "com/demo/Greeter", None).unwrap();
    assert!(
        redec.contains("\"Hi\""),
        "modified value not in re-decompiled: {redec}"
    );
    assert!(redec.contains("greet2"), "added method missing: {redec}");

    std::fs::remove_dir_all(&dir).ok();
    println!("E2E PASS");
}
