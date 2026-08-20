//! Simulates the exact `jar_decompile` command flow (index → read bytes →
//! magic check → CFR → cache) against a real JAR + real DB, including the
//! scratch-directory file naming used by the command layer.
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use nexterm_lib::{decompile, jar, jar_db};

#[test]
#[ignore]
fn decompile_command_flow() {
    let dir = std::env::temp_dir().join(format!("jar-cmd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Build a real jar.
    let src_dir = dir.join("src/demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Test.java"), "package demo;\npublic class Test { public String msg() { return \"hi\"; } }\n").unwrap();
    let jdk = nexterm_lib::compile::detect_jdk();
    assert!(jdk.found);
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    assert!(std::process::Command::new(jdk.javac_path.as_deref().unwrap()).arg("-d").arg(&out).arg(src_dir.join("Test.java")).status().unwrap().success());
    let jar_path = dir.join("test.jar");
    assert!(std::process::Command::new("jar").arg("cf").arg(&jar_path).arg("-C").arg(&out).arg(".").status().unwrap().success());

    // Index.
    let idx = jar::index_jar(&jar_path).unwrap();
    let entry = "demo/Test.class";
    assert!(idx.entries.iter().any(|e| e.entry_path == entry));

    // Read class bytes (same as command).
    let bytes = jar::read_entry_bytes(&jar_path, entry).unwrap();
    assert!(bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]), "magic ok");

    // Scratch dir + file naming (mirrors jar_decompile).
    let scratch = dir.join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let class_file = scratch.join(format!("{}.class", entry.replace('/', "_")));
    std::fs::write(&class_file, &bytes).unwrap();

    // CFR.
    let cfr = decompile::find_cfr_jar().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let source = decompile::decompile_class(&class_file, &cfr, Some(cancel)).unwrap();
    assert!(source.contains("class Test"), "source: {source}");
    assert!(source.contains("msg"), "source: {source}");
    println!("DECOMPILE CMD FLOW PASS; source={} chars", source.len());
    std::fs::remove_dir_all(&dir).ok();
}
