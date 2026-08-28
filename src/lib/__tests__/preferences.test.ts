/**
 * Preference persistence round-trip tests.
 *
 * Guards the "toggle → restart → still on" contract for UI preferences
 * (show-resources, command suggestions, …). Regression: SQLite stores
 * INTEGER booleans as 0/1 numbers, but `prefGet` used to require a real
 * `boolean`, so every persisted `1` was read back as `false` and settings
 * silently reset on every launch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock Tauri IPC: in-memory SQLite stand-in ──────────────────────────────
const DB: Record<string, Record<string, unknown>[]> = {
  app_settings: [],
  layout_config: [],
  terminal_appearance: [],
  editor_config: [],
};
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(async () => {
  for (const k of Object.keys(DB)) DB[k] = [];
  invokeMock.mockImplementation(
    (cmd: string, args?: { table?: string; row?: Record<string, unknown>; key?: string }) => {
      if (cmd === 'row_get' && args?.table) {
        const rows = DB[args.table] ?? [];
        const row = rows.find(r => String(r.id) === String(args.key));
        return Promise.resolve(row ?? null);
      }
      if (cmd === 'row_upsert' && args?.table && args?.row) {
        const rows = DB[args.table];
        // Mirrors the backend json_to_sql: booleans are stored as INTEGER 0/1
        // and come back as numbers — the exact shape that broke prefGet.
        const stored: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args.row)) {
          stored[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
        }
        const idx = rows.findIndex(r => String(r.id) === String(stored.id));
        if (idx === -1) rows.push(stored);
        else rows[idx] = stored;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    },
  );
  const { resetPreferenceCaches } = await import('../preferences');
  resetPreferenceCaches();
});

async function hydrate(): Promise<void> {
  const { hydratePreferences } = await import('../preferences');
  await hydratePreferences();
}

describe('preferences persistence', () => {
  it('show-resources survives a reload (SQLite number 0/1 → boolean)', async () => {
    const { prefGet, prefSet, resetPreferenceCaches } = await import('../preferences');
    // Hydrate first so prefSet writes to the SQLite stand-in, then toggle on.
    await hydrate();
    prefSet('nexterm:toolbox:show-resources', true);
    // The stored column is the INTEGER 1, not a boolean.
    expect(DB.app_settings[0]?.show_resources).toBe(1);
    // Simulate app restart: drop the in-memory cache and reload from SQLite.
    resetPreferenceCaches();
    await hydrate();
    expect(prefGet<boolean>('nexterm:toolbox:show-resources', false)).toBe(true);
  });

  it('show-resources reads false when stored as 0', async () => {
    DB.app_settings = [{ id: 1, show_resources: 0 }];
    await hydrate();
    const { prefGet } = await import('../preferences');
    expect(prefGet<boolean>('nexterm:toolbox:show-resources', false)).toBe(false);
  });

  it('command-suggestions column round-trips through sshClientSettings', async () => {
    const { prefGet, prefSet, resetPreferenceCaches } = await import('../preferences');
    await hydrate();
    prefSet('sshClientSettings', {
      theme: 'dark',
      autoReconnect: true,
      logLevel: 'info',
      maxLogSize: 100,
      savePasswords: false,
      autoLockTimeout: 30,
      hostKeyVerification: true,
      enableNotifications: true,
      showConnectionManager: true,
      showSystemMonitor: true,
      showStatusBar: true,
      commandSuggestions: false,
      connectionTimeout: 30,
      keepAliveInterval: 60,
      defaultProtocol: 'SSH',
      newSession: 'Ctrl+N',
      closeSession: 'Ctrl+W',
      nextTab: 'Ctrl+Tab',
      previousTab: 'Ctrl+Shift+Tab',
    });
    // Backend persisted the INTEGER 0 for the disabled toggle.
    expect(DB.app_settings[0]?.command_suggestions).toBe(0);
    // Simulate app restart and verify the toggle is still off.
    resetPreferenceCaches();
    await hydrate();
    const settings = prefGet<Record<string, unknown>>('sshClientSettings', {});
    expect(settings.commandSuggestions).toBe(false);
  });

  it('suggestion tuning columns round-trip through sshClientSettings', async () => {
    const { prefGet, prefSet, resetPreferenceCaches } = await import('../preferences');
    await hydrate();
    prefSet('sshClientSettings', {
      theme: 'dark',
      autoReconnect: true,
      logLevel: 'info',
      maxLogSize: 100,
      savePasswords: false,
      autoLockTimeout: 30,
      hostKeyVerification: true,
      enableNotifications: true,
      showConnectionManager: true,
      showSystemMonitor: true,
      showStatusBar: true,
      commandSuggestions: true,
      suggestionDebounceMs: 200,
      suggestionTuiGateEnabled: false,
      connectionTimeout: 30,
      keepAliveInterval: 60,
      defaultProtocol: 'SSH',
      newSession: 'Ctrl+N',
      closeSession: 'Ctrl+W',
      nextTab: 'Ctrl+Tab',
      previousTab: 'Ctrl+Shift+Tab',
    });
    // Backend persisted INTEGER 200 (debounce) and INTEGER 0 (gate disabled).
    expect(DB.app_settings[0]?.suggestion_debounce_ms).toBe(200);
    expect(DB.app_settings[0]?.suggestion_tui_gate_enabled).toBe(0);
    // Simulate app restart and verify values survive.
    resetPreferenceCaches();
    await hydrate();
    const settings = prefGet<Record<string, unknown>>('sshClientSettings', {});
    expect(settings.suggestionDebounceMs).toBe(200);
    expect(settings.suggestionTuiGateEnabled).toBe(false);
  });

  it('other INTEGER boolean settings convert correctly', async () => {
    DB.app_settings = [
      {
        id: 1,
        auto_reconnect: 0,
        save_passwords: 1,
        follow_terminal_directory: 0,
      },
    ];
    await hydrate();
    const { prefGet } = await import('../preferences');
    const s = prefGet<Record<string, unknown>>('sshClientSettings', {});
    expect(s.autoReconnect).toBe(false);
    expect(s.savePasswords).toBe(true);
    expect(prefGet<boolean>('nexterm-follow-terminal-directory', true)).toBe(false);
  });
});
