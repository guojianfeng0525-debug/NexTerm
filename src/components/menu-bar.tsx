import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuLabel
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { ConnectionStorageManager, type ConnectionData } from '@/lib/connection-storage';
import { DEFAULT_LAYOUT_SHORTCUTS, formatKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import {
  Plus,
  FolderOpen,
  Save,
  X,
  Copy,
  Clipboard,
  Search,
  Settings,
  RefreshCw,
  Download,
  Scissors,
  ArrowRight,
  ArrowLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelBottomClose,
  PanelBottomOpen,
  Maximize2,
  LayoutGrid,
  AppWindow,
  KeyRound,
  ArrowLeftRight,
  Server,
  StickyNote,
} from 'lucide-react';
import type { ToolboxViewId } from '@/lib/toolbox/toolbox-types';

interface MenuBarProps {
  onNewConnection?: () => void;
  onOpenConnection?: () => void;
  onSaveConnection?: () => void;
  onCloseConnection?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onFind?: () => void;
  onFindNext?: () => void;
  onFindPrevious?: () => void;
  onClearScreen?: () => void;
  onToggleConnectionManager?: () => void;
  onToggleSystemMonitor?: () => void;
  onToggleFullscreen?: () => void;
  onOpenSettings?: () => void;
  onOpenSFTP?: () => void;
  onOpenTool?: (view: ToolboxViewId) => void;
  onNewTab?: () => void;
  onCloneTab?: () => void;
  onNextTab?: () => void;
  onPreviousTab?: () => void;
  closeConnectionShortcutLabel?: string;
  nextTabShortcutLabel?: string;
  previousTabShortcutLabel?: string;
  onRecentConnectionSelect?: (connection: ConnectionData) => void;
  hasActiveConnection?: boolean;
  hasActiveTerminal?: boolean;
  canPaste?: boolean;
  // Layout controls (VS Code-style, right-aligned)
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  onToggleBottomPanel?: () => void;
  onToggleZenMode?: () => void;
  onApplyPreset?: (preset: string) => void;
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  bottomPanelVisible?: boolean;
  zenMode?: boolean;
}

export function MenuBar({
  onNewConnection,
  onOpenConnection,
  onSaveConnection,
  onCloseConnection,
  onCopy,
  onPaste,
  onSelectAll,
  onFind,
  onFindNext,
  onFindPrevious,
  onClearScreen,
  onToggleConnectionManager: _onToggleConnectionManager,
  onToggleSystemMonitor: _onToggleSystemMonitor,
  onToggleFullscreen: _onToggleFullscreen,
  onOpenSettings,
  onOpenSFTP: _onOpenSFTP,
  onOpenTool,
  onNewTab,
  onCloneTab,
  onNextTab,
  onPreviousTab,
  closeConnectionShortcutLabel,
  nextTabShortcutLabel,
  previousTabShortcutLabel,
  onRecentConnectionSelect,
  hasActiveConnection = false,
  hasActiveTerminal,
  canPaste = true,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onToggleBottomPanel,
  onToggleZenMode,
  onApplyPreset,
  leftSidebarVisible,
  rightSidebarVisible,
  bottomPanelVisible,
  zenMode,
}: MenuBarProps) {
  const { t } = useTranslation();
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const formatShortcut = (shortcut: string) => formatKeyboardShortcut(shortcut, isMac);
  const terminalActionsAvailable = hasActiveTerminal ?? hasActiveConnection;

  // Load recent connections
  const [recentConnections, setRecentConnections] = useState<ConnectionData[]>([]);

  useEffect(() => {
    // Load recent connections on mount and whenever the component updates
    const loadRecentConnections = () => {
      const connections = ConnectionStorageManager.getRecentConnections(5); // Get top 5 recent connections
      setRecentConnections(connections);
    };

    loadRecentConnections();

    // Listen for storage changes to update recent connections
    const handleStorageChange = () => {
      loadRecentConnections();
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const handleDragRegionDoubleClick = useCallback(() => {
    // On non-macOS, data-tauri-drag-region doesn't zoom on double-click, so we do it manually
    if (!isMac) {
      void getCurrentWindow().toggleMaximize();
    }
  }, [isMac]);

  return (
    <div
      className="border-b border-border bg-background py-1 flex items-center gap-1"
      style={{ paddingLeft: isMac ? '80px' : '8px' }}
    >
      {/* Menu dropdowns — hidden on macOS because native system menu bar handles these */}
      {!isMac && (
        <>
      {/* ── Servers menu — connection & app-level actions ── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('menuBar.servers')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewConnection}>
            <Plus className="mr-2 h-4 w-4" />
            {t('menuBar.newConnection')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+N')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenConnection}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {t('menuBar.openConnection')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+O')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Download className="mr-2 h-4 w-4" />
              {t('menuBar.recentConnections')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {recentConnections.length > 0 ? (
                recentConnections.map(connection => (
                  <DropdownMenuItem
                    key={connection.id}
                    onClick={() => onRecentConnectionSelect?.(connection)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{connection.name}</span>
                      <span className="text-xs text-muted-foreground">({connection.username}@{connection.host})</span>
                    </span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>
                  <span className="text-muted-foreground">{t('menuBar.noRecentConnections')}</span>
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSaveConnection} disabled={!hasActiveConnection}>
            <Save className="mr-2 h-4 w-4" />
            {t('menuBar.saveConnection')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+S')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <Save className="mr-2 h-4 w-4" />
            {t('menuBar.saveConnectionAs')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+Shift+S')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCloseConnection} disabled={!hasActiveConnection}>
            <X className="mr-2 h-4 w-4" />
            {t('menuBar.closeConnection')}
            <DropdownMenuShortcut>{formatShortcut(closeConnectionShortcutLabel ?? 'Ctrl+W')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 h-4 w-4" />
            {t('menuBar.options')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <X className="mr-2 h-4 w-4" />
            {t('menuBar.exit')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+Q')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Terminal menu — session & terminal editing actions ── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('menuBar.terminal')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onNewTab}>
            <Plus className="mr-2 h-4 w-4" />
            {t('menuBar.newTab')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+T')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCloneTab} disabled={!hasActiveConnection}>
            <Copy className="mr-2 h-4 w-4" />
            {t('menuBar.duplicateTab')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+D')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNextTab} disabled={!hasActiveConnection}>
            <ArrowRight className="mr-2 h-4 w-4" />
            {t('menuBar.nextTab')}
            <DropdownMenuShortcut>{formatShortcut(nextTabShortcutLabel ?? 'Ctrl+Tab')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPreviousTab} disabled={!hasActiveConnection}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('menuBar.previousTab')}
            <DropdownMenuShortcut>{formatShortcut(previousTabShortcutLabel ?? 'Ctrl+Shift+Tab')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('menuBar.reconnect')}
            <DropdownMenuShortcut>F5</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasActiveConnection}>
            <X className="mr-2 h-4 w-4" />
            {t('menuBar.disconnect')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCopy} disabled={!terminalActionsAvailable || !onCopy}>
            <Copy className="mr-2 h-4 w-4" />
            {t('menuBar.copy')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+C')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPaste} disabled={!terminalActionsAvailable || !canPaste || !onPaste}>
            <Clipboard className="mr-2 h-4 w-4" />
            {t('menuBar.paste')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+V')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <Scissors className="mr-2 h-4 w-4" />
            {t('menuBar.cut')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+X')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onSelectAll} disabled={!terminalActionsAvailable || !onSelectAll}>
            {t('menuBar.selectAll')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+A')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onFind} disabled={!terminalActionsAvailable || !onFind}>
            <Search className="mr-2 h-4 w-4" />
            {t('menuBar.find')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+F')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onFindNext} disabled={!terminalActionsAvailable || !onFindNext}>
            <Search className="mr-2 h-4 w-4" />
            {t('menuBar.findNext')}
            <DropdownMenuShortcut>F3</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onFindPrevious} disabled={!terminalActionsAvailable || !onFindPrevious}>
            <Search className="mr-2 h-4 w-4" />
            {t('menuBar.findPrevious')}
            <DropdownMenuShortcut>{formatShortcut('Shift+F3')}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onClearScreen} disabled={!terminalActionsAvailable || !onClearScreen}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('menuBar.clearScreen')}
            <DropdownMenuShortcut>{formatShortcut('Ctrl+L')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Toolbox menus — one top-level menu per tool ── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('toolbox.apps.title')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpenTool?.('apps')}>
            <AppWindow className="mr-2 h-4 w-4" />
            {t('toolbox.apps.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('toolbox.vault.title')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpenTool?.('vault')}>
            <KeyRound className="mr-2 h-4 w-4" />
            {t('toolbox.vault.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('toolbox.tunnels.title')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpenTool?.('tunnels')}>
            <ArrowLeftRight className="mr-2 h-4 w-4" />
            {t('toolbox.tunnels.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('toolbox.services.title')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpenTool?.('services')}>
            <Server className="mr-2 h-4 w-4" />
            {t('toolbox.services.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">{t('toolbox.notes.title')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpenTool?.('notes')}>
            <StickyNote className="mr-2 h-4 w-4" />
            {t('toolbox.notes.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

        </> /* end !isMac menu dropdowns */
      )}

      {/* Drag region spacer — fills all empty horizontal space so the user can drag the window */}
      <div
        className="flex-1 h-full min-h-[28px] min-w-0 cursor-default"
        data-tauri-drag-region
        onDoubleClick={handleDragRegionDoubleClick}
      />

      {/* Layout controls — VS Code style, right-aligned */}
      <div className="flex items-center gap-0.5 pr-1">
        <TooltipProvider>
          <Separator orientation="vertical" className="h-4 mx-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleLeftSidebar}>
                {leftSidebarVisible
                  ? <PanelLeftClose className="w-4 h-4" />
                  : <PanelLeftOpen className="w-4 h-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              <span>{t(leftSidebarVisible ? 'common.hide' : 'common.show')} {t('menuBar.toggleDirectoryBar')}</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {formatShortcut(DEFAULT_LAYOUT_SHORTCUTS.toggleLeftSidebar)}
              </kbd>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleBottomPanel}>
                {bottomPanelVisible
                  ? <PanelBottomClose className="w-4 h-4" />
                  : <PanelBottomOpen className="w-4 h-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              <span>{t(bottomPanelVisible ? 'common.hide' : 'common.show')} {t('menuBar.toggleFileBrowser')}</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {formatShortcut(DEFAULT_LAYOUT_SHORTCUTS.toggleBottomPanel)}
              </kbd>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onToggleRightSidebar}>
                {rightSidebarVisible
                  ? <PanelRightClose className="w-4 h-4" />
                  : <PanelRightOpen className="w-4 h-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              <span>{t(rightSidebarVisible ? 'common.hide' : 'common.show')} {t('menuBar.toggleMonitorPanel')}</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {formatShortcut(DEFAULT_LAYOUT_SHORTCUTS.toggleRightSidebar)}
              </kbd>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`h-7 w-7 p-0 ${zenMode ? 'bg-accent' : ''}`}
                onClick={onToggleZenMode}
              >
                <Maximize2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              <span>{t('menuBar.toggleZenMode')}</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {formatShortcut(DEFAULT_LAYOUT_SHORTCUTS.toggleZenMode)}
              </kbd>
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <LayoutGrid className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('menuBar.layoutPresets')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('menuBar.layoutPresets')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onApplyPreset?.('Default')}>{t('menuBar.defaultLayout')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onApplyPreset?.('Minimal')}>{t('menuBar.minimalTerminalOnly')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onApplyPreset?.('Focus Mode')}>{t('menuBar.focusMode')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onApplyPreset?.('Full Stack')}>{t('menuBar.fullStackAllPanels')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onApplyPreset?.('Zen Mode')}>{t('menuBar.zenMode')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onOpenSettings}>
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.options')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
