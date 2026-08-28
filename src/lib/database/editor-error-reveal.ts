import type { Text } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/**
 * Editor error-line reveal (feature-design §2.5).
 *
 * Server-side `LINE n` is relative to the first line of the *sent* statement,
 * while the editor shows the whole document (comments, leading statements …).
 * `resolveAbsoluteLineNumber` converts the relative line to an absolute editor
 * line using the statement range from `currentStatementAt`; `revealEditorLine`
 * then moves the cursor, scrolls the line into view, marks the line with a
 * red wavy underline that fades out after 2 s (ux-spec §2.2.1), and focuses
 * the editor.
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

/* ── Error-line mark (wavy underline, 2 s fade-out — ux-spec §2.2.1) ── */

/** Effect carrying the document position of the line to mark. */
const setErrorMark = StateEffect.define<number>();
const clearErrorMark = StateEffect.define<null>();

/** Line decoration: red wavy underline + a soft destructive background that
 *  animates away (`cm-error-line` keyframes live in the app stylesheet). */
const errorLineDecoration = Decoration.line({
  class: "cm-error-line",
});

interface ErrorMarkState {
  readonly pos: number | null;
}

const errorMarkField = StateField.define<ErrorMarkState>({
  create: () => ({ pos: null }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorMark)) return { pos: effect.value };
      if (effect.is(clearErrorMark)) return { pos: null };
    }
    if (value.pos == null) return value;
    const mapped = tr.changes.mapPos(value.pos);
    return mapped === value.pos ? value : { pos: mapped };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      // Line decorations resolve to the line containing `pos` at draw time,
      // so no document access is needed here.
      value.pos == null ? Decoration.none : Decoration.set([errorLineDecoration.range(value.pos)]),
    ),
});

/** CodeMirror extension registering the error-line mark field. Mount once in
 *  the editor's extension list (e.g. the query editor of each DB tool). */
export const errorLineMarkExtension = () => [errorMarkField];

/** Duration the wavy underline stays visible before fading out. */
export const ERROR_LINE_FADE_MS = 2_000;

/**
 * Scrolls the editor to the failing line, moves the selection there, marks
 * the line with a fading wavy underline and focuses the view.
 *
 * @param view Target CodeMirror instance (the tool's query editor).
 * @param statementRange Range of the sent statement, or null when unknown.
 * @param relativeLine Server `LINE n` (1-based, relative to the statement).
 */
export function revealEditorLine(
  view: EditorViewType,
  statementRange: StatementRange | null,
  relativeLine: number,
): void {
  const absLine = resolveAbsoluteLineNumber(view.state.doc, statementRange, relativeLine);
  const target = view.state.doc.line(absLine);
  view.dispatch({
    selection: { anchor: target.from },
    effects: [
      EditorView.scrollIntoView(target.from, { y: "center" }),
      setErrorMark.of(target.from),
    ],
  });
  view.focus();
  // Auto-clear after the fade window; restarting an in-flight timer is fine
  // (re-revealing the same line re-triggers the 2 s window). Guard on the
  // DOM still being connected — dispatching on a destroyed view throws.
  window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: clearErrorMark.of(null) });
  }, ERROR_LINE_FADE_MS);
}
