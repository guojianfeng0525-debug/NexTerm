import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  resolveAbsoluteLineNumber,
  revealEditorLine,
  type StatementRange,
} from "../editor-error-reveal";

const DOC_LINES = ["-- leading comment", "SELECT 1;", "SELECT * FROM users;", "SELECT 2;"];

function makeDoc(): Text {
  return Text.of(DOC_LINES);
}

/** Build a view mounted on a real DOM container so focus() behaves. */
function makeView(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc }),
    parent,
  });
  return { view, parent };
}

let cleanupViews: EditorView[] = [];

afterEach(() => {
  for (const view of cleanupViews) view.destroy();
  cleanupViews = [];
  document.body.innerHTML = "";
});

describe("resolveAbsoluteLineNumber", () => {
  it("maps relative line 1 to the statement's first line", () => {
    const doc = makeDoc();
    // "SELECT * FROM users;" starts on line 3 (1-based).
    const range: StatementRange = { start: doc.line(3).from, end: doc.line(3).to };
    expect(resolveAbsoluteLineNumber(doc, range, 1)).toBe(3);
  });

  it("adds the relative offset within the statement", () => {
    const doc = makeDoc();
    const range: StatementRange = { start: doc.line(3).from, end: doc.line(3).to };
    expect(resolveAbsoluteLineNumber(doc, range, 2)).toBe(4);
  });

  it("uses line 1 as base when no statement range is given", () => {
    const doc = makeDoc();
    expect(resolveAbsoluteLineNumber(doc, null, 2)).toBe(2);
  });

  it("clamps below to line 1", () => {
    const doc = makeDoc();
    expect(resolveAbsoluteLineNumber(doc, null, 0)).toBe(1);
    expect(resolveAbsoluteLineNumber(doc, null, -5)).toBe(1);
  });

  it("clamps above to the last document line", () => {
    const doc = makeDoc();
    const range: StatementRange = { start: doc.line(4).from, end: doc.line(4).to };
    expect(resolveAbsoluteLineNumber(doc, range, 10)).toBe(doc.lines);
  });
});

describe("revealEditorLine", () => {
  it("dispatches a selection on the absolute target line and focuses", () => {
    const { view } = makeView(DOC_LINES.join("\n"));
    cleanupViews.push(view);

    const doc = view.state.doc;
    const range: StatementRange = { start: doc.line(3).from, end: doc.line(3).to };
    revealEditorLine(view, range, 1);

    const target = doc.line(3);
    expect(view.state.selection.main.anchor).toBe(target.from);
    expect(view.hasFocus).toBe(true);
  });

  it("handles a null statement range (whole document)", () => {
    const { view } = makeView("a\nb\nc\nd");
    cleanupViews.push(view);

    revealEditorLine(view, null, 4);
    const target = view.state.doc.line(4);
    expect(view.state.selection.main.anchor).toBe(target.from);
  });

  it("clamps an out-of-range relative line to the last document line", () => {
    const { view } = makeView("a\nb\nc");
    cleanupViews.push(view);

    revealEditorLine(view, null, 999);
    const last = view.state.doc.line(view.state.doc.lines);
    expect(view.state.selection.main.anchor).toBe(last.from);
  });
});
