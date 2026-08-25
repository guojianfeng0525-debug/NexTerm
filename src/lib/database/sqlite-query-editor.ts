import type { DatabaseCompletionItem, DatabaseQueryEditorContext } from "./query-editor";

const SQLITE_KEYWORDS = ["SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "TABLE", "ORDER BY", "LIMIT"];

export function createSqliteQueryEditorContext(input: {
  readonly connectionId: string;
  readonly lookup: () => Promise<readonly string[]>;
}): DatabaseQueryEditorContext {
  return {
    providerId: "sqlite",
    languageId: "sql.sqlite",
    connectionId: input.connectionId,
    complete: async (): Promise<readonly DatabaseCompletionItem[]> => [
      ...SQLITE_KEYWORDS.map((label) => ({ label, kind: "function" as const })),
      ...(await input.lookup()).map((label) => ({ label, kind: "relation" as const })),
    ],
  };
}
