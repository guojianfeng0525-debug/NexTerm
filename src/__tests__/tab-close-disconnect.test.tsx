import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TerminalTab } from '../lib/terminal-group-types';

/**
 * P1-1 regression: closing a tab must disconnect the backend session.
 * TerminalGroupProvider diffs the tab set between renders and calls
 * disconnectBackendSession for every removed tab. The mapping below is the
 * contract under test (module-level function in terminal-group-context.tsx).
 */

// Mock the Tauri bridge so the context module can be imported in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === '__unknown__') throw new Error('unknown command');
    return undefined;
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { TerminalGroupProvider, useTerminalGroups } from '../lib/terminal-group-context';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createDefaultState } from '../lib/terminal-group-reducer';

function baseTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    name: 'Server',
    connectionStatus: 'connected',
    reconnectCount: 0,
    ...overrides,
  };
}

function Probe({ remove }: { remove: () => void }) {
  return (
    <button
      data-testid="remove"
      onClick={() => remove()}
    >
      remove
    </button>
  );
}

describe('TerminalGroupProvider tab-close disconnect wiring', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it('invokes the protocol-appropriate disconnect command when a tab is removed', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    let dispatchFn: ((action: unknown) => void) | null = null;
    function Harness() {
      const { state, dispatch } = useTerminalGroups();
      dispatchFn = dispatch;
      return <Probe remove={() => dispatch({ type: 'REMOVE_TAB', groupId: state.activeGroupId, tabId: 'sftp-tab' })} />;
    }

    // Seed the store cache so initializeState picks up our tabs.
    const { saveState, resetWorkspaceCache } = await import('../lib/terminal-group-serializer');
    const defaultState = createDefaultState();
    const groupId = defaultState.activeGroupId;
    const seeded = {
      ...defaultState,
      groups: {
        ...defaultState.groups,
        [groupId]: {
          ...defaultState.groups[groupId],
          tabs: [
            baseTab({ id: 'ssh-tab', tabType: undefined }),
            baseTab({ id: 'sftp-tab', tabType: 'file-browser', protocol: 'SFTP' }),
            baseTab({ id: 'ftp-tab', tabType: 'file-browser', protocol: 'FTP' }),
            baseTab({ id: 'rdp-tab', tabType: 'desktop', protocol: 'RDP' }),
          ],
          activeTabId: 'sftp-tab',
        },
      },
      tabToGroupMap: { 'ssh-tab': groupId, 'sftp-tab': groupId, 'ftp-tab': groupId, 'rdp-tab': groupId },
    };
    saveState(seeded as typeof defaultState);

    await act(async () => {
      createRoot(container).render(
        <TerminalGroupProvider>
          <Harness />
        </TerminalGroupProvider>,
      );
    });

    // Initial mount — no disconnects yet.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    // Close the SFTP tab.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remove"]')!.click();
    });
    // Flush the fire-and-forget disconnect promise.
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('sftp_standalone_disconnect', { connection_id: 'sftp-tab' });

    resetWorkspaceCache();
    container.remove();
    dispatchFn = null;
  });
});
