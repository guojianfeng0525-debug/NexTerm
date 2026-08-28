/**
 * Transient range highlighting for query editors (ux-spec §4.4 / L1).
 *
 * `flashEditorRange(view, from, to)` paints the range with a temporary
 * `bg-primary/10` decoration that is removed after ~2s. Pure CodeMirror — no
 * React — so it can be unit-tested in isolation. The field is injected on
 * demand via `StateEffect.appendConfig`, keeping the shared `CodeEditor`
 * component free of flash-specific wiring.
 */

import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/** How long the inserted-SQL highlight stays visible (ms). */
export const FLASH_DURATION_MS = 2000;

const flashRangeEffect = StateEffect.define<{ from: number; to: number }>();
const clearFlashEffect = StateEffect.define<null>();

/** Decoration set holding the currently visible flash range (exported for
 *  unit tests via `activeFlashRange`). */
export const flashRangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flashRangeEffect)) {
        deco = Decoration.none;
        if (effect.value.to > effect.value.from) {
          deco = deco.update({
            add: [
              Decoration.mark({ class: "bg-primary/10" }).range(
                effect.value.from,
                effect.value.to,
              ),
            ],
          });
        }
      } else if (effect.is(clearFlashEffect)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Views that already have `flashRangeField` injected (appendConfig is not
 *  idempotent for a StateField). */
const injectedViews = new WeakSet<EditorView>();

function ensureFlashField(view: EditorView): void {
  if (injectedViews.has(view)) return;
  injectedViews.add(view);
  view.dispatch({ effects: StateEffect.appendConfig.of([flashRangeField]) });
}

/** The currently flashed range, or null. Test/assertion helper. */
export function activeFlashRange(view: EditorView): { from: number; to: number } | null {
  if (!injectedViews.has(view)) return null;
  const deco = view.state.field(flashRangeField);
  let result: { from: number; to: number } | null = null;
  deco.between(0, view.state.doc.length, (from, to) => {
    result = { from, to };
  });
  return result;
}

/**
 * Highlights `[from, to)` for `FLASH_DURATION_MS`, then removes it. The
 * selection is untouched, so callers pair this with a caret placement.
 */
export function flashEditorRange(
  view: EditorView,
  from: number,
  to: number,
): void {
  if (!view || to <= from) return;
  ensureFlashField(view);
  view.dispatch({ effects: flashRangeEffect.of({ from, to }) });
  window.setTimeout(() => {
    try {
      view.dispatch({ effects: clearFlashEffect.of(null) });
    } catch {
      /* view already destroyed — the dispatch would throw; ignore */
    }
  }, FLASH_DURATION_MS);
}
