import { describe, expect, it, vi } from "vitest";
import {
  createPostgresNavigatorConnectionNode,
  createPostgresNavigatorGroupNode,
  getPostgresObjectReference,
  getPostgresRelationReference,
  loadPostgresNavigatorChildren,
} from "@/lib/database/postgresql-object-loader";
import type { DatabaseObjectNode } from "@/lib/database/types";

const labels = {
  tables: "Tables",
  views: "Views",
  materializedViews: "Materialized Views",
  functions: "Functions",
  sequences: "Sequences",
  columns: "Columns",
  indexes: "Indexes",
  constraints: "Constraints",
  triggers: "Triggers",
};

function invokeMock(
  handler: (command: string, args: unknown) => unknown,
) {
  const invoke = vi.fn(async (command: string, args?: { request?: unknown }) =>
    handler(command, args?.request),
  );
  Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
  return invoke;
}

/** Walks the loader tree by simulating expansion until a matching node appears. */
async function expandTo(
  roots: readonly DatabaseObjectNode[],
  nodes: readonly DatabaseObjectNode[],
  matcher: (node: DatabaseObjectNode) => boolean,
): Promise<DatabaseObjectNode | null> {
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift()!;
    if (matcher(node)) return node;
    if (node.expandable) {
      const children = await loadPostgresNavigatorChildren(node, labels);
      queue.push(...children);
    }
  }
  return null;
}

describe("postgres object model (B21)", () => {
  describe("getPostgresObjectReference path decoding", () => {
    const connection = createPostgresNavigatorConnectionNode({
      id: "conn-1",
      name: "Primary",
      database: "db-a",
    });

    it("decodes a schema-level function node with signature (overload)", () => {
      const node: DatabaseObjectNode = {
        id: "database://postgresql/conn-1/connection:conn-1/catalog:db-a/schema:public/group:functions/object:add_numbers(integer%2C%20integer)/function" as DatabaseObjectNode["id"],
        parentId: connection.id,
        providerId: "postgresql",
        kind: "object",
        objectRole: "function",
        label: "add_numbers",
        iconRole: "function",
        expandable: false,
        selectable: true,
        openable: true,
        reference: {
          providerId: "postgresql",
          path: [
            "conn-1",
            "db-a",
            "public",
            "functions",
            "add_numbers(integer, integer)",
            "function",
          ],
        },
      };
      const reference = getPostgresObjectReference(node);
      expect(reference).toEqual({
        connectionId: "conn-1",
        database: "db-a",
        schema: "public",
        objectKind: "function",
        name: "add_numbers",
        signature: "integer, integer",
        fullSignature: "add_numbers(integer, integer)",
      });
    });

    it("decodes a schema-level sequence node", () => {
      const node: DatabaseObjectNode = {
        id: "x" as DatabaseObjectNode["id"],
        providerId: "postgresql",
        kind: "object",
        objectRole: "sequence",
        label: "order_seq",
        iconRole: "sequence",
        expandable: false,
        selectable: true,
        openable: true,
        reference: {
          providerId: "postgresql",
          path: ["conn-1", "db-a", "public", "sequences", "order_seq", "sequence"],
        },
      };
      expect(getPostgresObjectReference(node)).toEqual({
        connectionId: "conn-1",
        database: "db-a",
        schema: "public",
        objectKind: "sequence",
        name: "order_seq",
      });
    });

    it("decodes table-level index/constraint/trigger/column nodes", () => {
      for (const [role, subGroup] of [
        ["index", "indexes"],
        ["constraint", "constraints"],
        ["trigger", "triggers"],
        ["column", "columns"],
      ] as const) {
        const node: DatabaseObjectNode = {
          id: "x" as DatabaseObjectNode["id"],
          providerId: "postgresql",
          kind: "object",
          objectRole: role,
          label: "orders_pkey",
          iconRole: role,
          expandable: false,
          selectable: true,
          openable: true,
          reference: {
            providerId: "postgresql",
            path: [
              "conn-1",
              "db-a",
              "public",
              "orders",
              subGroup,
              "orders_pkey",
              role,
            ],
          },
        };
        const reference = getPostgresObjectReference(node);
        expect(reference).toEqual({
          connectionId: "conn-1",
          database: "db-a",
          schema: "public",
          objectKind: role,
          name: "orders_pkey",
          table: "orders",
        });
      }
    });

    it("rejects relation nodes (handled by getPostgresRelationReference)", () => {
      const node: DatabaseObjectNode = {
        id: "x" as DatabaseObjectNode["id"],
        providerId: "postgresql",
        kind: "object",
        objectRole: "table",
        label: "orders",
        iconRole: "table",
        expandable: true,
        selectable: true,
        openable: true,
        reference: {
          providerId: "postgresql",
          path: ["conn-1", "db-a", "public", "orders", "table"],
        },
      };
      expect(getPostgresObjectReference(node)).toBeNull();
      expect(getPostgresRelationReference(node)).toEqual({
        connectionId: "conn-1",
        database: "db-a",
        schema: "public",
        relation: "orders",
        objectRole: "table",
      });
    });

    it("distinguishes overloaded function nodes by their encoded id", () => {
      const load = invokeMock((command) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        if (command === "postgres_catalog_objects") {
          return [
            { kind: "function", schema: "public", name: "add_numbers", signature: "integer, integer" },
            { kind: "function", schema: "public", name: "add_numbers", signature: "integer, text" },
          ];
        }
        return [];
      });
      void load;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      return Promise.resolve().then(async () => {
        const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
        const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
        const groups = await loadPostgresNavigatorChildren(schema, labels);
        const functions = groups[3];
        expect(functions.label).toBe("Functions");
        const items = await loadPostgresNavigatorChildren(functions, labels);
        expect(items).toHaveLength(2);
        expect(items[0].id).not.toBe(items[1].id);
        // Labels stay proname-only; signatures live in the reference.
        expect(items.map((item) => item.label)).toEqual([
          "add_numbers",
          "add_numbers",
        ]);
        expect(getPostgresObjectReference(items[0])?.signature).toBe(
          "integer, integer",
        );
        expect(getPostgresObjectReference(items[1])?.signature).toBe(
          "integer, text",
        );
      });
    });
  });

  describe("tree structure (B21 D-B21-1)", () => {
    it("lists five schema-level groups: tables/views/materializedViews/functions/sequences", async () => {
      const invoke = invokeMock((command) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        return [];
      });
      void invoke;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
      const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
      const groups = await loadPostgresNavigatorChildren(schema, labels);
      expect(groups.map((group) => group.label)).toEqual([
        "Tables",
        "Views",
        "Materialized Views",
        "Functions",
        "Sequences",
      ]);
    });

    it("expands a table node into columns/indexes/constraints/triggers sub-groups", async () => {
      const invoke = invokeMock((command) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        if (command === "postgres_catalog_search") {
          return [{ kind: "relation", schema: "public", name: "orders", relationKind: "r" }];
        }
        return [];
      });
      void invoke;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
      const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
      const [tables] = await loadPostgresNavigatorChildren(schema, labels);
      const [orders] = await loadPostgresNavigatorChildren(tables, labels);
      expect(orders.objectRole).toBe("table");
      expect(orders.expandable).toBe(true);
      const subGroups = await loadPostgresNavigatorChildren(orders, labels);
      expect(subGroups.map((group) => group.label)).toEqual([
        "Columns",
        "Indexes",
        "Constraints",
        "Triggers",
      ]);
      expect(subGroups.every((group) => group.kind === "group")).toBe(true);
    });

    it("expands a view node into columns only", async () => {
      const invoke = invokeMock((command) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        if (command === "postgres_catalog_search") {
          return [{ kind: "relation", schema: "public", name: "active_users", relationKind: "v" }];
        }
        return [];
      });
      void invoke;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
      const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
      const [, views] = await loadPostgresNavigatorChildren(schema, labels);
      const [view] = await loadPostgresNavigatorChildren(views, labels);
      expect(view.objectRole).toBe("view");
      expect(view.expandable).toBe(true);
      const subGroups = await loadPostgresNavigatorChildren(view, labels);
      expect(subGroups.map((group) => group.label)).toEqual(["Columns"]);
    });

    it("loads columns in attnum order with metadata from the catalog command", async () => {
      const invoke = invokeMock((command, request) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        if (command === "postgres_catalog_search") {
          return [{ kind: "relation", schema: "public", name: "orders", relationKind: "r" }];
        }
        if (command === "postgres_catalog_objects") {
          if ((request as { kind?: string } | undefined)?.kind === "columns") {
            return [
              { kind: "column", schema: "public", name: "id", relation: "orders", dataType: "integer", nullable: false, ordinal: 1 },
              { kind: "column", schema: "public", name: "name", relation: "orders", dataType: "text", nullable: true, ordinal: 2 },
            ];
          }
        }
        return [];
      });
      void invoke;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
      const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
      const [tables] = await loadPostgresNavigatorChildren(schema, labels);
      const [orders] = await loadPostgresNavigatorChildren(tables, labels);
      const [columns] = await loadPostgresNavigatorChildren(orders, labels);
      const items = await loadPostgresNavigatorChildren(columns, labels);
      expect(items.map((item) => item.label)).toEqual(["id", "name"]);
      expect(items.every((item) => item.objectRole === "column")).toBe(true);
      expect(items.every((item) => !item.expandable)).toBe(true);
      expect(items.every((item) => item.openable)).toBe(true);
      const ref = getPostgresObjectReference(items[0]);
      expect(ref?.table).toBe("orders");
      expect(ref?.name).toBe("id");
    });

    it("labels constraints with their type prefix (AC-21A-2)", async () => {
      const invoke = invokeMock((command, request) => {
        if (command === "postgres_catalog_schemas") return ["public"];
        if (command === "postgres_catalog_search") {
          return [{ kind: "relation", schema: "public", name: "orders", relationKind: "r" }];
        }
        if (command === "postgres_catalog_objects") {
          if ((request as { kind?: string } | undefined)?.kind === "constraints") {
            return [
              { kind: "constraint", schema: "public", name: "orders_pkey", relation: "orders", objectType: "p" },
              { kind: "constraint", schema: "public", name: "orders_user_id_fkey", relation: "orders", objectType: "f" },
              { kind: "constraint", schema: "public", name: "orders_status_check", relation: "orders", objectType: "c" },
            ];
          }
        }
        return [];
      });
      void invoke;
      const connection = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Primary",
        database: "db-a",
      });
      const [catalog] = await loadPostgresNavigatorChildren(connection, labels);
      const [schema] = await loadPostgresNavigatorChildren(catalog, labels);
      const [tables] = await loadPostgresNavigatorChildren(schema, labels);
      const [orders] = await loadPostgresNavigatorChildren(tables, labels);
      const [, , constraints] = await loadPostgresNavigatorChildren(orders, labels);
      const items = await loadPostgresNavigatorChildren(constraints, labels);
      expect(items.map((item) => item.label)).toEqual([
        "PRIMARY KEY orders_pkey",
        "FOREIGN KEY orders_user_id_fkey",
        "CHECK orders_status_check",
      ]);
    });
  });

  describe("connection grouping and presentation (B22)", () => {
    it("carries group, accentColor and statusBadge onto the connection node", () => {
      const node = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Prod",
        database: "app",
        group: "prod",
        accentColor: "#ef4444",
        statusBadge: "disconnected",
      });
      expect(node.kind).toBe("connection");
      expect(node.accentColor).toBe("#ef4444");
      expect(node.statusBadge).toBe("disconnected");
      expect(node.reference.path).toEqual(["conn-1", "app"]);
    });

    it("builds a virtual group header with groupKind connection", () => {
      const node = createPostgresNavigatorGroupNode("prod");
      expect(node.kind).toBe("group");
      expect(node.groupKind).toBe("connection");
      expect(node.label).toBe("prod");
      expect(node.expandable).toBe(false);
      expect(node.selectable).toBe(false);
      expect(node.openable).toBe(false);
    });

    it("connection nodes are openable so double-click connects (B22)", () => {
      const node = createPostgresNavigatorConnectionNode({
        id: "conn-1",
        name: "Prod",
        database: "app",
      });
      expect(node.openable).toBe(true);
    });

    it("omits optional presentation fields when absent", () => {
      const node = createPostgresNavigatorConnectionNode({
        id: "conn-2",
        name: "Plain",
        database: "app",
      });
      expect(node.accentColor).toBeUndefined();
      expect(node.statusBadge).toBeUndefined();
    });
  });
});
