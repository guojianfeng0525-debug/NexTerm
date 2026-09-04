/**
 * Shared in-memory Tauri IPC mock for tests.
 *
 * Stands in for the SQLite backend: `row_upsert` / `row_get` / `row_list` /
 * `row_delete` / `row_clear` / `legacy_db_get` operate on a plain object
 * keyed by table name. Primary keys are resolved per table so upsert
 * semantics (same key → replace) match the backend.
 *
 * Usage:
 *   const ipc = createTestIpc();
 *   vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => ipc.invokeMock(...a) }));
 *   // seed: ipc.DB.connections = [...];  or use row helpers.
 */
import { vi } from 'vitest';

export interface TestIpc {
  DB: Record<string, Record<string, unknown>[]>;
  invokeMock: (...args: unknown[]) => unknown;
}

/** Primary-key column per table (mirrors src-tauri pk_column + composite keys). */
function pkOf(table: string): string | string[] {
  switch (table) {
    case 'command_stats':
      return ['command', 'scope'];
    case 'command_usage':
    case 'command_history':
      return 'command';
    case 'workspace_tabs':
      return 'tab_id';
    case 'workspace_grid_nodes':
      return 'node_id';
    case 'workspace_groups':
      return 'group_id';
    default:
      return 'id';
  }
}

function pkValue(row: Record<string, unknown>, pk: string | string[]): string {
  if (Array.isArray(pk)) {
    return pk.map(k => String(row[k] ?? '')).join('\u0000');
  }
  return String(row[pk] ?? '');
}

export function createTestIpc(): TestIpc {
  const DB: Record<string, Record<string, unknown>[]> = {};
  const invokeMock = vi.fn(
    (
      cmd: string,
      args?: {
        table?: string;
        row?: Record<string, unknown>;
        key?: string | number;
        id?: string | number;
        request?: {
          meta?: Record<string, unknown>;
          groups?: Record<string, unknown>[];
          tabs?: Record<string, unknown>[];
          gridNodes?: Record<string, unknown>[];
        };
      },
    ) => {
      const table = args?.table ?? '';
      switch (cmd) {
        case 'row_upsert': {
          const row = { ...(args?.row ?? {}) };
          const rows = DB[table] ?? (DB[table] = []);
          const pk = pkOf(table);
          const key = pkValue(row, pk);
          const idx = rows.findIndex(r => pkValue(r, pk) === key);
          if (idx === -1) rows.push(row);
          else rows[idx] = row;
          return Promise.resolve();
        }
        case 'row_get': {
          const rows = DB[table] ?? [];
          const key = String(args?.key ?? '');
          const row = rows.find(r => pkValue(r, pkOf(table)) === key);
          return Promise.resolve(row ?? null);
        }
        case 'row_list': {
          return Promise.resolve([...(DB[table] ?? [])]);
        }
        case 'row_delete': {
          const key = String(args?.key ?? '');
          if (DB[table]) DB[table] = DB[table].filter(r => pkValue(r, pkOf(table)) !== key);
          return Promise.resolve();
        }
        case 'row_clear': {
          DB[table] = [];
          return Promise.resolve();
        }
        case 'workspace_replace': {
          const request = args?.request ?? {};
          DB.workspace_meta = request.meta ? [{ ...request.meta }] : [];
          DB.workspace_groups = [...(request.groups ?? [])];
          DB.workspace_tabs = [...(request.tabs ?? [])];
          DB.workspace_grid_nodes = [...(request.gridNodes ?? [])];
          return Promise.resolve();
        }
        case 'legacy_db_get': {
          // Legacy tables are keyed `key`/`value` rows; stored as {key, value}.
          const rows = DB[table] ?? [];
          const row = rows.find(r => String(r.key) === String(args?.key));
          return Promise.resolve(row ? String(row.value) : null);
        }
        case 'drop_legacy_tables': {
          for (const t of Object.keys(DB)) {
            if (t.endsWith('_legacy') || t === 'vault' || t === 'toolbox' || t === 'api_debug') delete DB[t];
          }
          return Promise.resolve();
        }
        default:
          return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
      }
    },
  );
  return { DB, invokeMock: invokeMock as unknown as (...args: unknown[]) => unknown };
}

/** Apply a seed row (upsert semantics) without going through the mock. */
export function seedRow(ipc: TestIpc, table: string, row: Record<string, unknown>): void {
  const rows = ipc.DB[table] ?? (ipc.DB[table] = []);
  const pk = pkOf(table);
  const key = pkValue(row, pk);
  const idx = rows.findIndex(r => pkValue(r, pk) === key);
  if (idx === -1) rows.push({ ...row });
  else rows[idx] = { ...row };
}
