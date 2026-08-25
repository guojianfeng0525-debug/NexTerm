import type { DatabaseProviderDescriptor, DatabaseProviderId } from "./types";

export const postgresqlProvider: DatabaseProviderDescriptor = {
  id: "postgresql",
  displayName: "PostgreSQL",
  family: "relational",
  capabilities: {
    supportsSchemas: true,
    supportsTransactions: true,
    explain: "text",
    // The current PostgreSQL backend safely supports primary-key row updates.
    supportsResultEditing: true,
    supportsPagination: true,
    supportsSshTunnel: true,
    supportsTls: true,
    supportsReadOnlyConnection: true,
    supportsCodeCompletion: true,
    supportsRelations: true,
  },
  objectModel: {
    hierarchy: ["connection", "catalog", "schema", "group", "object"],
    objectRoles: ["relation"],
  },
};

/** P0 local-file provider. It intentionally exposes no network transport. */
export const sqliteProvider: DatabaseProviderDescriptor = {
  id: "sqlite",
  displayName: "SQLite (Experimental)",
  family: "relational",
  capabilities: {
    supportsSchemas: false,
    supportsTransactions: false,
    explain: "none",
    supportsResultEditing: false,
    supportsPagination: false,
    supportsSshTunnel: false,
    supportsTls: false,
    supportsReadOnlyConnection: true,
    supportsCodeCompletion: true,
    supportsRelations: true,
  },
  objectModel: {
    hierarchy: ["connection", "catalog", "group", "object"],
    objectRoles: ["relation"],
  },
};

const providers = [postgresqlProvider, sqliteProvider] as const;

export function getDatabaseProvider(
  id: string,
): DatabaseProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id);
}

export function listDatabaseProviders(): readonly DatabaseProviderDescriptor[] {
  return providers;
}

export function hasDatabaseProvider(id: string): id is DatabaseProviderId {
  return getDatabaseProvider(id) !== undefined;
}
