/**
 * PostgreSQL SSH host-key TOFU (trust on first use) flow tests.
 *
 * tool-postgres.tsx pins the jump host fingerprint before opening the tunnel:
 *   1. no stored fingerprint → probe → trust dialog → save → connect
 *   2. stored fingerprint mismatch → a "retrust" action is offered
 *   3. clicking retrust re-probes and re-opens the trust dialog without the
 *      user having to edit sshHost / sshPort
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { ToolPostgres } from '../components/toolbox/tool-postgres';
import type { PostgreSQLConnectionProfile } from '../lib/database/postgresql-profile-adapter';
import { invoke } from '@tauri-apps/api/core';
import { PostgresConnectionsStorage } from '../lib/toolbox/postgres-storage';
import { toast } from 'sonner';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getConnections: vi.fn(() => []),
  },
}));

vi.mock('@/lib/toolbox/postgres-storage', () => ({
  PostgresConnectionsStorage: {
    load: vi.fn(),
    upsert: vi.fn(async () => true),
  },
}));

// CodeMirror is heavy and irrelevant to the TOFU flow — stub it out.
vi.mock('@/components/code-editor', () => ({
  CodeEditor: () => <textarea data-testid="code-editor-mock" readOnly />,
}));

const baseProfile: PostgreSQLConnectionProfile = {
  id: 'pg-1',
  name: 'Local PG',
  providerId: 'postgresql',
  environment: 'development',
  createdAt: 1,
  updatedAt: 1,
  providerConfig: {
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    password: 'secret',
    readOnly: false,
    autoCommit: true,
    sslMode: 'prefer',
    sshEnabled: true,
    sshHost: 'jump.example.com',
    sshPort: 22,
    sshUsername: 'jumpuser',
    sshAuthMethod: 'password',
    sshPassword: 'jumppass',
    sshHostKeyFingerprint: undefined,
  },
};

const NEW_FINGERPRINT = 'SHA256:newkey';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(PostgresConnectionsStorage.load).mockReturnValue([baseProfile]);
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'postgres_ssh_fingerprint':
        return { fingerprint: NEW_FINGERPRINT };
      case 'postgres_connect':
        return { serverVersion: '16.4' };
      case 'postgres_catalog_schemas':
        return ['public'];
      case 'postgres_catalog_search':
        return [];
      default:
        return undefined;
    }
  });
});

/** Open the connection dialog and press its primary Connect button (async flow wrapped in act). */
async function openDialogAndConnect() {
  fireEvent.click(screen.getByTestId('postgres-connect'));
  const dialog = screen.getByTestId('postgres-connection-dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
  });
}

function withStoredFingerprint(fingerprint: string): PostgreSQLConnectionProfile {
  return {
    ...baseProfile,
    providerConfig: { ...baseProfile.providerConfig, sshHostKeyFingerprint: fingerprint },
  };
}

describe('ToolPostgres SSH host-key TOFU', () => {
  it('probes the fingerprint, shows the trust dialog, and connects after trust', async () => {
    render(<ToolPostgres />);
    await openDialogAndConnect();

    // Trust dialog appears with the probed fingerprint.
    expect(await screen.findByText('Trust SSH server identity')).toBeTruthy();
    expect(screen.getByText(new RegExp(NEW_FINGERPRINT))).toBeTruthy();

    // No connection attempt happens before trust.
    expect(invoke).not.toHaveBeenCalledWith('postgres_connect', expect.anything());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    });

    // The fingerprint is saved and the connection request carries it.
    expect(invoke).toHaveBeenCalledWith(
      'postgres_connect',
      expect.objectContaining({
        request: expect.objectContaining({
          ssh: expect.objectContaining({ hostKeyFingerprint: NEW_FINGERPRINT }),
        }),
      }),
    );
    expect(PostgresConnectionsStorage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfig: expect.objectContaining({ sshHostKeyFingerprint: NEW_FINGERPRINT }),
      }),
    );
    // Connected state reached.
    expect(screen.getByTestId('postgres-disconnect')).toBeTruthy();
  });

  it('offers a retrust action when the stored fingerprint no longer matches', async () => {
    vi.mocked(PostgresConnectionsStorage.load).mockReturnValue([
      withStoredFingerprint('SHA256:stale'),
    ]);
    // The verified tunnel rejects with the Rust-side mismatch error.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'postgres_connect') {
        throw new Error(`host key fingerprint changed: SHA256:stale != ${NEW_FINGERPRINT}`);
      }
      return { fingerprint: NEW_FINGERPRINT };
    });

    render(<ToolPostgres />);
    await openDialogAndConnect();

    expect(toast.error).toHaveBeenCalledWith(
      'SSH host key fingerprint mismatch',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Retrust SSH host key' }),
      }),
    );
  });

  it('re-probes and re-opens the trust dialog when retrust is clicked', async () => {
    vi.mocked(PostgresConnectionsStorage.load).mockReturnValue([
      withStoredFingerprint('SHA256:stale'),
    ]);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'postgres_connect') {
        throw new Error(`host key fingerprint changed: SHA256:stale != ${NEW_FINGERPRINT}`);
      }
      return { fingerprint: NEW_FINGERPRINT };
    });

    render(<ToolPostgres />);
    await openDialogAndConnect();

    // Grab the retrust action from the mismatch toast.
    const mismatchCall = vi.mocked(toast.error).mock.calls.find(
      ([message]) => message === 'SSH host key fingerprint mismatch',
    );
    expect(mismatchCall).toBeDefined();
    const data = mismatchCall![1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(data.action?.label).toBe('Retrust SSH host key');

    // Clicking the action re-probes with the existing host/port.
    await act(async () => {
      data.action!.onClick();
    });

    expect(invoke).toHaveBeenCalledWith(
      'postgres_ssh_fingerprint',
      expect.objectContaining({
        request: { host: 'jump.example.com', port: 22 },
      }),
    );
    expect(await screen.findByText('Trust SSH server identity')).toBeTruthy();
    expect(screen.getByText(new RegExp(NEW_FINGERPRINT))).toBeTruthy();

    // Trusting the re-probed fingerprint connects with the new value.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    });
    expect(invoke).toHaveBeenCalledWith(
      'postgres_connect',
      expect.objectContaining({
        request: expect.objectContaining({
          ssh: expect.objectContaining({ hostKeyFingerprint: NEW_FINGERPRINT }),
        }),
      }),
    );
  });
});
