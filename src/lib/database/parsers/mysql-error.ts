import type { ParsedDatabaseError } from "../database-error";

/**
 * MySQL error parser (feature-design §2.3).
 *
 * Rust side (src-tauri/src/mysql.rs:157) emits `MySQL query failed: {error}`
 * where `{error}` is the mysql_async Error Display, typically:
 *
 *   MySQL query failed: Error 1064 (42000): You have an error in your SQL syntax
 *
 * The numeric error code (`1064`) and the optional SQLSTATE (`42000`) are
 * extracted; MySQL client errors carry no statement line number.
 */

const RUST_PREFIX = "MySQL query failed: ";

/** `Error 1064 (42000): message` — SQLSTATE group is optional. */
const ERROR_RE = /^Error\s+(\d+)(?:\s*\(([^)]+)\))?[:：]\s*([\s\S]*)$/;

export function parseMySQLError(raw: string): ParsedDatabaseError {
  const fullText = raw;
  let text = raw;
  if (text.startsWith(RUST_PREFIX)) text = text.slice(RUST_PREFIX.length);

  const match = text.match(ERROR_RE);
  if (match) {
    return {
      message: match[3].trim(),
      fullText,
      code: match[1],
      source: "mysql",
    };
  }

  return { message: text.trim(), fullText, source: "mysql" };
}
