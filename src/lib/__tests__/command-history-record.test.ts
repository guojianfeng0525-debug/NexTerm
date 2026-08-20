/**
 * Regression: executed commands must reach the command-history view.
 * Previously nothing wrote the `command_usage` / `command_history` tables
 * (only the suggestion engine's `command_stats` was updated), so the history
 * panel was always empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import { setupAppLock } from '../toolbox/app-lock';
import { hydrateCommandHistory, recordExecutedCommand, getCommandHistory, getCommandUsage } from '../command-history';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  await setupAppLock('test-pass');
  await hydrateCommandHistory();
});

describe('recordExecutedCommand', () => {
  it('records into memory and persists to SQLite', async () => {
    const listener = vi.fn();
    window.addEventListener('nexterm:command-history-changed', listener);

    recordExecutedCommand('ls -la');
    recordExecutedCommand('ls -la');
    recordExecutedCommand('git status');

    // In-memory immediately.
    expect(getCommandHistory().map((h) => h.c)).toEqual(['ls -la', 'git status']);
    expect(getCommandHistory()[0].n).toBe(2);
    expect(getCommandUsage()['ls -la']).toBe(2);

    // Async persist settles into the stand-in tables.
    await new Promise(r => setTimeout(r, 20));
    expect(ipc.DB.command_usage?.length ?? 0).toBe(2);
    expect(ipc.DB.command_history?.length ?? 0).toBe(2);
    expect(listener).toHaveBeenCalled();

    window.removeEventListener('nexterm:command-history-changed', listener);
  });

  it('restores history after a simulated restart (re-hydrate)', async () => {
    recordExecutedCommand('docker ps');
    recordExecutedCommand('npm run dev');
    await new Promise(r => setTimeout(r, 20));

    // Simulate app restart: reload from SQLite.
    await hydrateCommandHistory();

    const entries = getCommandHistory();
    expect(entries.map((h) => h.c).sort()).toEqual(['docker ps', 'npm run dev']);
    expect(getCommandUsage()['docker ps']).toBe(1);
  });

  it('ignores blank commands', () => {
    recordExecutedCommand('   ');
    expect(getCommandHistory()).toEqual([]);
  });
});
