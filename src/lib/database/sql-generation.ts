/**
 * SQL generation for the navigator tree / result-grid menus (feature-design §4.1).
 *
 * Pure functions that emit statement templates from column metadata; the
 * caller supplies a `quoteIdentifier` dialect hook so PG (`"x"`), MySQL
 * (`` `x` ``) and SQLite (`"x"`) each quote correctly, and escaping stays
 * provider-owned (e.g. PG doubles inner quotes: `"a""b"`).
 */

export interface SqlGenerationOptions {
  /** Provider dialect identifier quoting, e.g. `(s) => '"' + s.replace(/"/g, '""') + '"'`. */
  readonly quoteIdentifier: (id: string) => string;
  /** Default row limit for SELECT. Falls back to 100 (aligned with the
   *  table-browse page size). */
  readonly selectLimit?: number;
}

export interface ColumnMetadata {
  readonly name: string;
  /** Provider column type, e.g. PostgresCatalogObjectItem.dataType. */
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly default?: string;
}

const DEFAULT_SELECT_LIMIT = 100;

/** Quotes an identifier with the provider dialect hook. */
function quote(options: SqlGenerationOptions, id: string): string {
  return options.quoteIdentifier(id);
}

/** Builds a qualified name: `"schema"."table"` or `"table"` when the qualifier
 *  (schema / database) is empty. */
function qualifiedName(
  qualifier: string,
  table: string,
  options: SqlGenerationOptions,
): string {
  if (qualifier) {
    return `${quote(options, qualifier)}.${quote(options, table)}`;
  }
  return quote(options, table);
}

export function generateSelectSql(
  qualifier: string,
  table: string,
  columns: readonly ColumnMetadata[] | null,
  options: SqlGenerationOptions,
): string {
  const selectList = columns && columns.length > 0
    ? columns.map((column) => quote(options, column.name)).join(", ")
    : "*";
  const limit = options.selectLimit ?? DEFAULT_SELECT_LIMIT;
  return `SELECT ${selectList} FROM ${qualifiedName(qualifier, table, options)} LIMIT ${limit};`;
}

export function generateInsertSql(
  qualifier: string,
  table: string,
  columns: readonly ColumnMetadata[],
  options: SqlGenerationOptions,
): string {
  const names = columns.map((column) => quote(options, column.name));
  const placeholders = columns.map(() => "''");
  return `INSERT INTO ${qualifiedName(qualifier, table, options)} (${names.join(", ")}) VALUES (${placeholders.join(", ")});`;
}

export function generateUpdateSql(
  qualifier: string,
  table: string,
  columns: readonly ColumnMetadata[],
  primaryKeyColumns: readonly string[],
  options: SqlGenerationOptions,
): string {
  const primaryKeys = new Set(primaryKeyColumns);
  let settable = columns.filter((column) => !primaryKeys.has(column.name));
  // Degenerate fallback: every column is a primary key — still allow a SET
  // list so the generated template stays valid SQL.
  if (settable.length === 0) settable = columns.slice();
  const setClause = settable
    .map((column) => `${quote(options, column.name)} = ''`)
    .join(", ");
  const whereClause = primaryKeyColumns.length > 0
    ? ` WHERE ${primaryKeyColumns.map((pk) => `${quote(options, pk)} = <id>`).join(" AND ")}`
    : "";
  return `UPDATE ${qualifiedName(qualifier, table, options)} SET ${setClause}${whereClause};`;
}
