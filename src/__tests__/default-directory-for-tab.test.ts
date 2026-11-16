import { beforeEach, describe, expect, it, vi } from 'vitest';

// The portals module imports heavy components (PtyTerminal, DesktopViewer);
// only the pure defaultDirectoryForTab helper is under test here.
vi.mock('../components/pty-terminal', () => ({ PtyTerminal: () => null }));
vi.mock('../components/desktop-viewer', () => ({ DesktopViewer: () => null }));
vi.mock('../components/file-browser-view', () => ({ FileBrowserView: () => null }));
vi.mock('../components/file-editor-view', () => ({ FileEditorView: () => null }));

const getConnection = vi.fn();
vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: { getConnection: (...args: unknown[]) => getConnection(...args) },
}));

import { defaultDirectoryForTab } from '../components/terminal/terminal-tab-portals';
import type { TerminalTab } from '../lib/terminal-group-types';

const baseTab: TerminalTab = {
  id: 'conn-1',
  name: 'server',
  connectionStatus: 'connected',
  reconnectCount: 0,
};

describe('defaultDirectoryForTab', () => {
  beforeEach(() => {
    getConnection.mockReset();
  });

  it('prefers the pre-disconnect working directory over the connection default', () => {
    getConnection.mockReturnValue({ defaultDirectory: '/home/user', terminalStartupMode: 'default' });
    expect(defaultDirectoryForTab({ ...baseTab, lastWorkingDirectory: '/srv/deep/work' })).toBe('/srv/deep/work');
  });

  it('falls back to the connection default when no capture exists', () => {
    getConnection.mockReturnValue({ defaultDirectory: '/home/user', terminalStartupMode: 'default' });
    expect(defaultDirectoryForTab({ ...baseTab })).toBe('/home/user');
  });

  it('returns undefined when startup mode is disabled and nothing was captured', () => {
    getConnection.mockReturnValue({ defaultDirectory: '/home/user', terminalStartupMode: 'disabled' });
    expect(defaultDirectoryForTab({ ...baseTab })).toBeUndefined();
  });

  it('the capture still wins when startup mode is disabled — it is a session restore, not a startup default', () => {
    getConnection.mockReturnValue({ defaultDirectory: '/home/user', terminalStartupMode: 'disabled' });
    expect(defaultDirectoryForTab({ ...baseTab, lastWorkingDirectory: '/var/log' })).toBe('/var/log');
  });

  it('resolves the connection through originalConnectionId for duplicate tabs', () => {
    getConnection.mockReturnValue({ defaultDirectory: '/opt/work' });
    expect(defaultDirectoryForTab({ ...baseTab, originalConnectionId: 'origin-9' })).toBe('/opt/work');
    expect(getConnection).toHaveBeenCalledWith('origin-9');
  });
});
