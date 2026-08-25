import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  createSqliteNavigatorConnectionNode,
  getSqliteRelationReference,
  loadSqliteNavigatorChildren,
} from "@/lib/database/sqlite-object-loader";
import { createSqliteQueryEditorContext } from "@/lib/database/sqlite-query-editor";

describe("SQLite provider adapters", () => {
  it("maps a file-backed catalog into shared navigator nodes", async () => {
    mocks.invoke.mockResolvedValueOnce([{ name: "projects" }, { name: "users" }]);
    const connection = createSqliteNavigatorConnectionNode({ id: "sqlite-1", name: "Fixture", filePath: "/tmp/fixture.db" });
    const [catalog] = await loadSqliteNavigatorChildren(connection, "Tables");
    const [group] = await loadSqliteNavigatorChildren(catalog!, "Tables");
    const relations = await loadSqliteNavigatorChildren(group!, "Tables");

    expect(catalog).toMatchObject({ providerId: "sqlite", kind: "catalog", label: "fixture.db" });
    expect(group).toMatchObject({ providerId: "sqlite", kind: "group", label: "Tables" });
    expect(relations.map((item) => item.label)).toEqual(["projects", "users"]);
    expect(getSqliteRelationReference(relations[1]!)).toEqual({ connectionId: "sqlite-1", relation: "users" });
    expect(mocks.invoke).toHaveBeenCalledWith("sqlite_catalog_objects", { connectionId: "sqlite-1" });
  });

  it("provides SQLite keywords and fixture metadata completion", async () => {
    const context = createSqliteQueryEditorContext({ connectionId: "sqlite-1", lookup: async () => ["users", "projects"] });
    const items = await context.complete!({ kind: "relation", prefix: "" });

    expect(context).toMatchObject({ providerId: "sqlite", languageId: "sql.sqlite", connectionId: "sqlite-1" });
    expect(items).toContainEqual({ label: "SELECT", kind: "function" });
    expect(items).toContainEqual({ label: "users", kind: "relation" });
    expect(items).toContainEqual({ label: "projects", kind: "relation" });
  });
});
