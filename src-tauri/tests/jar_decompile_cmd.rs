//! Simulates the exact `jar_decompile` command flow (index → read bytes →
//! magic check → jd-core → ClassView) against a real JAR, including the
//! scratch-directory file naming used by the command layer and the
//! JD-GUI preference overrides (escapeUnicode / realign).
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use nexterm_lib::{decompile, jar};

#[test]
#[ignore]
fn decompile_command_flow() {
    let dir = std::env::temp_dir().join(format!("jar-cmd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Build a real jar.
    let src_dir = dir.join("src/demo");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Test.java"), "package demo;\npublic class Test { public String msg() { return \"你好\"; } }\n").unwrap();
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

    // Decompile with display defaults (JD-GUI ClassFilePage: escapeUnicode=false, realign=false).
    let jd = decompile::find_decompiler_jar().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let source = decompile::decompile_class(&class_file, &jd, "demo/Test", Some(cancel)).unwrap();
    assert!(source.contains("class Test"), "source: {source}");
    assert!(source.contains("msg"), "source: {source}");
    println!("DECOMPILE CMD FLOW PASS; source={} chars", source.len());

    // Preferences override: escapeUnicode=true must produce \uXXXX escapes.
    let opts = decompile::DecompileOptions { escape_unicode: true, realign: true, line_numbers: false };
    let esc = decompile::decompile_class_with_options(&class_file, &jd, "", "demo/Test", opts, None).unwrap();
    assert!(!esc.contains("你好"), "escapeUnicode=true must escape non-ASCII: {esc}");
    assert!(esc.contains("\\u4F60\\u597D"), "escapeUnicode=true should emit \\u4F60\\u597D: {esc}");
    println!("ESCAPE-UNICODE PREF PASS");

    std::fs::remove_dir_all(&dir).ok();
}
