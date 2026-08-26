/**
 * Step 2 (v2.10.0): shared SQL formatter wrapper (sql-formatting-competitor-analysis.md §6.1).
 *
 * Serves both entry points:
 *  - query editor "Format SQL" (⌘⇧F, whole text or selection)
 *  - DDL preview panel (single-click table/view → formatted DDL)
 *
 * Default rules follow the Navicat-style baseline agreed in the analysis doc:
 * uppercase keywords, one clause per line, 2-space indent, 1 blank line
 * between queries. String literals, quoted identifiers, comments and
 * dollar-quoted bodies are never rewritten (content protection, AC-1).
 */
import { format as formatWithSqlFormatter } from "sql-formatter";

export type SqlKeywordCase = "preserve" | "upper" | "lower";

export interface SqlFormatOptions {
  /** Keyword casing applied to SQL keywords only (never to literals/comments). */
  readonly keywordCase: SqlKeywordCase;
  /** Indent width in spaces (Navicat-style baseline: 2). */
  readonly indentWidth: number;
  /** Blank lines between consecutive queries. */
  readonly linesBetweenQueries: 0 | 1 | 2;
}

export const PG_SQL_FORMAT_DEFAULTS: SqlFormatOptions = {
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenQueries: 1,
};

function buildOptions(options: Partial<SqlFormatOptions> | undefined) {
  const merged: SqlFormatOptions = { ...PG_SQL_FORMAT_DEFAULTS, ...options };
  return {
    language: "postgresql" as const,
    keywordCase: merged.keywordCase,
    tabWidth: merged.indentWidth,
    useTabs: false,
    linesBetweenQueries: merged.linesBetweenQueries,
    // Identifiers and data types keep their original casing.
    identifierCase: "preserve" as const,
    datatypeCase: "preserve" as const,
  };
}

/**
 * Formats a SQL document (or DDL text) with the shared default rules.
 * If the formatter cannot process the input, the original text is returned
 * unchanged — formatting is strictly best-effort and must never corrupt
 * content (R-5 fallback to the minimal "no rewrite" rule set).
 */
export function formatSql(sql: string, options?: Partial<SqlFormatOptions>): string {
  if (!sql.trim()) return sql;
  try {
    return formatWithSqlFormatter(sql, buildOptions(options));
  } catch {
    return sql;
  }
}

/** Formats DDL text for the preview panel (same engine and defaults). */
export function formatDdl(ddl: string, options?: Partial<SqlFormatOptions>): string {
  return formatSql(ddl, options);
}

/**
 * Formats a selected SQL fragment (AC-2). The caller owns the editor state:
 * it passes exactly the selected text and splices the returned string back
 * over the selection range, which keeps everything outside the selection
 * byte-identical by construction. Whitespace-only/empty fragments are
 * returned unchanged.
 */
export function formatSqlSelection(
  sql: string,
  options?: Partial<SqlFormatOptions>,
): string {
  if (!sql.trim()) return sql;
  try {
    return formatWithSqlFormatter(sql, buildOptions(options));
  } catch {
    return sql;
  }
}

/**
 * Extracts "protected" segments — string literals, quoted identifiers, line
 * comments, block comments and dollar-quoted bodies — in document order.
 * Used by tests (AC-1) to assert formatting never rewrites these regions.
 */
export function extractProtectedSegments(sql: string): string[] {
  const segments: string[] = [];
  let quote: string | null = null;
  let quoteStart = 0;
  let lineComment = false;
  let lineStart = 0;
  let blockDepth = 0;
  let blockStart = 0;
  let dollarTag: string | null = null;
  let dollarStart = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") {
        segments.push(sql.slice(lineStart, index));
        lineComment = false;
      }
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
        continue;
      }
      if (char === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) segments.push(sql.slice(blockStart, index));
        continue;
      }
      index += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (char === "$" && sql.startsWith(dollarTag, index + 1)) {
        const tagEnd = index + 1 + dollarTag.length;
        if (sql[tagEnd] === "$") {
          dollarTag = null;
          index = tagEnd + 1;
          segments.push(sql.slice(dollarStart, index));
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        if (quote === "'" && next === "'") {
          index += 2;
          continue;
        }
        quote = null;
        segments.push(sql.slice(quoteStart, index + 1));
      }
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      lineStart = index;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      blockStart = index;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoteStart = index;
      index += 1;
      continue;
    }
    if (char === "$") {
      const tagEnd = sql.indexOf("$", index + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(index + 1, tagEnd);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) || tag === "") {
          dollarTag = tag;
          dollarStart = index;
          index = tagEnd + 1;
          continue;
        }
      }
    }
    index += 1;
  }
  if (lineComment) segments.push(sql.slice(lineStart));
  if (blockDepth > 0) segments.push(sql.slice(blockStart));
  if (quote !== null) segments.push(sql.slice(quoteStart));
  if (dollarTag !== null) segments.push(sql.slice(dollarStart));
  return segments;
}
