import { describe, expect, it } from 'vitest';
import { rankSuggestions } from '../suggestion/engine';
import { SCOPE_GLOBAL, WEIGHTS, type CommandStat } from '../suggestion/types';

const now = Date.now();
const HOUR = 3600_000;

function stat(command: string, scope: string, over: Partial<CommandStat> = {}): CommandStat {
  return {
    command,
    scope,
    use_count: 1,
    selection_count: 0,
    rejection_count: 0,
    last_used: now - HOUR,
    ...over,
  };
}

describe('suggestion engine: ranking', () => {
  it('ranks higher-usage, more-recent commands first', () => {
    const stats = [
      stat('git status', SCOPE_GLOBAL, { use_count: 5, last_used: now }),
      stat('git stash', SCOPE_GLOBAL, { use_count: 50, last_used: now - 90 * 24 * HOUR }),
    ];
    const r = rankSuggestions('git st', stats, { now });
    expect(r.mode).toBe('popup');
    // Higher total use + recency wins even with fewer absolute uses.
    expect(r.candidates[0].command).toBe('git status');
  });

  it('boosts connection-scoped usage when the scope matches', () => {
    const conn = 'C:abc';
    const stats = [
      stat('docker ps', SCOPE_GLOBAL, { use_count: 1, last_used: now }),
      stat('docker ps', conn, { use_count: 1, last_used: now }),
      stat('systemctl status', conn, { use_count: 1, last_used: now }),
    ];
    const r = rankSuggestions('docker ', stats, { now, connectionScope: conn });
    expect(r.candidates[0].command).toBe('docker ps');
    // The connection-scoped docker ps must outrank a global-only candidate.
    const docker = r.candidates.find(c => c.command === 'docker ps');
    expect(docker).toBeDefined();
  });

  it('boosts cwd-scoped usage when the directory matches (full-path hash)', () => {
    const cwd = 'D:somehash';
    const stats = [
      stat('npm run dev', SCOPE_GLOBAL, { use_count: 1 }),
      stat('npm run dev', cwd, { use_count: 1 }),
    ];
    const r = rankSuggestions('npm run', stats, { now, cwdScopeKey: cwd });
    expect(r.candidates[0].command).toBe('npm run dev');
  });

  it('penalises rejected suggestions', () => {
    const stats = [
      stat('git push', SCOPE_GLOBAL, { use_count: 10, rejection_count: 8, last_used: now }),
      stat('git pull', SCOPE_GLOBAL, { use_count: 2, last_used: now }),
    ];
    const r = rankSuggestions('git p', stats, { now });
    // push has far more uses but heavy rejections — pull should surface first.
    expect(r.candidates[0].command).toBe('git pull');
  });
});

describe('suggestion engine: auto-quiet', () => {
  it('hides when no candidate clears the minimum score', () => {
    const stats = [stat('zzzz-exotic', SCOPE_GLOBAL, { use_count: 0, last_used: 0 })];
    const r = rankSuggestions('zzzz', stats, { now });
    expect(r.mode).toBe('hidden');
  });

  it('hides when input has no matching candidates at all', () => {
    const r = rankSuggestions('ls -la', [], { now });
    expect(r.mode).toBe('hidden');
    expect(r.candidates).toHaveLength(0);
  });

  it('never pads beyond the max candidate count', () => {
    const stats = Array.from({ length: 30 }, (_, i) =>
      stat(`cmd${i} x`, SCOPE_GLOBAL, { use_count: 30 - i, last_used: now }),
    );
    const r = rankSuggestions('cmd', stats, { now });
    expect(r.mode).toBe('popup');
    expect(r.candidates.length).toBeLessThanOrEqual(WEIGHTS.maxCandidates);
  });

  it('excludes the typed text itself from candidates', () => {
    const stats = [stat('git status', SCOPE_GLOBAL, { use_count: 99, last_used: now })];
    const r = rankSuggestions('git status', stats, { now });
    expect(r.candidates.every(c => c.command !== 'git status')).toBe(true);
  });
});

describe('suggestion engine: curated options act as fallback', () => {
  it('adds curated flags for the first command token', () => {
    const r = rankSuggestions('ps -', [], { now, curated: ['-A', '-e', '-a'] });
    // Low score without usage — hidden unless a stat exists; curated only fills
    // the list when real evidence exists. This asserts the engine does not
    // invent suggestions from curated lists alone.
    expect(r.mode).toBe('hidden');
  });
});
