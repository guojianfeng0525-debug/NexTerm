import type {
  DatabaseCommandResult,
  DatabaseResult,
  DatabaseResultColumn,
  DatabaseTabularResult,
} from "./result-types";

export interface PostgresQueryRuntimeResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly commandTags?: readonly string[];
  readonly truncated: boolean;
}

export interface PostgresTableRuntimeResult extends PostgresQueryRuntimeResult {
  readonly primaryKeyColumns?: readonly string[];
  readonly nullableColumns?: readonly string[];
  /** Formatted server types aligned with `columns` (e.g. `int4`, `text`). */
  readonly columnTypes?: readonly string[];
  /** Column comments aligned with `columns`; empty string when absent. */
  readonly columnComments?: readonly string[];
}

function columnsFor(names: readonly string[]): readonly DatabaseResultColumn[] {
  return names.map((label, ordinal) => ({
    key: `column:${ordinal}`,
    label,
    ordinal,
    // The current simple-query IPC intentionally supplies no type metadata.
    semanticType: "unknown",
  }));
}

function commandResult(commandTags: readonly string[]): DatabaseCommandResult {
  return { kind: "command", commandTags };
}

export function adaptPostgresQueryResult(
  result: PostgresQueryRuntimeResult,
): DatabaseResult {
  const commandTags = result.commandTags ?? [];
  if (!result.columns.length && !result.rows.length) {
    return commandTags.length ? commandResult(commandTags) : { kind: "empty" };
  }

  return {
    kind: "tabular",
    columns: columnsFor(result.columns),
    rows: result.rows,
    commandTags,
    truncated: result.truncated,
    editability: { editable: false, primaryKeyColumnKeys: [], nullableColumnKeys: [] },
  };
}

export function adaptPostgresTableResult(
  result: PostgresTableRuntimeResult,
  pagination: { readonly offset: number; readonly limit: number },
): DatabaseTabularResult {
  const columns = result.columns.map((label, ordinal) => ({
    key: `column:${ordinal}`,
    label,
    ordinal,
    // The table-data IPC now supplies server type metadata; the semantic
    // type remains unknown for now (no cross-provider mapping yet).
    semanticType: "unknown" as const,
    providerType: result.columnTypes?.[ordinal],
    providerComment: result.columnComments?.[ordinal],
  }));
  const primaryKeyNames = new Set(result.primaryKeyColumns ?? []);
  const nullableColumnNames = new Set(result.nullableColumns ?? []);
  return {
    kind: "tabular",
    columns,
    rows: result.rows,
    commandTags: result.commandTags ?? [],
    truncated: result.truncated,
    pagination: {
      ...pagination,
      hasMore: result.truncated,
    },
    editability: {
      editable: primaryKeyNames.size > 0,
      primaryKeyColumnKeys: columns
        .filter((column) => primaryKeyNames.has(column.label))
        .map((column) => column.key),
      nullableColumnKeys: columns
        .filter((column) => nullableColumnNames.has(column.label))
        .map((column) => column.key),
    },
  };
}
