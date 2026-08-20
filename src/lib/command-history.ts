/**
 * Command usage + full-command history backing the terminal suggestion engine.
 *
 * Persisted in normalized tables (`command_usage`, `command_history`) with
 * the command text encrypted per-field (AES-GCM via the app-password key) —
 * terminal commands may contain passwords. Because AES-GCM uses a random IV
 * per encryption, the module keeps a plaintext → ciphertext map so removed
 * rows can still be located. Reads/writes stay synchronous for the hot
 * suggestion path: the module keeps an in-memory cache hydrated after unlock.
 */
import { rowList, rowUpsert, rowDelete, encField, decField } from './toolbox/db';

export interface CommandHistoryEntry {
  c: string; // full command line
  n: number; // times executed
  t: number; // last executed timestamp
}

let usage: Record<string, number> | null = null;
let history: CommandHistoryEntry[] | null = null;
let hydrated = false;

// plaintext command -> stored ciphertext (for locating rows to delete)
let usageEnc = new Map<string, string>();
let historyEnc = new Map<string, string>();

// Serialises async persistence: concurrent recordExecutedCommand calls must
// not both encrypt the same command (AES-GCM random IV → duplicate rows).
let persistChain: Promise<void> = Promise.resolve();

export function isCommandHistoryHydrated(): boolean {
  return hydrated;
}

/** Load usage/history from SQLite into the in-memory cache. */
export async function hydrateCommandHistory(): Promise<void> {
  try {
    const [uRows, hRows] = await Promise.all([rowList('command_usage'), rowList('command_history')]);
    const nextUsage: Record<string, number> = {};
    const nextHistory: CommandHistoryEntry[] = [];
    usageEnc = new Map();
    historyEnc = new Map();
    for (const row of uRows) {
      const cmd = await decField(row.command as string);
      if (cmd !== undefined) {
        nextUsage[cmd] = (row.count as number) ?? 0;
        usageEnc.set(cmd, String(row.command));
      }
    }
    for (const row of hRows) {
      const cmd = await decField(row.command as string);
      if (cmd !== undefined) {
        nextHistory.push({ c: cmd, n: (row.count as number) ?? 0, t: (row.last_used as number) ?? 0 });
        historyEnc.set(cmd, String(row.command));
      }
    }
    usage = nextUsage;
    history = nextHistory;
  } catch {
    usage = {};
    history = [];
  }
  hydrated = true;
}

async function rewriteUsage(): Promise<void> {
  if (!usage) return;
  for (const cipher of usageEnc.values()) await rowDelete('command_usage', cipher);
  usageEnc = new Map();
  for (const [cmd, count] of Object.entries(usage)) {
    const cipher = await encField(cmd);
    if (cipher) {
      await rowUpsert('command_usage', { command: cipher, count });
      usageEnc.set(cmd, cipher);
    }
  }
}

async function rewriteHistory(): Promise<void> {
  if (!history) return;
  for (const cipher of historyEnc.values()) await rowDelete('command_history', cipher);
  historyEnc = new Map();
  for (const h of history) {
    const cipher = await encField(h.c);
    if (cipher) {
      await rowUpsert('command_history', { command: cipher, count: h.n, last_used: h.t });
      historyEnc.set(h.c, cipher);
    }
  }
}

/** Synchronous read (most-used first for usage; most-recent first for history). */
export function getCommandUsage(): Record<string, number> {
  return usage ?? {};
}

export function getCommandHistory(): CommandHistoryEntry[] {
  return history ?? [];
}

/** Replace usage/history in memory and persist to SQLite when hydrated. */
export function setCommandData(
  nextUsage: Record<string, number>,
  nextHistory: CommandHistoryEntry[],
): void {
  usage = nextUsage;
  history = nextHistory;
  if (hydrated) {
    void rewriteUsage();
    void rewriteHistory();
  }
}

/**
 * Record one executed command into usage + history and persist it
 * incrementally. Called by the terminal on every submitted command; the
 * suggestion engine keeps its own `command_stats` table separately.
 */
export function recordExecutedCommand(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  const now = Date.now();

  usage = usage ?? {};
  usage[trimmed] = (usage[trimmed] ?? 0) + 1;

  history = history ?? [];
  const existing = history.find((h) => h.c === trimmed);
  if (existing) {
    existing.n += 1;
    existing.t = now;
  } else {
    history.push({ c: trimmed, n: 1, t: now });
  }

  if (!hydrated) return;
  const count = usage[trimmed];
  const entry = existing ?? history[history.length - 1];
  // Notify the history view synchronously — the async SQLite write below must
  // not gate UI refresh (it can lag or fail while memory is already updated).
  try {
    window.dispatchEvent(new Event('nexterm:command-history-changed'));
  } catch {
    /* ignore */
  }
  persistChain = persistChain.then(async () => {
    // Reuse the stored ciphertext for this command (AES-GCM uses a random IV,
    // so a fresh encryption would create a duplicate row).
    let usageCipher = usageEnc.get(trimmed);
    if (!usageCipher) {
      const fresh = await encField(trimmed);
      if (!fresh) return;
      usageCipher = fresh;
      usageEnc.set(trimmed, fresh);
    }
    await rowUpsert('command_usage', { command: usageCipher, count });

    let historyCipher = historyEnc.get(trimmed);
    if (!historyCipher) {
      const fresh = await encField(trimmed);
      if (!fresh) return;
      historyCipher = fresh;
      historyEnc.set(trimmed, fresh);
    }
    await rowUpsert('command_history', { command: historyCipher, count: entry?.n ?? 1, last_used: now });
  });
}
