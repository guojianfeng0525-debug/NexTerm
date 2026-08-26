/**
 * Verifies jump host + default directory survive a full save → restart →
 * re-hydrate round trip through the SQLite stand-in (with app key so the
 * encrypted jump password is persisted and decrypted back).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc, seedRow } from './helpers/test-ipc';
import { setupAppLock } from '../toolbox/app-lock';
import {
  ConnectionStorageManager,
  hydrateConnectionsStorage,
  resetConnectionsCache,
} from '../connection-storage';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  resetConnectionsCache();
  // Real app-password key so encField/decField round-trip like production.
  await setupAppLock('test-pass');
  await hydrateConnectionsStorage();
});

describe('jump host + default directory persistence', () => {
  it('save → restart → restore keeps jump config and default directory', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-jump', {
      name: 'Bastion Host',
      host: '10.0.0.50',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'target-pass',
      jumpHost: 'bastion.example.com',
      jumpPort: 2222,
      jumpUsername: 'jumpuser',
      jumpPassword: 'jump-secret',
      jumpUseKey: false,
      defaultDirectory: '/srv/data',
    });

    // Let the async persistAll settle into the SQLite stand-in. Poll for the
    // actual row instead of a fixed sleep: the encrypted write is queued, so a
    // hardcoded 10ms window is a race (flaky in full-suite runs).
    await vi.waitFor(() => {
      expect(ipc.DB.connections?.[0]?.jump_host).toBe('bastion.example.com');
    });

    // Inspect the raw stored row: jump_password must be ciphertext, not the plaintext.
    const raw = ipc.DB.connections?.[0];
    expect(raw?.jump_host).toBe('bastion.example.com');
    expect(raw?.jump_port).toBe(2222);
    expect(raw?.jump_username).toBe('jumpuser');
    expect(raw?.jump_use_key).toBe(0);
    expect(raw?.default_directory).toBe('/srv/data');
    expect(String(raw?.jump_password ?? '')).not.toContain('jump-secret');

    // Simulate app restart: drop the in-memory cache and reload from SQLite.
    resetConnectionsCache();
    await hydrateConnectionsStorage();

    const conn = ConnectionStorageManager.getConnection('conn-jump');
    expect(conn?.jumpHost).toBe('bastion.example.com');
    expect(conn?.jumpPort).toBe(2222);
    expect(conn?.jumpUsername).toBe('jumpuser');
    expect(conn?.jumpPassword).toBe('jump-secret');
    expect(conn?.jumpUseKey).toBe(false);
    expect(conn?.defaultDirectory).toBe('/srv/data');
  });

  it('updateConnection persists a newly added jump config', async () => {
    ConnectionStorageManager.saveConnectionWithId('conn-plain', {
      name: 'Plain',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'pw',
    });

    ConnectionStorageManager.updateConnection('conn-plain', {
      jumpHost: 'jump.local',
      jumpPort: 22,
      jumpUsername: 'j',
      jumpPassword: 'jp',
      jumpUseKey: false,
      defaultDirectory: '/home/j',
    });

    await vi.waitFor(() => {
      expect(ipc.DB.connections?.[0]?.jump_host).toBe('jump.local');
    });
    resetConnectionsCache();
    await hydrateConnectionsStorage();

    const conn = ConnectionStorageManager.getConnection('conn-plain');
    expect(conn?.jumpHost).toBe('jump.local');
    expect(conn?.jumpPort).toBe(22);
    expect(conn?.jumpUsername).toBe('j');
    expect(conn?.jumpPassword).toBe('jp');
    expect(conn?.defaultDirectory).toBe('/home/j');
  });

  it('hydrates a legacy row that already has jump columns', async () => {
    // Row as it would exist in an old database (pre-hydration, plaintext jump fields).
    seedRow(ipc, 'connections', {
      id: 'conn-legacy',
      name: 'Legacy',
      host: '10.0.0.2',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      auth_method: 'password',
      created_at: '2026-01-01T00:00:00.000Z',
      jump_host: 'old-jump.example.com',
      jump_port: 2200,
      jump_username: 'olduser',
      default_directory: '/opt/app',
    });
    resetConnectionsCache();
    await hydrateConnectionsStorage();

    const conn = ConnectionStorageManager.getConnection('conn-legacy');
    expect(conn?.jumpHost).toBe('old-jump.example.com');
    expect(conn?.jumpPort).toBe(2200);
    expect(conn?.jumpUsername).toBe('olduser');
    expect(conn?.defaultDirectory).toBe('/opt/app');
  });
});
