import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegratedFileBrowser } from '../components/integrated-file-browser';
import { createTestIpc } from '../lib/__tests__/helpers/test-ipc';
import { hydratePreferences, resetPreferenceCaches, prefGet } from '../lib/preferences';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  warning: vi.fn(),
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
  open: mocks.open,
  save: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
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
  DirectoryTransferDialog: ({
    sourcePath,
    destPath,
    destinationDirectoryName,
  }: {
    sourcePath: string;
    destPath: string;
    destinationDirectoryName?: string;
  }) => <div data-testid="directory-transfer">{sourcePath} → {destPath}/{destinationDirectoryName}</div>,
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

beforeEach(async () => {
  for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
  resetPreferenceCaches();
  await hydratePreferences();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue([]);
  mocks.open.mockReset();
  mocks.warning.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('IntegratedFileBrowser keyboard shortcuts', () => {
  it('does not intercept document shortcuts from editable targets', () => {
    render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected={false}
        onClose={() => {}}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    input.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();

    input.remove();
  });
});

describe('IntegratedFileBrowser terminal directory following', () => {
  it('loads the active terminal directory and decodes spaces and Unicode', async () => {
    const terminalWorkingDirectory = {
      path: '/srv/My Project/测试',
      sequence: 1,
    };

    render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={terminalWorkingDirectory}
      />,
    );

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
        connectionId: 'conn-1',
        path: terminalWorkingDirectory.path,
      });
    });
    expect(await screen.findByTitle(terminalWorkingDirectory.path)).toBeTruthy();
  });

  it('can pause terminal directory following', async () => {
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/first', sequence: 1 }}
      />,
    );

    const followToggle = await screen.findByTitle('Follow terminal directory');
    expect(followToggle.getAttribute('aria-pressed')).toBe('true');
    expect(followToggle.getAttribute('data-state')).toBe('on');

    fireEvent.click(followToggle);

    expect(followToggle.getAttribute('aria-pressed')).toBe('false');
    expect(followToggle.getAttribute('data-state')).toBe('off');
    expect(prefGet<boolean>('nexterm-follow-terminal-directory', true)).toBe(false);
    mocks.invoke.mockClear();

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-1"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/second', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(mocks.invoke).not.toHaveBeenCalledWith('list_files', {
        connectionId: 'conn-1',
        path: '/srv/second',
      });
    });
  });

  it('returns to the same terminal directory after manual navigation on the next prompt', async () => {
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-manual"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/app', sequence: 1 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/srv/app'),
      ).toHaveLength(1);
    });
    // Wait for the initial follow load to COMMIT (breadcrumb renders
    // '/srv/app') before clicking Home. On slow runners the click can land
    // while currentPath is still the initial '/home', making navigateTo
    // early-return and swallowing the click; the follow load then commits
    // '/srv/app' and the breadcrumb never shows '/home'.
    await screen.findByTitle('/srv/app');
    fireEvent.click(screen.getByTitle('Home'));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
        connectionId: 'conn-manual',
        path: '/home',
      });
    });
    // Wait for the Home navigation to fully commit (breadcrumb renders '/home')
    // before bumping the terminal sequence. Otherwise the follow effect can still
    // see committedPathRef === '/srv/app' and skip reloading, making this test
    // order-dependent on async timing.
    await screen.findByTitle('/home');

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-manual"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/srv/app', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/srv/app'),
      ).toHaveLength(2);
    });
  });

  it('keeps the last good directory and warns once when a terminal path is inaccessible', async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { path: string }) => {
      if (args.path === '/root/private') throw new Error('permission denied');
      return [];
    });
    const { rerender } = render(
      <IntegratedFileBrowser
        connectionId="conn-preserve"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/root/private', sequence: 1 }}
      />,
    );

    await waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
    expect(await screen.findByTitle('/home')).toBeTruthy();

    rerender(
      <IntegratedFileBrowser
        connectionId="conn-preserve"
        isConnected
        onClose={() => {}}
        terminalWorkingDirectory={{ path: '/root/private', sequence: 2 }}
      />,
    );

    await waitFor(() => {
      expect(
        mocks.invoke.mock.calls.filter(([, args]) => args.path === '/root/private'),
      ).toHaveLength(2);
    });
    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(await screen.findByTitle('/home')).toBeTruthy();
  });
});

describe('IntegratedFileBrowser directory download', () => {
  it('opens the recursive transfer dialog for a remote directory', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_files') {
        return [{
          name: 'release files',
          size: 0,
          modified: null,
          permissions: 'drwxr-xr-x',
          file_type: 'Directory',
        }];
      }
      return undefined;
    });
    mocks.open.mockResolvedValue('C:/Downloads');

    render(
      <IntegratedFileBrowser
        connectionId="conn-download"
        isConnected
        onClose={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download directory' }));

    expect(mocks.open).toHaveBeenCalledWith({ directory: true });
    expect((await screen.findByTestId('directory-transfer')).textContent).toBe(
      '/home/release files → C:/Downloads/release files',
    );
  });
});
