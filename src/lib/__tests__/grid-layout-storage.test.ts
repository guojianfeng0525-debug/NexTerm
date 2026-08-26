import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GRID_LAYOUT,
  gridLayoutKey,
  loadGridLayout,
  saveGridLayout,
} from "@/lib/database/grid-layout-storage";

afterEach(() => localStorage.clear());

describe("grid layout storage (B18 Slice C)", () => {
  it("scopes the storage key per provider/connection/schema/table", () => {
    expect(gridLayoutKey("postgresql", "c1", "public", "users")).toBe(
      "nexterm.gridLayout.postgresql.c1.public.users",
    );
    expect(gridLayoutKey("postgresql", "c2", "public", "users")).not.toBe(
      gridLayoutKey("postgresql", "c1", "public", "users"),
    );
  });

  it("round-trips a layout through localStorage (C-8)", () => {
    const key = gridLayoutKey("postgresql", "c1", "public", "users");
    saveGridLayout(key, {
      frozenCount: 2,
      widths: { "column:0": 200, "column:1": 150 },
      rowHeight: 36,
      showFieldType: true,
      showComment: false,
    });
    expect(loadGridLayout(key)).toEqual({
      frozenCount: 2,
      widths: { "column:0": 200, "column:1": 150 },
      rowHeight: 36,
      showFieldType: true,
      showComment: false,
    });
  });

  it("returns the default layout when nothing is stored", () => {
    expect(loadGridLayout("nexterm.gridLayout.postgresql.c1.public.users")).toEqual(
      DEFAULT_GRID_LAYOUT,
    );
  });

  it("falls back to defaults for corrupted payloads", () => {
    localStorage.setItem(
      "nexterm.gridLayout.postgresql.c1.public.users",
      "{not json",
    );
    expect(loadGridLayout("nexterm.gridLayout.postgresql.c1.public.users")).toEqual(
      DEFAULT_GRID_LAYOUT,
    );
  });

  it("sanitizes out-of-range numeric fields", () => {
    localStorage.setItem(
      "nexterm.gridLayout.postgresql.c1.public.users",
      JSON.stringify({ frozenCount: -3, rowHeight: -10, widths: "oops" }),
    );
    expect(loadGridLayout("nexterm.gridLayout.postgresql.c1.public.users")).toEqual({
      frozenCount: 0,
      widths: {},
      rowHeight: 0,
      showFieldType: false,
      showComment: false,
    });
  });
});
