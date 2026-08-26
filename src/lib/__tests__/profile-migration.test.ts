import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import { setupAppLock } from '../toolbox/app-lock';
import {
  hydratePostgresConnections,
  PostgresConnectionsStorage,
  resetPostgresConnections,
} from '../toolbox/postgres-storage';
import { hydrateSqliteConnections, SqliteConnectionsStorage } from '../toolbox/sqlite-storage';
import type { PostgreSQLConnectionProfile } from '../database/postgresql-profile-adapter';
import {
  isValidColor,
  isValidGroupName,
  mergeConnections,
  parseConnectionsImport,
  serializeConnectionsExport,
} from '../connections-io';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({}));
vi.mock('@tauri-apps/plugin-fs', () => ({}));

function profile(overrides: Partial<PostgreSQLConnectionProfile> = {}): PostgreSQLConnectionProfile {
  return {
    id: 'pg-1', name: 'Production', providerId: 'postgresql', environment: 'production', createdAt: 1, updatedAt: 1,
    providerConfig: {
      host: 'db.example.com', port: 5432, database: 'app', username: 'app_user', password: 'database-secret',
      readOnly: false, autoCommit: false, sslMode: 'prefer', sshEnabled: false,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  for (const key of Object.keys(ipc.DB)) delete ipc.DB[key];
  resetPostgresConnections();
  await setupAppLock('test-pass');
  await hydratePostgresConnections();
  await hydrateSqliteConnections();
});

describe('B22 color/group persistence migration', () => {
  it('persists and restores the accent color field', async () => {
    const withColor = profile({
      providerConfig: { ...profile().providerConfig, color: '#ef4444' },
    });
    await PostgresConnectionsStorage.upsert(withColor);

    const raw = ipc.DB.postgres_connections?.[0];
    expect(raw?.color).toBe('#ef4444');
    expect(String(raw?.password)).not.toContain('database-secret');

    resetPostgresConnections();
    await hydratePostgresConnections();
    const restored = PostgresConnectionsStorage.load()[0];
    expect(restored.providerConfig.color).toBe('#ef4444');
  });

  it('keeps color undefined when the column is absent (legacy rows)', async () => {
    // Simulate a legacy row written before the `color` column existed.
    const legacy = {
      id: 'pg-legacy', name: 'Legacy', group_name: null, environment: 'development',
      host: 'h', port: 5432, database_name: 'd', username: 'u',
      created_at: 1, updated_at: 1,
    };
    ipc.DB.postgres_connections = [legacy];
    resetPostgresConnections();
    await hydratePostgresConnections();
    const restored = PostgresConnectionsStorage.load()[0];
    expect(restored).toBeDefined();
    expect(restored.providerConfig.color).toBeUndefined();
    expect(restored.group).toBeUndefined();
  });

  it('persists the group field through the profile adapter', async () => {
    const grouped = profile({ group: 'prod', name: 'Prod A' });
    await PostgresConnectionsStorage.upsert(grouped);
    const raw = ipc.DB.postgres_connections?.[0];
    expect(raw?.group_name).toBe('prod');

    resetPostgresConnections();
    await hydratePostgresConnections();
    expect(PostgresConnectionsStorage.load()[0].group).toBe('prod');
  });

  it('syncs color on the SQLite storage twin', async () => {
    await SqliteConnectionsStorage.upsert({
      id: 'sqlite-1', name: 'Local', providerId: 'sqlite', environment: 'development', createdAt: 1, updatedAt: 1,
      providerConfig: { filePath: '/tmp/a.db', readOnly: false, color: '#22c55e' },
    });
    const raw = ipc.DB.database_sqlite_connections?.[0];
    expect(raw?.color).toBe('#22c55e');

    // SQLite storage has no explicit reset export; hydrate re-seeds the cache.
    await hydrateSqliteConnections();
    expect(SqliteConnectionsStorage.load()[0].providerConfig.color).toBe('#22c55e');
  });
});

describe('B22 group/color validation', () => {
  it('rejects path traversal and separator group names', () => {
    expect(isValidGroupName('prod')).toBe(true);
    expect(isValidGroupName('业务线 A')).toBe(true);
    expect(isValidGroupName('../../x')).toBe(false);
    expect(isValidGroupName('a/b')).toBe(false);
    expect(isValidGroupName('a\\b')).toBe(false);
    expect(isValidGroupName('x'.repeat(129))).toBe(false);
    expect(isValidGroupName('')).toBe(false);
    expect(isValidGroupName('ctrl\u0007char')).toBe(false);
  });

  it('accepts only #RRGGBB hex colors', () => {
    expect(isValidColor('#ef4444')).toBe(true);
    expect(isValidColor('#1a2b3c')).toBe(true);
    expect(isValidColor('red')).toBe(false);
    expect(isValidColor('#ef44')).toBe(false);
    expect(isValidColor('red;background:url(x)')).toBe(false);
    expect(isValidColor('#gggggg')).toBe(false);
  });
});

describe('B22 connection import/export serialization', () => {
  const secretProfile = profile({
    id: 'pg-secret', name: 'Secret Box', group: 'prod',
    providerConfig: {
      ...profile().providerConfig,
      password: 'p@ssw0rd-UNIQUE-abc',
      sslClientKey: 'client-key-abc',
      sshPassword: 'ssh-pass-abc',
      color: '#ef4444',
    },
  });

  it('exports plaintext file without any plaintext secret', async () => {
    const text = await serializeConnectionsExport([secretProfile]);
    expect(text).not.toContain('p@ssw0rd-UNIQUE-abc');
    expect(text).not.toContain('client-key-abc');
    expect(text).not.toContain('ssh-pass-abc');
    expect(text).toContain('"format": "nexterm-connections"');
    expect(text).toContain('"color"');
    expect(text).toContain('__hasPassword:password');
  });

  it('exports encrypted file with v1 envelopes, not plaintext', async () => {
    const text = await serializeConnectionsExport([secretProfile], { encryptWithPassphrase: 'correct horse' });
    expect(text).not.toContain('p@ssw0rd-UNIQUE-abc');
    expect(text).toContain('"credentialsEncrypted": true');
    expect(text).toMatch(/"password": "v1:/);
  });

  it('round-trips secrets with the correct passphrase', async () => {
    const text = await serializeConnectionsExport([secretProfile], { encryptWithPassphrase: 'correct horse' });
    const imported = await parseConnectionsImport(text, 'correct horse');
    expect(imported.secretFailures).toEqual([]);
    const restored = imported.connections[0];
    expect(restored.profile.name).toBe('Secret Box');
    expect(restored.secrets?.password).toBe('p@ssw0rd-UNIQUE-abc');
    expect(restored.secrets?.sslClientKey).toBe('client-key-abc');
    expect(restored.secrets?.sshPassword).toBe('ssh-pass-abc');
    // Non-secret fields survive too.
    expect(restored.profile.providerConfig.host).toBe('db.example.com');
  });

  it('fails secret decryption with a wrong passphrase and does not leak plaintext', async () => {
    const text = await serializeConnectionsExport([secretProfile], { encryptWithPassphrase: 'correct horse' });
    const imported = await parseConnectionsImport(text, 'wrong passphrase');
    expect(imported.secretFailures.length).toBeGreaterThan(0);
    expect(imported.connections[0].secrets?.password).toBeUndefined();
  });

  it('requires a passphrase for encrypted files', async () => {
    const text = await serializeConnectionsExport([secretProfile], { encryptWithPassphrase: 'correct horse' });
    await expect(parseConnectionsImport(text)).rejects.toThrow('passphrase required');
  });

  it('rejects malformed JSON with a generic message', async () => {
    await expect(parseConnectionsImport('{not json')).rejects.toThrow('invalid import file');
    await expect(parseConnectionsImport('')).rejects.toThrow('invalid import file');
    await expect(parseConnectionsImport('{"format":"other","version":1,"connections":[]}')).rejects.toThrow('invalid import file');
  });

  it('rejects oversized files', async () => {
    await expect(parseConnectionsImport('x'.repeat(5 * 1024 * 1024 + 1))).rejects.toThrow('invalid import file');
  });

  it('sanitizes prototype-pollution keys on import', async () => {
    const file = {
      format: 'nexterm-connections',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentialsEncrypted: false,
      connections: [{
        id: 'pg-polluted', name: 'Polluted', environment: 'development',
        host: 'h', port: 5432, database: 'd', username: 'u',
        readOnly: false, autoCommit: true, sslMode: 'prefer',
        constructor: { prototype: { polluted: true } },
        '__proto__': { polluted: true },
      }],
    };
    const imported = await parseConnectionsImport(JSON.stringify(file));
    expect(imported.connections).toHaveLength(1);
    expect((imported.connections[0].profile as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects invalid group names and colors on import', async () => {
    const badGroup = {
      format: 'nexterm-connections', version: 1, exportedAt: 'now', credentialsEncrypted: false,
      connections: [{ id: 'x', name: 'X', environment: 'development', host: 'h', port: 5432, database: 'd', username: 'u', readOnly: false, autoCommit: true, sslMode: 'prefer', group: '../../etc' }],
    };
    await expect(parseConnectionsImport(JSON.stringify(badGroup))).rejects.toThrow('invalid import file');

    const badColor = {
      format: 'nexterm-connections', version: 1, exportedAt: 'now', credentialsEncrypted: false,
      connections: [{ id: 'y', name: 'Y', environment: 'development', host: 'h', port: 5432, database: 'd', username: 'u', readOnly: false, autoCommit: true, sslMode: 'prefer', color: 'red;background:url(1)' }],
    };
    await expect(parseConnectionsImport(JSON.stringify(badColor))).rejects.toThrow('invalid import file');
  });

  it('rejects unknown environments and ssl modes on import', async () => {
    const badEnv = {
      format: 'nexterm-connections', version: 1, exportedAt: 'now', credentialsEncrypted: false,
      connections: [{ id: 'z', name: 'Z', environment: 'prod', host: 'h', port: 5432, database: 'd', username: 'u', readOnly: false, autoCommit: true, sslMode: 'prefer' }],
    };
    await expect(parseConnectionsImport(JSON.stringify(badEnv))).rejects.toThrow('invalid import file');
  });
});

describe('B22 import merge strategy', () => {
  it('append skips same-name connections and adds new ones', () => {
    const current = [profile({ id: 'a', name: 'Same', host: 'old' } as never)];
    const imported = [
      profile({ id: 'b', name: 'Same', providerConfig: { ...profile().providerConfig, host: 'new' } }),
      profile({ id: 'c', name: 'Brand New' }),
    ];
    const merged = mergeConnections(current, imported, 'append');
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('a');
    expect(merged[1].name).toBe('Brand New');
  });

  it('overwrite replaces same-name connections', () => {
    const current = [profile({ id: 'a', name: 'Same', providerConfig: { ...profile().providerConfig, host: 'old' } })];
    const imported = [
      profile({ id: 'b', name: 'Same', providerConfig: { ...profile().providerConfig, host: 'new', color: '#ef4444' } }),
    ];
    const merged = mergeConnections(current, imported, 'overwrite');
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('b');
    expect(merged[0].providerConfig.host).toBe('new');
    expect(merged[0].providerConfig.color).toBe('#ef4444');
  });
});
