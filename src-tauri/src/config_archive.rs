use std::io::{Read, Write};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ArchiveEntry { pub path: String, pub data: Vec<u8> }

fn valid_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.contains('\\')
        && !path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
}

#[tauri::command]
pub fn write_config_archive(output_path: String, entries: Vec<ArchiveEntry>) -> Result<(), String> {
    let file = std::fs::File::create(output_path).map_err(|e| format!("create archive: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in entries {
        if !valid_path(&entry.path) { return Err("invalid archive entry path".to_string()); }
        zip.start_file(&entry.path, options).map_err(|e| format!("start archive entry: {e}"))?;
        zip.write_all(&entry.data).map_err(|e| format!("write archive entry: {e}"))?;
    }
    zip.finish().map_err(|e| format!("finish archive: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn read_config_archive(input_path: String) -> Result<Vec<ArchiveEntry>, String> {
    let file = std::fs::File::open(input_path).map_err(|e| format!("open archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read archive: {e}"))?;
    if zip.len() > 1_000 { return Err("archive contains too many files".to_string()); }
    let mut entries = Vec::with_capacity(zip.len());
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|e| format!("read archive entry: {e}"))?;
        let path = file.name().to_string();
        if file.is_dir() { continue; }
        if !valid_path(&path) || file.size() > 128 * 1024 * 1024 { return Err("invalid archive entry".to_string()); }
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data).map_err(|e| format!("read archive entry: {e}"))?;
        entries.push(ArchiveEntry { path, data });
    }
    Ok(entries)
}
