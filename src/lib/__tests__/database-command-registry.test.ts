import { describe, expect, it } from "vitest";
import {
  resolveDatabaseCommand,
  type DatabaseCommandContext,
} from "@/lib/database/command-registry";
import { postgresqlProvider } from "@/lib/database/provider-registry";

const connectedNavigatorContext: DatabaseCommandContext = {
  scope: "NAVIGATOR",
  provider: postgresqlProvider,
  connectionState: "connected",
};

describe("database command resolver", () => {
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
});
