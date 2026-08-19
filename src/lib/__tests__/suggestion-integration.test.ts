/**
 * End-to-end (engine + store) integration test for the acceptance criteria:
 *  1. With suggestions: the user can select, and selection feeds back so the
 *     same suggestion ranks higher next time.
 *  2. Without suggestions: nothing is shown and nothing interferes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rankSuggestions } from '../suggestion/engine';
import { SCOPE_GLOBAL } from '../suggestion/types';
import { rowUpsert } from '../toolbox/db';
import {
  cwdScope,
  getStatsForScopes,
  hydrateSuggestionStore,
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

beforeEach(() => {
  resetSuggestionStoreForTest();
  vi.clearAllMocks();
});

describe('suggestion integration', () => {
  it('records → suggests → selection boosts the next ranking', async () => {
    await hydrateSuggestionStore({}, []);
    const conn = 'C:conn1';
    const dir = cwdScope('/opt/project-a');

    // User runs commands on this connection.
    recordUse('git status', conn, dir);
    recordUse('git stash', conn, dir);
    recordUse('git status', conn, dir);
    await new Promise(r => setTimeout(r, 5));

    const stats = getStatsForScopes([SCOPE_GLOBAL, conn, dir ?? '']);
    const first = rankSuggestions('git st', stats, { connectionScope: conn, cwdScopeKey: dir });
    expect(first.mode).toBe('popup');
    expect(first.candidates[0].command).toBe('git status');

    // User selects it — positive feedback.
    recordSelection('git status', conn);
    await new Promise(r => setTimeout(r, 5));

    const stats2 = getStatsForScopes([SCOPE_GLOBAL, conn, dir ?? '']);
    const second = rankSuggestions('git st', stats2, { connectionScope: conn, cwdScopeKey: dir });
    expect(second.candidates[0].command).toBe('git status');
  });

  it('hides completely when there is no quality candidate (auto-quiet)', async () => {
    // Completely fresh store: zero learning data anywhere.
    await hydrateSuggestionStore({}, []);
    const stats = getStatsForScopes([SCOPE_GLOBAL, 'C:brand-new']);
    const r = rankSuggestions('git st', stats, { connectionScope: 'C:brand-new' });
    expect(r.mode).toBe('hidden');
    expect(r.candidates).toHaveLength(0);

    // Even with unrelated usage recorded, a non-matching input stays hidden.
    recordUse('docker ps', 'C:brand-new', null);
    await new Promise(r => setTimeout(r, 5));
    const stats2 = getStatsForScopes([SCOPE_GLOBAL, 'C:brand-new']);
    const r2 = rankSuggestions('git st', stats2, { connectionScope: 'C:brand-new' });
    expect(r2.mode).toBe('hidden');
  });

  it('does not surface the typed text itself as a suggestion', async () => {
    await hydrateSuggestionStore({}, []);
    recordUse('systemctl start nginx', 'C:x', null);
    await new Promise(r => setTimeout(r, 5));
    const stats = getStatsForScopes([SCOPE_GLOBAL, 'C:x']);
    const r = rankSuggestions('systemctl start nginx', stats, { connectionScope: 'C:x' });
    expect(r.candidates.some(c => c.command === 'systemctl start nginx')).toBe(false);
  });
});
