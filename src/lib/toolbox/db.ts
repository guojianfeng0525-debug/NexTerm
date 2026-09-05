/**
 * SQLite-backed storage layer with normalized per-module tables.
 *
 * Every application domain owns a dedicated table with typed columns — one
 * row per entity, no JSON-blob fields (except a few encrypted payload
 * columns). Sensitive fields are encrypted individually with the
 * app-password-derived AES-GCM key (`encField`/`decField`) before they are
 * written, so password columns only ever hold ciphertext; the rest of the row
 * stays plaintext and readable.
 */
import { invoke } from '@tauri-apps/api/core';
import { getAppLockKey } from './app-lock';
import { encryptPayload, decryptPayload } from './vault-crypto';

/** Backend module tables. Keep in sync with `src-tauri/src/db.rs::TABLES`. */
export type DbTable =
  | 'connections'
  | 'folders'
  | 'active_connections'
  | 'profiles'
  | 'vault_records'
  | 'app_lock'
  | 'command_usage'
  | 'command_history'
  | 'command_stats'
  | 'toolbox_apps'
  | 'tunnels'
  | 'services'
  | 'service_orchestrations'
  | 'notes'
  | 'api_collections'
  | 'api_environments'
  | 'api_request_history'
  | 'postgres_connections'
  | 'database_sqlite_connections'
  | 'database_mysql_connections'
  | 'app_settings'
  | 'layout_config'
  | 'terminal_appearance'
  | 'editor_config'
  | 'workspace_meta'
  | 'workspace_groups'
  | 'workspace_tabs'
  | 'workspace_grid_nodes'
  | 'documents'
  | 'jar_preferences'
  | 'jar_recent_files'
  | 'jar_find_history'
  /* ── network topology & diagnostics (see docs/network-topology-design.md §3) ── */
  | 'net_nodes'
  | 'net_interfaces'
  | 'net_routes'
  | 'net_firewalls'
  | 'net_firewall_rules'
  | 'net_ports'
  | 'net_port_probes'
  | 'net_links'
  | 'net_port_links';

export type Row = Record<string, unknown>;

export interface WorkspaceReplaceRequest {
  readonly meta: Row;
  readonly groups: readonly Row[];
  readonly tabs: readonly Row[];
  readonly gridNodes: readonly Row[];
}

/* ── row access on normalized tables ─────────────────────────────────────── */

/** Upsert one row (must include the primary key column with a non-empty value). */
export async function rowUpsert(table: DbTable, row: Row): Promise<boolean> {
  try {
    await invoke('row_upsert', { table, row });
    return true;
  } catch (err) {
    // Surface backend persistence failures instead of silently swallowing
    // them — a "successful" save that never reaches SQLite loses data on
    // the next launch.
    const pk = typeof row.id === 'string' || typeof row.id === 'number'
      ? String(row.id)
      : typeof row.key === 'string' || typeof row.key === 'number'
        ? String(row.key)
        : '(unknown)';
    console.error(`[db] row_upsert failed for ${table} (pk=${pk}):`, err);
    return false;
  }
}

export async function rowGet(table: DbTable, key: string): Promise<Row | null> {
  try {
    return await invoke<Row | null>('row_get', { table, key });
  } catch {
    return null;
  }
}

export async function rowList(table: DbTable): Promise<Row[]> {
  try {
    return await invoke<Row[]>('row_list', { table });
  } catch {
    return [];
  }
}

export async function rowDelete(table: DbTable, key: string): Promise<void> {
  try {
    await invoke('row_delete', { table, key });
  } catch {
    /* ignore */
  }
}

/** Delete every row in a table (used for full-state rewrites). */
export async function rowClear(table: DbTable): Promise<void> {
  try {
    await invoke('row_clear', { table });
  } catch {
    /* ignore */
  }
}

/** Atomically replace all normalized terminal-workspace rows. */
export function workspaceReplace(request: WorkspaceReplaceRequest): Promise<void> {
  return invoke('workspace_replace', { request });
}

/** Retain the newest learned command-stat rows. */
export async function pruneCommandStats(limit: number): Promise<void> {
  try {
    await invoke('prune_command_stats', { limit });
  } catch {
    /* non-critical cache maintenance */
  }
}

/** Drop legacy key-value tables after their data was migrated. */
export async function dropLegacyTables(): Promise<void> {
  try {
    await invoke('drop_legacy_tables');
  } catch {
    /* ignore */
  }
}

/** Read a value from a legacy key-value table (one-time migration only). */
export async function legacyDbGet(
  table: 'connections_legacy' | 'profiles_legacy' | 'app_lock_legacy' | 'command_history_legacy' | 'preferences_legacy' | 'workspace_legacy' | 'vault' | 'toolbox' | 'api_debug',
  key: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>('legacy_db_get', { table, key });
  } catch {
    return null;
  }
}

/* ── per-field encryption (AES-GCM with the app-password key) ────────────── */

/** Encrypt a sensitive field. Empty input → null (stored as SQL NULL). */
export async function encField(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const k = getAppLockKey();
  if (!k) return null;
  try {
    return await encryptPayload(k, value);
  } catch {
    return null;
  }
}

/** Decrypt a sensitive field. Null/missing/failed → undefined. */
export async function decField(cipher: string | null | undefined): Promise<string | undefined> {
  if (!cipher) return undefined;
  const k = getAppLockKey();
  if (!k) return undefined;
  try {
    return await decryptPayload(k, cipher);
  } catch {
    return undefined;
  }
}
