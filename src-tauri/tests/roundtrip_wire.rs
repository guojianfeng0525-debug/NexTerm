//! P0-2 — DOCX wire-based persistence PoC.
//!
//! Validates the "SQLite stores structured wire JSON + non-editor parts as
//! BLOBs (no original file)" design:
//!   1. open docx → extract editor wire parts (body/headers/footers/footnotes/
//!      endnotes/relationships/numbering) → serialize each to JSON
//!   2. unzip the package → non-editor parts (media/fonts/theme/settings/
//!      content-types/rels/styles…) kept as raw bytes
//!   3. rebuild: re-zip the BLOB parts as the package bottom + deserialize
//!      wire JSON → S13SaveRequest → write_docx_s13 → .docx bytes
//!   4. verify media bytes are identical and content/header/footer survive

use std::collections::BTreeSet;

use docx_parse::serializer::{
    S13SaveOptions, S13SaveRequest, SerializerDeterminism, write_docx_s13,
};
use docx_parse::NumberingDefinitions;
use docx_parse::{DocumentBody, HeaderFooter, Note, Relationship};

fn fixture() -> Vec<u8> {
    std::fs::read("tests/fixtures/roundtrip.docx").expect("fixture missing")
}

/// Editor parts the S13 serializer rewrites; everything else is kept as a BLOB.
fn is_editor_part(path: &str) -> bool {
    path == "word/document.xml"
        || path.starts_with("word/header")
        || path.starts_with("word/footer")
        || path == "word/footnotes.xml"
        || path == "word/endnotes.xml"
        || path == "word/numbering.xml"
}

#[test]
fn docx_wire_roundtrip_keeps_content_media_and_headers() {
    let original = fixture();

    // 1. Parse → extract the wire fields that S13SaveRequest needs.
    let doc = betteroffice_docx::Document::open(&original).expect("open");
    let m = doc.model();
    let body_json = serde_json::to_string(&m.body).expect("body json");
    let headers_json = serde_json::to_string(&m.headers).expect("headers json");
    let footers_json = serde_json::to_string(&m.footers).expect("footers json");
    let footnotes_json = serde_json::to_string(&m.footnotes).expect("footnotes json");
    let endnotes_json = serde_json::to_string(&m.endnotes).expect("endnotes json");
    let rels_json = serde_json::to_string(&m.relationships).expect("rels json");
    let numbering_json = serde_json::to_string(&m.numbering).expect("numbering json");

    // 2. Split the package: editor parts → wire (rebuilt), others → BLOBs.
    let parts = ooxml_opc::unzip_parts(&original).expect("unzip");
    let mut blobs: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, data) in &parts {
        if !is_editor_part(name) {
            blobs.push((name.clone(), data.clone()));
        }
    }
    assert!(blobs.iter().any(|(n, _)| n.contains("word/media/")), "media blob kept");
    assert!(blobs.iter().any(|(n, _)| n == "[Content_Types].xml"), "content types kept");

    // 3. Rebuild: BLOBs → package bottom zip, wire JSON → S13 request.
    let bottom = zip_blobs(&blobs);
    let body: DocumentBody = serde_json::from_str(&body_json).expect("body from json");
    let headers: Vec<(String, HeaderFooter)> = serde_json::from_str(&headers_json).expect("headers");
    let footers: Vec<(String, HeaderFooter)> = serde_json::from_str(&footers_json).expect("footers");
    let footnotes: Vec<Note> = serde_json::from_str(&footnotes_json).expect("footnotes");
    let endnotes: Vec<Note> = serde_json::from_str(&endnotes_json).expect("endnotes");
    let rels: Vec<(String, Relationship)> = serde_json::from_str(&rels_json).expect("rels");
    let numbering: NumberingDefinitions = serde_json::from_str(&numbering_json).expect("numbering");

    // seed must be a SHA-256 hex digest; now = ISO-ish timestamp string.
    let seed = hex_of_sha256(b"nexterm-docx-wire-poc");
    let request = S13SaveRequest {
        determinism: SerializerDeterminism { seed, now: "2026-01-01T00:00:00.000Z".to_owned() },
        document: body,
        header_entries: headers,
        footer_entries: footers,
        footnotes,
        endnotes,
        footnote_separators: Vec::new(),
        endnote_separators: Vec::new(),
        relationship_entries: rels,
        numbering: Some(numbering),
        options: S13SaveOptions {
            update_modified_date: false,
            modified_by: None,
        },
        selective: None,
    };
    let exported = write_docx_s13(request, &bottom).expect("write_docx_s13");

    // 4. Verify.
    let out_parts = ooxml_opc::unzip_parts(&exported).expect("unzip exported");
    let out_map: std::collections::HashMap<String, Vec<u8>> =
        out_parts.into_iter().collect();

    // Media bytes identical to the original.
    for (name, data) in &blobs {
        if name.contains("word/media/") {
            assert_eq!(out_map.get(name), Some(data), "media {name} byte-identical");
        }
    }
    // Content survives.
    let doc2 = betteroffice_docx::Document::open(&exported).expect("reopen exported");
    let all_text: String = doc2.paragraphs().iter().map(|p| docx_text(p)).collect();
    assert!(all_text.contains("测试文档标题"), "heading survives wire rebuild");
    assert!(all_text.contains("加粗斜体文本"), "run survives");
    assert!(!doc2.tables().is_empty(), "table survives");
    // Header/footer survive.
    assert!(!doc2.headers().is_empty(), "headers survive");
    assert!(!doc2.footers().is_empty(), "footers survive");
}

fn zip_blobs(blobs: &[(String, Vec<u8>)]) -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in blobs {
        zip.start_file(name, opts).expect("start_file");
        use std::io::Write;
        zip.write_all(data).expect("write");
    }
    let cursor = zip.finish().expect("finish zip");
    cursor.into_inner()
}

fn docx_text(p: &betteroffice_docx::Paragraph) -> String {
    use betteroffice_docx::{ParagraphContent, RunContent};
    let mut s = String::new();
    for content in &p.content {
        if let ParagraphContent::Inline(inline) = content {
            if let betteroffice_docx::InlineNode::Run(r) = inline {
                for rc in &r.content {
                    if let RunContent::Text { text, .. } = rc {
                        s.push_str(text);
                    }
                }
            }
        }
    }
    s
}

#[allow(dead_code)]
fn _part_set(bytes: &[u8]) -> BTreeSet<String> {
    ooxml_opc::unzip_parts(bytes)
        .map(|parts| parts.into_iter().map(|(n, _)| n).collect())
        .unwrap_or_default()
}

fn hex_of_sha256(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
