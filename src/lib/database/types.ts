export const DATABASE_PROVIDER_IDS = ["postgresql", "sqlite", "mysql"] as const;

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

export type DatabaseObjectRole =
  | "relation"
  | "table"
  | "view"
  | "materializedView"
  | "function"
  | "sequence"
  | "index"
  | "constraint"
  | "trigger"
  | "column";

export type DatabaseObjectIconRole =
  | "connection"
  | "catalog"
  | "schema"
  | "group"
  | "relation"
  | "table"
  | "view"
  | "materializedView"
  | "function"
  | "sequence"
  | "index"
  | "constraint"
  | "trigger"
  | "column";

/**
 * Connection node lifecycle badge (B22). Rendered next to connection root
 * nodes; providers fill it from their live session state.
 */
export type DatabaseNodeStatusBadge =
  | "connected"
  | "connecting"
  | "error"
  | "disconnected";

export type DatabaseObjectNodeId = string & {
  readonly __databaseObjectNodeId: unique symbol;
};

export interface DatabaseObjectIdentitySegment {
  readonly kind: DatabaseObjectNodeKind;
  readonly value: string;
}

export interface DatabaseObjectIdentity {
  readonly providerId: DatabaseProviderId;
  readonly connectionId: string;
  readonly path: readonly DatabaseObjectIdentitySegment[];
}

/**
 * The shared Navigator treats this path as opaque. Providers construct and
 * decode it at their boundary, keeping provider metadata out of the renderer.
 */
export interface DatabaseObjectReference {
  readonly providerId: DatabaseProviderId;
  readonly path: readonly string[];
}

export interface DatabaseObjectNode {
  readonly id: DatabaseObjectNodeId;
  readonly parentId?: DatabaseObjectNodeId;
  readonly providerId: DatabaseProviderId;
  readonly kind: DatabaseObjectNodeKind;
  readonly objectRole?: DatabaseObjectRole;
  readonly label: string;
  readonly iconRole: DatabaseObjectIconRole;
  readonly expandable: boolean;
  readonly selectable: boolean;
  readonly openable: boolean;
  readonly reference: DatabaseObjectReference;
  /** Optional accent color (B22), e.g. `#e5484d`. Pure presentation. */
  readonly accentColor?: string;
  /** Optional lifecycle badge (B22), rendered next to connection roots. */
  readonly statusBadge?: DatabaseNodeStatusBadge;
  /** Optional short text badge, e.g. a group member count. */
  readonly metaBadge?: string;
  /**
   * Distinguishes virtual connection groups (B22, rendered as group headers)
   * from provider object groups. Undefined = provider object group.
   */
  readonly groupKind?: "connection" | "schema";
  /**
   * Provider-owned optional metadata attached at node build time (e.g. a
   * column node's dataType for "copy column definition"). Treated as opaque
   * by the shared Navigator.
   */
  readonly metadata?: Readonly<Record<string, string | boolean | number | undefined>>;
}

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
