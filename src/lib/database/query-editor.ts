import type { DatabaseProviderId } from "./types";

export type DatabaseQueryLanguageId = "sql.standard" | "sql.postgresql" | "sql.sqlite";
export type DatabaseCompletionKind = "relation" | "column" | "function" | "type";

export interface DatabaseCompletionRequest {
  readonly kind: DatabaseCompletionKind;
  readonly prefix: string;
  readonly schema?: string;
  readonly relation?: string;
}

export interface DatabaseCompletionItem {
  readonly label: string;
  readonly kind: DatabaseCompletionKind;
  readonly detail?: string;
}

export interface DatabaseQueryEditorContext {
  readonly providerId?: DatabaseProviderId;
  readonly languageId: DatabaseQueryLanguageId;
  readonly connectionId?: string;
  readonly catalog?: string;
  readonly schema?: string;
  readonly complete?: (
    request: DatabaseCompletionRequest,
  ) => Promise<readonly DatabaseCompletionItem[]>;
}

export const genericSqlQueryEditorContext: DatabaseQueryEditorContext = {
  languageId: "sql.standard",
};
