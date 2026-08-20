/**
 * Documents module storage — metadata cache + backend command plumbing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestIpc } from './helpers/test-ipc';
import {
  initializeDocumentsStore,
  resetDocumentsStore,
  listDocuments,
  importDocument,
  exportDocument,
  saveDocument,
  deleteDocument,
} from '../toolbox/documents-storage';

const ipc = createTestIpc();
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => {
    const cmd = args[0] as string;
    if (cmd.startsWith('row_') || cmd === 'legacy_db_get' || cmd === 'drop_legacy_tables') {
      return ipc.invokeMock(...args);
    }
    return invokeMock(...args);
  },
}));

const meta = {
  id: 'doc-1',
  name: '报表.xlsx',
  kind: 'xlsx' as const,
  size: 1234,
  headVersion: 1,
  createdAt: 1000,
  updatedAt: 1000,
};

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  invokeMock.mockReset();
  resetDocumentsStore();
  await initializeDocumentsStore();
});

describe('documents storage', () => {
  it('lists metadata from SQLite after restart', async () => {
    ipc.DB.documents = [
      { id: 'doc-1', name: 'a.xlsx', kind: 'xlsx', size: 10, head_version: 1, created_at: 1, updated_at: 1 },
      { id: 'doc-2', name: 'b.docx', kind: 'docx', size: 20, head_version: 2, created_at: 2, updated_at: 2 },
    ];
    resetDocumentsStore();
    await initializeDocumentsStore();
    const docs = listDocuments();
    expect(docs).toHaveLength(2);
    expect(docs[0].name).toBe('b.docx');
    expect(docs[0].kind).toBe('docx');
    expect(docs[0].headVersion).toBe(2);
  });

  it('imports via the backend command and caches metadata', async () => {
    invokeMock.mockResolvedValueOnce(meta);
    const result = await importDocument('报表.xlsx', new Uint8Array([1, 2, 3]));
    expect(result.id).toBe('doc-1');
    expect(invokeMock).toHaveBeenCalledWith('documents_import', expect.objectContaining({ name: '报表.xlsx' }));
    expect(listDocuments()).toHaveLength(1);
  });

  it('exports bytes via the backend command', async () => {
    invokeMock.mockResolvedValueOnce([1, 2, 3, 4]);
    const bytes = await exportDocument('doc-1');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(invokeMock).toHaveBeenCalledWith('documents_export', { docId: 'doc-1', version: null });
  });

  it('saves edited bytes and advances the cached head version', async () => {
    ipc.DB.documents = [
      { id: 'doc-1', name: 'a.xlsx', kind: 'xlsx', size: 10, head_version: 1, created_at: 1, updated_at: 1 },
    ];
    resetDocumentsStore();
    await initializeDocumentsStore();

    invokeMock.mockResolvedValueOnce(2);
    await saveDocument('doc-1', 1, 'a.xlsx', new Uint8Array([9]));
    expect(invokeMock).toHaveBeenCalledWith('documents_save', expect.objectContaining({ baseVersion: 1 }));
    expect(listDocuments()[0].headVersion).toBe(2);
  });

  it('deletes via the backend command and removes from cache', async () => {
    ipc.DB.documents = [
      { id: 'doc-1', name: 'a.xlsx', kind: 'xlsx', size: 10, head_version: 1, created_at: 1, updated_at: 1 },
    ];
    resetDocumentsStore();
    await initializeDocumentsStore();

    invokeMock.mockResolvedValueOnce(undefined);
    await deleteDocument('doc-1');
    expect(invokeMock).toHaveBeenCalledWith('documents_delete', { docId: 'doc-1' });
    expect(listDocuments()).toHaveLength(0);
  });
});
