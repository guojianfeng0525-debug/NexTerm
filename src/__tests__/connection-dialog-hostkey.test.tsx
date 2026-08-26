/**
 * Regression tests for the in-app SSH host-key (TOFU) confirmation dialog.
 *
 * When connecting an SSH/SFTP server whose fingerprint is not yet stored, the
 * dialog probes the remote host key and asks the user to confirm it inside the
 * app (replacing the previous window.confirm). It must:
 *   - confirm → proceed with the probed fingerprint and connect
 *   - cancel  → abort the connection attempt
 *   - never hang forever (30s auto-cancel + unmount safety)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getValidFolders: vi.fn(() => [{ path: 'All Connections' }]),
    getConnections: vi.fn(() => []),
    updateConnection: vi.fn(() => null),
    saveConnectionWithId: vi.fn(() => null),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'ssh_host_key_fingerprint') return { fingerprint: 'SHA256:abc123' };
    if (cmd === 'ssh_connect') return { success: true };
    return undefined;
  });
});

function fillSshForm() {
  fireEvent.change(screen.getByLabelText('Connection Name'), {
    target: { value: 'Test Server' },
  });
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'example.com' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'root' } });
  // Password lives on the Auth tab.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Auth' }), { button: 0 });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
}

/** Locate the host-key confirmation dialog content (the only one holding the fingerprint). */
function getHostKeyPrompt(): HTMLElement {
  const description = screen.getByText(/Verify SSH server identity/);
  const dialog = description.closest('[data-slot="dialog-content"]');
  expect(dialog).not.toBeNull();
  return dialog as HTMLElement;
}

describe('ConnectionDialog host-key confirmation', () => {
  it('confirms the probed fingerprint and proceeds to connect', async () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={onConnect} />);

    fillSshForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    // The probe result is presented for confirmation.
    expect(await screen.findByText(/Verify SSH server identity/)).toBeTruthy();
    expect(screen.getByText(/SHA256:abc123/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(getHostKeyPrompt()).getByRole('button', { name: 'Confirm' }));
    });

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ hostKeyFingerprint: 'SHA256:abc123' }),
      );
    });
    // The accepted fingerprint is persisted before the tunnel is opened.
    expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.anything());
  });

  it('cancels the connection attempt when the user rejects the host key', async () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={onConnect} />);

    fillSshForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    });

    expect(await screen.findByText(/Verify SSH server identity/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(getHostKeyPrompt()).getByRole('button', { name: 'Cancel' }));
    });

    expect(onConnect).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('ssh_connect', expect.anything());
    // The prompt closes again.
    expect(screen.queryByText(/Verify SSH server identity/)).toBeNull();
  });

  it('auto-cancels the pending prompt after the 30s timeout instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const onConnect = vi.fn();
      render(<ConnectionDialog open onOpenChange={vi.fn()} onConnect={onConnect} />);

      fillSshForm();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/Verify SSH server identity/)).toBeTruthy();

      // Nothing has connected while the prompt is open.
      expect(onConnect).not.toHaveBeenCalled();

      // Advance past the auto-cancel timeout.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.queryByText(/Verify SSH server identity/)).toBeNull();
      expect(onConnect).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith('ssh_connect', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});
