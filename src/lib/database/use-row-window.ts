import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

/** Rows rendered above/below the visible window keep the scrollbar honest. */
export const ROW_WINDOW_OVERSCAN = 5;
/** Only virtualize grids big enough that full rendering hurts. */
export const ROW_WINDOW_THRESHOLD = 60;
/** Conservative leading window mounted before the container height is known,
 * so a large result set never paints its full DOM on the first frame. */
const INITIAL_WINDOW_ROWS = ROW_WINDOW_THRESHOLD + ROW_WINDOW_OVERSCAN * 2;

export interface RowWindow {
  /** First row index that must be mounted (0-based). */
  readonly start: number;
  /** One past the last mounted row index (exclusive). */
  readonly end: number;
  /** True when the grid is large enough to virtualize (total > threshold). */
  readonly enabled: boolean;
  readonly scrollTop: number;
}

export interface RowWindowArgs {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly total: number;
  readonly rowHeight: number;
  readonly overscan?: number;
}

/**
 * Pure fixed-row-height window computation (exported for unit tests).
 * Rows are uniform height (`rowHeight`), so the visible window is a pure
 * function of scrollTop and the container height.
 */
export function computeRowWindow({
  scrollTop,
  viewportHeight,
  total,
  rowHeight,
  overscan = ROW_WINDOW_OVERSCAN,
}: RowWindowArgs): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  if (rowHeight <= 0) return { start: 0, end: total };
  // Small grids never virtualize — keep the exact current DOM structure.
  if (total <= ROW_WINDOW_THRESHOLD) return { start: 0, end: total };
  // Height not measured yet: mount a conservative leading window so a large
  // result set never paints its full DOM on the first frame.
  if (viewportHeight <= 0) {
    return { start: 0, end: Math.min(total, INITIAL_WINDOW_ROWS) };
  }
  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  // Symmetric overscan: scrollTop maps to a row, back up `overscan` rows.
  // Start is clamped to the grid so an over-scrolled container cannot produce
  // an empty window.
  let start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  start = Math.min(start, Math.max(0, total - visibleRows));
  const end = Math.min(total, start + visibleRows + overscan * 2);
  return { start, end };
}

/**
 * Minimal fixed-row-height windowing for the result grid (architecture
 * decision: spacer-tr, no @tanstack/react-virtual). Only scroll + resize
 * listeners with an rAF-throttled state sync are needed. When disabled
 * (small result sets) it returns the full range so callers keep rendering
 * everything unchanged.
 */
export function useRowWindow(
  containerRef: RefObject<HTMLElement | null>,
  total: number,
  rowHeight: number,
): RowWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const rafIdRef = useRef<number | null>(null);

  // Scroll sync — rAF-throttled so a fast scroll only triggers one state
  // update per frame. useEffect is fine here: scroll never blocks first paint.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onScroll = () => {
      if (rafIdRef.current != null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        setScrollTop(node.scrollTop);
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [containerRef]);

  // Container height — useLayoutEffect so the measurement (and the resulting
  // window) is applied before the browser paints, never mounting the full DOM
  // of a large result set on its first frame.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height != null) setViewportHeight(height);
    });
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, [containerRef]);

  const enabled = total > ROW_WINDOW_THRESHOLD && rowHeight > 0;

  return useMemo(() => {
    if (!enabled) return { start: 0, end: total, enabled: false, scrollTop };
    const { start, end } = computeRowWindow({
      scrollTop,
      viewportHeight,
      total,
      rowHeight,
    });
    return { start, end, enabled: true, scrollTop };
  }, [enabled, scrollTop, viewportHeight, total, rowHeight]);
}
