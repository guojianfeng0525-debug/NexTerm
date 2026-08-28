//! jd-core-based decompilation — the exact engine JD-GUI 1.6.6 is built on.
//!
//! Runs `java -jar jdcore-wrapper.jar <class> --internal-name <name>
//! --classpath <dir> ...` as a subprocess and captures the decompiled Java
//! source. The wrapper (scripts/jdcore-wrapper/JdCoreDecompiler.java) is a
//! thin CLI around org.jd.core 1.1.3 whose printer is a faithful port of
//! JD-GUI's StringBuilderPrinter / LineNumberStringBuilderPrinter, so output
//! matches JD-GUI (tab = two spaces, unicode escape off by default, `/* n */`
//! line prefixes when requested).
//!
//! Classes are decompiled lazily on demand; results are cached by the caller
//! (SQLite). Decompilation is cancellable via the returned child handle.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Locate the bundled jd-core wrapper jar.
pub fn find_decompiler_jar() -> Result<std::path::PathBuf, String> {
    find_decompiler_jar_with(None)
}

/// Locate the bundled jd-core wrapper jar. `resource_dir` is the Tauri
/// resource directory (Windows exe layout puts bundled resources there).
/// Falls back to scanning exe-adjacent + dev paths so it works in dev, tests,
/// and packaged builds.
pub fn find_decompiler_jar_with(resource_dir: Option<&Path>) -> Result<std::path::PathBuf, String> {
    // 1) Tauri resource dir (most reliable across installers & portable exe).
    if let Some(rd) = resource_dir {
        let direct = rd.join("jdcore/jdcore-wrapper.jar");
        if direct.is_file() {
            return Ok(direct);
        }
        // Some bundlers nest resources one level deeper (e.g. under _up_/).
        if let Ok(entries) = std::fs::read_dir(rd) {
            for e in entries.flatten() {
                let p = e.path().join("jdcore/jdcore-wrapper.jar");
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
    }
    // 2) Bundled via Tauri `bundle.resources`: <exe_dir>/jdcore/jdcore-wrapper.jar
    if let Ok(exe) = std::env::current_exe() {
        let exe_dir = exe.parent().unwrap_or(Path::new("."));
        let candidates = [
            exe_dir.join("jdcore/jdcore-wrapper.jar"),
            exe_dir.join("../jdcore/jdcore-wrapper.jar"),
            exe_dir.join("resources/jdcore/jdcore-wrapper.jar"),
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
        Path::new("src-tauri/resources/jdcore/jdcore-wrapper.jar"),
        Path::new("resources/jdcore/jdcore-wrapper.jar"),
        Path::new("../src-tauri/resources/jdcore/jdcore-wrapper.jar"),
    ];
    for c in &dev_candidates {
        if c.is_file() {
            return Ok(c.to_path_buf());
        }
    }
    // 4) Embedded wrapper jar: compiled INTO the executable via include_bytes!,
    //    so packaged builds never depend on external files.
    extract_embedded_jd()
}

/// The bundled jd-core wrapper jar, embedded at compile time. ~730 KB —
/// acceptable binary bloat for a self-contained portable exe.
const EMBEDDED_JD_JAR: &[u8] = include_bytes!("../resources/jdcore/jdcore-wrapper.jar");

/// Write the embedded jar to a cache path under the system temp dir and return
/// it. Reuses the cached file (same byte length) so we only write once.
fn extract_embedded_jd() -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("nexterm-jdcore");
    let path = dir.join("jdcore-wrapper.jar");
    if path.is_file() {
        // Reuse if the cached copy matches the embedded size (cheap sanity).
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() == EMBEDDED_JD_JAR.len() as u64 {
                return Ok(path);
            }
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create jdcore cache dir: {e}"))?;
    std::fs::write(&path, EMBEDDED_JD_JAR)
        .map_err(|e| format!("write embedded jdcore jar: {e}"))?;
    Ok(path)
}

/// Find `java` (needed to run jd-core). Prefer JAVA_HOME, then PATH.
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

/// Decompiler options mirroring JD-GUI preferences:
/// - `escape_unicode`: ClassFileDecompilerPreferences.escapeUnicodeCharacters
/// - `realign`:        ClassFileDecompilerPreferences.realignLineNumbers
/// - `line_numbers`:   ClassFileSaverPreferences.writeLineNumbers
#[derive(Clone, Copy, Debug)]
pub struct DecompileOptions {
    pub escape_unicode: bool,
    pub realign: bool,
    pub line_numbers: bool,
}

impl Default for DecompileOptions {
    fn default() -> Self {
        // JD-GUI ClassFilePage display defaults.
        DecompileOptions {
            escape_unicode: false,
            realign: false,
            line_numbers: false,
        }
    }
}

impl DecompileOptions {
    /// JD-GUI ClassFileSourceSaverProvider "Save All Sources" defaults.
    pub fn saver() -> Self {
        DecompileOptions {
            escape_unicode: false,
            realign: true,
            line_numbers: true,
        }
    }
}

/// Run jd-core on one .class file; return decompiled source.
///
/// `class_file` — path to the .class file (written to a temp dir by caller).
/// `internal_name` — the class's internal name (`demo/Full`), i.e. the jar
///   entry path minus `.class`. jd-core keys loader lookups on it, exactly
///   like JD-GUI's ClassFilePage passes the entry internal name.
/// `cancel` — when set, the subprocess is killed.
pub fn decompile_class(
    class_file: &Path,
    decompiler_jar: &Path,
    internal_name: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<DecompileResult, String> {
    decompile_class_with_options(
        class_file,
        decompiler_jar,
        "",
        internal_name,
        DecompileOptions::default(),
        cancel,
    )
}

/// Like `decompile_class` but lets the caller supply a sibling-classes dir
/// (JD-GUI ContainerLoader: same-package/inner classes resolve from there).
pub fn decompile_class_with_classpath(
    class_file: &Path,
    decompiler_jar: &Path,
    classpath: &str,
    internal_name: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<DecompileResult, String> {
    decompile_class_with_options(
        class_file,
        decompiler_jar,
        classpath,
        internal_name,
        DecompileOptions::default(),
        cancel,
    )
}

/// Result of a jd-core run: the source text plus JD-GUI-style position-bound
/// references (JDREFS emitted by the wrapper's printer on stderr).
#[derive(Debug, Clone)]
pub struct DecompileResult {
    pub source: String,
    pub refs: Vec<crate::jar::ClassRef>,
}

/// Test/call-site convenience: treat the result as its source text
/// (`.contains()`, `.len()`, `format!("{}")`, ...) like the old String return.
impl std::ops::Deref for DecompileResult {
    type Target = str;
    fn deref(&self) -> &str {
        &self.source
    }
}
impl std::fmt::Display for DecompileResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.source)
    }
}

/// Parse a JSON string literal emitted by the wrapper (quotes stripped,
/// escapes decoded); "null" → empty.
fn json_str(raw: &str) -> String {
    if raw.trim() == "null" {
        return String::new();
    }
    let s = raw.trim();
    let s = s
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(s);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(cp) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(cp) {
                            out.push(ch);
                        }
                    }
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn opt_json_str(raw: Option<&str>) -> Option<String> {
    let v = json_str(raw.unwrap_or("null"));
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Parse the wrapper's JDREFS lines (jd-core Printer type constants:
/// TYPE=1, FIELD=2, METHOD=3, CONSTRUCTOR=4) into position-bound refs.
fn parse_jdrefs(stderr: &str) -> Vec<crate::jar::ClassRef> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("JDREFS\t") else {
            continue;
        };
        let parts: Vec<&str> = rest.split('\t').collect();
        if parts.len() < 6 {
            continue;
        }
        let offset = json_str(parts[0]).parse::<usize>().unwrap_or(0);
        let len = json_str(parts[1]).parse::<usize>().unwrap_or(0);
        let kind = match parts[2] {
            "1" => "type",
            "2" => "field",
            "3" => "method",
            "4" => "constructor",
            _ => "type",
        };
        let internal_type_name = json_str(parts[3]);
        if internal_type_name.is_empty() {
            continue;
        }
        let name = opt_json_str(parts.get(4).copied());
        let descriptor = opt_json_str(parts.get(5).copied());
        let owner = opt_json_str(parts.get(6).copied());
        out.push(crate::jar::ClassRef {
            internal_type_name,
            name,
            kind: kind.to_string(),
            descriptor,
            owner,
            offset,
            len,
        });
    }
    out
}

/// Full control over jd-core invocation (options + sibling classpath).
pub fn decompile_class_with_options(
    class_file: &Path,
    decompiler_jar: &Path,
    classpath: &str,
    internal_name: &str,
    opts: DecompileOptions,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<DecompileResult, String> {
    let java = find_java()?;
    let mut cmd = Command::new(&java);
    // Force UTF-8 output. On Windows the JVM's stdout defaults to the system
    // ANSI code page (GBK on zh-CN), which garbles the Chinese characters the
    // decompiler emits. `file.encoding` covers JDK 8–17; `stdout.encoding`
    // covers JDK 18+ where System.out switched to `stdout.encoding`. Setting
    // both keeps the output UTF-8 on every JDK, so `from_utf8_lossy` decodes
    // correctly.
    cmd.arg("-Dfile.encoding=UTF-8")
        .arg("-Dstdout.encoding=UTF-8")
        .arg("-jar")
        .arg(decompiler_jar)
        .arg(class_file)
        .arg("--internal-name")
        .arg(internal_name)
        .arg("--classpath")
        .arg(classpath)
        .arg("--escape-unicode")
        .arg(opts.escape_unicode.to_string())
        .arg("--realign")
        .arg(opts.realign.to_string())
        .arg("--line-numbers")
        .arg(opts.line_numbers.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch java (jd-core): {e}"))?;

    // Hard deadline for the JD-Core child (audit P1-5): a malformed class
    // can make the JVM hang forever; without a timeout the calling jar_*
    // command would never return. 60s is generous for a single class.
    const DECOMPILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    let deadline = std::time::Instant::now() + DECOMPILE_TIMEOUT;
    let timed_out = Arc::new(AtomicBool::new(false));
    let timed_out_flag = Arc::clone(&timed_out);

    if let Some(cancel) = cancel {
        // Cancel watcher: kills the child as soon as the cancel flag flips.
        let pid = child.id();
        let finished = Arc::new(AtomicBool::new(false));
        let watcher_finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            while !watcher_finished.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    // Kill on all platforms.
                    let _ = kill_process(pid);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        });
        // Deadline watcher: same kill path on timeout.
        let pid = child.id();
        let finished2 = Arc::new(AtomicBool::new(false));
        let watcher2_finished = Arc::clone(&finished2);
        let timeout_flag = Arc::clone(&timed_out_flag);
        std::thread::spawn(move || {
            while !watcher2_finished.load(Ordering::Relaxed) {
                if std::time::Instant::now() >= deadline {
                    timeout_flag.store(true, Ordering::Relaxed);
                    let _ = kill_process(pid);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        let output = child.wait_with_output();
        finished.store(true, Ordering::Relaxed);
        finished2.store(true, Ordering::Relaxed);
        let output = output.map_err(|e| format!("failed waiting for jd-core: {e}"))?;
        if timed_out_flag.load(Ordering::Relaxed) {
            return Err("jd-core decompilation timed out after 60 seconds".to_string());
        }
        return decompile_output(output, class_file);
    }

    let pid = child.id();
    let finished = Arc::new(AtomicBool::new(false));
    let watcher_finished = Arc::clone(&finished);
    let timeout_flag = Arc::clone(&timed_out_flag);
    std::thread::spawn(move || {
        while !watcher_finished.load(Ordering::Relaxed) {
            if std::time::Instant::now() >= deadline {
                timeout_flag.store(true, Ordering::Relaxed);
                let _ = kill_process(pid);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed waiting for jd-core: {e}"))?;
    finished.store(true, Ordering::Relaxed);
    if timed_out_flag.load(Ordering::Relaxed) {
        return Err("jd-core decompilation timed out after 60 seconds".to_string());
    }

    decompile_output(output, class_file)
}

fn decompile_output(
    output: std::process::Output,
    class_file: &Path,
) -> Result<DecompileResult, String> {
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if !output.status.success() {
        return Err(format!(
            "jd-core decompilation failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    if stdout.trim().is_empty() {
        // The wrapper prints the reason to stderr on failure.
        let detail = if stderr.trim().is_empty() {
            "(no stderr)".to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "jd-core produced no output for {} — the class may be corrupt, or java could not run the decompiler. {detail}",
            class_file.display()
        ));
    }
    Ok(DecompileResult {
        source: stdout,
        refs: parse_jdrefs(&stderr),
    })
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
    fn decompiler_jar_is_present() {
        let jar = find_decompiler_jar();
        assert!(
            jar.is_ok(),
            "jd-core wrapper jar should be bundled: {:?}",
            jar.err()
        );
    }

    #[test]
    fn java_is_available() {
        let java = find_java();
        assert!(java.is_ok(), "java should be available to run jd-core");
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
        let jd = find_decompiler_jar().unwrap();
        let source = decompile_class(&class, &jd, "Hello", None).unwrap();
        assert!(source.contains("public class Hello"), "source: {source}");
        assert!(source.contains("hi"), "should contain method hi: {source}");
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Saver mode (JD-GUI Save All Sources defaults) must emit `/* n */ `
    /// line-number prefixes.
    #[test]
    fn decompile_saver_mode_emits_line_numbers() {
        let jdk = crate::compile::detect_jdk();
        if !jdk.found {
            eprintln!("skipping: no javac");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("jar-decomp-saver-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("Saver.java");
        std::fs::write(&src, "public class Saver {\n  public int x = 1;\n}\n").unwrap();
        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let status = std::process::Command::new(jdk.javac_path.as_deref().unwrap())
            .arg("-d")
            .arg(&out)
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());

        let class = out.join("Saver.class");
        let jd = find_decompiler_jar().unwrap();
        let source =
            decompile_class_with_options(&class, &jd, "", "Saver", DecompileOptions::saver(), None)
                .unwrap();
        assert!(
            source.contains("/* 1 */") || source.contains("/* 2 */"),
            "saver mode should emit line prefixes: {source}"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn embedded_jdcore_extracts_to_cache() {
        // Simulate a packaged build: no external jar anywhere → the embedded
        // bytes must produce a usable jar via the temp-dir cache.
        let path = extract_embedded_jd().expect("embedded jd-core extraction");
        assert!(path.is_file(), "extracted jar must exist");
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), EMBEDDED_JD_JAR.len() as u64);
        // Second call reuses the cache.
        let path2 = extract_embedded_jd().unwrap();
        assert_eq!(path, path2);
    }
}
