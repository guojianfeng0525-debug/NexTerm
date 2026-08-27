import { describe, expect, it } from "vitest";
import {
  databaseErrorResult,
  parseProviderError,
  type ParsedDatabaseError,
} from "../database-error";
import { parseMySQLError } from "../parsers/mysql-error";
import { parsePostgresError } from "../parsers/postgres-error";
import { parseSQLiteError } from "../parsers/sqlite-error";

describe("parsePostgresError", () => {
  it("strips Rust + Display prefixes and extracts message", () => {
    const parsed = parsePostgresError(
      'PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"',
    );
    expect(parsed.source).toBe("postgres");
    expect(parsed.message).toBe('syntax error at or near "SELEC"');
    expect(parsed.fullText).toContain("PostgreSQL query failed:");
  });

  it("parses LINE number, line text and caret-column position", () => {
    const parsed = parsePostgresError(
      [
        'PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"',
        "LINE 1: SELEC * FROM users",
        "        ^",
      ].join("\n"),
    );
    expect(parsed.lineNumber).toBe(1);
    expect(parsed.lineText).toBe("SELEC * FROM users");
    expect(parsed.position).toBe(9); // 8 leading spaces + caret
  });

  it("extracts SQLSTATE code when the ERROR line carries one", () => {
    const parsed = parsePostgresError(
      'PostgreSQL query failed: db error: ERROR: 23505: duplicate key value violates unique constraint "users_pkey"',
    );
    expect(parsed.code).toBe("23505");
    expect(parsed.message).toBe(
      'duplicate key value violates unique constraint "users_pkey"',
    );
  });

  it("leaves fields undefined when no LINE is present", () => {
    const parsed = parsePostgresError(
      'PostgreSQL query failed: db error: ERROR: relation "users" does not exist',
    );
    expect(parsed.message).toBe('relation "users" does not exist');
    expect(parsed.lineNumber).toBeUndefined();
    expect(parsed.lineText).toBeUndefined();
    expect(parsed.position).toBeUndefined();
    expect(parsed.code).toBeUndefined();
  });

  it("handles non-DbError text (e.g. connection refused) without ERROR line", () => {
    const parsed = parsePostgresError(
      "PostgreSQL query failed: db error: connection refused",
    );
    expect(parsed.message).toBe("connection refused");
    expect(parsed.code).toBeUndefined();
  });
});

describe("parseMySQLError", () => {
  it("extracts numeric code with SQLSTATE from the standard format", () => {
    const parsed = parseMySQLError(
      "MySQL query failed: Error 1064 (42000): You have an error in your SQL syntax; check the manual",
    );
    expect(parsed.source).toBe("mysql");
    expect(parsed.code).toBe("1064");
    expect(parsed.message).toBe(
      "You have an error in your SQL syntax; check the manual",
    );
  });

  it("extracts code without SQLSTATE", () => {
    const parsed = parseMySQLError(
      "MySQL query failed: Error 1045: Access denied for user 'root'@'localhost'",
    );
    expect(parsed.code).toBe("1045");
    expect(parsed.message).toBe("Access denied for user 'root'@'localhost'");
  });

  it("falls back to the stripped text when the format is unrecognized", () => {
    const parsed = parseMySQLError("MySQL query failed: server gone away");
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toBe("server gone away");
  });

  it("never reports a line number (MySQL client errors)", () => {
    const parsed = parseMySQLError(
      "MySQL query failed: Error 1146 (42S02): Table 'db.t' doesn't exist",
    );
    expect(parsed.lineNumber).toBeUndefined();
  });
});

describe("parseSQLiteError", () => {
  it("strips Rust + rusqlite prefixes and keeps the message", () => {
    const parsed = parseSQLiteError(
      'SQLite query failed: error returned from database: near "SELEC": syntax error',
    );
    expect(parsed.source).toBe("sqlite");
    expect(parsed.message).toBe('near "SELEC": syntax error');
    expect(parsed.code).toBeUndefined();
    expect(parsed.lineNumber).toBeUndefined();
  });

  it("keeps text untouched when no known prefix is present", () => {
    const parsed = parseSQLiteError("database is locked");
    expect(parsed.message).toBe("database is locked");
  });
});

describe("parseProviderError (registry + fallback)", () => {
  it("dispatches to the registered provider parser", () => {
    const parsed = parseProviderError("postgres", "PostgreSQL query failed: ERROR: boom");
    expect(parsed.source).toBe("postgres");
    expect(parsed.message).toBe("boom");
  });

  it("returns an unknown-source fallback for unregistered providers", () => {
    const parsed = parseProviderError("oracle", "some raw error text");
    expect(parsed.source).toBe("unknown");
    expect(parsed.message).toBe("some raw error text");
    expect(parsed.fullText).toBe("some raw error text");
  });
});

describe("databaseErrorResult", () => {
  it("wraps a parsed error into an error-kind result", () => {
    const error: ParsedDatabaseError = {
      message: "boom",
      fullText: "boom",
      source: "postgres",
    };
    const result = databaseErrorResult(error);
    expect(result.kind).toBe("error");
    expect(result.error).toBe(error);
  });
});
