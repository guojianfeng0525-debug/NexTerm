/**
 * Manual editor / creator for port-level topology connections.
 *
 * A relation can be outbound (focused port → peer port) or inbound (peer port →
 * focused port). Unknown peer endpoints stay as IP:port data and are never
 * probed from this dialog.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  NetProtocol,
  NetworkNode,
  NetworkPort,
  NetworkPortLink,
  PortLinkStatus,
} from '@/lib/network/topology-types';
import { generateId } from '@/lib/toolbox/toolbox-storage';
import { nodeLabel } from './topology-graph';
import { cn } from '@/lib/utils';

const PROTOCOL_OPTIONS: NetProtocol[] = ['tcp', 'udp'];
const STATUS_OPTIONS: PortLinkStatus[] = ['active', 'observed', 'stale', 'unknown'];
const STATUS_LABEL_KEYS = {
  active: 'topology.linkStatus.active',
  observed: 'topology.linkStatus.observed',
  stale: 'topology.linkStatus.stale',
  unknown: 'topology.linkStatus.unknown',
} as const satisfies Record<PortLinkStatus, string>;

export interface PortLinkEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` creates a new relation. */
  readonly link: NetworkPortLink | null;
  readonly focusNodeId: string;
  readonly focusPort: NetworkPort;
  readonly nodes: NetworkNode[];
  readonly portsByNode: Record<string, NetworkPort[]>;
  readonly onSave: (link: NetworkPortLink) => void;
  readonly onDelete: (id: string) => void;
}

interface FormState {
  direction: 'outbound' | 'inbound';
  peerMode: 'node' | 'ip';
  peerNodeId: string;
  peerIp: string;
  peerPort: string;
  protocol: NetProtocol;
  status: PortLinkStatus;
  manualLabel: string;
  description: string;
}

const EMPTY_FORM: FormState = {
  direction: 'outbound',
  peerMode: 'node',
  peerNodeId: '',
  peerIp: '',
  peerPort: '',
  protocol: 'tcp',
  status: 'active',
  manualLabel: '',
  description: '',
};

function parsePort(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 1 && value <= 65535 ? value : null;
}

function portOptionLabel(port: NetworkPort): string {
  return [
    `${port.port}/${port.protocol}`,
    port.serviceName || port.processName || port.listenAddr,
  ].filter(Boolean).join(' · ');
}

export function PortLinkEditorDialog({
  open,
  onOpenChange,
  link,
  focusNodeId,
  focusPort,
  nodes,
  portsByNode,
  onSave,
  onDelete,
}: PortLinkEditorDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmingDelete(false);
    if (link) {
      const inbound = link.targetNodeId === focusNodeId && link.targetPortId === focusPort.id;
      const peerNodeId = inbound ? link.sourceNodeId : link.targetNodeId;
      const peerIp = inbound ? link.sourceIp : link.targetIp;
      const peerPort = inbound ? link.sourcePort : link.targetPort;
      setForm({
        direction: inbound ? 'inbound' : 'outbound',
        peerMode: peerNodeId ? 'node' : 'ip',
        peerNodeId: peerNodeId ?? '',
        peerIp: peerIp ?? '',
        peerPort: String(peerPort ?? ''),
        protocol: inbound ? link.sourceProtocol : link.targetProtocol,
        status: link.status,
        manualLabel: link.manualLabel,
        description: link.description,
      });
      return;
    }

    const firstPeer = nodes.find((node) => node.id !== focusNodeId);
    setForm({
      ...EMPTY_FORM,
      protocol: focusPort.protocol,
      peerNodeId: firstPeer?.id ?? '',
      peerPort: '',
    });
  }, [open, link, focusNodeId, focusPort, nodes]);

  const peerPortOptions = useMemo(() => {
    if (form.direction !== 'inbound' || form.peerMode !== 'node') return [];
    return (portsByNode[form.peerNodeId] ?? []).filter((port) => port.protocol === form.protocol);
  }, [form.direction, form.peerMode, form.peerNodeId, form.protocol, portsByNode]);

  useEffect(() => {
    if (!open || form.direction !== 'inbound' || form.peerMode !== 'node') return;
    const ports = portsByNode[form.peerNodeId] ?? [];
    const current = ports.find((port) => `${port.port}` === form.peerPort && port.protocol === form.protocol);
    if (current) return;
    const first = ports.find((port) => port.protocol === form.protocol);
    if (first) setForm((state) => ({ ...state, peerPort: String(first.port) }));
  }, [open, form.direction, form.peerMode, form.peerNodeId, form.peerPort, form.protocol, portsByNode]);

  const endpointPort = parsePort(form.peerPort);
  const canSave =
    endpointPort !== null &&
    (form.peerMode === 'node' ? form.peerNodeId !== '' : form.peerIp.trim() !== '');

  const handleSave = () => {
    if (!canSave) return;
    const now = Date.now();
    const peerIsNode = form.peerMode === 'node';
    const peerNodeId = peerIsNode ? form.peerNodeId : null;
    const peerIp = peerIsNode ? null : form.peerIp.trim();
    const inbound = form.direction === 'inbound';

    let sourceNodeId: string | null;
    let sourcePortId: string | null;
    let sourceIp: string | null;
    let targetNodeId: string | null;
    let targetPortId: string | null;
    let targetIp: string | null;

    if (inbound) {
      sourceNodeId = peerNodeId;
      sourceIp = peerIp;
      sourcePortId = peerIsNode
        ? (portsByNode[peerNodeId ?? ''] ?? []).find(
            (port) => port.protocol === form.protocol && port.port === endpointPort,
          )?.id ?? null
        : null;
      targetNodeId = focusNodeId;
      targetPortId = focusPort.id;
      targetIp = null;
    } else {
      sourceNodeId = focusNodeId;
      sourcePortId = focusPort.id;
      sourceIp = null;
      targetNodeId = peerNodeId;
      targetPortId = peerIsNode
        ? (portsByNode[peerNodeId ?? ''] ?? []).find(
            (port) => port.protocol === form.protocol && port.port === endpointPort,
          )?.id ?? null
        : null;
      targetIp = peerIp;
    }

    const next: NetworkPortLink = {
      id: link?.id ?? generateId('plink'),
      sourceNodeId,
      sourcePortId,
      sourceIp,
      sourceProtocol: form.protocol,
      sourcePort: inbound ? endpointPort : focusPort.port,
      targetNodeId,
      targetPortId,
      targetProtocol: form.protocol,
      targetPort: inbound ? focusPort.port : endpointPort,
      targetIp,
      status: form.status,
      source: 'manual',
      evidence: link?.evidence ?? '',
      description: form.description.trim(),
      manualLabel: form.manualLabel.trim(),
      hidden: link?.hidden ?? false,
      firstSeenAt: link?.firstSeenAt ?? now,
      lastConfirmedAt: now,
      createdAt: link?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(next);
    onOpenChange(false);
  };

  const peerTypeLabel = form.direction === 'inbound'
    ? t('network.portLinks.sourcePort')
    : t('network.portLinks.targetPort');

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="!inset-0 !m-auto flex max-h-[85vh] w-[92vw] max-w-xl flex-col gap-0 p-0"
          data-testid="port-link-editor"
        >
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>
              {link ? t('network.portTopology.editLink') : t('network.portTopology.addLink')}
            </DialogTitle>
            <DialogDescription>{t('network.portLinks.title')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {link?.source === 'auto' && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                  {t('topology.source.auto')}
                </Badge>
                <span className="text-[11px] text-muted-foreground">{t('network.portLinks.autoHint')}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t('network.portLinks.direction')}</Label>
              <div className="flex overflow-hidden rounded-md border border-border">
                {(['outbound', 'inbound'] as const).map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    data-testid={`port-link-direction-${direction}`}
                    className={cn(
                      'h-8 flex-1 text-xs transition-colors',
                      form.direction === direction
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent',
                    )}
                    onClick={() => setForm((current) => ({ ...current, direction }))}
                  >
                    {t(`network.portLinks.${direction}`)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {form.direction === 'inbound'
                  ? `${t('network.portTopology.peer')}:${form.protocol.toUpperCase()} ${endpointPort ?? '--'} → ${focusPort.port}/${focusPort.protocol}`
                  : `${focusPort.port}/${focusPort.protocol} → ${t('network.portTopology.peer')}:${form.protocol.toUpperCase()} ${endpointPort ?? '--'}`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="port-link-peer-mode">{t('network.portLinks.peerType')}</Label>
              <Select
                value={form.peerMode}
                onValueChange={(value) => setForm((current) => ({ ...current, peerMode: value as 'node' | 'ip' }))}
              >
                <SelectTrigger id="port-link-peer-mode" className="w-full" data-testid="port-link-peer-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">{t('network.portLinks.targetModeNode')}</SelectItem>
                  <SelectItem value="ip">{t('network.portLinks.targetModeIp')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.peerMode === 'node' ? (
              <div className="space-y-1.5">
                <Label htmlFor="port-link-peer-node">
                  {form.direction === 'inbound' ? t('network.portLinks.sourceServer') : t('network.portLinks.targetServer')}
                </Label>
                <Select
                  value={form.peerNodeId}
                  onValueChange={(value) => setForm((current) => ({ ...current, peerNodeId: value }))}
                >
                  <SelectTrigger id="port-link-peer-node" className="w-full" data-testid="port-link-peer-node">
                    <SelectValue placeholder={t('network.portLinks.targetServer')} />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes
                      .filter((node) => node.id !== focusNodeId || form.direction === 'outbound')
                      .map((node) => (
                        <SelectItem key={node.id} value={node.id}>{nodeLabel(node)}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="port-link-peer-ip">{t('network.portLinks.peerIp')}</Label>
                <Input
                  id="port-link-peer-ip"
                  value={form.peerIp}
                  onChange={(event) => setForm((current) => ({ ...current, peerIp: event.target.value }))}
                  placeholder="10.10.1.21"
                  className="font-mono"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="port-link-peer-port">{peerTypeLabel}</Label>
              {form.direction === 'inbound' && form.peerMode === 'node' && peerPortOptions.length > 0 && (link?.sourcePortId !== null || !link) ? (
                <Select
                  value={form.peerPort}
                  onValueChange={(value) => setForm((current) => ({ ...current, peerPort: value }))}
                >
                  <SelectTrigger id="port-link-peer-port" className="w-full" data-testid="port-link-peer-port">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {peerPortOptions.map((port) => (
                      <SelectItem key={port.id} value={String(port.port)}>
                        {portOptionLabel(port)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="port-link-peer-port"
                  data-testid="port-link-peer-port"
                  value={form.peerPort}
                  onChange={(event) => setForm((current) => ({ ...current, peerPort: event.target.value }))}
                  placeholder="8080"
                  className="font-mono"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="port-link-protocol">{t('network.portLinks.protocol')}</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(value) => setForm((current) => ({ ...current, protocol: value as NetProtocol }))}
                >
                  <SelectTrigger id="port-link-protocol" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROTOCOL_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option.toUpperCase()}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port-link-status">{t('network.portLinks.status')}</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm((current) => ({ ...current, status: value as PortLinkStatus }))}
                >
                  <SelectTrigger id="port-link-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{t(STATUS_LABEL_KEYS[option])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="port-link-label">{t('network.portLinks.manualLabel')}</Label>
                <Input
                  id="port-link-label"
                  data-testid="port-link-label"
                value={form.manualLabel}
                onChange={(event) => setForm((current) => ({ ...current, manualLabel: event.target.value }))}
                placeholder={t('network.portLinks.manualLabelPlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="port-link-description">{t('network.portLinks.description')}</Label>
              <Textarea
                id="port-link-description"
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                placeholder={t('network.portLinks.descriptionPlaceholder')}
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
                  data-testid="port-link-request-delete"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('network.portLinks.delete')}
                </Button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" onClick={handleSave} disabled={!canSave} data-testid="port-link-save">
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
            <DialogTitle>{t('network.portLinks.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('network.portLinks.deleteDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="port-link-confirm-delete"
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
