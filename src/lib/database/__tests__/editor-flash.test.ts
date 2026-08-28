import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  activeFlashRange,
  FLASH_DURATION_MS,
  flashEditorRange,
} from "../editor-flash";

function createView(doc = "SELECT 1;"): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [] }),
    parent,
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("flashEditorRange", () => {
  it("adds a decoration over the requested range", () => {
    const view = createView("SELECT 1;");
    flashEditorRange(view, 0, 7);
    expect(activeFlashRange(view)).toEqual({ from: 0, to: 7 });
    view.destroy();
  });

  it("clears the decoration after the flash duration", () => {
    const view = createView("SELECT 1;");
    flashEditorRange(view, 0, 7);
    expect(activeFlashRange(view)).not.toBeNull();
    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(activeFlashRange(view)).toBeNull();
    view.destroy();
  });

  it("is a no-op for an empty or inverted range", () => {
    const view = createView("SELECT 1;");
    flashEditorRange(view, 3, 3);
    expect(activeFlashRange(view)).toBeNull();
    flashEditorRange(view, 5, 2);
    expect(activeFlashRange(view)).toBeNull();
    view.destroy();
  });

  it("leaves the current selection untouched", () => {
    const view = createView("SELECT 1;");
    view.dispatch({ selection: { anchor: 2, head: 5 } });
    flashEditorRange(view, 0, 7);
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(5);
    view.destroy();
  });

  it("re-flashing replaces the previous range", () => {
    const view = createView("SELECT 1;");
    flashEditorRange(view, 0, 4);
    expect(activeFlashRange(view)).toEqual({ from: 0, to: 4 });
    flashEditorRange(view, 2, 6);
    expect(activeFlashRange(view)).toEqual({ from: 2, to: 6 });
    view.destroy();
  });
});
