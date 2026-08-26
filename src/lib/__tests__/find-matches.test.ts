import { describe, expect, it } from "vitest";
import {
  findCellMatches,
  nextFindIndex,
  previousFindIndex,
} from "@/lib/database/find-matches";

const rows = [
  ["Alpha", null, "beta"],
  ["ALPHA!", "beta", null],
  [null, "gamma", "BetA"],
] as const;

describe("findCellMatches (B-6)", () => {
  it("matches case-insensitively with contains semantics", () => {
    expect(findCellMatches(rows, "beta")).toEqual([
      { row: 0, column: 2 },
      { row: 1, column: 1 },
      { row: 2, column: 2 },
    ]);
  });

  it("skips NULL cells", () => {
    // "alpha" appears in row 0 col 0 and row 1 col 0; NULL cells are skipped.
    expect(findCellMatches(rows, "alpha")).toEqual([
      { row: 0, column: 0 },
      { row: 1, column: 0 },
    ]);
  });

  it("returns no matches for empty text", () => {
    expect(findCellMatches(rows, "")).toEqual([]);
    expect(findCellMatches(rows, "  ")).toEqual([]);
  });

  it("returns no matches when nothing contains the needle", () => {
    expect(findCellMatches(rows, "zzz")).toEqual([]);
  });
});

describe("nextFindIndex / previousFindIndex (B-2)", () => {
  it("wraps forward", () => {
    expect(nextFindIndex(0, 3)).toBe(1);
    expect(nextFindIndex(2, 3)).toBe(0);
  });

  it("wraps backward", () => {
    expect(previousFindIndex(0, 3)).toBe(2);
    expect(previousFindIndex(2, 3)).toBe(1);
  });

  it("stays at 0 when there are no matches", () => {
    expect(nextFindIndex(0, 0)).toBe(0);
    expect(previousFindIndex(0, 0)).toBe(0);
  });
});
