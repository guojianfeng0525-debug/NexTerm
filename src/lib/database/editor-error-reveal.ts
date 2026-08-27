import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Editor error-line reveal (feature-design §2.5).
 *
 * Server-side `LINE n` is relative to the first line of the *sent* statement,
 * while the editor shows the whole document (comments, leading statements …).
 * `resolveAbsoluteLineNumber` converts the relative line to an absolute editor
 * line using the statement range from `currentStatementAt`; `revealEditorLine`
 * then moves the cursor, scrolls the line into view and focuses the editor.
 *
 * Highlighting stays MVP: selection jump + the already-enabled
 * `highlightActiveLine` extension (feature-design §2.5 note).
 */

/** A statement range in the document (code-unit offsets), as produced by
 *  `currentStatementAt` / `splitSqlStatements`. */
export interface StatementRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Converts a server `LINE n` (relative to the sent statement's first line)
 * into an absolute 1-based editor line number, clamped to the document.
 *
 * @param doc CodeMirror document (Text).
 * @param statementRange Range of the sent statement in the doc, or null when
 *   the whole document was sent (fall back to line 1).
 * @param relativeLine 1-based line reported by the server (LINE n).
 */
export function resolveAbsoluteLineNumber(
  doc: Text,
  statementRange: StatementRange | null,
  relativeLine: number,
): number {
  const baseLine = doc.lineAt(statementRange?.start ?? 0).number;
  const raw = baseLine + Math.max(1, Math.floor(relativeLine)) - 1;
  return Math.max(1, Math.min(raw, doc.lines));
}

/**
 * Scrolls the editor to the failing line, moves the selection there and
 * focuses the view.
 *
 * @param view Target CodeMirror instance (the tool's query editor).
 * @param statementRange Range of the sent statement, or null when unknown.
 * @param relativeLine Server `LINE n` (1-based, relative to the statement).
 */
export function revealEditorLine(
  view: EditorView,
  statementRange: StatementRange | null,
  relativeLine: number,
): void {
  const absLine = resolveAbsoluteLineNumber(view.state.doc, statementRange, relativeLine);
  const target = view.state.doc.line(absLine);
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
}
