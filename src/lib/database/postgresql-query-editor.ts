import type {
  DatabaseCompletionItem,
  DatabaseCompletionRequest,
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
    complete: async (request: DatabaseCompletionRequest) =>
      (await input.lookup(request)).map(
        (item): DatabaseCompletionItem => ({
          label: item.name,
          kind: completionKind(item.kind),
          detail: item.signature ?? item.dataType ?? item.schema,
        }),
      ),
  };
}
