/**
 * B19: frontend SQL statement tokenizer (pm plan §B19-A, security §4.1).
 * Mirrors the Rust `split_sql_statements` lexer so the editor can locate the
 * "current statement" under the cursor with the same rules: a semicolon inside
 * a string, comment, or dollar-quote never splits the text.
 *
 * Returns byte offsets into the SQL string (which for JS strings equals UTF-16
 * code-unit offsets). Consumers that care about multi-byte characters must
 * treat these as code-unit offsets (the editor API uses the same unit).
 */

export interface SqlStatementRange {
  readonly start: number;
  readonly end: number;
}

/** Splits SQL text into statement ranges (same lexer as the Rust backend). */
export function splitSqlStatements(sql: string): SqlStatementRange[] {
  const statements: SqlStatementRange[] = [];
  let cut = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockDepth = 0;
  let dollarTag: string | null = null;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
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
      }
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "$") {
      // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty).
      const tagEnd = sql.indexOf("$", index + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(index + 1, tagEnd);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) || tag === "") {
          dollarTag = tag;
          index = tagEnd + 1;
          continue;
        }
      }
      index += 1;
      continue;
    }
    if (char === ";") {
      const start = skipLeadingNoise(sql, cut);
      const end = trimTrailing(sql, start, index);
      if (start < end) statements.push({ start, end });
      cut = index + 1;
    }
    index += 1;
  }
  const start = skipLeadingNoise(sql, cut);
  const end = trimTrailing(sql, start, sql.length);
  if (start < end) statements.push({ start, end });
  return statements;
}

/** Byte/code-unit offset of the first non-noise char at/after `from`. */
export function skipLeadingNoise(sql: string, from: number): number {
  let index = from;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
    } else if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        const b = sql[index];
        const n = sql[index + 1];
        if (b === "/" && n === "*") {
          depth += 1;
          index += 2;
        } else if (b === "*" && n === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
    } else {
      break;
    }
  }
  return index;
}

function trimTrailing(sql: string, start: number, end: number): number {
  let e = end;
  while (e > start && /\s/.test(sql[e - 1])) e -= 1;
  return e;
}

/**
 * Returns the range of the statement containing `offset` (a caret position).
 * When the caret is inside leading noise or at a boundary, the next statement
 * is chosen; when the text has no statements, null is returned.
 */
export function currentStatementAt(sql: string, offset: number): SqlStatementRange | null {
  const ranges = splitSqlStatements(sql);
  if (ranges.length === 0) return null;
  // Prefer the statement whose [start, end] contains offset; otherwise the
  // first statement whose start is at/after offset; otherwise the last one.
  const containing = ranges.find((range) => offset >= range.start && offset <= range.end);
  if (containing) return containing;
  const after = ranges.find((range) => range.start >= offset);
  return after ?? ranges[ranges.length - 1];
}

/**
 * Toggles line comments on every line overlapping the current selection:
 * lines already starting with `--` get the prefix stripped, others get it
 * added. Returns the replacement text (caller applies it to the editor).
 */
export function toggleLineComment(sql: string, from: number, to: number): string {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let lineStart = 0;
  for (let i = 0; i <= sql.length; i += 1) {
    if (i === sql.length || sql[i] === "\n") {
      lines.push({ start: lineStart, end: i, text: sql.slice(lineStart, i) });
      lineStart = i + 1;
    }
  }
  const affected = lines.filter((line) => line.end >= from && line.start <= to);
  const allCommented = affected.every((line) => line.text.trimStart().startsWith("--"));
  const parts: string[] = [];
  let cursor = 0;
  for (const line of affected) {
    if (line.start > cursor) parts.push(sql.slice(cursor, line.start));
    const indent = line.text.match(/^\s*/)?.[0] ?? "";
    const body = line.text.slice(indent.length);
    if (allCommented) {
      parts.push(indent + body.replace(/^--/, ""));
    } else {
      parts.push(indent + "--" + body);
    }
    cursor = line.end;
  }
  if (cursor < sql.length) parts.push(sql.slice(cursor));
  return parts.join("");
}
