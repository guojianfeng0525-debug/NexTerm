import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import { setupAppLock } from '../toolbox/app-lock';
import { hydratePostgresConnections, PostgresConnectionsStorage, resetPostgresConnections } from '../toolbox/postgres-storage';
import type { PostgreSQLConnectionProfile } from '../database/postgresql-profile-adapter';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

const profile: PostgreSQLConnectionProfile = {
  id: 'pg-1', name: 'Production', providerId: 'postgresql', environment: 'production', createdAt: 1, updatedAt: 1,
  providerConfig: {
    host: 'db.example.com', port: 5432, database: 'app', username: 'app_user', password: 'database-secret', defaultSchema: 'app',
    readOnly: false, autoCommit: false, sslMode: 'verify-full', sslRootCert: 'ca certificate',
    sslClientCert: 'client certificate', sslClientKey: 'client private key', sslKeyPassphrase: 'tls-secret',
    sshEnabled: true, sshHost: 'jump.example.com', sshPort: 22, sshUsername: 'jump_user',
    sshConnectionId: 'ssh-server-1', sshAuthMethod: 'privateKey', sshPrivateKey: 'ssh private key',
    sshPrivateKeyPath: '~/.ssh/id_ed25519', sshPrivateKeyPassphrase: 'ssh-secret',
    sshHostKeyFingerprint: 'SHA256:trusted',
  },
};

beforeEach(async () => {
  for (const key of Object.keys(ipc.DB)) delete ipc.DB[key];
  resetPostgresConnections();
  await setupAppLock('test-pass');
  await hydratePostgresConnections();
});

describe('PostgreSQL profile storage', () => {
  it('encrypts secrets and restores a complete profile after hydration', async () => {
    await PostgresConnectionsStorage.upsert(profile);
    const raw = ipc.DB.postgres_connections?.[0];
    expect(String(raw?.password)).not.toContain('database-secret');
    expect(String(raw?.ssh_private_key)).not.toContain('ssh private key');
    expect(String(raw?.ssl_client_key)).not.toContain('client private key');
    expect(raw).toMatchObject({
      id: 'pg-1',
      environment: 'production',
      host: 'db.example.com',
      database_name: 'app',
      read_only: 0,
      ssl_mode: 'verify-full',
      ssh_enabled: 1,
    });
    expect(raw).not.toHaveProperty('provider_id');

    resetPostgresConnections();
    await hydratePostgresConnections();
    expect(PostgresConnectionsStorage.load()).toEqual([profile]);
  });

  it('keeps the in-memory navigator unchanged when persistence fails', async () => {
    (ipc.invokeMock as unknown as { mockRejectedValueOnce: (error: Error) => void })
      .mockRejectedValueOnce(new Error('SQLite unavailable'));

    await expect(PostgresConnectionsStorage.upsert(profile)).resolves.toBe(false);
    expect(PostgresConnectionsStorage.load()).toEqual([]);
  });
});
