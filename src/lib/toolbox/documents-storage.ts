/**
 * Documents module storage — metadata + version/export orchestration.
 *
 * SQLite is the single source of truth (canonical model + resource BLOBs);
 * the frontend only holds lightweight metadata. File bytes are exchanged with
 * the backend through Tauri commands (import / export / save) and are never
 * persisted in the frontend.
 */
import { invoke } from '@tauri-apps/api/core';
import { rowList } from './db';

/** Call the backend with a hard timeout so a hung command shows an error
 *  instead of leaving the UI waiting forever. */
async function invokeWithTimeout<T>(cmd: string, args: Record<string, unknown>, ms = 30000): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`操作超时（${ms / 1000}s）`)), ms),
  );
  const call = invoke<T>(cmd, args);
  return Promise.race([call, timer]);
}

export type DocumentKind = 'xlsx' | 'docx';

export interface DocumentMeta {
  id: string;
  name: string;
  kind: DocumentKind;
  size: number;
  headVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentVersion {
  version: number;
  createdAt: number;
}

let cache: DocumentMeta[] = [];
let initialized = false;

export function isDocumentsStoreInitialized(): boolean {
  return initialized;
}

export function resetDocumentsStore(): void {
  cache = [];
  initialized = false;
}

/** Load document metadata from SQLite (call once after unlock). */
export async function initializeDocumentsStore(): Promise<void> {
  try {
    const rows = await rowList('documents');
    cache = rows.map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      kind: (r.kind as DocumentKind) ?? 'xlsx',
      size: (r.size as number) ?? 0,
      headVersion: (r.head_version as number) ?? 0,
      createdAt: (r.created_at as number) ?? 0,
      updatedAt: (r.updated_at as number) ?? 0,
    }));
  } catch {
    cache = [];
  }
  initialized = true;
}

/** All documents, newest first. */
export function listDocuments(): DocumentMeta[] {
  return [...cache].sort((a, b) => b.createdAt - a.createdAt);
}

/** Refresh the metadata cache from the backend. */
export async function refreshDocuments(): Promise<DocumentMeta[]> {
  try {
    const rows = await invokeWithTimeout<DocumentMeta[]>('documents_list', {});
    cache = rows;
  } catch {
    /* backend unavailable */
  }
  return listDocuments();
}

/** Import a file: bytes go to the backend, only metadata stays here. */
export async function importDocument(name: string, bytes: Uint8Array): Promise<DocumentMeta> {
  const id = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const meta = await invokeWithTimeout<DocumentMeta>('documents_import', { bytes, name, id });
  cache = [meta, ...cache];
  return meta;
}

/** Export a document version to OOXML bytes (default: head). */
export async function exportDocument(docId: string, version?: number): Promise<Uint8Array> {
  const res = await invokeWithTimeout<number[]>('documents_export', { docId, version: version ?? null });
  return new Uint8Array(res);
}

/** Save edited bytes as a new version. Returns the new version number. */
export async function saveDocument(
  docId: string,
  baseVersion: number,
  name: string,
  bytes: Uint8Array,
): Promise<number> {
  const next = await invokeWithTimeout<number>('documents_save', {
    docId,
    baseVersion,
    name,
    bytes,
  });
  cache = cache.map((d) => (d.id === docId ? { ...d, headVersion: next } : d));
  return next;
}

/** Version list for a document. */
export async function listVersions(docId: string): Promise<DocumentVersion[]> {
  const rows = await invokeWithTimeout<[number, number][]>('documents_versions', { docId });
  return rows.map(([version, createdAt]) => ({ version, createdAt }));
}

/** Delete a document and all versions. */
export async function deleteDocument(docId: string): Promise<void> {
  await invokeWithTimeout('documents_delete', { docId });
  cache = cache.filter((d) => d.id !== docId);
}
