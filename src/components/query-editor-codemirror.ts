import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { PostgreSQL, SQLite } from "@codemirror/lang-sql";
import type { DatabaseQueryEditorContext } from "@/lib/database/query-editor";
import {
  postgresCatalogCompletionSource,
  postgresCompletionSource,
  type PostgresCatalogLookup,
} from "@/lib/postgres-completion";

export function queryEditorDialect(context: DatabaseQueryEditorContext) {
  if (context.languageId === "sql.postgresql") return PostgreSQL;
  if (context.languageId === "sql.sqlite") return SQLite;
  return undefined;
}

export function queryEditorCompletionSource(
  context: DatabaseQueryEditorContext,
) {
  return (completionContext: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    if (context.languageId === "sql.sqlite") {
      if (!context.complete) return null;
      return context.complete({ kind: "relation", prefix: "" }).then((items) => ({
        from: completionContext.pos,
        options: items.map((item) => ({ label: item.label, type: item.kind === "relation" ? "class" : "keyword" })),
      }));
    }
    if (context.languageId !== "sql.postgresql") return null;
    const lookup: PostgresCatalogLookup | undefined = context.complete
      ? async (request) =>
          (await context.complete!(request)).map((item) => ({
            kind: item.kind,
            name: item.label,
            schema: context.schema,
            dataType: item.detail,
          }))
      : undefined;
    return lookup
      ? postgresCatalogCompletionSource(completionContext, lookup)
      : postgresCompletionSource(completionContext);
  };
}
