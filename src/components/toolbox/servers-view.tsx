import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ConnectionStorageManager,
  type ConnectionData,
  type ConnectionFolder,
} from '@/lib/connection-storage';
import { buildSshConnectRequest } from '@/lib/ssh-connect-request';
import { prefGet, prefSet } from '@/lib/preferences';
import type { TFunction } from 'i18next';
import {
  Server,
  Plus,
  Play,
  Pencil,
  Trash2,
  MoreVertical,
  FolderSync,
  ArrowUpDown,
  Monitor,
  Star,
  StarOff,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Search,
  Inbox,
  Cpu,
  MemoryStick,
  HardDrive,
  Copy,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ServersViewProps {
  /** Connect to a saved server by id. */
  onConnect: (connectionId: string) => void;
  /** Open the new-connection dialog, optionally pre-selecting a folder. */
  onNew: (folderPath?: string) => void;
  /** Open the edit dialog for a saved server. */
  onEdit: (connectionId: string) => void;
  /** Ids of currently connected sessions. */
  activeConnections: Set<string>;
  /** Map of saved connection id → live session id for resource queries. */
  connectionSessions: Record<string, string>;
  /** Increment to reload the list (e.g. after a save). */
  refreshTrigger?: number;
}

/** Selected scope in the directory tree: all, favorites, or a folder path. */
type TreeSelection = { kind: 'all' } | { kind: 'favorites' } | { kind: 'folder'; path: string };

const PROTOCOL_COLORS: Record<string, string> = {
  SSH: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  SFTP: 'bg-green-500/10 text-green-500 border-green-500/20',
  FTP: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  FTPS: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  RDP: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
  VNC: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
};

/** Live-session stats poll interval (connected servers). */
const RESOURCES_POLL_MS = 2000;
/** Cadence for re-probing reachable unconnected SSH/SFTP servers. */
const PROBE_INTERVAL_MS = 2000;
/** Backoff after a failed probe, so dead hosts are not hammered every tick. */
const PROBE_FAIL_BACKOFF_MS = 30_000;

interface ServerStats {
  cpu_percent: number;
  cores: number;
  memory: { total: number; used: number; free: number; available: number };
  disk: { total: string; used: string; available: string; use_percent: number };
  uptime: string;
  bandwidth?: { rx_bytes_per_sec: number; tx_bytes_per_sec: number };
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}


/** Compact progress bar used inside the 2×2 resource grid. */
function GradientBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={cn(
        'relative inline-block h-1.5 w-full min-w-[24px] shrink-0 overflow-hidden rounded-full border border-border/60 bg-muted-foreground/10',
        className,
      )}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${pct}%`,
          background: 'linear-gradient(to right, #22d3ee, #2563eb)',
        }}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function protocolIcon(protocol: string) {
  const proto = (protocol || 'SSH').toUpperCase();
  if (proto === 'SFTP') return <FolderSync className="h-4 w-4" />;
  if (proto === 'FTP' || proto === 'FTPS') return <ArrowUpDown className="h-4 w-4" />;
  if (proto === 'RDP' || proto === 'VNC') return <Monitor className="h-4 w-4" />;
  return <Server className="h-4 w-4" />;
}

function formatLastConnected(iso: string | undefined, t: TFunction<'translation', undefined>): string {
  if (!iso) return t('serversView.neverConnected');
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('serversView.justNow');
  if (diff < hour) return t('serversView.minutesAgo', { count: Math.floor(diff / minute) });
  if (diff < day) return t('serversView.hoursAgo', { count: Math.floor(diff / hour) });
  if (diff < 7 * day) return t('serversView.daysAgo', { count: Math.floor(diff / day) });
  return t('serversView.weeksAgo');
}

export function ServersView({
  onConnect,
  onNew,
  onEdit,
  activeConnections,
  connectionSessions,
  refreshTrigger = 0,
}: ServersViewProps) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<ConnectionFolder[]>(() => ConnectionStorageManager.getFolders());
  const [allServers, setAllServers] = useState<ConnectionData[]>(() => ConnectionStorageManager.getConnections());
  const [selection, setSelection] = useState<TreeSelection>({ kind: 'all' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ConnectionData | null>(null);
  const [selectedServer, setSelectedServer] = useState<ConnectionData | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<ConnectionFolder | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<ConnectionFolder | null>(null);
  const [renameFolderDialogOpen, setRenameFolderDialogOpen] = useState(false);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderParent, setFolderParent] = useState<string | undefined>(undefined);
  const [folderName, setFolderName] = useState('');
  const [showResources, setShowResources] = useState<boolean>(() =>
    Boolean(prefGet<unknown>('nexterm:toolbox:show-resources', false)),
  );
  const [resources, setResources] = useState<Record<string, ServerStats>>({});

  // Earliest allowed offline-probe retry per server id. Successful probes
  // schedule the next attempt after PROBE_INTERVAL_MS; failed probes back off
  // for PROBE_FAIL_BACKOFF_MS so dead hosts don't stall the poll loop.
  const nextProbeRef = useRef<Record<string, number>>({});

  const reload = useCallback(() => {
    setFolders(ConnectionStorageManager.getFolders());
    setAllServers(ConnectionStorageManager.getConnections());
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshTrigger]);

  // Refresh when connections change from elsewhere.
  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [reload]);

  // Persist the resources toggle across sessions (SQLite preferences table).
  useEffect(() => {
    prefSet('nexterm:toolbox:show-resources', showResources);
  }, [showResources]);

  // Poll live resource stats when the toggle is on. Connected servers reuse
  // their live session; unconnected SSH/SFTP servers are probed through a
  // short-lived SSH connection on the same 2-second cadence, with a 30s
  // backoff after failures. The probe reports all four metrics (CPU, memory,
  // disk, network). Results are merged so last-known values survive a tick.
  useEffect(() => {
    if (!showResources) {
      setResources({});
      return;
    }
    let cancelled = false;
    let busy = false;
    const fetchAll = async () => {
      if (busy) return;
      busy = true;
      const map: Record<string, ServerStats> = {};
      try {
        for (const server of allServers) {
          const sessionId = connectionSessions[server.id];
          if (sessionId) {
            try {
              const stats = await invoke<ServerStats>('get_system_stats', {
                connectionId: sessionId,
              });
              try {
                const bw = await invoke<{ success: boolean; bandwidth: { interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }[]; error?: string }>('get_network_bandwidth', {
                  connectionId: sessionId,
                });
                const ifaces = bw?.bandwidth ?? [];
                if (ifaces.length > 0) {
                  stats.bandwidth = {
                    rx_bytes_per_sec: ifaces.reduce((sum, i) => sum + (i.rx_bytes_per_sec ?? 0), 0),
                    tx_bytes_per_sec: ifaces.reduce((sum, i) => sum + (i.tx_bytes_per_sec ?? 0), 0),
                  };
                }
              } catch {
                /* bandwidth unavailable */
              }
              map[server.id] = stats;
            } catch {
              /* skip unreachable servers */
            }
            continue;
          }
          // Offline probe: SSH/SFTP only, silently skipped on failure.
          const proto = (server.protocol || 'SSH').toUpperCase();
          if (proto !== 'SSH' && proto !== 'SFTP') continue;
          const now = Date.now();
          if (now < (nextProbeRef.current[server.id] ?? 0)) continue;
          nextProbeRef.current[server.id] = now + PROBE_INTERVAL_MS;
          const conn = ConnectionStorageManager.getConnection(server.id);
          if (!conn) continue;
          try {
            const stats = await invoke<ServerStats>('probe_server_stats', {
              request: buildSshConnectRequest(server.id, conn),
            });
            map[server.id] = stats;
          } catch {
            // Back off before retrying an unreachable / rejected host.
            nextProbeRef.current[server.id] = Date.now() + PROBE_FAIL_BACKOFF_MS;
          }
        }
        if (!cancelled) setResources((prev) => ({ ...prev, ...map }));
      } finally {
        busy = false;
      }
    };
    void fetchAll();
    const timer = window.setInterval(() => void fetchAll(), RESOURCES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [showResources, allServers, connectionSessions]);

  /* ── scoped list ───────────────────────────────────────────────────────── */

  const scopedServers = useMemo(() => {
    switch (selection.kind) {
      case 'favorites':
        return ConnectionStorageManager.getFavorites();
      case 'folder':
        return ConnectionStorageManager.getConnectionsByFolderRecursive(selection.path);
      case 'all':
      default:
        return allServers;
    }
  }, [selection, allServers]);

  const visibleServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scopedServers;
    return scopedServers.filter((s) =>
      [s.name, s.host, s.username, s.protocol].join(' ').toLowerCase().includes(q),
    );
  }, [scopedServers, search]);

  const treeCounts = useMemo(() => {
    const all = allServers.length;
    const fav = ConnectionStorageManager.getFavorites().length;
    return { all, fav };
  }, [allServers]);

  /* ── folder tree helpers ────────────────────────────────────────────────── */

  const childFolders = useCallback(
    (parentPath: string | undefined) =>
      folders
        .filter((f) => (f.parentPath ?? undefined) === (parentPath ?? undefined))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders],
  );

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openNewFolder = useCallback((parentPath?: string) => {
    setFolderParent(parentPath);
    setFolderName('');
    setFolderDialogOpen(true);
  }, []);

  const handleCreateFolder = useCallback(() => {
    if (!folderName.trim()) {
      toast.error(t('serversView.folderNameRequired'));
      return;
    }
    ConnectionStorageManager.createFolder(folderName.trim(), folderParent);
    reload();
    setFolderDialogOpen(false);
    toast.success(t('serversView.folderCreated'), { description: folderName.trim() });
    if (folderParent) {
      setExpanded((prev) => new Set(prev).add(folderParent));
    }
  }, [folderName, folderParent, reload, t]);

  const handleDeleteFolder = useCallback(() => {
    if (!deleteFolderTarget) return;
    ConnectionStorageManager.deleteFolder(deleteFolderTarget.path, true);
    reload();
    toast.success(t('serversView.folderDeleted'), { description: deleteFolderTarget.name });
    setDeleteFolderTarget(null);
    if (selection.kind === 'folder' && selection.path === deleteFolderTarget.path) {
      setSelection({ kind: 'all' });
    }
  }, [deleteFolderTarget, reload, selection, t]);

  const handleRenameFolder = useCallback(() => {
    const target = renameFolderTarget;
    if (!target) return;
    const newName = renameFolderName.trim();
    if (!newName) {
      toast.error(t('serversView.folderNameRequired'));
      return;
    }
    if (!ConnectionStorageManager.renameFolder(target.path, newName)) {
      toast.error(t('serversView.folderRenameFailed'));
      return;
    }
    reload();
    setRenameFolderDialogOpen(false);
    setRenameFolderTarget(null);
    toast.success(t('serversView.folderRenamed'), { description: newName });
    if (selection.kind === 'folder' && selection.path === target.path) {
      setSelection({ kind: 'folder', path: target.parentPath
        ? `${target.parentPath}/${newName}`
        : newName });
    }
  }, [renameFolderTarget, renameFolderName, reload, selection, t]);

  /* ── server actions ─────────────────────────────────────────────────────── */

  const handleDeleteServer = useCallback(() => {
    if (!deleteTarget) return;
    ConnectionStorageManager.deleteConnection(deleteTarget.id);
    reload();
    toast.success(t('serversView.deleted'), { description: deleteTarget.name });
    setDeleteTarget(null);
  }, [deleteTarget, reload, t]);

  const toggleFavorite = useCallback((server: ConnectionData) => {
    ConnectionStorageManager.updateConnection(server.id, { favorite: !server.favorite });
    reload();
  }, [reload]);

  /** Duplicate a server (including its saved password) as a new entry. */
  const duplicateServer = useCallback(
    (server: ConnectionData) => {
      const { id: _id, createdAt: _createdAt, ...rest } = server;
      const copy = { ...rest, name: `${server.name} ${t('serversView.copySuffix')}` };
      const saved = ConnectionStorageManager.saveConnection(copy);
      reload();
      toast.success(t('serversView.duplicated'), { description: saved.name });
    },
    [reload, t],
  );

  // Plain recursive function (not memoized) so the self-reference is safe.
  function renderFolderTree(parentPath: string | undefined, level: number): React.ReactNode {
      const children = childFolders(parentPath);
      if (children.length === 0 && parentPath !== undefined) return null;
      return children.map((folder) => {
        const isExpanded = expanded.has(folder.path);
        const isSelected = selection.kind === 'folder' && selection.path === folder.path;
        const hasChildren = childFolders(folder.path).length > 0;
        return (
          <div key={folder.path}>
            <div
              className={cn(
                'group flex items-center gap-1 rounded-md py-1 pr-1 text-sm cursor-pointer select-none',
                isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60 text-foreground/90',
              )}
              style={{ paddingLeft: `${level * 14 + 4}px` }}
              onClick={() => setSelection({ kind: 'folder', path: folder.path })}
            >
              <button
                type="button"
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground',
                  !hasChildren && 'invisible',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(folder.path);
                }}
                aria-label={t('serversView.toggleFolder')}
              >
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
              )}
              <span className="flex-1 min-w-0 truncate">{folder.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('common.more')}
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[150px]">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openNewFolder(folder.path); }}>
                    <FolderPlus className="mr-2 h-4 w-4" />
                    {t('serversView.newSubfolder')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameFolderTarget(folder);
                      setRenameFolderName(folder.name);
                      setRenameFolderDialogOpen(true);
                    }}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    {t('serversView.renameFolder')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(e) => { e.stopPropagation(); setDeleteFolderTarget(folder); }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {isExpanded && renderFolderTree(folder.path, level + 1)}
          </div>
        );
      });
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            {t('serversView.title')}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {treeCounts.all}
            </Badge>
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('serversView.description')}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5" title={t('serversView.showResources')}>
            <span className="text-[11px] text-muted-foreground hidden lg:inline">{t('serversView.showResources')}</span>
            <Switch checked={showResources} onCheckedChange={setShowResources} />
          </div>
          <Button
            size="sm"
            onClick={() => onNew(selection.kind === 'folder' ? selection.path : undefined)}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            {t('serversView.new')}
          </Button>
        </div>
      </div>

      {/* Body: directory tree (left) + list (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── Directory tree ── */}
        <div className="w-56 shrink-0 border-r border-border flex flex-col bg-muted/20">
          <div className="px-2 pt-2 space-y-0.5">
            <button
              type="button"
              onClick={() => setSelection({ kind: 'all' })}
              className={cn(
                'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                selection.kind === 'all' ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60 text-foreground/90',
              )}
            >
              <Inbox className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{t('serversView.allConnections')}</span>
              <span className="text-[10px] text-muted-foreground">{treeCounts.all}</span>
            </button>
            <button
              type="button"
              onClick={() => setSelection({ kind: 'favorites' })}
              className={cn(
                'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                selection.kind === 'favorites' ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60 text-foreground/90',
              )}
            >
              <Star className="h-4 w-4 shrink-0 text-amber-400" />
              <span className="flex-1 text-left">{t('serversView.favorites')}</span>
              <span className="text-[10px] text-muted-foreground">{treeCounts.fav}</span>
            </button>
          </div>

          <div className="px-2 pt-3 pb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('serversView.folders')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => openNewFolder(undefined)}
              title={t('serversView.newFolder')}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="px-1 pb-2 space-y-0.5">
              {folders.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">{t('serversView.noFolders')}</p>
              ) : (
                renderFolderTree(undefined, 0)
              )}
            </div>
          </ScrollArea>
        </div>

        {/* ── Connection list ── */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('serversView.searchPlaceholder')}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">
              {visibleServers.length} / {scopedServers.length}
            </span>
          </div>

          <ScrollArea className="flex-1">
            {allServers.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 p-10 text-center">
                <div className="p-3 rounded-full bg-primary/10 text-primary">
                  <Server className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t('serversView.empty')}</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t('serversView.emptyDesc')}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => onNew(selection.kind === 'folder' ? selection.path : undefined)}
                  className="gap-1.5"
                >
                  <Plus className="h-4 w-4" />
                  {t('serversView.newFirst')}
                </Button>
              </div>
            ) : visibleServers.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-10">
                {t('serversView.noMatches')}
              </p>
            ) : (
              <div className="p-3 space-y-1">
                {visibleServers.map((server) => {
                  const isOnline = activeConnections.has(server.id);
                  const protocol = (server.protocol || 'SSH').toUpperCase();
                  return (
                    <div
                      key={server.id}
                      className={cn(
                        'group grid grid-cols-3 items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                        selectedServer?.id === server.id
                          ? 'border-primary/40 bg-card'
                          : 'border-transparent hover:border-border hover:bg-card',
                      )}
                      onClick={() => setSelectedServer(server)}
                    >
                      {/* Column 1 (1/3): icon + name + IP */}
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg shrink-0',
                            isOnline ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {protocolIcon(protocol)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-sm font-medium text-foreground truncate">{server.name}</span>
                            {server.favorite && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400 shrink-0" />}
                            <Badge variant="outline" className={cn('text-[10px] shrink-0', PROTOCOL_COLORS[protocol])}>
                              {protocol}
                            </Badge>
                          </div>
                          <p className="text-[11px] font-mono text-muted-foreground truncate">
                            {server.username ? `${server.username}@` : ''}
                            {server.host}:{server.port}
                          </p>
                        </div>
                      </div>

                      {/* Column 2 (1/3): resources in a 2×2 grid (CPU/MEM, DISK/bandwidth).
                          Rendered whenever the resource toggle is ON — connected
                          servers show live values, disconnected ones show a
                          placeholder so the three columns stay aligned. */}
                      <div className="min-w-0">
                        {showResources ? (
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 whitespace-nowrap text-[10px] text-muted-foreground font-mono">
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 min-w-0">
                                <Cpu className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {resources[server.id] ? `${resources[server.id].cores}${t('serversView.cores')} ${resources[server.id].cpu_percent.toFixed(0)}%` : '—'}
                                </span>
                              </span>
                              <GradientBar value={resources[server.id]?.cpu_percent ?? 0} />
                            </span>
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 min-w-0">
                                <MemoryStick className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {(() => {
                                    if (!resources[server.id]) return '—';
                                    const mem = resources[server.id].memory;
                                    const pct = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
                                    return `${formatBytes(mem.total * 1024 * 1024)} ${pct.toFixed(0)}%`;
                                  })()}
                                </span>
                              </span>
                              <GradientBar value={(() => {
                                if (!resources[server.id]) return 0;
                                const mem = resources[server.id].memory;
                                return mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
                              })()} />
                            </span>
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 min-w-0">
                                <HardDrive className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {resources[server.id] ? `${resources[server.id].disk.total} ${resources[server.id].disk.use_percent.toFixed(0)}%` : '—'}
                                </span>
                              </span>
                              <GradientBar value={resources[server.id]?.disk.use_percent ?? 0} />
                            </span>
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className="flex items-center gap-1 min-w-0">
                                <ArrowUpDown className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {resources[server.id]
                                    ? `↑${formatSpeed(resources[server.id].bandwidth?.tx_bytes_per_sec ?? -1)} ↓${formatSpeed(resources[server.id].bandwidth?.rx_bytes_per_sec ?? -1)}`
                                    : '—'}
                                </span>
                              </span>
                              <span className="h-1.5" />
                            </span>
                          </div>
                        ) : null}
                      </div>

                      {/* Column 3 (1/3): status + actions, right-aligned */}
                      <div className="flex items-center justify-end gap-2 min-w-0">
                        <span className="hidden md:flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                          <span className={cn('h-1.5 w-1.5 rounded-full', isOnline ? 'bg-success animate-pulse' : 'bg-muted-foreground/40')} />
                          {isOnline ? t('serversView.online') : t('serversView.offline')}
                        </span>
                        <span className="hidden lg:block text-[10px] text-muted-foreground max-w-[90px] truncate shrink-0">
                          {formatLastConnected(server.lastConnected, t)}
                        </span>

                      <Button
                        size="sm"
                        variant={isOnline ? 'outline' : 'default'}
                        className="h-7 gap-1 text-xs shrink-0"
                        disabled={isOnline}
                        onClick={(e) => {
                          e.stopPropagation();
                          onConnect(server.id);
                        }}
                      >
                        <Play className="h-3.5 w-3.5" />
                        {isOnline ? t('serversView.connected') : t('serversView.connect')}
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground transition-opacity shrink-0"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('common.more')}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[150px]">
                          <DropdownMenuItem onClick={() => onEdit(server.id)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => duplicateServer(server)}>
                            <Copy className="mr-2 h-4 w-4" />
                            {t('serversView.duplicate')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleFavorite(server)}>
                            {server.favorite ? (
                              <StarOff className="mr-2 h-4 w-4" />
                            ) : (
                              <Star className="mr-2 h-4 w-4" />
                            )}
                            {server.favorite ? t('serversView.unfavorite') : t('serversView.favorite')}
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(server)}>
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          {/* Selected server details */}
          {selectedServer && (
            <div className="border-t border-border bg-muted/20 p-3 shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h5 className="text-sm font-semibold text-foreground truncate">{selectedServer.name}</h5>
                <Badge
                  variant="outline"
                  className={cn('text-[10px] shrink-0', PROTOCOL_COLORS[(selectedServer.protocol || 'SSH').toUpperCase()])}
                >
                  {(selectedServer.protocol || 'SSH').toUpperCase()}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-muted-foreground shrink-0">{t('connectionDetails.host')}</span>
                  <span className="font-mono truncate">{selectedServer.host}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground shrink-0">{t('connectionDetails.port')}</span>
                  <span className="font-mono">{selectedServer.port}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground shrink-0">{t('connectionDetails.username')}</span>
                  <span className="font-mono truncate">{selectedServer.username || '—'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground shrink-0">{t('connectionDetails.lastConnected')}</span>
                  <span className="truncate">{formatLastConnected(selectedServer.lastConnected, t)}</span>
                </div>
              </div>
              {selectedServer.description && (
                <p className="text-xs text-muted-foreground">{selectedServer.description}</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={activeConnections.has(selectedServer.id)}
                  onClick={() => onConnect(selectedServer.id)}
                >
                  <Play className="h-3.5 w-3.5" />
                  {activeConnections.has(selectedServer.id) ? t('serversView.connected') : t('serversView.connect')}
                </Button>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onEdit(selectedServer.id)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('common.edit')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New folder dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('serversView.newFolder')}</DialogTitle>
            <DialogDescription>{t('serversView.newFolderDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="new-folder-name">{t('serversView.folderName')}</Label>
            <Input
              id="new-folder-name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
              }}
              placeholder={t('serversView.folderNamePlaceholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateFolder}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename folder dialog */}
      <Dialog open={renameFolderDialogOpen} onOpenChange={setRenameFolderDialogOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('serversView.renameFolderTitle')}</DialogTitle>
            <DialogDescription>{t('serversView.renameFolderDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="rename-folder-name">{t('serversView.folderName')}</Label>
            <Input
              id="rename-folder-name"
              value={renameFolderName}
              onChange={(e) => setRenameFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameFolder();
              }}
              placeholder={t('serversView.folderNamePlaceholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFolderDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRenameFolder}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder confirmation */}
      <AlertDialog open={!!deleteFolderTarget} onOpenChange={(open) => !open && setDeleteFolderTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('serversView.deleteFolderTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('serversView.deleteFolderDesc', { name: deleteFolderTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteFolder}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete server confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('serversView.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('serversView.deleteDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteServer}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
