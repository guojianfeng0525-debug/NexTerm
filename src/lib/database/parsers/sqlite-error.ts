import type { ParsedDatabaseError } from "../database-error";

/**
 * SQLite error parser (feature-design §2.3).
 *
 * Rust side (src-tauri/src/sqlite.rs:119) emits `SQLite query failed: {error}`
 * where `{error}` is the rusqlite error Display, typically:
 *
 *   SQLite query failed: error returned from database: near "SELEC": syntax error
 *
 * rusqlite errors carry no structured code or line number — the remaining
 * text is the message.
 */

const RUST_PREFIX = "SQLite query failed: ";
const RUSQLITE_PREFIX = "error returned from database: ";

export function parseSQLiteError(raw: string): ParsedDatabaseError {
  const fullText = raw;
  let text = raw;
  for (const prefix of [RUST_PREFIX, RUSQLITE_PREFIX]) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }

  return { message: text.trim(), fullText, source: "sqlite" };
}
