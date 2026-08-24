//! javac discovery and compilation.
//!
//! Detects the JDK (PATH or JAVA_HOME), compiles modified Java sources, and
//! parses javac diagnostics into structured error/warning lists. Compiled
//! `.class` bytes are returned to the caller for persistence — the original
//! JAR is never touched.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Result of JDK detection.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JdkInfo {
    pub found: bool,
    pub javac_path: Option<String>,
    pub java_version: Option<String>,
    pub java_home: Option<String>,
    pub error: Option<String>,
}

/// One javac diagnostic.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileDiagnostic {
    pub file: String,
    pub line: i64,
    pub column: i64,
    pub level: String, // "error" | "warning"
    pub message: String,
}

/// Compile result for a set of sources.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub success: bool,
    pub diagnostics: Vec<CompileDiagnostic>,
    /// Compiled .class files: (relative class path, bytes) on success.
    pub classes: Vec<(String, Vec<u8>)>,
    pub javac_path: String,
}

/// Locate javac: JAVA_HOME/bin/javac first, then PATH.
pub fn detect_jdk() -> JdkInfo {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.is_empty() {
            let home = PathBuf::from(home);
            candidates.push(home.join("bin").join("javac"));
            #[cfg(windows)]
            candidates.push(home.join("bin").join("javac.exe"));
        }
    }
    candidates.push(PathBuf::from("javac"));

    for cand in &candidates {
        if let Ok(output) = Command::new(cand).arg("-version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let home = if cand
                    .file_name()
                    .map(|n| n == "javac" || n == "javac.exe")
                    .unwrap_or(false)
                    && std::env::var("JAVA_HOME")
                        .map(|h| !h.is_empty())
                        .unwrap_or(false)
                {
                    std::env::var("JAVA_HOME").ok()
                } else if cand
                    .file_name()
                    .map(|n| n == "javac" || n == "javac.exe")
                    .unwrap_or(false)
                {
                    // Derive home from javac path: bin/javac → up two.
                    cand.parent()
                        .and_then(|bin| bin.parent())
                        .map(|p| p.display().to_string())
                } else {
                    None
                };
                return JdkInfo {
                    found: true,
                    javac_path: Some(cand.display().to_string()),
                    java_version: Some(version),
                    java_home: home,
                    error: None,
                };
            }
        }
    }
    JdkInfo {
        found: false,
        javac_path: None,
        java_version: None,
        java_home: std::env::var("JAVA_HOME").ok().filter(|h| !h.is_empty()),
        error: Some(
            "javac not found. Install a JDK (or set JAVA_HOME) to compile modified sources.".into(),
        ),
    }
}

/// Parse javac stderr lines like:
///   path/File.java:12: error: cannot find symbol
///   path/File.java:5: warning: [deprecation] Foo in Bar has been deprecated
fn parse_diagnostics(stderr: &str, base_dir: &Path) -> Vec<CompileDiagnostic> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let line = line.trim();
        // Pattern: <file>:<line>: <level>: <message>   or   <file>:<line>:<col>: <level>: <message>
        let re = regex::Regex::new(
            r#"^(?P<file>[^:]+):(?P<line>\d+)(?::(?P<col>\d+))?:\s*(?P<level>error|warning):\s*(?P<msg>.+)$"#,
        )
        .unwrap();
        if let Some(caps) = re.captures(line) {
            let file = caps.name("file").unwrap().as_str().to_string();
            // Resolve relative to base dir for display.
            let display = Path::new(&file)
                .strip_prefix(base_dir)
                .unwrap_or(Path::new(&file))
                .display()
                .to_string();
            out.push(CompileDiagnostic {
                file: display,
                line: caps.name("line").unwrap().as_str().parse().unwrap_or(0),
                column: caps
                    .name("col")
                    .map(|c| c.as_str().parse().unwrap_or(0))
                    .unwrap_or(0),
                level: caps.name("level").unwrap().as_str().to_string(),
                message: caps.name("msg").unwrap().as_str().to_string(),
            });
        }
    }
    out
}

/// Compile one or more sources.
///
/// `sources`: map of relative source path → content, e.g. "com/example/Foo.java".
/// `classpath`: optional extra classpath (original JAR) for dependencies.
/// Returns compiled .class entries with their JAR-relative paths.
pub fn compile_sources(
    javac: &str,
    sources: &[(String, String)],
    classpath: Option<&str>,
    tmp_root: &Path,
) -> Result<CompileResult, String> {
    // Write sources into tmp_root preserving package structure.
    let src_dir = tmp_root.join("src");
    let out_dir = tmp_root.join("out");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("mk src dir: {e}"))?;
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mk out dir: {e}"))?;

    let mut file_paths: Vec<PathBuf> = Vec::new();
    for (rel, content) in sources {
        let p = src_dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mk dir {}: {e}", parent.display()))?;
        }
        std::fs::write(&p, content).map_err(|e| format!("write {}: {e}", p.display()))?;
        file_paths.push(p);
    }

    // javac -encoding UTF-8 -d out <files> (-classpath original.jar)
    // Force English diagnostics so error parsing is locale-independent.
    let mut cmd = Command::new(javac);
    cmd.arg("-J-Duser.language=en")
        .arg("-J-Duser.country=US")
        .arg("-encoding")
        .arg("UTF-8");
    cmd.arg("-d").arg(&out_dir);
    if let Some(cp) = classpath {
        cmd.arg("-classpath").arg(cp);
    }
    cmd.args(&file_paths);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to run javac ({javac}): {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let diagnostics = parse_diagnostics(&stderr, &src_dir);

    if !output.status.success() {
        return Ok(CompileResult {
            success: false,
            diagnostics,
            classes: Vec::new(),
            javac_path: javac.to_string(),
        });
    }

    // Collect compiled .class files from out_dir.
    let mut classes: Vec<(String, Vec<u8>)> = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    walk(&p, root, out);
                } else if p.extension().map(|e| e == "class").unwrap_or(false) {
                    let rel = p.strip_prefix(root).unwrap_or(&p).display().to_string();
                    if let Ok(bytes) = std::fs::read(&p) {
                        out.push((rel, bytes));
                    }
                }
            }
        }
    }
    walk(&out_dir, &out_dir, &mut classes);
    classes.sort_by(|a, b| a.0.cmp(&b.0));

    Ok(CompileResult {
        success: true,
        diagnostics,
        classes,
        javac_path: javac.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_diagnostics_formats() {
        let base = std::path::Path::new("/work");
        let errs = parse_diagnostics(
            "/work/src/com/example/Foo.java:12: error: cannot find symbol\n\
             /work/src/com/example/Foo.java:5:7: warning: [deprecation] Foo in Bar has been deprecated\n\
             /work/src/com/example/Foo.java:9: error: ';' expected",
            base,
        );
        assert_eq!(errs.len(), 3);
        assert_eq!(errs[0].level, "error");
        assert_eq!(errs[0].line, 12);
        assert_eq!(errs[1].level, "warning");
        assert_eq!(errs[1].column, 7);
        assert_eq!(errs[2].line, 9);
    }

    #[test]
    fn detect_jdk_finds_javac() {
        let info = detect_jdk();
        // The dev machine has JDK 17; CI may not. Only assert consistency:
        if info.found {
            assert!(info.javac_path.is_some());
            assert!(info.java_version.is_some());
        }
    }

    #[test]
    fn compile_valid_and_invalid() {
        let info = detect_jdk();
        if !info.found {
            eprintln!("skipping: no javac");
            return;
        }
        let javac = info.javac_path.unwrap();
        let tmp = std::env::temp_dir().join(format!("jar-compile-test-{}", std::process::id()));
        // Valid source.
        let ok = compile_sources(
            &javac,
            &[(
                "com/example/Hello.java".into(),
                "package com.example; public class Hello { public int add(int a, int b) { return a + b; } }".into(),
            )],
            None,
            &tmp,
        )
        .unwrap();
        assert!(ok.success, "compile should succeed: {:?}", ok.diagnostics);
        assert!(ok
            .classes
            .iter()
            .any(|(p, _)| p == "com/example/Hello.class"));

        // Invalid source → error diagnostics, no classes.
        let bad = compile_sources(
            &javac,
            &[(
                "com/example/Bad.java".into(),
                "package com.example; public class Bad { public int f( { }".into(),
            )],
            None,
            &tmp,
        )
        .unwrap();
        assert!(!bad.success);
        assert!(bad.diagnostics.iter().any(|d| d.level == "error"));
        assert!(bad.classes.is_empty());

        std::fs::remove_dir_all(&tmp).ok();
    }
}
