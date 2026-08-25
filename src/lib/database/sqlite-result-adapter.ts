import type { DatabaseResult, DatabaseResultColumn } from "./result-types";

export interface SqliteQueryRuntimeResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly commandTags: readonly string[];
  readonly truncated: boolean;
}

export function adaptSqliteQueryResult(result: SqliteQueryRuntimeResult): DatabaseResult {
  if (!result.columns.length && !result.rows.length) {
    return result.commandTags.length ? { kind: "command", commandTags: result.commandTags } : { kind: "empty" };
  }
  const columns: readonly DatabaseResultColumn[] = result.columns.map((label, ordinal) => ({
    key: `column:${ordinal}`, label, ordinal, semanticType: "unknown",
  }));
  return {
    kind: "tabular", columns, rows: result.rows, commandTags: result.commandTags,
    truncated: result.truncated, editability: { editable: false, primaryKeyColumnKeys: [] },
  };
}
