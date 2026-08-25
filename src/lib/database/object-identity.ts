import type {
  DatabaseObjectIdentity,
  DatabaseObjectNodeId,
} from "./types";

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Creates a deterministic, provider- and hierarchy-scoped Navigator node ID. */
export function createDatabaseObjectNodeId(
  identity: DatabaseObjectIdentity,
): DatabaseObjectNodeId {
  const path = identity.path
    .map((segment) => `${segment.kind}:${encodeSegment(segment.value)}`)
    .join("/");

  return `database://${encodeSegment(identity.providerId)}/${encodeSegment(identity.connectionId)}/${path}` as DatabaseObjectNodeId;
}
