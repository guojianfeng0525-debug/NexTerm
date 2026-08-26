import type {
  DatabaseCapabilityKey,
  DatabaseExplainCapability,
  DatabaseProviderDescriptor,
} from "./types";

export const DATABASE_COMMAND_SCOPES = [
  "DATABASE",
  "NAVIGATOR",
  "WORKSPACE",
  "QUERY_EDITOR",
  "DATA_GRID",
] as const;

export type DatabaseCommandScope = (typeof DATABASE_COMMAND_SCOPES)[number];

export const DATABASE_COMMAND_IDS = [
  "database.connection.connect",
  "database.connection.disconnect",
  "database.connection.edit",
  "database.connection.delete",
  "database.connection.refresh",
  "database.workspace.newQuery",
  "database.object.open",
  "database.object.refresh",
  "database.object.copyName",
  "database.query.execute",
  "database.query.explain",
  "database.tab.close",
  "database.tab.closeOthers",
  "database.result.copyCell",
  "database.result.copyRow",
  "database.result.copyColumnName",
  "database.result.exportCsv",
  "database.data.refresh",
  "database.data.nextPage",
  "database.data.previousPage",
  "database.data.addRecord",
  "database.data.deleteRecord",
  "database.data.saveChanges",
  "database.data.revertChanges",
] as const;

export type DatabaseCommandId = (typeof DATABASE_COMMAND_IDS)[number];

export type DatabaseConnectionState =
  | "disconnected"
  | "connecting"
  | "connected";

export interface DatabaseCommandDescriptor {
  readonly id: DatabaseCommandId;
  readonly labelKey: string;
  readonly scopes: readonly DatabaseCommandScope[];
  readonly requiredCapabilities: readonly DatabaseCommandCapabilityRequirement[];
  readonly connectionStates: readonly DatabaseConnectionState[];
}

export type DatabaseCommandCapabilityRequirement =
  | {
      readonly kind: "boolean";
      readonly capability: DatabaseCapabilityKey;
    }
  | {
      readonly kind: "explain";
      readonly supportedModes: readonly Exclude<
        DatabaseExplainCapability,
        "none"
      >[];
    };

export interface DatabaseCommandContext {
  readonly scope: DatabaseCommandScope;
  readonly provider: DatabaseProviderDescriptor;
  readonly connectionState: DatabaseConnectionState;
}

export type DatabaseCommandResolution =
  | {
      readonly state: "enabled";
      readonly descriptor: DatabaseCommandDescriptor;
    }
  | {
      readonly state: "disabled";
      readonly descriptor: DatabaseCommandDescriptor;
      readonly reason: "missing-capability" | "connection-state";
    }
  | {
      readonly state: "hidden";
      readonly reason: "unknown-command" | "wrong-scope";
    };

const commands: readonly DatabaseCommandDescriptor[] = [
  {
    id: "database.connection.connect",
    labelKey: "database.command.connection.connect",
    scopes: ["DATABASE", "NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["disconnected"],
  },
  {
    id: "database.connection.disconnect",
    labelKey: "database.command.connection.disconnect",
    scopes: ["DATABASE", "NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.connection.edit",
    labelKey: "database.command.connection.edit",
    scopes: ["DATABASE", "NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["disconnected", "connected"],
  },
  {
    id: "database.connection.delete",
    labelKey: "database.command.connection.delete",
    scopes: ["DATABASE", "NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["disconnected", "connected"],
  },
  {
    id: "database.connection.refresh",
    labelKey: "database.command.connection.refresh",
    scopes: ["DATABASE", "NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.workspace.newQuery",
    labelKey: "database.command.workspace.newQuery",
    scopes: ["DATABASE", "NAVIGATOR", "WORKSPACE"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.object.open",
    labelKey: "database.command.object.open",
    scopes: ["NAVIGATOR"],
    requiredCapabilities: [
      { kind: "boolean", capability: "supportsRelations" },
    ],
    connectionStates: ["connected"],
  },
  {
    id: "database.object.refresh",
    labelKey: "database.command.object.refresh",
    scopes: ["NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.object.copyName",
    labelKey: "database.command.object.copyName",
    scopes: ["NAVIGATOR"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.query.execute",
    labelKey: "database.command.query.execute",
    scopes: ["QUERY_EDITOR"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.query.explain",
    labelKey: "database.command.query.explain",
    scopes: ["QUERY_EDITOR"],
    requiredCapabilities: [
      { kind: "explain", supportedModes: ["text", "visual"] },
    ],
    connectionStates: ["connected"],
  },
  {
    id: "database.tab.close",
    labelKey: "database.command.tab.close",
    scopes: ["WORKSPACE"],
    requiredCapabilities: [],
    connectionStates: ["disconnected", "connected"],
  },
  {
    id: "database.tab.closeOthers",
    labelKey: "database.command.tab.closeOthers",
    scopes: ["WORKSPACE"],
    requiredCapabilities: [],
    connectionStates: ["disconnected", "connected"],
  },
  {
    id: "database.result.copyCell",
    labelKey: "database.command.result.copyCell",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.result.copyRow",
    labelKey: "database.command.result.copyRow",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.result.copyColumnName",
    labelKey: "database.command.result.copyColumnName",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.result.exportCsv",
    labelKey: "database.command.result.exportCsv",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.refresh",
    labelKey: "database.command.data.refresh",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsPagination" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.nextPage",
    labelKey: "database.command.data.nextPage",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsPagination" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.previousPage",
    labelKey: "database.command.data.previousPage",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsPagination" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.addRecord",
    labelKey: "database.command.data.addRecord",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsResultEditing" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.deleteRecord",
    labelKey: "database.command.data.deleteRecord",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsResultEditing" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.saveChanges",
    labelKey: "database.command.data.saveChanges",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsResultEditing" }],
    connectionStates: ["connected"],
  },
  {
    id: "database.data.revertChanges",
    labelKey: "database.command.data.revertChanges",
    scopes: ["DATA_GRID"],
    requiredCapabilities: [{ kind: "boolean", capability: "supportsResultEditing" }],
    connectionStates: ["connected"],
  },
];

export function getDatabaseCommand(
  id: string,
): DatabaseCommandDescriptor | undefined {
  return commands.find((command) => command.id === id);
}

export function resolveDatabaseCommand(
  id: string,
  context: DatabaseCommandContext,
): DatabaseCommandResolution {
  const descriptor = getDatabaseCommand(id);
  if (!descriptor) return { state: "hidden", reason: "unknown-command" };

  if (!descriptor.scopes.includes(context.scope)) {
    return { state: "hidden", reason: "wrong-scope" };
  }

  if (
    descriptor.requiredCapabilities.some((requirement) => {
      if (requirement.kind === "boolean") {
        return !context.provider.capabilities[requirement.capability];
      }
      const explain = context.provider.capabilities.explain;
      return explain === "none" || !requirement.supportedModes.includes(explain);
    })
  ) {
    return { state: "disabled", descriptor, reason: "missing-capability" };
  }

  if (!descriptor.connectionStates.includes(context.connectionState)) {
    return { state: "disabled", descriptor, reason: "connection-state" };
  }

  return { state: "enabled", descriptor };
}
