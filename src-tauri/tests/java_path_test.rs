// Verify find_java works with restricted PATH (GUI app simulation).
use nexterm_lib::decompile;
#[test]
// macOS/Linux ship a PATH-independent /usr/bin/java stub, so clearing the
// environment is recoverable there. Windows has no system java at all: a real
// GUI launch inherits the user PATH, and the "no PATH, no JAVA_HOME" state
// this test simulates is unrecoverable by design — skip it on Windows.
#[cfg(not(windows))]
fn find_java_gui_env() {
    // Save and clear PATH + JAVA_HOME to simulate GUI launch.
    let old_path = std::env::var("PATH").ok();
    let old_home = std::env::var("JAVA_HOME").ok();
    std::env::remove_var("PATH");
    std::env::remove_var("JAVA_HOME");
    let r = decompile::find_java_public();
    // Restore.
    if let Some(p) = old_path { std::env::set_var("PATH", p); }
    if let Some(h) = old_home { std::env::set_var("JAVA_HOME", h); }
    assert!(r.is_ok(), "find_java should fall back to javac-derived java: {:?}", r.err());
}
