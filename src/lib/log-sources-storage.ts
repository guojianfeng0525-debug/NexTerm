/**
 * Storage for user-authored log source commands (log monitor).
 *
 * A custom source is a FULL shell command (`tail -f /srv/order/logs/stdout.log`,
 * `journalctl -u order -f --no-pager`) saved per saved-connection id — each
 * server keeps its own list. Rows live in the `log_custom_sources` SQLite
 * table through the generic row_* channel (table + columns registered in
 * `src-tauri/src/db.rs`; the registration of `row_upsert` & co. in
 * `generate_handler!` is asserted by `command_registration_tests` — the
 * workspace_replace lesson).
 *
 * No credential may ever be stored here: the command runs on the server as
 * the connection's login user, exactly as if typed into the terminal.
 */
import { rowDelete, rowList, rowUpsert, type Row } from './toolbox/db';
import { generateId } from './toolbox/toolbox-storage';

export interface CustomLogSource {
  readonly id: string;
  /** Saved-connection id this command belongs to (per-server isolation). */
  readonly connectionId: string;
  name: string;
  command: string;
  sortOrder: number;
  readonly createdAt: number;
  updatedAt: number;
}

/** Strict field coercion — an unexpected shape degrades to ''/0 instead of
 * stringifying objects (`[object Object]`), which would corrupt ids. */
function strField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rowToSource(row: Row): CustomLogSource {
  return {
    id: strField(row.id),
    connectionId: strField(row.connection_id),
    name: strField(row.name),
    command: strField(row.command),
    sortOrder: numField(row.sort_order),
    createdAt: numField(row.created_at),
    updatedAt: numField(row.updated_at),
  };
}

function sourceToRow(source: CustomLogSource): Row {
  return {
    id: source.id,
    connection_id: source.connectionId,
    name: source.name,
    command: source.command,
    sort_order: source.sortOrder,
    created_at: source.createdAt,
    updated_at: source.updatedAt,
  };
}

/** All custom sources (all connections). */
export async function listCustomLogSources(): Promise<CustomLogSource[]> {
  const rows = await rowList('log_custom_sources');
  return rows
    .map(rowToSource)
    .filter((source) => source.id !== '')
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId) || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}

/** Custom sources saved for one connection, in display order. */
export async function listCustomLogSourcesForConnection(connectionId: string): Promise<CustomLogSource[]> {
  const all = await listCustomLogSources();
  return all.filter((source) => source.connectionId === connectionId);
}

export async function upsertCustomLogSource(source: CustomLogSource): Promise<void> {
  if (!source.id || !source.connectionId || !source.name.trim() || !source.command.trim()) {
    throw new Error('invalid custom log source');
  }
  await rowUpsert('log_custom_sources', sourceToRow(source));
}

export interface NewCustomLogSourceInput {
  connectionId: string;
  name: string;
  command: string;
}

/** Create a source appended after the connection's current last entry. */
export async function createCustomLogSource(input: NewCustomLogSourceInput): Promise<CustomLogSource> {
  const existing = await listCustomLogSourcesForConnection(input.connectionId);
  const now = Date.now();
  const source: CustomLogSource = {
    id: generateId('logsrc'),
    connectionId: input.connectionId,
    name: input.name.trim(),
    command: input.command.trim(),
    sortOrder: (existing.at(-1)?.sortOrder ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
  };
  await upsertCustomLogSource(source);
  return source;
}

export async function removeCustomLogSource(id: string): Promise<void> {
  await rowDelete('log_custom_sources', id);
}

/** Move a source one slot up/down within its connection's list. */
export async function moveCustomLogSource(id: string, direction: 'up' | 'down'): Promise<void> {
  const all = await listCustomLogSources();
  const target = all.find((source) => source.id === id);
  if (!target) return;
  const siblings = all.filter((source) => source.connectionId === target.connectionId);
  const index = siblings.findIndex((source) => source.id === id);
  const swapWith = direction === 'up' ? siblings[index - 1] : siblings[index + 1];
  if (!swapWith) return;
  const now = Date.now();
  await rowUpsert('log_custom_sources', sourceToRow({ ...target, sortOrder: swapWith.sortOrder, updatedAt: now }));
  await rowUpsert('log_custom_sources', sourceToRow({ ...swapWith, sortOrder: target.sortOrder, updatedAt: now }));
}
