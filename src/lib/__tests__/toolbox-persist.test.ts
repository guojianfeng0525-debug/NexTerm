/**
 * Toolbox (apps / services / tunnels) persistence round-trip tests.
 *
 * Guards the "save → restart → still there" contract for the three toolbox
 * features. Catches column-name mismatches like the services `cwd` vs
 * `work_dir` bug, and verifies the tunnel jump-password encrypt/decrypt loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupAppLock } from '../toolbox/app-lock';

// ── Mock Tauri IPC: in-memory SQLite stand-in ──────────────────────────────
const DB: Record<string, Record<string, unknown>[]> = {
  toolbox_apps: [],
  services: [],
  tunnels: [],
  api_collections: [],
};
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(async () => {
  for (const k of Object.keys(DB)) DB[k] = [];
  invokeMock.mockImplementation(
    (cmd: string, args?: { table?: string; row?: Record<string, unknown>; id?: string }) => {
      if (cmd === 'row_list' && args?.table) return Promise.resolve(DB[args.table] ?? []);
      if (cmd === 'row_upsert' && args?.table && args?.row) {
        const rows = DB[args.table as string];
        const pk = 'id';
        const idx = rows.findIndex(r => r[pk] === args.row![pk]);
        if (idx === -1) rows.push(args.row);
        else rows[idx] = args.row;
        return Promise.resolve();
      }
      if (cmd === 'row_delete' && args?.table && args?.id) {
        DB[args.table as string] = DB[args.table as string].filter(r => r.id !== args.id);
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    },
  );
  // Real AES-GCM key so encField/decField round-trip like production.
  await setupAppLock('toolbox-test-pass');
});

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 20));
}

describe('toolbox persistence', () => {
  it('apps survive a reload (including icon data-URL)', async () => {
    const { AppsStorage, initializeToolboxStore, generateId } = await import('../toolbox/toolbox-storage');
    const app = {
      id: generateId('app'),
      name: 'My App',
      path: '/usr/bin/example',
      args: '--flag',
      iconPath: 'data:image/png;base64,iVBORw0KGgo=',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    AppsStorage.save([app]);
    await flush();

    await import('../toolbox/toolbox-storage').then(() => initializeToolboxStore());
    await flush();
    const reloaded = AppsStorage.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].name).toBe('My App');
    expect(reloaded[0].path).toBe('/usr/bin/example');
    expect(reloaded[0].args).toBe('--flag');
    expect(reloaded[0].iconPath).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('services survive a reload — including cwd (work_dir column)', async () => {
    const { ServicesStorage, initializeToolboxStore, generateId } = await import('../toolbox/toolbox-storage');
    const now = Date.now();
    ServicesStorage.save([
      {
        id: generateId('svc'),
        name: 'web',
        command: 'node server.js',
        cwd: '/opt/project',
        args: '--port 3000',
        env: ['NODE_ENV=production'],
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await flush();

    await import('../toolbox/toolbox-storage').then(() => initializeToolboxStore());
    await flush();
    const reloaded = ServicesStorage.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].cwd).toBe('/opt/project');
    expect(reloaded[0].args).toBe('--port 3000');
    expect(reloaded[0].env).toEqual(['NODE_ENV=production']);
  });

  it('tunnels survive a reload with an encrypted jump password', async () => {
    const { TunnelsStorage, initializeToolboxStore, generateId } = await import('../toolbox/toolbox-storage');
    const now = Date.now();
    TunnelsStorage.save([
      {
        id: generateId('tun'),
        name: 'db-tunnel',
        bindAddress: '127.0.0.1',
        listenPort: 3307,
        remoteHost: 'db.internal',
        remotePort: 3306,
        jumpHost: 'bastion.example.com',
        jumpPort: 22,
        jumpUsername: 'jumpuser',
        jumpPassword: 's3cret-jump',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await flush();

    // Ciphertext must be stored — never plaintext.
    const stored = DB.tunnels[0];
    expect(String(stored.jump_password)).not.toContain('s3cret-jump');

    await import('../toolbox/toolbox-storage').then(() => initializeToolboxStore());
    await flush();
    const reloaded = TunnelsStorage.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].remoteHost).toBe('db.internal');
    expect(reloaded[0].listenPort).toBe(3307);
    expect(reloaded[0].jumpHost).toBe('bastion.example.com');
    expect(reloaded[0].jumpPassword).toBe('s3cret-jump');
  });

  it('keeps distinct saved API request IDs instead of overwriting one request', async () => {
    const { setCollection, hydrateApiDebugStorage, getCollection } = await import('../toolbox/api-debug-storage');
    const request = (id: string, name: string) => ({
      id,
      name,
      group: '',
      method: 'GET',
      url: `https://example.test/${id}`,
      params: [],
      headers: [],
      bodyType: 'none' as const,
      bodyText: '',
      auth: { type: 'none' as const, username: '', password: '', token: '', apiKeyName: '', apiKeyValue: '', apiKeyIn: 'header' as const },
      timeoutMs: 30000,
      updatedAt: Date.now(),
    });
    setCollection([request('api-a', 'A'), request('api-b', 'B')]);
    await flush();
    expect(DB.api_collections).toHaveLength(2);

    await hydrateApiDebugStorage();
    expect(getCollection().map((item) => item.id).sort()).toEqual(['api-a', 'api-b']);
  });
});
