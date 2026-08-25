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
  readonly providerType?: string;
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
