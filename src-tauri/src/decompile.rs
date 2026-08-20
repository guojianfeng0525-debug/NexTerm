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
    // Bundled via Tauri `bundle.resources`: <exe_dir>/cfr/cfr-0.152.jar
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
    // Dev fallback: repo-relative (cwd = project root) or src-tauri-relative
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
    Err("CFR jar not found. Expected cfr/cfr-0.152.jar bundled with the app or src-tauri/resources/cfr/cfr-0.152.jar in dev.".into())
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
}
