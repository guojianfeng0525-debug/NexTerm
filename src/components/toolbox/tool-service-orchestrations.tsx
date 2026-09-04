import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { OrchestrationsStorage, ServicesStorage, TunnelsStorage, generateId } from '@/lib/toolbox/toolbox-storage';
import type {
  OrchestrationItem,
  ServiceConfig,
  ServiceOrchestration,
  TunnelConfig,
} from '@/lib/toolbox/toolbox-types';
import {
  ArrowLeftRight,
  GripVertical,
  ListOrdered,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Server,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** One step while editing: stable key for drag identity + the persisted item. */
interface StepDraft {
  key: string;
  item: OrchestrationItem;
}

type StepRunStatus = 'pending' | 'running' | 'ok' | 'failed' | 'stopped';

interface StepRunState {
  status: StepRunStatus;
  error?: string;
}

const BADGE: Record<OrchestrationItem['kind'], string> = {
  tunnel: 'text-sky-600 dark:text-sky-400 border-sky-600/30 bg-sky-600/10',
  service: 'text-amber-600 dark:text-amber-400 border-amber-600/30 bg-amber-600/10',
};

/** Reorder the step drafts when a drag ends (move `activeKey` to `overKey`). */
export function reorderSteps<T extends { key: string }>(steps: T[], activeKey: string, overKey: string): T[] {
  if (activeKey === overKey) return steps;
  const oldIndex = steps.findIndex((s) => s.key === activeKey);
  const newIndex = steps.findIndex((s) => s.key === overKey);
  if (oldIndex === -1 || newIndex === -1) return steps;
  return arrayMove(steps, oldIndex, newIndex);
}

/* ── sortable step row ──────────────────────────────────────────────────── */

function SortableStepRow({
  draft,
  label,
  missing,
  onRemove,
}: {
  draft: StepDraft;
  label: string;
  missing: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: draft.key,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2',
        isDragging && 'opacity-60 ring-1 ring-primary shadow-md',
        missing && 'border-destructive/50 bg-destructive/5',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
        aria-label="drag"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Badge variant="outline" className={cn('text-[10px] gap-1', BADGE[draft.item.kind])}>
        {draft.item.kind === 'tunnel' ? <ArrowLeftRight className="h-3 w-3" /> : <Server className="h-3 w-3" />}
        {draft.item.kind === 'tunnel' ? 'Tunnel' : 'Service'}
      </Badge>
      <span className={cn('min-w-0 flex-1 truncate text-xs', missing ? 'text-destructive line-through' : 'text-foreground')}>
        {missing ? '⚠ ' : ''}
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        aria-label="remove"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ── main component ─────────────────────────────────────────────────────── */

export function ServiceOrchestrations() {
  const { t } = useTranslation();
  const [orchestrations, setOrchestrations] = useState<ServiceOrchestration[]>(() => OrchestrationsStorage.load());
  const [services, setServices] = useState<ServiceConfig[]>(() => ServicesStorage.load());
  const [tunnels, setTunnels] = useState<TunnelConfig[]>(() => TunnelsStorage.load());

  // Keep the tunnel/service pickers in sync when the user adds/edits/removes
  // entries in the Remote Tunnels / Local Services views (they share the same
  // storage; we re-read on the storage-changed broadcast AND on dialog open).
  const refreshConfigs = useCallback(() => {
    setServices(ServicesStorage.load());
    setTunnels(TunnelsStorage.load());
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: string }>).detail?.kind;
      if (!kind || kind === 'services' || kind === 'tunnels') {
        refreshConfigs();
      }
    };
    window.addEventListener('nexterm:toolbox-changed', handler);
    return () => window.removeEventListener('nexterm:toolbox-changed', handler);
  }, [refreshConfigs]);

  // editor state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceOrchestration | null>(null);
  const [formName, setFormName] = useState('');
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [pickKind, setPickKind] = useState<OrchestrationItem['kind']>('tunnel');
  const [pickId, setPickId] = useState('');

  // run state
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, StepRunState[]>>({});

  const [deleteTarget, setDeleteTarget] = useState<ServiceOrchestration | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  /** Resolve a step to its display label; missing → undefined. */
  const resolveStep = useCallback(
    (item: OrchestrationItem): string | undefined => {
      if (item.kind === 'tunnel') {
        return tunnels.find((c) => c.id === item.id)?.name ?? item.id;
      }
      return services.find((c) => c.id === item.id)?.name ?? item.id;
    },
    [tunnels, services],
  );

  const isStepMissing = useCallback(
    (item: OrchestrationItem): boolean => {
      if (item.kind === 'tunnel') return !tunnels.some((c) => c.id === item.id);
      return !services.some((c) => c.id === item.id);
    },
    [tunnels, services],
  );

  const openAdd = useCallback(() => {
    refreshConfigs();
    setEditing(null);
    setFormName('');
    setSteps([]);
    setPickKind('tunnel');
    setPickId('');
    setFormOpen(true);
  }, [refreshConfigs]);

  const openEdit = useCallback(
    (orch: ServiceOrchestration) => {
      refreshConfigs();
      setEditing(orch);
      setFormName(orch.name);
      setSteps(orch.items.map((item, index) => ({ key: `${orch.id}-${index}`, item })));
      setPickKind('tunnel');
      setPickId('');
      setFormOpen(true);
    },
    [refreshConfigs],
  );

  const handleAddStep = useCallback(() => {
    if (!pickId) {
      toast.error(t('toolbox.orchestrations.pickStep'));
      return;
    }
    setSteps((prev) => [...prev, { key: generateId('step'), item: { kind: pickKind, id: pickId } }]);
    // Keep the same kind selected for fast multi-add; clear the pick so the
    // next add is an explicit choice.
    setPickId('');
  }, [pickKind, pickId, t]);

  const handleRemoveStep = useCallback((key: string) => {
    setSteps((prev) => prev.filter((s) => s.key !== key));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    setSteps((prev) => reorderSteps(prev, String(active.id), String(over.id)));
  }, []);

  const handleSave = useCallback(() => {
    if (!formName.trim()) {
      toast.error(t('toolbox.orchestrations.formIncomplete'), {
        description: t('toolbox.orchestrations.nameRequired'),
      });
      return;
    }
    if (steps.length === 0) {
      toast.error(t('toolbox.orchestrations.formIncomplete'), {
        description: t('toolbox.orchestrations.noSteps'),
      });
      return;
    }
    const now = Date.now();
    const orch: ServiceOrchestration = {
      id: editing?.id ?? generateId('orch'),
      name: formName.trim(),
      items: steps.map((s) => s.item),
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
    };
    setOrchestrations(OrchestrationsStorage.upsert(orch));
    setFormOpen(false);
    toast.success(editing ? t('toolbox.orchestrations.updated') : t('toolbox.orchestrations.added'), {
      description: orch.name,
    });
  }, [editing, formName, steps, t]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    setOrchestrations(OrchestrationsStorage.remove(deleteTarget.id));
    toast.success(t('toolbox.orchestrations.deleted'), { description: deleteTarget.name });
    setDeleteTarget(null);
  }, [deleteTarget, t]);

  /** Strict-order run: each step must succeed before the next starts. */
  const handleRun = useCallback(
    async (orch: ServiceOrchestration) => {
      if (runBusy) return;
      setRunBusy(orch.id);
      const states: StepRunState[] = orch.items.map(() => ({ status: 'pending' }));
      setRunStates((prev) => ({ ...prev, [orch.id]: states }));
      let succeeded = 0;
      try {
        for (let i = 0; i < orch.items.length; i++) {
          const item = orch.items[i];
          setRunStates((prev) => {
            const next = [...(prev[orch.id] ?? [])];
            next[i] = { status: 'running' };
            return { ...prev, [orch.id]: next };
          });
          try {
            if (item.kind === 'tunnel') {
              const cfg = tunnels.find((c) => c.id === item.id);
              if (!cfg) throw new Error(t('toolbox.orchestrations.missingConfig'));
              await invoke('tunnel_start', {
                request: {
                  id: cfg.id,
                  name: cfg.name,
                  bind_address: cfg.bindAddress,
                  listen_port: cfg.listenPort,
                  remote_host: cfg.remoteHost,
                  remote_port: cfg.remotePort,
                  jump_host: cfg.jumpHost ?? null,
              jump_port: cfg.jumpPort ?? null,
              jump_username: cfg.jumpUsername ?? null,
              jump_password: cfg.jumpPassword ?? null,
              jump_host_key_fingerprint: cfg.jumpHostKeyFingerprint ?? null,
            },
              });
            } else {
              const cfg = services.find((c) => c.id === item.id);
              if (!cfg) throw new Error(t('toolbox.orchestrations.missingConfig'));
              await invoke('service_start', {
                request: {
                  id: cfg.id,
                  name: cfg.name,
                  command: cfg.command,
                  args: cfg.args ?? null,
                  cwd: cfg.cwd ?? null,
                  env: cfg.env ?? null,
                },
              });
            }
            succeeded++;
            setRunStates((prev) => {
              const next = [...(prev[orch.id] ?? [])];
              next[i] = { status: 'ok' };
              return { ...prev, [orch.id]: next };
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setRunStates((prev) => {
              const next = [...(prev[orch.id] ?? [])];
              next[i] = { status: 'failed', error: message };
              return { ...prev, [orch.id]: next };
            });
            // Fail-fast: stop the flow at the first failed step.
            toast.error(t('toolbox.orchestrations.runFailed'), {
              description: t('toolbox.orchestrations.failedAt', {
                step: i + 1,
                name: resolveStep(item) ?? item.id,
                message,
              }),
            });
            break;
          }
        }
        if (succeeded === orch.items.length) {
          toast.success(t('toolbox.orchestrations.runSuccess'), {
            description: t('toolbox.orchestrations.runSummary', { count: orch.items.length }),
          });
        }
      } finally {
        // Tell sibling views (tunnels/services) to resync running state.
        window.dispatchEvent(new CustomEvent('nexterm:orchestration-ran'));
        setRunBusy(null);
      }
    },
    [runBusy, tunnels, services, t, resolveStep],
  );

  const pickOptions = useMemo(() => {
    if (pickKind === 'tunnel') return tunnels;
    return services;
  }, [pickKind, tunnels, services]);

  /** Stop every step that is currently running, in REVERSE order (last
   *  started stops first). Individual failures do not abort the sweep — we
   *  try to stop everything and report the count of successful stops. */
  const handleStop = useCallback(
    async (orch: ServiceOrchestration) => {
      if (runBusy) return;
      setRunBusy(orch.id);
      let stopped = 0;
      const states: StepRunState[] = orch.items.map(() => ({ status: 'pending' }));
      setRunStates((prev) => ({ ...prev, [orch.id]: states }));
      try {
        // Reverse order: the most recently started step stops first.
        for (let i = orch.items.length - 1; i >= 0; i--) {
          const item = orch.items[i];
          setRunStates((prev) => {
            const next = [...(prev[orch.id] ?? [])];
            next[i] = { status: 'running' };
            return { ...prev, [orch.id]: next };
          });
          try {
            if (item.kind === 'tunnel') {
              await invoke('tunnel_stop', { id: item.id });
            } else {
              await invoke('service_stop', { id: item.id });
            }
            stopped++;
            setRunStates((prev) => {
              const next = [...(prev[orch.id] ?? [])];
              next[i] = { status: 'stopped' };
              return { ...prev, [orch.id]: next };
            });
          } catch {
            // Best-effort: keep stopping the remaining steps.
            setRunStates((prev) => {
              const next = [...(prev[orch.id] ?? [])];
              next[i] = { status: 'ok' };
              return { ...prev, [orch.id]: next };
            });
          }
        }
        if (stopped > 0) {
          toast.success(t('toolbox.orchestrations.stopSuccess'), {
            description: t('toolbox.orchestrations.stopSummary', { count: stopped }),
          });
        } else {
          toast.info?.(t('toolbox.orchestrations.stopNothing'));
        }
      } finally {
        window.dispatchEvent(new CustomEvent('nexterm:orchestration-ran'));
        setRunBusy(null);
      }
    },
    [runBusy, t],
  );

  const runningNow = useMemo(() => {
    const set = new Set<string>();
    for (const [id, states] of Object.entries(runStates)) {
      if (states.some((s) => s.status === 'running')) set.add(id);
    }
    return set;
  }, [runStates]);

  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <ListOrdered className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate">{t('toolbox.orchestrations.title')}</span>
          <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">{t('toolbox.orchestrations.description')}</span>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" onClick={openAdd}>
          <Plus className="h-3.5 w-3.5" />
          {t('toolbox.orchestrations.add')}
        </Button>
      </div>

      {orchestrations.length === 0 ? (
        <p className="px-4 pb-3 text-[11px] text-muted-foreground">{t('toolbox.orchestrations.empty')}</p>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto px-4 pb-3">
          {orchestrations.map((orch) => {
            const states = runStates[orch.id] ?? [];
            const isRunning = runningNow.has(orch.id);
            const isBusy = runBusy === orch.id;
            return (
              <div
                key={orch.id}
                className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate text-xs font-semibold text-foreground">{orch.name}</h4>
                    <p className="text-[10px] text-muted-foreground">
                      {t('toolbox.orchestrations.stepCount', { count: orch.items.length })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={isBusy}
                      onClick={() => void handleRun(orch)}
                    >
                      {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      {isRunning ? t('toolbox.orchestrations.running') : t('toolbox.orchestrations.start')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      disabled={isBusy}
                      onClick={() => void handleStop(orch)}
                    >
                      <Square className="h-3.5 w-3.5" />
                      {t('toolbox.orchestrations.stop')}
                    </Button>
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
                        <DropdownMenuItem onClick={() => openEdit(orch)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(orch)}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* ordered step list with live run state */}
                <div className="space-y-1">
                  {orch.items.map((item, index) => {
                    const state = states[index];
                    const label = resolveStep(item) ?? item.id;
                    const missing = isStepMissing(item);
                    return (
                      <div
                        key={`${index}-${item.id}`}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]',
                          state?.status === 'ok' && 'bg-success/10 text-success',
                          state?.status === 'failed' && 'bg-destructive/10 text-destructive',
                          state?.status === 'running' && 'bg-primary/10 text-primary',
                          missing && !state && 'text-destructive/80',
                          !state && !missing && 'text-muted-foreground',
                        )}
                      >
                        <span className="font-mono text-[10px] opacity-70">{index + 1}.</span>
                        {state?.status === 'running' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : state?.status === 'ok' ? (
                          <span className="text-[10px]">✓</span>
                        ) : state?.status === 'stopped' ? (
                          <span className="text-[10px]">■</span>
                        ) : state?.status === 'failed' ? (
                          <span className="text-[10px]">✕</span>
                        ) : (
                          <span className="text-[10px] opacity-50">·</span>
                        )}
                        {item.kind === 'tunnel' ? (
                          <ArrowLeftRight className="h-3 w-3 shrink-0 opacity-70" />
                        ) : (
                          <Server className="h-3 w-3 shrink-0 opacity-70" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {missing && !state ? '⚠ ' : ''}
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {states.some((s) => s.status === 'failed') && (
                  <p className="text-[10px] text-destructive leading-snug">
                    {states.find((s) => s.status === 'failed')?.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('toolbox.orchestrations.editTitle') : t('toolbox.orchestrations.addTitle')}
            </DialogTitle>
            <DialogDescription>{t('toolbox.orchestrations.formDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="orch-name">{t('toolbox.orchestrations.name')}</Label>
              <Input
                id="orch-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('toolbox.orchestrations.namePlaceholder')}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('toolbox.orchestrations.steps')}</Label>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={steps.map((s) => s.key)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-1.5">
                    {steps.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                        {t('toolbox.orchestrations.noSteps')}
                      </p>
                    ) : (
                      steps.map((draft) => (
                        <SortableStepRow
                          key={draft.key}
                          draft={draft}
                          label={resolveStep(draft.item) ?? draft.item.id}
                          missing={isStepMissing(draft.item)}
                          onRemove={() => handleRemoveStep(draft.key)}
                        />
                      ))
                    )}
                  </div>
                </SortableContext>
              </DndContext>
            </div>

            {/* add-step picker */}
            <div className="flex items-end gap-2">
              <div className="space-y-1.5 w-28 shrink-0">
                <Label>{t('toolbox.orchestrations.type')}</Label>
                <Select
                  value={pickKind}
                  onValueChange={(v) => {
                    setPickKind(v as OrchestrationItem['kind']);
                    setPickId('');
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tunnel" className="text-xs">{t('toolbox.orchestrations.tunnel')}</SelectItem>
                    <SelectItem value="service" className="text-xs">{t('toolbox.orchestrations.service')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                <Label>{t('toolbox.orchestrations.target')}</Label>
                <Select value={pickId} onValueChange={setPickId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t('toolbox.orchestrations.chooseTarget')} />
                  </SelectTrigger>
                  <SelectContent>
                    {pickOptions.length === 0 ? (
                      <p className="px-3 py-2 text-[11px] text-muted-foreground">
                        {pickKind === 'tunnel'
                          ? t('toolbox.orchestrations.noTunnels')
                          : t('toolbox.orchestrations.noServices')}
                      </p>
                    ) : (
                      pickOptions.map((cfg) => (
                        <SelectItem key={cfg.id} value={cfg.id} className="text-xs">
                          {cfg.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-8 gap-1 text-xs shrink-0"
                disabled={!pickId}
                onClick={handleAddStep}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('toolbox.orchestrations.addStep')}
              </Button>
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
            <AlertDialogTitle>{t('toolbox.orchestrations.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbox.orchestrations.deleteDesc', { name: deleteTarget?.name ?? '' })}
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
