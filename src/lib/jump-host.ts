import type { ConnectionData } from '@/lib/connection-storage';

/**
 * A jump host must itself be directly reachable. A server that is configured
 * through another jump host cannot be selected as the next hop: that would ask
 * NexTerm to tunnel through a chain it has no direct connection for.
 */
export function canBeJumpHost(connection: Pick<ConnectionData, 'protocol' | 'jumpHost'>): boolean {
  const protocol = (connection.protocol ?? '').toUpperCase();
  return (protocol === 'SSH' || protocol === 'SFTP') && !(connection.jumpHost ?? '').trim();
}

export function selectJumpHostCandidates<T extends Pick<ConnectionData, 'id' | 'protocol' | 'jumpHost'>>(
  connections: readonly T[],
  excludeId?: string,
): T[] {
  return connections.filter((connection) => connection.id !== excludeId && canBeJumpHost(connection));
}
