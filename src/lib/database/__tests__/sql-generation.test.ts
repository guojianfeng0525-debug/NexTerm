import { describe, expect, it } from "vitest";
import {
  generateInsertSql,
  generateSelectSql,
  generateUpdateSql,
  type ColumnMetadata,
  type SqlGenerationOptions,
} from "../sql-generation";

/** PostgreSQL quoting (mirrors tool-postgres.tsx quoteQualifiedPostgresName). */
const pg: SqlGenerationOptions = {
  quoteIdentifier: (s) => `"${s.replace(/"/g, '""')}"`,
};

/** MySQL backtick quoting. */
const mysql: SqlGenerationOptions = {
  quoteIdentifier: (s) => `\`${s.replace(/`/g, "``")}\``,
};

const usersColumns: readonly ColumnMetadata[] = [
  { name: "id", dataType: "int4", nullable: false },
  { name: "name", dataType: "text" },
  { name: "email", dataType: "text" },
];

describe("generateSelectSql", () => {
  it("quotes the qualified name and selected columns with a default limit", () => {
    expect(generateSelectSql("public", "users", usersColumns, pg)).toBe(
      'SELECT "id", "name", "email" FROM "public"."users" LIMIT 100;',
    );
  });

  it("omits the qualifier when empty", () => {
    expect(generateSelectSql("", "users", usersColumns, pg)).toBe(
      'SELECT "id", "name", "email" FROM "users" LIMIT 100;',
    );
  });

  it("respects a custom select limit", () => {
    const options: SqlGenerationOptions = { ...pg, selectLimit: 1000 };
    expect(generateSelectSql("public", "users", usersColumns, options)).toBe(
      'SELECT "id", "name", "email" FROM "public"."users" LIMIT 1000;',
    );
  });

  it("degenerates to SELECT * when columns is null", () => {
    expect(generateSelectSql("public", "users", null, pg)).toBe(
      'SELECT * FROM "public"."users" LIMIT 100;',
    );
  });

  it("uses MySQL backtick quoting", () => {
    expect(generateSelectSql("app", "users", [{ name: "id" }], mysql)).toBe(
      "SELECT `id` FROM `app`.`users` LIMIT 100;",
    );
  });

  it("escapes embedded double quotes in identifiers (PG)", () => {
    expect(generateSelectSql("public", 'weird"table', [{ name: "a" }], pg)).toBe(
      'SELECT "a" FROM "public"."weird""table" LIMIT 100;',
    );
  });

  it("escapes embedded double quotes in column names (PG)", () => {
    expect(generateSelectSql("public", "users", [{ name: 'col"umn' }], pg)).toBe(
      'SELECT "col""umn" FROM "public"."users" LIMIT 100;',
    );
  });

  it("escapes embedded backticks in identifiers (MySQL)", () => {
    expect(generateSelectSql("app", "we`ird", [{ name: "a`b" }], mysql)).toBe(
      "SELECT `a``b` FROM `app`.`we``ird` LIMIT 100;",
    );
  });

  it("honours a zero select limit", () => {
    const options: SqlGenerationOptions = { ...pg, selectLimit: 0 };
    expect(generateSelectSql("public", "users", usersColumns, options)).toBe(
      'SELECT "id", "name", "email" FROM "public"."users" LIMIT 0;',
    );
  });
});

describe("generateInsertSql", () => {
  it("emits column list with empty-string placeholders", () => {
    expect(generateInsertSql("public", "users", usersColumns, pg)).toBe(
      'INSERT INTO "public"."users" ("id", "name", "email") VALUES (\'\', \'\', \'\');',
    );
  });

  it("handles an empty column list", () => {
    expect(generateInsertSql("public", "users", [], pg)).toBe(
      'INSERT INTO "public"."users" () VALUES ();',
    );
  });

  it("preserves the given column order in names and placeholders", () => {
    const columns = [{ name: "z_last" }, { name: "a_first" }, { name: "m_middle" }];
    expect(generateInsertSql("public", "t", columns, pg)).toBe(
      'INSERT INTO "public"."t" ("z_last", "a_first", "m_middle") VALUES (\'\', \'\', \'\');',
    );
  });

  it("quotes INSERT identifiers with the MySQL dialect", () => {
    expect(generateInsertSql("app", "users", [{ name: "id" }, { name: "name" }], mysql)).toBe(
      "INSERT INTO `app`.`users` (`id`, `name`) VALUES ('', '');",
    );
  });
});

describe("generateUpdateSql", () => {
  it("sets non-primary-key columns and filters by primary key", () => {
    expect(
      generateUpdateSql("public", "users", usersColumns, ["id"], pg),
    ).toBe('UPDATE "public"."users" SET "name" = \'\', "email" = \'\' WHERE "id" = <id>;');
  });

  it("supports composite primary keys joined with AND", () => {
    expect(
      generateUpdateSql("public", "t", [{ name: "a" }, { name: "b" }, { name: "v" }], ["a", "b"], pg),
    ).toBe('UPDATE "public"."t" SET "v" = \'\' WHERE "a" = <id> AND "b" = <id>;');
  });

  it("falls back to setting every column when all are primary keys", () => {
    expect(
      generateUpdateSql("public", "t", [{ name: "id" }], ["id"], pg),
    ).toBe('UPDATE "public"."t" SET "id" = \'\' WHERE "id" = <id>;');
  });

  it("omits the WHERE clause when no primary key is given", () => {
    expect(
      generateUpdateSql("public", "users", [{ name: "name" }], [], pg),
    ).toBe('UPDATE "public"."users" SET "name" = \'\';');
  });

  it("quotes the primary key in the WHERE clause with the dialect", () => {
    expect(
      generateUpdateSql("app", "users", [{ name: "name" }], ["id"], mysql),
    ).toBe("UPDATE `app`.`users` SET `name` = '' WHERE `id` = <id>;");
  });
});
