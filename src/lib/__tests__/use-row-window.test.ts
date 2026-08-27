import { describe, expect, it } from "vitest";
import {
  computeRowWindow,
  ROW_WINDOW_OVERSCAN,
  ROW_WINDOW_THRESHOLD,
} from "@/lib/database/use-row-window";

describe("computeRowWindow (spacer-tr windowing)", () => {
  const H = 24;

  it("returns the full range for empty/small grids (threshold disabled)", () => {
    expect(computeRowWindow({ scrollTop: 0, viewportHeight: 600, total: 0, rowHeight: H })).toEqual({ start: 0, end: 0 });
    expect(computeRowWindow({ scrollTop: 0, viewportHeight: 600, total: 10, rowHeight: H })).toEqual({ start: 0, end: 10 });
    expect(computeRowWindow({ scrollTop: 0, viewportHeight: 600, total: ROW_WINDOW_THRESHOLD, rowHeight: H })).toEqual({ start: 0, end: ROW_WINDOW_THRESHOLD });
  });

  it("mounts a conservative leading window before the height is measured", () => {
    const { start, end } = computeRowWindow({ scrollTop: 0, viewportHeight: 0, total: 1000, rowHeight: H });
    expect(start).toBe(0);
    // 60 + 2×overscan leading rows, never the full grid.
    expect(end).toBe(ROW_WINDOW_THRESHOLD + ROW_WINDOW_OVERSCAN * 2);
    expect(end).toBeLessThan(1000);
  });

  it("keeps a mid-scroll window covering visible + 2×overscan rows", () => {
    // viewport shows 25 rows; scroll 240px → row 10 is first visible.
    const viewportHeight = 25 * H;
    const { start, end } = computeRowWindow({ scrollTop: 10 * H, viewportHeight, total: 1000, rowHeight: H });
    expect(start).toBe(10 - ROW_WINDOW_OVERSCAN);
    expect(end).toBe(start + Math.ceil(viewportHeight / H) + ROW_WINDOW_OVERSCAN * 2);
    expect(end).toBe(10 - ROW_WINDOW_OVERSCAN + 25 + ROW_WINDOW_OVERSCAN * 2);
  });

  it("clamps the window to the grid edges", () => {
    // At the very bottom: start must pull back so the window covers the end.
    const viewportHeight = 25 * H;
    const { start, end } = computeRowWindow({ scrollTop: 990 * H, viewportHeight, total: 1000, rowHeight: H });
    expect(end).toBe(1000);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(1000);
    // Top edge: no negative start.
    const top = computeRowWindow({ scrollTop: 0, viewportHeight, total: 1000, rowHeight: H });
    expect(top.start).toBe(0);
    expect(top.end).toBe(Math.ceil(viewportHeight / H) + ROW_WINDOW_OVERSCAN * 2);
  });

  it("uses the provided overscan", () => {
    const viewportHeight = 10 * H;
    const { start, end } = computeRowWindow({ scrollTop: 5 * H, viewportHeight, total: 1000, rowHeight: H, overscan: 1 });
    expect(start).toBe(5 - 1);
    expect(end).toBe(5 - 1 + 10 + 2);
  });

  it("falls back to the full range when rowHeight is invalid", () => {
    expect(computeRowWindow({ scrollTop: 100, viewportHeight: 600, total: 500, rowHeight: 0 })).toEqual({ start: 0, end: 500 });
  });
});
