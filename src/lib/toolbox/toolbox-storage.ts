/**
 * SQLite-backed list storage for the Toolbox features (apps, tunnels,
 * services, notes) — one row per item in dedicated normalized tables.
 * Keeps a synchronous in-memory cache; every mutation is persisted per-row
 * (sensitive fields — note title/content — encrypted via the app-password key).
 */
import type { NoteItem, ToolboxApp, TunnelConfig, ServiceConfig } from './toolbox-types';
import { rowList, rowUpsert, rowDelete, decField, encField } from './db';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Generate a reasonably unique id with a readable prefix. */
export function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

type Kind = 'apps' | 'tunnels' | 'services' | 'notes';

// In-memory cache (synchronous reads for the UI).
const cache: Record<Kind, unknown[]> = { apps: [], tunnels: [], services: [], notes: [] };
let initialized = false;

/* ── row mapping helpers ──────────────────────────────────────────────────── */

function appToRow(a: ToolboxApp): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    path: a.path,
    args: a.args ?? null,
    work_dir: a.cwd ?? null,
    icon_path: a.iconPath ?? null,
    category: a.category ?? null,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

function rowToApp(row: Record<string, unknown>): ToolboxApp {
  return {
    id: str(row.id),
    name: str(row.name),
    path: str(row.path),
    args: (row.args as string) ?? undefined,
    cwd: (row.work_dir as string) ?? undefined,
    iconPath: (row.icon_path as string) ?? undefined,
    category: (row.category as string) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

async function tunnelToRowEncrypted(t: TunnelConfig): Promise<Record<string, unknown>> {
  return {
    id: t.id,
    name: t.name,
    bind_address: t.bindAddress,
    listen_port: t.listenPort,
    remote_host: t.remoteHost,
    remote_port: t.remotePort,
    jump_host: t.jumpHost ?? null,
    jump_port: t.jumpPort ?? null,
    jump_username: t.jumpUsername ?? null,
    jump_password: (await encField(t.jumpPassword)) ?? null,
    group_name: t.group ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function rowToTunnel(row: Record<string, unknown>): TunnelConfig {
  return {
    id: str(row.id),
    name: str(row.name),
    bindAddress: str(row.bind_address),
    listenPort: row.listen_port as number,
    remoteHost: str(row.remote_host),
    remotePort: row.remote_port as number,
    jumpHost: (row.jump_host as string) ?? undefined,
    jumpPort: (row.jump_port as number) ?? undefined,
    jumpUsername: (row.jump_username as string) ?? undefined,
    group: (row.group_name as string) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** Decrypt a tunnel row; falls back to the raw value for legacy plaintext data. */
async function rowToTunnelDecrypted(row: Record<string, unknown>): Promise<TunnelConfig> {
  const t = rowToTunnel(row);
  t.jumpPassword =
    (await decField(row.jump_password as string)) ?? (row.jump_password as string) ?? undefined;
  return t;
}

function serviceToRow(s: ServiceConfig): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    command: s.command,
    work_dir: s.cwd ?? null,
    args: s.args ?? null,
    env: s.env ? JSON.stringify(s.env) : null,
    group_name: s.group ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function rowToService(row: Record<string, unknown>): ServiceConfig {
  const service: ServiceConfig = {
    id: str(row.id),
    name: str(row.name),
    command: str(row.command),
    cwd: (row.work_dir as string) ?? undefined,
    args: (row.args as string) ?? undefined,
    group: (row.group_name as string) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
  if (row.env) {
    try {
      service.env = JSON.parse(str(row.env)) as string[];
    } catch {
      /* ignore */
    }
  }
  return service;
}

/** Note title/content are encrypted per-field before persisting. */
async function rowToNote(row: Record<string, unknown>): Promise<NoteItem> {
  return {
    id: str(row.id),
    title: (await decField(row.title as string)) ?? str(row.title),
    language: (row.language as NoteItem['language']) ?? 'text',
    content: (await decField(row.content as string)) ?? str(row.content),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

async function noteToRowEncrypted(n: NoteItem): Promise<Record<string, unknown>> {
  return {
    id: n.id,
    title: (await encField(n.title)) ?? '',
    language: n.language,
    content: (await encField(n.content)) ?? '',
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

/* ── hydration / persistence ──────────────────────────────────────────────── */

function tableFor(kind: Kind): 'toolbox_apps' | 'tunnels' | 'services' | 'notes' {
  if (kind === 'apps') return 'toolbox_apps';
  if (kind === 'tunnels') return 'tunnels';
  if (kind === 'services') return 'services';
  return 'notes';
}

/** Load every toolbox list from SQLite (call once after app unlock). */
export async function initializeToolboxStore(): Promise<void> {
  const [apps, tunnels, services, notes] = await Promise.all([
    rowList('toolbox_apps'),
    rowList('tunnels'),
    rowList('services'),
    rowList('notes'),
  ]);
  cache.apps = apps.map(rowToApp);
  cache.tunnels = await Promise.all(tunnels.map(rowToTunnelDecrypted));
  cache.services = services.map(rowToService);
  cache.notes = await Promise.all(notes.map(rowToNote));
  initialized = true;
}

export function isToolboxStoreInitialized(): boolean {
  return initialized;
}

/** Reset the in-memory cache (used by tests to simulate an app restart). */
export function resetToolboxStore(): void {
  cache.apps = [];
  cache.tunnels = [];
  cache.services = [];
  cache.notes = [];
  initialized = false;
}

function list<T>(kind: Kind): T[] {
  return cache[kind] as T[];
}

function commitUpsert(kind: Kind, row: Record<string, unknown>): void {
  void rowUpsert(tableFor(kind), row).then(() => undefined);
}

function commitDelete(kind: Kind, id: string): void {
  void rowDelete(tableFor(kind), id).then(() => undefined);
}

function upsert<T extends { id: string }>(kind: Kind, item: T): T[] {
  const items = list<T>(kind);
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) {
    cache[kind] = [...items, item];
  } else {
    const next = [...items];
    next[index] = item;
    cache[kind] = next;
  }
  if (kind === 'notes') {
    void noteToRowEncrypted(item as unknown as NoteItem).then((row) => commitUpsert(kind, row));
  } else if (kind === 'tunnels') {
    void tunnelToRowEncrypted(item as unknown as TunnelConfig).then((row) => commitUpsert(kind, row));
  } else {
    commitUpsert(kind, mapToRow(kind, item));
  }
  return list<T>(kind);
}

function mapToRow(kind: Kind, item: { id: string }): Record<string, unknown> {
  if (kind === 'apps') return appToRow(item as ToolboxApp);
  // tunnels are persisted through the encrypted path (upsert/save), so this
  // branch is only a type-level fallback that is never executed.
  if (kind === 'tunnels') return { id: (item as TunnelConfig).id };
  return serviceToRow(item as ServiceConfig);
}

function remove<T extends { id: string }>(kind: Kind, id: string): T[] {
  cache[kind] = list<T>(kind).filter((i) => i.id !== id);
  commitDelete(kind, id);
  return list<T>(kind);
}

/* ── Apps ─────────────────────────────────────────────────────────────────── */

export const AppsStorage = {
  load(): ToolboxApp[] {
    return list<ToolboxApp>('apps');
  },
  save(items: ToolboxApp[]): void {
    cache.apps = items;
    for (const item of items) {
      commitUpsert('apps', appToRow(item));
    }
  },
  upsert(item: ToolboxApp): ToolboxApp[] {
    return upsert('apps', item);
  },
  remove(id: string): ToolboxApp[] {
    return remove('apps', id);
  },
};

/* ── Tunnels ──────────────────────────────────────────────────────────────── */

export const TunnelsStorage = {
  load(): TunnelConfig[] {
    return list<TunnelConfig>('tunnels');
  },
  save(items: TunnelConfig[]): void {
    cache.tunnels = items;
    for (const item of items) {
      void tunnelToRowEncrypted(item).then((row) => commitUpsert('tunnels', row));
    }
  },
  upsert(item: TunnelConfig): TunnelConfig[] {
    return upsert('tunnels', item);
  },
  remove(id: string): TunnelConfig[] {
    return remove('tunnels', id);
  },
};

/* ── Services ─────────────────────────────────────────────────────────────── */

export const ServicesStorage = {
  load(): ServiceConfig[] {
    return list<ServiceConfig>('services');
  },
  save(items: ServiceConfig[]): void {
    cache.services = items;
    for (const item of items) {
      commitUpsert('services', serviceToRow(item));
    }
  },
  upsert(item: ServiceConfig): ServiceConfig[] {
    return upsert('services', item);
  },
  remove(id: string): ServiceConfig[] {
    return remove('services', id);
  },
};

/* ── Notes ────────────────────────────────────────────────────────────────── */

export const NotesStorage = {
  load(): NoteItem[] {
    return list<NoteItem>('notes');
  },
  save(items: NoteItem[]): void {
    cache.notes = items;
    for (const item of items) {
      void noteToRowEncrypted(item).then((row) => commitUpsert('notes', row));
    }
  },
  upsert(item: NoteItem): NoteItem[] {
    return upsert('notes', item);
  },
  remove(id: string): NoteItem[] {
    return remove('notes', id);
  },
};
