import { describe, expect, it } from "vitest";
import {
  buildFieldValueFilter,
  isEmptyFilter,
  resolveFilterShortcut,
} from "@/lib/database/table-filter";
import type { TableFilterState } from "@/lib/database/result-types";

const active: TableFilterState = {
  logic: "AND",
  conditions: [{ column: "score", operator: "gte", value: "10" }],
  orderBy: [{ column: "score", direction: "desc" }],
};

describe("resolveFilterShortcut (A-7)", () => {
  it("replays the active filter when one is applied", () => {
    expect(resolveFilterShortcut(active)).toEqual({
      kind: "replay",
      filter: active,
    });
  });

  it("refreshes when no active filter exists", () => {
    expect(resolveFilterShortcut(undefined)).toEqual({
      kind: "refresh",
    });
  });
});

describe("isEmptyFilter (A-12)", () => {
  it("treats no conditions and no sort as empty", () => {
    expect(isEmptyFilter({ logic: "AND", conditions: [], orderBy: [] })).toBe(
      true,
    );
  });

  it("treats conditions without sort as non-empty", () => {
    expect(isEmptyFilter(active)).toBe(false);
  });

  it("treats sort-only filters as non-empty", () => {
    expect(
      isEmptyFilter({ logic: "AND", conditions: [], orderBy: active.orderBy }),
    ).toBe(false);
  });
});

describe("buildFieldValueFilter (A-2)", () => {
  it("maps a NULL cell to the isNull operator", () => {
    expect(buildFieldValueFilter("notes", null)).toEqual({
      logic: "AND",
      conditions: [{ column: "notes", operator: "isNull" }],
      orderBy: [],
    });
  });

  it("maps a text cell to an exact eq match", () => {
    expect(buildFieldValueFilter("name", "Ada")).toEqual({
      logic: "AND",
      conditions: [{ column: "name", operator: "eq", value: "Ada" }],
      orderBy: [],
    });
  });

  it("keeps an empty string as an eq match, never null semantics", () => {
    expect(buildFieldValueFilter("name", "")).toEqual({
      logic: "AND",
      conditions: [{ column: "name", operator: "eq", value: "" }],
      orderBy: [],
    });
  });
});
