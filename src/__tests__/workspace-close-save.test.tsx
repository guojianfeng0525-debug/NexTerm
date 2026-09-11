import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TerminalTab } from '../lib/terminal-group-types';

const tauri = vi.hoisted(() => {
  const db: Record<string, unknown[]> = {};
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'row_list') return [...(db[String(args?.table)] ?? [])];
    if (command === 'workspace_replace') {
      const request = args?.request as Record<string, unknown[]>;
      db.workspace_meta = request.meta ? [request.meta] : [];
      db.workspace_groups = [...(request.groups ?? [])];
      db.workspace_tabs = [...(request.tabs ?? [])];
      db.workspace_grid_nodes = [...(request.gridNodes ?? [])];
      return undefined;
    }
    return undefined;
  });
  const closeHandlers: Array<(event: { preventDefault(): void }) => Promise<void> | void> = [];
  const destroy = vi.fn();
  const processExit = vi.fn();
  return { db, invoke, closeHandlers, destroy, processExit };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: { preventDefault(): void }) => Promise<void> | void) => {
      tauri.closeHandlers.push(handler);
      return () => undefined;
    },
    destroy: tauri.destroy,
  }),
}));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: tauri.processExit }));

import { TerminalGroupProvider, useTerminalGroups } from '../lib/terminal-group-context';
import {
  hydrateWorkspace,
  resetWorkspaceCache,
  saveState,
  loadState,
} from '../lib/terminal-group-serializer';
import { createDefaultState } from '../lib/terminal-group-reducer';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

function Harness() {
  const { dispatch } = useTerminalGroups();
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: 'UPDATE_TAB_STATUS', tabId: 'tab-1', status: 'connected' })}
    >
      update
    </button>
  );
}

describe('TerminalGroupProvider — save workspace at close', () => {
  beforeEach(async () => {
    for (const key of Object.keys(tauri.db)) delete tauri.db[key];
    tauri.invoke.mockClear();
    tauri.closeHandlers.length = 0;
    tauri.destroy.mockClear();
    tauri.processExit.mockClear();
    tauri.destroy.mockResolvedValue(undefined);
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    resetWorkspaceCache();
    await hydrateWorkspace();
  });

  it('stages reducer changes and persists only when close is requested', async () => {
    const tab: TerminalTab = {
      id: 'tab-1',
      name: 'Server',
      connectionStatus: 'connecting',
      reconnectCount: 0,
    };
    const seeded = createDefaultState();
    const groupId = seeded.activeGroupId;
    seeded.groups[groupId] = { id: groupId, tabs: [tab], activeTabId: tab.id };
    seeded.tabToGroupMap = { [tab.id]: groupId };
    saveState(seeded);

    const container = document.createElement('div');
    document.body.appendChild(container);
    let finished = false;
    await act(async () => {
      createRoot(container).render(
        <TerminalGroupProvider>
          <Harness />
        </TerminalGroupProvider>,
      );
      await Promise.resolve();
      finished = true;
    });
    expect(finished).toBe(true);
    expect(tauri.closeHandlers).toHaveLength(1);

    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(loadState()?.groups[groupId]?.tabs[0]?.connectionStatus).toBe('connected');
    expect(tauri.db.workspace_tabs).toBeUndefined();

    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await tauri.closeHandlers[0]?.(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(tauri.destroy).toHaveBeenCalled();
    expect(tauri.db.workspace_tabs).toHaveLength(1);
    expect(tauri.db.workspace_meta).toEqual([
      expect.objectContaining({ active_group_id: groupId }),
    ]);

    document.body.removeChild(container);
  });

  it('falls back to process exit when the window destroy capability is missing', async () => {
    // Regression guard for the 2.18.0 unclosable-app bug: `destroy` was never
    // in `core:window:*` capabilities, so its rejection left the window open
    // forever. The handler must now route through plugin-process instead.
    tauri.destroy.mockRejectedValue(new Error('window.destroy not allowed'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(
        <TerminalGroupProvider>
          <Harness />
        </TerminalGroupProvider>,
      );
      await Promise.resolve();
    });

    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await tauri.closeHandlers[0]?.(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(tauri.destroy).toHaveBeenCalled();
    expect(tauri.processExit).toHaveBeenCalledWith(0);

    document.body.removeChild(container);
  });

  it('still closes when persistence hangs (3s bound)', async () => {
    vi.useFakeTimers();
    try {
      tauri.invoke.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      );

      const container = document.createElement('div');
      document.body.appendChild(container);
      await act(async () => {
        createRoot(container).render(
          <TerminalGroupProvider>
            <Harness />
          </TerminalGroupProvider>,
        );
        await Promise.resolve();
      });

      const event = { preventDefault: vi.fn() };
      const closeRun = act(async () => {
        await tauri.closeHandlers[0]?.(event);
      });
      // The persistence promise never resolves within the bound; the race
      // timer must fire and let the close proceed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      await closeRun;

      expect(tauri.destroy).toHaveBeenCalled();

      document.body.removeChild(container);
    } finally {
      vi.useRealTimers();
    }
  });
});
