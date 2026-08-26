/**
 * Step 2 (v2.10.0): SQL formatter wrapper unit tests.
 * Covers AC-1 (content protection), AC-2 (selection-only formatting) and
 * AC-3 (statement boundaries preserved) from
 * docs/database/sql-formatting-competitor-analysis.md §6.1.
 */
import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../database/sql-statement-tokenizer";
import {
  extractProtectedSegments,
  formatDdl,
  formatSql,
  formatSqlSelection,
  PG_SQL_FORMAT_DEFAULTS,
} from "../database/sql-formatter";

const COMPRESSED_SQL =
  "SELECT u.id,u.name,count(o.id) AS order_count FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.status='active' AND u.created_at>='2026-01-01' GROUP BY u.id,u.name HAVING count(o.id)>0 ORDER BY order_count DESC LIMIT 10;";

function normalizeWhitespace(sql: string): string {
  // The formatter only rewrites whitespace and keyword casing — never tokens —
  // so statements are "identical" when equal after stripping all whitespace
  // and lowercasing (keywordCase may change keywords).
  return sql.replace(/\s+/g, "").toLowerCase();
}

function statementTexts(sql: string): string[] {
  return splitSqlStatements(sql).map((range) =>
    normalizeWhitespace(sql.slice(range.start, range.end)),
  );
}

describe("formatSql", () => {
  it("uppercases keywords and puts one clause per line (Navicat-style baseline)", () => {
    const formatted = formatSql(COMPRESSED_SQL);
    expect(formatted).toContain("SELECT\n");
    expect(formatted).toContain("FROM\n");
    expect(formatted).toContain("WHERE\n");
    expect(formatted).toContain("GROUP BY\n");
    expect(formatted).toContain("HAVING\n");
    expect(formatted).toContain("ORDER BY\n");
    expect(formatted).toMatch(/LEFT JOIN orders o ON o\.user_id = u\.id/);
    expect(formatted).toContain("'active'");
    // Clause keywords appear uppercase at line starts.
    expect(formatted).toMatch(/^SELECT$/m);
    expect(formatted).toMatch(/^FROM$/m);
    expect(formatted).toMatch(/^WHERE$/m);
    expect(formatted).toMatch(/^GROUP BY$/m);
    expect(formatted).toMatch(/^ORDER BY$/m);
  });

  it("AC-1: never rewrites string literals, comments or dollar-quoted bodies", () => {
    const sql = [
      "select 'Mixed Case String; with ;; semicolons' as a,",
      "  \"MixedCaseIdent\" as b -- keep this comment as-is",
      "from t /* block comment with select from where */",
      "where fn() = $tag$body; select 'fake'$tag$ and name ilike 'a%';",
    ].join("\n");
    const formatted = formatSql(sql);
    const before = extractProtectedSegments(sql);
    const after = extractProtectedSegments(formatted);
    expect(after).toEqual(before);
  });

  it("AC-1: preserves escaped quote content", () => {
    const sql = "select 'it''s fine' from t where c = 'a''b';";
    const formatted = formatSql(sql);
    expect(formatted).toContain("'it''s fine'");
    expect(formatted).toContain("'a''b'");
    expect(extractProtectedSegments(formatted)).toEqual(extractProtectedSegments(sql));
  });

  it("AC-3: statement boundaries survive formatting (normalized statements equal)", () => {
    const multi = [
      "insert into t(a,b) values(1,'x');",
      COMPRESSED_SQL,
      "update t set a=2 where b='y';",
    ].join("\n");
    const formatted = formatSql(multi);
    expect(statementTexts(formatted)).toEqual(statementTexts(multi));
    expect(statementTexts(formatted)).toHaveLength(3);
  });

  it("PG specifics: :: cast, ILIKE and dollar-quote body are untouched", () => {
    const formatted = formatSql(
      "select id::text, body from t where name ilike 'a%' and body = $tag$hello; world$tag$;",
    );
    expect(formatted).toContain("id::text");
    expect(formatted).toContain("ILIKE 'a%'");
    expect(formatted).toContain("$tag$hello; world$tag$");
  });

  it("keeps identifier casing (no identifier rewriting)", () => {
    const formatted = formatSql("select MyColumn from MyTable;");
    expect(formatted).toContain("MyColumn");
    expect(formatted).toContain("MyTable");
  });

  it("returns input unchanged for empty/whitespace-only text", () => {
    expect(formatSql("")).toBe("");
    expect(formatSql("   \n\t ")).toBe("   \n\t ");
  });

  it("R-5 fallback: returns the original text when the formatter throws", () => {
    // Malformed input that cannot be formatted still yields the original bytes.
    const broken = "SELEC ~~ (( 'unterminated";
    expect(formatSql(broken)).toBe(broken);
  });

  it("applies custom options (lower keywords, 4-space indent)", () => {
    const formatted = formatSql("SELECT a FROM t;", {
      keywordCase: "lower",
      indentWidth: 4,
    });
    expect(formatted).toContain("select");
    expect(formatted).toContain("from");
    expect(formatted).not.toMatch(/\bSELECT\b/);
  });

  it("defaults are Navicat-style (uppercase keywords)", () => {
    expect(PG_SQL_FORMAT_DEFAULTS.keywordCase).toBe("upper");
    expect(PG_SQL_FORMAT_DEFAULTS.indentWidth).toBeGreaterThanOrEqual(2);
    expect(PG_SQL_FORMAT_DEFAULTS.indentWidth).toBeLessThanOrEqual(4);
  });
});

describe("formatSqlSelection (AC-2)", () => {
  const fragment = "select c,d from u where x=1;";

  it("formats the selected fragment with uppercase keywords and clause breaks", () => {
    const formatted = formatSqlSelection(fragment);
    expect(formatted).toMatch(/^SELECT/);
    expect(formatted).toContain("WHERE");
    expect(formatted).toContain("x = 1;");
  });

  it("formats a mid-expression fragment (selection may not be a full statement)", () => {
    const formatted = formatSqlSelection("u.id,u.name,count(o.id)");
    expect(formatted).toContain("u.id");
    expect(formatted).toContain("count(o.id)");
  });

  it("returns empty/whitespace-only fragments unchanged", () => {
    expect(formatSqlSelection("")).toBe("");
    expect(formatSqlSelection("   \n\t ")).toBe("   \n\t ");
  });

  it("returns the original bytes when the formatter cannot process the fragment", () => {
    const broken = "SELEC ~~ (( 'unterminated";
    expect(formatSqlSelection(broken)).toBe(broken);
  });

  it("accepts custom options", () => {
    const formatted = formatSqlSelection("SELECT a FROM t;", {
      keywordCase: "lower",
    });
    expect(formatted).toContain("select");
    expect(formatted).not.toMatch(/\bSELECT\b/);
  });

  it("splice contract: caller replaces only the selection range, so text outside stays byte-identical", () => {
    const doc = "select a,b from t;\nselect c,d from u where x=1;\nselect e from v;";
    const from = doc.indexOf("select c");
    const to = doc.indexOf("x=1;") + 4;
    const selected = doc.slice(from, to);
    const formatted = formatSqlSelection(selected);
    const text = doc.slice(0, from) + formatted + doc.slice(to);
    expect(text.startsWith("select a,b from t;\n")).toBe(true);
    expect(text.endsWith("\nselect e from v;")).toBe(true);
    expect(text.slice(from, from + formatted.length)).toMatch(/^SELECT/);
  });
});

describe("formatDdl", () => {
  it("AC-6: renders single-line Rust DDL output as multi-line formatted SQL", () => {
    const rawDdl =
      'CREATE TABLE "public"."users" ( "id" serial NOT NULL, "name" varchar(100), CONSTRAINT users_pkey PRIMARY KEY ("id") );';
    const formatted = formatDdl(rawDdl);
    expect(formatted.split("\n").length).toBeGreaterThan(1);
    expect(formatted).toContain("CREATE TABLE");
    expect(formatted).toContain('"id" serial NOT NULL');
    expect(formatted).toContain("PRIMARY KEY");
    expect(formatted).toMatch(/;$|\);\s*$/);
  });

  it("formats view DDL", () => {
    const raw = "CREATE OR REPLACE VIEW public.v_users AS select id,name from users;";
    const formatted = formatDdl(raw);
    expect(formatted).toContain("CREATE OR REPLACE VIEW public.v_users");
    expect(formatted).toMatch(/^SELECT$/m);
    expect(formatted).toMatch(/^FROM$/m);
    expect(formatted).toContain("users;");
  });
});
