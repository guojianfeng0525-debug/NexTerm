/**
 * Regression: connections must survive a restart (re-hydrate).
 * The row sent to `row_upsert` must contain no `undefined` values (Tauri
 * invoke would fail to serialize them), and the save→reload cycle must
 * preserve the connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStorageManager, hydrateConnectionsStorage } from '../lib/connection-storage';
import { rowList, rowUpsert } from '../lib/toolbox/db';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const DB: Record<string, Record<string, unknown>[]> = {
  connections: [],
  folders: [],
  active_connections: [],
};

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(DB)) DB[k] = [];
  invokeMock.mockImplementation((cmd: string, args?: { table?: string; row?: Record<string, unknown> }) => {
    if (cmd === 'row_list' && args?.table) return Promise.resolve(DB[args.table] ?? []);
    if (cmd === 'row_upsert' && args?.table && args?.row) {
      const rows = DB[args.table as string];
      const pk = 'id';
      const idx = rows.findIndex(r => r[pk] === args.row![pk]);
      if (idx === -1) rows.push(args.row);
      else rows[idx] = args.row;
      return Promise.resolve();
    }
    if (cmd === 'row_delete') return Promise.resolve();
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
});

describe('connection persistence across restart', () => {
  it('persists a new connection to SQLite and reloads it after re-hydrate', async () => {
    // Simulate app unlock → hydrate (empty DB → legacy → defaults persisted).
    await hydrateConnectionsStorage();

    // Save a new server (as the dialog does).
    ConnectionStorageManager.saveConnectionWithId('conn-abc', {
      name: 'My Server',
      host: '10.0.0.5',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      password: 'secret',
      folder: 'All Connections/Personal',
    });

    // Let the async persistAll settle.
    await new Promise(r => setTimeout(r, 10));

    // The connection must be in the SQLite-backed store.
    expect(DB.connections.some(c => c.id === 'conn-abc')).toBe(true);
    // Regression: jump_use_key is NOT NULL in SQLite — a null would fail the
    // whole row upsert (silently losing the connection on restart).
    expect(DB.connections.find(c => c.id === 'conn-abc')?.jump_use_key).toBe(0);

    // Simulate restart: re-hydrate from SQLite (fresh module state).
    vi.resetModules();
    const fresh = await import('../lib/connection-storage');
    await fresh.hydrateConnectionsStorage();

    const conns = ConnectionStorageManager.getConnections();
    const saved = conns.find(c => c.id === 'conn-abc');
    expect(saved).toBeDefined();
    expect(saved?.name).toBe('My Server');
    expect(saved?.host).toBe('10.0.0.5');
    expect(saved?.folder).toBe('All Connections/Personal');
  });

  it('serializes rows without undefined values (safe for Tauri invoke)', async () => {
    const conn = ConnectionStorageManager.saveConnection({
      name: 'Undef Check',
      host: '10.0.0.6',
      port: 22,
      username: 'u',
      protocol: 'SSH',
      folder: 'All Connections/Work',
    });
    await new Promise(r => setTimeout(r, 10));
    const row = DB.connections.find(c => c.id === conn.id);
    expect(row).toBeDefined();
    for (const [k, v] of Object.entries(row!)) {
      expect(v, `column ${k} must not be undefined`).not.toBeUndefined();
    }
  });
});
