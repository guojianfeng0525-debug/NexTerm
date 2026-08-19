/**
 * Tests for the servers-view tree upgrades:
 * - root ("All Connections") folder can be renamed, rewriting all nested paths
 * - storage writes dispatch 'nexterm:connections-changed' so UIs reload
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
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
  await setupAppLock('test-pass');
  await hydrateConnectionsStorage();
});

describe('root folder rename', () => {
  it('renames the top-level folder and rewrites nested paths + connection refs', () => {
    // Default structure: All Connections / Personal / Work.
    const folders = ConnectionStorageManager.getFolders();
    expect(folders.some(f => f.path === 'All Connections')).toBe(true);

    ConnectionStorageManager.saveConnectionWithId('conn-1', {
      name: 'Srv',
      host: 'h',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      folder: 'All Connections/Work',
    });

    const ok = ConnectionStorageManager.renameFolder('All Connections', '我的服务器');
    expect(ok).toBe(true);

    const after = ConnectionStorageManager.getFolders();
    expect(after.some(f => f.path === '我的服务器')).toBe(true);
    expect(after.some(f => f.path === '我的服务器/Work')).toBe(true);
    expect(after.some(f => f.path === '我的服务器/Personal')).toBe(true);
    expect(after.some(f => f.path === 'All Connections')).toBe(false);

    const conn = ConnectionStorageManager.getConnection('conn-1');
    expect(conn?.folder).toBe('我的服务器/Work');
  });

  it('rejects a root rename that would collide with an existing folder', () => {
    ConnectionStorageManager.createFolder('Existing', undefined);
    const ok = ConnectionStorageManager.renameFolder('All Connections', 'Existing');
    expect(ok).toBe(false);
  });
});

describe('connections-changed event', () => {
  it('dispatches after a save and after a delete', () => {
    const listener = vi.fn();
    window.addEventListener('nexterm:connections-changed', listener);

    ConnectionStorageManager.saveConnectionWithId('evt-1', {
      name: 'E',
      host: 'h',
      port: 22,
      username: 'u',
      protocol: 'SSH',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    ConnectionStorageManager.updateConnection('evt-1', { name: 'X' });
    expect(listener).toHaveBeenCalledTimes(2);

    ConnectionStorageManager.deleteConnection('evt-1');
    expect(listener).toHaveBeenCalledTimes(3);

    window.removeEventListener('nexterm:connections-changed', listener);
  });
});
