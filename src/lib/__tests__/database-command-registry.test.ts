import { describe, expect, it } from "vitest";
import {
  resolveDatabaseCommand,
  type DatabaseCommandContext,
} from "@/lib/database/command-registry";
import { postgresqlProvider, sqliteProvider } from "@/lib/database/provider-registry";

const connectedNavigatorContext: DatabaseCommandContext = {
  scope: "NAVIGATOR",
  provider: postgresqlProvider,
  connectionState: "connected",
};

describe("database command resolver", () => {
  it("enables Execute for PostgreSQL in a connected query editor", () => {
    expect(
      resolveDatabaseCommand("database.query.execute", {
        ...connectedNavigatorContext,
        scope: "QUERY_EDITOR",
      }),
    ).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.query.execute" },
    });
  });

  it("enables Explain for PostgreSQL in a connected query editor", () => {
    expect(
      resolveDatabaseCommand("database.query.explain", {
        ...connectedNavigatorContext,
        scope: "QUERY_EDITOR",
      }),
    ).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.query.explain" },
    });
  });

  it("enables Disconnect for PostgreSQL in a connected database scope", () => {
    expect(
      resolveDatabaseCommand(
        "database.connection.disconnect",
        { ...connectedNavigatorContext, scope: "DATABASE" },
      ),
    ).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.connection.disconnect" },
    });
  });

  it("enables New Query for PostgreSQL in a connected database scope", () => {
    expect(
      resolveDatabaseCommand("database.workspace.newQuery", {
        ...connectedNavigatorContext,
        scope: "DATABASE",
      }),
    ).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.workspace.newQuery" },
    });
  });

  it("disables New Query while disconnected", () => {
    expect(
      resolveDatabaseCommand("database.workspace.newQuery", {
        ...connectedNavigatorContext,
        scope: "DATABASE",
        connectionState: "disconnected",
      }),
    ).toMatchObject({ state: "disabled", reason: "connection-state" });
  });

  it("disables Disconnect while disconnected", () => {
    expect(
      resolveDatabaseCommand("database.connection.disconnect", {
        ...connectedNavigatorContext,
        scope: "DATABASE",
        connectionState: "disconnected",
      }),
    ).toMatchObject({ state: "disabled", reason: "connection-state" });
  });

  it("hides Disconnect outside its registered scope", () => {
    expect(
      resolveDatabaseCommand("database.connection.disconnect", {
        ...connectedNavigatorContext,
        scope: "QUERY_EDITOR",
      }),
    ).toEqual({ state: "hidden", reason: "wrong-scope" });
  });

  it("enables an object command when the provider supports it in the active scope", () => {
    expect(
      resolveDatabaseCommand("database.object.open", connectedNavigatorContext),
    ).toMatchObject({ state: "enabled", descriptor: { id: "database.object.open" } });
  });

  it("disables commands when the provider capability is missing", () => {
    const providerWithoutRelations = {
      ...postgresqlProvider,
      capabilities: {
        ...postgresqlProvider.capabilities,
        supportsRelations: false,
      },
    };

    expect(
      resolveDatabaseCommand("database.object.open", {
        ...connectedNavigatorContext,
        provider: providerWithoutRelations,
      }),
    ).toMatchObject({ state: "disabled", reason: "missing-capability" });
  });

  it("disables Explain when a provider reports no Explain capability", () => {
    const providerWithoutExplain = {
      ...postgresqlProvider,
      capabilities: {
        ...postgresqlProvider.capabilities,
        explain: "none" as const,
      },
    };

    expect(
      resolveDatabaseCommand("database.query.explain", {
        ...connectedNavigatorContext,
        scope: "QUERY_EDITOR",
        provider: providerWithoutExplain,
      }),
    ).toMatchObject({ state: "disabled", reason: "missing-capability" });
  });

  it("hides commands outside their registered scope", () => {
    expect(
      resolveDatabaseCommand("database.query.execute", connectedNavigatorContext),
    ).toEqual({ state: "hidden", reason: "wrong-scope" });
  });

  it("disables connection-dependent commands while disconnected", () => {
    expect(
      resolveDatabaseCommand("database.query.execute", {
        ...connectedNavigatorContext,
        scope: "QUERY_EDITOR",
        connectionState: "disconnected",
      }),
    ).toMatchObject({ state: "disabled", reason: "connection-state" });
  });

  it("fails safely for unknown commands", () => {
    expect(
      resolveDatabaseCommand("database.unknown", connectedNavigatorContext),
    ).toEqual({ state: "hidden", reason: "unknown-command" });
  });

  it("resolves SQLite commands from its descriptor without UI provider branches", () => {
    const connectedSqlite = {
      scope: "QUERY_EDITOR" as const,
      provider: sqliteProvider,
      connectionState: "connected" as const,
    };

    expect(resolveDatabaseCommand("database.query.execute", connectedSqlite)).toMatchObject({ state: "enabled" });
    expect(resolveDatabaseCommand("database.query.execute", { ...connectedSqlite, connectionState: "disconnected" })).toMatchObject({ state: "disabled", reason: "connection-state" });
    expect(resolveDatabaseCommand("database.query.explain", connectedSqlite)).toMatchObject({ state: "disabled", reason: "missing-capability" });
    expect(resolveDatabaseCommand("database.workspace.newQuery", { ...connectedSqlite, scope: "DATABASE" })).toMatchObject({ state: "enabled" });
    expect(resolveDatabaseCommand("database.connection.disconnect", { ...connectedSqlite, scope: "DATABASE" })).toMatchObject({ state: "enabled" });
  });

  it("exposes PostgreSQL data operations only when their capabilities permit them", () => {
    expect(resolveDatabaseCommand("database.data.saveChanges", {
      ...connectedNavigatorContext,
      scope: "DATA_GRID",
    })).toMatchObject({ state: "enabled" });
    expect(resolveDatabaseCommand("database.data.nextPage", {
      ...connectedNavigatorContext,
      scope: "DATA_GRID",
    })).toMatchObject({ state: "enabled" });
    expect(resolveDatabaseCommand("database.data.saveChanges", {
      scope: "DATA_GRID",
      provider: sqliteProvider,
      connectionState: "connected",
    })).toMatchObject({ state: "disabled", reason: "missing-capability" });
  });

  it("allows tab and result commands without changing provider runtime boundaries", () => {
    expect(resolveDatabaseCommand("database.tab.close", {
      ...connectedNavigatorContext,
      scope: "WORKSPACE",
    })).toMatchObject({ state: "enabled" });
    expect(resolveDatabaseCommand("database.result.copyCell", {
      ...connectedNavigatorContext,
      scope: "DATA_GRID",
    })).toMatchObject({ state: "enabled" });
  });

  it("exposes Add/Delete Record only in the data grid with result editing capability", () => {
    const connectedGrid = {
      scope: "DATA_GRID" as const,
      provider: postgresqlProvider,
      connectionState: "connected" as const,
    };
    expect(resolveDatabaseCommand("database.data.addRecord", connectedGrid)).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.data.addRecord" },
    });
    expect(resolveDatabaseCommand("database.data.deleteRecord", connectedGrid)).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.data.deleteRecord" },
    });
    // Wrong scope hides the command even when the capability exists.
    expect(resolveDatabaseCommand("database.data.addRecord", {
      ...connectedGrid,
      scope: "QUERY_EDITOR",
    })).toMatchObject({ state: "hidden", reason: "wrong-scope" });
    // SQLite lacks result editing, so the commands are disabled.
    expect(resolveDatabaseCommand("database.data.addRecord", {
      scope: "DATA_GRID",
      provider: sqliteProvider,
      connectionState: "connected",
    })).toMatchObject({ state: "disabled", reason: "missing-capability" });
    expect(resolveDatabaseCommand("database.data.deleteRecord", {
      scope: "DATA_GRID",
      provider: sqliteProvider,
      connectionState: "connected",
    })).toMatchObject({ state: "disabled", reason: "missing-capability" });
  });

  it("enables filter commands as read operations without editing capability", () => {
    const connectedGrid = {
      scope: "DATA_GRID" as const,
      provider: postgresqlProvider,
      connectionState: "connected" as const,
    };
    expect(resolveDatabaseCommand("database.data.filterByFieldValue", connectedGrid)).toMatchObject({
      state: "enabled",
      descriptor: { id: "database.data.filterByFieldValue" },
    });
    expect(resolveDatabaseCommand("database.data.customFilter", connectedGrid)).toMatchObject({
      state: "enabled",
    });
    expect(resolveDatabaseCommand("database.data.filterSort", connectedGrid)).toMatchObject({
      state: "enabled",
    });
    expect(resolveDatabaseCommand("database.data.clearFilter", connectedGrid)).toMatchObject({
      state: "enabled",
    });
    // Read-only providers (SQLite without result editing) still expose filtering.
    expect(resolveDatabaseCommand("database.data.filterByFieldValue", {
      scope: "DATA_GRID",
      provider: sqliteProvider,
      connectionState: "connected",
    })).toMatchObject({ state: "enabled" });
    // Wrong scope hides the filter commands.
    expect(resolveDatabaseCommand("database.data.filterSort", {
      ...connectedGrid,
      scope: "QUERY_EDITOR",
    })).toMatchObject({ state: "hidden", reason: "wrong-scope" });
  });
});
