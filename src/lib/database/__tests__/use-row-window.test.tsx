import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useRowWindow } from "../use-row-window";

/** Test harness that renders the hook against a real DOM container. */
function Harness({
  total,
  rowHeight,
  viewportHeight,
}: {
  total: number;
  rowHeight: number;
  viewportHeight: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const window = useRowWindow(containerRef, total, rowHeight);
  return (
    <div
      ref={containerRef}
      data-testid="container"
      data-window={JSON.stringify(window)}
      style={{ height: viewportHeight, overflow: "auto" }}
    />
  );
}

let mockViewportHeight = 480;

// jsdom reports clientHeight = 0 and has no ResizeObserver; mock both so the
// hook's viewport measurement behaves like a real browser.
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderHarness(props: {
  total: number;
  rowHeight?: number;
  viewportHeight?: number;
}) {
  const { total, rowHeight = 24, viewportHeight = 480 } = props;
  mockViewportHeight = viewportHeight;
  const result = render(<Harness total={total} rowHeight={rowHeight} viewportHeight={viewportHeight} />);
  const container = result.getByTestId("container");
  const readWindow = () =>
    JSON.parse(container.getAttribute("data-window") ?? "{}") as {
      start: number;
      end: number;
      enabled: boolean;
      scrollTop: number;
    };
  const scrollTo = (top: number) => {
    act(() => {
      container.scrollTop = top;
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(32); // let the rAF-throttled handler fire
    });
    return readWindow();
  };
  return { result, container, readWindow, scrollTo };
}

describe("useRowWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is disabled for small result sets and returns the full range", () => {
    const { readWindow } = renderHarness({ total: 40 });
    const w = readWindow();
    expect(w.enabled).toBe(false);
    expect(w.start).toBe(0);
    expect(w.end).toBe(40);
  });

  it("is enabled above the threshold with a measurable viewport", () => {
    const { readWindow } = renderHarness({ total: 200, viewportHeight: 480 });
    const w = readWindow();
    expect(w.enabled).toBe(true);
    expect(w.start).toBe(0);
    // 480 / 24 = 20 visible + 2×5 overscan = 30 mounted rows.
    expect(w.end).toBe(30);
  });

  it("mounts a conservative leading window before the height is measured", () => {
    const { readWindow } = renderHarness({ total: 500, viewportHeight: 0 });
    const w = readWindow();
    expect(w.enabled).toBe(true);
    expect(w.start).toBe(0);
    // 60 threshold + 2×5 overscan leading rows — never the full grid.
    expect(w.end).toBe(70);
  });

  it("updates the window when scrolled", () => {
    const { scrollTo } = renderHarness({ total: 500, viewportHeight: 480 });
    // Scroll to row 100 → 2400px. Window should start at 100 - 5 overscan.
    act(() => {
      vi.advanceTimersByTime(32);
    });
    const w = scrollTo(2400);
    expect(w.enabled).toBe(true);
    expect(w.start).toBe(95);
    expect(w.end).toBe(125);
  });

  it("clamps the window to the grid boundaries", () => {
    const { scrollTo } = renderHarness({ total: 100, viewportHeight: 480 });
    // Scroll past the end: 100 rows × 24 = 2400 max, ask for 5000.
    const w = scrollTo(5000);
    expect(w.enabled).toBe(true);
    expect(w.start).toBeLessThan(100);
    expect(w.end).toBe(100);
  });

  it("keeps at least viewport+overscan rows mounted at the top", () => {
    const { readWindow } = renderHarness({ total: 1000, viewportHeight: 480 });
    const w = readWindow();
    expect(w.enabled).toBe(true);
    expect(w.start).toBe(0);
    // viewportRows(20) + overscan(5) + overscan(5) = 30 at the top.
    expect(w.end).toBe(30);
  });
});
