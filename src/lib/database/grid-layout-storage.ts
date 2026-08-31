import type { GridLayoutState } from "./result-types";

export const DEFAULT_GRID_LAYOUT: GridLayoutState = {
  frozenCount: 0,
  widths: {},
  /** 0 = use the default row height. */
  rowHeight: 0,
  showFieldType: false,
  /** Comments on by default (DBeaver parity); legacy layouts that never
   * stored the flag fall back to this default rather than `false`. */
  showComment: true,
};

/** Layout persistence is scoped per provider/connection/schema/table so the
 * same table name under a different connection never shares layout (B18 §6.3). */
export function gridLayoutKey(
  providerId: string,
  connectionId: string,
  schema: string,
  table: string,
): string {
  return `nexterm.gridLayout.${providerId}.${connectionId}.${schema}.${table}`;
}

export function loadGridLayout(key: string): GridLayoutState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_GRID_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_GRID_LAYOUT;
    const candidate = parsed as Partial<GridLayoutState>;
    return {
      frozenCount:
        typeof candidate.frozenCount === "number" &&
        Number.isFinite(candidate.frozenCount) &&
        candidate.frozenCount >= 0
          ? candidate.frozenCount
          : 0,
      widths:
        candidate.widths && typeof candidate.widths === "object"
          ? candidate.widths
          : {},
      rowHeight:
        typeof candidate.rowHeight === "number" &&
        Number.isFinite(candidate.rowHeight) &&
        candidate.rowHeight >= 0
          ? candidate.rowHeight
          : 0,
      showFieldType: Boolean(candidate.showFieldType),
      // Only an explicitly stored boolean overrides the default; layouts
      // saved before the comment column existed (flag absent/undefined)
      // inherit `true` instead of silently hiding comments.
      showComment:
        typeof candidate.showComment === "boolean"
          ? candidate.showComment
          : DEFAULT_GRID_LAYOUT.showComment,
    };
  } catch {
    return DEFAULT_GRID_LAYOUT;
  }
}

export function saveGridLayout(key: string, layout: GridLayoutState): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // Quota or private-mode storage failure: persistence is best-effort.
  }
}
