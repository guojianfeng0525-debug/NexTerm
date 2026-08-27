import { parseMySQLError } from "./parsers/mysql-error";
import { parsePostgresError } from "./parsers/postgres-error";
import { parseSQLiteError } from "./parsers/sqlite-error";

/**
 * Provider-neutral database error model (feature-design §2.2).
 *
 * All provider errors flowing through the UI are normalized by
 * `parseProviderError(providerId, raw)` into this structure; `DatabaseResult`
 * carries it in the `error` kind so the result pane can render a persistent,
 * copyable error card (feature-design §2.4).
 */

export type DatabaseErrorSource = "postgres" | "mysql" | "sqlite" | "unknown";

export interface ParsedDatabaseError {
  /** Core error text with prefixes / `LINE n:` / stack noise stripped. */
  readonly message: string;
  /** Raw full text (for copy / diagnostics). */
  readonly fullText: string;
  /** SQLSTATE (PG) or numeric error code (MySQL). */
  readonly code?: string;
  /** PG DbError.position: 1-based character offset (route B, P1; MVP feeds
   *  the caret column estimated from the `^` line). */
  readonly position?: number;
  /** 1-based relative line parsed from `LINE n:` (relative to the sent SQL). */
  readonly lineNumber?: number;
  /** The offending line text from `LINE n: <text>`. */
  readonly lineText?: string;
  readonly source: DatabaseErrorSource;
}

export type DatabaseErrorParser = (raw: string) => ParsedDatabaseError;

/** Provider error parser registry (unknown providers fall back below). */
const parsers: Readonly<Record<string, DatabaseErrorParser>> = {
  postgres: parsePostgresError,
  mysql: parseMySQLError,
  sqlite: parseSQLiteError,
};

/** Normalization entry point for provider errors (feature-design §2.8). */
export function parseProviderError(providerId: string, raw: string): ParsedDatabaseError {
  const parser = parsers[providerId];
  if (parser) return parser(raw);
  return { message: raw, fullText: raw, source: "unknown" };
}

/** Wraps a parsed error into a `DatabaseErrorResult` for the result pane. */
export function databaseErrorResult(error: ParsedDatabaseError): {
  readonly kind: "error";
  readonly error: ParsedDatabaseError;
} {
  return { kind: "error", error };
}
