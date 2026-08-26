import type {
  FilterCondition,
  TableFilterState,
} from "./result-types";

/**
 * Pure decision logic for Ctrl+R in a table tab (A-7). B18 semantics: the
 * dialog applies immediately, so there is no draft state — Ctrl+R either
 * replays the active filter from offset 0 or refreshes the current page.
 */
export type FilterShortcutDecision =
  | { readonly kind: "replay"; readonly filter: TableFilterState }
  | { readonly kind: "refresh" };

export function resolveFilterShortcut(
  active?: TableFilterState,
): FilterShortcutDecision {
  if (active) return { kind: "replay", filter: active };
  return { kind: "refresh" };
}

/** An empty filter (no conditions and no sort) is equivalent to clearing it. */
export function isEmptyFilter(filter: TableFilterState): boolean {
  return filter.conditions.length === 0 && filter.orderBy.length === 0;
}

/**
 * Builds the single-condition filter used by "Filter by field value" (A-2):
 * a NULL cell maps to `isNull`; any other cell text maps to an exact `eq`
 * match. NULL semantics never travel as `eq` + null (security §5).
 */
export function buildFieldValueFilter(
  column: string,
  value: string | null,
): TableFilterState {
  const condition: FilterCondition =
    value === null
      ? { column, operator: "isNull" }
      : { column, operator: "eq", value };
  return { logic: "AND", conditions: [condition], orderBy: [] };
}
