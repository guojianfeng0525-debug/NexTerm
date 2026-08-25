import { describe, expect, it } from "vitest";
import {
  getDatabaseProvider,
  hasDatabaseProvider,
  listDatabaseProviders,
  postgresqlProvider,
  sqliteProvider,
  mysqlProvider,
} from "@/lib/database/provider-registry";

describe("database provider registry", () => {
  it("registers and resolves the PostgreSQL provider", () => {
    expect(getDatabaseProvider("postgresql")).toBe(postgresqlProvider);
    expect(hasDatabaseProvider("postgresql")).toBe(true);
  });

  it("does not resolve an unknown provider", () => {
    expect(getDatabaseProvider("unknown")).toBeUndefined();
    expect(hasDatabaseProvider("unknown")).toBe(false);
  });

  it("lists PostgreSQL, SQLite, and MySQL by stable provider identity", () => {
    expect(listDatabaseProviders().map((provider) => provider.id)).toEqual([
      "postgresql",
      "sqlite",
      "mysql",
    ]);
    expect(getDatabaseProvider("sqlite")).toBe(sqliteProvider);
    expect(hasDatabaseProvider("sqlite")).toBe(true);
    expect(getDatabaseProvider("mysql")).toBe(mysqlProvider);
    expect(hasDatabaseProvider("mysql")).toBe(true);
  });

  it("reports only PostgreSQL capabilities implemented by the current provider", () => {
    expect(postgresqlProvider.capabilities).toMatchObject({
      supportsSchemas: true,
      supportsTransactions: true,
      explain: "text",
      supportsResultEditing: true,
      supportsPagination: true,
      supportsSshTunnel: true,
      supportsTls: true,
      supportsReadOnlyConnection: true,
      supportsCodeCompletion: true,
      supportsRelations: true,
    });
    expect(postgresqlProvider.capabilities.explain).not.toBe("visual");
  });

  it("declares SQLite as a local experimental P0 provider", () => {
    expect(sqliteProvider.displayName).toContain("Experimental");
    expect(sqliteProvider.capabilities).toMatchObject({
      supportsSchemas: false,
      supportsTransactions: false,
      explain: "none",
      supportsResultEditing: false,
      supportsPagination: false,
      supportsSshTunnel: false,
      supportsTls: false,
      supportsReadOnlyConnection: true,
      supportsCodeCompletion: true,
      supportsRelations: true,
    });
  });
});
