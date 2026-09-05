//! System clipboard "file list" read/write commands.
//!
//! The Tauri clipboard-manager plugin only handles text/images, but the SFTP
//! panel needs real file references so users can Ctrl+C in the app and paste
//! into Finder/Explorer (and vice versa). Each desktop platform gets a native
//! implementation:
//!
//! - macOS: `NSPasteboard` with `NSURL` objects (must run on the main thread).
//! - Windows: raw clipboard with `CF_HDROP` / `DROPFILES` via the `windows` crate.
//! - Linux: `text/uri-list` via `arboard` (graceful degradation; the frontend
//!   shows a hint when the desktop environment does not publish file URIs).

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::time::Duration;

/// 跳转到 macOS 主线程的超时时间。Pasteboard 往返通常很快；如果主线程阻塞
/// 超过该时长，返回错误而不是让命令死锁。
#[cfg(target_os = "macos")]
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Read file references from the system clipboard.
///
/// Returns absolute local paths. An empty list is NOT an error — it just means
/// the clipboard currently holds no file references (or only non-file URLs).
#[tauri::command]
pub fn clipboard_read_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    read_files_platform(&app)
}

/// Write existing on-disk paths to the system clipboard as file references.
#[tauri::command]
pub fn clipboard_write_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("clipboard_write_files: path list is empty".to_string());
    }
    for p in &paths {
        if !std::path::Path::new(p).exists() {
            return Err(format!("clipboard_write_files: path does not exist: {p}"));
        }
    }
    write_files_platform(&app, &paths)
}

/// Return (creating if needed) `<app cache dir>/clipboard-downloads`, where the
/// frontend stages remote files before exposing them on the clipboard.
#[tauri::command]
pub fn get_clipboard_cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("failed to resolve app cache dir: {e}"))?
        .join("clipboard-downloads");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create clipboard cache dir {:?}: {e}", dir))?;
    // Prevent long-lived sensitive downloads from accumulating forever. The
    // active clipboard batch is protected by the explicit cleanup call below;
    // this startup/path-acquisition pass only removes files older than a day.
    if let Err(error) = cleanup_clipboard_cache_dir(&dir, &[], Some(86_400)) {
        tracing::warn!("failed to prune clipboard cache {:?}: {error}", dir);
    }
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "clipboard cache dir is not valid UTF-8".to_string())
}

/// Remove cached clipboard downloads except `exclude_paths`.
///
/// `max_age_secs` protects recently created files when called opportunistically;
/// the frontend passes zero after replacing the system clipboard, so every
/// previous batch is removed while the newly written paths are excluded.
#[tauri::command]
pub fn clipboard_cleanup_cache(
    app: tauri::AppHandle,
    exclude_paths: Vec<String>,
    max_age_secs: Option<u64>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("failed to resolve app cache dir: {e}"))?
        .join("clipboard-downloads");
    let excluded = exclude_paths
        .into_iter()
        .map(PathBuf::from)
        .filter_map(|path| std::fs::canonicalize(&path).ok())
        .collect::<Vec<_>>();
    cleanup_clipboard_cache_dir(&dir, &excluded, max_age_secs)
}

fn cleanup_clipboard_cache_dir(
    dir: &Path,
    excluded: &[PathBuf],
    max_age_secs: Option<u64>,
) -> Result<Vec<String>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    cleanup_dir_recursive(dir, excluded, max_age_secs, &mut removed)?;
    Ok(removed)
}

fn cleanup_dir_recursive(
    dir: &Path,
    excluded: &[PathBuf],
    max_age_secs: Option<u64>,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read clipboard cache dir {:?}: {e}", dir))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read clipboard cache entry: {e}"))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("failed to inspect clipboard cache entry {path:?}: {e}"))?;

        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            cleanup_dir_recursive(&path, excluded, max_age_secs, removed)?;
            if std::fs::read_dir(&path)
                .map_err(|e| format!("failed to read clipboard cache dir {path:?}: {e}"))?
                .next()
                .is_none()
            {
                std::fs::remove_dir(&path)
                    .map_err(|e| format!("failed to remove clipboard cache dir {path:?}: {e}"))?;
                if let Some(text) = path.to_str() {
                    removed.push(text.to_owned());
                }
            }
            continue;
        }

        let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if excluded.iter().any(|excluded| excluded == &canonical) {
            continue;
        }
        if let Some(max_age) = max_age_secs {
            let modified = metadata
                .modified()
                .map_err(|e| format!("failed to read clipboard cache mtime {path:?}: {e}"))?;
            let age = modified
                .elapsed()
                .map_err(|e| format!("invalid clipboard cache mtime {path:?}: {e}"))?;
            if age.as_secs() < max_age {
                continue;
            }
        }

        if metadata.file_type().is_symlink() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("failed to remove clipboard cache symlink {path:?}: {e}"))?;
        } else {
            std::fs::remove_file(&path)
                .map_err(|e| format!("failed to remove clipboard cache file {path:?}: {e}"))?;
        }
        if let Some(text) = path.to_str() {
            removed.push(text.to_owned());
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS — NSPasteboard + NSURL (main thread only)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn read_files_platform(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<String>, String>>();
    app.run_on_main_thread(move || {
        // Drain temporary Objective-C objects when the pool closure ends.
        let result = objc2::rc::autoreleasepool(|_| unsafe { ns_pasteboard_read_files() });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to hop to main thread: {e}"))?;
    rx.recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "timed out waiting for pasteboard read on main thread".to_string())?
}

#[cfg(target_os = "macos")]
fn write_files_platform(app: &tauri::AppHandle, paths: &[String]) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let paths = paths.to_vec();
    app.run_on_main_thread(move || {
        let result = objc2::rc::autoreleasepool(|_| unsafe { ns_pasteboard_write_files(&paths) });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("failed to hop to main thread: {e}"))?;
    rx.recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "timed out waiting for pasteboard write on main thread".to_string())?
}

/// SAFETY: must be called on the macOS main thread (AppKit requirement).
#[cfg(target_os = "macos")]
unsafe fn ns_pasteboard_read_files() -> Result<Vec<String>, String> {
    use objc2::ClassType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSURL};

    let pb = NSPasteboard::generalPasteboard();

    // Ask only for file URLs (NSPasteboardURLReadingFileURLsOnlyKey = YES).
    // The key is an extern static referencing an NSString; reading it is the
    // one unsafe op here. NSDictionary copies its keys, matching from_slices.
    let class_array = NSArray::from_slice(&[NSURL::class()]);
    let options = NSDictionary::from_slices(
        &[unsafe { objc2_app_kit::NSPasteboardURLReadingFileURLsOnlyKey }],
        &[NSNumber::new_bool(true).as_ref()],
    );

    let objects = unsafe { pb.readObjectsForClasses_options(&class_array, Some(&options)) };

    let mut out = Vec::new();
    if let Some(array) = objects {
        for obj in array.to_vec() {
            if let Ok(url) = obj.downcast::<NSURL>() {
                if !url.isFileURL() {
                    continue;
                }
                if let Some(path) = url.path() {
                    out.push(path.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// SAFETY: must be called on the macOS main thread (AppKit requirement).
#[cfg(target_os = "macos")]
unsafe fn ns_pasteboard_write_files(paths: &[String]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();

    let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
        .iter()
        .map(|p| {
            let ns_path = NSString::from_str(p);
            let is_dir = std::path::Path::new(p).is_dir();
            ProtocolObject::from_retained(NSURL::fileURLWithPath_isDirectory(&ns_path, is_dir))
        })
        .collect();

    let objects = NSArray::from_retained_slice(&urls);
    let ok = pb.writeObjects(&objects);
    if ok {
        Ok(())
    } else {
        Err("NSPasteboard writeObjects returned false".to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows — CF_HDROP / DROPFILES
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn read_files_platform(_app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        OpenClipboard(None).map_err(|e| format!("OpenClipboard failed: {e}"))?;
        // Ensure the clipboard is closed on every exit path.
        struct CloseGuard;
        impl Drop for CloseGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _guard = CloseGuard;

        let handle = GetClipboardData(CF_HDROP.0 as u32)
            .map_err(|e| format!("GetClipboardData(CF_HDROP) failed: {e}"))?;
        if handle.is_invalid() {
            return Ok(vec![]);
        }

        // The CF_HDROP payload is an HGLOBAL storing the DROPFILES blob.
        let hdrop = HDROP(handle.0);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            // First call: query the required buffer length (in u16, excluding NUL).
            let len = DragQueryFileW(hdrop, i, None);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(hdrop, i, Some(&mut buf));
            if copied == 0 {
                continue;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            if let Ok(p) = String::from_utf16(&buf[..end]) {
                if !p.is_empty() {
                    paths.push(p);
                }
            }
        }
        Ok(paths)
    }
}

#[cfg(windows)]
fn write_files_platform(_app: &tauri::AppHandle, paths: &[String]) -> Result<(), String> {
    use windows::Win32::Foundation::{HANDLE, POINT};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    // Encode as UTF-16 first so the allocation size is exact.
    let wide: Vec<Vec<u16>> = paths.iter().map(|p| p.encode_utf16().collect()).collect();
    let header = std::mem::size_of::<DROPFILES>();
    // Each path: its chars + NUL. Then one extra NUL terminating the whole list.
    let total = header + wide.iter().map(|w| (w.len() + 1) * 2).sum::<usize>() + 2;

    unsafe {
        let hglobal =
            GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("GlobalAlloc failed: {e}"))?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            let _ = windows::Win32::Foundation::GlobalFree(Some(hglobal));
            return Err("GlobalLock failed".to_string());
        }

        (ptr as *mut DROPFILES).write(DROPFILES {
            pFiles: header as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: windows::core::BOOL(0),
            fWide: windows::core::BOOL(1),
        });

        let mut cursor = ptr.add(header) as *mut u16;
        for w in &wide {
            std::ptr::copy_nonoverlapping(w.as_ptr(), cursor, w.len());
            cursor = cursor.add(w.len());
            *cursor = 0; // per-path NUL
            cursor = cursor.add(1);
        }
        *cursor = 0; // final list-terminating NUL

        let _ = GlobalUnlock(hglobal);

        OpenClipboard(None).map_err(|e| format!("OpenClipboard failed: {e}"))?;
        struct CloseGuard;
        impl Drop for CloseGuard {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _guard = CloseGuard;

        if let Err(e) = EmptyClipboard() {
            return Err(format!("EmptyClipboard failed: {e}"));
        }

        match SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglobal.0))) {
            Ok(_) => Ok(()), // system owns the memory now
            Err(e) => {
                let _ = windows::Win32::Foundation::GlobalFree(Some(hglobal));
                Err(format!("SetClipboardData failed: {e}"))
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linux — text/uri-list via arboard (degraded mode)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn read_files_platform(_app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("failed to open clipboard: {e}"))?;
    let text = clipboard
        .get_text()
        .map_err(|e| format!("failed to read clipboard text: {e}"))?;
    let paths = parse_uri_list(&text);
    if paths.is_empty() {
        // Not a file list — report as a distinct, expected condition so the
        // frontend can degrade gracefully instead of showing a hard error.
        return Err("clipboard contains no file:// URIs".to_string());
    }
    Ok(paths)
}

#[cfg(target_os = "linux")]
fn write_files_platform(_app: &tauri::AppHandle, paths: &[String]) -> Result<(), String> {
    let payload = build_uri_list(paths);
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("failed to open clipboard: {e}"))?;
    clipboard
        .set_text(payload)
        .map_err(|e| format!("failed to write clipboard text: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-independent helpers (unit-tested below)
// ─────────────────────────────────────────────────────────────────────────────

/// Percent-decode a URI component (path part of a file:// URL).
#[cfg(target_os = "linux")]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 将 `text/uri-list` 内容解析为本地文件路径。
///
/// 按 freedesktop 规范处理：以 `#` 开头的行是注释；其余每行是一个 URI。
/// 只接受空 host 的 `file://` URI（即 `file:///absolute/path`），并解码成
/// 绝对路径；远程 host URI 与非 `file` scheme 都必须忽略。
#[cfg(target_os = "linux")]
pub(crate) fn parse_uri_list(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("file://") {
            // `file://remote/path` 表示远程 host，不能当成本地路径截取。
            // 本地路径必须紧随 `file://` 后以 `/` 开头。
            if !rest.starts_with('/') {
                continue;
            }
            let path_part = rest;
            let decoded = percent_decode(path_part);
            if decoded.starts_with('/') && !decoded.is_empty() {
                paths.push(decoded);
            }
        }
        // 其他 scheme 有意忽略。
    }
    paths
}

/// Build a `text/uri-list` payload from absolute paths (percent-encoding the
/// characters the spec reserves). Ends with CRLF + trailing empty line.
#[cfg(target_os = "linux")]
pub(crate) fn build_uri_list(paths: &[String]) -> String {
    fn encode_path(p: &str) -> String {
        let mut out = String::with_capacity(p.len());
        for c in p.chars() {
            // RFC 8089: encode anything outside the unreserved set.
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '/') {
                out.push(c);
            } else {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
        out
    }
    let mut list = String::new();
    for p in paths {
        list.push_str("file://");
        list.push_str(&encode_path(p));
        list.push_str("\r\n");
    }
    list
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_uri_list() {
        let text = "file:///home/user/a.txt\r\nfile:///tmp/b%20c.txt\r\n";
        assert_eq!(
            parse_uri_list(text),
            vec!["/home/user/a.txt".to_string(), "/tmp/b c.txt".to_string()]
        );
    }

    #[test]
    fn parse_skips_comments_blank_and_non_file() {
        let text =
            "# comment\r\n\r\nfile:///a.txt\r\nhttps://example.com/x\r\nfile://remote/share/f";
        assert_eq!(parse_uri_list(text), vec!["/a.txt".to_string()]);
    }

    #[test]
    fn parse_ignores_remote_host_uris() {
        // `file://remote/share/f` 是远程 URI，不是本地路径，必须跳过。
        let text = "file://nas/data/file.bin\r\nfile:///local/file.bin\r\n";
        assert_eq!(parse_uri_list(text), vec!["/local/file.bin".to_string()]);
    }

    #[test]
    fn parse_plain_text_is_empty() {
        assert!(parse_uri_list("just some copied text").is_empty());
        assert!(parse_uri_list("").is_empty());
    }

    #[test]
    fn parse_utf8_percent_sequence() {
        let text = "file:///tmp/%E4%B8%AD%E6%96%87.txt";
        assert_eq!(parse_uri_list(text), vec!["/tmp/中文.txt".to_string()]);
    }

    #[test]
    fn roundtrip_uri_list() {
        let paths = vec![
            "/home/user/my file.txt".to_string(),
            "/tmp/ünïcode/".to_string(),
        ];
        let payload = build_uri_list(&paths);
        assert_eq!(parse_uri_list(&payload), paths);
    }

    #[test]
    fn build_encodes_reserved_chars() {
        let payload = build_uri_list(&["/a b#c.txt".to_string()]);
        assert_eq!(payload, "file:///a%20b%23c.txt\r\n");
    }

    #[test]
    fn build_handles_multiple_paths() {
        let payload = build_uri_list(&["/x".to_string(), "/y".to_string(), "/z".to_string()]);
        assert_eq!(payload, "file:///x\r\nfile:///y\r\nfile:///z\r\n");
    }

    #[test]
    fn percent_decode_keeps_literal_percent_without_hex() {
        assert_eq!(percent_decode("100% done"), "100% done");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn cleanup_removes_previous_batches_and_keeps_excluded_paths() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("clipboard-downloads");
        let nested = dir.join("old-batch");
        std::fs::create_dir_all(&nested).unwrap();
        let current = dir.join("current.txt");
        let old = nested.join("old.txt");
        std::fs::write(&current, b"current").unwrap();
        std::fs::write(&old, b"old").unwrap();

        let excluded = vec![std::fs::canonicalize(&current).unwrap()];
        let removed = cleanup_clipboard_cache_dir(&dir, &excluded, None).unwrap();

        assert!(current.exists());
        assert!(!old.exists());
        assert!(!nested.exists());
        assert_eq!(removed.len(), 2);
    }

    #[test]
    fn cleanup_accepts_missing_directory() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            cleanup_clipboard_cache_dir(&root.path().join("missing"), &[], None)
                .unwrap()
                .is_empty()
        );
    }
}
