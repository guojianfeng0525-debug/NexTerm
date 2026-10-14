import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channel } from '@tauri-apps/api/core';
import { useUploadPlanner, type UploadProgress } from '@/components/use-upload-planner';
import type { UploadQueueInput } from '@/lib/upload-paths';
import { validateUploadTargets } from '@/lib/upload-conflicts';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), resolved: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage = () => {}; } }));

const fileVersion = { kind: 'File', size: 10, modified: '2026-10-14 10:00:00' };
const items: UploadQueueInput[] = ['a.txt', 'b.txt', 'c.txt'].map(name => ({
  connectionId: 'server-a', fileName: name, direction: 'upload', sourcePath: `/local/${name}`, destinationPath: `/remote/${name}`, totalBytes: 12,
}));

function Harness({ active = true, connected = true, connectionId = 'server-a' }: { active?: boolean; connected?: boolean; connectionId?: string }) {
  const [result, setResult] = useState('');
  const [controller, setController] = useState<AbortController | null>(null);
  const { planUploads, upload, conflictDialog } = useUploadPlanner({ connectionId, label: connectionId, active, connected, canOperate: () => active });
  const save = (value: unknown) => { mocks.resolved(value); setResult(JSON.stringify(value)); };
  return <>
    <button onClick={() => { const abort = new AbortController(); setController(abort); void planUploads(items, abort.signal).then(save).catch(error => save(String(error))); }}>Plan</button>
    <button onClick={() => { const abort = new AbortController(); setController(abort); void upload(items[0], 'transfer-1', new Channel<UploadProgress>(), abort.signal).then(save); }}>Transfer</button>
    <button onClick={() => controller?.abort()}>Abort</button>
    <output data-testid="result">{result}</output>{conflictDialog}
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (command: string, args: { paths?: string[] }) => {
    if (command === 'inspect_remote_uploads') return args.paths?.map(path => ({ path, version: path.endsWith('a.txt') ? fileVersion : path.endsWith('b.txt') ? { ...fileVersion, kind: 'Directory' } : null }));
    if (command === 'stat_local_path') return { exists: true, size: 12, modified: '2026-10-14 11:00:00' };
    return { success: true };
  });
});
afterEach(cleanup);

describe('upload conflict business rules', () => {
  it('groups conflicts, defaults to skip, and never authorizes replacing a directory', async () => {
    render(<Harness />); fireEvent.click(screen.getByText('Plan'));
    const dialog = await screen.findByRole('alertdialog');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    const selects = dialog.querySelectorAll('select');
    expect(selects).toHaveLength(3);
    expect(selects[1].value).toBe('skip');
    expect(selects[2].querySelector('option[value="replace"]')).toHaveProperty('disabled', true);
    fireEvent.change(selects[0], { target: { value: 'replace' } });
    expect(selects[1].value).toBe('replace'); expect(selects[2].value).toBe('skip');
    fireEvent.change(selects[2], { target: { value: 'keep-both' } });
    fireEvent.click(screen.getByText('Continue upload'));
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalled());
    const planned = mocks.resolved.mock.calls[0][0] as UploadQueueInput[];
    expect(planned[0]).toMatchObject({ conflictPolicy: 'replace', expectedTarget: fileVersion });
    expect(planned[1]).toMatchObject({ conflictPolicy: 'keep-both' });
    expect(planned[1].expectedTarget).toBeUndefined();
    expect(planned[2]).toMatchObject({ conflictPolicy: 'ask', destinationPath: '/remote/c.txt' });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'upload_remote_file')).toHaveLength(0);
  });

  it('cancels without uploading and preserves skip as a decision', async () => {
    render(<Harness />); fireEvent.click(screen.getByText('Plan'));
    await screen.findByRole('alertdialog'); fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledWith(null));
    fireEvent.click(screen.getByText('Plan')); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Continue upload'));
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledTimes(2));
    const planned = mocks.resolved.mock.calls[1][0] as UploadQueueInput[];
    expect(planned[0].skip).toBe(true); expect(planned[1].skip).toBe(true); expect(planned[2].skip).toBe(false);
  });

  it('retains hidden pending requests without approving or changing their destination', async () => {
    const view = render(<Harness />); fireEvent.click(screen.getByText('Plan')); await screen.findByRole('alertdialog');
    view.rerender(<Harness active={false} />);
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(mocks.resolved).not.toHaveBeenCalled();
    view.rerender(<Harness active />); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Continue upload'));
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalled());
    expect((mocks.resolved.mock.calls[0][0] as UploadQueueInput[]).map(item => item.destinationPath)).toEqual(items.map(item => item.destinationPath));
  });

  it('cancels pending approvals on disconnect instead of carrying them into a new session', async () => {
    const view = render(<Harness />); fireEvent.click(screen.getByText('Plan')); await screen.findByRole('alertdialog');
    view.rerender(<Harness connected={false} />);
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledWith(null));
    view.rerender(<Harness connected />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('expires approval when its connection changes', async () => {
    const view = render(<Harness />); fireEvent.click(screen.getByText('Plan')); await screen.findByRole('alertdialog');
    view.rerender(<Harness connectionId="server-b" />);
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledWith(null));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('aborting a waiting transfer closes its confirmation and does not retry', async () => {
    mocks.invoke.mockImplementation(async (command: string, args: { paths?: string[] }) => {
      if (command === 'upload_remote_file') return { success: false, conflict: { path: '/remote/a.txt', version: fileVersion } };
      if (command === 'inspect_remote_uploads') return args.paths?.map(path => ({ path, version: fileVersion }));
      return { exists: true, size: 12 };
    });
    render(<Harness />); fireEvent.click(screen.getByText('Transfer')); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Abort'));
    await waitFor(() => expect(mocks.resolved).toHaveBeenCalledWith({ success: false, cancelled: true }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'upload_remote_file')).toHaveLength(1);
  });

  it('requests fresh approval when the backend observes a changed target', async () => {
    let uploads = 0;
    const changed = { ...fileVersion, size: 99 };
    mocks.invoke.mockImplementation(async (command: string, args: { paths?: string[] }) => {
      if (command === 'upload_remote_file') return ++uploads === 1 ? { success: false, conflict: { path: '/remote/a.txt', version: changed } } : { success: true };
      if (command === 'inspect_remote_uploads') return args.paths?.map(path => ({ path, version: changed }));
      return { exists: true, size: 12 };
    });
    render(<Harness />); fireEvent.click(screen.getByText('Transfer')); const dialog = await screen.findByRole('alertdialog');
    expect(uploads).toBe(1);
    fireEvent.change(dialog.querySelectorAll('select')[1], { target: { value: 'replace' } });
    fireEvent.click(screen.getByText('Continue upload'));
    await waitFor(() => expect(uploads).toBe(2));
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === 'upload_remote_file');
    expect(calls[0][1]).toMatchObject({ conflictPolicy: 'ask', expectedTarget: null });
    expect(calls[1][1]).toMatchObject({ conflictPolicy: 'replace', expectedTarget: changed });
  });

  it('fails closed for malformed or mismatched inspection results', () => {
    expect(() => validateUploadTargets(undefined, ['/remote/a'])).toThrow();
    expect(() => validateUploadTargets([{ path: '/other', version: null }], ['/remote/a'])).toThrow();
    expect(() => validateUploadTargets([{ path: '/remote/a', version: { ...fileVersion, size: -1 } }], ['/remote/a'])).toThrow();
  });
});
