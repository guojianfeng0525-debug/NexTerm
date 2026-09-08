/**
 * Level-2 topology drill-down for one port.
 *
 * The view reuses the server-level SVG renderer by projecting ports and
 * port-level relations onto synthetic nodes/links. It performs local reads and
 * manual edits only; opening or expanding a node never triggers a probe.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowUpRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { TopologyGraph, nodeLabel } from './topology-graph';
import { PortLinkEditorDialog } from './port-link-editor-dialog';
import { isServerPeerAddress } from '@/lib/network/address-scope';
import {
  getNode,
  getNodeFirewall,
  getNodePorts,
  getPortLinksForPort,
  listNodes,
  listPortLinks,
  listPorts,
  patchPortManual,
  removePortLink,
  subscribeTopology,
  upsertPortLink,
} from '@/lib/network/topology-storage';
import { cn } from '@/lib/utils';
import type {
  NetworkLink,
  NetworkNode,
  NetworkPort,
  NetworkPortLink,
  PortLinkStatus,
} from '@/lib/network/topology-types';

type Direction = 'all' | 'inbound' | 'outbound';

const STATUS_CLASSES: Record<PortLinkStatus, string> = {
  active: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  observed: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
  stale: 'border-transparent bg-muted text-muted-foreground',
  unknown: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
};
const STATUS_KEYS = {
  active: 'topology.linkStatus.active',
  observed: 'topology.linkStatus.observed',
  stale: 'topology.linkStatus.stale',
  unknown: 'topology.linkStatus.unknown',
} as const satisfies Record<PortLinkStatus, string>;
const DIRECTION_KEYS = {
  all: 'network.portTopology.all',
  inbound: 'network.portTopology.inbound',
  outbound: 'network.portTopology.outbound',
} as const satisfies Record<Direction, string>;
const FIREWALL_APPLICABILITY_KEYS = {
  unknown: 'network.portTopology.firewallUnknown',
  metadataAvailable: 'network.portTopology.firewallMetadataAvailable',
  notApplicable: 'network.portTopology.firewallNotApplicable',
} as const;

function makeNode(
  id: string,
  label: string,
  subtitle: string,
  nodeType: string,
  groupPath: string,
): NetworkNode {
  return {
    id,
    connectionId: id,
    groupPath,
    hostname: label,
    osName: '',
    primaryIp: subtitle,
    roleHint: 'general',
    displayName: label,
    nodeType,
    environment: '',
    notes: '',
    hidden: false,
    posX: null,
    posY: null,
    lastProbeAt: null,
    lastProbeStatus: 'never',
    lastProbeError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeLink(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  protocol: 'tcp' | 'udp',
  port: number | null,
  source: 'auto' | 'manual',
  status: PortLinkStatus,
  hidden: boolean,
  manualLabel: string,
  description: string,
): NetworkLink {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    protocol,
    port,
    linkType: 'custom',
    status,
    source,
    evidence: '',
    description,
    manualLabel,
    hidden,
    firstSeenAt: 0,
    lastConfirmedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function formatTimestamp(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

export interface PortTopologyViewProps {
  readonly nodeId: string;
  readonly portId: string;
  readonly host: string;
  readonly onBack: () => void;
  /** Continue the chain to a persisted peer port. Local navigation only. */
  readonly onOpenPort?: (nodeId: string, portId: string) => void;
}

export function PortTopologyView({ nodeId, portId, host, onBack, onOpenPort }: PortTopologyViewProps) {
  const { t } = useTranslation();
  const [storeVersion, setStoreVersion] = useState(0);
  const [direction, setDirection] = useState<Direction>('all');
  const [filterProtocol, setFilterProtocol] = useState<'all' | 'tcp' | 'udp'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | PortLinkStatus>('all');
  const [search, setSearch] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [portEditOpen, setPortEditOpen] = useState(false);
  const [linkEditOpen, setLinkEditOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<NetworkPortLink | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // This is a render projection of a persisted listener row, not a synthetic
  // port entity. The prefix only keeps graph ids disjoint from server ids.
  const centralNodeId = `listener:${portId}`;

  useEffect(() => subscribeTopology(() => setStoreVersion((version) => version + 1)), []);

  const focused = useMemo(
    () => getNodePorts(nodeId).find((port) => port.id === portId),
    [nodeId, portId, storeVersion],
  );
  const { inbound, outbound } = useMemo(
    () => focused ? getPortLinksForPort(nodeId, portId) : { inbound: [], outbound: [] },
    [focused, nodeId, portId, storeVersion],
  );
  const nodes = useMemo(() => listNodes(), [storeVersion]);
  const group = useMemo(() => getNode(nodeId)?.groupPath || '', [nodeId, storeVersion]);
  const nodesInGroup = useMemo(() => nodes.filter(node => (node.groupPath || '') === group), [group, nodes]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const portsByNode = useMemo(() => {
    const map: Record<string, NetworkPort[]> = {};
    const ids = new Set(nodesInGroup.map(node => node.id));
    for (const port of listPorts()) {
      if (ids.has(port.nodeId)) map[port.nodeId] = [...(map[port.nodeId] ?? []), port];
    }
    return map;
  }, [storeVersion]);
  const firewallApplicability = useMemo(
    () => {
      if (!focused) return 'unknown' as const;
      const firewall = getNodeFirewall(nodeId);
      if (!firewall) return 'unknown' as const;
      return firewall.active ? 'metadataAvailable' as const : 'notApplicable' as const;
    },
    [focused, nodeId, storeVersion],
  );
  const scopedInbound = useMemo(
    () => inbound.filter(link => link.sourceIp == null || isServerPeerAddress(link.sourceIp)),
    [inbound],
  );

  const scopedOutbound = useMemo(
    () => outbound.filter(link => link.targetIp == null || isServerPeerAddress(link.targetIp)),
    [outbound],
  );

  const relatedServers = useMemo(() => {
    const ids = new Set<string>();
    for (const link of [...scopedInbound, ...scopedOutbound]) {
      if (link.sourceNodeId && link.sourceNodeId !== nodeId) ids.add(link.sourceNodeId);
      if (link.targetNodeId && link.targetNodeId !== nodeId) ids.add(link.targetNodeId);
    }
    return ids.size;
  }, [scopedInbound, scopedOutbound, nodeId]);

  const allLinks = useMemo(() => {
    if (direction === 'inbound') return scopedInbound;
    if (direction === 'outbound') return scopedOutbound;
    return [...scopedInbound, ...scopedOutbound];
  }, [direction, scopedInbound, scopedOutbound]);

  const endpointOf = useMemo(() => {
    const describe = (link: NetworkPortLink, source: boolean) => {
      const peerNodeId = source ? link.sourceNodeId : link.targetNodeId;
      const peerIp = source ? link.sourceIp : link.targetIp;
      const peerPort = source ? link.sourcePort : link.targetPort;
      const protocol = source ? link.sourceProtocol : link.targetProtocol;
      const peerPortId = source ? link.sourcePortId : link.targetPortId;
      const node = peerNodeId ? nodesById.get(peerNodeId) : undefined;
      const endpointLabel = node
        ? peerPortId
          ? `${nodeLabel(node)} · ${peerPort}/${protocol}`
          : nodeLabel(node)
        : peerIp ?? '?';
      return {
        nodeId: peerNodeId,
        portId: peerPortId,
        ip: peerIp,
        port: peerPort,
        protocol,
        label: endpointLabel,
        subtitle: node?.primaryIp || (peerPortId ? `${peerPort}/${protocol}` : ''),
        type: 'server',
      };
    };
    return (link: NetworkPortLink) => {
      const isOutbound = link.sourceNodeId === nodeId && link.sourcePortId === portId;
      return { isOutbound, peer: describe(link, !isOutbound) };
    };
  }, [nodeId, nodesById, portId]);

  const filteredLinks = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allLinks.filter((link) => {
      if (filterProtocol !== 'all' && link.sourceProtocol !== filterProtocol && link.targetProtocol !== filterProtocol) return false;
      if (filterStatus !== 'all' && link.status !== filterStatus) return false;
      if (!term) return true;
      const { peer } = endpointOf(link);
      return [
        peer.label,
        peer.subtitle,
        String(peer.port),
        link.manualLabel,
        link.description,
        link.evidence,
      ].join(' ').toLowerCase().includes(term);
    });
  }, [allLinks, endpointOf, filterProtocol, filterStatus, search]);

  const { graphNodes, graphLinks } = useMemo(() => {
    if (!focused) return { graphNodes: [], graphLinks: [] };
    const centralId = centralNodeId;
    const central = makeNode(
      centralId,
      `${focused.port}/${focused.protocol}`,
      `${host || focused.listenAddr} · ${focused.listenAddr}`,
      'port',
      group,
    );
    const syntheticNodes = [central];
    const syntheticLinks: NetworkLink[] = [];

    for (const link of filteredLinks) {
      const { isOutbound, peer } = endpointOf(link);
      const peerKey = `peer:${peer.nodeId ?? peer.ip}:${peer.protocol}:${peer.portId ?? 'server'}`;
      if (!syntheticNodes.some((node) => node.id === peerKey)) {
        syntheticNodes.push(makeNode(peerKey, peer.label, peer.subtitle, peer.type, group));
      }
      syntheticLinks.push(
        makeLink(
          link.id,
          isOutbound ? centralId : peerKey,
          isOutbound ? peerKey : centralId,
          peer.protocol,
          peer.portId ? peer.port : null,
          link.source,
          link.status,
          link.hidden,
          link.manualLabel,
          link.description,
        ),
      );
    }

    for (const node of syntheticNodes) {
      const position = positionsRef.current.get(node.id);
      if (position) {
        node.posX = position.x;
        node.posY = position.y;
      }
    }
    return { graphNodes: syntheticNodes, graphLinks: syntheticLinks };
  }, [focused, filteredLinks, endpointOf, group, host, portId]);

  const openPort = (nodeId: string, portId: string) => {
    onOpenPort?.(nodeId, portId);
    if (!onOpenPort) return;
    setSelectedNodeId(null);
    setSelectedLinkId(null);
  };

  const handleMoveNode = (id: string, x: number, y: number) => {
    positionsRef.current.set(id, { x, y });
    setLayoutVersion((version) => version + 1);
  };

  if (!focused) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2">
        <Button type="button" variant="ghost" size="sm" className="w-fit gap-1" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('network.portTopology.back')}
        </Button>
        <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">{t('network.portTopology.empty')}</p>
      </div>
    );
  }

  const chips: Array<{ label: string; value: React.ReactNode; title?: string }> = [
    { label: t('network.portLinks.protocol'), value: focused.protocol.toUpperCase() },
    { label: t('network.ports.listenAddr'), value: focused.listenAddr || t('network.common.na') },
    { label: t('network.portTopology.listenState'), value: focused.state || t('network.common.na') },
    { label: t('network.portTopology.pid'), value: focused.pid === null ? t('network.common.na') : focused.pid },
    { label: t('network.portTopology.process'), value: focused.processName || t('network.common.na') },
    { label: t('network.portTopology.serviceName'), value: focused.serviceName || t('network.common.na') },
    { label: t('network.portTopology.purpose'), value: focused.purpose || t('network.common.na') },
    { label: t('network.portTopology.firewallStatus'), value: t(FIREWALL_APPLICABILITY_KEYS[firewallApplicability]) },
    { label: t('network.portTopology.relatedServers'), value: relatedServers },
    { label: t('network.portTopology.inboundCount'), value: scopedInbound.length },
    { label: t('network.portTopology.outboundCount'), value: scopedOutbound.length },
    { label: t('network.portTopology.lastProbe'), value: formatTimestamp(focused.lastSeenAt) },
  ];

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 p-2"
      key={`${nodeId}:${portId}`}
      data-testid="port-topology-view"
    >
      <div className="shrink-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onBack} aria-label={t('network.portTopology.back')}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium">
              <span className="font-mono">{host || focused.listenAddr}:{focused.port}</span>
              <span className="ml-1 text-[9px] uppercase text-muted-foreground">{focused.protocol}</span>
            </p>
          </div>
          <Button type="button" variant="outline" size="icon" className="h-6 w-6 shrink-0" onClick={() => setPortEditOpen(true)} aria-label={t('network.portTopology.editPort')}>
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10px]"
            data-testid="port-link-add"
            onClick={() => { setEditingLink(null); setLinkEditOpen(true); }}
          >
            <Plus className="h-3 w-3" />
            {t('network.portTopology.addLink')}
          </Button>
        </div>

        <div className="rounded-md border border-border bg-muted/20">
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 p-2 sm:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-7">
            {chips.map((chip) => (
              <div key={chip.label} className="min-w-0" title={chip.title}>
                <p className="truncate text-[9px] text-muted-foreground">{chip.label}</p>
                <div className="truncate text-[10px] font-medium text-foreground">{chip.value}</div>
              </div>
            ))}
          </div>
          <p className="border-t border-border px-2 py-1 text-[9px] text-muted-foreground">
            {t('network.portTopology.stateHint')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <div className="flex overflow-hidden rounded-md border border-border">
            {(['all', 'inbound', 'outbound'] as Direction[]).map((item) => (
              <button
                key={item}
                type="button"
                data-testid={`port-direction-${item}`}
                onClick={() => setDirection(item)}
                className={cn('h-6 px-2 text-[10px]', direction === item ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:bg-accent')}
              >
                {t(DIRECTION_KEYS[item])}
              </button>
            ))}
          </div>
          <Select value={filterProtocol} onValueChange={(value) => setFilterProtocol(value as 'all' | 'tcp' | 'udp')}>
            <SelectTrigger className="h-6 w-[5.5rem] text-[10px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('network.portTopology.filterProtocol')}: {t('network.portTopology.all')}</SelectItem>
              <SelectItem value="tcp">TCP</SelectItem>
              <SelectItem value="udp">UDP</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={(value) => setFilterStatus(value as 'all' | PortLinkStatus)}>
            <SelectTrigger className="h-6 w-[5.5rem] text-[10px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('network.portTopology.filterStatus')}: {t('network.portTopology.all')}</SelectItem>
              {(['active', 'observed', 'stale', 'unknown'] as PortLinkStatus[]).map((status) => (
                <SelectItem key={status} value={status}>{t(STATUS_KEYS[status])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('network.portTopology.searchPlaceholder')} className="h-6 min-w-0 flex-1 px-2 text-[10px]" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/20">
        {graphLinks.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[10px] text-muted-foreground">{t('network.portTopology.noLinks')}</div>
        ) : (
          <TopologyGraph
            nodes={graphNodes}
            links={graphLinks}
            selectedNodeId={selectedNodeId ?? centralNodeId}
            selectedLinkId={selectedLinkId}
            layoutSeed={layoutVersion}
            onSelectNode={setSelectedNodeId}
            onSelectLink={setSelectedLinkId}
            onEditNode={(id) => {
              if (id === centralNodeId) {
                setPortEditOpen(true);
                return;
              }
              const real = filteredLinks.find((link) => {
                const peer = endpointOf(link).peer;
                return `peer:${peer.nodeId ?? peer.ip}:${peer.protocol}:${peer.portId ?? 'server'}` === id;
              });
              const endpoint = real ? endpointOf(real).peer : undefined;
              if (endpoint?.nodeId && endpoint.portId) openPort(endpoint.nodeId, endpoint.portId);
            }}
            onEditLink={(id) => {
              const real = listPortLinks().find((link) => link.id === id);
              if (real) {
                setEditingLink(real);
                setLinkEditOpen(true);
              }
            }}
            onHideNode={() => undefined}
            onRequestDeleteNode={() => undefined}
            onMoveNode={handleMoveNode}
          />
        )}
      </div>

      <div className="max-h-[32%] shrink-0 overflow-auto rounded-md border border-border">
        {filteredLinks.length === 0 ? (
          <p className="px-2 py-3 text-center text-[10px] text-muted-foreground">{t('network.portTopology.noLinks')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {filteredLinks.map((link) => {
              const { isOutbound, peer } = endpointOf(link);
              return (
                <li key={link.id} className="flex items-center gap-1.5 px-2 py-1.5 text-[10px]">
                  <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                    {isOutbound ? t('network.portTopology.outbound') : t('network.portTopology.inbound')}
                  </Badge>
                  <span className={cn('truncate', link.hidden && 'opacity-50')} title={peer.label}>{peer.label}</span>
                  {link.manualLabel && (
                    <span className="min-w-0 max-w-[9rem] truncate text-muted-foreground" title={link.manualLabel}>
                      {link.manualLabel}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground" title={t('network.portTopology.lastProbe')}>
                    {formatTimestamp(link.lastConfirmedAt)}
                  </span>
                  <Badge variant="outline" className={cn('h-4 px-1 text-[9px]', STATUS_CLASSES[link.status])}>{t(STATUS_KEYS[link.status])}</Badge>
                  {link.source === 'manual' && (
                    <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] text-muted-foreground">{t('topology.source.manual')}</Badge>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    {peer.nodeId && peer.portId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        data-testid={`open-peer-port-${peer.nodeId}-${peer.portId}`}
                        onClick={() => openPort(peer.nodeId as string, peer.portId as string)}
                        aria-label={t('network.portTopology.openPeerPort')}
                      >
                        <ArrowUpRight className="h-2.5 w-2.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      data-testid={`port-link-edit-${link.id}`}
                      onClick={() => { setEditingLink(link); setLinkEditOpen(true); }}
                      aria-label={t('network.portTopology.editLink')}
                    >
                      <Pencil className="h-2.5 w-2.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-5 w-5 text-destructive" onClick={() => removePortLink(link.id)} aria-label={t('network.portLinks.delete')}>
                      <Trash2 className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <PortEditDialog open={portEditOpen} onOpenChange={setPortEditOpen} port={focused} onSave={(patch) => patchPortManual(nodeId, portId, patch)} />

      <PortLinkEditorDialog
        open={linkEditOpen}
        onOpenChange={setLinkEditOpen}
        link={editingLink}
        focusNodeId={nodeId}
        focusPort={focused}
        nodes={nodesInGroup}
        portsByNode={portsByNode}
        onSave={upsertPortLink}
        onDelete={removePortLink}
      />
    </div>
  );
}

interface PortEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: NetworkPort;
  onSave: (patch: Partial<Pick<NetworkPort, 'serviceName' | 'purpose' | 'notes' | 'tags' | 'hidden'>>) => void;
}

function PortEditDialog({ open, onOpenChange, port, onSave }: PortEditDialogProps) {
  const { t } = useTranslation();
  const [serviceName, setServiceName] = useState(port.serviceName);
  const [purpose, setPurpose] = useState(port.purpose);
  const [notes, setNotes] = useState(port.notes);
  const [tags, setTags] = useState(port.tags.join(', '));

  useEffect(() => {
    if (!open) return;
    setServiceName(port.serviceName);
    setPurpose(port.purpose);
    setNotes(port.notes);
    setTags(port.tags.join(', '));
  }, [open, port]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!inset-0 !m-auto !h-[430px] !translate-x-0 !translate-y-0 flex max-h-[85vh] !w-[calc(100vw-2rem)] !max-w-none flex-col gap-0 overflow-hidden p-0 sm:!max-w-md">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle>{t('network.portTopology.editPort')}</DialogTitle>
          <DialogDescription><span className="font-mono">{port.port}/{port.protocol}</span> @ {port.listenAddr}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="port-edit-service">{t('network.portTopology.serviceName')}</Label>
              <Input id="port-edit-service" value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder={t('network.ports.servicePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="port-edit-purpose">{t('network.portTopology.purpose')}</Label>
              <Input id="port-edit-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="port-edit-tags">{t('network.portTopology.tags')}</Label>
            <Input id="port-edit-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="web, backend, internal" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="port-edit-notes">{t('network.portTopology.notes')}</Label>
            <Textarea id="port-edit-notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-[72px] resize-none" />
          </div>
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-3">
          <div className="flex w-full justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="button" onClick={() => {
              onSave({
                serviceName: serviceName.trim(),
                purpose: purpose.trim(),
                notes: notes.trim(),
                tags: tags.split(',').map((item) => item.trim()).filter(Boolean),
              });
              onOpenChange(false);
            }}>{t('common.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
