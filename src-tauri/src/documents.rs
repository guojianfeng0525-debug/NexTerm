//! Documents module backend — canonical-model persistence for DOCX/XLSX.
//!
//! SQLite stores the structured model (editor wire parts for DOCX, workbook
//! model for XLSX) plus non-editor package parts as BLOBs. The original file
//! bytes are never persisted — they are rebuilt from the model on export.

use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::State;

use crate::db::DbState;

/// (resource_id, kind, mime, data, sha256)
pub type ResourceRow = (String, String, String, Vec<u8>, String);

#[derive(serde::Serialize)]
pub struct DocumentMeta {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
}

// ── XLSX canonical model DTO ─────────────────────────────────────────────
// betteroffice-xlsx's `Workbook` is not serde, so we bridge it with our own
// serializable representation (all leaf types implement serde).

#[derive(serde::Serialize, serde::Deserialize)]
struct CellDto {
    value: betteroffice_xlsx::CellValue,
    formula: Option<String>,
    style: Option<u32>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct XlsxSheetDto {
    name: String,
    cells: Vec<(u32, u32, CellDto)>,
    freeze_pane: Option<betteroffice_xlsx::FreezePane>,
    merges: Vec<betteroffice_xlsx::CellRange>,
    col_widths: Vec<(u32, f64)>,
    row_heights: Vec<(u32, f64)>,
    hyperlinks: Vec<betteroffice_xlsx::Hyperlink>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct XlsxModelDto {
    sheets: Vec<XlsxSheetDto>,
    date_system: betteroffice_xlsx::DateSystem,
    defined_names: Vec<betteroffice_xlsx::DefinedName>,
    shared_strings: Vec<String>,
    styles: xlsx_model::Stylesheet,
}

fn workbook_to_dto(wb: &betteroffice_xlsx::WorkbookModel) -> XlsxModelDto {
    XlsxModelDto {
        sheets: wb
            .sheets
            .iter()
            .map(|s| XlsxSheetDto {
                name: s.name.clone(),
                cells: s
                    .iter_cells()
                    .map(|(r, c)| {
                        (
                            r.row,
                            r.col,
                            CellDto {
                                value: c.value.clone(),
                                formula: c.formula.clone(),
                                style: c.style,
                            },
                        )
                    })
                    .collect(),
                freeze_pane: s.freeze_pane,
                merges: s.merges.clone(),
                col_widths: s.col_widths.iter().map(|(k, v)| (*k, *v)).collect(),
                row_heights: s.row_heights.iter().map(|(k, v)| (*k, *v)).collect(),
                hyperlinks: s.hyperlinks.clone(),
            })
            .collect(),
        date_system: wb.date_system,
        defined_names: wb.defined_names.clone(),
        shared_strings: wb.shared_strings.clone(),
        styles: wb.styles.clone(),
    }
}

fn dto_to_workbook(dto: XlsxModelDto) -> betteroffice_xlsx::WorkbookModel {
    let mut sheets = Vec::with_capacity(dto.sheets.len());
    for s in dto.sheets {
        let mut sheet = betteroffice_xlsx::Sheet::new(s.name);
        for (row, col, cell) in s.cells {
            sheet.set_cell(
                betteroffice_xlsx::CellRef::new(row, col),
                betteroffice_xlsx::Cell {
                    value: cell.value,
                    formula: cell.formula,
                    style: cell.style,
                },
            );
        }
        sheet.freeze_pane = s.freeze_pane;
        sheet.merges = s.merges;
        sheet.col_widths = s.col_widths.into_iter().collect();
        sheet.row_heights = s.row_heights.into_iter().collect();
        sheet.hyperlinks = s.hyperlinks;
        sheets.push(sheet);
    }
    betteroffice_xlsx::WorkbookModel {
        sheets,
        date_system: dto.date_system,
        defined_names: dto.defined_names,
        shared_strings: dto.shared_strings,
        styles: dto.styles,
    }
}

/// Detect the real OOXML container from the file header — extension alone is
/// not trustworthy (a legacy `.doc` is an OLE container, not a zip, and would
/// make the DOCX parser hang or spin).
pub fn detect_ooxml_kind(bytes: &[u8], name: &str) -> Result<&'static str, String> {
    let lower = name.to_lowercase();
    // ZIP/Office Open XML starts with "PK\x03\x04".
    let is_zip = bytes.len() >= 4
        && bytes[0] == 0x50
        && bytes[1] == 0x4b
        && bytes[2] == 0x03
        && bytes[3] == 0x04;
    if !is_zip {
        // OLE2 (legacy .doc/.xls) starts with D0 CF 11 E0.
        let is_ole = bytes.len() >= 8
            && bytes[0] == 0xd0
            && bytes[1] == 0xcf
            && bytes[2] == 0x11
            && bytes[3] == 0xe0
            && bytes[4] == 0xa1
            && bytes[5] == 0xb1
            && bytes[6] == 0x1a
            && bytes[7] == 0xe1;
        if is_ole {
            return Err("legacy OLE format (.doc/.xls) is not supported — save the file as .docx/.xlsx first".to_string());
        }
        return Err("not a valid Office Open XML file".to_string());
    }
    if lower.ends_with(".docx") || lower.ends_with(".doc") {
        Ok("docx")
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xls") {
        Ok("xlsx")
    } else {
        // Zip container but unknown extension — try to sniff the content.
        if bytes.len() > 96 && String::from_utf8_lossy(&bytes[0..96]).contains("word/") {
            Ok("docx")
        } else {
            Ok("xlsx")
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Serialize the DOCX wire fields into the canonical model JSON.
fn docx_wire_model(doc: &betteroffice_docx::Document) -> Result<String, String> {
    let m = doc.model();
    #[derive(serde::Serialize)]
    struct Wire {
        body: docx_parse::DocumentBody,
        headers: Vec<(String, docx_parse::HeaderFooter)>,
        footers: Vec<(String, docx_parse::HeaderFooter)>,
        footnotes: Vec<docx_parse::Note>,
        endnotes: Vec<docx_parse::Note>,
        relationships: Vec<(String, docx_parse::Relationship)>,
        numbering: docx_parse::NumberingDefinitions,
    }
    let wire = Wire {
        body: m.body.clone(),
        headers: m.headers.clone(),
        footers: m.footers.clone(),
        footnotes: m.footnotes.clone(),
        endnotes: m.endnotes.clone(),
        relationships: m.relationships.clone(),
        numbering: m.numbering.clone(),
    };
    serde_json::to_string(&wire).map_err(|e| e.to_string())
}

/// Editor parts the DOCX serializer rewrites; everything else becomes a BLOB.
fn is_docx_editor_part(path: &str) -> bool {
    path == "word/document.xml"
        || path.starts_with("word/header")
        || path.starts_with("word/footer")
        || path == "word/footnotes.xml"
        || path == "word/endnotes.xml"
        || path == "word/numbering.xml"
}

/// Engine-level parse limits — far stricter than the defaults so an
/// oversized or pathological document is refused quickly instead of stalling.
fn docx_parse_limits() -> docx_parse::xml::ParseLimits {
    docx_parse::xml::ParseLimits {
        max_xml_bytes: 32 * 1024 * 1024,
        max_xml_events: 500_000,
        max_xml_text_bytes: 32 * 1024 * 1024,
        max_xml_depth: 64,
        max_attributes_per_element: 512,
        max_attribute_bytes: 512 * 1024,
        max_relationships: 50_000,
        max_leaf_values: 200_000,
        max_blocks: 100_000,
        max_paragraphs: 50_000,
        max_tables: 2_000,
        max_table_rows: 50_000,
        max_table_cells: 200_000,
        max_notes: 5_000,
        max_comments: 5_000,
        max_nesting_depth: 64,
    }
}

/// Parse DOCX (pure, may be slow on hostile input — caller wraps in a timeout).
fn parse_docx(
    bytes: &[u8],
    name: &str,
    id: &str,
) -> Result<(String, Vec<ResourceRow>, i64), String> {
    let doc = betteroffice_docx::Document::open_with_limits(bytes, &docx_parse_limits())
        .map_err(|e| format!("parse docx: {e}"))?;
    let model = docx_wire_model(&doc)?;
    let parts = ooxml_opc::unzip_parts(bytes).map_err(|e| format!("unzip: {e}"))?;
    let mut resources: Vec<ResourceRow> = Vec::new();
    for (path, data) in &parts {
        if is_docx_editor_part(path) {
            continue;
        }
        let mime = mime_for_part(path);
        resources.push((
            path.clone(),
            "blob".to_string(),
            mime,
            data.clone(),
            sha256_hex(data),
        ));
    }
    let _ = name;
    let _ = id;
    Ok((model, resources, bytes.len() as i64))
}

/// Parse XLSX (pure).
fn parse_xlsx(
    bytes: &[u8],
    name: &str,
    id: &str,
) -> Result<(String, Vec<ResourceRow>, i64), String> {
    let wb = betteroffice_xlsx::Workbook::open(bytes).map_err(|e| format!("parse xlsx: {e}"))?;
    let model = serde_json::to_string(&workbook_to_dto(wb.model())).map_err(|e| e.to_string())?;
    let _ = name;
    let _ = id;
    Ok((model, Vec::new(), bytes.len() as i64))
}

/// Import DOCX: parse → wire model JSON + non-editor parts as BLOBs.
pub fn import_docx(
    state: &DbState,
    bytes: &[u8],
    name: &str,
    id: &str,
) -> Result<DocumentMeta, String> {
    let (model, resources, size) = parse_docx(bytes, name, id)?;
    let model_hash = sha256_hex(model.as_bytes());
    state
        .documents_write(
            id,
            name,
            "docx",
            size,
            Some(&sha256_hex(bytes)),
            1,
            None,
            &model,
            &model_hash,
            &resources,
        )
        .map_err(|e| format!("persist: {e}"))?;
    Ok(DocumentMeta {
        id: id.to_string(),
        name: name.to_string(),
        kind: "docx".into(),
        size,
    })
}

/// Import XLSX: parse → workbook model JSON.
pub fn import_xlsx(
    state: &DbState,
    bytes: &[u8],
    name: &str,
    id: &str,
) -> Result<DocumentMeta, String> {
    let (model, resources, size) = parse_xlsx(bytes, name, id)?;
    let model_hash = sha256_hex(model.as_bytes());
    state
        .documents_write(
            id,
            name,
            "xlsx",
            size,
            Some(&sha256_hex(bytes)),
            1,
            None,
            &model,
            &model_hash,
            &resources,
        )
        .map_err(|e| format!("persist: {e}"))?;
    Ok(DocumentMeta {
        id: id.to_string(),
        name: name.to_string(),
        kind: "xlsx".into(),
        size,
    })
}

/// Export a document to OOXML bytes from the canonical model.
pub fn export(state: &DbState, doc_id: &str, version: Option<i64>) -> Result<Vec<u8>, String> {
    let (ver, model_json) = state
        .documents_read_model(doc_id, version)?
        .ok_or_else(|| "document or version not found".to_string())?;

    // Kind from the document row.
    let kind = state
        .documents_kind(doc_id)?
        .ok_or_else(|| "document not found".to_string())?;

    match kind.as_str() {
        "xlsx" => export_xlsx(&model_json),
        "docx" => export_docx(state, doc_id, ver, &model_json),
        other => Err(format!("unsupported document kind: {other}")),
    }
}

fn export_xlsx(model_json: &str) -> Result<Vec<u8>, String> {
    let dto: XlsxModelDto =
        serde_json::from_str(model_json).map_err(|e| format!("model json: {e}"))?;
    let wb = betteroffice_xlsx::Workbook::from_model(dto_to_workbook(dto))
        .map_err(|e| format!("from_model: {e}"))?;
    wb.save().map_err(|e| format!("save xlsx: {e}"))
}

fn export_docx(
    state: &DbState,
    doc_id: &str,
    _version: i64,
    model_json: &str,
) -> Result<Vec<u8>, String> {
    #[derive(serde::Deserialize)]
    struct Wire {
        body: docx_parse::DocumentBody,
        headers: Vec<(String, docx_parse::HeaderFooter)>,
        footers: Vec<(String, docx_parse::HeaderFooter)>,
        footnotes: Vec<docx_parse::Note>,
        endnotes: Vec<docx_parse::Note>,
        relationships: Vec<(String, docx_parse::Relationship)>,
        numbering: docx_parse::NumberingDefinitions,
    }
    let wire: Wire = serde_json::from_str(model_json).map_err(|e| format!("model json: {e}"))?;

    // Rebuild the package bottom from the BLOB resources.
    let resources = state.documents_resources(doc_id)?;
    let bottom = zip_blobs(&resources);

    let request = docx_parse::serializer::S13SaveRequest {
        determinism: docx_parse::serializer::SerializerDeterminism {
            seed: sha256_hex(format!("nexterm-docx-{doc_id}").as_bytes()),
            now: "2026-01-01T00:00:00.000Z".to_string(),
        },
        document: wire.body,
        header_entries: wire.headers,
        footer_entries: wire.footers,
        footnotes: wire.footnotes,
        endnotes: wire.endnotes,
        footnote_separators: Vec::new(),
        endnote_separators: Vec::new(),
        relationship_entries: wire.relationships,
        numbering: Some(wire.numbering),
        options: docx_parse::serializer::S13SaveOptions {
            update_modified_date: false,
            modified_by: None,
        },
        selective: None,
    };
    docx_parse::serializer::write_docx_s13(request, &bottom).map_err(|e| format!("write docx: {e}"))
}

/// Save an edited document: re-parse the editor bytes into the canonical
/// model and write a new version.
pub fn save_edited(
    state: &DbState,
    doc_id: &str,
    base_version: i64,
    name: &str,
    bytes: &[u8],
) -> Result<i64, String> {
    let kind = state
        .documents_kind(doc_id)?
        .ok_or_else(|| "document not found".to_string())?;

    let (model, resources, size): (String, Vec<ResourceRow>, i64) = match kind.as_str() {
        "xlsx" => {
            let wb =
                betteroffice_xlsx::Workbook::open(bytes).map_err(|e| format!("parse xlsx: {e}"))?;
            let model =
                serde_json::to_string(&workbook_to_dto(wb.model())).map_err(|e| e.to_string())?;
            (model, Vec::new(), bytes.len() as i64)
        }
        "docx" => {
            let doc =
                betteroffice_docx::Document::open(bytes).map_err(|e| format!("parse docx: {e}"))?;
            let model = docx_wire_model(&doc)?;
            let parts = ooxml_opc::unzip_parts(bytes).map_err(|e| format!("unzip: {e}"))?;
            let mut resources = Vec::new();
            for (path, data) in &parts {
                if is_docx_editor_part(path) {
                    continue;
                }
                let mime = mime_for_part(path);
                resources.push((
                    path.clone(),
                    "blob".to_string(),
                    mime,
                    data.clone(),
                    sha256_hex(data),
                ));
            }
            (model, resources, bytes.len() as i64)
        }
        other => return Err(format!("unsupported document kind: {other}")),
    };

    let model_hash = sha256_hex(model.as_bytes());
    let head = state
        .documents_read_model(doc_id, None)?
        .map(|(v, _)| v)
        .unwrap_or(0);
    let next = head + 1;

    state
        .documents_write(
            doc_id,
            name,
            &kind,
            size,
            None,
            next,
            Some(base_version),
            &model,
            &model_hash,
            &resources,
        )
        .map_err(|e| format!("persist: {e}"))?;
    Ok(next)
}

fn zip_blobs(resources: &[(String, String, String, Vec<u8>)]) -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (path, _kind, _mime, data) in resources {
        if zip.start_file(path, opts).is_ok() {
            use std::io::Write;
            let _ = zip.write_all(data);
        }
    }
    zip.finish().map(|c| c.into_inner()).unwrap_or_default()
}

fn mime_for_part(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".into()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".into()
    } else if lower.ends_with(".gif") {
        "image/gif".into()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".into()
    } else if lower.ends_with(".emf") {
        "image/x-emf".into()
    } else if lower.ends_with(".woff") || lower.ends_with(".woff2") {
        "font/woff2".into()
    } else if lower.ends_with(".ttf") {
        "font/ttf".into()
    } else if lower.ends_with(".xml") || lower.ends_with(".rels") {
        "application/xml".into()
    } else {
        "application/octet-stream".into()
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub head_version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn documents_list(
    state: State<'_, Arc<DbState>>,
) -> Result<Vec<DocumentListEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.documents_list().map(|rows| {
            rows.into_iter()
                .map(
                    |(id, name, kind, size, head_version, created_at, updated_at)| {
                        DocumentListEntry {
                            id,
                            name,
                            kind,
                            size,
                            head_version,
                            created_at,
                            updated_at,
                        }
                    },
                )
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse timeout — guards against pathological files that stall the engine.
const PARSE_TIMEOUT_SECS: u64 = 20;

#[tauri::command]
pub async fn documents_import(
    bytes: Vec<u8>,
    name: String,
    id: String,
    state: State<'_, Arc<DbState>>,
) -> Result<DocumentMeta, String> {
    let kind = detect_ooxml_kind(&bytes, &name)?;
    let source_hash = sha256_hex(&bytes);
    let name_owned = name.clone();
    let id_owned = id.clone();
    let kind_owned = kind.to_string();
    // Parsing is CPU-heavy and can hang on hostile input — run it on the
    // blocking pool with a hard timeout so the UI never freezes.
    let parsed = tauri::async_runtime::spawn_blocking(move || match kind {
        "docx" => parse_docx(&bytes, &name, &id),
        "xlsx" => parse_xlsx(&bytes, &name, &id),
        _ => Err("unsupported file type".to_string()),
    });
    let (model, resources, size) =
        tokio::time::timeout(std::time::Duration::from_secs(PARSE_TIMEOUT_SECS), parsed)
            .await
            .map_err(|_| {
                format!("parsing timed out after {PARSE_TIMEOUT_SECS}s — the file may be corrupt")
            })?
            .map_err(|e| e.to_string())??;

    let model_hash = sha256_hex(model.as_bytes());
    state
        .documents_write(
            &id_owned,
            &name_owned,
            &kind_owned,
            size,
            Some(&source_hash),
            1,
            None,
            &model,
            &model_hash,
            &resources,
        )
        .map_err(|e| format!("persist: {e}"))?;
    Ok(DocumentMeta {
        id: id_owned,
        name: name_owned,
        kind: kind_owned,
        size,
    })
}

#[tauri::command]
pub async fn documents_export(
    doc_id: String,
    version: Option<i64>,
    state: State<'_, Arc<DbState>>,
) -> Result<Vec<u8>, String> {
    let state = state.inner().clone();
    let doc_id_owned = doc_id.clone();
    // Rebuilding the package from the model (zip + serialization) is CPU-heavy
    // — run it on the blocking pool so the UI never freezes.
    tauri::async_runtime::spawn_blocking(move || export(&state, &doc_id_owned, version))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn documents_save(
    doc_id: String,
    base_version: i64,
    name: String,
    bytes: Vec<u8>,
    state: State<'_, Arc<DbState>>,
) -> Result<i64, String> {
    let state = state.inner().clone();
    let doc_id_owned = doc_id.clone();
    let name_owned = name.clone();
    // Re-parsing edited bytes into the canonical model is CPU-heavy — run it on
    // the blocking pool with a hard timeout so the UI never freezes.
    let task = tauri::async_runtime::spawn_blocking(move || {
        save_edited(&state, &doc_id_owned, base_version, &name_owned, &bytes)
    });
    tokio::time::timeout(std::time::Duration::from_secs(PARSE_TIMEOUT_SECS), task)
        .await
        .map_err(|_| {
            format!("save timed out after {PARSE_TIMEOUT_SECS}s — the file may be corrupt")
        })?
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn documents_versions(
    doc_id: String,
    state: State<'_, Arc<DbState>>,
) -> Result<Vec<(i64, i64)>, String> {
    let state = state.inner().clone();
    let doc_id_owned = doc_id.clone();
    tauri::async_runtime::spawn_blocking(move || state.documents_versions(&doc_id_owned))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn documents_delete(
    doc_id: String,
    state: State<'_, Arc<DbState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    let doc_id_owned = doc_id.clone();
    tauri::async_runtime::spawn_blocking(move || state.documents_delete(&doc_id_owned))
        .await
        .map_err(|e| e.to_string())?
}

/// Generate a fresh document id on the backend.
pub fn new_doc_id() -> String {
    format!("doc-{}-{}", now_ms(), fastrand_fragment())
}

fn fastrand_fragment() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
