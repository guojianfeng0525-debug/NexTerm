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
  tablesLabel: string,
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
            { kind: "group", value: "relations" },
          ],
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "group",
        label: tablesLabel,
        iconRole: "group",
        expandable: true,
        selectable: true,
        openable: false,
        reference: createReference([connectionId, database, schema, "relations"]),
      },
    ];
  }

  if (node.kind === "group" && path.length === 4 && path[3] === "relations") {
    const [connectionId, database, schema] = path;
    const relations = await invoke<PostgresCatalogItem[]>("postgres_catalog_search", {
      request: { connectionId, kind: "relation", schema },
    });
    return relations.map((relation) => ({
      id: createDatabaseObjectNodeId({
        providerId: "postgresql",
        connectionId,
        path: [
          { kind: "connection", value: connectionId },
          { kind: "catalog", value: database },
          { kind: "schema", value: schema },
          { kind: "group", value: "relations" },
          { kind: "object", value: relation.name },
        ],
      }),
      parentId: node.id,
      providerId: "postgresql",
      kind: "object",
      objectRole: "relation",
      label: relation.name,
      iconRole: "relation",
      expandable: false,
      selectable: true,
      openable: true,
      reference: createReference([connectionId, database, schema, relation.name]),
    }));
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
    node.objectRole !== "relation" ||
    path.length !== 4
  ) {
    return null;
  }

  const [connectionId, database, schema, relation] = path;
  return { connectionId, database, schema, relation };
}
