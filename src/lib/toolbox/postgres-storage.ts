/** SQLite-backed PostgreSQL data-source profiles. Secrets are encrypted per field. */
import type { PostgresConnection } from './toolbox-types';
import { decField, encField, rowClear, rowDelete, rowList, rowUpsert } from './db';

const cache: PostgresConnection[] = [];
let initialized = false;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function toRow(connection: PostgresConnection): Promise<Record<string, unknown>> {
  return {
    id: connection.id, name: connection.name, group_name: connection.group ?? null,
    environment: connection.environment, host: connection.host, port: connection.port, database_name: connection.database,
    username: connection.username, password: await encField(connection.password), default_schema: connection.defaultSchema ?? null,
    read_only: Number(connection.readOnly), auto_commit: Number(connection.autoCommit), ssl_mode: connection.sslMode,
    ssl_root_cert: connection.sslRootCert ?? null, ssl_client_cert: connection.sslClientCert ?? null,
    ssl_client_key: await encField(connection.sslClientKey), ssl_key_passphrase: await encField(connection.sslKeyPassphrase),
    ssh_enabled: Number(connection.sshEnabled), ssh_connection_id: connection.sshConnectionId ?? null, ssh_host: connection.sshHost ?? null, ssh_port: connection.sshPort ?? null,
    ssh_username: connection.sshUsername ?? null, ssh_auth_method: connection.sshAuthMethod ?? null,
    ssh_password: await encField(connection.sshPassword), ssh_private_key: await encField(connection.sshPrivateKey),
    ssh_private_key_path: connection.sshPrivateKeyPath ?? null, ssh_private_key_passphrase: await encField(connection.sshPrivateKeyPassphrase),
    ssh_host_key_fingerprint: connection.sshHostKeyFingerprint ?? null,
    created_at: connection.createdAt, updated_at: connection.updatedAt,
  };
}

async function fromRow(row: Record<string, unknown>): Promise<PostgresConnection> {
  const environment = row.environment === 'production' || row.environment === 'test' ? row.environment : 'development';
  return {
    id: str(row.id) ?? '', name: str(row.name) ?? '', group: str(row.group_name), environment,
    host: str(row.host) ?? '', port: Number(row.port ?? 5432), database: str(row.database_name) ?? '',
    username: str(row.username) ?? '', password: (await decField(str(row.password))) ?? str(row.password),
    defaultSchema: str(row.default_schema), readOnly: Boolean(row.read_only), autoCommit: Boolean(row.auto_commit),
    sslMode: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(String(row.ssl_mode))
      ? row.ssl_mode as PostgresConnection['sslMode'] : 'prefer',
    sslRootCert: str(row.ssl_root_cert), sslClientCert: str(row.ssl_client_cert),
    sslClientKey: (await decField(str(row.ssl_client_key))) ?? str(row.ssl_client_key),
    sslKeyPassphrase: (await decField(str(row.ssl_key_passphrase))) ?? str(row.ssl_key_passphrase),
    sshEnabled: Boolean(row.ssh_enabled), sshConnectionId: str(row.ssh_connection_id), sshHost: str(row.ssh_host), sshPort: row.ssh_port == null ? undefined : Number(row.ssh_port),
    sshUsername: str(row.ssh_username), sshAuthMethod: row.ssh_auth_method === 'privateKey' ? 'privateKey' : row.ssh_auth_method === 'password' ? 'password' : undefined,
    sshPassword: (await decField(str(row.ssh_password))) ?? str(row.ssh_password),
    sshPrivateKey: (await decField(str(row.ssh_private_key))) ?? str(row.ssh_private_key),
    sshPrivateKeyPath: str(row.ssh_private_key_path),
    sshPrivateKeyPassphrase: (await decField(str(row.ssh_private_key_passphrase))) ?? str(row.ssh_private_key_passphrase),
    sshHostKeyFingerprint: str(row.ssh_host_key_fingerprint), createdAt: Number(row.created_at ?? Date.now()), updatedAt: Number(row.updated_at ?? Date.now()),
  };
}

function notify(): void {
  window.dispatchEvent(new CustomEvent('nexterm:toolbox-changed', { detail: { kind: 'postgres' } }));
}

export async function hydratePostgresConnections(): Promise<void> {
  const rows = await rowList('postgres_connections');
  cache.splice(0, cache.length, ...(await Promise.all(rows.map(fromRow))));
  initialized = true;
}

export function resetPostgresConnections(): void {
  cache.splice(0, cache.length);
  initialized = false;
}

export const PostgresConnectionsStorage = {
  initialized: () => initialized,
  load: (): PostgresConnection[] => [...cache],
  async upsert(connection: PostgresConnection): Promise<boolean> {
    const persisted = await rowUpsert('postgres_connections', await toRow(connection));
    if (!persisted) return false;
    const index = cache.findIndex((item) => item.id === connection.id);
    if (index === -1) cache.push(connection); else cache[index] = connection;
    notify();
    return true;
  },
  async remove(id: string): Promise<void> {
    const index = cache.findIndex((item) => item.id === id);
    if (index !== -1) cache.splice(index, 1);
    notify();
    await rowDelete('postgres_connections', id);
  },
  async replace(items: PostgresConnection[]): Promise<void> {
    cache.splice(0, cache.length, ...items);
    await rowClear('postgres_connections');
    await Promise.all(items.map(async (item) => rowUpsert('postgres_connections', await toRow(item))));
    notify();
  },
};
