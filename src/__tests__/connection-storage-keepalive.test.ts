import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStorageManager, hydrateConnectionsStorage } from '../lib/connection-storage';
import { buildSshConnectRequest } from '../lib/ssh-connect-request';

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('../lib/toolbox/db', () => ({
  rowList: async (table: string) => table === 'connections' ? db.rows : [],
  rowUpsert: vi.fn(async (table: string, row: Record<string, unknown>) => {
    if (table === 'connections') db.rows = [...db.rows.filter(r => r.id !== row.id), { ...row }];
    return true;
  }),
  rowDelete: vi.fn(),
  encField: async (value: unknown) => value ?? null,
  decField: async (value: unknown) => value ?? undefined,
}));
vi.mock('../lib/preferences', () => ({ prefGet: () => ({ keepAliveInterval: 5 }) }));

const legacy = { id: 'legacy', name: 'Legacy server', host: 'fixture', port: 22, username: 'fixture', protocol: 'SSH', keep_alive: 0, keep_alive_interval: null, server_alive_count_max: null };
beforeEach(() => { db.rows = [{ ...legacy }]; });

describe('persisted SSH keepalive settings', () => {
  it('enables heartbeat for legacy quick connections that never configured it', async () => {
    await hydrateConnectionsStorage();
    const connection = ConnectionStorageManager.getConnection('legacy')!;
    expect(buildSshConnectRequest('legacy', connection)).toMatchObject({ keepalive_enabled: true, keepalive_interval: 5, keepalive_max: 20 });
  });

  it('retains an explicitly configured opt-out', async () => {
    db.rows = [{ ...legacy, keep_alive_interval: 30, server_alive_count_max: 3 }];
    await hydrateConnectionsStorage();
    const connection = ConnectionStorageManager.getConnection('legacy')!;
    expect(buildSshConnectRequest('legacy', connection).keepalive_enabled).toBe(false);
  });

  it('round-trips a new opt-out even when its numeric options were omitted', async () => {
    await hydrateConnectionsStorage();
    ConnectionStorageManager.updateConnection('legacy', { keepAlive: false });
    await vi.waitFor(() => { expect(db.rows[0].keep_alive_interval).toBe(15); });
    await hydrateConnectionsStorage();
    const connection = ConnectionStorageManager.getConnection('legacy')!;
    expect(buildSshConnectRequest('legacy', connection).keepalive_enabled).toBe(false);
  });
});
