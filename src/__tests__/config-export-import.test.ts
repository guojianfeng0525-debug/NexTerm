import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSave = vi.fn();
const mockOpen = vi.fn();
const mockInvoke = vi.fn();
const verifyAppLock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => mockSave(...args), open: (...args: unknown[]) => mockOpen(...args),
}));
vi.mock('../lib/toolbox/app-lock', () => ({ verifyAppLock, getAppLockKey: () => ({}) }));
vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: { exportConnections: () => JSON.stringify({ connections: [], folders: [] }), importConnections: vi.fn() },
}));
vi.mock('../lib/preferences', () => ({ prefGet: (_key: string, fallback: unknown) => fallback, prefSet: vi.fn() }));
vi.mock('../lib/toolbox/toolbox-storage', () => ({
  AppsStorage: { load: () => [], save: vi.fn(), remove: vi.fn() },
  TunnelsStorage: { load: () => [], save: vi.fn(), remove: vi.fn() },
  ServicesStorage: { load: () => [], save: vi.fn(), remove: vi.fn() },
  OrchestrationsStorage: { load: () => [], save: vi.fn(), remove: vi.fn() },
  NotesStorage: { load: () => [], save: vi.fn(), remove: vi.fn() }, generateId: () => 'generated-id',
}));
vi.mock('../lib/connection-profiles', () => ({ ConnectionProfileManager: { getProfiles: () => [], importProfiles: vi.fn() } }));
vi.mock('../lib/toolbox/vault-excel', () => ({ buildVaultExcel: () => new Uint8Array(), parseVaultExcel: () => [] }));
vi.mock('../lib/toolbox/records-storage', () => ({ loadRecords: () => [], saveRecords: vi.fn() }));
vi.mock('../lib/toolbox/documents-storage', () => ({
  listDocuments: () => [], exportDocument: () => new Uint8Array(), importDocument: vi.fn(), deleteDocument: vi.fn(),
}));

describe('plaintext configuration archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAppLock.mockResolvedValue(true);
    mockInvoke.mockResolvedValue(undefined);
  });

  it('verifies the app-lock password and writes the required plaintext ZIP entries', async () => {
    mockSave.mockResolvedValue('/tmp/nexterm-config.zip');
    const { exportAllConfig } = await import('../lib/config-export-import');

    await expect(exportAllConfig('correct horse battery staple')).resolves.toBe(true);
    expect(verifyAppLock).toHaveBeenCalledWith('correct horse battery staple');
    expect(mockInvoke).toHaveBeenCalledWith('write_config_archive', expect.objectContaining({
      outputPath: '/tmp/nexterm-config.zip',
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'manifest.json' }), expect.objectContaining({ path: 'connections.json' }),
        expect.objectContaining({ path: 'tunnels.json' }), expect.objectContaining({ path: 'app-config.json' }),
        expect.objectContaining({ path: 'vault.xlsx' }), expect.objectContaining({ path: 'notes.xlsx' }),
      ]),
    }));
  });

  it('does not open a save dialog when the app-lock password is wrong', async () => {
    verifyAppLock.mockResolvedValue(false);
    const { exportAllConfig } = await import('../lib/config-export-import');

    await expect(exportAllConfig('wrong')).rejects.toThrow('Incorrect app-lock password');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('reads a ZIP archive through the backend command', async () => {
    mockOpen.mockResolvedValue('/tmp/nexterm-config.zip');
    const XLSX = await import('xlsx');
    const notesWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(notesWorkbook, XLSX.utils.aoa_to_sheet([
      ['Title', 'Language', 'Content', 'Pinned', 'Created At', 'Updated At'],
    ]), 'Notes');
    const notesBytes = Array.from(new Uint8Array(XLSX.write(notesWorkbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'read_config_archive') return Promise.resolve([
        { path: 'manifest.json', data: Array.from(new TextEncoder().encode(JSON.stringify({ format: 'nexterm-config-archive', version: 1, documents: [] }))) },
        { path: 'connections.json', data: Array.from(new TextEncoder().encode('{"connections":[]}')) },
        { path: 'tunnels.json', data: Array.from(new TextEncoder().encode('[]')) },
        { path: 'app-config.json', data: Array.from(new TextEncoder().encode('{"settings":{},"layout":{},"appearance":{},"editor":{},"language":"auto"}')) },
        { path: 'vault.xlsx', data: [] }, { path: 'notes.xlsx', data: notesBytes },
      ]);
      return Promise.resolve(undefined);
    });
    const { importAllConfig } = await import('../lib/config-export-import');

    await expect(importAllConfig(true)).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('read_config_archive', { inputPath: '/tmp/nexterm-config.zip' });
  });
});
