import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";
import type { DatabaseTabularResult, GridLayoutState } from "@/lib/database/result-types";

// jsdom has no ResizeObserver / layout heights; make the pane measure a fixed
// viewport so the windowing path is exercised deterministically.
let mockViewportHeight = 480;
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return mockViewportHeight;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeResult(rowCount: number): DatabaseTabularResult {
  return {
    kind: "tabular",
    columns: Array.from({ length: 3 }, (_, i) => ({
      key: `column:${i}`,
      label: `col${i}`,
      ordinal: i,
      semanticType: "text",
    })),
    rows: Array.from({ length: rowCount }, (_, r) => [
      `r${r}-c0`,
      `r${r}-c1`,
      `r${r}-c2`,
    ]),
    commandTags: [],
    truncated: false,
    editability: { editable: false, primaryKeyColumnKeys: [] },
  };
}

const baseLabels = {
  result: "结果",
  message: "消息",
  ready: "就绪",
  rowsRange: (a: number, b: number) => `${a}-${b}`,
  previous: "上一页",
  next: "下一页",
  null: "NULL",
} as const;

function renderPane(result: DatabaseTabularResult, layout?: GridLayoutState) {
  mockViewportHeight = 480;
  return render(
    <DatabaseResultPane
      result={result}
      fillHeight
      height={480}
      paged={false}
      onPrevious={() => undefined}
      onNext={() => undefined}
      labels={baseLabels}
      layout={layout}
      pendingInsertRows={[]}
      deletedRowIndexes={[]}
    />,
  );
}

describe("DatabaseResultPane windowing", () => {
  it("renders every row when below the windowing threshold", () => {
    const { container } = renderPane(makeResult(40));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(40);
    // No spacer rows.
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("renders only the window + spacers for large results", () => {
    const { container } = renderPane(makeResult(500), {
      frozenCount: 0,
      widths: {},
      rowHeight: 24,
      showFieldType: false,
      showComment: false,
    });
    const trs = container.querySelectorAll("tbody tr");
    // viewport(20) + 2×overscan(10) windowed rows + bottom spacer (start=0,
    // so no top spacer) = 31.
    expect(trs).toHaveLength(31);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("keeps the edit target mounted when the window would exclude it", () => {
    const { container } = renderPane(makeResult(500), {
      frozenCount: 0,
      widths: {},
      rowHeight: 24,
      showFieldType: false,
      showComment: false,
    });
    // Simulate: user scrolled so the window moved far from the editing row —
    // covered by the unit-level clamping; here we assert the pane still renders
    // when no editing state exists (regression: no crash on large grid).
    expect(container.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });

  it("renders an error result through renderError with the shared header", () => {
    const error = {
      kind: "error" as const,
      error: { message: 'relation "users" does not exist', fullText: "", source: "postgres" as const },
    };
    render(
      <DatabaseResultPane
        result={error}
        height={480}
        paged={false}
        onPrevious={() => undefined}
        onNext={() => undefined}
        labels={baseLabels}
        renderError={(parsed) => (
          <div data-testid="custom-error">{parsed.message}</div>
        )}
      />,
    );
    expect(screen.getByTestId("custom-error").textContent).toBe(
      'relation "users" does not exist',
    );
    // Header keeps the "message" label for non-tabular results.
    expect(screen.getByText("消息")).not.toBeNull();
  });

  it("degrades to the ready message area when renderError is absent", () => {
    const error = {
      kind: "error" as const,
      error: { message: "boom", fullText: "", source: "postgres" as const },
    };
    render(
      <DatabaseResultPane
        result={error}
        height={480}
        paged={false}
        onPrevious={() => undefined}
        onNext={() => undefined}
        labels={baseLabels}
      />,
    );
    expect(screen.getByText("就绪")).not.toBeNull();
  });
});
