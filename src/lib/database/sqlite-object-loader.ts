import { invoke } from "@tauri-apps/api/core";
import { createDatabaseObjectNodeId } from "./object-identity";
import type { DatabaseObjectNode, DatabaseObjectReference } from "./types";

export interface SqliteNavigatorConnection {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
}

export interface SqliteRelationReference {
  readonly connectionId: string;
  readonly relation: string;
}

function reference(path: readonly string[]): DatabaseObjectReference {
  return { providerId: "sqlite", path };
}

export function createSqliteNavigatorConnectionNode(
  connection: SqliteNavigatorConnection,
): DatabaseObjectNode {
  return {
    id: createDatabaseObjectNodeId({
      providerId: "sqlite", connectionId: connection.id,
      path: [{ kind: "connection", value: connection.id }],
    }),
    providerId: "sqlite", kind: "connection", label: connection.name,
    iconRole: "connection", expandable: true, selectable: true, openable: false,
    reference: reference([connection.id, connection.filePath]),
  };
}

/** SQLite's file is the catalog; it has no synthetic schema level. */
export async function loadSqliteNavigatorChildren(
  node: DatabaseObjectNode,
  tablesLabel: string,
): Promise<readonly DatabaseObjectNode[]> {
  if (node.reference.providerId !== "sqlite") return [];
  const [connectionId, filePath, group] = node.reference.path;
  if (node.kind === "connection" && connectionId && filePath) {
    return [{
      id: createDatabaseObjectNodeId({ providerId: "sqlite", connectionId, path: [
        { kind: "connection", value: connectionId }, { kind: "catalog", value: filePath },
      ] }),
      parentId: node.id, providerId: "sqlite", kind: "catalog", label: filePath.split(/[\\/]/).at(-1) ?? filePath,
      iconRole: "catalog", expandable: true, selectable: true, openable: false,
      reference: reference([connectionId, filePath]),
    }];
  }
  if (node.kind === "catalog" && connectionId && filePath) {
    return [{
      id: createDatabaseObjectNodeId({ providerId: "sqlite", connectionId, path: [
        { kind: "connection", value: connectionId }, { kind: "catalog", value: filePath }, { kind: "group", value: "relations" },
      ] }),
      parentId: node.id, providerId: "sqlite", kind: "group", label: tablesLabel,
      iconRole: "group", expandable: true, selectable: true, openable: false,
      reference: reference([connectionId, filePath, "relations"]),
    }];
  }
  if (node.kind === "group" && group === "relations" && connectionId && filePath) {
    const relations = await invoke<readonly { readonly name: string }[]>("sqlite_catalog_objects", { connectionId });
    return relations.map(({ name }) => ({
      id: createDatabaseObjectNodeId({ providerId: "sqlite", connectionId, path: [
        { kind: "connection", value: connectionId }, { kind: "catalog", value: filePath }, { kind: "group", value: "relations" }, { kind: "object", value: name },
      ] }),
      parentId: node.id, providerId: "sqlite", kind: "object", objectRole: "relation", label: name,
      iconRole: "relation", expandable: false, selectable: true, openable: true,
      reference: reference([connectionId, filePath, "relations", name]),
    }));
  }
  return [];
}

export function getSqliteRelationReference(node: DatabaseObjectNode): SqliteRelationReference | null {
  const path = node.reference.providerId === "sqlite" ? node.reference.path : [];
  return node.kind === "object" && node.objectRole === "relation" && path.length === 4
    ? { connectionId: path[0], relation: path[3] }
    : null;
}
