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
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
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


import { ToolTopology } from '../components/toolbox/tool-topology';
import { makeNode } from '../lib/network/__tests__/fixtures';
import { FilePanel } from '../components/file-panel';
import { AlertDialog, AlertDialogContent, AlertDialogAction, AlertDialogTitle, AlertDialogDescription } from '../components/ui/alert-dialog';

const topology = vi.hoisted(() => ({ nodes: [] as any[], remove: vi.fn() }));
vi.mock('../lib/network/topology-storage', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, listNodes: () => topology.nodes, listLinks: () => [], subscribeTopology: () => () => {},
    getNodeInterfaces: () => [], getNodePorts: () => [], removeNodes: (ids: string[]) => topology.remove(ids) };
});
vi.mock('../components/network/topology-node-dialog', () => ({ TopologyNodeDialog: () => null }));
vi.mock('../components/network/link-editor-dialog', () => ({ LinkEditorDialog: () => null }));
vi.mock('../components/network/port-topology', () => ({ PortTopologyView: () => null }));

const listing = [
  { name: 'alpha.txt', file_type: 'File', size: 1, modified: null, permissions: null },
  { name: 'release  files', file_type: 'Directory', size: 0, modified: null, permissions: null },
];
let sequence = 0;
async function prepare(active = true) {
  const id = `delete-safety-${++sequence}`;
  mocks.invoke.mockImplementation(async (command: string) => command === 'list_files' ? listing : true);
  const props = { connectionId: id, host: 'server-a', isConnected: true, isActive: active, onClose: () => {},
    terminalWorkingDirectory: { path: '/srv/app/logs', sequence: 1 } };
  const view = render(<><IntegratedFileBrowser {...props} /><svg data-testid="foreign-page" tabIndex={0} /></>);
  await screen.findByTitle(active ? '/srv/app/logs' : '/home');
  return { ...view, props };
}
function select(name = 'alpha.txt') { fireEvent.click(screen.getByText(name), { ctrlKey: true }); }
function press(key = 'Delete', target: Element = screen.getByTestId('ssh-file-workspace'), flags = {}) {
  fireEvent.keyDown(target, { key, ...flags });
}
function deletes() { return mocks.invoke.mock.calls.filter(([command]) => command === 'delete_file'); }
function confirm() { fireEvent.click(screen.getByRole('button', { name: /^Delete \d+ items?$/ })); }

// Network IPC is mocked. No test can delete a real server file.
describe('File deletion ownership and immutable confirmation', () => {
  it('ignores Delete and select-all originating on another page', async () => {
    await prepare(); select();
    press('Delete', screen.getByTestId('foreign-page'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    press('Escape');
    press('a', screen.getByTestId('foreign-page'), { ctrlKey: true });
    press();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deletes()).toHaveLength(0);
  });
  it.each([{ isActive: false }, { hidden: true }])('ignores hidden/inactive file workspaces: %j', async flags => {
    const view = await prepare(!('isActive' in flags)); select();
    if ('hidden' in flags) screen.getByTestId('ssh-file-workspace').style.display = 'none';
    press(); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(deletes()).toHaveLength(0);
    view.unmount();
  });
  it('excludes parent navigation from selection and deletion', async () => {
    await prepare(); select('..'); press();
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(deletes()).toHaveLength(0);
  });
  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }])('ignores modified/repeating/composing Delete: %j', async flags => {
    await prepare(); select(); press('Delete', screen.getByTestId('ssh-file-workspace'), flags);
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(deletes()).toHaveLength(0);
  });
  it('ignores an already-handled event', async () => {
    await prepare(); select();
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    event.preventDefault(); fireEvent(screen.getByTestId('ssh-file-workspace'), event);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('leaves an unrelated modal in control of the keyboard', async () => {
    await prepare(); select();
    render(<AlertDialog open><AlertDialogContent><AlertDialogTitle>Other action</AlertDialogTitle><AlertDialogDescription>Other action</AlertDialogDescription><AlertDialogAction data-testid="other-action">Continue</AlertDialogAction></AlertDialogContent></AlertDialog>);
    press('Delete', screen.getByTestId('other-action'));
    press(); // Even synthetic events on the background panel must be ignored.
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1); expect(deletes()).toHaveLength(0);
  });
  it('an older file confirmation cannot execute while another modal owns focus', async () => {
    await prepare(); select(); press();
    const oldConfirm = screen.getByRole('button', { name: 'Delete 1 item' });
    render(<AlertDialog open><AlertDialogContent><AlertDialogTitle>Newer dialog</AlertDialogTitle><AlertDialogDescription>Newer operation</AlertDialogDescription><AlertDialogAction data-testid="newer-action">Continue</AlertDialogAction></AlertDialogContent></AlertDialog>);
    screen.getByTestId('newer-action').focus(); fireEvent.click(oldConfirm);
    expect(deletes()).toHaveLength(0);
  });
  it('shows server and full paths, then deletes exactly the confirmed batch', async () => {
    const { props } = await prepare(); press('a', undefined, { ctrlKey: true }); press();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('server-a');
    expect(dialog.textContent).toContain('/srv/app/logs/alpha.txt');
    expect(dialog.textContent).toContain('/srv/app/logs/release  files');
    expect(dialog.textContent).not.toContain('/srv/app/logs/..');
    expect(deletes()).toHaveLength(0); confirm();
    await waitFor(() => expect(deletes()).toHaveLength(2));
    expect(deletes().map(([, args]) => args)).toEqual([
      { connectionId: props.connectionId, path: '/srv/app/logs/alpha.txt', parentPath: '/srv/app/logs', isDirectory: false },
      { connectionId: props.connectionId, path: '/srv/app/logs/release  files', parentPath: '/srv/app/logs', isDirectory: true },
    ]);
  });
  it('cancel never sends a deletion request', async () => {
    await prepare(); select(); press(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deletes()).toHaveLength(0);
  });
  it.each(['connection', 'page', 'directory'])('invalidates confirmation when %s changes', async change => {
    const { props, rerender } = await prepare(); select(); press();
    const oldConfirm = screen.getByRole('button', { name: 'Delete 1 item' });
    rerender(<IntegratedFileBrowser {...props} connectionId={change === 'connection' ? 'replacement-server' : props.connectionId}
      isActive={change !== 'page'} terminalWorkingDirectory={{ path: change === 'directory' ? '/srv/other' : '/srv/app/logs', sequence: 2 }} />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(oldConfirm); expect(deletes()).toHaveLength(0);
  });
  it('rejects confirmation immediately when its ancestor is hidden', async () => {
    await prepare(); select(); press(); const button = screen.getByRole('button', { name: 'Delete 1 item' });
    screen.getByTestId('ssh-file-workspace').style.display = 'none';
    fireEvent.click(button); expect(deletes()).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
  it('does not duplicate deletion while a request is in flight', async () => {
    await prepare(); let resolve!: (value: boolean) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'delete_file' ? new Promise(r => { resolve = r; }) : Promise.resolve(listing));
    select(); press(); const button = screen.getByRole('button', { name: 'Delete 1 item' }); fireEvent.click(button); fireEvent.click(button); expect(deletes()).toHaveLength(1);
    resolve(true); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
  it('stops the rest of a batch after changing servers', async () => {
    const { props, rerender } = await prepare(); let resolve!: (value: boolean) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'delete_file' ? new Promise(r => { resolve = r; }) : Promise.resolve(listing));
    press('a', undefined, { ctrlKey: true }); press(); confirm(); expect(deletes()).toHaveLength(1);
    rerender(<IntegratedFileBrowser {...props} connectionId="server-b" />); resolve(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes()).toHaveLength(1); expect(deletes()[0][1].connectionId).toBe(props.connectionId);
  });
  it('keeps focus in the filename input while renaming', async () => {
    await prepare(); select(); press('F2');
    const input = screen.getByDisplayValue('alpha.txt');
    fireEvent.click(input); expect(document.activeElement).toBe(input);
  });
  it('keeps intentional in-page copy/paste working across directories', async () => {
    const { props, rerender } = await prepare(); select(); press('c', undefined, { ctrlKey: true });
    rerender(<IntegratedFileBrowser {...props} terminalWorkingDirectory={{ path: '/srv/destination', sequence: 2 }} />);
    await screen.findByTitle('/srv/destination'); press('v', undefined, { ctrlKey: true });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('copy_file', {
      connectionId: props.connectionId, sourcePath: '/srv/app/logs/alpha.txt', destPath: '/srv/destination/alpha.txt',
    }));
  });
  it('queued uploads retain their original server after switching connections', async () => {
    const { props, rerender } = await prepare(); let resolve!: (value: { success: boolean }) => void;
    let uploadCount = 0;
    mocks.invoke.mockImplementation((command: string, args: { paths: string[] }) => {
      if (command === 'list_files') return Promise.resolve(listing);
      if (command === 'inspect_remote_uploads') return Promise.resolve((args.paths as string[]).map(path => ({ path, version: null })));
      if (command === 'upload_remote_file') {
        uploadCount++;
        return uploadCount === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve({ success: true });
      }
      return Promise.resolve(true);
    });
    mocks.open.mockResolvedValue(['/local/first.txt', '/local/second.txt']);
    fireEvent.click(screen.getByTitle('Upload files'));
    await waitFor(() => expect(uploadCount).toBe(1));
    rerender(<IntegratedFileBrowser {...props} connectionId="upload-server-b" />);
    resolve({ success: true });
    await waitFor(() => expect(uploadCount).toBe(2));
    const uploads = mocks.invoke.mock.calls.filter(([command]) => command === 'upload_remote_file');
    expect(uploads.map(([, args]) => args.connectionId)).toEqual([props.connectionId, props.connectionId]);
  });
  it('real topology Delete opens only its own confirmation and changes only topology data', async () => {
    const view = await prepare(false); select();
    topology.nodes = [makeNode({ id: 'node-a', hostname: 'audit-host', displayName: 'audit-host' })]; topology.remove.mockClear();
    view.rerender(<><IntegratedFileBrowser {...view.props} isActive={false} /><ToolTopology /></>);
    const canvas = await screen.findByRole('application');
    const node = canvas.querySelector('[tabindex="0"]')!;
    fireEvent(node, new MouseEvent('pointerdown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => expect(node.getAttribute('data-selected')).toBe('true'));
    press('Delete', canvas); expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog').textContent).toContain('audit-host');
    fireEvent.click(screen.getByTestId('topology-delete-selected-confirm'));
    expect(topology.remove).toHaveBeenCalledWith(['node-a']); expect(deletes()).toHaveLength(0);
  });
});

describe('Independent file-panel confirmation', () => {
  it('requires confirmation with the remote host and full path', async () => {
    const operation = vi.fn().mockResolvedValue(undefined);
    render(<FilePanel mode="remote" label="ftp-host" isActive initialPath="/srv/app"
      onFocus={() => {}} onLoadDirectory={async () => listing} onDelete={operation} />);
    await screen.findByText('alpha.txt');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(operation).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toContain('ftp-host');
    expect(screen.getByRole('alertdialog').textContent).toContain('/srv/app/release  files');
    confirm(); await waitFor(() => expect(operation).toHaveBeenCalledWith('/srv/app/release  files', true));
  });
  it('rejects a stale confirmation after the operation owner changes', async () => {
    const first = vi.fn(); const second = vi.fn(); const load = vi.fn().mockResolvedValue(listing);
    const props = { mode: 'remote' as const, label: 'ftp-host', isActive: true, initialPath: '/srv/app', onFocus: () => {}, onLoadDirectory: load };
    const view = render(<FilePanel {...props} onDelete={first} />); await screen.findByText('alpha.txt');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    const oldConfirm = screen.getByRole('button', { name: 'Delete 1 item' });
    view.rerender(<FilePanel {...props} onDelete={second} />); fireEvent.click(oldConfirm);
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });
});
