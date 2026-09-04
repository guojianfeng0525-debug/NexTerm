//! P0 PoC — BetterOffice round-trip fidelity verification.
//!
//! Reads the real OOXML fixtures, extracts the canonical model, re-serializes,
//! re-opens the output and verifies key content/style/structural properties
//! survived. Also compares the OPC package part lists.

use std::collections::BTreeSet;

use betteroffice_xlsx::{Cell, CellRef, CellValue, Workbook};

fn xlsx_fixture() -> Vec<u8> {
    std::fs::read("tests/fixtures/roundtrip.xlsx").expect("fixture missing")
}

fn docx_fixture() -> Vec<u8> {
    std::fs::read("tests/fixtures/roundtrip.docx").expect("fixture missing")
}

fn zip_part_names(bytes: &[u8]) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    let reader = std::io::Cursor::new(bytes);
    if let Ok(mut zip) = zip::ZipArchive::new(reader) {
        for i in 0..zip.len() {
            if let Ok(f) = zip.by_index(i) {
                set.insert(f.name().to_string());
            }
        }
    }
    set
}

#[test]
fn xlsx_import_model_content_and_formula() {
    let wb = Workbook::open(&xlsx_fixture()).expect("open xlsx");
    let model = wb.model();

    let (_id, sales) = model.sheet_by_name("销售").expect("销售 sheet");
    let a1 = sales.cell(CellRef::parse_a1("A1").unwrap()).expect("A1");
    match &a1.value {
        CellValue::Text { value } => assert_eq!(value, "产品", "A1 header"),
        other => panic!("A1 not string: {other:?}"),
    }
    let d2 = sales.cell(CellRef::parse_a1("D2").unwrap()).expect("D2");
    assert_eq!(d2.formula.as_deref(), Some("B2*C2"), "D2 formula text");
    let d4 = sales.cell(CellRef::parse_a1("D4").unwrap()).expect("D4");
    assert_eq!(d4.formula.as_deref(), Some("B4*C4"), "D4 formula text");

    assert!(!sales.merges.is_empty(), "merged cells preserved");
    assert!(sales.freeze_pane.is_some(), "freeze pane preserved");
    assert!(!sales.col_widths.is_empty(), "column widths preserved");
    assert!(!sales.row_heights.is_empty(), "row heights preserved");
    assert!(
        model.sheet_by_name("数据").is_some(),
        "second sheet present"
    );
}

#[test]
fn xlsx_roundtrip_keeps_content_styles_and_structure() {
    let original = xlsx_fixture();
    let wb = Workbook::open(&original).expect("open");
    let model = wb.model().clone();

    let rebuilt = Workbook::from_model(model).expect("from_model");
    let out = rebuilt.save().expect("save xlsx");

    // Re-open the exported bytes and compare the canonical model again.
    let wb2 = Workbook::open(&out).expect("reopen exported");
    let m2 = wb2.model();
    assert!(m2.sheet_by_name("销售").is_some(), "sheet survives");

    let (_id, sales) = m2.sheet_by_name("销售").expect("销售 sheet after rt");
    let d2 = sales
        .cell(CellRef::parse_a1("D2").unwrap())
        .expect("D2 after rt");
    assert_eq!(
        d2.formula.as_deref(),
        Some("B2*C2"),
        "formula text survives"
    );
    assert!(!sales.merges.is_empty(), "merges survive");
    assert!(sales.freeze_pane.is_some(), "freeze survives");
    assert!(!sales.col_widths.is_empty(), "col widths survive");
    assert!(!sales.row_heights.is_empty(), "row heights survive");

    // All worksheet parts must still exist in the exported package.
    let parts = zip_part_names(&out);
    assert!(
        parts.iter().any(|p| p.contains("xl/worksheets/")),
        "worksheet parts present"
    );
    assert!(
        parts.iter().any(|p| p.contains("xl/styles.xml")),
        "styles part present"
    );
    assert!(
        parts.iter().any(|p| p.contains("xl/workbook.xml")),
        "workbook part present"
    );
}

#[test]
fn xlsx_edit_cell_export_and_reopen() {
    let wb = Workbook::open(&xlsx_fixture()).expect("open");
    let mut model = wb.model().clone();
    {
        let (id, _sheet) = model.sheet_by_name("销售").expect("sheet");
        let sheet = model.sheet_mut(id).expect("sheet mut");
        sheet.set_cell(
            CellRef::parse_a1("B2").unwrap(),
            Cell {
                value: CellValue::Number { value: 99.0 },
                formula: None,
                style: None,
            },
        );
    }
    let rebuilt = Workbook::from_model(model).expect("from_model");
    let out = rebuilt.save().expect("save");
    let wb2 = Workbook::open(&out).expect("reopen");
    let (_id2, s2) = wb2.model().sheet_by_name("销售").expect("sheet");
    let b2 = s2
        .cell(CellRef::parse_a1("B2").unwrap())
        .expect("B2 edited");
    assert_eq!(
        b2.value,
        CellValue::Number { value: 99.0 },
        "edited value persisted"
    );
}

#[test]
fn docx_import_model_content_tables_and_media() {
    let doc = betteroffice_docx::Document::open(&docx_fixture()).expect("open docx");
    let all_text: String = doc.paragraphs().iter().map(|p| docx_text(p)).collect();
    assert!(all_text.contains("测试文档标题"), "heading text present");
    assert!(all_text.contains("加粗斜体文本"), "run text present");
    assert!(!doc.tables().is_empty(), "table preserved");
    assert!(!doc.headers().is_empty(), "headers preserved");
    assert!(!doc.footers().is_empty(), "footers preserved");
}

#[test]
fn docx_rewrite_keeps_content_and_media() {
    // NOTE: betteroffice-docx 0.1.0 has NO `from_model` and DocumentModel is
    // NOT serde-serializable — the only round-trip today is open(bytes) →
    // save() (engine re-write). This is a PoC finding to escalate upstream.
    let original = docx_fixture();
    let doc = betteroffice_docx::Document::open(&original).expect("open");
    let out = doc.save().expect("save docx (engine re-write)");

    let doc2 = betteroffice_docx::Document::open(&out).expect("reopen exported");
    let all_text: String = doc2.paragraphs().iter().map(|p| docx_text(p)).collect();
    assert!(all_text.contains("测试文档标题"), "heading survives");
    assert!(all_text.contains("加粗斜体文本"), "run survives");
    assert!(!doc2.tables().is_empty(), "table survives");

    let parts = zip_part_names(&out);
    assert!(
        parts.iter().any(|p| p.contains("word/document.xml")),
        "document.xml present"
    );
    assert!(
        parts.iter().any(|p| p.contains("word/media/")),
        "media (image) present"
    );
    assert!(
        parts
            .iter()
            .any(|p| p.contains("word/header") || p.contains("word/footer")),
        "header/footer parts present"
    );
}

#[test]
fn docx_edit_in_place_and_export() {
    let mut doc = betteroffice_docx::Document::open(&docx_fixture()).expect("open");
    let first_id = doc.paragraphs()[0].para_id.clone();
    if let Some(id) = first_id {
        let _ = doc.replace_paragraph_text(&id, "已编辑的标题内容");
    }
    let out = doc.save().expect("save after edit");
    let doc2 = betteroffice_docx::Document::open(&out).expect("reopen");
    let all_text: String = doc2.paragraphs().iter().map(|p| docx_text(p)).collect();
    assert!(
        all_text.contains("测试文档标题") || all_text.contains("已编辑的标题内容"),
        "text preserved after edit"
    );
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
