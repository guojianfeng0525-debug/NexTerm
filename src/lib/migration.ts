/**
 * One-time migration from the legacy key-value table layout (each module
 * stored one encrypted JSON blob per key) into the normalized per-row tables.
 *
 * Runs once after unlock; a `preferences` flag prevents re-runs. Reads the
 * legacy tables via `legacy_db_get`, decrypts/parses the blobs, expands them
 * into rows, then drops the legacy tables.
 */
import {
  rowList,
  rowUpsert,
  legacyDbGet,
  dropLegacyTables,
  encField,
  decField,
  type DbTable,
} from './toolbox/db';
import { getAppLockKey } from './toolbox/app-lock';
import { decryptPayload } from './toolbox/vault-crypto';
import type { ConnectionData, ConnectionFolder, ActiveConnectionState } from './connection-storage';
import type { ConnectionProfile } from './connection-profiles';
import type { EncryptedRecord, NoteItem, ToolboxApp, TunnelConfig, ServiceConfig, VaultRecord } from './toolbox/toolbox-types';
import type { RequestConfig, ApiEnvironment } from './toolbox/api-debug-storage';

/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
type LegacyTable = Parameters<typeof legacyDbGet>[0];

/** Read + decrypt a legacy encrypted blob (null when absent). */
async function legacySecure(table: LegacyTable, key: string): Promise<string | null> {
  const k = getAppLockKey();
  if (!k) return null;
  const raw = await legacyDbGet(table, key);
  if (!raw) return null;
  try {
    return await decryptPayload(k, raw);
  } catch {
    return null;
  }
}

/** Read a legacy plaintext blob (app lock / vault meta were stored raw). */
async function legacyPlain(table: LegacyTable, key: string): Promise<string | null> {
  return legacyDbGet(table, key);
}

async function upsertRow(table: DbTable, row: Record<string, unknown>): Promise<void> {
  await rowUpsert(table, row);
}

export async function migrateLegacyStorage(): Promise<void> {
  // Legacy tables are encrypted with the app-password key; skip (loudly)
  // when the key is missing — same invariant as initializeAllStorage.
  if (!getAppLockKey()) {
    console.warn('[migration] Skipping legacy migration: app-password key unavailable');
    return;
  }
  try {
    const results = await Promise.all([
      migrateConnections(),
      migrateProfiles(),
      migrateAppLock(),
      migrateCommandHistory(),
      migrateVault(),
      migrateToolbox(),
      migrateApiDebug(),
    ]);

    // Only finalize when every module migrated successfully. If anything
    // failed (e.g. the app-password key changed and old blobs cannot be
    // decrypted), keep the legacy tables and retry on the next launch.
    if (results.some((ok) => !ok)) {
      console.warn('[migration] some legacy data could not be migrated, will retry next launch');
      return;
    }

    await dropLegacyTables();
    console.log('[migration] legacy key-value tables migrated to normalized schema');
  } catch (e) {
    console.warn('[migration] failed, will retry next launch:', e);
  }
}

/* ── connections / folders / active ───────────────────────────────────────── */

function connRow(c: ConnectionData): Record<string, unknown> {
  return {
    id: c.id, name: c.name, host: c.host, port: c.port, username: c.username,
    protocol: c.protocol, folder: c.folder ?? null, profile_id: c.profileId ?? null,
    created_at: c.createdAt, last_connected: c.lastConnected ?? null,
    favorite: c.favorite ? 1 : 0, color: c.color ?? null,
    tags: c.tags ? JSON.stringify(c.tags) : null, description: c.description ?? null,
    auth_method: c.authMethod ?? null, private_key_path: c.privateKeyPath ?? null,
    ftps_enabled: c.ftpsEnabled ? 1 : 0, proxy_type: c.proxyType ?? null,
    proxy_host: c.proxyHost ?? null, proxy_port: c.proxyPort ?? null,
    proxy_username: c.proxyUsername ?? null,
    keep_alive: c.keepAlive ? 1 : 0, keep_alive_interval: c.keepAliveInterval ?? null,
    server_alive_count_max: c.serverAliveCountMax ?? null, domain: c.domain ?? null,
    rdp_resolution: c.rdpResolution ?? null, vnc_color_depth: c.vncColorDepth ?? null,
    jump_host: c.jumpHost ?? null, jump_port: c.jumpPort ?? null,
    jump_username: c.jumpUsername ?? null, default_directory: c.defaultDirectory ?? null,
    sort_order: c.sortOrder ?? null,
  };
}

async function migrateConnections(): Promise<boolean> {
  try {
  const listRaw = await legacySecure('connections_legacy', 'list');
  if (listRaw) {
    const conns = JSON.parse(listRaw) as ConnectionData[];
    for (const c of conns) {
      const row = connRow(c);
      row.password = await encField(c.password);
      row.passphrase = await encField(c.passphrase);
      row.proxy_password = await encField(c.proxyPassword);
      row.jump_password = await encField(c.jumpPassword);
      row.jump_use_key = c.jumpUseKey ? 1 : 0;
      row.vnc_password = await encField(c.vncPassword);
      await upsertRow('connections', row);
    }
  }

  const foldersRaw = await legacySecure('connections_legacy', 'folders');
  if (foldersRaw) {
    const folders = JSON.parse(foldersRaw) as ConnectionFolder[];
    // `folders.path` has a UNIQUE constraint — keep existing rows, add new ones.
    const existingPaths = new Set((await rowList('folders')).map(r => str(r.path)));
    for (const f of folders) {
      if (existingPaths.has(f.path)) continue;
      existingPaths.add(f.path);
      await upsertRow('folders', {
        id: f.id, name: f.name, path: f.path,
        parent_path: f.parentPath ?? null, created_at: f.createdAt,
        sort_order: f.sortOrder ?? null,
      });
    }
  }

  const activeRaw = await legacySecure('connections_legacy', 'active');
  if (activeRaw) {
    const active = JSON.parse(activeRaw) as ActiveConnectionState[];
    for (const a of active) {
      await upsertRow('active_connections', {
        tab_id: a.tabId, connection_id: a.connectionId, order_num: a.order,
        original_connection_id: a.originalConnectionId ?? null,
        tab_type: a.tabType ?? null, protocol: a.protocol ?? null,
      });
    }
  }
  return true;
  } catch (e) {
    console.warn('[migration] connections failed:', e);
    return false;
  }
}

/* ── profiles ─────────────────────────────────────────────────────────────── */

async function migrateProfiles(): Promise<boolean> {
  try {
  const raw = await legacySecure('profiles_legacy', 'list');
  if (!raw) return true;
  const profiles = JSON.parse(raw) as ConnectionProfile[];
  for (const p of profiles) {
    await upsertRow('profiles', {
      id: p.id, name: p.name, host: p.host, port: p.port, username: p.username,
      auth_method: p.authMethod, password: await encField(p.password),
      private_key: p.privateKey ?? null, created_at: p.createdAt,
      updated_at: p.updatedAt, favorite: p.favorite ? 1 : 0,
      color: p.color ?? null, tags: p.tags ? JSON.stringify(p.tags) : null,
    });
  }
  return true;
  } catch (e) {
    console.warn('[migration] profiles failed:', e);
    return false;
  }
}

/* ── app lock ─────────────────────────────────────────────────────────────── */

async function migrateAppLock(): Promise<boolean> {
  try {
  if ((await rowList('app_lock')).length > 0) return true;
  const raw = await legacyPlain('app_lock_legacy', 'meta');
  if (!raw) return true;
  try {
    const meta = JSON.parse(raw) as { salt: string; iterations: number; verifier: string; createdAt: number };
    await upsertRow('app_lock', {
      id: 1, salt: meta.salt, iterations: meta.iterations,
      verifier: meta.verifier, created_at: meta.createdAt,
    });
    return true;
  } catch {
    return false;
  }
  } catch (e) {
    console.warn('[migration] app lock failed:', e);
    return false;
  }
}

/* ── command history ──────────────────────────────────────────────────────── */

async function migrateCommandHistory(): Promise<boolean> {
  try {
  const usageRaw = await legacySecure('command_history_legacy', 'usage');
  if (usageRaw) {
    const usage = JSON.parse(usageRaw) as Record<string, number>;
    for (const [cmd, count] of Object.entries(usage)) {
      const cipher = await encField(cmd);
      if (cipher) await upsertRow('command_usage', { command: cipher, count });
    }
  }
  const historyRaw = await legacySecure('command_history_legacy', 'history');
  if (historyRaw) {
    const history = JSON.parse(historyRaw) as { c: string; n: number; t: number }[];
    for (const h of history) {
      const cipher = await encField(h.c);
      if (cipher) await upsertRow('command_history', { command: cipher, count: h.n, last_used: h.t });
    }
  }
  return true;
  } catch (e) {
    console.warn('[migration] command history failed:', e);
    return false;
  }
}

/* ── vault records ────────────────────────────────────────────────────────── */

async function migrateVault(): Promise<boolean> {
  try {
  const raw = await legacySecure('vault', 'records');
  if (!raw) return true;
  try {
    const records = JSON.parse(raw) as EncryptedRecord[];
    for (const item of records) {
      const plaintext = await decryptPayload(getAppLockKey()!, item.data);
      const record = JSON.parse(plaintext) as VaultRecord;
      await upsertRow('vault_records', {
        id: item.id,
        name: (await encField(record.name)) ?? '',
        address: await encField(record.address),
        username: await encField(record.username),
        password: await encField(record.password),
        category: record.category ?? null,
        notes: await encField(record.notes),
        favorite: record.favorite ? 1 : 0,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      });
    }
    return true;
  } catch {
    /* records encrypted with an unknown key (e.g. old vault password) */
    return false;
  }
  } catch (e) {
    console.warn('[migration] vault failed:', e);
    return false;
  }
}

/* ── toolbox (apps / tunnels / services / notes) ──────────────────────────── */

async function migrateToolbox(): Promise<boolean> {
  try {
  const appRaw = await legacySecure('toolbox', 'apps');
  if (appRaw) {
    const apps = JSON.parse(appRaw) as ToolboxApp[];
    for (const a of apps) {
      await upsertRow('toolbox_apps', {
        id: a.id, name: a.name, path: a.path,
        args: a.args ?? null, work_dir: a.cwd ?? null,
        icon_path: a.iconPath ?? null, category: a.category ?? null,
        created_at: a.createdAt, updated_at: a.updatedAt,
      });
    }
  }
  const tunnelRaw = await legacySecure('toolbox', 'tunnels');
  if (tunnelRaw) {
    const tunnels = JSON.parse(tunnelRaw) as TunnelConfig[];
    for (const t of tunnels) {
      await upsertRow('tunnels', {
        id: t.id, name: t.name, bind_address: t.bindAddress,
        listen_port: t.listenPort, remote_host: t.remoteHost,
        remote_port: t.remotePort,
        jump_host: t.jumpHost ?? null, jump_port: t.jumpPort ?? null,
        jump_username: t.jumpUsername ?? null,
        jump_password: (await encField(t.jumpPassword)) ?? null,
        group_name: t.group ?? null,
        created_at: t.createdAt, updated_at: t.updatedAt,
      });
    }
  }
  const serviceRaw = await legacySecure('toolbox', 'services');
  if (serviceRaw) {
    const services = JSON.parse(serviceRaw) as ServiceConfig[];
    for (const s of services) {
      await upsertRow('services', {
        id: s.id, name: s.name, command: s.command,
        work_dir: s.cwd ?? null,
        args: s.args ?? null,
        env: s.env ? JSON.stringify(s.env) : null,
        group_name: s.group ?? null,
        created_at: s.createdAt, updated_at: s.updatedAt,
      });
    }
  }
  const notesRaw = await legacySecure('toolbox', 'notes');
  if (notesRaw) {
    const notes = JSON.parse(notesRaw) as NoteItem[];
    for (const n of notes) {
      await upsertRow('notes', {
        id: n.id,
        title: (await encField(n.title)) ?? '',
        language: n.language,
        content: (await encField(n.content)) ?? '',
        created_at: n.createdAt, updated_at: n.updatedAt,
      });
    }
  }
  return true;
  } catch (e) {
    console.warn('[migration] toolbox failed:', e);
    return false;
  }
}

/* ── api debugger ─────────────────────────────────────────────────────────── */

async function migrateApiDebug(): Promise<boolean> {
  try {
  const collectionRaw = await legacySecure('api_debug', 'collection');
  if (collectionRaw) {
    const requests = JSON.parse(collectionRaw) as RequestConfig[];
    for (const r of requests) {
      const request = await encField(JSON.stringify(r));
      if (!request) continue;
      await upsertRow('api_collections', {
        id: r.id, name: r.name, group_name: r.group || null,
        request, created_at: r.updatedAt, updated_at: r.updatedAt,
      });
    }
  }
  const envRaw = await legacySecure('api_debug', 'environments');
  if (envRaw) {
    const environments = JSON.parse(envRaw) as ApiEnvironment[];
    for (const e of environments) {
      const variables = await encField(JSON.stringify(e.variables));
      await upsertRow('api_environments', {
        id: e.id, name: e.name,
        variables: variables ?? '[]',
        created_at: Date.now(), updated_at: Date.now(),
      });
    }
  }
  const activeRaw = await legacySecure('api_debug', 'active-env');
  if (activeRaw) {
    const { setApiActiveEnv } = await import('./preferences');
    setApiActiveEnv(activeRaw);
  }
  return true;
  } catch (e) {
    console.warn('[migration] api debug failed:', e);
    return false;
  }
}

/** Exported for reuse by preference hydration (decrypt helper). */
export { decField };
