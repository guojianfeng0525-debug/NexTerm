import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type {
  DatabaseTabularResult,
  GridLayoutState,
} from "@/lib/database/result-types";
import { DatabaseResultPane } from "@/components/toolbox/database-result-pane";

/** jsdom has no ResizeObserver — provide a minimal controllable stand-in. */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

// Fixed viewport height for the scroll container so windowing math is exact.
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 600,
});

afterEach(() => {
  cleanup();
  MockResizeObserver.instances.length = 0;
});

const labels = {
  result: "Result",
  message: "Message",
  ready: "Ready",
  null: "NULL",
  previous: "Prev",
  next: "Next",
  rowsRange: (from: number, to: number) => `${from}-${to}`,
};

function buildResult(rowCount: number): DatabaseTabularResult {
  return {
    kind: "tabular",
    columns: Array.from({ length: 5 }, (_, c) => ({
      key: `c${c}`,
      label: `c${c}`,
      ordinal: c,
      semanticType: "text" as const,
    })),
    rows: Array.from({ length: rowCount }, (_, r) => [`v${r}`, "a", "b", "c", "d"]),
    commandTags: [],
    truncated: false,
    editability: { editable: false, primaryKeyColumnKeys: [] },
  };
}

function renderPane(result: DatabaseTabularResult, layout?: GridLayoutState) {
  return render(
    <DatabaseResultPane
      result={result}
      height={260}
      fillHeight={false}
      paged={false}
      onPrevious={() => undefined}
      onNext={() => undefined}
      labels={labels}
      layout={layout}
    />,
  );
}

describe("DatabaseResultPane row windowing", () => {
  it("renders only the window + bottom spacer for large result sets", () => {
    const { container } = renderPane(buildResult(1000));
    const tbody = container.querySelector("tbody");
    expect(tbody).not.toBeNull();
    // viewport 600px / 24px = 25 visible + 2×overscan(5) = 35 mounted rows.
    const dataRows = tbody!.querySelectorAll('tr:not([aria-hidden="true"])');
    expect(dataRows.length).toBe(35);
    // Every mounted row is forced to the uniform height so the spacer math
    // stays consistent with the real scrollbar.
    dataRows.forEach((tr) => {
      expect((tr as HTMLElement).style.height).toBe("24px");
    });
    // No top spacer at scrollTop = 0.
    expect(
      container.querySelectorAll('[data-testid="database-result-window-spacer-top"]')
        .length,
    ).toBe(0);
    // Bottom spacer fills the remainder of the grid.
    const bottom = container.querySelector(
      '[data-testid="database-result-window-spacer-bottom"] td',
    ) as HTMLElement | null;
    expect(bottom).not.toBeNull();
    expect(bottom!.style.height).toBe(`${(1000 - 35) * 24}px`);
  });

  it("honors the user row height for both rows and spacer math", () => {
    const layout: GridLayoutState = {
      frozenCount: 0,
      widths: {},
      rowHeight: 36,
      showFieldType: false,
      showComment: false,
    };
    const { container } = renderPane(buildResult(500), layout);
    const tbody = container.querySelector("tbody");
    const dataRows = tbody!.querySelectorAll('tr:not([aria-hidden="true"])');
    // 600 / 36 = 17 visible + 10 overscan = 27 mounted rows.
    expect(dataRows.length).toBe(27);
    dataRows.forEach((tr) => {
      expect((tr as HTMLElement).style.height).toBe("36px");
    });
    const bottom = container.querySelector(
      '[data-testid="database-result-window-spacer-bottom"] td',
    ) as HTMLElement | null;
    expect(bottom!.style.height).toBe(`${(500 - 27) * 36}px`);
  });

  it("keeps small result sets fully rendered without spacers", () => {
    const { container } = renderPane(buildResult(10));
    const tbody = container.querySelector("tbody");
    expect(tbody!.querySelectorAll('tr:not([aria-hidden="true"])').length).toBe(10);
    expect(
      container.querySelectorAll(
        '[data-testid="database-result-window-spacer-top"], [data-testid="database-result-window-spacer-bottom"]',
      ).length,
    ).toBe(0);
  });

  it("shows the ready message for an empty grid", () => {
    const { container } = renderPane(buildResult(0));
    expect(container.textContent).toContain("Ready");
  });
});
