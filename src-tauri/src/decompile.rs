//! CFR-based decompilation.
//!
//! Runs `java -jar cfr.jar <class>` as a subprocess and captures the
//! decompiled Java source. Classes are decompiled lazily on demand; results
//! are cached by the caller (SQLite). Decompilation is cancellable via the
//! returned child handle.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Locate the bundled CFR jar. Search order:
/// 1. Explicit path override (e.g. configured in settings)
/// 2. `resources/cfr/cfr-0.152.jar` next to the executable
/// 3. `src-tauri/resources/cfr/cfr-0.152.jar` in dev (cwd-relative fallback)
pub fn find_cfr_jar() -> Result<std::path::PathBuf, String> {
    find_cfr_jar_with(None)
}

/// Locate the bundled CFR jar. `resource_dir` is the Tauri resource directory
/// (Windows exe layout puts bundled resources there). Falls back to scanning
/// exe-adjacent + dev paths so it works in dev, tests, and packaged builds.
pub fn find_cfr_jar_with(resource_dir: Option<&std::path::Path>) -> Result<std::path::PathBuf, String> {
    // 1) Tauri resource dir (most reliable across installers & portable exe).
    if let Some(rd) = resource_dir {
        let direct = rd.join("cfr/cfr-0.152.jar");
        if direct.is_file() {
            return Ok(direct);
        }
        // Some bundlers nest resources one level deeper (e.g. under _up_/).
        if let Ok(entries) = std::fs::read_dir(rd) {
            for e in entries.flatten() {
                let p = e.path().join("cfr/cfr-0.152.jar");
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
    }
    // 2) Bundled via Tauri `bundle.resources`: <exe_dir>/cfr/cfr-0.152.jar
    if let Ok(exe) = std::env::current_exe() {
        let exe_dir = exe.parent().unwrap_or(Path::new("."));
        let candidates = [
            exe_dir.join("cfr/cfr-0.152.jar"),
            exe_dir.join("../cfr/cfr-0.152.jar"),
            exe_dir.join("resources/cfr/cfr-0.152.jar"),
        ];
        for c in &candidates {
            if c.is_file() {
                return Ok(c.clone());
            }
        }
    }
    // 3) Dev fallback: repo-relative (cwd = project root) or src-tauri-relative
    // (cwd = src-tauri, e.g. `cargo test`).
    let dev_candidates = [
        Path::new("src-tauri/resources/cfr/cfr-0.152.jar"),
        Path::new("resources/cfr/cfr-0.152.jar"),
        Path::new("../src-tauri/resources/cfr/cfr-0.152.jar"),
    ];
    for c in &dev_candidates {
        if c.is_file() {
            return Ok(c.to_path_buf());
        }
    }
    // 4) Embedded CFR jar: the jar is compiled INTO the executable via
    //    include_bytes!, so packaged builds never depend on external files.
    extract_embedded_cfr()
}

/// The bundled CFR jar, embedded at compile time. 2.1 MB — acceptable binary
/// bloat for a self-contained portable exe (no external jar to ship/lose).
const EMBEDDED_CFR_JAR: &[u8] = include_bytes!("../resources/cfr/cfr-0.152.jar");

/// Write the embedded jar to a cache path under the system temp dir and return
/// it. Reuses the cached file (same byte length) so we only write once.
fn extract_embedded_cfr() -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("nexterm-cfr");
    let path = dir.join("cfr-0.152.jar");
    if path.is_file() {
        // Reuse if the cached copy matches the embedded size (cheap sanity).
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() == EMBEDDED_CFR_JAR.len() as u64 {
                return Ok(path);
            }
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cfr cache dir: {e}"))?;
    std::fs::write(&path, EMBEDDED_CFR_JAR).map_err(|e| format!("write embedded cfr jar: {e}"))?;
    Ok(path)
}

/// Find `java` (needed to run CFR). Prefer JAVA_HOME, then PATH.
pub fn find_java() -> Result<std::path::PathBuf, String> {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.is_empty() {
            let j = std::path::PathBuf::from(&home).join("bin").join("java");
            if j.is_file() {
                return Ok(j);
            }
            let jw = std::path::PathBuf::from(&home).join("bin").join("java.exe");
            if jw.is_file() {
                return Ok(jw);
            }
        }
    }
    // PATH lookup via `java` — rely on Command resolving PATH (GUI apps on
    // macOS include /usr/bin which has java).
    let path_java = std::path::PathBuf::from("java");
    if command_exists(&path_java) {
        return Ok(path_java);
    }
    // Fallback 1: java next to javac (same JDK).
    let jdk = crate::compile::detect_jdk();
    if let Some(javac_path) = jdk.javac_path {
        if let Some(bin) = std::path::Path::new(&javac_path).parent() {
            let j = bin.join(if cfg!(windows) { "java.exe" } else { "java" });
            if j.is_file() {
                return Ok(j);
            }
        }
    }
    // Fallback 2: well-known system paths.
    for cand in [
        "/usr/bin/java",
        "/usr/local/bin/java",
        "/opt/homebrew/bin/java",
        "/usr/lib/jvm/default-java/bin/java",
    ] {
        let p = std::path::PathBuf::from(cand);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("java not found. Install a JDK (or set JAVA_HOME) to decompile classes.".into())
}

/// Check whether `cmd` resolves to something runnable via PATH (like `which`).
fn command_exists(cmd: &std::path::Path) -> bool {
    if cmd.is_file() {
        return true;
    }
    // Relative name: search PATH.
    if cmd.components().count() == 1 {
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let cand = dir.join(cmd);
                if cand.is_file() {
                    return true;
                }
            }
        }
    }
    false
}

/// Test-only alias to probe java resolution.
pub fn find_java_public() -> Result<std::path::PathBuf, String> {
    find_java()
}

/// Run CFR on one .class file; return decompiled source.
///
/// `class_file` — path to the .class file (written to a temp dir by caller).
/// `cancel` — when set, the subprocess is killed.
pub fn decompile_class(
    class_file: &Path,
    cfr_jar: &Path,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<String, String> {
    let java = find_java()?;
    let mut cmd = Command::new(&java);
    cmd.arg("-jar")
        .arg(cfr_jar)
        .arg(class_file)
        .arg("--comments")
        .arg("false")
        .arg("--extraclasspath")
        .arg("")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch java (CFR): {e}"))?;

    // If a cancel flag is set, spawn a watcher that kills the child.
    if let Some(cancel) = cancel {
        let pid = child.id();
        std::thread::spawn(move || {
            let mut waited = false;
            for _ in 0..1200 {
                if cancel.load(Ordering::Relaxed) {
                    // Kill on all platforms.
                    let _ = kill_process(pid);
                    waited = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if !waited {
                // Also stop watching if the process would outlive us (60s cap).
                let _ = kill_process(pid);
            }
        });
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed waiting for CFR: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if !output.status.success() {
        return Err(format!(
            "CFR decompilation failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    if stdout.trim().is_empty() {
        // CFR often exits 0 even on failure, printing the reason to stderr.
        let detail = if stderr.trim().is_empty() {
            "(no stderr)".to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "CFR produced no output for {} — the class may be corrupt, or java could not run CFR. {detail}",
            class_file.display()
        ));
    }
    Ok(stdout)
}

#[cfg(unix)]
fn kill_process(pid: u32) -> Result<(), String> {
    // SAFETY: libc kill with SIGKILL.
    let rc = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("kill failed rc={rc}"))
    }
}

#[cfg(windows)]
fn kill_process(pid: u32) -> Result<(), String> {
    // taskkill /F /PID <pid>
    let out = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("taskkill: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err("taskkill failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfr_jar_is_present() {
        let jar = find_cfr_jar();
        assert!(jar.is_ok(), "CFR jar should be bundled: {:?}", jar.err());
    }

    #[test]
    fn java_is_available() {
        let java = find_java();
        assert!(java.is_ok(), "java should be available to run CFR");
    }

    /// End-to-end: compile a tiny class, decompile it, check output contains
    /// the method. Requires JDK (skipped when absent).
    #[test]
    fn decompile_smoke() {
        let jdk = crate::compile::detect_jdk();
        if !jdk.found {
            eprintln!("skipping: no javac");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("jar-decomp-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("Hello.java");
        std::fs::write(
            &src,
            "public class Hello { public String hi() { return \"world\"; } }",
        )
        .unwrap();
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let status = std::process::Command::new(jdk.javac_path.as_deref().unwrap())
            .arg("-d")
            .arg(&out)
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());

        let class = out.join("Hello.class");
        let cfr = find_cfr_jar().unwrap();
        let source = decompile_class(&class, &cfr, None).unwrap();
        assert!(source.contains("public class Hello"), "source: {source}");
        assert!(source.contains("hi"), "should contain method hi: {source}");
        std::fs::remove_dir_all(&tmp).ok();
    }
    #[test]
    fn embedded_cfr_extracts_to_cache() {
        // Simulate a packaged build: no external jar anywhere → the embedded
        // bytes must produce a usable jar via the temp-dir cache.
        let path = extract_embedded_cfr().expect("embedded cfr extraction");
        assert!(path.is_file(), "extracted jar must exist");
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), EMBEDDED_CFR_JAR.len() as u64);
        // Second call reuses the cache.
        let path2 = extract_embedded_cfr().unwrap();
        assert_eq!(path, path2);
    }

}
