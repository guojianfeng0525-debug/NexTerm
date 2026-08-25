import type { DatabaseCompletionItem, DatabaseQueryEditorContext } from "./query-editor";

const MYSQL_KEYWORDS = ["SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "TABLE", "ORDER BY", "LIMIT"];

export function createMySQLQueryEditorContext(input: {
  readonly connectionId: string;
  readonly database: string;
  readonly lookup: () => Promise<readonly string[]>;
}): DatabaseQueryEditorContext {
  return {
    providerId: "mysql",
    languageId: "sql.mysql",
    connectionId: input.connectionId,
    catalog: input.database,
    complete: async (): Promise<readonly DatabaseCompletionItem[]> => [
      ...MYSQL_KEYWORDS.map((label) => ({ label, kind: "function" as const })),
      ...(await input.lookup()).map((label) => ({ label, kind: "relation" as const })),
    ],
  };
}
