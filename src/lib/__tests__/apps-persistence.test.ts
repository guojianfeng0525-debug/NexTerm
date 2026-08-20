/**
 * Common-apps persistence: a saved app (with args / cwd / icon) must survive
 * an app restart and still launch with the same path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import { setupAppLock } from '../toolbox/app-lock';
import { AppsStorage, initializeToolboxStore, generateId } from '../toolbox/toolbox-storage';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  await setupAppLock('test-pass');
  await initializeToolboxStore();
});

describe('common apps persistence', () => {
  it('survives a restart with path + args + cwd + icon', async () => {
    const app = {
      id: generateId('app'),
      name: 'My Tool',
      path: '/usr/local/bin/mytool',
      args: '--flag "quoted arg"',
      cwd: '/var/lib/mytool',
      iconPath: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      createdAt: 1000,
      updatedAt: 1000,
    };
    AppsStorage.upsert(app);

    await new Promise(r => setTimeout(r, 20));
    // The row reached SQLite.
    expect(ipc.DB.toolbox_apps?.length ?? 0).toBe(1);

    // Simulate "the next day": fresh cache reloaded from SQLite.
    const { resetToolboxStore } = await import('../toolbox/toolbox-storage');
    resetToolboxStore();
    await initializeToolboxStore();

    const loaded = AppsStorage.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].path).toBe('/usr/local/bin/mytool');
    expect(loaded[0].args).toBe('--flag "quoted arg"');
    expect(loaded[0].cwd).toBe('/var/lib/mytool');
    expect(loaded[0].iconPath).toContain('data:image/png;base64,');
  });

  it('keeps the path even when a very large icon is stripped on save', async () => {
    // Simulate a guard: an oversized icon must not block persisting the app.
    const bigIcon = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
    const app = {
      id: generateId('app'),
      name: 'Big Icon App',
      path: 'C:\\Program Files\\Example\\app.exe',
      createdAt: 1000,
      updatedAt: 1000,
    };
    // Save with the large icon; the storage layer should still persist the row
    // (icon may be dropped, path must survive).
    AppsStorage.upsert({ ...app, iconPath: bigIcon } as never);

    await new Promise(r => setTimeout(r, 20));
    const { resetToolboxStore } = await import('../toolbox/toolbox-storage');
    resetToolboxStore();
    await initializeToolboxStore();

    const loaded = AppsStorage.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].path).toBe('C:\\Program Files\\Example\\app.exe');
  });
});
