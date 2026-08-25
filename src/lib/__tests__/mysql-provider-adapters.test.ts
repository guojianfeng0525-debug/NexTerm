import { describe, expect, it, vi } from "vitest";
import { mysqlProvider } from "@/lib/database/provider-registry";
import { createMySQLNavigatorConnectionNode, getMySQLRelationReference, loadMySQLNavigatorChildren } from "@/lib/database/mysql-object-loader";
import { createMySQLQueryEditorContext } from "@/lib/database/mysql-query-editor";
import { adaptMySQLQueryResult } from "@/lib/database/mysql-result-adapter";
import { isValidMySQLPort } from "@/lib/database/mysql-profile";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([{ name: "users" }]) }));

describe("MySQL provider adapters", () => {
  it("declares only implemented P0 capabilities", () => {
    expect(mysqlProvider).toMatchObject({ id: "mysql", displayName: "MySQL (Experimental)", capabilities: { explain: "none", supportsSshTunnel: false, supportsTls: false, supportsRelations: true } });
  });
  it("builds a MySQL catalog/table hierarchy with provider-scoped identity", async () => {
    const connection = createMySQLNavigatorConnectionNode({ id: "mysql-1", name: "Fixture", database: "nexterm_e2e" });
    const catalog = (await loadMySQLNavigatorChildren(connection, "Tables"))[0]!;
    const group = (await loadMySQLNavigatorChildren(catalog, "Tables"))[0]!;
    const relation = (await loadMySQLNavigatorChildren(group, "Tables"))[0]!;
    expect(getMySQLRelationReference(relation)).toEqual({ connectionId: "mysql-1", database: "nexterm_e2e", relation: "users" });
    const secondConnection = createMySQLNavigatorConnectionNode({ id: "mysql-1", name: "Fixture", database: "other" });
    const secondCatalog = (await loadMySQLNavigatorChildren(secondConnection, "Tables"))[0]!;
    const secondGroup = (await loadMySQLNavigatorChildren(secondCatalog, "Tables"))[0]!;
    const secondRelation = (await loadMySQLNavigatorChildren(secondGroup, "Tables"))[0]!;
    expect(secondRelation.id).not.toBe(relation.id);
  });
  it("uses MySQL dialect/completion and preserves lossless cells", async () => {
    const context = createMySQLQueryEditorContext({ connectionId: "mysql-1", database: "nexterm_e2e", lookup: async () => ["users"] });
    expect(context).toMatchObject({ providerId: "mysql", languageId: "sql.mysql", catalog: "nexterm_e2e" });
    expect((await context.complete!({ kind: "relation", prefix: "" })).map((item) => item.label)).toContain("users");
    expect(adaptMySQLQueryResult({ columns: ["id", "balance", "note"], rows: [["9007199254740993", "1234567890.123456789", null]], commandTags: [], truncated: false })).toMatchObject({ kind: "tabular", rows: [["9007199254740993", "1234567890.123456789", null]] });
  });
  it("validates the complete MySQL port range", () => {
    expect(isValidMySQLPort(0)).toBe(false);
    expect(isValidMySQLPort(1)).toBe(true);
    expect(isValidMySQLPort(3306)).toBe(true);
    expect(isValidMySQLPort(65535)).toBe(true);
    expect(isValidMySQLPort(65536)).toBe(false);
  });
});
