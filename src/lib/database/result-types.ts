/**
 * Provider-neutral data received by result UIs. Cell serialization remains
 * provider-owned so values such as BIGINT and NUMERIC never lose precision.
 */
export type DatabaseCellValue = string | null;

export type DatabaseColumnSemanticType =
  | "text"
  | "number"
  | "boolean"
  | "datetime"
  | "json"
  | "binary"
  | "unknown";

export interface DatabaseResultColumn {
  readonly key: string;
  readonly label: string;
  readonly ordinal: number;
  readonly semanticType: DatabaseColumnSemanticType;
  /** Formatted server type (e.g. `int4`, `text`); populated by providers
   * that expose column metadata (PostgreSQL table browse). */
  readonly providerType?: string;
  /** Server-side column comment; empty/absent when none. */
  readonly providerComment?: string;
}

/**
 * Server-side filter state for table browsing. Conditions are structured
 * data — the backend builds parameterized SQL, never frontend string
 * concatenation (D-B18-2).
 */
export type FilterOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like"
  | "isNull" | "isNotNull";

export interface FilterCondition {
  /** Column label (the database column name). */
  readonly column: string;
  readonly operator: FilterOperator;
  /** Ignored by `isNull` / `isNotNull`. */
  readonly value?: string | null;
}

export interface SortClause {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

export interface TableFilterState {
  readonly logic: "AND" | "OR";
  readonly conditions: readonly FilterCondition[];
  readonly orderBy: readonly SortClause[];
}

/** Per-table grid layout persisted across tab reopens (Slice C). */
export interface GridLayoutState {
  readonly frozenCount: number;
  /** column key -> pixel width. */
  readonly widths: Readonly<Record<string, number>>;
  readonly rowHeight: number;
  readonly showFieldType: boolean;
  readonly showComment: boolean;
}

export type DatabaseResultRow = readonly DatabaseCellValue[];

export interface DatabaseResultPagination {
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface DatabaseResultEditability {
  readonly editable: boolean;
  readonly primaryKeyColumnKeys: readonly string[];
  readonly nullableColumnKeys?: readonly string[];
}

export interface DatabaseTabularResult {
  readonly kind: "tabular";
  readonly columns: readonly DatabaseResultColumn[];
  readonly rows: readonly DatabaseResultRow[];
  readonly commandTags: readonly string[];
  readonly truncated: boolean;
  readonly pagination?: DatabaseResultPagination;
  readonly editability: DatabaseResultEditability;
}

export interface DatabaseCommandResult {
  readonly kind: "command";
  readonly commandTags: readonly string[];
}

export interface DatabaseEmptyResult {
  readonly kind: "empty";
}

export type DatabaseResult =
  | DatabaseTabularResult
  | DatabaseCommandResult
  | DatabaseEmptyResult;
