import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { applyLanguageFromPreference } from './lib/i18n';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MenuBar } from './components/menu-bar';
import { LogMonitor, LogMonitorStateProvider } from './components/log-monitor';
import { StatusBar } from './components/status-bar';
import { ConnectionDialog, ConnectionConfig } from './components/connection-dialog';
import { SettingsModal } from './components/settings-modal';
import { IntegratedFileBrowser } from './components/integrated-file-browser';
import { toConnectionConfig } from './lib/connection-config';
import { ActiveConnectionsManager, ConnectionStorageManager } from './lib/connection-storage';
import { isDesktopProtocol } from './lib/protocol-config';
import { buildSftpConnectRequest, buildSshConnectRequest } from './lib/ssh-connect-request';
import { registerRestoration, clearAllRestorations } from './lib/restoration-manager';
import { useLayout, LayoutProvider } from './lib/layout-context';
import {
  APP_SETTINGS_CHANGED_EVENT,
  createLayoutShortcuts,
  createSplitViewShortcuts,
  loadKeyboardShortcutSettings,
  useKeyboardShortcuts,
} from './lib/keyboard-shortcuts';
import type { SplitViewShortcutBindings } from './lib/keyboard-shortcuts';
import { TerminalGroupProvider, useTerminalGroups } from './lib/terminal-group-context';
import { TerminalCallbacksProvider } from './lib/terminal-callbacks-context';
import { GridRenderer } from './components/terminal/grid-renderer';
import { ToolboxNav, type WorkspaceSection } from './components/toolbox/toolbox-nav';
import { AppLockScreen } from './components/toolbox/app-lock-screen';
// Tool views are code-split (React.lazy) so their heavyweight dependencies
// (codemirror, sql-formatter, xlsx, …) load on demand instead of inflating the
// main entry. Views stay mounted once resolved (hidden via CSS), so internal
// state such as the vault unlock persists across section switches.
const ServersView = lazy(() => import('./components/toolbox/servers-view').then((m) => ({ default: m.ServersView })));
const ToolApps = lazy(() => import('./components/toolbox/tool-apps').then((m) => ({ default: m.ToolApps })));
const ToolVault = lazy(() => import('./components/toolbox/tool-vault').then((m) => ({ default: m.ToolVault })));
const ToolTunnels = lazy(() => import('./components/toolbox/tool-tunnels').then((m) => ({ default: m.ToolTunnels })));
const ToolServices = lazy(() => import('./components/toolbox/tool-services').then((m) => ({ default: m.ToolServices })));
const ToolNotes = lazy(() => import('./components/toolbox/tool-notes').then((m) => ({ default: m.ToolNotes })));
const ToolCommandHistory = lazy(() => import('./components/toolbox/tool-command-history').then((m) => ({ default: m.ToolCommandHistory })));
const ToolDocuments = lazy(() => import('./components/toolbox/tool-documents').then((m) => ({ default: m.ToolDocuments })));
const ToolApiDebug = lazy(() => import('./components/toolbox/tool-api-debug').then((m) => ({ default: m.ToolApiDebug })));
const ToolPostgres = lazy(() => import('./components/toolbox/tool-postgres').then((m) => ({ default: m.ToolPostgres })));
const ToolSqlite = lazy(() => import('./components/toolbox/tool-sqlite').then((m) => ({ default: m.ToolSqlite })));
const ToolMySql = lazy(() => import('./components/toolbox/tool-mysql').then((m) => ({ default: m.ToolMySql })));
const ToolJarDecompiler = lazy(() => import('./components/toolbox/tool-jar-decompiler').then((m) => ({ default: m.ToolJarDecompiler })));
import { ErrorBoundary } from './components/error-boundary';
import { initializeAllStorage } from './lib/storage-init';
import type { TerminalTab } from './lib/terminal-group-types';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';
import { dispatchTerminalCommand, type TerminalCommand } from './lib/terminal-commands';

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Dialog, DialogContent } from './components/ui/dialog';
import { History, ShieldCheck, PlugZap, Activity, Loader2, Terminal, Plus, Maximize2, ScrollText } from 'lucide-react';
import type { ToolboxViewId } from './lib/toolbox/toolbox-types';

interface ConnectionNode {
  id: string;
  name: string;
  type: 'folder' | 'connection';
  path?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  isConnected?: boolean;
  children?: ConnectionNode[];
  isExpanded?: boolean;
}

/** Jump-host payload for desktop_connect requests (RDP/VNC via SSH bastion). */
function buildDesktopJumpHost(source: {
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string;
  jumpUseKey?: boolean;
}) {
  if (!source.jumpHost?.trim()) return null;
  return {
    host: source.jumpHost.trim(),
    port: source.jumpPort ?? 22,
    username: source.jumpUsername ?? null,
    password: source.jumpPassword ?? null,
    useKey: source.jumpUseKey ?? false,
  };
}

function AppContent() {
  const { t } = useTranslation();

  // Terminal group state from context
  const { state, dispatch, activeGroup, activeTab, activeConnection } = useTerminalGroups();
  const workingDirectorySequenceRef = useRef(0);
  const [terminalWorkingDirectories, setTerminalWorkingDirectories] = useState<
    Record<string, { path: string; sequence: number }>
  >({});

  const handleWorkingDirectoryChange = useCallback((connectionId: string, path: string) => {
    setTerminalWorkingDirectories((previous) => ({
      ...previous,
      [connectionId]: {
        path,
        sequence: ++workingDirectorySequenceRef.current,
      },
    }));
  }, []);

  // Suggestion-context accessor: latest known cwd for a terminal instance.
  const getWorkingDirectory = useCallback(
    (connectionId: string) => terminalWorkingDirectories[connectionId]?.path,
    [terminalWorkingDirectories],
  );

  // Modal states
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionInitialFolder, setConnectionInitialFolder] = useState<string | undefined>();
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  // Workspace section controlled by the page's directory bar: the connection
  // workspace, a terminal-only view, or one of the five toolbox tools.
  const [section, setSection] = useState<WorkspaceSection>('connection');
  useEffect(() => {
    const handleDatabaseProviderSelection = (event: Event) => {
      const providerId = (event as CustomEvent<string>).detail;
      if (providerId === 'postgresql') setSection('postgres');
        if (providerId === 'sqlite') setSection('sqlite');
        if (providerId === 'mysql') setSection('mysql');
    };
    window.addEventListener('nexterm:database-provider-selected', handleDatabaseProviderSelection);
    return () => window.removeEventListener('nexterm:database-provider-selected', handleDatabaseProviderSelection);
  }, []);
  // Jump to the notes tool when a note is selected from another view (e.g. the
  // Postgres "save to notes" toast's View action).
  useEffect(() => {
    const selectNote = (event: Event) => {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (!noteId) return;
      setSection('notes');
    };
    window.addEventListener('nexterm:select-note', selectNote);
    return () => window.removeEventListener('nexterm:select-note', selectNote);
  }, []);

  // App lock + storage hydration gates live in App() — AppContent only mounts
  // after every SQLite-backed store has been hydrated, so all hooks below run
  // against populated caches (see audit P0-1/P0-2).
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  // Track whether the edit dialog was opened due to a failed connection attempt (double-click)
  // vs. direct edit (right-click). When non-null and matches saved config id, auto-connect after save.
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  // Incremented after any save/connect dialog close to trigger sidebar refresh
  const [connectionSaveTrigger, setConnectionSaveTrigger] = useState(0);
  const [keyboardShortcutSettings, setKeyboardShortcutSettings] = useState<SplitViewShortcutBindings>(
    () => loadKeyboardShortcutSettings(),
  );

  // Right sidebar tab & log monitor integration
  const [rightSidebarTab, setRightSidebarTab] = useState("monitor");
  const [externalLogPath, setExternalLogPath] = useState<string | undefined>();
  const [externalLogPathKey, setExternalLogPathKey] = useState(0);
  // Floating log viewer: the Log Monitor tab can detach into its own dialog.
  const [logsFloating, setLogsFloating] = useState(false);

  // Restoration state
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoringProgress, setRestoringProgress] = useState({ current: 0, total: 0 });
  const [currentRestoreTarget, setCurrentRestoreTarget] = useState<{ name: string; host?: string; username?: string } | null>(null);

  // Layout management
  const {
    layout,
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
    setRightSidebarSize,
    setBottomPanelSize,
    applyPreset,
  } = useLayout();

  // Collect all tabs across all groups for compatibility with existing features
  const allTabs = useMemo(() => {
    return Object.values(state.groups).flatMap(g => g.tabs);
  }, [state.groups]);

  // Memoized set of active connection IDs — stable reference prevents
  // ConnectionManager from rebuilding its tree on every parent render.
  // Memoized set of active connection ids (both session ids and original
  // connection ids) so the servers view can mark saved servers as online.
  const activeConnectionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of allTabs) {
      ids.add(tab.id);
      if (tab.originalConnectionId) ids.add(tab.originalConnectionId);
    }
    return ids;
  }, [allTabs]);

  // Map saved connection id → live session id, so the servers view can query
  // per-server resource stats (get_system_stats) for connected servers.
  const connectionSessions = useMemo(() => {
    const map: Record<string, string> = {};
    for (const tab of allTabs) {
      if (tab.tabType === undefined || tab.tabType === 'terminal') {
        map[tab.originalConnectionId ?? tab.id] = tab.id;
      }
    }
    return map;
  }, [allTabs]);

  const activeTerminalId = activeTab
    && (activeTab.tabType === undefined || activeTab.tabType === 'terminal')
    && activeTab.connectionStatus !== 'pending'
    ? activeTab.id
    : null;

  const runActiveTerminalCommand = useCallback((command: TerminalCommand) => {
    if (activeTerminalId) {
      dispatchTerminalCommand(activeTerminalId, command);
    }
  }, [activeTerminalId]);

  // Apply stored language preference (follows OS locale when set to "auto")
  useEffect(() => {
    void applyLanguageFromPreference();
  }, []);

  useEffect(() => {
    const refreshKeyboardShortcutSettings = () => {
      setKeyboardShortcutSettings(loadKeyboardShortcutSettings());
    };

    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refreshKeyboardShortcutSettings);
    window.addEventListener('storage', refreshKeyboardShortcutSettings);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refreshKeyboardShortcutSettings);
      window.removeEventListener('storage', refreshKeyboardShortcutSettings);
    };
  }, []);

  const handleCloseActiveTab = useCallback(() => {
    if (!activeGroup?.activeTabId) {
      return;
    }

    const isLastTab = allTabs.length === 1;
    dispatch({ type: 'REMOVE_TAB', groupId: activeGroup.id, tabId: activeGroup.activeTabId });

    if (isLastTab) {
      ActiveConnectionsManager.clearActiveConnections();
    }
  }, [activeGroup, allTabs.length, dispatch]);

  // Keyboard shortcuts: layout + split view
  const splitViewShortcuts = useMemo(() => {
    const groupIds = Object.keys(state.groups);
    return createSplitViewShortcuts(
      {
        splitRight: () => {
          if (state.activeGroupId) {
            dispatch({ type: 'SPLIT_GROUP', groupId: state.activeGroupId, direction: 'right' });
          }
        },
        splitDown: () => {
          if (state.activeGroupId) {
            dispatch({ type: 'SPLIT_GROUP', groupId: state.activeGroupId, direction: 'down' });
          }
        },
        focusGroup: (index: number) => {
          if (index < groupIds.length) {
            dispatch({ type: 'ACTIVATE_GROUP', groupId: groupIds[index] });
          }
        },
        closeTab: () => {
          handleCloseActiveTab();
        },
        nextTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const nextIndex = (currentIndex + 1) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[nextIndex].id });
          }
        },
        prevTab: () => {
          if (activeGroup && activeGroup.activeTabId && activeGroup.tabs.length > 1) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            const prevIndex = (currentIndex - 1 + activeGroup.tabs.length) % activeGroup.tabs.length;
            dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[prevIndex].id });
          }
        },
      },
      keyboardShortcutSettings,
    );
  }, [state.activeGroupId, state.groups, activeGroup, dispatch, handleCloseActiveTab, keyboardShortcutSettings]);

  const layoutShortcuts = useMemo(() => createLayoutShortcuts({
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleBottomPanel,
    toggleZenMode,
  }), [toggleLeftSidebar, toggleRightSidebar, toggleBottomPanel, toggleZenMode]);

  // Stable merged array — spreading inline would create a new reference every
  // render and re-mount the global keydown listener on each state update.
  const allShortcuts = useMemo(
    () => [...layoutShortcuts, ...splitViewShortcuts],
    [layoutShortcuts, splitViewShortcuts],
  );
  useKeyboardShortcuts(allShortcuts, true);

  // Save active connections when tabs change (for restore on next launch)
  useEffect(() => {
    // Editor and toolbox tabs are transient — exclude them from persistence
    const persistableTabs = allTabs.filter(tab => tab.tabType !== 'editor' && tab.tabType !== 'tools');
    if (persistableTabs.length > 0) {
      const activeConnections = persistableTabs.map((tab, index) => ({
        tabId: tab.id,
        connectionId: tab.id,
        order: index,
        originalConnectionId: tab.originalConnectionId,
        tabType: tab.tabType,
        protocol: tab.protocol,
      }));
      ActiveConnectionsManager.saveActiveConnections(activeConnections);
    } else {
      ActiveConnectionsManager.clearActiveConnections();
    }
  }, [allTabs]);

  // Restore connections on mount
  useEffect(() => {
    /** Race a promise against a timeout; rejects with a clear message on expiry. */
    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label} did not complete within ${ms / 1000}s`)), ms),
        ),
      ]);
    }

    const CONNECT_TIMEOUT_MS = 15_000; // 15 s per backend connect call
    const OVERALL_RESTORE_TIMEOUT_MS = 60_000; // 60 s for the entire restore

    const restoreConnections = async () => {
      const activeConnections = ActiveConnectionsManager.getActiveConnections();

      if (activeConnections.length === 0) {
        return;
      }

      // Collect tab IDs already present in the restored layout state to avoid duplicates.
      // The TerminalGroupProvider may have loaded tabs from the SQLite workspace store, so we only need
      // to re-establish SSH connections for those tabs, not add them again.
      const existingTabIds = new Set(
        Object.values(state.groups).flatMap(g => g.tabs.map(t => t.id))
      );

      console.log('Previous connections found:', activeConnections);

      setIsRestoring(true);
      setRestoringProgress({ current: 0, total: activeConnections.length });

      const sortedConnections = [...activeConnections].sort((a, b) => a.order - b.order);

      let restoredCount = 0;
      let failedCount = 0;

      for (let i = 0; i < sortedConnections.length; i++) {
        const activeConn = sortedConnections[i];
        const connectionIdToLoad = activeConn.originalConnectionId || activeConn.connectionId;
        const connectionData = ConnectionStorageManager.getConnection(connectionIdToLoad);

        setRestoringProgress({ current: i + 1, total: sortedConnections.length });

        if (!connectionData) {
          console.warn(`Connection ${connectionIdToLoad} not found in storage`);
          failedCount++;
          continue;
        }

        const isDesktopProto = connectionData.protocol === 'RDP' || connectionData.protocol === 'VNC';
        const hasCredentials = isDesktopProto
          ? true // Desktop protocols can connect with or without credentials
          : connectionData.authMethod === 'password'
            ? !!connectionData.password
            : (connectionData.authMethod === 'anonymous' ? true : !!connectionData.privateKeyPath);

        if (!hasCredentials) {
          console.log(`Connection ${connectionData.name} has no saved credentials, skipping restore`);
          failedCount++;
          continue;
        }

        setCurrentRestoreTarget({
          name: connectionData.name,
          host: connectionData.host,
          username: connectionData.username,
        });

        const tabAlreadyExists = existingTabIds.has(activeConn.connectionId);
        const isSftp = activeConn.protocol === 'SFTP' || connectionData.protocol === 'SFTP';
        const isFtp = activeConn.protocol === 'FTP' || connectionData.protocol === 'FTP';
        const isFileBrowser = isSftp || isFtp;
        const isDesktopRestore = activeConn.tabType === 'desktop' ||
          connectionData.protocol === 'RDP' || connectionData.protocol === 'VNC';

        try {
          if (isDesktopRestore) {
            // RDP/VNC restoration
            const proto = connectionData.protocol;
            await withTimeout(
              invoke('desktop_connect', {
                connectionId: activeConn.connectionId,
                request: {
                  host: connectionData.host,
                  port: connectionData.port || (proto === 'RDP' ? 3389 : 5900),
                  protocol: proto.toLowerCase(),
                  username: connectionData.username || '',
                  password: connectionData.password || '',
                  domain: connectionData.domain || null,
                  resolution: connectionData.rdpResolution || '1920x1080',
                  colorDepth: connectionData.vncColorDepth ? parseInt(connectionData.vncColorDepth) : 24,
                  jumpHost: buildDesktopJumpHost(connectionData),
                }
              }),
              CONNECT_TIMEOUT_MS,
              `desktop_connect ${connectionData.name}`,
            );

            if (!activeConn.originalConnectionId) {
              ConnectionStorageManager.updateLastConnected(connectionData.id);
            }

            if (tabAlreadyExists) {
              dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'connected' });
            } else {
              const newTab: TerminalTab = {
                id: activeConn.connectionId,
                name: connectionData.name,
                tabType: 'desktop',
                protocol: connectionData.protocol,
                host: connectionData.host,
                username: connectionData.username,
                originalConnectionId: activeConn.originalConnectionId,
                connectionStatus: 'connected',
                reconnectCount: 0,
              };
              dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
            }

            restoredCount++;
            console.log(`✓ Restored ${proto} desktop connection: ${connectionData.name}${tabAlreadyExists ? ' (reconnected existing tab)' : ''}`);
          } else if (isFileBrowser) {
            // SFTP/FTP restoration
            if (isSftp) {
              await withTimeout(
                invoke('sftp_connect', { request: buildSftpConnectRequest(activeConn.connectionId, connectionData) }),
                CONNECT_TIMEOUT_MS,
                `sftp_connect ${connectionData.name}`,
              );
            } else {
              await withTimeout(
                invoke('ftp_connect', {
                  request: {
                    connection_id: activeConn.connectionId,
                    host: connectionData.host,
                    port: connectionData.port || 21,
                    username: connectionData.username || '',
                    password: connectionData.password || '',
                    ftps_enabled: connectionData.ftpsEnabled ?? false,
                    anonymous: connectionData.authMethod === 'anonymous',
                  }
                }),
                CONNECT_TIMEOUT_MS,
                `ftp_connect ${connectionData.name}`,
              );
            }

            if (!activeConn.originalConnectionId) {
              ConnectionStorageManager.updateLastConnected(connectionData.id);
            }

            if (tabAlreadyExists) {
              dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'connected' });
            } else {
              const newTab: TerminalTab = {
                id: activeConn.connectionId,
                name: connectionData.name,
                tabType: 'file-browser',
                protocol: connectionData.protocol,
                host: connectionData.host,
                username: connectionData.username,
                originalConnectionId: activeConn.originalConnectionId,
                connectionStatus: 'connected',
                reconnectCount: 0,
              };
              dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
            }

            restoredCount++;
            console.log(`✓ Restored ${connectionData.protocol} connection: ${connectionData.name}${tabAlreadyExists ? ' (reconnected existing tab)' : ''}`);
          } else {
            // SSH restoration (existing behavior)
            const result = await withTimeout(
              invoke<{ success: boolean; error?: string }>(
                'ssh_connect',
                {
                  request: buildSshConnectRequest(activeConn.connectionId, connectionData),
                }
              ),
              CONNECT_TIMEOUT_MS,
              `ssh_connect ${connectionData.name}`,
            );

            if (result.success) {
              if (!activeConn.originalConnectionId) {
                ConnectionStorageManager.updateLastConnected(connectionData.id);
              }

              if (tabAlreadyExists) {
                dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'connecting' });
              } else {
                const newTab: TerminalTab = {
                  id: activeConn.connectionId,
                  name: connectionData.name,
                  protocol: connectionData.protocol,
                  host: connectionData.host,
                  username: connectionData.username,
                  originalConnectionId: activeConn.originalConnectionId,
                  connectionStatus: 'connecting',
                  reconnectCount: 0,
                };
                dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
              }

              restoredCount++;
              console.log(`✓ Restored connection: ${connectionData.name}${tabAlreadyExists ? ' (reconnected existing tab)' : ''}${activeConn.originalConnectionId ? ' (duplicate)' : ''}`);

              if (i < sortedConnections.length - 1) {
                await registerRestoration(activeConn.connectionId, 3000);
              }
            } else {
              console.error(`Failed to restore connection ${connectionData.name}:`, result.error);
              if (tabAlreadyExists) {
                dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'disconnected' });
              }
              failedCount++;
            }
          }
        } catch (error) {
          console.error(`Error restoring connection ${connectionData.name}:`, error);
          if (tabAlreadyExists) {
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: activeConn.connectionId, status: 'disconnected' });
          }
          failedCount++;
        }
      }

      if (restoredCount > 0) {
        toast.success(t('app.connectionsRestored'), {
          description: failedCount > 0
            ? t('app.connectionsRestoredDesc', { restoredCount, failedCount })
            : t('app.connectionsRestoredAllDesc', { restoredCount }),
        });
      } else if (failedCount > 0) {
        ActiveConnectionsManager.clearActiveConnections();
        toast.error(t('app.restoreFailed'), {
          description: t('app.restoreFailedDesc'),
        });
      }

      setCurrentRestoreTarget(null);
      setIsRestoring(false);
      setRestoringProgress({ current: 0, total: 0 });
      clearAllRestorations();
    };

    withTimeout(restoreConnections(), OVERALL_RESTORE_TIMEOUT_MS, 'Session restore').catch((err) => {
      console.error('Session restore timed out:', err);
      toast.error(t('app.restoreTimedOut'), {
        description: t('app.restoreTimedOutDesc'),
      });
      setCurrentRestoreTarget(null);
      setIsRestoring(false);
      setRestoringProgress({ current: 0, total: 0 });
      clearAllRestorations();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronous guard against double-connect: React state updates are async,
  // so a fast double-click could otherwise open two sessions before the new
  // tab renders. This ref is checked/updated immediately.
  const connectingGuardRef = useRef<Set<string>>(new Set());

  const handleConnectionConnect = async (connection: ConnectionNode) => {
    if (connection.type === 'connection') {
      if (connectingGuardRef.current.has(connection.id)) return;
      connectingGuardRef.current.add(connection.id);
      window.setTimeout(() => connectingGuardRef.current.delete(connection.id), 3000);

      // Deduplicate: if this connection already has a live tab (connecting or
      // connected), activate it instead of opening a second session.
      const existingTab = allTabs.find((tab) =>
        (tab.originalConnectionId === connection.id || tab.id === connection.id) &&
        tab.connectionStatus !== 'disconnected',
      );
      if (existingTab) {
        for (const group of Object.values(state.groups)) {
          if (group.tabs.some((t) => t.id === existingTab.id)) {
            dispatch({ type: 'ACTIVATE_GROUP', groupId: group.id });
            dispatch({ type: 'ACTIVATE_TAB', groupId: group.id, tabId: existingTab.id });
            break;
          }
        }
        setSection('terminal');
        return;
      }

      // Always use a unique session ID (see sessionId below) to prevent the backend
      // from reusing a stale session from a previously closed tab that was never
      // disconnected. This guarantees a fresh TCP connection with the latest config.
      const connectionData = ConnectionStorageManager.getConnection(connection.id);
      if (!connectionData) return;

      const isSftp = connectionData.protocol === 'SFTP';
      const isFtp = connectionData.protocol === 'FTP';
      const isFileBrowser = isSftp || isFtp;

      const hasCredentials = isFileBrowser
        ? (connectionData.authMethod === 'anonymous' || connectionData.authMethod === 'password'
          ? (connectionData.authMethod === 'anonymous' || !!connectionData.password)
          : !!connectionData.privateKeyPath)
        : (connectionData.authMethod === 'password'
          ? !!connectionData.password
          : !!connectionData.privateKeyPath);

      if (!hasCredentials) {
        setEditingConnection(toConnectionConfig(connectionData));
        setPendingConnectionId(connection.id);
        setConnectionDialogOpen(true);
        return;
      }

      // Always use a unique session ID — the backend may still hold a stale
      // session from a previously closed tab that was never disconnected.
      // A fresh session ID guarantees a new TCP connection with the latest config.
      const sessionId = `${connection.id}-dup-${Date.now()}`;

      if (isFileBrowser) {
        // SFTP/FTP connect flow
        const newTab: TerminalTab = {
          id: sessionId,
          name: connectionData.name,
          tabType: 'file-browser',
          protocol: connectionData.protocol,
          host: connectionData.host,
          username: connectionData.username,
          originalConnectionId: connection.id,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          if (isSftp) {
            await invoke('sftp_connect', { request: buildSftpConnectRequest(sessionId, connectionData) });
          } else {
            await invoke('ftp_connect', {
              request: {
                connection_id: sessionId,
                host: connectionData.host,
                port: connectionData.port || 21,
                username: connectionData.username || '',
                password: connectionData.password || '',
                ftps_enabled: connectionData.ftpsEnabled ?? false,
                anonymous: connectionData.authMethod === 'anonymous',
              }
            });
          }
          ConnectionStorageManager.updateLastConnected(connection.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
          setSection('terminal');
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH connect flow — create a placeholder tab first (shows "Waiting for
        // connection..." so the user knows something is happening), then ssh_connect.
        // Only after ssh_connect succeeds do we switch to 'connecting' status, which
        // triggers PtyTerminal to mount and establish the WebSocket + PTY session.
        // This avoids a race where PtyTerminal sends StartPty before the backend
        // SSH session is fully established.
        const newTab: TerminalTab = {
          id: sessionId,
          name: connectionData.name,
          protocol: connectionData.protocol,
          host: connectionData.host,
          username: connectionData.username,
          originalConnectionId: connection.id,
          connectionStatus: 'pending',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        console.debug('[SSH] Connecting:', { id: connectionData.id, host: connectionData.host, port: connectionData.port, authMethod: connectionData.authMethod });

        try {
          const result = await invoke<{ success: boolean; error?: string }>(
            'ssh_connect',
            {
              request: buildSshConnectRequest(sessionId, connectionData),
            }
          );

          if (result.success) {
            ConnectionStorageManager.updateLastConnected(connection.id);
            // Switch to 'connecting' — this mounts PtyTerminal which opens WebSocket
            // and sends StartPty. The backend SSH session is ready by now.
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connecting' });
            setSection('terminal');
          } else {
            console.error('SSH connection failed:', result.error);
            dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
            toast.error(t('app.connectionFailed'), {
              description: result.error || t('app.unableToConnectDesc'),
            });
            setEditingConnection(toConnectionConfig(connectionData));
            setPendingConnectionId(connection.id);
            setConnectionDialogOpen(true);
          }
        } catch (error) {
          console.error('Error connecting to SSH:', error);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          toast.error(t('app.connectionError'), {
            description: error instanceof Error ? error.message : t('app.connectionErrorDesc'),
          });
          setEditingConnection(toConnectionConfig(connectionData));
          setPendingConnectionId(connection.id);
          setConnectionDialogOpen(true);
        }
      }
    }
  };

  const handleNewTab = useCallback((folderPath?: string) => {
    // Creating a connection returns to the connection workspace.
    setSection('connection');
    setConnectionInitialFolder(folderPath);
    setConnectionDialogOpen(true);
    setEditingConnection(null);
    setPendingConnectionId(null);
  }, []);

  const handleDuplicateTab = useCallback(async (tabId: string) => {
    const tabToDuplicate = allTabs.find(tab => tab.id === tabId);
    if (!tabToDuplicate) return;

    const originalConnectionId = tabToDuplicate.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error(t('app.cannotDuplicate'), {
        description: t('app.cannotDuplicateDesc'),
      });
      return;
    }

    const isSftp = tabToDuplicate.protocol === 'SFTP' || connectionData.protocol === 'SFTP';
    const isFtp = tabToDuplicate.protocol === 'FTP' || connectionData.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;

    const hasCredentials = isFileBrowser
      ? (connectionData.authMethod === 'anonymous' || !!connectionData.password || !!connectionData.privateKeyPath)
      : (connectionData.authMethod === 'password'
        ? !!connectionData.password
        : !!connectionData.privateKeyPath);

    if (!hasCredentials) {
      toast.error(t('app.cannotDuplicate'), {
        description: t('app.noCredentialsDesc'),
      });
      return;
    }

    try {
      const duplicateId = `${originalConnectionId}-dup-${Date.now()}`;

      if (isFileBrowser) {
        // SFTP/FTP duplicate flow
        const duplicatedTab: TerminalTab = {
          id: duplicateId,
          name: tabToDuplicate.name,
          tabType: 'file-browser',
          protocol: tabToDuplicate.protocol,
          host: tabToDuplicate.host,
          username: tabToDuplicate.username,
          originalConnectionId,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: duplicatedTab });

        try {
          if (isSftp) {
            await invoke('sftp_connect', { request: buildSftpConnectRequest(duplicateId, connectionData) });
          } else {
            await invoke('ftp_connect', {
              request: {
                connection_id: duplicateId,
                host: connectionData.host,
                port: connectionData.port || 21,
                username: connectionData.username || '',
                password: connectionData.password || '',
                ftps_enabled: connectionData.ftpsEnabled ?? false,
                anonymous: connectionData.authMethod === 'anonymous',
              }
            });
          }
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: duplicateId, status: 'connected' });
          toast.success(t('app.tabDuplicated'), {
            description: t('app.tabDuplicatedDesc', { name: tabToDuplicate.name }),
          });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: duplicateId, status: 'disconnected' });
          toast.error(t('app.duplicationFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH duplicate flow
        const result = await invoke<{ success: boolean; error?: string }>(
          'ssh_connect',
          {
            request: buildSshConnectRequest(duplicateId, connectionData),
          }
        );

        if (result.success) {
          const duplicatedTab: TerminalTab = {
            id: duplicateId,
            name: tabToDuplicate.name,
            protocol: tabToDuplicate.protocol,
            host: tabToDuplicate.host,
            username: tabToDuplicate.username,
            originalConnectionId,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };

          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: duplicatedTab });

          toast.success(t('app.tabDuplicated'), {
            description: t('app.tabDuplicatedDesc', { name: tabToDuplicate.name }),
          });
        } else {
          toast.error(t('app.duplicationFailed'), {
            description: result.error || t('app.duplicationFailedDesc'),
          });
        }
      }
    } catch (error) {
      console.error('Error duplicating tab:', error);
      toast.error(t('app.duplicationError'), {
        description: error instanceof Error ? error.message : t('app.duplicationErrorDesc'),
      });
    }
  }, [allTabs, state.activeGroupId, dispatch, t]);

  const handleReconnect = useCallback(async (tabId: string) => {
    const tabToReconnect = allTabs.find(tab => tab.id === tabId);
    if (!tabToReconnect) return;

    const originalConnectionId = tabToReconnect.originalConnectionId || tabId;
    const connectionData = ConnectionStorageManager.getConnection(originalConnectionId);
    if (!connectionData) {
      toast.error(t('app.cannotReconnect'), {
        description: t('app.cannotReconnectDesc'),
      });
      return;
    }

    const isSftp = tabToReconnect.protocol === 'SFTP' || connectionData.protocol === 'SFTP';
    const isFtp = tabToReconnect.protocol === 'FTP' || connectionData.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;

    const hasCredentials = isFileBrowser
      ? (connectionData.authMethod === 'anonymous' || !!connectionData.password || !!connectionData.privateKeyPath)
      : (connectionData.authMethod === 'password'
        ? !!connectionData.password
        : !!connectionData.privateKeyPath);

    if (!hasCredentials) {
      toast.error(t('app.cannotReconnect'), {
        description: t('app.noCredentialsDesc'),
      });
      setEditingConnection(toConnectionConfig(connectionData));
      setPendingConnectionId(originalConnectionId);
      setConnectionDialogOpen(true);
      return;
    }

    // Update tab status to connecting
    dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connecting' });

    try {
      if (isFileBrowser) {
        // SFTP/FTP reconnect
        try {
          if (isSftp) {
            await invoke('sftp_standalone_disconnect', { connection_id: tabId });
          } else {
            await invoke('ftp_disconnect', { connection_id: tabId });
          }
        } catch {
          // Ignore errors when disconnecting
        }

        if (isSftp) {
          await invoke('sftp_connect', { request: buildSftpConnectRequest(tabId, connectionData) });
        } else {
          await invoke('ftp_connect', {
            request: {
              connection_id: tabId,
              host: connectionData.host,
              port: connectionData.port || 21,
              username: connectionData.username || '',
              password: connectionData.password || '',
              ftps_enabled: connectionData.ftpsEnabled ?? false,
              anonymous: connectionData.authMethod === 'anonymous',
            }
          });
        }

        if (!tabToReconnect.originalConnectionId) {
          ConnectionStorageManager.updateLastConnected(originalConnectionId);
        }
        dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
        toast.success(t('app.reconnected'), {
          description: t('app.reconnectedDesc', { name: tabToReconnect.name }),
        });
      } else {
        // SSH reconnect (existing behavior)
        try {
          await invoke('ssh_disconnect', { connectionId: tabId });
        } catch {
          // Ignore errors when disconnecting
        }

        const result = await invoke<{ success: boolean; error?: string }>(
          'ssh_connect',
          {
            request: buildSshConnectRequest(tabId, connectionData),
          }
        );

        if (result.success) {
          if (!tabToReconnect.originalConnectionId) {
            ConnectionStorageManager.updateLastConnected(originalConnectionId);
          }
          // Remount PtyTerminal so it opens a fresh WebSocket/PTY on the
          // newly re-established SSH connection.
          dispatch({ type: 'RECONNECT_TAB', tabId });
          toast.success(t('app.reconnected'), {
            description: t('app.reconnectedDesc', { name: tabToReconnect.name }),
          });
        } else {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          toast.error(t('app.reconnectionFailed'), {
            description: result.error || t('app.reconnectionFailedDesc'),
          });
        }
      }
    } catch (error) {
      console.error('Error reconnecting:', error);
      dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
      toast.error(t('app.reconnectionError'), {
        description: error instanceof Error ? error.message : t('app.reconnectionErrorDesc'),
      });
    }
  }, [allTabs, dispatch, t]);

  // Handler: open a remote file in the Log Monitor panel
  const handleOpenInLogMonitor = useCallback((filePath: string) => {
    setExternalLogPath(filePath);
    setExternalLogPathKey((k) => k + 1);
    setRightSidebarTab("logs");
    // Ensure right sidebar is visible
    if (!layout.rightSidebarVisible) {
      toggleRightSidebar();
    }
    toast.success(t('app.openingInLogMonitor', { filename: filePath.split("/").pop() }));
  }, [layout.rightSidebarVisible, toggleRightSidebar, t]);

  // Handler: open a remote file in a new Tauri window.
  // The window is centered on whichever monitor the parent window currently
  // occupies, matching the behaviour of VS Code, Chrome, Figma, etc.
  const handleOpenInEditor = useCallback((filePath: string, fileName: string) => {
    if (!activeConnection) return;
    const label = `file-viewer-${Date.now()}`;
    const url = `${window.location.origin}/?mode=file-viewer`
      + `&connectionId=${encodeURIComponent(activeConnection.connectionId)}`
      + `&filePath=${encodeURIComponent(filePath)}`
      + `&fileName=${encodeURIComponent(fileName)}`;

    const WIN_W = 900;
    const WIN_H = 700;

    Promise.all([
      import('@tauri-apps/api/webviewWindow'),
      import('@tauri-apps/api/window'),
    ]).then(async ([{ WebviewWindow }, { getCurrentWindow, currentMonitor }]) => {
      const parentWin = getCurrentWindow();
      const [monitor, scaleFactor] = await Promise.all([
        currentMonitor(),          // standalone function, not a method on Window
        parentWin.scaleFactor(),
      ]);

      // Derive logical (DIP) position centered on the parent's monitor.
      // Falls back to Tauri's built-in centering if monitor info is unavailable.
      let position: { x: number; y: number } | undefined;
      if (monitor) {
        const logicalMonX = monitor.position.x / scaleFactor;
        const logicalMonY = monitor.position.y / scaleFactor;
        const logicalMonW = monitor.size.width / scaleFactor;
        const logicalMonH = monitor.size.height / scaleFactor;
        position = {
          x: Math.round(logicalMonX + (logicalMonW - WIN_W) / 2),
          y: Math.round(logicalMonY + (logicalMonH - WIN_H) / 2),
        };
      }

      const win = new WebviewWindow(label, {
        url,
        title: fileName,
        width: WIN_W,
        height: WIN_H,
        // Use explicit position when available; fall back to primary-monitor center
        ...(position ? position : { center: true }),
        resizable: true,
        decorations: true,
      });
      win.once('tauri://error', (e) => {
        toast.error(t('app.failedToOpenWindow'), { description: String(e.payload) });
      });
    }).catch((err: unknown) => {
      toast.error(t('app.couldNotOpenWindow'), { description: String(err) });
    });
  }, [activeConnection, t]);

  const handleConnectionDialogConnect = useCallback(async (config: ConnectionConfig) => {
    const tabId = config.id || `connection-${Date.now()}`;
    const isSftp = config.protocol === 'SFTP';
    const isFtp = config.protocol === 'FTP';
    const isFileBrowser = isSftp || isFtp;
    const isDesktop = isDesktopProtocol(config.protocol);

    // Check if a tab with this ID already exists in any group
    const existingTab = allTabs.find(tab => tab.id === tabId);

    if (existingTab) {
      // Tab exists - activate it and update status
      for (const group of Object.values(state.groups)) {
        if (group.tabs.some(t => t.id === tabId)) {
          dispatch({ type: 'ACTIVATE_GROUP', groupId: group.id });
          dispatch({ type: 'ACTIVATE_TAB', groupId: group.id, tabId });
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connecting' });
          break;
        }
      }

      // For SFTP/FTP reconnect flow
      if (isFileBrowser) {
        try {
          if (isSftp) {
            await invoke('sftp_connect', { request: buildSftpConnectRequest(tabId, config) });
          } else {
            await invoke('ftp_connect', {
              request: {
                connection_id: tabId,
                host: config.host,
                port: config.port || 21,
                username: config.username || '',
                password: config.password || '',
                ftps_enabled: config.ftpsEnabled ?? false,
                anonymous: config.authMethod === 'anonymous',
              }
            });
          }
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
          setSection('terminal');
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isDesktop) {
        // RDP/VNC reconnect flow
        try {
          await invoke('desktop_connect', {
            connectionId: tabId,
            request: {
              host: config.host,
              port: config.port || (config.protocol === 'RDP' ? 3389 : 5900),
              protocol: config.protocol.toLowerCase(),
              username: config.username || '',
              password: config.password || '',
              domain: config.domain || null,
              resolution: config.rdpResolution || '1920x1080',
              colorDepth: config.vncColorDepth ? parseInt(config.vncColorDepth) : 24,
              jumpHost: buildDesktopJumpHost(config),
            }
          });
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
          setSection('terminal');
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      if (isDesktop) {
        // For RDP/VNC: create desktop tab and connect
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          tabType: 'desktop',
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          await invoke('desktop_connect', {
            connectionId: tabId,
            request: {
              host: config.host,
              port: config.port || (config.protocol === 'RDP' ? 3389 : 5900),
              protocol: config.protocol.toLowerCase(),
              username: config.username || '',
              password: config.password || '',
              domain: config.domain || null,
              resolution: config.rdpResolution || '1920x1080',
              colorDepth: config.vncColorDepth ? parseInt(config.vncColorDepth) : 24,
              jumpHost: buildDesktopJumpHost(config),
            }
          });
          ConnectionStorageManager.updateLastConnected(config.id || tabId);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
          setSection('terminal');
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isFileBrowser) {
        // For SFTP/FTP: connect first, then add file-browser tab
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          tabType: 'file-browser',
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });

        try {
          if (isSftp) {
            await invoke('sftp_connect', { request: buildSftpConnectRequest(tabId, config) });
          } else {
            await invoke('ftp_connect', {
              request: {
                connection_id: tabId,
                host: config.host,
                port: config.port || 21,
                username: config.username || '',
                password: config.password || '',
                ftps_enabled: config.ftpsEnabled ?? false,
                anonymous: config.authMethod === 'anonymous',
              }
            });
          }
          ConnectionStorageManager.updateLastConnected(config.id || tabId);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'connected' });
          setSection('terminal');
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH/Telnet: create terminal tab (existing behavior)
        const newTab: TerminalTab = {
          id: tabId,
          name: config.name,
          protocol: config.protocol,
          host: config.host,
          username: config.username,
          connectionStatus: 'connecting',
          reconnectCount: 0,
        };
        dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        setSection('terminal');
      }
    }
  }, [allTabs, state.groups, state.activeGroupId, dispatch, t, setSection]);

  const handleOpenSettings = useCallback(() => {
    setSettingsModalOpen(true);
  }, []);

  // Open a toolbox tool via the workspace directory bar.
  const handleOpenTool = useCallback((view: ToolboxViewId) => {
    setSection(view);
  }, []);

  // Listen for native macOS menu events forwarded by Rust via app.emit("menu-action", id)
  useEffect(() => {
    const unlistenPromise = listen<string>('menu-action', (event) => {
      switch (event.payload) {
        case 'new_connection':
        case 'new_tab':
          handleNewTab();
          break;
        case 'close_connection':
          handleCloseActiveTab();
          break;
        case 'clone_tab':
          if (activeTab) { handleDuplicateTab(activeTab.id); }
          break;
        case 'find':
          runActiveTerminalCommand('find');
          break;
        case 'clear_screen':
          runActiveTerminalCommand('clear-screen');
          break;
        case 'next_tab':
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const idx = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (idx < activeGroup.tabs.length - 1) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[idx + 1].id });
            }
          }
          break;
        case 'prev_tab':
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const idx = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (idx > 0) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[idx - 1].id });
            }
          }
          break;
        case 'settings':
          handleOpenSettings();
          break;
        case 'tool_apps':
          handleOpenTool('apps');
          break;
        case 'tool_vault':
          handleOpenTool('vault');
          break;
        case 'tool_tunnels':
          handleOpenTool('tunnels');
          break;
        case 'tool_services':
          handleOpenTool('services');
          break;
        case 'tool_notes':
          handleOpenTool('notes');
          break;
        case 'tool_history':
          handleOpenTool('history');
          break;
      }
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, [activeGroup, activeTab, handleNewTab, handleOpenSettings, handleDuplicateTab, handleCloseActiveTab, runActiveTerminalCommand, dispatch, handleOpenTool]);

  // Connect to a server from the servers view list.
  const handleServerConnect = useCallback((connectionId: string) => {
    const connectionData = ConnectionStorageManager.getConnection(connectionId);
    if (!connectionData) return;
    const node: ConnectionNode = {
      id: connectionData.id,
      name: connectionData.name,
      type: 'connection',
      protocol: connectionData.protocol,
      host: connectionData.host,
      port: connectionData.port,
      username: connectionData.username,
    };
    void handleConnectionConnect(node);
  }, [handleConnectionConnect]);

  // Edit a server from the servers view list.
  const handleEditServer = useCallback((connectionId: string) => {
    const connectionData = ConnectionStorageManager.getConnection(connectionId);
    if (!connectionData) return;
    setEditingConnection(toConnectionConfig(connectionData));
    setConnectionDialogOpen(true);
    setPendingConnectionId(null);
  }, []);
  const handleSaveConnection = useCallback(async (config: ConnectionConfig) => {
    if (!config.id) return;

    // Update any open tab name for this connection
    for (const group of Object.values(state.groups)) {
      for (const tab of group.tabs) {
        if (tab.id === config.id || tab.originalConnectionId === config.id) {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: tab.id, name: config.name });
        }
      }
    }

    const wasPendingConnect = pendingConnectionId === config.id;
    if (wasPendingConnect) {
      setPendingConnectionId(null);

      // Reuse the existing disconnected/pending tab (created by the initial failed
      // connection attempt) instead of creating a new one. This avoids leaving a
      // dead tab behind after the user saves a fix and auto-connects.
      const pendingTab = allTabs.find(tab =>
        tab.originalConnectionId === config.id &&
        (tab.connectionStatus === 'disconnected' || tab.connectionStatus === 'pending')
      );
      const sessionId = pendingTab ? pendingTab.id : `${config.id}-dup-${Date.now()}`;

      const isSftp = config.protocol === 'SFTP';
      const isFtp = config.protocol === 'FTP';
      const isFileBrowser = isSftp || isFtp;
      const isDesktop = isDesktopProtocol(config.protocol);

      if (isDesktop) {
        if (!pendingTab) {
          const newTab: TerminalTab = {
            id: sessionId,
            name: config.name,
            tabType: 'desktop',
            protocol: config.protocol,
            host: config.host,
            username: config.username,
            originalConnectionId: config.id,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };
          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        } else {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
          dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
        }

        try {
          await invoke('desktop_connect', {
            connectionId: sessionId,
            request: {
              host: config.host,
              port: config.port || (config.protocol === 'RDP' ? 3389 : 5900),
              protocol: config.protocol.toLowerCase(),
              username: config.username || '',
              password: config.password || '',
              domain: config.domain || null,
              resolution: config.rdpResolution || '1920x1080',
              colorDepth: config.vncColorDepth ? parseInt(config.vncColorDepth) : 24,
              jumpHost: buildDesktopJumpHost(config),
            }
          });
          ConnectionStorageManager.updateLastConnected(config.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (isFileBrowser) {
        if (!pendingTab) {
          const newTab: TerminalTab = {
            id: sessionId,
            name: config.name,
            tabType: 'file-browser',
            protocol: config.protocol,
            host: config.host,
            username: config.username,
            originalConnectionId: config.id,
            connectionStatus: 'connecting',
            reconnectCount: 0,
          };
          dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
        } else {
          dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
          dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
        }

        try {
          if (isSftp) {
            await invoke('sftp_connect', { request: buildSftpConnectRequest(sessionId, config) });
          } else {
            await invoke('ftp_connect', {
              request: {
                connection_id: sessionId,
                host: config.host,
                port: config.port || 21,
                username: config.username || '',
                password: config.password || '',
                ftps_enabled: config.ftpsEnabled ?? false,
                anonymous: config.authMethod === 'anonymous',
              }
            });
          }
          ConnectionStorageManager.updateLastConnected(config.id);
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'connected' });
        } catch (error) {
          dispatch({ type: 'UPDATE_TAB_STATUS', tabId: sessionId, status: 'disconnected' });
          toast.error(t('app.connectionFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SSH / Telnet / Raw — connect then create/reuse tab
        try {
          const result = await invoke<{ success: boolean; error?: string }>('ssh_connect', {
            request: buildSshConnectRequest(sessionId, config),
          });

          if (result.success) {
            ConnectionStorageManager.updateLastConnected(config.id);
            if (pendingTab) {
              // Reuse existing tab — RECONNECT_TAB increments reconnectCount so
              // PtyTerminal's React key changes, forcing a remount with a fresh
              // WebSocket + StartPty session. (UPDATE_TAB_STATUS alone would leave
              // the old terminal content showing.)
              dispatch({ type: 'UPDATE_TAB_NAME', tabId: sessionId, name: config.name });
              dispatch({ type: 'RECONNECT_TAB', tabId: sessionId });
            } else {
              // No existing tab — create a new one
              const newTab: TerminalTab = {
                id: sessionId,
                name: config.name,
                protocol: config.protocol,
                host: config.host,
                username: config.username,
                originalConnectionId: config.id,
                connectionStatus: 'connecting',
                reconnectCount: 0,
              };
              dispatch({ type: 'ADD_TAB', groupId: state.activeGroupId, tab: newTab });
            }
          } else {
            toast.error(t('app.connectionFailed'), {
              description: result.error || t('app.unableToConnectDesc'),
            });
          }
        } catch (error) {
          toast.error(t('app.connectionError'), {
            description: error instanceof Error ? error.message : t('app.connectionErrorDesc'),
          });
        }
      }
    }
  }, [state.groups, state.activeGroupId, allTabs, dispatch, t, pendingConnectionId]);

  // Derive active connection info for StatusBar (compatible format)
  const statusBarConnection = activeConnection ? {
    name: activeConnection.name,
    protocol: activeConnection.protocol || 'SSH',
    host: activeConnection.host,
    status: activeConnection.status,
  } : undefined;

  const restoringPercent = !restoringProgress.total
    ? 0
    : Math.min(100, Math.round((restoringProgress.current / restoringProgress.total) * 100));

  const restoreHighlights = useMemo(() => (
    [
      { icon: ShieldCheck, label: t('app.restoreHighlightEncrypted') },
      { icon: PlugZap, label: t('app.restoreHighlightReconnect') },
      { icon: Activity, label: t('app.restoreHighlightMonitoring') },
    ]
  ), [t]);

  // Check if there are any tabs across all groups
  const hasAnyTabs = allTabs.length > 0;
  // File-browser tabs don't need right sidebar (system monitor) or bottom panel (integrated file browser)
  const isFileBrowserTab = activeTab?.tabType === 'file-browser';
  // Desktop tabs (RDP/VNC) also don't need right sidebar or bottom panel
  const isDesktopTab = activeTab?.tabType === 'desktop';
  // Editor tabs are standalone — hide extra panels like file-browser/desktop tabs
  const isEditorTab = activeTab?.tabType === 'editor';
  const hideExtraPanels = isFileBrowserTab || isDesktopTab || isEditorTab;

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Connection Restoration Loading Overlay */}
      {isRestoring && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-xl rounded-2xl border bg-card p-8 shadow-2xl">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <History className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">{t('app.workspaceRestoreLabel')}</p>
                <h3 className="mt-1 text-2xl font-semibold text-foreground">{t('app.workspaceRestoreTitle')}</h3>
              </div>
            </div>

            <div className="mt-6 space-y-5">
              <div className="flex items-center justify-between text-sm text-muted-foreground" aria-live="polite">
                <span>
                  {currentRestoreTarget
                    ? t('app.reconnectingName', { name: currentRestoreTarget.name })
                    : t('app.preparingConnections')}
                </span>
                <span className="font-semibold text-foreground">
                  {restoringProgress.current} / {restoringProgress.total}
                </span>
              </div>

              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-gradient-to-r from-primary to-primary/70 transition-[width] duration-500 ease-out"
                  style={{ width: `${restoringPercent}%` }}
                />
              </div>

              {currentRestoreTarget && (
                <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{currentRestoreTarget.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {currentRestoreTarget.username ? `${currentRestoreTarget.username}@` : ''}
                      {currentRestoreTarget.host || t('app.unknownHost')}
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                {restoreHighlights.map(({ icon: Icon, label }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 p-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-background text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <span className="text-xs leading-tight">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Web menu bar – on macOS shows only layout controls (native system menu handles File/Edit); on Windows/Linux shows full menus */}
      <MenuBar
        onNewConnection={handleNewTab}
        onNewTab={handleNewTab}
        onCloseConnection={handleCloseActiveTab}
        onNextTab={() => {
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (currentIndex < activeGroup.tabs.length - 1) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[currentIndex + 1].id });
            }
          }
        }}
        onPreviousTab={() => {
          if (activeGroup && activeGroup.tabs.length > 1 && activeGroup.activeTabId) {
            const currentIndex = activeGroup.tabs.findIndex(t => t.id === activeGroup.activeTabId);
            if (currentIndex > 0) {
              dispatch({ type: 'ACTIVATE_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[currentIndex - 1].id });
            }
          }
        }}
        onCloneTab={() => {
          if (activeTab) {
            void handleDuplicateTab(activeTab.id);
          }
        }}
        onCopy={() => runActiveTerminalCommand('copy')}
        onPaste={() => runActiveTerminalCommand('paste')}
        onSelectAll={() => runActiveTerminalCommand('select-all')}
        onFind={() => runActiveTerminalCommand('find')}
        onFindNext={() => runActiveTerminalCommand('find-next')}
        onFindPrevious={() => runActiveTerminalCommand('find-previous')}
        onClearScreen={() => runActiveTerminalCommand('clear-screen')}
        onOpenSettings={handleOpenSettings}
        onOpenTool={handleOpenTool}
        closeConnectionShortcutLabel={keyboardShortcutSettings.closeTab}
        nextTabShortcutLabel={keyboardShortcutSettings.nextTab}
        previousTabShortcutLabel={keyboardShortcutSettings.prevTab}
        hasActiveConnection={!!activeTab}
        hasActiveTerminal={activeTerminalId !== null}
        canPaste={activeTab?.connectionStatus === 'connected'}
        onToggleLeftSidebar={toggleLeftSidebar}
        onToggleRightSidebar={toggleRightSidebar}
        onToggleBottomPanel={toggleBottomPanel}
        onToggleZenMode={toggleZenMode}
        onApplyPreset={applyPreset}
        leftSidebarVisible={layout.leftSidebarVisible}
        rightSidebarVisible={layout.rightSidebarVisible && hasAnyTabs && !hideExtraPanels}
        bottomPanelVisible={layout.bottomPanelVisible && !hideExtraPanels}
        zenMode={layout.zenMode}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Page directory bar (toggle via the layout shortcut / menu) */}
        {layout.leftSidebarVisible && <ToolboxNav section={section} onSelect={setSection} />}

        {/*
          All workspace views stay mounted — switching sections only toggles
          visibility. This keeps SSH/PTY sessions alive and preserves tool
          state (e.g. the unlocked vault) across navigation.
        */}
        <div className="flex-1 min-w-0 relative overflow-hidden">
          {/* ── Terminal workspace (always mounted) ── */}
          <div className={cn('absolute inset-0', section === 'terminal' ? '' : 'hidden')}>
            {hasAnyTabs ? (
              <div className="h-full w-full flex overflow-hidden">
                <LogMonitorStateProvider>
                <ResizablePanelGroup direction="horizontal" autoSaveId="nexterm-terminal-layout" className="flex-1">
                  {/* Terminal + optional bottom file browser */}
                  <ResizablePanel
                    id="terminal-main"
                    order={1}
                    defaultSize={100 - ((layout.rightSidebarVisible && activeConnection && !hideExtraPanels) ? layout.rightSidebarSize : 0)}
                    minSize={30}
                  >
                    <ResizablePanelGroup direction="vertical" className="h-full">
                      {/* Terminal Grid Panel */}
                      <ResizablePanel id="terminal-grid" order={1} defaultSize={layout.bottomPanelVisible ? 70 : 100} minSize={30}>
                        <TerminalCallbacksProvider value={{
                          onDuplicateTab: handleDuplicateTab,
                          onNewTab: handleNewTab,
                          onReconnectTab: handleReconnect,
                          closeTabShortcut: keyboardShortcutSettings.closeTab,
                          onWorkingDirectoryChange: handleWorkingDirectoryChange,
                          getWorkingDirectory,
                        }}>
                          <ErrorBoundary label="Terminal">
                            <GridRenderer node={state.gridLayout} path={[]} />
                          </ErrorBoundary>
                        </TerminalCallbacksProvider>
                      </ResizablePanel>

                      {layout.bottomPanelVisible && !hideExtraPanels && activeConnection && (
                        <>
                          <ResizableHandle />

                          {/* File Browser Panel - uses activeConnection from context */}
                          <ResizablePanel
                            id="file-browser"
                            order={2}
                            defaultSize={layout.bottomPanelSize}
                            minSize={20}
                            maxSize={50}
                            onResize={(size) => setBottomPanelSize(size)}
                          >
                            <ErrorBoundary label="File Browser">
                              <IntegratedFileBrowser
                              connectionId={activeConnection.connectionId}
                              host={activeConnection.host}
                              isConnected={activeConnection.status === 'connected'}
                              terminalWorkingDirectory={terminalWorkingDirectories[activeConnection.connectionId]}
                              onClose={() => {}}
                              onOpenInLogMonitor={handleOpenInLogMonitor}
                              onOpenInEditor={handleOpenInEditor}
                            />
                            </ErrorBoundary>
                          </ResizablePanel>
                        </>
                      )}
                    </ResizablePanelGroup>
                  </ResizablePanel>

                  {layout.rightSidebarVisible && activeConnection && !hideExtraPanels && (
                    <>
                      <ResizableHandle />

                      {/* Right Sidebar - Monitor/Logs using activeConnection from context */}
                      <ResizablePanel
                        id="right-sidebar"
                        order={2}
                        defaultSize={layout.rightSidebarSize}
                        minSize={15}
                        maxSize={30}
                        onResize={(size) => setRightSidebarSize(size)}
                      >
                        <Tabs value={rightSidebarTab} onValueChange={setRightSidebarTab} className="h-full flex flex-col">
                          <TabsList className="inline-flex w-auto mx-1 mt-2">
                            <TabsTrigger value="monitor" className="text-xs px-2">{t('app.monitor')}</TabsTrigger>
                            <TabsTrigger value="logs" className="text-xs px-2">{t('app.logs')}</TabsTrigger>
                            {rightSidebarTab === 'logs' && activeConnection && (
                              <button
                                type="button"
                                className="ml-auto inline-flex items-center justify-center rounded px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                onClick={() => setLogsFloating(true)}
                                title={t('app.floatLogs')}
                              >
                                <Maximize2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </TabsList>

                          <div className="flex-1 mt-0 overflow-hidden relative">
                            <TabsContent value="monitor" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                              <div className="h-full overflow-hidden px-1 py-2">
                                {activeConnection ? (
                                  <ErrorBoundary label={t('app.systemMonitor')}>
                                    <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{'...'}</div>}>
                                      <SystemMonitor connectionId={activeConnection.connectionId} />
                                    </Suspense>
                                  </ErrorBoundary>
                                ) : null}
                              </div>
                            </TabsContent>

                            <TabsContent value="logs" forceMount className="absolute inset-0 mt-0 data-[state=inactive]:hidden">
                              {activeConnection ? (
                                <ErrorBoundary label={t('app.logMonitor')}>
                                  <LogMonitor
                                    connectionId={activeConnection.connectionId}
                                    externalLogPath={externalLogPath}
                                    externalLogPathKey={externalLogPathKey}
                                    isActive={!logsFloating}
                                  />
                                </ErrorBoundary>
                              ) : null}
                            </TabsContent>
                          </div>
                        </Tabs>
                      </ResizablePanel>

                      {/* Floating log viewer (detached from the sidebar tab) */}
                      <Dialog open={logsFloating} onOpenChange={(o) => { if (!o) setLogsFloating(false); }}>
                        <DialogContent className="top-[6vh] translate-y-0 sm:max-w-[80vw] h-[84vh] p-0 gap-0 flex flex-col overflow-hidden">
                          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                            <ScrollText className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-semibold">{t('app.logMonitor')}</span>
                            <span className="ml-auto text-[10px] text-muted-foreground truncate">
                              {activeConnection?.name}
                            </span>
                          </div>
                          <div className="flex-1 min-h-0 overflow-hidden">
                            {activeConnection ? (
                              <ErrorBoundary label={t('app.logMonitor')}>
                                <LogMonitor
                                  connectionId={activeConnection.connectionId}
                                  externalLogPath={externalLogPath}
                                  externalLogPathKey={externalLogPathKey}
                                  isActive={logsFloating}
                                />
                              </ErrorBoundary>
                            ) : (
                              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                                {t('app.noActiveConnection')}
                              </div>
                            )}
                          </div>
                        </DialogContent>
                      </Dialog>
                    </>
                  )}
                </ResizablePanelGroup>
                </LogMonitorStateProvider>
              </div>
            ) : (
              /* Terminal empty state — just a "New Connection" button */
              <div className="h-full w-full flex items-center justify-center p-8">
                <div className="text-center space-y-4 max-w-sm">
                  <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                    <Terminal className="h-8 w-8" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">{t('terminalEmpty.title')}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{t('terminalEmpty.desc')}</p>
                  </div>
                  <Button size="lg" onClick={() => handleNewTab()} className="gap-2 shadow-lg">
                    <Plus className="h-5 w-5" />
                    {t('serversView.new')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Tool views: code-split, suspended on first open ── */}
          <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground">{'...'}</div>}>
          {/* ── Servers view (always mounted) ── */}
          <div className={cn('absolute inset-0 bg-background', section === 'connection' ? '' : 'hidden')}>
            <ServersView
              onConnect={handleServerConnect}
              onNew={handleNewTab}
              onEdit={handleEditServer}
              activeConnections={activeConnectionIds}
              connectionSessions={connectionSessions}
              refreshTrigger={connectionSaveTrigger}
            />
          </div>

          {/* ── Tool views (always mounted, so vault unlock state persists) ── */}
          <div className={cn('absolute inset-0 bg-background', section === 'apps' ? '' : 'hidden')}>
            <ToolApps />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'vault' ? '' : 'hidden')}>
            <ToolVault />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'tunnels' ? '' : 'hidden')}>
            <ToolTunnels />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'services' ? '' : 'hidden')}>
            <ToolServices />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'notes' ? '' : 'hidden')}>
            <ToolNotes />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'history' ? '' : 'hidden')}>
            <ToolCommandHistory />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'documents' ? '' : 'hidden')}>
            <ToolDocuments />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'api' ? '' : 'hidden')}>
            <ToolApiDebug active={section === 'api'} />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'postgres' ? '' : 'hidden')}>
            <ToolPostgres />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'sqlite' ? '' : 'hidden')}>
            <ToolSqlite />
          </div>
          <div className={cn('absolute inset-0 bg-background', section === 'mysql' ? '' : 'hidden')}>
            <ToolMySql />
          </div>
          {section === 'jar' && (
            <div className="absolute inset-0 bg-background">
              <ToolJarDecompiler />
            </div>
          )}
          </Suspense>
        </div>
      </div>

      {(section === 'connection' || section === 'terminal') && (
        <StatusBar activeConnection={statusBarConnection} />
      )}

      {/* Modals */}
      <ConnectionDialog
        open={connectionDialogOpen}
        onOpenChange={(open) => {
          setConnectionDialogOpen(open);
          if (!open) {
            setConnectionInitialFolder(undefined);
            setEditingConnection(null);
            setConnectionSaveTrigger(t => t + 1);
          }
        }}
        onConnect={handleConnectionDialogConnect}
        onSave={handleSaveConnection}
        editingConnection={editingConnection}
        initialFolder={connectionInitialFolder}
      />

      <SettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        onAppearanceChange={() => {
          // Appearance changes are handled by individual PtyTerminal instances
          // via their own settings listeners in TerminalGroupView
        }}
      />

      <Toaster richColors position="top-right" />
    </div>
  );
}

const SystemMonitor = lazy(() => import('./components/system-monitor').then((m) => ({ default: m.SystemMonitor })));

/** Full-screen loading state shown while SQLite stores hydrate (after unlock). */
function AppStorageLoading() {
  const { t } = useTranslation();
  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
        <span className="text-sm">{t('app.loadingWorkspace')}</span>
      </div>
    </div>
  );
}

export default function App() {
  // App lock and storage hydration live ABOVE the workspace tree so that
  // TerminalGroupProvider (and every hook in AppContent) only mounts after the
  // SQLite stores are hydrated. Mounting the provider during the lock screen
  // used to initialize the reducer with a default layout and, on the first
  // dispatch, overwrite the persisted workspace tables (see audit P0-1/P0-2).
  const [appLocked, setAppLocked] = useState<boolean>(true);
  const [storageReady, setStorageReady] = useState(false);

  // After the lock screen is passed, hydrate every SQLite-backed store before
  // the workspace renders (a short loading state avoids empty-cache flashes).
  useEffect(() => {
    if (appLocked || storageReady) return;
    let cancelled = false;
    void initializeAllStorage()
      .catch(() => {
        /* a failing store degrades to its legacy fallback */
      })
      .finally(() => {
        if (!cancelled) setStorageReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [appLocked, storageReady]);

  // Prefetch code-split tool views during idle time so switching to any tool
  // is instant — no "click then load" flash. Desktop assets are local, so the
  // background fetch is cheap and the lazy() load() promises resolve before
  // the user opens a tool, keeping the main entry small while UX stays snappy.
  useEffect(() => {
    const prefetch = () => {
      void import('./components/toolbox/servers-view');
      void import('./components/toolbox/tool-apps');
      void import('./components/toolbox/tool-vault');
      void import('./components/toolbox/tool-tunnels');
      void import('./components/toolbox/tool-services');
      void import('./components/toolbox/tool-notes');
      void import('./components/toolbox/tool-command-history');
      void import('./components/toolbox/tool-documents');
      void import('./components/toolbox/tool-api-debug');
      void import('./components/toolbox/tool-postgres');
      void import('./components/toolbox/tool-sqlite');
      void import('./components/toolbox/tool-mysql');
      void import('./components/toolbox/tool-jar-decompiler');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetch, { timeout: 1500 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(prefetch, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  // Password gate — no application UI before the password is verified.
  if (appLocked) {
    return (
      <ErrorBoundary label="NexTerm Lock">
        <AppLockScreen onUnlock={() => setAppLocked(false)} />
      </ErrorBoundary>
    );
  }

  // Storage gate — hydrate SQLite-backed caches before the workspace mounts.
  if (!storageReady) {
    return <AppStorageLoading />;
  }

  return (
    <ErrorBoundary label="NexTerm">
      <LayoutProvider>
        <TerminalGroupProvider>
          <AppContent />
        </TerminalGroupProvider>
      </LayoutProvider>
    </ErrorBoundary>
  );
}
