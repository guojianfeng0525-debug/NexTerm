import { invoke } from "@tauri-apps/api/core";
import { createDatabaseObjectNodeId } from "./object-identity";
import type {
  DatabaseObjectNode,
  DatabaseObjectReference,
} from "./types";

interface PostgresCatalogItem {
  readonly kind: string;
  readonly schema?: string;
  readonly name: string;
  readonly relationKind?: "r" | "p" | "v" | "m";
}

export interface PostgresNavigatorConnection {
  readonly id: string;
  readonly name: string;
  readonly database: string;
}

export interface PostgresRelationReference {
  readonly connectionId: string;
  readonly database: string;
  readonly schema: string;
  readonly relation: string;
  readonly objectRole?: "table" | "view" | "materializedView";
}

export interface PostgresNavigatorGroupLabels {
  readonly tables: string;
  readonly views: string;
  readonly materializedViews: string;
}

function createReference(path: readonly string[]): DatabaseObjectReference {
  return { providerId: "postgresql", path };
}

function createConnectionNode(
  connection: PostgresNavigatorConnection,
): DatabaseObjectNode {
  return {
    id: createDatabaseObjectNodeId({
      providerId: "postgresql",
      connectionId: connection.id,
      path: [{ kind: "connection", value: connection.id }],
    }),
    providerId: "postgresql",
    kind: "connection",
    label: connection.name,
    iconRole: "connection",
    expandable: true,
    selectable: true,
    openable: false,
    reference: createReference([connection.id, connection.database]),
  };
}

export function createPostgresNavigatorConnectionNode(
  connection: PostgresNavigatorConnection,
): DatabaseObjectNode {
  return createConnectionNode(connection);
}

function postgresReference(node: DatabaseObjectNode): readonly string[] | null {
  return node.reference.providerId === "postgresql"
    ? node.reference.path
    : null;
}

/** Loads only the direct children for a PostgreSQL Navigator node. */
export async function loadPostgresNavigatorChildren(
  node: DatabaseObjectNode,
  labels: PostgresNavigatorGroupLabels,
): Promise<readonly DatabaseObjectNode[]> {
  const path = postgresReference(node);
  if (!path) return [];

  if (node.kind === "connection" && path.length === 2) {
    const [connectionId, database] = path;
    return [
      {
        id: createDatabaseObjectNodeId({
          providerId: "postgresql",
          connectionId,
          path: [
            { kind: "connection", value: connectionId },
            { kind: "catalog", value: database },
          ],
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "catalog",
        label: database,
        iconRole: "catalog",
        expandable: true,
        selectable: true,
        openable: false,
        reference: createReference(path),
      },
    ];
  }

  if (node.kind === "catalog" && path.length === 2) {
    const [connectionId, database] = path;
    const schemas = await invoke<string[]>("postgres_catalog_schemas", {
      connectionId,
    });
    return schemas.map((schema) => ({
      id: createDatabaseObjectNodeId({
        providerId: "postgresql",
        connectionId,
        path: [
          { kind: "connection", value: connectionId },
          { kind: "catalog", value: database },
          { kind: "schema", value: schema },
        ],
      }),
      parentId: node.id,
      providerId: "postgresql",
      kind: "schema",
      label: schema,
      iconRole: "schema",
      expandable: true,
      selectable: true,
      openable: false,
      reference: createReference([connectionId, database, schema]),
    }));
  }

  if (node.kind === "schema" && path.length === 3) {
    const [connectionId, database, schema] = path;
    return [
      {
        id: createDatabaseObjectNodeId({
          providerId: "postgresql",
          connectionId,
          path: [
            { kind: "connection", value: connectionId },
            { kind: "catalog", value: database },
            { kind: "schema", value: schema },
            { kind: "group", value: "tables" },
          ],
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "group",
        label: labels.tables,
        iconRole: "group",
        expandable: true,
        selectable: true,
        openable: false,
        reference: createReference([connectionId, database, schema, "tables"]),
      },
      {
        id: createDatabaseObjectNodeId({
          providerId: "postgresql",
          connectionId,
          path: [
            { kind: "connection", value: connectionId },
            { kind: "catalog", value: database },
            { kind: "schema", value: schema },
            { kind: "group", value: "views" },
          ],
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "group",
        label: labels.views,
        iconRole: "group",
        expandable: true,
        selectable: true,
        openable: false,
        reference: createReference([connectionId, database, schema, "views"]),
      },
      {
        id: createDatabaseObjectNodeId({
          providerId: "postgresql",
          connectionId,
          path: [
            { kind: "connection", value: connectionId },
            { kind: "catalog", value: database },
            { kind: "schema", value: schema },
            { kind: "group", value: "materializedViews" },
          ],
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "group",
        label: labels.materializedViews,
        iconRole: "group",
        expandable: true,
        selectable: true,
        openable: false,
        reference: createReference([connectionId, database, schema, "materializedViews"]),
      },
    ];
  }

  if (node.kind === "group" && path.length === 4) {
    const [connectionId, database, schema] = path;
    const relations = await invoke<PostgresCatalogItem[]>("postgres_catalog_search", {
      request: { connectionId, kind: "relation", schema },
    });
    const group = path[3];
    const relationRole = (relation: PostgresCatalogItem) => {
      if (relation.relationKind === "v") return "view" as const;
      if (relation.relationKind === "m") return "materializedView" as const;
      return "table" as const;
    };
    return relations.filter((relation) => {
      const role = relationRole(relation);
      return (group === "tables" && role === "table") ||
        (group === "views" && role === "view") ||
        (group === "materializedViews" && role === "materializedView");
    }).map((relation) => {
      const objectRole = relationRole(relation);
      return {
      id: createDatabaseObjectNodeId({
        providerId: "postgresql",
        connectionId,
        path: [
          { kind: "connection", value: connectionId },
          { kind: "catalog", value: database },
          { kind: "schema", value: schema },
          { kind: "group", value: group },
          { kind: "object", value: relation.name },
        ],
      }),
      parentId: node.id,
      providerId: "postgresql",
      kind: "object",
      objectRole,
      label: relation.name,
      iconRole: objectRole,
      expandable: false,
      selectable: true,
      openable: true,
      reference: createReference([connectionId, database, schema, relation.name, objectRole]),
    };
    });
  }

  return [];
}

export function getPostgresRelationReference(
  node: DatabaseObjectNode,
): PostgresRelationReference | null {
  const path = postgresReference(node);
  if (
    !path ||
    node.kind !== "object" ||
    (node.objectRole !== "table" && node.objectRole !== "view" && node.objectRole !== "materializedView") ||
    path.length !== 5
  ) {
    return null;
  }

  const [connectionId, database, schema, relation, objectRole] = path;
  return { connectionId, database, schema, relation, objectRole: objectRole as PostgresRelationReference["objectRole"] };
}
