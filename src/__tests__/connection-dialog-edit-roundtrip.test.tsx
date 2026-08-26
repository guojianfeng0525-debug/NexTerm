/**
 * Regression tests: editing a saved SSH connection and toggling advanced
 * keepalive options must survive a save → re-open round-trip.
 *
 * Uses the real ConnectionStorageManager in-memory cache, so it exercises the
 * same storage path as the desktop app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionDialog, type ConnectionConfig } from '../components/connection-dialog';
import { ConnectionStorageManager, type ConnectionData } from '../lib/connection-storage';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

/** Mirror of App.tsx's toConnectionConfig: stored ConnectionData → dialog config. */
function toConfig(data: ConnectionData): ConnectionConfig {
  return {
    id: data.id,
    name: data.name,
    protocol: data.protocol as ConnectionConfig['protocol'],
    host: data.host,
    port: data.port,
    username: data.username,
    authMethod: data.authMethod || 'password',
    password: data.password,
    privateKeyPath: data.privateKeyPath,
    passphrase: data.passphrase,
    proxyType: data.proxyType,
    proxyHost: data.proxyHost,
    proxyPort: data.proxyPort,
    proxyUsername: data.proxyUsername,
    proxyPassword: data.proxyPassword,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}

beforeEach(() => {
  localStorage.clear();
});

async function switchToAdvancedTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Advanced' }), { button: 0 });
}

describe('edit advanced options round-trip (real storage)', () => {
  it('keepalive interval edit survives save → re-open', async () => {
    ConnectionStorageManager.saveConnectionWithId('c1', {
      name: 'My Server',
      host: 'example.com',
      port: 22,
      username: 'root',
      protocol: 'SSH',
      authMethod: 'password',
      keepAlive: true,
      keepAliveInterval: 60,
      serverAliveCountMax: 3,
    });

    const editing = toConfig(ConnectionStorageManager.getConnection('c1')!);

    const { unmount } = render(
      <ConnectionDialog
        open
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={editing}
      />,
    );
    await switchToAdvancedTab();
    const intervalInput = screen.getByLabelText('Interval (seconds)');
    fireEvent.change(intervalInput, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    unmount();

    expect(ConnectionStorageManager.getConnection('c1')?.keepAliveInterval).toBe(30);
  });
});
