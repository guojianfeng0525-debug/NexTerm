import { invoke } from "@tauri-apps/api/core";
import { createDatabaseObjectNodeId } from "./object-identity";
import type { DatabaseObjectNode, DatabaseObjectReference } from "./types";

export interface MySQLNavigatorConnection { readonly id: string; readonly name: string; readonly database: string; }
export interface MySQLRelationReference { readonly connectionId: string; readonly database: string; readonly relation: string; }

function reference(path: readonly string[]): DatabaseObjectReference { return { providerId: "mysql", path }; }

export function createMySQLNavigatorConnectionNode(connection: MySQLNavigatorConnection): DatabaseObjectNode {
  return {
    id: createDatabaseObjectNodeId({ providerId: "mysql", connectionId: connection.id, path: [{ kind: "connection", value: connection.id }] }),
    providerId: "mysql", kind: "connection", label: connection.name, iconRole: "connection", expandable: true, selectable: true, openable: false,
    reference: reference([connection.id, connection.database]),
  };
}

/** MySQL P0 uses its selected database as a catalog, without synthetic PostgreSQL schemas. */
export async function loadMySQLNavigatorChildren(node: DatabaseObjectNode, tablesLabel: string): Promise<readonly DatabaseObjectNode[]> {
  if (node.reference.providerId !== "mysql") return [];
  const [connectionId, database, group] = node.reference.path;
  if (node.kind === "connection" && connectionId && database) return [{
    id: createDatabaseObjectNodeId({ providerId: "mysql", connectionId, path: [{ kind: "connection", value: connectionId }, { kind: "catalog", value: database }] }),
    parentId: node.id, providerId: "mysql", kind: "catalog", label: database, iconRole: "catalog", expandable: true, selectable: true, openable: false, reference: reference([connectionId, database]),
  }];
  if (node.kind === "catalog" && connectionId && database) return [{
    id: createDatabaseObjectNodeId({ providerId: "mysql", connectionId, path: [{ kind: "connection", value: connectionId }, { kind: "catalog", value: database }, { kind: "group", value: "relations" }] }),
    parentId: node.id, providerId: "mysql", kind: "group", label: tablesLabel, iconRole: "group", expandable: true, selectable: true, openable: false, reference: reference([connectionId, database, "relations"]),
  }];
  if (node.kind === "group" && group === "relations" && connectionId && database) {
    const relations = await invoke<readonly { readonly name: string }[]>("mysql_catalog_objects", { connectionId });
    return relations.map(({ name }) => ({
      id: createDatabaseObjectNodeId({ providerId: "mysql", connectionId, path: [{ kind: "connection", value: connectionId }, { kind: "catalog", value: database }, { kind: "group", value: "relations" }, { kind: "object", value: name }] }),
      parentId: node.id, providerId: "mysql", kind: "object", objectRole: "relation", label: name, iconRole: "relation", expandable: false, selectable: true, openable: true, reference: reference([connectionId, database, "relations", name]),
    }));
  }
  return [];
}

export function getMySQLRelationReference(node: DatabaseObjectNode): MySQLRelationReference | null {
  const path = node.reference.providerId === "mysql" ? node.reference.path : [];
  return node.kind === "object" && node.objectRole === "relation" && path.length === 4
    ? { connectionId: path[0], database: path[1], relation: path[3] } : null;
}
