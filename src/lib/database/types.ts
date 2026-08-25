export const DATABASE_PROVIDER_IDS = ["postgresql"] as const;

export type DatabaseProviderId = (typeof DATABASE_PROVIDER_IDS)[number];

export type DatabaseFamily =
  | "relational"
  | "document"
  | "key-value"
  | "warehouse";

export type DatabaseObjectNodeKind =
  | "connection"
  | "catalog"
  | "schema"
  | "group"
  | "object";

export type DatabaseObjectRole = "relation";

export type DatabaseExplainCapability = "none" | "text" | "visual";

/**
 * Provider-runtime capabilities, not a claim that every matching UI exists.
 * New capabilities require a shared caller before they are added here.
 */
export interface DatabaseCapabilities {
  readonly supportsSchemas: boolean;
  readonly supportsTransactions: boolean;
  readonly explain: DatabaseExplainCapability;
  readonly supportsResultEditing: boolean;
  readonly supportsPagination: boolean;
  readonly supportsSshTunnel: boolean;
  readonly supportsTls: boolean;
  readonly supportsReadOnlyConnection: boolean;
  readonly supportsCodeCompletion: boolean;
  readonly supportsRelations: boolean;
}

export type DatabaseCapabilityKey =
  | "supportsSchemas"
  | "supportsTransactions"
  | "supportsResultEditing"
  | "supportsPagination"
  | "supportsSshTunnel"
  | "supportsTls"
  | "supportsReadOnlyConnection"
  | "supportsCodeCompletion"
  | "supportsRelations";

export interface DatabaseObjectModelMetadata {
  readonly hierarchy: readonly DatabaseObjectNodeKind[];
  readonly objectRoles: readonly DatabaseObjectRole[];
}

export interface DatabaseProviderDescriptor {
  readonly id: DatabaseProviderId;
  readonly displayName: string;
  readonly family: DatabaseFamily;
  readonly capabilities: DatabaseCapabilities;
  readonly objectModel: DatabaseObjectModelMetadata;
}
