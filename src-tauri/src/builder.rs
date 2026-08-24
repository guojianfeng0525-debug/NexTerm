//! JAR rebuild.
//!
//! Builds a new JAR from the original (read-only) plus modifications:
//! - unchanged classes/resources/META-INF are copied byte-for-byte
//! - modified classes use their compiled bytes
//! - deleted classes are skipped
//! - added classes are appended
//!
//! The output is written to a temp file first, then renamed into place, so a
//! failed build never corrupts an existing output.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

/// One entry to write into the new JAR.
pub enum EntryPayload {
    /// Copy raw bytes from the original JAR entry.
    Original(Vec<u8>),
    /// Use provided bytes (compiled class, added class, etc).
    Bytes(Vec<u8>),
}

/// Build a new JAR at `output_path`.
///
/// `original_jar` — read-only input.
/// `overrides` — map entry_path → replacement payload. Entries present here
///   replace the original; entries absent are copied as-is.
/// `deletions` — entry paths to omit entirely.
/// `additions` — new entries (entry_path → bytes).
pub fn build_jar(
    original_jar: &Path,
    overrides: &HashMap<String, Vec<u8>>,
    deletions: &[String],
    additions: &[(String, Vec<u8>)],
    output_path: &Path,
) -> Result<u64, String> {
    let file = std::fs::File::open(original_jar)
        .map_err(|e| format!("open original jar {}: {e}", original_jar.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;

    let deleted: std::collections::HashSet<&str> = deletions.iter().map(|s| s.as_str()).collect();

    // Temp output in the same directory, then rename.
    let out_dir = output_path.parent().unwrap_or(Path::new("."));
    let tmp_path = out_dir.join(format!(
        ".{}.tmp-{}",
        output_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "jar".into()),
        std::process::id()
    ));
    let out_file = std::fs::File::create(&tmp_path).map_err(|e| format!("create temp out: {e}"))?;
    let mut zip = zip::ZipWriter::new(out_file);

    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1) Copy all original entries (with overrides/deletions applied).
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        if deleted.contains(name.as_str()) {
            continue;
        }

        let payload: Vec<u8> = if let Some(repl) = overrides.get(name.as_str()) {
            repl.clone()
        } else {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("read entry {name}: {e}"))?;
            buf
        };

        zip.start_file(&name, opts)
            .map_err(|e| format!("start entry {name}: {e}"))?;
        zip.write_all(&payload)
            .map_err(|e| format!("write entry {name}: {e}"))?;
    }

    // 2) Additions (new classes / files).
    for (name, bytes) in additions {
        zip.start_file(name, opts)
            .map_err(|e| format!("start addition {name}: {e}"))?;
        zip.write_all(bytes)
            .map_err(|e| format!("write addition {name}: {e}"))?;
    }

    zip.finish().map_err(|e| format!("finish zip: {e}"))?;

    // Atomic-ish rename.
    std::fs::rename(&tmp_path, output_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("finalize output {}: {e}", output_path.display())
    })?;

    let size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_jar(path: &Path, files: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    fn read_jar(path: &Path) -> HashMap<String, Vec<u8>> {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut out = HashMap::new();
        for i in 0..archive.len() {
            let mut e = archive.by_index(i).unwrap();
            let name = e.name().to_string();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut e, &mut buf).unwrap();
            out.insert(name, buf);
        }
        out
    }

    #[test]
    fn rebuild_preserves_unmodified_and_applies_changes() {
        let dir = std::env::temp_dir().join(format!("jar-build-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let orig = dir.join("orig.jar");
        let out = dir.join("out.jar");
        make_jar(
            &orig,
            &[
                ("a/A.class", b"OLD_A"),
                ("b/B.class", b"OLD_B"),
                ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
                ("r.txt", b"resource"),
            ],
        );

        let mut overrides = HashMap::new();
        overrides.insert("a/A.class".to_string(), b"NEW_A".to_vec());
        let deletions = vec!["b/B.class".to_string()];
        let additions = vec![("c/C.class".to_string(), b"NEW_C".to_vec())];

        let size = build_jar(&orig, &overrides, &deletions, &additions, &out).unwrap();
        assert!(size > 0);

        let rebuilt = read_jar(&out);
        assert_eq!(rebuilt["a/A.class"], b"NEW_A");
        assert_eq!(rebuilt["META-INF/MANIFEST.MF"], b"Manifest-Version: 1.0\n");
        assert_eq!(rebuilt["r.txt"], b"resource");
        assert!(!rebuilt.contains_key("b/B.class"));
        assert_eq!(rebuilt["c/C.class"], b"NEW_C");

        // Original untouched.
        let orig_read = read_jar(&orig);
        assert_eq!(orig_read["a/A.class"], b"OLD_A");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_missing_original_fails() {
        let out =
            std::env::temp_dir().join(format!("jar-build-missing-{}.jar", std::process::id()));
        let res = build_jar(
            Path::new("/nonexistent/x.jar"),
            &HashMap::new(),
            &[],
            &[],
            &out,
        );
        assert!(res.is_err());
    }
}
