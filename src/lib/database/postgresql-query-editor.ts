import type {
  DatabaseCompletionItem,
  DatabaseQueryEditorContext,
} from "./query-editor";
import type { PostgresCatalogLookup } from "../postgres-completion";

function completionKind(kind: string): DatabaseCompletionItem["kind"] {
  if (kind === "column" || kind === "function" || kind === "type") return kind;
  return "relation";
}

export function createPostgresQueryEditorContext(input: {
  readonly connectionId: string;
  readonly catalog: string;
  readonly schema?: string;
  readonly lookup: PostgresCatalogLookup;
}): DatabaseQueryEditorContext {
  return {
    providerId: "postgresql",
    languageId: "sql.postgresql",
    connectionId: input.connectionId,
    catalog: input.catalog,
    schema: input.schema,
    complete: async (request) => {
      const items = await input.lookup({
        ...request,
        // Bare-name relation completion must not be pinned to the navigator's
        // current schema: PG resolves unqualified table names through the
        // session search_path, so candidates from every visible schema are
        // offered (DBeaver parity). Qualified prefixes (pg_catalog.)
        // still constrain the search.
        schema: request.schema ?? (request.kind === "relation" ? undefined : input.schema),
      });
      return items.map(
        (item): DatabaseCompletionItem => ({
          // Bare-name relation candidates keep their schema qualifier so the
          // inserted text runs as-is; qualified contexts already carry it.
          label: request.kind === "relation" && !request.schema && item.schema && item.schema !== input.schema
            ? `${item.schema}.${item.name}`
            : item.name,
          kind: completionKind(item.kind),
          detail: item.comment
            ? `${item.signature ?? item.dataType ?? item.schema ?? ""} — ${item.comment}`.trim()
            : item.signature ?? item.dataType ?? item.schema,
        }),
      );
    },
  };
}
