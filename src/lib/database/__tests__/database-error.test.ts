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

  it("reports position 1 when the caret sits in the first column", () => {
    const parsed = parsePostgresError(
      [
        'PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"',
        "LINE 1: SELEC * FROM users",
        "^",
      ].join("\n"),
    );
    expect(parsed.position).toBe(1);
  });

  it("keeps parsing when the error block carries extra server lines (CONTEXT/HINT)", () => {
    const parsed = parsePostgresError(
      [
        'PostgreSQL query failed: db error: ERROR: 23505: duplicate key value violates unique constraint "users_pkey"',
        "DETAIL: Key (email)=(a@b.c) already exists.",
        "LINE 1: INSERT INTO users (email) VALUES ('a@b.c')",
        "                                          ^",
        'HINT: Use a different email address.',
      ].join("\n"),
    );
    expect(parsed.code).toBe("23505");
    expect(parsed.lineNumber).toBe(1);
    expect(parsed.lineText).toContain("INSERT INTO users");
    expect(parsed.message).toContain("duplicate key value");
  });

  it("parses a LINE beyond 9 and strips leading whitespace from the line text", () => {
    const parsed = parsePostgresError(
      [
        "ERROR: invalid input syntax for type integer",
        'LINE 10: SELECT * FROM users WHERE id = \'abc\'',
        "                                  ^",
      ].join("\n"),
    );
    expect(parsed.lineNumber).toBe(10);
    expect(parsed.lineText).toBe("SELECT * FROM users WHERE id = 'abc'");
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

  it("extracts the code when the SQLSTATE group carries non-digit characters", () => {
    const parsed = parseMySQLError(
      "MySQL query failed: Error 2003 (HY000): Can't connect to MySQL server on '127.0.0.1'",
    );
    expect(parsed.code).toBe("2003");
    expect(parsed.message).toContain("Can't connect to MySQL server");
  });

  it("keeps the code when the message itself contains parentheses and colons", () => {
    const parsed = parseMySQLError(
      "MySQL query failed: Error 1366 (HY000): Incorrect integer value: 'x' for column 'id' at row 1",
    );
    expect(parsed.code).toBe("1366");
    expect(parsed.message).toContain("Incorrect integer value");
  });

  it("falls back for an 'Error:' (no numeric code) style message", () => {
    const parsed = parseMySQLError("MySQL query failed: Error: Unknown storage engine 'InnoDB'");
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toBe("Error: Unknown storage engine 'InnoDB'");
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

  it("strips the rusqlite prefix even without the Rust wrapper", () => {
    const parsed = parseSQLiteError("error returned from database: table users already exists");
    expect(parsed.message).toBe("table users already exists");
  });

  it("strips only the Rust wrapper when the inner prefix is absent", () => {
    const parsed = parseSQLiteError("SQLite query failed: no such table: users");
    expect(parsed.message).toBe("no such table: users");
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
