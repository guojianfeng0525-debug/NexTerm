/**
 * Learning store for the adaptive command suggestion system.
 *
 * Persisted in SQLite `command_stats` (command encrypted per-field with the
 * app-password key; scope stored as a stable hash so per-connection / per-cwd
 * weighting works without storing sensitive paths). Reads are synchronous
 * from an in-memory cache so the hot suggestion path never blocks on IO;
 * writes are asynchronous and fire-and-forget — a failing SQLite write only
 * logs and degrades, it never affects the terminal.
 */
import { rowList, rowUpsert, encField, decField } from '../toolbox/db';
import { isSensitiveCommand } from './sensitive';
import { SCOPE_GLOBAL, STORE_CAP, type CommandStat } from './types';

/** Stable, non-cryptographic hash (djb2) for building compact scope keys. */
export function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Scope key for a connection: `C:<hash>` (hash of the connection id). */
export function connectionScope(connectionId: string): string {
  return `C:${stableHash(connectionId)}`;
}

/** Scope key for a directory: `D:<hash>` (hash of the FULL normalized path). */
export function cwdScope(fullPath: string | undefined): string | null {
  if (!fullPath || !fullPath.trim()) return null;
  const normalized = fullPath.trim().replace(/\\/g, '/');
  return `D:${stableHash(normalized)}`;
}

// ── in-memory cache: scope -> (command -> stat) ─────────────────────────────
let cache = new Map<string, Map<string, CommandStat>>();
let hydrated = false;

export function isSuggestionStoreHydrated(): boolean {
  return hydrated;
}

/** Synchronous lookup of every stat row for the given scopes (engine path). */
export function getStatsForScopes(scopes: string[]): CommandStat[] {
  const out: CommandStat[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const bucket = cache.get(scope);
    if (!bucket) continue;
    for (const stat of bucket.values()) {
      const k = `${stat.command}\u0000${stat.scope}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(stat);
    }
  }
  return out;
}

function getBucket(scope: string): Map<string, CommandStat> {
  let bucket = cache.get(scope);
  if (!bucket) {
    bucket = new Map();
    cache.set(scope, bucket);
  }
  return bucket;
}

/** Record a command execution (called once when the command is submitted). */
export function recordUse(command: string, connScope: string, cwdScopeKey: string | null): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  if (isSensitiveCommand(trimmed)) return;

  const scopes = [SCOPE_GLOBAL, connScope];
  if (cwdScopeKey) scopes.push(cwdScopeKey);

  const now = Date.now();
  for (const scope of scopes) {
    const bucket = getBucket(scope);
    const stat = bucket.get(trimmed);
    if (stat) {
      stat.use_count += 1;
      stat.last_used = now;
    } else {
      bucket.set(trimmed, {
        command: trimmed,
        scope,
        use_count: 1,
        selection_count: 0,
        rejection_count: 0,
        last_used: now,
      });
    }
  }
  // Prune rarely to keep memory bounded.
  if (cache.size > STORE_CAP) pruneCache();
  void persistScopes(scopes, trimmed);
}

/** User accepted this suggestion — positive feedback. */
export function recordSelection(command: string, scope: string): void {
  const bucket = getBucket(scope);
  const stat = bucket.get(command);
  if (stat) {
    stat.selection_count += 1;
    stat.last_used = Date.now();
    void persistScopes([scope], command);
  }
}

/**
 * Negative feedback: the suggestion was surfaced but the user did not take it
 * (they typed something else / pressed Esc). Only the specific candidate is
 * penalised — never the whole candidate list.
 */
export function recordRejection(command: string, scope: string): void {
  const bucket = getBucket(scope);
  const stat = bucket.get(command);
  if (stat) {
    stat.rejection_count += 1;
    void persistScopes([scope], command);
  }
}

/** Look up one stat (used by the UI to apply feedback after acceptance). */
export function getStat(command: string, scope: string): CommandStat | undefined {
  return cache.get(scope)?.get(command);
}

// ── hydration / migration ──────────────────────────────────────────────────


async function persistScopes(scopes: string[], command: string): Promise<void> {
  for (const scope of scopes) {
    const stat = cache.get(scope)?.get(command);
    if (!stat) continue;
    const cipher = await encField(command);
    if (!cipher) continue;
    try {
      await rowUpsert('command_stats', {
        command: cipher,
        scope,
        use_count: stat.use_count,
        selection_count: stat.selection_count,
        rejection_count: stat.rejection_count,
        last_used: stat.last_used,
      });
    } catch {
      /* non-critical: suggestion learning degrades, terminal unaffected */
    }
  }
}

/**
 * Hydrate the store from SQLite. When the store is empty but legacy
 * usage/history exists, migrate it as initial global frequency data.
 */
export async function hydrateSuggestionStore(
  legacyUsage: Record<string, number>,
  legacyHistory: { c: string; n: number; t: number }[],
): Promise<void> {
  try {
    const rows = await rowList('command_stats');
    cache = new Map();
    if (rows.length > 0) {
      for (const row of rows) {
        const scope = typeof row.scope === 'string' ? row.scope : '';
        const cmd = await decField(row.command as string);
        if (cmd === undefined || !scope) continue;
        const bucket = getBucket(scope);
        bucket.set(cmd, {
          command: cmd,
          scope,
          use_count: (row.use_count as number) ?? 0,
          selection_count: (row.selection_count as number) ?? 0,
          rejection_count: (row.rejection_count as number) ?? 0,
          last_used: (row.last_used as number) ?? 0,
        });
      }
      hydrated = true;
      return;
    }

    // First run: migrate legacy usage/history as global initial frequency.
    const migrated = new Map<string, CommandStat>();
    const now = Date.now();
    for (const [cmd, count] of Object.entries(legacyUsage)) {
      if (isSensitiveCommand(cmd)) continue;
      migrated.set(cmd, {
        command: cmd,
        scope: SCOPE_GLOBAL,
        use_count: count,
        selection_count: 0,
        rejection_count: 0,
        last_used: now,
      });
    }
    for (const h of legacyHistory) {
      if (isSensitiveCommand(h.c)) continue;
      const existing = migrated.get(h.c);
      if (existing) {
        existing.use_count = Math.max(existing.use_count, h.n);
        existing.last_used = Math.max(existing.last_used, h.t);
      } else {
        migrated.set(h.c, {
          command: h.c,
          scope: SCOPE_GLOBAL,
          use_count: h.n,
          selection_count: 0,
          rejection_count: 0,
          last_used: h.t,
        });
      }
    }
    const globalBucket = new Map<string, CommandStat>();
    for (const stat of migrated.values()) globalBucket.set(stat.command, stat);
    cache = new Map([[SCOPE_GLOBAL, globalBucket]]);
    if (migrated.size > 0) {
      for (const stat of globalBucket.values()) {
        const cipher = await encField(stat.command);
        if (!cipher) continue;
        try {
          await rowUpsert('command_stats', {
            command: cipher,
            scope: stat.scope,
            use_count: stat.use_count,
            selection_count: 0,
            rejection_count: 0,
            last_used: stat.last_used,
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    cache = new Map();
  }
  hydrated = true;
}

function pruneCache(): void {
  // Drop least-recently-used global entries first (cheap bounded memory).
  const buckets = [...cache.values()];
  let total = 0;
  for (const b of buckets) total += b.size;
  if (total <= STORE_CAP) return;
  const all: { scope: string; command: string; last: number }[] = [];
  for (const [scope, bucket] of cache) {
    for (const [command, stat] of bucket) all.push({ scope, command, last: stat.last_used });
  }
  all.sort((a, b) => a.last - b.last);
  const excess = total - STORE_CAP;
  for (const item of all.slice(0, excess)) {
    cache.get(item.scope)?.delete(item.command);
  }
}

/** Reset for tests. */
export function resetSuggestionStoreForTest(): void {
  cache = new Map();
  hydrated = false;
}
