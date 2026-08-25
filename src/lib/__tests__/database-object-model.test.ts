import { describe, expect, it, vi } from "vitest";
import { createDatabaseObjectNodeId } from "@/lib/database/object-identity";
import {
  createPostgresNavigatorConnectionNode,
  getPostgresRelationReference,
  loadPostgresNavigatorChildren,
} from "@/lib/database/postgresql-object-loader";
import type { DatabaseObjectIdentity } from "@/lib/database/types";

function identity(
  connectionId: string,
  path: DatabaseObjectIdentity["path"],
): DatabaseObjectIdentity {
  return { providerId: "postgresql", connectionId, path };
}

describe("database object identity", () => {
  it("is deterministic and scopes every hierarchy segment", () => {
    const relationPath = [
      { kind: "connection", value: "connection-a" },
      { kind: "catalog", value: "db-a" },
      { kind: "schema", value: "public" },
      { kind: "group", value: "relations" },
      { kind: "object", value: "users" },
    ] as const;
    expect(createDatabaseObjectNodeId(identity("connection-a", relationPath))).toBe(
      createDatabaseObjectNodeId(identity("connection-a", relationPath)),
    );
    expect(createDatabaseObjectNodeId(identity("connection-a", relationPath))).not.toBe(
      createDatabaseObjectNodeId(identity("connection-b", relationPath)),
    );
    expect(createDatabaseObjectNodeId(identity("connection-a", relationPath))).not.toBe(
      createDatabaseObjectNodeId(
        identity("connection-a", [
          ...relationPath.slice(0, 2),
          { kind: "schema", value: "audit" },
          ...relationPath.slice(3),
        ]),
      ),
    );
    expect(createDatabaseObjectNodeId(identity("connection-a", relationPath))).not.toBe(
      createDatabaseObjectNodeId(
        identity("connection-a", [
          { kind: "connection", value: "connection-a" },
          { kind: "catalog", value: "db-b" },
          ...relationPath.slice(2),
        ]),
      ),
    );
  });

  it("scopes group IDs to their parent schema", () => {
    const group = (schema: string) =>
      createDatabaseObjectNodeId(
        identity("connection-a", [
          { kind: "connection", value: "connection-a" },
          { kind: "catalog", value: "db-a" },
          { kind: "schema", value: schema },
          { kind: "group", value: "relations" },
        ]),
      );
    expect(group("public")).not.toBe(group("audit"));
  });
});

describe("PostgreSQL object loader", () => {
  it("maps PostgreSQL metadata into shared nodes with preserved references", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "postgres_catalog_schemas") return ["public"];
      if (command === "postgres_catalog_search") {
        return [{ kind: "relation", schema: "public", name: "users" }];
      }
      return [];
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    const connection = createPostgresNavigatorConnectionNode({
      id: "connection-a",
      name: "Primary",
      database: "db-a",
    });
    const [catalog] = await loadPostgresNavigatorChildren(connection, "Tables");
    const [schema] = await loadPostgresNavigatorChildren(catalog, "Tables");
    const [group] = await loadPostgresNavigatorChildren(schema, "Tables");
    const [relation] = await loadPostgresNavigatorChildren(group, "Tables");

    expect(catalog.parentId).toBe(connection.id);
    expect(schema.parentId).toBe(catalog.id);
    expect(group.parentId).toBe(schema.id);
    expect(relation.parentId).toBe(group.id);
    expect(relation).toMatchObject({
      providerId: "postgresql",
      kind: "object",
      objectRole: "relation",
      expandable: false,
      openable: true,
    });
    expect(getPostgresRelationReference(relation)).toEqual({
      connectionId: "connection-a",
      database: "db-a",
      schema: "public",
      relation: "users",
    });
  });
});
