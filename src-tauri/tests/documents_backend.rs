//! Documents backend integration tests — import → SQLite → export round-trip
//! through the real DbState (no original-file persistence).

use std::sync::Arc;

use nexterm_lib::db::DbState;
use nexterm_lib::documents;

fn tmp_db() -> DbState {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let path = std::env::temp_dir().join(format!(
        "nexterm-doc-test-{}-{}.db",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
    ));
    let _ = std::fs::remove_file(&path);
    DbState::open(&path).expect("open db")
}

fn xlsx_bytes() -> Vec<u8> {
    std::fs::read("tests/fixtures/roundtrip.xlsx").expect("fixture")
}

fn docx_bytes() -> Vec<u8> {
    std::fs::read("tests/fixtures/roundtrip.docx").expect("fixture")
}

fn import_doc(state: &DbState, bytes: &[u8], name: &str) -> String {
    let id = format!(
        "doc-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    if name.ends_with(".xlsx") {
        let _ = Arc::new(());
        // call through the module API directly
        let meta = documents::import_xlsx(state, bytes, name, &id).expect("import xlsx");
        assert_eq!(meta.id, id);
    } else {
        let meta = documents::import_docx(state, bytes, name, &id).expect("import docx");
        assert_eq!(meta.id, id);
    }
    id
}

#[test]
fn xlsx_import_export_roundtrip() {
    let db = tmp_db();
    let bytes = xlsx_bytes();
    let id = import_doc(&db, &bytes, "报表.xlsx");

    // Model persisted, head version 1.
    let (v, model) = db
        .documents_read_model(&id, None)
        .expect("read model")
        .expect("exists");
    assert_eq!(v, 1);
    assert!(model.contains("\"sheets\""), "model has sheets: {model}");

    // Export from SQLite model.
    let exported = documents::export(&db, &id, None).expect("export");
    let wb = betteroffice_xlsx::Workbook::open(&exported).expect("reopen exported");
    let m = wb.model();
    let (_sid, sheet) = m.sheet_by_name("销售").expect("sheet");
    let d2 = sheet
        .cell(betteroffice_xlsx::CellRef::parse_a1("D2").unwrap())
        .expect("D2");
    assert_eq!(
        d2.formula.as_deref(),
        Some("B2*C2"),
        "formula survives sqlite round-trip"
    );
}

#[test]
fn docx_import_export_roundtrip() {
    let db = tmp_db();
    let bytes = docx_bytes();
    let id = import_doc(&db, &bytes, "文档.docx");

    let (v, model) = db
        .documents_read_model(&id, None)
        .expect("read model")
        .expect("exists");
    assert_eq!(v, 1);
    assert!(model.contains("\"body\""), "model has body");

    let resources = db.documents_resources(&id).expect("resources");
    assert!(
        resources
            .iter()
            .any(|(r, _, _, _)| r.contains("word/media/")),
        "media blob stored"
    );

    let exported = documents::export(&db, &id, None).expect("export");
    let doc = betteroffice_docx::Document::open(&exported).expect("reopen exported");
    let text: String = doc.paragraphs().iter().map(|p| docx_text(p)).collect();
    assert!(text.contains("测试文档标题"), "content survives");
    assert!(!doc.headers().is_empty(), "headers survive");

    // Media byte-identical between stored blob and exported package.
    let out_parts = ooxml_opc::unzip_parts(&exported).expect("unzip");
    let media = resources
        .into_iter()
        .find(|(r, _, _, _)| r.contains("word/media/"))
        .expect("media");
    let out_media = out_parts
        .iter()
        .find(|(n, _)| *n == media.0)
        .expect("media in export");
    assert_eq!(out_media.1, media.3, "media bytes identical");
}

#[test]
fn docx_save_creates_new_version() {
    let db = tmp_db();
    let bytes = docx_bytes();
    let id = import_doc(&db, &bytes, "文档.docx");

    // Simulate an editor save: bytes → new version (base 1).
    let next = documents::save_edited(&db, &id, 1, "文档.docx", &bytes).expect("save");
    assert_eq!(next, 2);

    let (v, _) = db
        .documents_read_model(&id, None)
        .expect("read")
        .expect("exists");
    assert_eq!(v, 2, "head advanced");

    let versions = db.documents_versions(&id).expect("versions");
    assert_eq!(versions.len(), 2, "two versions kept");
}

fn docx_text(p: &betteroffice_docx::Paragraph) -> String {
    use betteroffice_docx::{ParagraphContent, RunContent};
    let mut s = String::new();
    for content in &p.content {
        if let ParagraphContent::Inline(betteroffice_docx::InlineNode::Run(r)) = content {
            for rc in &r.content {
                if let RunContent::Text { text, .. } = rc {
                    s.push_str(text);
                }
            }
        }
    }
    s
}

#[test]
fn legacy_documents_table_migrates() {
    // Build a database with the OLD documents shape (type/content/edited_content),
    // then open it through DbState — the migration must rename type→kind, drop
    // the content columns, add head_version/source_hash, and allow imports.
    let path = std::env::temp_dir().join(format!("nexterm-doc-legacy-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    {
        let conn = rusqlite::Connection::open(&path).expect("open raw");
        conn.execute_batch(
            "CREATE TABLE documents (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL DEFAULT '',
               type TEXT NOT NULL DEFAULT '',
               size INTEGER NOT NULL DEFAULT 0,
               content TEXT NOT NULL DEFAULT '',
               edited_content TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )
        .expect("create legacy table");
    }
    let db = DbState::open(&path).expect("open triggers migration");

    let bytes = xlsx_bytes();
    let id = documents::import_xlsx(&db, &bytes, "旧表.xlsx", "doc-legacy-1")
        .expect("import after migration")
        .id;
    let (v, model) = db
        .documents_read_model(id.as_str(), None)
        .expect("read")
        .expect("exists");
    assert_eq!(v, 1);
    assert!(model.contains("\"sheets\""), "model persisted: {model}");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn legacy_doc_rejected_without_hanging() {
    // A real .doc is an OLE container (D0 CF 11 E0 …) — must be rejected
    // before the DOCX parser ever sees it (which used to hang the app).
    let ole: Vec<u8> = vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0];
    let err = documents::detect_ooxml_kind(&ole, "report.doc").expect_err("must reject .doc");
    assert!(err.contains("legacy OLE"), "got: {err}");
    let err2 = documents::detect_ooxml_kind(&ole, "report.docx")
        .expect_err("must reject even with docx name");
    assert!(err2.contains("legacy OLE"), "got: {err2}");

    // Random garbage is also rejected.
    let junk: Vec<u8> = vec![0x00; 64];
    let err3 = documents::detect_ooxml_kind(&junk, "x.xlsx").expect_err("junk rejected");
    assert!(err3.contains("not a valid"), "got: {err3}");
}
