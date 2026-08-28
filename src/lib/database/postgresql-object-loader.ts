import { invoke } from "@tauri-apps/api/core";
import { createDatabaseObjectNodeId } from "./object-identity";
import type {
  DatabaseNodeStatusBadge,
  DatabaseObjectNode,
  DatabaseObjectReference,
} from "./types";

interface PostgresCatalogItem {
  readonly kind: string;
  readonly schema?: string;
  readonly name: string;
  readonly relationKind?: "r" | "p" | "v" | "m";
}

interface PostgresCatalogObjectItem {
  readonly kind: string;
  readonly schema: string;
  readonly name: string;
  readonly signature?: string;
  readonly relation?: string;
  readonly objectType?: string;
  readonly dataType?: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly ordinal?: number;
}

export interface PostgresNavigatorConnection {
  readonly id: string;
  readonly name: string;
  readonly database: string;
  /** Optional virtual connection group (B22); undefined = ungrouped. */
  readonly group?: string;
  /** Optional connection accent color (B22), e.g. `#ef4444`. */
  readonly accentColor?: string;
  /** Optional lifecycle badge (B22): connected/connecting/error/disconnected. */
  readonly statusBadge?: DatabaseNodeStatusBadge;
}

export interface PostgresRelationReference {
  readonly connectionId: string;
  readonly database: string;
  readonly schema: string;
  readonly relation: string;
  readonly objectRole?: "table" | "view" | "materializedView";
}

/** B21 object reference for the navigator object kinds (D-B21-2/4). */
export interface PostgresObjectReference {
  readonly connectionId: string;
  readonly database: string;
  readonly schema: string;
  readonly objectKind:
    | "table"
    | "view"
    | "materializedView"
    | "function"
    | "sequence"
    | "index"
    | "constraint"
    | "trigger"
    | "column";
  readonly name: string;
  /** Function identity arguments (overload disambiguation, e.g. `integer, integer`). */
  readonly signature?: string;
  /** Owning table for index/constraint/trigger/column. */
  readonly table?: string;
  /** Physical column ordinal (columns only). */
  readonly ordinal?: number;
  /** Raw function signature text `proname(args)` when overloaded. */
  readonly fullSignature?: string;
}

export interface PostgresNavigatorGroupLabels {
  readonly tables: string;
  readonly views: string;
  readonly materializedViews: string;
  readonly functions: string;
  readonly sequences: string;
  readonly columns: string;
  readonly indexes: string;
  readonly constraints: string;
  readonly triggers: string;
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
    // Double-click (or Enter) on a saved connection opens it — the provider
    // routes connection nodes to its connect flow (B22).
    openable: true,
    reference: createReference([connection.id, connection.database]),
    ...(connection.accentColor
      ? { accentColor: connection.accentColor }
      : {}),
    ...(connection.statusBadge ? { statusBadge: connection.statusBadge } : {}),
  };
}

/**
 * Builds the B22 virtual group-header node for a connection group. Group
 * headers are `kind: "group"` with `groupKind: "connection"`, which the shared
 * Navigator renders as a styled section header (D-B22-3).
 */
export function createPostgresNavigatorGroupNode(
  groupName: string,
): DatabaseObjectNode {
  const groupId = createDatabaseObjectNodeId({
    providerId: "postgresql",
    connectionId: `__group__${groupName}`,
    path: [{ kind: "group", value: groupName }],
  });
  return {
    id: groupId,
    providerId: "postgresql",
    kind: "group",
    label: groupName,
    iconRole: "group",
    expandable: false,
    selectable: false,
    openable: false,
    reference: createReference(["__group__", groupName]),
    groupKind: "connection",
    metaBadge: undefined,
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

/**
 * Builds the object-node segment path for a catalog object under a group.
 * - schema-level objects (functions/sequences): path[3] = group
 * - table-level objects (indexes/constraints/triggers/columns): path[3] = table, path[4] = sub group
 */
function objectIdentityPath(
  connectionId: string,
  database: string,
  schema: string,
  group: string,
  table: string | undefined,
  name: string,
): {
  kind: "connection" | "catalog" | "schema" | "group" | "object";
  value: string;
}[] {
  if (table) {
    return [
      { kind: "connection", value: connectionId },
      { kind: "catalog", value: database },
      { kind: "schema", value: schema },
      { kind: "object", value: table },
      { kind: "group", value: group },
      { kind: "object", value: name },
    ];
  }
  return [
    { kind: "connection", value: connectionId },
    { kind: "catalog", value: database },
    { kind: "schema", value: schema },
    { kind: "group", value: group },
    { kind: "object", value: name },
  ];
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
    // B21: five schema-level groups (D-B21-1): tables/views/materializedViews
    // + functions/sequences.
    const groups: { value: string; label: string }[] = [
      { value: "tables", label: labels.tables },
      { value: "views", label: labels.views },
      { value: "materializedViews", label: labels.materializedViews },
      { value: "functions", label: labels.functions },
      { value: "sequences", label: labels.sequences },
    ];
    return groups.map((group) => ({
      id: createDatabaseObjectNodeId({
        providerId: "postgresql",
        connectionId,
        path: [
          { kind: "connection", value: connectionId },
          { kind: "catalog", value: database },
          { kind: "schema", value: schema },
          { kind: "group", value: group.value },
        ],
      }),
      parentId: node.id,
      providerId: "postgresql",
      kind: "group",
      label: group.label,
      iconRole: "group",
      expandable: true,
      selectable: true,
      openable: false,
      reference: createReference([connectionId, database, schema, group.value]),
    }));
  }

  // Schema-level groups: functions/sequences load real catalog objects;
  // tables/views/materializedViews keep the relation-based loading.
  if (node.kind === "group" && path.length === 4) {
    const [connectionId, database, schema, group] = path;
    if (group === "functions" || group === "sequences") {
      const items = await invoke<PostgresCatalogObjectItem[]>(
        "postgres_catalog_objects",
        {
          request: { connectionId, kind: group, schema },
        },
      );
      return items.map((item) => {
        // Overloaded functions share a proname; the id encodes the identity
        // arguments so each signature occupies its own node (D-B21-3).
        const encodedName = item.signature
          ? `${item.name}(${item.signature})`
          : item.name;
        const objectRole =
          group === "functions"
            ? ("function" as const)
            : ("sequence" as const);
        return {
          id: createDatabaseObjectNodeId({
            providerId: "postgresql",
            connectionId,
            path: objectIdentityPath(
              connectionId,
              database,
              schema,
              group,
              undefined,
              encodedName,
            ),
          }),
          parentId: node.id,
          providerId: "postgresql",
          kind: "object",
          objectRole,
          label: item.name,
          iconRole: objectRole,
          expandable: false,
          selectable: true,
          openable: true,
          reference: createReference([
            connectionId,
            database,
            schema,
            group,
            encodedName,
            objectRole,
          ]),
        };
      });
    }

    const relations = await invoke<PostgresCatalogItem[]>(
      "postgres_catalog_search",
      {
        request: {
          connectionId,
          kind: "relation",
          schema,
          // `postgres_catalog_search` is a completion endpoint by default
          // (LIMIT 100); the navigator needs the full relation list so it
          // passes the same cap used by the other navigator group listings.
          limit: 10_000,
        },
      },
    );
    const relationRole = (relation: PostgresCatalogItem) => {
      if (relation.relationKind === "v") return "view" as const;
      if (relation.relationKind === "m") return "materializedView" as const;
      return "table" as const;
    };
    return relations
      .filter((relation) => {
        const role = relationRole(relation);
        return (
          (group === "tables" && role === "table") ||
          (group === "views" && role === "view") ||
          (group === "materializedViews" && role === "materializedView")
        );
      })
      .map((relation) => {
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
          // B21: tables/views/materializedViews are expandable to reveal
          // their child groups (D-B21-1).
          expandable: true,
          selectable: true,
          openable: true,
          reference: createReference([
            connectionId,
            database,
            schema,
            relation.name,
            objectRole,
          ]),
        };
      });
  }

  // Relation object node (table/view/materializedView): return its table-level
  // child groups (columns/indexes/constraints/triggers). Static structure, no
  // DB query — the groups lazy-load their own objects (D-B21-5).
  if (
    node.kind === "object" &&
    path.length === 5 &&
    (node.objectRole === "table" ||
      node.objectRole === "view" ||
      node.objectRole === "materializedView")
  ) {
    const [connectionId, database, schema, relation] = path;
    const objectRole = path[4];
    const isTable = objectRole === "table";
    const groups: { value: string; label: string }[] = [
      { value: "columns", label: labels.columns },
      ...(isTable
        ? [
            { value: "indexes", label: labels.indexes },
            { value: "constraints", label: labels.constraints },
            { value: "triggers", label: labels.triggers },
          ]
        : []),
    ];
    return groups.map((group) => ({
      id: createDatabaseObjectNodeId({
        providerId: "postgresql",
        connectionId,
        path: [
          { kind: "connection", value: connectionId },
          { kind: "catalog", value: database },
          { kind: "schema", value: schema },
          { kind: "object", value: relation },
          { kind: "group", value: group.value },
        ],
      }),
      parentId: node.id,
      providerId: "postgresql",
      kind: "group",
      label: group.label,
      iconRole: "group",
      expandable: true,
      selectable: true,
      openable: false,
      reference: createReference([
        connectionId,
        database,
        schema,
        relation,
        group.value,
      ]),
    }));
  }

  // Table-level sub-groups (columns/indexes/constraints/triggers): load the
  // objects through the catalog command.
  if (node.kind === "group" && path.length === 5) {
    const [connectionId, database, schema, relation, group] = path;
    const kind = group as
      | "columns"
      | "indexes"
      | "constraints"
      | "triggers";
    const items = await invoke<PostgresCatalogObjectItem[]>(
      "postgres_catalog_objects",
      {
        request: { connectionId, kind, schema, relation },
      },
    );
    const role: "column" | "index" | "constraint" | "trigger" =
      ((): "column" | "index" | "constraint" | "trigger" => {
        switch (group) {
          case "columns":
            return "column";
          case "indexes":
            return "index";
          case "constraints":
            return "constraint";
          case "triggers":
            return "trigger";
        }
        return "column";
      })();
    return items.map((item) => {
      const label =
        role === "constraint"
          ? constraintLabel(item.name, item.objectType)
          : item.name;
      return {
        id: createDatabaseObjectNodeId({
          providerId: "postgresql",
          connectionId,
          path: objectIdentityPath(
            connectionId,
            database,
            schema,
            group,
            relation,
            item.name,
          ),
        }),
        parentId: node.id,
        providerId: "postgresql",
        kind: "object",
        objectRole: role,
        label,
        iconRole: role,
        expandable: false,
        selectable: true,
        // Columns open their owning table (D-B21-2); indexes/constraints/
        // triggers open the object viewer.
        openable: true,
        reference: createReference([
          connectionId,
          database,
          schema,
          relation,
          group,
          item.name,
          role,
        ]),
        // Column DDL metadata for "copy column definition" (ux-spec §1.2.4).
        ...(role === "column" && item.dataType
          ? { metadata: { dataType: item.dataType } }
          : {}),
      };
    });
  }

  return [];
}
/** Constraint display label carries a type prefix (AC-21A-2). */
function constraintLabel(name: string, contype: string | undefined): string {
  const prefix = (type?: string) => {
    switch (type) {
      case "p":
        return "PRIMARY KEY";
      case "f":
        return "FOREIGN KEY";
      case "u":
        return "UNIQUE";
      case "c":
        return "CHECK";
      case "x":
        return "EXCLUDE";
      default:
        return undefined;
    }
  };
  const type = prefix(contype);
  return type ? `${type} ${name}` : name;
}

export function getPostgresRelationReference(
  node: DatabaseObjectNode,
): PostgresRelationReference | null {
  const path = postgresReference(node);
  if (
    !path ||
    node.kind !== "object" ||
    (node.objectRole !== "table" &&
      node.objectRole !== "view" &&
      node.objectRole !== "materializedView") ||
    path.length !== 5
  ) {
    return null;
  }

  const [connectionId, database, schema, relation, objectRole] = path;
  return {
    connectionId,
    database,
    schema,
    relation,
    objectRole: objectRole as PostgresRelationReference["objectRole"],
  };
}

/** Parses an encoded function name `proname(args)` back into name + args. */
function splitFunctionSignature(encoded: string): {
  name: string;
  signature: string;
} {
  const open = encoded.indexOf("(");
  if (open < 0 || !encoded.endsWith(")")) {
    return { name: encoded, signature: "" };
  }
  return {
    name: encoded.slice(0, open),
    signature: encoded.slice(open + 1, -1),
  };
}

/**
 * B21 object reference resolution for the six object kinds. Path shapes:
 * - schema-level (function/sequence): [conn, db, schema, group, name, role] (6)
 * - table-level (index/constraint/trigger/column): [conn, db, schema, table, subGroup, name, role] (7)
 */
export function getPostgresObjectReference(
  node: DatabaseObjectNode,
): PostgresObjectReference | null {
  const path = postgresReference(node);
  if (!path || node.kind !== "object") return null;
  const role = node.objectRole;
  if (
    role !== "function" &&
    role !== "sequence" &&
    role !== "index" &&
    role !== "constraint" &&
    role !== "trigger" &&
    role !== "column"
  ) {
    return null;
  }

  if (path.length === 6) {
    const [connectionId, database, schema, _group, encodedName] = path;
    const { name, signature } =
      role === "function"
        ? splitFunctionSignature(encodedName)
        : { name: encodedName, signature: "" };
    return {
      connectionId,
      database,
      schema,
      objectKind: role,
      name,
      ...(signature ? { signature } : {}),
      ...(role === "function" ? { fullSignature: encodedName } : {}),
    };
  }

  if (path.length === 7) {
    const [connectionId, database, schema, table, _subGroup, name] = path;
    return {
      connectionId,
      database,
      schema,
      objectKind: role,
      name,
      table,
    };
  }

  return null;
}
