import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  defaultTerminalOptions,
  getTerminalOptions,
  loadAppearanceSettings,
} from '../lib/terminal-config';
import { createTestIpc, seedRow } from '../lib/__tests__/helpers/test-ipc';
import { hydratePreferences, resetPreferenceCaches } from '../lib/preferences';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

describe('terminal scrollback configuration', () => {
  beforeEach(async () => {
    for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
    resetPreferenceCaches();
    await hydratePreferences();
  });

  it('keeps at least 10000 lines in the default xterm scrollback buffer', async () => {
    const term = new Terminal({
      ...defaultTerminalOptions,
      cols: 80,
      rows: 24,
    });

    for (let i = 1; i <= 20000; i += 1) {
      term.writeln(String(i));
    }

    await new Promise<void>((resolve) => term.write('', () => resolve()));

    expect(term.options.scrollback).toBe(10000);
    expect(term.buffer.active.length).toBeGreaterThanOrEqual(10000);

    term.dispose();
  });

  it('migrates the regressed 500-line saved scrollback value back to the default', async () => {
    // Persist a regressed 500-line value through the SQLite store, then
    // simulate an app restart: reload from the stand-in.
    seedRow(ipc, 'terminal_appearance', { id: 1, scrollback: 500 });
    resetPreferenceCaches();
    await hydratePreferences();

    expect(loadAppearanceSettings().scrollback).toBe(10000);
    expect(getTerminalOptions(loadAppearanceSettings()).scrollback).toBe(10000);
  });
});
