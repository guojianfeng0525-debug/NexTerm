import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';
import { createTestIpc } from '../lib/__tests__/helpers/test-ipc';
import { hydratePreferences, resetPreferenceCaches } from '../lib/preferences';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => {
    const cmd = args[0] as string;
    // Storage commands go to the in-memory SQLite stand-in so preferences
    // (e.g. follow-terminal-directory) persist like in production.
    if (cmd === 'row_upsert' || cmd === 'row_get' || cmd === 'row_list' ||
        cmd === 'row_delete' || cmd === 'row_clear' || cmd === 'legacy_db_get' ||
        cmd === 'drop_legacy_tables') {
      return ipc.invokeMock(...args);
    }
    return mocks.invoke(...args);
  },
  Channel: class {
    onmessage: ((payload: unknown) => void) | null = null;
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.error,
    info: mocks.info,
    success: mocks.success,
    warning: mocks.warning,
  },
}));

vi.mock('../lib/async-retry', () => ({
  CancelledError: class CancelledError extends Error {},
  withRetry: (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('../components/directory-tree', () => ({
  DirectoryTree: () => <div data-testid="directory-tree" />,
}));

vi.mock('../components/transfer-queue', () => ({
  TransferQueue: () => null,
}));

vi.mock('../components/directory-transfer-dialog', () => ({
  DirectoryTransferDialog: () => null,
}));

vi.mock('../components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}));

vi.mock('../components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const CACHE_DIR = '/Users/tester/Library/Caches/NexTerm/clipboard-downloads';

const FILE_A = {
  name: 'alpha.txt',
  size: 128,
  modified: null,
  permissions: '-rw-r--r--',
  file_type: 'File',
};
const FILE_B = {
  name: 'beta.log',
  size: 256,
  modified: null,
  permissions: '-rw-r--r--',
  file_type: 'File',
};

interface InvokeArgs {
  connectionId?: string;
  remotePath?: string;
  localPath?: string;
  paths?: string[];
  [key: string]: unknown;
}

function invokeCalls(cmd: string): Array<[string, InvokeArgs]> {
  return mocks.invoke.mock.calls.filter(([c]) => c === cmd);
}

function ctrlKey(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

function metaKey(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Install an invoke implementation. Defaults cover the standard flow:
 * two remote files, empty system clipboard, successful transfers.
 */
function installInvoke(overrides: Record<string, () => unknown> = {}) {
  const defaults: Record<string, () => unknown> = {
    list_files: () => [FILE_A, FILE_B],
    get_clipboard_cache_dir: () => CACHE_DIR,
    clipboard_read_files: () => [],
    upload_remote_file: () => ({ success: true }),
    download_remote_file: () => ({ success: true }),
    clipboard_write_files: () => null,
    copy_file: () => true,
  };
  const impl = { ...defaults, ...overrides };
  mocks.invoke.mockImplementation((cmd: string) => {
    const handler = impl[cmd];
    if (handler) return Promise.resolve(handler());
    return Promise.resolve(undefined);
  });
}

async function renderBrowser(connectionId = 'conn-clip') {
  render(
    <IntegratedFileBrowser
      connectionId={connectionId}
      isConnected
      onClose={() => {}}
    />,
  );
  // Wait for the file list to load and commit.
  expect(await screen.findByText('alpha.txt')).toBeTruthy();
  expect(await screen.findByText('beta.log')).toBeTruthy();
}

/** Ctrl/Cmd+Click file rows to select exactly the named files (no ".."). */
async function selectFiles(names: string[]) {
  for (const name of names) {
    fireEvent.click(screen.getByText(name), { ctrlKey: true });
  }
  await waitFor(() => {
    expect(screen.getAllByText(`${names.length} selected`).length).toBeGreaterThan(0);
  });
}

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  resetPreferenceCaches();
  await hydratePreferences();
  mocks.invoke.mockReset();
  installInvoke();
  mocks.warning.mockReset();
  mocks.success.mockReset();
  mocks.info.mockReset();
  mocks.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IntegratedFileBrowser system-clipboard Ctrl+C', () => {
  it('downloads selected files to the cache dir and writes local paths to the system clipboard', async () => {
    await renderBrowser();
    await selectFiles(['alpha.txt', 'beta.log']);

    fireEvent(document, ctrlKey('c'));

    // 1. Cache dir is requested first.
    await waitFor(() => {
      expect(invokeCalls('get_clipboard_cache_dir')).toHaveLength(1);
    });
    // 2. Both files are enqueued as downloads into the cache dir.
    await waitFor(() => {
      expect(invokeCalls('download_remote_file')).toHaveLength(2);
    });
    const dests = invokeCalls('download_remote_file').map(([, a]) => a.localPath).sort();
    expect(dests).toEqual([`${CACHE_DIR}/alpha.txt`, `${CACHE_DIR}/beta.log`]);
    const sources = invokeCalls('download_remote_file').map(([, a]) => a.remotePath).sort();
    expect(sources).toEqual(['/home/alpha.txt', '/home/beta.log']);

    // 3. Once both transfers complete, the local paths are written to the
    //    system clipboard as file references.
    await waitFor(() => {
      expect(invokeCalls('clipboard_write_files')).toHaveLength(1);
    });
    expect(invokeCalls('clipboard_write_files')[0][1].paths.sort()).toEqual(
      [`${CACHE_DIR}/alpha.txt`, `${CACHE_DIR}/beta.log`],
    );
    // 4. Downloading + done toasts.
    expect(
      mocks.info.mock.calls.some(([m]) => String(m).includes('system clipboard')),
    ).toBe(true);
    await waitFor(() => {
      expect(
        mocks.success.mock.calls.some(([m]) => String(m).includes('ready to paste locally')),
      ).toBe(true);
    });
  });

  it('writes the clipboard when only some files of the batch download succeed', async () => {
    installInvoke({
      download_remote_file: () => {
        const calls = invokeCalls('download_remote_file').length;
        return calls % 2 === 1 ? { success: false, error: 'boom' } : { success: true };
      },
    });
    await renderBrowser('conn-partial');
    await selectFiles(['alpha.txt', 'beta.log']);

    fireEvent(document, ctrlKey('c'));

    await waitFor(() => {
      expect(invokeCalls('download_remote_file')).toHaveLength(2);
    });
    // Only the successful download is written to the system clipboard.
    await waitFor(() => {
      expect(invokeCalls('clipboard_write_files')).toHaveLength(1);
    });
    const written = invokeCalls('clipboard_write_files')[0][1].paths;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/\/(alpha\.txt|beta\.log)$/);
  });

  it('keeps the virtual clipboard working alongside the system clipboard download', async () => {
    await renderBrowser();
    await selectFiles(['alpha.txt', 'beta.log']);

    fireEvent(document, ctrlKey('c'));

    // Virtual clipboard toast fires immediately (existing remote→remote flow).
    await waitFor(() => {
      expect(
        mocks.success.mock.calls.some(([m]) => String(m).includes('copied to clipboard')),
      ).toBe(true);
    });
    // ...and the system-clipboard download still starts.
    await waitFor(() => {
      expect(invokeCalls('get_clipboard_cache_dir')).toHaveLength(1);
    });
  });

  it('does not enqueue clipboard downloads when no plain file is selected', async () => {
    installInvoke({
      list_files: () => [{ name: 'docs', size: 0, modified: null, permissions: 'drwxr-xr-x', file_type: 'Directory' }],
    });
    render(
      <IntegratedFileBrowser
        connectionId="conn-dir-only"
        isConnected
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText('docs')).toBeTruthy();
    fireEvent.click(screen.getByText('docs'), { ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByText('1 selected')).toBeTruthy();
    });

    fireEvent(document, ctrlKey('c'));

    // Virtual clipboard still populated, but no system-clipboard download.
    await waitFor(() => {
      expect(mocks.success).toHaveBeenCalled();
    });
    expect(invokeCalls('get_clipboard_cache_dir')).toHaveLength(0);
    expect(invokeCalls('download_remote_file')).toHaveLength(0);
  });

  it('degrades gracefully when get_clipboard_cache_dir fails', async () => {
    installInvoke({
      get_clipboard_cache_dir: () => {
        throw new Error('cache dir unavailable');
      },
    });
    await renderBrowser('conn-cache-fail');
    await selectFiles(['alpha.txt']);

    fireEvent(document, ctrlKey('c'));

    // Virtual clipboard still works; no crash, no error toast for this path.
    await waitFor(() => {
      expect(
        mocks.success.mock.calls.some(([m]) => String(m).includes('copied to clipboard')),
      ).toBe(true);
    });
    expect(invokeCalls('download_remote_file')).toHaveLength(0);
    expect(mocks.error).not.toHaveBeenCalled();
  });
});

describe('IntegratedFileBrowser system-clipboard Ctrl+V', () => {
  it('uploads files from the system clipboard when the virtual clipboard is empty', async () => {
    const localFiles = ['/Users/tester/Desktop/report.pdf', '/Users/tester/Desktop/notes.txt'];
    installInvoke({
      clipboard_read_files: () => localFiles,
    });
    await renderBrowser('conn-paste-upload');

    fireEvent(document, ctrlKey('v'));

    await waitFor(() => {
      expect(invokeCalls('clipboard_read_files')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(invokeCalls('upload_remote_file')).toHaveLength(2);
    });
    const uploadArgs = invokeCalls('upload_remote_file').map(([, a]) => a);
    expect(uploadArgs.map((a) => a.localPath).sort()).toEqual([...localFiles].sort());
    // Destination = current remote dir + "/" + basename.
    expect(uploadArgs.map((a) => a.remotePath).sort()).toEqual(
      ['/home/report.pdf', '/home/notes.txt'].sort(),
    );
  });

  it('prefers the virtual clipboard and never reads the system clipboard when it is non-empty', async () => {
    await renderBrowser('conn-paste-remote');
    await selectFiles(['alpha.txt', 'beta.log']);

    // Ctrl+C fills the virtual clipboard (and kicks a clipboard download).
    fireEvent(document, ctrlKey('c'));
    await waitFor(() => {
      expect(invokeCalls('get_clipboard_cache_dir')).toHaveLength(1);
    });
    // Reset call log so only the paste behavior is inspected below.
    mocks.invoke.mockClear();

    fireEvent(document, ctrlKey('v'));

    // Remote copy_file is used; clipboard_read_files is never called.
    await waitFor(() => {
      expect(invokeCalls('copy_file')).toHaveLength(2);
    });
    expect(invokeCalls('clipboard_read_files')).toHaveLength(0);
    expect(invokeCalls('upload_remote_file')).toHaveLength(0);
  });

  it('toasts and does not crash when clipboard_read_files rejects', async () => {
    installInvoke({
      clipboard_read_files: () => {
        throw new Error('clipboard unavailable');
      },
    });
    await renderBrowser('conn-read-fail');

    expect(() => fireEvent(document, ctrlKey('v'))).not.toThrow();

    await waitFor(() => {
      expect(
        mocks.error.mock.calls.some(([m]) => String(m).includes('system clipboard')),
      ).toBe(true);
    });
  });

  it('does nothing when both clipboards are empty', async () => {
    await renderBrowser('conn-empty');
    mocks.invoke.mockClear();

    fireEvent(document, ctrlKey('v'));

    await waitFor(() => {
      expect(invokeCalls('clipboard_read_files')).toHaveLength(1);
    });
    // No uploads enqueued, no errors.
    expect(invokeCalls('upload_remote_file')).toHaveLength(0);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('supports Cmd+V (metaKey) like Ctrl+V', async () => {
    installInvoke({
      clipboard_read_files: () => ['/Users/tester/Desktop/only.txt'],
    });
    await renderBrowser('conn-cmd-v');

    fireEvent(document, metaKey('v'));

    await waitFor(() => {
      expect(invokeCalls('clipboard_read_files')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(invokeCalls('upload_remote_file')).toHaveLength(1);
    });
    expect(invokeCalls('upload_remote_file')[0][1].remotePath).toBe('/home/only.txt');
  });
});

describe('IntegratedFileBrowser row context menu file-type branching', () => {
  it('renders file actions for files and directory actions for directories', async () => {
    installInvoke({
      list_files: () => [
        { name: 'report.txt', size: 20, modified: null, permissions: '-rw-r--r--', file_type: 'File' },
        { name: 'docs', size: 0, modified: null, permissions: 'drwxr-xr-x', file_type: 'Directory' },
      ],
    });

    render(
      <IntegratedFileBrowser
        connectionId="conn-context-types"
        isConnected
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('report.txt')).toBeTruthy();
    expect(await screen.findByText('docs')).toBeTruthy();

    // The mocked portal renders every row's menu content; exact-text counts
    // still verify that the file and directory branches are mutually active.
    expect(screen.getAllByText('Open')).toHaveLength(1);
    expect(screen.getAllByText('Download')).toHaveLength(1);
    expect(screen.getAllByText('Open Folder')).toHaveLength(1);
    expect(screen.getAllByText('Download directory')).toHaveLength(1);
  });
});
