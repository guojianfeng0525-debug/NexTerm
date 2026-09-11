import React, { createContext, useContext, useReducer, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { TerminalGroupState, TerminalGroupAction, TerminalGroup, TerminalTab } from './terminal-group-types';
import { terminalGroupReducer, createDefaultState } from './terminal-group-reducer';
import { saveState, loadState, flushWorkspace } from './terminal-group-serializer';

/**
 * Disconnect the backend session for a closed tab (best-effort). Terminal tabs
 * need this too: PtyTerminal's cleanup only closes the PTY channel over the
 * WebSocket — the backend SSH connection itself stays open until ssh_disconnect.
 * Editor tabs borrow another tab's connection and tools tabs have no session,
 * so both are skipped.
 */
async function disconnectBackendSession(tab: TerminalTab): Promise<void> {
  try {
    if (tab.tabType === 'file-browser') {
      if (tab.protocol === 'SFTP') {
        await invoke('sftp_standalone_disconnect', { connection_id: tab.id });
      } else if (tab.protocol === 'FTP') {
        await invoke('ftp_disconnect', { connection_id: tab.id });
      }
    } else if (tab.tabType === 'desktop' || tab.protocol === 'VNC' || tab.protocol === 'RDP') {
      await invoke('desktop_disconnect', { connectionId: tab.id });
    } else if (tab.tabType === undefined || tab.tabType === 'terminal') {
      await invoke('ssh_disconnect', { connectionId: tab.id });
    }
  } catch {
    // The backend session may already be gone — closing must never block UI.
  }
}

interface TerminalGroupContextType {
  state: TerminalGroupState;
  dispatch: React.Dispatch<TerminalGroupAction>;
  /** 当前活动组 */
  activeGroup: TerminalGroup | null;
  /** 当前活动标签页 */
  activeTab: TerminalTab | null;
  /** 当前活动连接信息（驱动面板联动） */
  activeConnection: {
    connectionId: string;
    name: string;
    protocol: string;
    host?: string;
    username?: string;
    status: 'connected' | 'connecting' | 'disconnected' | 'pending';
  } | null;
}

const TerminalGroupContext = createContext<TerminalGroupContextType | null>(null);

/** Flatten every tab across every group, preserving group order. */
function collectTabs(state: TerminalGroupState): TerminalTab[] {
  return Object.values(state.groups).flatMap((g) => g.tabs);
}

function initializeState(): TerminalGroupState {
  const loaded = loadState();
  if (!loaded) return createDefaultState();

  // Reset all tabs to 'pending' — SSH sessions don't survive app restart.
  // This indicates the tab needs SSH connection to be established.
  // The restoreConnections effect in App.tsx will re-establish connections.
  const groups: Record<string, TerminalGroup> = {};
  const tabToGroupMap: Record<string, string> = {};
  
  for (const [id, group] of Object.entries(loaded.groups)) {
    groups[id] = {
      ...group,
      tabs: group.tabs.map((tab) => ({
        ...tab,
        connectionStatus: 'pending' as const,
      })),
    };
    for (const tab of group.tabs) {
      tabToGroupMap[tab.id] = id;
    }
  }
  return { ...loaded, groups, tabToGroupMap };
}

export function TerminalGroupProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(terminalGroupReducer, undefined, initializeState);

  const isInitialMount = useRef(true);
  const stateRef = useRef(state);
  const prevGroupCountRef = useRef(Object.keys(state.groups).length);

  // Keep the close-time snapshot current without touching SQLite after every
  // UI action. SQLite is rewritten once by the close-request handler below.
  useEffect(() => {
    stateRef.current = state;
    if (isInitialMount.current) {
      isInitialMount.current = false;
    }
  }, [state]);

  // Tauri delivers a cancellable close request, so we can persist the exact
  // final state before destroying the window. If persistence fails, closing
  // still wins: never trap the user in the app because of a storage error.
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const exitThroughWindow = async (): Promise<void> => {
      // `destroy` needs `core:window:allow-destroy`; if the capability is ever
      // dropped again (the 2.18.0 regression that made the app unclosable) or
      // the call fails for any other reason, fall back to process exit — the
      // process plugin and `process:allow-exit` are always available.
      try {
        await getCurrentWindow().destroy();
      } catch (error) {
        console.error('[workspace] window destroy failed, falling back to process exit:', error);
        const { exit } = await import('@tauri-apps/plugin-process');
        await exit(0);
      }
    };

    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      saveState(stateRef.current);
      // Bound the persistence so a wedged storage backend can never keep the
      // window open; the in-memory snapshot (saveState) is already durable
      // enough for the fallback path.
      try {
        await Promise.race([
          flushWorkspace(),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      } catch (error) {
        console.error('[workspace] close-time persistence failed:', error);
      }
      if (!disposed) await exitThroughWindow();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    saveState(state);
  }, [state]);

  // Disconnect backend sessions for closed tabs. All close paths (tab bar X,
  // context-menu close/others/left/right, Ctrl+W) go through the reducer, so
  // diffing the previous tab set catches every removal exactly once — even
  // when a dispatched batch removes several tabs at the same time.
  const prevTabsRef = useRef<TerminalTab[] | null>(null);
  useEffect(() => {
    const prevTabs = prevTabsRef.current;
    prevTabsRef.current = collectTabs(state);
    if (!prevTabs) return; // initial mount — nothing was closed
    const currentIds = new Set(Object.keys(state.tabToGroupMap));
    for (const tab of prevTabs) {
      if (!currentIds.has(tab.id)) {
        void disconnectBackendSession(tab);
      }
    }
  }, [state]);

  // When the number of groups changes (split/merge), fire window resize events
  // so all PtyTerminal instances refit to their new container dimensions.
  // Multiple staggered events ensure the terminal catches the final layout size
  // after react-resizable-panels finishes its CSS transitions.
  useEffect(() => {
    const groupCount = Object.keys(state.groups).length;
    if (groupCount !== prevGroupCountRef.current) {
      prevGroupCountRef.current = groupCount;
      const delays = [50, 150, 300];
      const timers = delays.map(ms =>
        setTimeout(() => window.dispatchEvent(new Event('resize')), ms)
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [state.groups]);

  const contextValue = useMemo(() => {
    const activeGroup = state.groups[state.activeGroupId] ?? null;
    const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
    const activeConnection = activeTab
      ? {
          connectionId: activeTab.id,
          name: activeTab.name,
          protocol: activeTab.protocol ?? '',
          host: activeTab.host,
          username: activeTab.username,
          status: activeTab.connectionStatus,
        }
      : null;

    return { state, dispatch, activeGroup, activeTab, activeConnection };
  }, [state]);

  return (
    <TerminalGroupContext.Provider value={contextValue}>
      {children}
    </TerminalGroupContext.Provider>
  );
}

export function useTerminalGroups(): TerminalGroupContextType {
  const context = useContext(TerminalGroupContext);
  if (!context) {
    throw new Error('useTerminalGroups must be used within a TerminalGroupProvider');
  }
  return context;
}
