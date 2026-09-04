/**
 * Node editor for the global topology view.
 *
 * Only the manual (M) fields are editable here — a probe run must never be
 * able to overwrite them. Everything the probe collects is shown read-only in
 * a clearly-separated section so users can see which values they may trust.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Trash2, Wand2 } from 'lucide-react';
import type { NetworkNode, ProbeStatus } from '@/lib/network/topology-types';
import { nodeLabel } from './topology-graph';

/** Canonical, translatable option values for the two categorical fields. */
export const NODE_TYPE_OPTIONS = [
  'physical',
  'virtual',
  'container',
  'gateway',
  'loadbalancer',
  'database',
  'other',
] as const;

export const NODE_ENVIRONMENT_OPTIONS = [
  'production',
  'staging',
  'test',
  'development',
  'other',
] as const;

const EMPTY_SENTINEL = '__empty__';
const CUSTOM_SENTINEL = '__custom__';

const PROBE_STATUS_CLASS: Record<ProbeStatus, string> = {
  ok: 'bg-success/15 text-success border-success/30',
  partial: 'bg-warning/15 text-warning border-warning/30',
  failed: 'bg-destructive/15 text-destructive border-destructive/30',
  never: 'bg-muted text-muted-foreground border-border',
};

interface CategoryFieldProps {
  readonly id: string;
  readonly value: string;
  readonly options: readonly string[];
  /** i18n prefix, e.g. `topology.nodeType` → `topology.nodeType.docker`. */
  readonly labelKey: string;
  readonly placeholder: string;
  readonly emptyLabel: string;
  readonly customLabel: string;
  readonly customPlaceholder: string;
  readonly onChange: (value: string) => void;
}

/**
 * Preset picker that still allows free text: choosing "custom" reveals an
 * input bound to the same value.
 */
function CategoryField({
  id,
  value,
  options,
  labelKey,
  placeholder,
  emptyLabel,
  customLabel,
  customPlaceholder,
  onChange,
}: CategoryFieldProps) {
  const { t } = useTranslation();
  const selectValue =
    value === '' ? EMPTY_SENTINEL : options.includes(value) ? value : CUSTOM_SENTINEL;

  return (
    <div className="space-y-1.5">
      <Select
        value={selectValue}
        onValueChange={(next) =>
          onChange(next === EMPTY_SENTINEL || next === CUSTOM_SENTINEL ? '' : next)
        }
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EMPTY_SENTINEL} className="text-muted-foreground">
            {emptyLabel}
          </SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`${labelKey}.${option}`, { defaultValue: option })}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>{customLabel}</SelectItem>
        </SelectContent>
      </Select>
      {selectValue === CUSTOM_SENTINEL && (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={customPlaceholder}
        />
      )}
    </div>
  );
}

export interface TopologyNodeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly node: NetworkNode | null;
  /** Read-only counters gathered from the node's detail tables. */
  readonly interfaceCount?: number;
  readonly portCount?: number;
  readonly onSave: (node: NetworkNode) => void;
  readonly onResetLayout: (id: string) => void;
  readonly onDelete: (id: string) => void;
}

interface FormState {
  displayName: string;
  nodeType: string;
  environment: string;
  notes: string;
  hidden: boolean;
}

const EMPTY_FORM: FormState = {
  displayName: '',
  nodeType: '',
  environment: '',
  notes: '',
  hidden: false,
};

function formatTimestamp(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}

export function TopologyNodeDialog({
  open,
  onOpenChange,
  node,
  interfaceCount = 0,
  portCount = 0,
  onSave,
  onResetLayout,
  onDelete,
}: TopologyNodeDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open || !node) return;
    setForm({
      displayName: node.displayName,
      nodeType: node.nodeType,
      environment: node.environment,
      notes: node.notes,
      hidden: node.hidden,
    });
    setConfirmingDelete(false);
  }, [open, node]);

  const readOnlyRows = useMemo(() => {
    if (!node) return [];
    return [
      { label: t('topology.node.hostname'), value: node.hostname || '—' },
      { label: t('topology.node.os'), value: node.osName || '—' },
      { label: t('topology.node.primaryIp'), value: node.primaryIp || '—' },
      {
        label: t('topology.node.roleHint'),
        value: t(`topology.role.${node.roleHint}`, { defaultValue: node.roleHint }),
      },
      { label: t('topology.node.lastProbeAt'), value: formatTimestamp(node.lastProbeAt) },
      { label: t('topology.node.interfaceCount'), value: String(interfaceCount) },
      { label: t('topology.node.portCount'), value: String(portCount) },
    ];
  }, [interfaceCount, node, portCount, t]);

  const handleSave = useCallback(() => {
    if (!node) return;
    onSave({
      ...node,
      displayName: form.displayName.trim(),
      nodeType: form.nodeType.trim(),
      environment: form.environment.trim(),
      notes: form.notes,
      hidden: form.hidden,
    });
    onOpenChange(false);
  }, [form, node, onOpenChange, onSave]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="!inset-0 !m-auto flex max-h-[85vh] w-[92vw] max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>{t('topology.nodeDialog.title')}</DialogTitle>
            <DialogDescription>
              {node ? nodeLabel(node) : t('topology.nodeDialog.description')}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 px-6 py-5">
              <section className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="topology-node-display-name">
                    {t('topology.nodeDialog.displayName')}
                  </Label>
                  <Input
                    id="topology-node-display-name"
                    value={form.displayName}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, displayName: event.target.value }))
                    }
                    placeholder={node?.hostname || t('topology.nodeDialog.displayNamePlaceholder')}
                    autoFocus
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <CategoryField
                    id="topology-node-type"
                    value={form.nodeType}
                    options={NODE_TYPE_OPTIONS}
                    labelKey="topology.nodeType"
                    placeholder={t('topology.nodeDialog.nodeTypePlaceholder')}
                    emptyLabel={t('topology.nodeDialog.notSet')}
                    customLabel={t('topology.nodeDialog.customValue')}
                    customPlaceholder={t('topology.nodeDialog.nodeTypeCustomPlaceholder')}
                    onChange={(value) => setForm((current) => ({ ...current, nodeType: value }))}
                  />
                  <CategoryField
                    id="topology-node-env"
                    value={form.environment}
                    options={NODE_ENVIRONMENT_OPTIONS}
                    labelKey="topology.environment"
                    placeholder={t('topology.nodeDialog.environmentPlaceholder')}
                    emptyLabel={t('topology.nodeDialog.notSet')}
                    customLabel={t('topology.nodeDialog.customValue')}
                    customPlaceholder={t('topology.nodeDialog.environmentCustomPlaceholder')}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, environment: value }))
                    }
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('topology.nodeDialog.nodeTypeHint')}
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor="topology-node-notes">{t('topology.nodeDialog.notes')}</Label>
                  <Textarea
                    id="topology-node-notes"
                    value={form.notes}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, notes: event.target.value }))
                    }
                    placeholder={t('topology.nodeDialog.notesPlaceholder')}
                    className="min-h-[72px] resize-none"
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                  <div className="min-w-0 pr-3">
                    <p className="text-xs font-medium text-foreground">
                      {t('topology.nodeDialog.hidden')}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('topology.nodeDialog.hiddenHint')}
                    </p>
                  </div>
                  <Switch
                    checked={form.hidden}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({ ...current, hidden: checked }))
                    }
                  />
                </div>
              </section>

              <Separator />

              <section className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-semibold text-foreground">
                    {t('topology.nodeDialog.autoSection')}
                  </h4>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {t('topology.nodeDialog.autoBadge')}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t('topology.nodeDialog.autoSectionHint')}
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {readOnlyRows.map((row) => (
                    <div key={row.label} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{row.label}</p>
                      <p className="truncate text-xs text-foreground" title={row.value}>
                        {row.value}
                      </p>
                    </div>
                  ))}
                  <div className="min-w-0">
                    <p className="text-[11px] text-muted-foreground">
                      {t('topology.node.lastProbeStatus')}
                    </p>
                    {node ? (
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${PROBE_STATUS_CLASS[node.lastProbeStatus]}`}
                      >
                        {t(`topology.probeStatus.${node.lastProbeStatus}`, {
                          defaultValue: node.lastProbeStatus,
                        })}
                      </Badge>
                    ) : (
                      <span className="text-xs text-foreground">—</span>
                    )}
                  </div>
                </div>
                {node?.lastProbeError && (
                  <p className="break-all rounded-md bg-muted px-2.5 py-2 font-mono text-[10px] text-destructive">
                    {node.lastProbeError}
                  </p>
                )}
              </section>
            </div>
          </ScrollArea>

          <DialogFooter className="shrink-0 border-t border-border px-6 py-3">
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => node && onResetLayout(node.id)}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {t('topology.nodeDialog.resetLayout')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('topology.nodeDialog.delete')}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" onClick={handleSave}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sibling dialog instead of a nested one — keeps focus handling sane. */}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="!inset-0 !m-auto w-[92vw] max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('topology.nodeDialog.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('topology.nodeDialog.deleteDesc', { name: node ? nodeLabel(node) : '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!node) return;
                onDelete(node.id);
                setConfirmingDelete(false);
                onOpenChange(false);
              }}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
