import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { TunnelsStorage, generateId } from '@/lib/toolbox/toolbox-storage';
import type { TunnelConfig, TunnelActivity } from '@/lib/toolbox/toolbox-types';
import {
  ArrowLeftRight,
  Plus,
  Play,
  Square,
  Pencil,
  Trash2,
  MoreVertical,
  Radio,
  Activity,
  Server,
} from 'lucide-react';

interface TunnelFormState {
  name: string;
  group: string;
  bindAddress: string;
  listenPort: string;
  remoteHost: string;
  remotePort: string;
  jumpHost: string;
  jumpPort: string;
  jumpUsername: string;
  jumpPassword: string;
  description: string;
}

const EMPTY_FORM: TunnelFormState = {
  name: '',
  group: '',
  bindAddress: '127.0.0.1',
  listenPort: '',
  remoteHost: '',
  remotePort: '',
  jumpHost: '',
  jumpPort: '22',
  jumpUsername: '',
  jumpPassword: '',
  description: '',
};

const MAX_ACTIVITY = 50;

function parsePort(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function ToolTunnels() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<TunnelConfig[]>(() => TunnelsStorage.load());
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelConfig | null>(null);
  const [form, setForm] = useState<TunnelFormState>({ ...EMPTY_FORM });
  const [deleteTarget, setDeleteTarget] = useState<TunnelConfig | null>(null);
  const [activity, setActivity] = useState<Record<string, TunnelActivity[]>>({});
  const [groupFilter, setGroupFilter] = useState('');

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const c of configs) if (c.group) set.add(c.group);
    return Array.from(set);
  }, [configs]);

  const visibleConfigs = useMemo(() => {
    if (!groupFilter) return configs;
    return configs.filter((c) => c.group === groupFilter);
  }, [configs, groupFilter]);

  const visibleRunningCount = useMemo(
    () => visibleConfigs.filter((c) => runningIds.has(c.id)).length,
    [visibleConfigs, runningIds],
  );
  const unlistenRef = useRef<UnlistenFn[]>([]);

  // Persist configs
  useEffect(() => {
    TunnelsStorage.save(configs);
  }, [configs]);

  // Sync running state from backend on mount
  useEffect(() => {
    void (async () => {
      try {
        const running = await invoke<{ id: string; active: boolean }[]>('tunnel_list');
        setRunningIds(new Set(running.map((r) => r.id)));
      } catch {
        // Backend unavailable (browser preview) — ignore
      }
    })();
  }, []);

  // Subscribe to tunnel events
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const register = (eventName: string, kind: 'activity' | 'error') => {
      void listen<{ id: string; message: string }>(eventName, (event) => {
        const { id, message } = event.payload;
        setActivity((prev) => {
          const list = prev[id] ?? [];
          const next = [...list, { id, message, timestamp: Date.now() }].slice(-MAX_ACTIVITY);
          return { ...prev, [id]: next };
        });
        if (kind === 'error') {
          toast.error(t('toolbox.tunnels.eventError'), { description: message });
        }
      }).then((fn) => unlisteners.push(fn));
    };
    register('tunnel://activity', 'activity');
    register('tunnel://error', 'error');
    unlistenRef.current = unlisteners;
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, [t]);

  const openAdd = useCallback(() => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((config: TunnelConfig) => {
    setEditing(config);
    setForm({
      name: config.name,
      group: config.group ?? '',
      bindAddress: config.bindAddress,
      listenPort: String(config.listenPort),
      remoteHost: config.remoteHost,
      remotePort: String(config.remotePort),
      jumpHost: config.jumpHost ?? '',
      jumpPort: String(config.jumpPort ?? 22),
      jumpUsername: config.jumpUsername ?? '',
      jumpPassword: config.jumpPassword ?? '',
      description: config.description ?? '',
    });
    setFormOpen(true);
  }, []);

  const handleSave = useCallback(() => {
    const listenPort = parsePort(form.listenPort);
    const remotePort = parsePort(form.remotePort);
    if (!form.name.trim() || !form.remoteHost.trim()) {
      toast.error(t('toolbox.tunnels.formIncomplete'), {
        description: t('toolbox.tunnels.formIncompleteDesc'),
      });
      return;
    }
    if (listenPort === null || remotePort === null) {
      toast.error(t('toolbox.tunnels.invalidPort'));
      return;
    }
    if (!form.bindAddress.trim()) {
      toast.error(t('toolbox.tunnels.invalidBind'));
      return;
    }
    const now = Date.now();
    const config: TunnelConfig = {
      id: editing?.id ?? generateId('tunnel'),
      name: form.name.trim(),
      group: form.group.trim() || undefined,
      bindAddress: form.bindAddress.trim(),
      listenPort,
      remoteHost: form.remoteHost.trim(),
      remotePort,
      jumpHost: form.jumpHost.trim() || undefined,
      jumpPort: form.jumpHost.trim() ? parsePort(form.jumpPort) ?? 22 : undefined,
      jumpUsername: form.jumpHost.trim() ? form.jumpUsername.trim() || undefined : undefined,
      jumpPassword: form.jumpHost.trim() ? form.jumpPassword : undefined,
      description: form.description.trim() || undefined,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    setConfigs(TunnelsStorage.upsert(config));
    setFormOpen(false);
    toast.success(editing ? t('toolbox.tunnels.updated') : t('toolbox.tunnels.added'), {
      description: config.name,
    });
  }, [editing, form, t]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    if (runningIds.has(deleteTarget.id)) {
      void invoke('tunnel_stop', { id: deleteTarget.id }).catch(() => undefined);
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
    }
    setConfigs(TunnelsStorage.remove(deleteTarget.id));
    toast.success(t('toolbox.tunnels.deleted'), { description: deleteTarget.name });
    setDeleteTarget(null);
  }, [deleteTarget, runningIds, t]);

  const handleStart = useCallback(
    async (config: TunnelConfig) => {
      setBusyId(config.id);
      try {
        await invoke('tunnel_start', {
          request: {
            id: config.id,
            name: config.name,
            bind_address: config.bindAddress,
            listen_port: config.listenPort,
            remote_host: config.remoteHost,
            remote_port: config.remotePort,
            jump_host: config.jumpHost ?? null,
            jump_port: config.jumpPort ?? null,
            jump_username: config.jumpUsername ?? null,
            jump_password: config.jumpPassword ?? null,
          },
        });
        setRunningIds((prev) => new Set(prev).add(config.id));
        toast.success(t('toolbox.tunnels.started'), {
          description: `${config.bindAddress}:${config.listenPort} → ${config.remoteHost}:${config.remotePort}`,
        });
      } catch (error) {
        toast.error(t('toolbox.tunnels.startFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const handleStop = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await invoke('tunnel_stop', { id });
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.success(t('toolbox.tunnels.stopped'));
      } catch (error) {
        toast.error(t('toolbox.tunnels.stopFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const activeCount = useMemo(() => configs.filter((c) => runningIds.has(c.id)).length, [configs, runningIds]);

  const [batchBusy, setBatchBusy] = useState(false);

  const handleBatchStart = useCallback(async () => {
    const targets = visibleConfigs.filter((c) => !runningIds.has(c.id));
    if (targets.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    let fail = 0;
    for (const c of targets) {
      try {
        await invoke('tunnel_start', {
          request: {
            id: c.id, name: c.name, bind_address: c.bindAddress,
            listen_port: c.listenPort, remote_host: c.remoteHost, remote_port: c.remotePort,
            jump_host: c.jumpHost ?? null,
            jump_port: c.jumpPort ?? null,
            jump_username: c.jumpUsername ?? null,
            jump_password: c.jumpPassword ?? null,
          },
        });
        setRunningIds((prev) => new Set(prev).add(c.id));
        ok++;
      } catch {
        fail++;
      }
    }
    setBatchBusy(false);
    toast.success(t('toolbox.tunnels.batchStarted', { count: ok }), {
      description: fail > 0 ? t('toolbox.tunnels.batchFailed', { count: fail }) : undefined,
    });
  }, [visibleConfigs, runningIds, t]);

  const handleBatchStop = useCallback(async () => {
    const targets = visibleConfigs.filter((c) => runningIds.has(c.id));
    if (targets.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    for (const c of targets) {
      try {
        await invoke('tunnel_stop', { id: c.id });
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
        ok++;
      } catch {
        /* ignore */
      }
    }
    setBatchBusy(false);
    toast.success(t('toolbox.tunnels.batchStopped', { count: ok }));
  }, [visibleConfigs, runningIds, t]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-primary" />
            {t('toolbox.tunnels.title')}
            {activeCount > 0 && (
              <Badge variant="outline" className="text-[10px] text-success border-success/30 bg-success/10 gap-1">
                <Radio className="h-3 w-3" />
                {t('toolbox.tunnels.activeCount', { count: activeCount })}
              </Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('toolbox.tunnels.description')}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Select
            value={groupFilter}
            onValueChange={(v) => setGroupFilter(v === '__all__' ? '' : v)}
          >
            <SelectTrigger className="h-7 w-[110px] text-[11px]">
              <SelectValue placeholder={t('toolbox.tunnels.allGroups')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__" className="text-xs">{t('toolbox.tunnels.allGroups')}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={batchBusy} onClick={() => void handleBatchStart()}>
            <Play className="h-3.5 w-3.5" />
            {t('toolbox.tunnels.startAll')}
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={batchBusy || visibleRunningCount === 0} onClick={() => void handleBatchStop()}>
            <Square className="h-3.5 w-3.5" />
            {t('toolbox.tunnels.stopAll')}
          </Button>
          <Button size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('toolbox.tunnels.add')}
          </Button>
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {visibleConfigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border p-10 text-center">
              <div className="p-3 rounded-full bg-primary/10 text-primary">
                <ArrowLeftRight className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('toolbox.tunnels.empty')}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t('toolbox.tunnels.emptyDesc')}</p>
              </div>
              <Button size="sm" onClick={openAdd} className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('toolbox.tunnels.addFirst')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleConfigs.map((config) => {
                const isRunning = runningIds.has(config.id);
                const isBusy = busyId === config.id;
                const tunnelActivity = activity[config.id] ?? [];
                return (
                  <div
                    key={config.id}
                    className="rounded-xl border border-border bg-card p-4 space-y-3 transition-all hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
                            isRunning ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          <ArrowLeftRight className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-medium text-foreground truncate flex items-center gap-2">
                            {config.name}
                            <Badge
                              variant={isRunning ? 'default' : 'secondary'}
                              className={`text-[10px] gap-1 ${
                                isRunning
                                  ? 'bg-success/15 text-success border border-success/30'
                                  : ''
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-success animate-pulse' : 'bg-muted-foreground/50'}`}
                              />
                              {isRunning ? t('toolbox.tunnels.running') : t('toolbox.tunnels.stopped')}
                            </Badge>
                          </h4>
                          <p className="text-[11px] font-mono text-foreground/80 truncate">
                            <span className="text-primary">{config.bindAddress}:{config.listenPort}</span>
                            <span className="text-muted-foreground mx-1">→</span>
                            {config.remoteHost}:{config.remotePort}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isRunning ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            disabled={isBusy}
                            onClick={() => void handleStop(config.id)}
                          >
                            <Square className="h-3.5 w-3.5" />
                            {t('toolbox.tunnels.stop')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            disabled={isBusy}
                            onClick={() => void handleStart(config)}
                          >
                            <Play className="h-3.5 w-3.5" />
                            {t('toolbox.tunnels.start')}
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                              aria-label={t('common.more')}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[140px]">
                            <DropdownMenuItem onClick={() => openEdit(config)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteTarget(config)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {config.description && (
                      <p className="text-xs text-muted-foreground">{config.description}</p>
                    )}

                    {tunnelActivity.length > 0 && (
                      <div className="rounded-lg bg-muted/50 border border-border/60 px-3 py-2 max-h-28 overflow-y-auto">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                          <Activity className="h-3 w-3" />
                          {t('toolbox.tunnels.activity')}
                        </p>
                        <ul className="space-y-0.5">
                          {tunnelActivity.slice(-8).map((item, index) => (
                            <li key={`${item.timestamp}-${index}`} className="text-[11px] font-mono text-muted-foreground">
                              <span className="text-primary">{item.message}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Add / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('toolbox.tunnels.editTitle') : t('toolbox.tunnels.addTitle')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.tunnels.formDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tun-name">{t('toolbox.tunnels.name')}</Label>
                <Input
                  id="tun-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('toolbox.tunnels.namePlaceholder')}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tun-group">{t('toolbox.tunnels.group')}</Label>
                <Input
                  id="tun-group"
                  value={form.group}
                  onChange={(e) => setForm((f) => ({ ...f, group: e.target.value }))}
                  placeholder={t('toolbox.tunnels.groupPlaceholder')}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('toolbox.tunnels.local')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tun-bind">{t('toolbox.tunnels.bindAddress')}</Label>
                  <Input
                    id="tun-bind"
                    value={form.bindAddress}
                    onChange={(e) => setForm((f) => ({ ...f, bindAddress: e.target.value }))}
                    placeholder="127.0.0.1"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tun-listen">{t('toolbox.tunnels.listenPort')}</Label>
                  <Input
                    id="tun-listen"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.listenPort}
                    onChange={(e) => setForm((f) => ({ ...f, listenPort: e.target.value }))}
                    placeholder="8080"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Server className="h-3 w-3" />
                {t('toolbox.tunnels.remote')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tun-host">{t('toolbox.tunnels.remoteHost')}</Label>
                  <Input
                    id="tun-host"
                    value={form.remoteHost}
                    onChange={(e) => setForm((f) => ({ ...f, remoteHost: e.target.value }))}
                    placeholder="example.com"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tun-remote-port">{t('toolbox.tunnels.remotePort')}</Label>
                  <Input
                    id="tun-remote-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.remotePort}
                    onChange={(e) => setForm((f) => ({ ...f, remotePort: e.target.value }))}
                    placeholder="3306"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Server className="h-3 w-3" />
                {t('toolbox.tunnels.jump')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tun-jump-host">{t('toolbox.tunnels.jumpHost')}</Label>
                  <Input
                    id="tun-jump-host"
                    value={form.jumpHost}
                    onChange={(e) => setForm((f) => ({ ...f, jumpHost: e.target.value }))}
                    placeholder="bastion.example.com"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tun-jump-port">{t('toolbox.tunnels.jumpPort')}</Label>
                  <Input
                    id="tun-jump-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.jumpPort}
                    onChange={(e) => setForm((f) => ({ ...f, jumpPort: e.target.value }))}
                    placeholder="22"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              {form.jumpHost.trim() && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="tun-jump-user">{t('toolbox.tunnels.jumpUsername')}</Label>
                    <Input
                      id="tun-jump-user"
                      value={form.jumpUsername}
                      onChange={(e) => setForm((f) => ({ ...f, jumpUsername: e.target.value }))}
                      placeholder={t('toolbox.tunnels.jumpUsernamePlaceholder')}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tun-jump-pass">{t('toolbox.tunnels.jumpPassword')}</Label>
                    <Input
                      id="tun-jump-pass"
                      type="password"
                      value={form.jumpPassword}
                      onChange={(e) => setForm((f) => ({ ...f, jumpPassword: e.target.value }))}
                      placeholder={t('toolbox.tunnels.jumpPasswordPlaceholder')}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tun-desc">{t('toolbox.tunnels.fieldDescription')}</Label>
              <Textarea
                id="tun-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t('toolbox.tunnels.descriptionPlaceholder')}
                className="min-h-[60px] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbox.tunnels.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.tunnels.deleteDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
