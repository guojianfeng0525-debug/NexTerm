/** Plaintext ZIP configuration archive import/export. */
import { invoke } from '@tauri-apps/api/core';
import { open as tauriOpen, save } from '@tauri-apps/plugin-dialog';
import { ConnectionStorageManager } from './connection-storage';
import { ConnectionProfileManager, type ConnectionProfile } from './connection-profiles';
import { prefGet, prefSet } from './preferences';
import { verifyAppLock, getAppLockKey } from './toolbox/app-lock';
import { AppsStorage, OrchestrationsStorage, ServicesStorage, TunnelsStorage, NotesStorage, generateId } from './toolbox/toolbox-storage';
import { PostgresConnectionsStorage } from './toolbox/postgres-storage';
import {
  adaptPostgreSQLPersistedProfile,
  toPostgreSQLPersistedProfile,
  type PostgreSQLPersistedProfile,
} from './database/postgresql-profile-adapter';
import type { NoteItem, ServiceConfig, ServiceOrchestration, ToolboxApp } from './toolbox/toolbox-types';
import { buildVaultExcel, parseVaultExcel } from './toolbox/vault-excel';
import { loadRecords, saveRecords } from './toolbox/records-storage';
import { listDocuments, exportDocument, importDocument, deleteDocument } from './toolbox/documents-storage';

interface ArchiveEntry {
  path: string;
  data: number[];
}

interface ArchiveManifest {
  format: 'nexterm-config-archive';
  version: 1;
  exportedAt: string;
  documents: Array<{ path: string; name: string }>;
}

interface AppConfig {
  settings: Record<string, unknown>;
  layout: Record<string, unknown>;
  appearance: Record<string, unknown>;
  editor: Record<string, unknown>;
  language: string;
  apps: ToolboxApp[];
  services: ServiceConfig[];
  orchestrations: ServiceOrchestration[];
  profiles: ConnectionProfile[];
  /** Kept flat for compatibility with existing v1 configuration archives. */
  postgresConnections: PostgreSQLPersistedProfile[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonEntry(path: string, value: unknown): ArchiveEntry {
  return { path, data: Array.from(encoder.encode(JSON.stringify(value, null, 2))) };
}

function parseJson<T>(entries: Map<string, Uint8Array>, path: string): T {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`Archive is missing ${path}`);
  return JSON.parse(decoder.decode(bytes)) as T;
}

function validateManifest(manifest: ArchiveManifest): void {
  if (manifest.format !== 'nexterm-config-archive' || manifest.version !== 1) {
    throw new Error('Unsupported configuration archive');
  }
}

function noteRows(notes: NoteItem[]): unknown[][] {
  return [
    ['Title', 'Language', 'Content', 'Pinned', 'Created At', 'Updated At'],
    ...notes.map((note) => [note.title, note.language, note.content, !!note.pinned, note.createdAt, note.updatedAt]),
  ];
}

async function buildNotesExcel(notes: NoteItem[]): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(noteRows(notes)), 'Notes');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function parseNotesExcel(bytes: Uint8Array): Promise<NoteItem[]> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' }) : [];
  const headers = rows[0];
  if (!Array.isArray(headers) || headers.join('|') !== 'Title|Language|Content|Pinned|Created At|Updated At') {
    throw new Error('Invalid notes workbook');
  }
  return rows.slice(1).flatMap((row): NoteItem[] => {
    const title = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!title) return [];
    const now = Date.now();
    return [{
      id: generateId('note'), title,
      language: typeof row[1] === 'string' ? row[1] as NoteItem['language'] : 'plain',
      content: typeof row[2] === 'string' ? row[2] : '',
      pinned: row[3] === true || row[3] === 'true' || row[3] === 1,
      createdAt: typeof row[4] === 'number' ? row[4] : now,
      updatedAt: typeof row[5] === 'number' ? row[5] : now,
    }];
  });
}

/** Export a plaintext ZIP after verifying the existing app-lock password. */
export async function exportAllConfig(password: string): Promise<boolean> {
  if (!(await verifyAppLock(password))) throw new Error('Incorrect app-lock password');
  const outputPath = await save({
    defaultPath: `nexterm-config-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'NexTerm Configuration Archive', extensions: ['zip'] }],
  });
  if (!outputPath) return false;

  const key = getAppLockKey();
  if (!key) throw new Error('App lock is not unlocked');
  const documents = listDocuments();
  const documentEntries = await Promise.all(documents.map(async (document) => {
    const path = `documents/${document.id}.${document.kind}`;
    return { path, data: Array.from(await exportDocument(document.id)) };
  }));
  const appConfig: AppConfig = {
    settings: prefGet('sshClientSettings', {}), layout: prefGet('nexterm-layout-config', {}),
    appearance: prefGet('terminalAppearance', {}), editor: prefGet('nexterm-editor-config', {}),
    language: prefGet('nexterm-language', 'auto'),
    apps: AppsStorage.load(), services: ServicesStorage.load(), orchestrations: OrchestrationsStorage.load(),
    profiles: ConnectionProfileManager.getProfiles(),
    postgresConnections: PostgresConnectionsStorage.load().map(toPostgreSQLPersistedProfile),
  };
  const vaultRows = (await loadRecords(key)).map(({ record }) => ({
    name: record.name, address: record.address, username: record.username, password: record.password,
    category: record.category ?? '', notes: record.notes ?? '', favorite: record.favorite ?? false,
  }));
  const manifest: ArchiveManifest = {
    format: 'nexterm-config-archive', version: 1, exportedAt: new Date().toISOString(),
    documents: documents.map((document) => ({ path: `documents/${document.id}.${document.kind}`, name: document.name })),
  };
  await invoke('write_config_archive', { outputPath, entries: [
    jsonEntry('manifest.json', manifest),
    jsonEntry('connections.json', JSON.parse(ConnectionStorageManager.exportConnections())),
    jsonEntry('tunnels.json', TunnelsStorage.load()), jsonEntry('app-config.json', appConfig),
    { path: 'vault.xlsx', data: Array.from(await buildVaultExcel(vaultRows)) },
    { path: 'notes.xlsx', data: Array.from(await buildNotesExcel(NotesStorage.load())) },
    ...documentEntries,
  ] satisfies ArchiveEntry[] });
  return true;
}

/** Import a plaintext ZIP. `merge` retains existing entries; false replaces them. */
export async function importAllConfig(merge = false): Promise<boolean> {
  const inputPath = await tauriOpen({ filters: [{ name: 'NexTerm Configuration Archive', extensions: ['zip'] }], multiple: false, directory: false });
  if (!inputPath || Array.isArray(inputPath)) return false;
  const rawEntries = await invoke<ArchiveEntry[]>('read_config_archive', { inputPath });
  const entries = new Map(rawEntries.map((entry) => [entry.path, new Uint8Array(entry.data)]));
  const manifest = parseJson<ArchiveManifest>(entries, 'manifest.json');
  validateManifest(manifest);
  const key = getAppLockKey();
  if (!key) throw new Error('App lock is not unlocked');

  const connections = parseJson<{ connections: unknown[]; folders?: unknown[] }>(entries, 'connections.json');
  ConnectionStorageManager.importConnections(JSON.stringify(connections), merge);
  const tunnels = parseJson<ReturnType<typeof TunnelsStorage.load>>(entries, 'tunnels.json');
  if (!merge) {
    TunnelsStorage.load().forEach((item) => TunnelsStorage.remove(item.id));
    AppsStorage.load().forEach((item) => AppsStorage.remove(item.id));
    ServicesStorage.load().forEach((item) => ServicesStorage.remove(item.id));
    OrchestrationsStorage.load().forEach((item) => OrchestrationsStorage.remove(item.id));
    NotesStorage.load().forEach((item) => NotesStorage.remove(item.id));
    await PostgresConnectionsStorage.replace([]);
  }
  TunnelsStorage.save(merge ? mergeById(TunnelsStorage.load(), tunnels) : tunnels);
  const config = parseJson<AppConfig>(entries, 'app-config.json');
  prefSet('sshClientSettings', config.settings);
  prefSet('nexterm-layout-config', config.layout);
  prefSet('terminalAppearance', config.appearance);
  prefSet('nexterm-editor-config', config.editor);
  prefSet('nexterm-language', config.language);
  ConnectionProfileManager.importProfiles(JSON.stringify(config.profiles ?? []), merge);
  const importedPostgresProfiles = (config.postgresConnections ?? []).map(
    adaptPostgreSQLPersistedProfile,
  );
  await PostgresConnectionsStorage.replace(merge
    ? mergeById(PostgresConnectionsStorage.load(), importedPostgresProfiles)
    : importedPostgresProfiles);
  AppsStorage.save(merge ? mergeById(AppsStorage.load(), config.apps ?? []) : (config.apps ?? []));
  ServicesStorage.save(merge ? mergeById(ServicesStorage.load(), config.services ?? []) : (config.services ?? []));
  OrchestrationsStorage.save(merge ? mergeById(OrchestrationsStorage.load(), config.orchestrations ?? []) : (config.orchestrations ?? []));

  const vaultBytes = entries.get('vault.xlsx');
  if (!vaultBytes) throw new Error('Archive is missing vault.xlsx');
  const vaultRows = await parseVaultExcel(vaultBytes);
  const currentRecords = merge ? await loadRecords(key) : [];
  const names = new Set(currentRecords.map((entry) => entry.record.name));
  const now = Date.now();
  for (const row of vaultRows) {
    if (merge && names.has(row.name)) continue;
    const id = generateId('record');
    currentRecords.push({ id, createdAt: now, updatedAt: now, record: {
      id, createdAt: now, updatedAt: now, name: row.name, address: row.address, username: row.username,
      password: row.password, category: row.category || undefined, notes: row.notes || undefined, favorite: row.favorite,
    } });
    names.add(row.name);
  }
  await saveRecords(key, currentRecords);
  const notesBytes = entries.get('notes.xlsx');
  if (!notesBytes) throw new Error('Archive is missing notes.xlsx');
  const notes = await parseNotesExcel(notesBytes);
  NotesStorage.save(merge ? [...NotesStorage.load(), ...notes] : notes);
  if (!merge) await Promise.all(listDocuments().map((document) => deleteDocument(document.id)));
  for (const document of manifest.documents) {
    const bytes = entries.get(document.path);
    if (!bytes) throw new Error(`Archive is missing ${document.path}`);
    await importDocument(document.name, bytes);
  }
  return true;
}

function mergeById<T extends { id: string }>(current: T[], imported: T[]): T[] {
  const next = new Map(current.map((item) => [item.id, item]));
  for (const item of imported) next.set(item.id, item);
  return [...next.values()];
}
