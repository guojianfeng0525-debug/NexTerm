import type { ParsedDatabaseError } from "../database-error";

/**
 * PostgreSQL error parser (feature-design §2.3).
 *
 * Rust side (src-tauri/src/postgres.rs:828) emits `PostgreSQL query failed:
 * {error}` where `{error}` is the tokio-postgres Error Display. A typical
 * statement error looks like:
 *
 *   PostgreSQL query failed: db error: ERROR: syntax error at or near "SELEC"
 *   LINE 1: SELEC * FROM users
 *           ^
 *
 * The `^` caret line carries the server-side column offset; since the Rust
 * layer currently returns only a String, we approximate `position` with the
 * caret column (1-based) — the structured `DbError.position` route is a
 * P1 follow-up (feature-design §2.3 note).
 */

const RUST_PREFIX = "PostgreSQL query failed: ";
const DISPLAY_PREFIX = "db error: ";

/** Matches an `ERROR: ...` line, optionally prefixed with a SQLSTATE code
 *  (5 chars, leading char may be a digit — e.g. 23505, 42P01). */
const ERROR_LINE_RE = /^ERROR:\s*(?:([0-9A-Z]{5}):\s*)?(.*)$/m;

/** Matches a `LINE n: <text>` line. */
const LINE_RE = /LINE\s+(\d+):\s*(.*)$/m;

/** Matches a caret line like `        ^` and captures the leading spaces. */
const CARET_RE = /^[ \t]*\^/m;

export function parsePostgresError(raw: string): ParsedDatabaseError {
  const fullText = raw;
  let text = raw;
  for (const prefix of [RUST_PREFIX, DISPLAY_PREFIX]) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }

  let message = text.trim();
  let code: string | undefined;
  const errorLine = text.match(ERROR_LINE_RE);
  if (errorLine) {
    if (errorLine[1]) code = errorLine[1];
    message = errorLine[2].trim();
  }

  let lineNumber: number | undefined;
  let lineText: string | undefined;
  const lineMatch = text.match(LINE_RE);
  if (lineMatch) {
    lineNumber = Number(lineMatch[1]);
    lineText = lineMatch[2].trim();
  }

  let position: number | undefined;
  const caretMatch = text.match(CARET_RE);
  if (caretMatch) {
    // `^` column (1-based): leading whitespace count + 1.
    position = caretMatch[0].length;
  }

  return {
    message,
    fullText,
    ...(code !== undefined ? { code } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
    ...(lineText !== undefined ? { lineText } : {}),
    source: "postgres",
  };
}
