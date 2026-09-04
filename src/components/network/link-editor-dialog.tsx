/**
 * Link editor / creator for the global topology view.
 *
 * Saving always marks the relationship as `manual`: user-authored knowledge
 * outranks automatic inference, and a later probe only refreshes
 * `lastConfirmedAt` / `status` on such a link (never `description` or
 * `manualLabel`).
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Trash2 } from 'lucide-react';
import type {
  LinkStatus,
  LinkType,
  NetProtocol,
  NetworkLink,
  NetworkNode,
} from '@/lib/network/topology-types';
import { inferLinkType } from '@/lib/network/topology-merge';
import { generateId } from '@/lib/toolbox/toolbox-storage';
import { nodeLabel } from './topology-graph';

const LINK_TYPE_ORDER: LinkType[] = [
  'ssh',
  'http',
  'database',
  'cache',
  'messaging',
  'custom',
  'unknown',
];

const PROTOCOL_OPTIONS: NetProtocol[] = ['tcp', 'udp'];

const STATUS_OPTIONS: LinkStatus[] = ['active', 'observed', 'stale', 'unknown'];

export interface LinkEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` creates a new relationship. */
  readonly link: NetworkLink | null;
  readonly nodes: NetworkNode[];
  /** Pre-selected source when creating from a node's context menu. */
  readonly defaultSourceId?: string | null;
  readonly onSave: (link: NetworkLink) => void;
  readonly onDelete: (id: string) => void;
}

interface FormState {
  sourceNodeId: string;
  targetNodeId: string;
  protocol: NetProtocol;
  port: string;
  linkType: LinkType;
  status: LinkStatus;
  description: string;
  manualLabel: string;
}

const EMPTY_FORM: FormState = {
  sourceNodeId: '',
  targetNodeId: '',
  protocol: 'tcp',
  port: '',
  linkType: 'custom',
  status: 'active',
  description: '',
  manualLabel: '',
};

function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 0 || value > 65535) return null;
  return value;
}

export function LinkEditorDialog({
  open,
  onOpenChange,
  link,
  nodes,
  defaultSourceId = null,
  onSave,
  onDelete,
}: LinkEditorDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Once the user picks a type by hand we stop auto-suggesting from ports. */
  const [typeTouched, setTypeTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmingDelete(false);
    setTypeTouched(false);
    if (link) {
      setForm({
        sourceNodeId: link.sourceNodeId,
        targetNodeId: link.targetNodeId,
        protocol: link.protocol,
        port: link.port === null ? '' : String(link.port),
        linkType: link.linkType,
        status: link.status,
        description: link.description,
        manualLabel: link.manualLabel,
      });
      return;
    }
    setForm({
      ...EMPTY_FORM,
      sourceNodeId: defaultSourceId ?? nodes[0]?.id ?? '',
      targetNodeId: nodes.find((node) => node.id !== defaultSourceId)?.id ?? '',
    });
  }, [open, link, nodes, defaultSourceId]);

  const nodeOptions = useMemo(
    () => nodes.map((node) => ({ id: node.id, label: nodeLabel(node) })),
    [nodes],
  );

  const handlePortChange = useCallback((raw: string) => {
    setForm((current) => {
      const next = { ...current, port: raw };
      if (!typeTouched) {
        const port = parsePort(raw);
        if (port !== null) next.linkType = inferLinkType(port, '');
      }
      return next;
    });
  }, [typeTouched]);

  const handleSave = useCallback(() => {
    const now = Date.now();
    const port = parsePort(form.port);
    if (link) {
      onSave({
        ...link,
        sourceNodeId: form.sourceNodeId,
        targetNodeId: form.targetNodeId,
        protocol: form.protocol,
        port,
        linkType: form.linkType,
        status: form.status,
        description: form.description.trim(),
        manualLabel: form.manualLabel.trim(),
        // A human touched it: from now on it is a manual relationship.
        source: 'manual',
        updatedAt: now,
      });
      onOpenChange(false);
      return;
    }
    onSave({
      id: generateId('link'),
      sourceNodeId: form.sourceNodeId,
      targetNodeId: form.targetNodeId,
      protocol: form.protocol,
      port,
      linkType: form.linkType,
      status: form.status,
      source: 'manual',
      evidence: '',
      description: form.description.trim(),
      manualLabel: form.manualLabel.trim(),
      hidden: false,
      firstSeenAt: now,
      lastConfirmedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    onOpenChange(false);
  }, [form, link, onOpenChange, onSave]);

  const canSave = form.sourceNodeId !== '' && form.targetNodeId !== '';
  const sameNode = canSave && form.sourceNodeId === form.targetNodeId;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="!inset-0 !m-auto flex max-h-[85vh] w-[92vw] max-w-xl flex-col gap-0 p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>
              {link ? t('topology.linkDialog.editTitle') : t('topology.linkDialog.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('topology.linkDialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {link && link.source === 'auto' && (
              <div className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {t('topology.source.auto')}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {t('topology.linkDialog.autoHint', { evidence: link.evidence })}
                  </span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="topology-link-source">{t('topology.linkDialog.sourceNode')}</Label>
                <Select
                  value={form.sourceNodeId}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, sourceNodeId: value }))
                  }
                >
                  <SelectTrigger id="topology-link-source" className="w-full">
                    <SelectValue placeholder={t('topology.linkDialog.selectNode')} />
                  </SelectTrigger>
                  <SelectContent>
                    {nodeOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="topology-link-target">{t('topology.linkDialog.targetNode')}</Label>
                <Select
                  value={form.targetNodeId}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, targetNodeId: value }))
                  }
                >
                  <SelectTrigger id="topology-link-target" className="w-full">
                    <SelectValue placeholder={t('topology.linkDialog.selectNode')} />
                  </SelectTrigger>
                  <SelectContent>
                    {nodeOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sameNode && (
              <p className="text-[11px] text-destructive">{t('topology.linkDialog.sameNode')}</p>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="topology-link-protocol">{t('topology.linkDialog.protocol')}</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, protocol: value as NetProtocol }))
                  }
                >
                  <SelectTrigger id="topology-link-protocol" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROTOCOL_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`topology.protocol.${option}`, { defaultValue: option })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="topology-link-port">{t('topology.linkDialog.port')}</Label>
                <Input
                  id="topology-link-port"
                  type="number"
                  min={0}
                  max={65535}
                  value={form.port}
                  onChange={(event) => handlePortChange(event.target.value)}
                  placeholder={t('topology.linkDialog.portPlaceholder')}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="topology-link-status">{t('topology.linkDialog.status')}</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, status: value as LinkStatus }))
                  }
                >
                  <SelectTrigger id="topology-link-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`topology.linkStatus.${option}`, { defaultValue: option })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="topology-link-type">{t('topology.linkDialog.linkType')}</Label>
              <Select
                value={form.linkType}
                onValueChange={(value) => {
                  setTypeTouched(true);
                  setForm((current) => ({ ...current, linkType: value as LinkType }));
                }}
              >
                <SelectTrigger id="topology-link-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINK_TYPE_ORDER.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`topology.linkType.${option}`, { defaultValue: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t('topology.linkDialog.linkTypeHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="topology-link-label">{t('topology.linkDialog.manualLabel')}</Label>
              <Input
                id="topology-link-label"
                value={form.manualLabel}
                onChange={(event) =>
                  setForm((current) => ({ ...current, manualLabel: event.target.value }))
                }
                placeholder={t('topology.linkDialog.manualLabelPlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="topology-link-description">
                {t('topology.linkDialog.description_field')}
              </Label>
              <Textarea
                id="topology-link-description"
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder={t('topology.linkDialog.descriptionPlaceholder')}
                className="min-h-[68px] resize-none"
              />
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t border-border px-6 py-3">
            <div className="flex w-full items-center justify-between gap-2">
              {link ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('topology.linkDialog.delete')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" onClick={handleSave} disabled={!canSave || sameNode}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="!inset-0 !m-auto w-[92vw] max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('topology.linkDialog.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('topology.linkDialog.deleteDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!link) return;
                onDelete(link.id);
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
