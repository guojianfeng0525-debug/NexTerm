import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPE_GLOBAL } from '../suggestion/types';
import { rowUpsert } from '../toolbox/db';
import {
  cwdScope,
  hydrateSuggestionStore,
  recordRejection,
  recordSelection,
  recordUse,
  resetSuggestionStoreForTest,
} from '../suggestion/store';

vi.mock('../toolbox/db', () => ({
  rowList: vi.fn(async () => []),
  rowUpsert: vi.fn(async () => true),
  encField: vi.fn(async (v: string) => `enc:${v}`),
  decField: vi.fn(async (v: string) => (v?.startsWith('enc:') ? v.slice(4) : undefined)),
}));

const upsertCalls = () => vi.mocked(rowUpsert).mock.calls;
const persistedRows = () =>
  upsertCalls().map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  resetSuggestionStoreForTest();
  vi.clearAllMocks();
});

describe('suggestion store: learning', () => {
  it('records use in global + connection + cwd scopes', async () => {
    await hydrateSuggestionStore({}, []);
    recordUse('git status', 'C:conn1', cwdScope('/opt/a'));
    recordUse('git status', 'C:conn1', cwdScope('/opt/a'));

    // Both calls must persist (async) — allow microtasks to flush.
    await vi.waitFor(() => {
      expect(upsertCalls().length).toBeGreaterThanOrEqual(3);
    });
  });

  it('skips sensitive commands entirely', async () => {
    await hydrateSuggestionStore({}, []);
    recordUse('mysql -u root -p secret', 'C:x', cwdScope('/tmp'));
    await new Promise(r => setTimeout(r, 5));
    // The sensitive command must produce zero persistence calls.
    expect(upsertCalls().length).toBe(0);
    recordUse('git status', 'C:x', cwdScope('/tmp'));
    await new Promise(r => setTimeout(r, 5));
    // Safe command persists for each scope (G + C + D).
    expect(upsertCalls().length).toBe(3);
  });

  it('selection and rejection adjust feedback counters', async () => {
    await hydrateSuggestionStore({}, []);
    recordUse('docker ps', 'C:x', null);
    recordSelection('docker ps', 'C:x');
    recordSelection('docker ps', 'C:x');
    recordRejection('docker ps', 'C:x');

    // No synchronous getter for direct counter checks without exposing cache —
    // verify persisted rows carry the counters.
    await new Promise(r => setTimeout(r, 5));
    const rows = persistedRows();
    const row = rows.find(r => r.scope === 'C:x');
    expect(row).toBeDefined();
    expect(row?.selection_count).toBe(2);
    expect(row?.rejection_count).toBe(1);
  });
});

describe('suggestion store: migration', () => {
  it('migrates legacy usage/history into global scope (sensitive-filtered)', async () => {
    await hydrateSuggestionStore(
      { 'git status': 10, 'curl -H Authorization: Bearer x': 5 },
      [{ c: 'docker ps', n: 3, t: 123 }, { c: 'export SECRET=1', n: 2, t: 456 }],
    );
    const rows = persistedRows();
    // Persisted commands are encrypted — strip the mock prefix for asserts.
    const cmds = rows.map(r => String(r.command).replace(/^enc:/, ''));
    expect(cmds).toContain('git status');
    expect(cmds).toContain('docker ps');
    // Sensitive commands must not be migrated.
    expect(cmds.some(c => c.includes('Bearer'))).toBe(false);
    expect(cmds.some(c => c.includes('SECRET'))).toBe(false);
    expect(rows.every(r => r.scope === SCOPE_GLOBAL)).toBe(true);
  });
});
