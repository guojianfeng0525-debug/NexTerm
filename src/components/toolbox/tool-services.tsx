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
import { ServicesStorage, generateId } from '@/lib/toolbox/toolbox-storage';
import type { ServiceConfig, ServiceLogEntry } from '@/lib/toolbox/toolbox-types';
import {
  Server,
  Plus,
  Play,
  Square,
  Pencil,
  Trash2,
  MoreVertical,
  TerminalSquare,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { cn } from '@/lib/utils';

interface ServiceFormState {
  name: string;
  group: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
  description: string;
}

const EMPTY_FORM: ServiceFormState = { name: '', group: '', command: '', args: '', cwd: '', env: '', description: '' };

interface RunningInfo {
  pid?: number;
  startedAt?: number;
}

const MAX_FRONTEND_LOG_LINES = 500;

export function ToolServices() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ServiceConfig[]>(() => ServicesStorage.load());
  const [running, setRunning] = useState<Record<string, RunningInfo>>({});
  const [logs, setLogs] = useState<Record<string, ServiceLogEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceConfig | null>(null);
  const [form, setForm] = useState<ServiceFormState>({ ...EMPTY_FORM });
  const [deleteTarget, setDeleteTarget] = useState<ServiceConfig | null>(null);
  const logEndRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    ServicesStorage.save(configs);
  }, [configs]);

  // Sync running state + fetch existing logs from backend on mount
  useEffect(() => {
    void (async () => {
      try {
        const list = await invoke<{ id: string; running: boolean; pid?: number; startedAt?: number }[]>(
          'service_list',
        );
        const info: Record<string, RunningInfo> = {};
        for (const item of list) {
          info[item.id] = { pid: item.pid, startedAt: item.startedAt };
        }
        setRunning(info);
        for (const item of list) {
          try {
            const lines = await invoke<ServiceLogEntry[]>('service_logs', { id: item.id });
            if (lines.length > 0) {
              setLogs((prev) => ({ ...prev, [item.id]: lines }));
              setExpanded((prev) => new Set(prev).add(item.id));
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        // Backend unavailable (browser preview) — ignore
      }
    })();
  }, []);

  // Subscribe to service output events
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const register = (eventName: string, kind: 'output' | 'exited') => {
      void listen<{ id: string; line: string; stream: string }>(eventName, (event) => {
        const { id, line, stream } = event.payload;
        if (kind === 'output') {
          setLogs((prev) => {
            const list = prev[id] ?? [];
            const next = [...list, { stream: stream === 'stderr' ? 'stderr' as const : 'stdout' as const, line, timestamp: Date.now() }];
            return { ...prev, [id]: next.slice(-MAX_FRONTEND_LOG_LINES) };
          });
        } else {
          // process exited — clear running flag, keep logs
          setRunning((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      }).then((fn) => unlisteners.push(fn));
    };
    register('service://output', 'output');
    register('service://exited', 'exited');
    return () => {
      for (const fn of unlisteners) fn();
    };
  }, []);

  // Auto-scroll expanded log panels to the bottom on new output
  useEffect(() => {
    for (const [id, ref] of Object.entries(logEndRefs.current)) {
      if (ref && expanded.has(id)) {
        ref.scrollIntoView({ block: 'end' });
      }
    }
  }, [logs, expanded]);

  const pickCwd = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: true,
        title: t('toolbox.services.pickCwd'),
      });
      if (typeof selected === 'string' && selected) {
        setForm((f) => ({ ...f, cwd: selected }));
      }
    } catch {
      /* cancelled */
    }
  }, [t]);

  const openAdd = useCallback(() => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((config: ServiceConfig) => {
    setEditing(config);
    setForm({
      name: config.name,
      group: config.group ?? '',
      command: config.command,
      args: config.args ?? '',
      cwd: config.cwd ?? '',
      env: (config.env ?? []).join('\n'),
      description: config.description ?? '',
    });
    setFormOpen(true);
  }, []);

  const handleSave = useCallback(() => {
    if (!form.name.trim() || !form.command.trim()) {
      toast.error(t('toolbox.services.formIncomplete'), {
        description: t('toolbox.services.formIncompleteDesc'),
      });
      return;
    }
    const now = Date.now();
    const envLines = form.env
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='));
    const config: ServiceConfig = {
      id: editing?.id ?? generateId('service'),
      name: form.name.trim(),
      group: form.group.trim() || undefined,
      command: form.command.trim(),
      args: form.args.trim() || undefined,
      cwd: form.cwd.trim() || undefined,
      env: envLines.length > 0 ? envLines : undefined,
      description: form.description.trim() || undefined,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    setConfigs(ServicesStorage.upsert(config));
    setFormOpen(false);
    toast.success(editing ? t('toolbox.services.updated') : t('toolbox.services.added'), {
      description: config.name,
    });
  }, [editing, form, t]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    if (running[deleteTarget.id]) {
      void invoke('service_stop', { id: deleteTarget.id }).catch(() => undefined);
      setRunning((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
    }
    setConfigs(ServicesStorage.remove(deleteTarget.id));
    toast.success(t('toolbox.services.deleted'), { description: deleteTarget.name });
    setDeleteTarget(null);
  }, [deleteTarget, running, t]);

  const handleStart = useCallback(
    async (config: ServiceConfig) => {
      setBusyId(config.id);
      try {
        const status = await invoke<{ id: string; running: boolean; pid?: number; startedAt?: number }>(
          'service_start',
          {
            request: {
              id: config.id,
              name: config.name,
              command: config.command,
              args: config.args ?? null,
              cwd: config.cwd ?? null,
              env: config.env ?? null,
            },
          },
        );
        setRunning((prev) => ({
          ...prev,
          [config.id]: { pid: status.pid, startedAt: status.startedAt },
        }));
        setExpanded((prev) => new Set(prev).add(config.id));
        toast.success(t('toolbox.services.started'), { description: config.name });
      } catch (error) {
        toast.error(t('toolbox.services.startFailed'), {
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
        await invoke('service_stop', { id });
        setRunning((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        toast.success(t('toolbox.services.stopped'));
      } catch (error) {
        toast.error(t('toolbox.services.stopFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const runningCount = Object.keys(running).length;
  const [groupFilter, setGroupFilter] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);

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
    () => visibleConfigs.filter((c) => running[c.id]).length,
    [visibleConfigs, running],
  );

  const handleBatchStart = useCallback(async () => {
    const targets = visibleConfigs.filter((c) => !running[c.id]);
    if (targets.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    let fail = 0;
    for (const c of targets) {
      try {
        await invoke('service_start', {
          request: { id: c.id, name: c.name, command: c.command, args: c.args ?? null, cwd: c.cwd ?? null, env: c.env ?? null },
        });
        setRunning((prev) => ({ ...prev, [c.id]: { pid: undefined, startedAt: Date.now() } }));
        ok++;
      } catch {
        fail++;
      }
    }
    setBatchBusy(false);
    toast.success(t('toolbox.services.batchStarted', { count: ok }), {
      description: fail > 0 ? t('toolbox.services.batchFailed', { count: fail }) : undefined,
    });
  }, [visibleConfigs, running, t]);

  const handleBatchStop = useCallback(async () => {
    const targets = visibleConfigs.filter((c) => running[c.id]);
    if (targets.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    for (const c of targets) {
      try {
        await invoke('service_stop', { id: c.id });
        setRunning((prev) => {
          const next = { ...prev };
          delete next[c.id];
          return next;
        });
        ok++;
      } catch {
        /* ignore */
      }
    }
    setBatchBusy(false);
    toast.success(t('toolbox.services.batchStopped', { count: ok }));
  }, [visibleConfigs, running, t]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            {t('toolbox.services.title')}
            {runningCount > 0 && (
              <Badge variant="outline" className="text-[10px] text-success border-success/30 bg-success/10 gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                {t('toolbox.services.runningCount', { count: runningCount })}
              </Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground truncate">{t('toolbox.services.description')}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Select
            value={groupFilter}
            onValueChange={(v) => setGroupFilter(v === '__all__' ? '' : v)}
          >
            <SelectTrigger className="h-7 w-[110px] text-[11px]">
              <SelectValue placeholder={t('toolbox.services.allGroups')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__" className="text-xs">{t('toolbox.services.allGroups')}</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={batchBusy} onClick={() => void handleBatchStart()}>
            <Play className="h-3.5 w-3.5" />
            {t('toolbox.services.startAll')}
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={batchBusy || visibleRunningCount === 0} onClick={() => void handleBatchStop()}>
            <Square className="h-3.5 w-3.5" />
            {t('toolbox.services.stopAll')}
          </Button>
          <Button size="sm" onClick={openAdd} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('toolbox.services.add')}
          </Button>
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {visibleConfigs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border p-10 text-center">
              <div className="p-3 rounded-full bg-primary/10 text-primary">
                <Server className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('toolbox.services.empty')}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{t('toolbox.services.emptyDesc')}</p>
              </div>
              <Button size="sm" onClick={openAdd} className="gap-1.5">
                <Plus className="h-4 w-4" />
                {t('toolbox.services.addFirst')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleConfigs.map((config) => {
                const info = running[config.id];
                const isRunning = !!info;
                const isBusy = busyId === config.id;
                const serviceLogs = logs[config.id] ?? [];
                const isExpanded = expanded.has(config.id);
                return (
                  <div key={config.id} className="rounded-xl border border-border bg-card overflow-hidden transition-all hover:shadow-md">
                    <div className="p-4 flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
                            isRunning ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          <Server className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-medium text-foreground truncate flex items-center gap-2">
                            {config.name}
                            <Badge
                              variant={isRunning ? 'default' : 'secondary'}
                              className={`text-[10px] gap-1 ${isRunning ? 'bg-success/15 text-success border border-success/30' : ''}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-success animate-pulse' : 'bg-muted-foreground/50'}`} />
                              {isRunning
                                ? t('toolbox.services.running')
                                : t('toolbox.services.stopped')}
                            </Badge>
                            {isRunning && info.pid ? (
                              <span className="text-[10px] font-mono text-muted-foreground">PID {info.pid}</span>
                            ) : null}
                          </h4>
                          <p className="text-[11px] font-mono text-muted-foreground truncate">{config.command}</p>
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
                            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                            {t('toolbox.services.stop')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            disabled={isBusy}
                            onClick={() => void handleStart(config)}
                          >
                            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            {t('toolbox.services.start')}
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
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(config)}>
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {config.description && (
                      <p className="px-4 pb-3 text-xs text-muted-foreground -mt-1">{config.description}</p>
                    )}

                    {(isRunning || serviceLogs.length > 0) && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(config.id)}
                        className="w-full flex items-center gap-1.5 px-4 py-1.5 border-t border-border/70 text-[11px] text-muted-foreground hover:bg-muted/40 transition-colors"
                      >
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        <TerminalSquare className="h-3.5 w-3.5" />
                        {t('toolbox.services.logs')}
                        <span className="ml-auto font-mono text-[10px]">{serviceLogs.length}</span>
                      </button>
                    )}

                    {isExpanded && serviceLogs.length > 0 && (
                      <div className="border-t border-border bg-[#0d1117] dark:bg-black/40">
                        <div className="max-h-56 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
                          {serviceLogs.map((entry, index) => (
                            <div
                              key={`${entry.timestamp}-${index}`}
                              className={cn(
                                'whitespace-pre-wrap break-all',
                                entry.stream === 'stderr' ? 'text-destructive/90' : 'text-foreground/80',
                              )}
                            >
                              {entry.line || ' '}
                            </div>
                          ))}
                          <div ref={(el) => { logEndRefs.current[config.id] = el; }} />
                        </div>
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
              {editing ? t('toolbox.services.editTitle') : t('toolbox.services.addTitle')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.services.formDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="svc-name">{t('toolbox.services.name')}</Label>
                <Input
                  id="svc-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('toolbox.services.namePlaceholder')}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="svc-group">{t('toolbox.services.group')}</Label>
                <Input
                  id="svc-group"
                  value={form.group}
                  onChange={(e) => setForm((f) => ({ ...f, group: e.target.value }))}
                  placeholder={t('toolbox.services.groupPlaceholder')}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svc-command">{t('toolbox.services.command')}</Label>
              <Input
                id="svc-command"
                value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                placeholder={t('toolbox.services.commandPlaceholder')}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{t('toolbox.services.commandHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svc-args">{t('toolbox.services.args')}</Label>
              <Input
                id="svc-args"
                value={form.args}
                onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                placeholder={t('toolbox.services.argsPlaceholder')}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{t('toolbox.services.argsHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svc-cwd">{t('toolbox.services.cwd')}</Label>
              <div className="flex gap-2">
                <Input
                  id="svc-cwd"
                  value={form.cwd}
                  onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                  placeholder={t('toolbox.services.cwdPlaceholder')}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => void pickCwd()}
                  title={t('toolbox.services.browse')}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svc-env">{t('toolbox.services.env')}</Label>
              <Textarea
                id="svc-env"
                value={form.env}
                onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                placeholder={t('toolbox.services.envPlaceholder')}
                className="min-h-[60px] font-mono text-xs resize-none"
              />
              <p className="text-[11px] text-muted-foreground">{t('toolbox.services.envHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="svc-desc">{t('toolbox.services.fieldDescription')}</Label>
              <Textarea
                id="svc-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t('toolbox.services.descriptionPlaceholder')}
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
            <AlertDialogTitle>{t('toolbox.services.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.services.deleteDesc', { name: deleteTarget?.name ?? '' })}
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
