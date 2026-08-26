import { describe, expect, it } from "vitest";
import {
  currentStatementAt,
  splitSqlStatements,
  toggleLineComment,
} from "@/lib/database/sql-statement-tokenizer";

describe("splitSqlStatements", () => {
  it("splits on semicolons outside strings and comments", () => {
    const sql = "SELECT 'a;b' AS v; -- comment; with semicolon\nSELECT 2; /* block; comment */ SELECT 3";
    const ranges = splitSqlStatements(sql);
    expect(ranges.length).toBe(3);
    expect(sql.slice(ranges[0].start, ranges[0].end)).toBe("SELECT 'a;b' AS v");
    expect(sql.slice(ranges[1].start, ranges[1].end)).toBe("SELECT 2");
    expect(sql.slice(ranges[2].start, ranges[2].end)).toBe("SELECT 3");
  });

  it("keeps nested block comments intact", () => {
    const sql = "SELECT 1 /* outer /* inner */ still outer */; SELECT 2";
    const ranges = splitSqlStatements(sql);
    expect(ranges.length).toBe(2);
    expect(sql.slice(ranges[0].start, ranges[0].end)).toContain("SELECT 1");
    expect(sql.slice(ranges[1].start, ranges[1].end)).toBe("SELECT 2");
  });

  it("does not split inside dollar-quoted bodies", () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN; EXECUTE 'x;y'; END; $fn$ LANGUAGE plpgsql; SELECT 1";
    const ranges = splitSqlStatements(sql);
    expect(ranges.length).toBe(2);
    expect(sql.slice(ranges[0].start, ranges[0].end)).toContain("$fn$ BEGIN; EXECUTE 'x;y'; END; $fn$");
    expect(sql.slice(ranges[1].start, ranges[1].end)).toBe("SELECT 1");
  });

  it("skips whitespace-only gaps and comment-only text", () => {
    expect(splitSqlStatements("SELECT 1   ;   \n\t SELECT 2").length).toBe(2);
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("  \n\t ")).toEqual([]);
    expect(splitSqlStatements("-- just a comment\n/* another */")).toEqual([]);
  });
});

describe("currentStatementAt", () => {
  const sql = "SELECT 1; SELECT 22; SELECT 333";

  it("finds the statement containing the caret", () => {
    const range = currentStatementAt(sql, 15);
    expect(sql.slice(range!.start, range!.end)).toBe("SELECT 22");
  });

  it("falls back to the next statement after a trailing caret", () => {
    const range = currentStatementAt(sql, 4);
    expect(sql.slice(range!.start, range!.end)).toBe("SELECT 1");
  });

  it("returns null for empty text", () => {
    expect(currentStatementAt("", 0)).toBeNull();
  });
});

describe("toggleLineComment", () => {
  it("adds -- to uncommented lines", () => {
    const result = toggleLineComment("SELECT 1\nSELECT 2", 0, 16);
    expect(result).toBe("--SELECT 1\n--SELECT 2");
  });

  it("removes -- from commented lines", () => {
    const result = toggleLineComment("--SELECT 1\n--SELECT 2", 0, 20);
    expect(result).toBe("SELECT 1\nSELECT 2");
  });

  it("preserves indentation when commenting", () => {
    const result = toggleLineComment("  SELECT 1", 0, 11);
    expect(result).toBe("  --SELECT 1");
  });
});
