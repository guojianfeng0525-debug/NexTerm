/**
 * Toolbox view: the global network topology.
 *
 * This is the cross-server view — nodes accumulate as the user probes servers
 * from the per-server "Network" tab, and relationships are merged by the
 * storage layer. Everything here is read/write on top of `topology-storage`;
 * probing itself is never triggered from this view.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Network, Plus, Search, Wand2, ZoomIn, ZoomOut, Maximize2, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  getNodeInterfaces,
  getNodePorts,
  listLinks,
  listNodes,
  removeNode,
  removeLink,
  removeNodes,
  subscribeTopology,
  upsertLink,
  upsertNode,
} from '@/lib/network/topology-storage';
import type { NetworkLink, NetworkNode, NetworkPort } from '@/lib/network/topology-types';
import { cn } from '@/lib/utils';
import { ConnectionStorageManager } from '@/lib/connection-storage';
import { SERVER_GROUP_ROOT } from '@/lib/network/address-scope';
import {
  TopologyGraph,
  computeAutoLayout,
  nodeLabel,
  type TopologyGraphHandle,
} from '@/components/network/topology-graph';
import { TopologyNodeDialog } from '@/components/network/topology-node-dialog';
import { LinkEditorDialog } from '@/components/network/link-editor-dialog';
import { PortTopologyView } from '@/components/network/port-topology';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const LINK_TYPE_BADGE: Record<string, string> = {
  ssh: 'bg-chart-1/15 text-chart-1 border-chart-1/30',
  http: 'bg-chart-2/15 text-chart-2 border-chart-2/30',
  database: 'bg-chart-3/15 text-chart-3 border-chart-3/30',
  cache: 'bg-chart-5/15 text-chart-5 border-chart-5/30',
  messaging: 'bg-chart-4/15 text-chart-4 border-chart-4/30',
  custom: 'bg-muted text-muted-foreground border-border',
  unknown: 'bg-muted text-muted-foreground border-border',
};

function formatTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Date(value).toLocaleString();
}

export function ToolTopology() {
  const { t } = useTranslation();
  const graphRef = useRef<TopologyGraphHandle | null>(null);

  const [nodes, setNodes] = useState<NetworkNode[]>([]);
  const [links, setLinks] = useState<NetworkLink[]>([]);
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [isolationGroup, setIsolationGroup] = useState(SERVER_GROUP_ROOT);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [layoutSeed, setLayoutSeed] = useState(0);

  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<NetworkLink | null>(null);
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<NetworkNode | null>(null);
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<NetworkNode[]>([]);
  const [deleteLinkTarget, setDeleteLinkTarget] = useState<NetworkLink | null>(null);
  const [drillDownPort, setDrillDownPort] = useState<{ nodeId: string; portId: string; host: string } | null>(null);

  const reload = useCallback(() => {
    setNodes(listNodes());
    setLinks(listLinks());
  }, []);

  // Group assignment is informational only (dropdown filter label). Saved
  // nodes follow their connection's folder; observed nodes keep the group of
  // the server that first observed them. NOTHING here can hide a node or an
  // edge — the graph renders exactly what is stored (WYSIWYG contract).
  const scopeOf = useCallback((node: NetworkNode): string => {
    if (node.connectionId.startsWith('observed:')) {
      return node.groupPath?.trim() || SERVER_GROUP_ROOT;
    }
    return ConnectionStorageManager.getConnection(node.connectionId)?.folder
      || SERVER_GROUP_ROOT;
  }, []);

  const groups = useMemo(() => {
    const observed = nodes.map(scopeOf);
    return [...new Set([SERVER_GROUP_ROOT, ...observed])]
      .sort((a, b) => a === SERVER_GROUP_ROOT ? -1 : b === SERVER_GROUP_ROOT ? 1 : a.localeCompare(b));
  }, [nodes, scopeOf]);

  useEffect(() => {
    if (!groups.includes(isolationGroup)) setIsolationGroup(SERVER_GROUP_ROOT);
  }, [groups, isolationGroup]);

  // The per-server panel writes to the same tables — keep the graph live.
  useEffect(() => {
    reload();
    return subscribeTopology(reload);
  }, [reload]);

  const visibleNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return nodes.filter((node) => {
      if (node.hidden && !showHidden) return false;
      // 「全部连接」= everything (cross-group edges included). A picked group
      // is a plain view filter. No address blacklist, no group scoping.
      if (isolationGroup !== SERVER_GROUP_ROOT && scopeOf(node) !== isolationGroup) return false;
      if (!query) return true;
      return (
        nodeLabel(node).toLowerCase().includes(query) ||
        node.hostname.toLowerCase().includes(query) ||
        node.primaryIp.toLowerCase().includes(query)
      );
    });
  }, [isolationGroup, nodes, scopeOf, search, showHidden]);

  const visibleLinks = useMemo(() => {
    const ids = new Set(visibleNodes.map((node) => node.id));
    return links.filter(
      (link) =>
        (showHidden || !link.hidden) &&
        ids.has(link.sourceNodeId) &&
        ids.has(link.targetNodeId),
    );
  }, [links, showHidden, visibleNodes]);

  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === selectedNodeId) ?? null,
    [visibleNodes, selectedNodeId],
  );
  const selectedVisibleIds = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map(node => node.id));
    const ids = new Set(selectedNodeIds);
    if (selectedNodeId) ids.add(selectedNodeId);
    return new Set([...ids].filter(id => visibleIds.has(id)));
  }, [selectedNodeId, selectedNodeIds, visibleNodes]);
  const selectedLink = useMemo(
    () => visibleLinks.find((link) => link.id === selectedLinkId) ?? null,
    [visibleLinks, selectedLinkId],
  );
  const selectedNodePorts = useMemo(
    () => (selectedNode ? getNodePorts(selectedNode.id) : []),
    [selectedNode],
  );

  const labelForId = useCallback(
    (id: string): string => {
      const node = nodes.find((item) => item.id === id);
      return node ? nodeLabel(node) : '—';
    },
    [nodes],
  );

  const nodeStats = useMemo(() => {
    if (!selectedNode) return { interfaces: 0, ports: 0 };
    return {
      interfaces: getNodeInterfaces(selectedNode.id).length,
      ports: getNodePorts(selectedNode.id).length,
    };
  }, [selectedNode]);

  /* ── node actions ─────────────────────────────────────────────────────── */

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedNodeIds(id ? [id] : []);
    setSelectedLinkId(null);
  }, []);

  const handleSelectedNodeIdsChange = useCallback((ids: string[]) => {
    setSelectedNodeIds(ids);
    setSelectedNodeId(ids.at(-1) ?? null);
    setSelectedLinkId(null);
  }, []);

  const handleEditNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    setSelectedLinkId(null);
    setNodeDialogOpen(true);
  }, []);

  const handleSaveNode = useCallback(
    (node: NetworkNode) => {
      upsertNode({ ...node, updatedAt: Date.now() });
      reload();
      toast.success(t('topology.toast.nodeSaved'), { description: nodeLabel(node) });
    },
    [reload, t],
  );

  const handleResetNodeLayout = useCallback(
    (id: string) => {
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      upsertNode({ ...node, posX: null, posY: null, updatedAt: Date.now() });
      setLayoutSeed((seed) => seed + 1);
      reload();
      toast.success(t('topology.toast.layoutReset'));
    },
    [nodes, reload, t],
  );

  const handleHideNode = useCallback(
    (id: string) => {
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      upsertNode({ ...node, hidden: !node.hidden, updatedAt: Date.now() });
      reload();
      toast.success(node.hidden ? t('topology.toast.nodeShown') : t('topology.toast.nodeHidden'), {
        description: nodeLabel(node),
      });
    },
    [nodes, reload, t],
  );

  const handleDeleteNode = useCallback(
    (id: string) => {
      const node = nodes.find((item) => item.id === id);
      removeNode(id);
      if (selectedNodeId === id) setSelectedNodeId(null);
      setSelectedNodeIds((current) => current.filter(itemId => itemId !== id));
      reload();
      toast.success(t('topology.toast.nodeDeleted'), {
        description: node ? nodeLabel(node) : undefined,
      });
    },
    [nodes, reload, selectedNodeId, t],
  );

  const handleDeleteNodes = useCallback(
    (ids: string[]) => {
      const targets = visibleNodes.filter(node => ids.includes(node.id));
      if (targets.length === 0) return;
      removeNodes(targets.map(node => node.id));
      setSelectedNodeId(null);
      setSelectedNodeIds([]);
      reload();
      toast.success(t('topology.toast.nodesDeleted', { count: targets.length }));
    },
    [reload, t, visibleNodes],
  );

  const openBulkNodeDelete = useCallback(() => {
    setBulkDeleteTargets(visibleNodes.filter(node => selectedVisibleIds.has(node.id)));
  }, [selectedVisibleIds, visibleNodes]);

  const handleMoveNode = useCallback(
    (id: string, x: number, y: number) => {
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      upsertNode({ ...node, posX: x, posY: y, updatedAt: Date.now() });
      reload();
    },
    [nodes, reload],
  );

  const handleAutoLayout = useCallback(() => {
    if (visibleNodes.length === 0) return;
    const positions = computeAutoLayout(visibleNodes, visibleLinks, { force: true });
    for (const node of visibleNodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      upsertNode({
        ...node,
        posX: Math.round(point.x),
        posY: Math.round(point.y),
        updatedAt: Date.now(),
      });
    }
    setLayoutSeed((seed) => seed + 1);
    reload();
    toast.success(t('topology.toast.layoutApplied'));
    // Give the freshly persisted coordinates a frame before fitting.
    requestAnimationFrame(() => graphRef.current?.fitToView());
  }, [reload, t, visibleLinks, visibleNodes]);

  /* ── link actions ─────────────────────────────────────────────────────── */

  const openCreateLink = useCallback(() => {
    setEditingLink(null);
    setLinkDialogOpen(true);
  }, []);

  const handleEditLink = useCallback((id: string) => {
    const link = links.find((item) => item.id === id);
    if (!link) return;
    setEditingLink(link);
    setSelectedLinkId(id);
    setSelectedNodeId(null);
    setLinkDialogOpen(true);
  }, [links]);

  const handleToggleLinkHidden = useCallback((id: string) => {
    const link = links.find((item) => item.id === id);
    if (!link) return;
    upsertLink({ ...link, hidden: !link.hidden, updatedAt: Date.now() });
    reload();
    toast.success(link.hidden ? t('topology.toast.linkShown') : t('topology.toast.linkHidden'));
  }, [links, reload, t]);

  const handleSaveLink = useCallback(
    (link: NetworkLink) => {
      const exists = links.some((item) => item.id === link.id);
      upsertLink(link);
      reload();
      toast.success(exists ? t('topology.toast.linkSaved') : t('topology.toast.linkCreated'));
    },
    [links, reload, t],
  );

  const handleDeleteLink = useCallback(
    (id: string) => {
      removeLink(id);
      if (selectedLinkId === id) setSelectedLinkId(null);
      reload();
      toast.success(t('topology.toast.linkDeleted'));
    },
    [reload, selectedLinkId, t],
  );

  /* ── render ───────────────────────────────────────────────────────────── */

  const hasAnyNode = visibleNodes.length > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Network className="h-4 w-4 text-primary" />
            {t('topology.title')}
            <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
              {drillDownPort
                ? t('network.portTopology.drillDownBadge')
                : t('topology.stats', { nodes: visibleNodes.length, links: visibleLinks.length })}
            </Badge>
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {drillDownPort ? t('network.portTopology.drillDownDescription') : t('topology.description')}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('topology.searchPlaceholder')}
              aria-label={t('topology.search')}
              className="h-7 w-[168px] pl-7 text-xs"
            />
          </div>

          <Select value={isolationGroup} onValueChange={setIsolationGroup}>
            <SelectTrigger
              className="h-7 w-[168px] text-xs"
              aria-label={t('topology.isolationGroup')}
              data-testid="topology-isolation-group"
            >
              <SelectValue>
                {isolationGroup === SERVER_GROUP_ROOT
                  ? t('connectionDialog.allConnections')
                  : isolationGroup.split('/').pop() || isolationGroup}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {groups.map(group => (
                <SelectItem key={group} value={group} className="text-xs" title={group}>
                  {group === SERVER_GROUP_ROOT
                    ? t('connectionDialog.allConnections')
                    : group.split('/').pop() || group}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
            <Switch
              id="topology-show-hidden"
              checked={showHidden}
              onCheckedChange={setShowHidden}
              className="scale-75"
            />
            <Label
              htmlFor="topology-show-hidden"
              className="cursor-pointer text-[11px] text-muted-foreground"
            >
              {t('topology.showHidden')}
            </Label>
          </div>

          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={handleAutoLayout}
            disabled={!hasAnyNode}
          >
            <Wand2 className="h-3.5 w-3.5" />
            {t('topology.autoLayout')}
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={openCreateLink}
            disabled={visibleNodes.length < 2}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('topology.newLink')}
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={openBulkNodeDelete}
            disabled={selectedVisibleIds.size === 0 || !!drillDownPort}
            data-testid="topology-delete-selected"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {selectedVisibleIds.size > 1
              ? t('topology.deleteSelectedCount', { count: selectedVisibleIds.size })
              : t('topology.deleteSelected')}
          </Button>

          <div className="flex items-center overflow-hidden rounded-md border border-border">
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() => graphRef.current?.zoomOut()}
              title={t('topology.zoomOut')}
              aria-label={t('topology.zoomOut')}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <Separator orientation="vertical" className="h-7" />
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() => graphRef.current?.zoomIn()}
              title={t('topology.zoomIn')}
              aria-label={t('topology.zoomIn')}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <Separator orientation="vertical" className="h-7" />
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() => graphRef.current?.fitToView()}
              title={t('topology.fitView')}
              aria-label={t('topology.fitView')}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      {!hasAnyNode ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border p-10 text-center">
            <div className="rounded-full bg-primary/10 p-3 text-primary">
              <Network className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-foreground">{t('topology.empty')}</p>
            <p className="text-xs text-muted-foreground">{t('topology.emptyDesc')}</p>
          </div>
        </div>
      ) : drillDownPort ? (
        <div className="min-h-0 flex-1">
          <PortTopologyView
            key={`${drillDownPort.nodeId}:${drillDownPort.portId}`}
            nodeId={drillDownPort.nodeId}
            portId={drillDownPort.portId}
            host={drillDownPort.host}
            onBack={() => setDrillDownPort(null)}
            onOpenPort={(peerNodeId, peerPortId) => {
              const peer = nodes.find((item) => item.id === peerNodeId);
              setDrillDownPort({ nodeId: peerNodeId, portId: peerPortId, host: peer?.primaryIp ?? '' });
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <TopologyGraph
              ref={graphRef}
              nodes={visibleNodes}
              links={visibleLinks}
              selectedNodeId={selectedNodeId}
              selectedLinkId={selectedLinkId}
              selectedNodeIds={selectedVisibleIds}
              layoutSeed={layoutSeed}
              onSelectNode={handleSelectNode}
              onSelectedNodeIdsChange={handleSelectedNodeIdsChange}
              onSelectLink={setSelectedLinkId}
              onEditNode={handleEditNode}
              onEditLink={handleEditLink}
              onHideNode={handleHideNode}
              onToggleLinkHidden={handleToggleLinkHidden}
              onRequestDeleteNode={(id) =>
                setDeleteNodeTarget(nodes.find((item) => item.id === id) ?? null)
              }
              onRequestDeleteNodes={(ids) => {
                setBulkDeleteTargets(visibleNodes.filter(node => ids.includes(node.id)));
              }}
              onMoveNode={handleMoveNode}
            />
          </div>

          <aside className="w-[300px] shrink-0 overflow-hidden border-l border-border bg-card/40">
            <ScrollArea className="h-full">
              <div className="space-y-3 p-4">
                <h4 className="text-xs font-semibold text-foreground">
                  {t('topology.details.title')}
                </h4>
                {selectedNode ? (
                    <NodeDetails
                      node={selectedNode}
                      interfaceCount={nodeStats.interfaces}
                      portCount={nodeStats.ports}
                      ports={selectedNodePorts}
                      onOpenPort={(port) => setDrillDownPort({
                        nodeId: selectedNode.id,
                        portId: port.id,
                        host: selectedNode.primaryIp,
                      })}
                      onEdit={() => handleEditNode(selectedNode.id)}
                    onHide={() => handleHideNode(selectedNode.id)}
                    onDelete={() => setDeleteNodeTarget(selectedNode)}
                  />
                ) : selectedLink ? (
                  <LinkDetails
                    link={selectedLink}
                    sourceLabel={labelForId(selectedLink.sourceNodeId)}
                    targetLabel={labelForId(selectedLink.targetNodeId)}
                    onEdit={() => handleEditLink(selectedLink.id)}
                    onDelete={() => setDeleteLinkTarget(selectedLink)}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('topology.details.noSelection')}
                    <br />
                    <span className="text-[11px]">{t('topology.details.noSelectionHint')}</span>
                  </p>
                )}
              </div>
            </ScrollArea>
          </aside>
        </div>
      )}

      {/* Dialogs */}
      <TopologyNodeDialog
        open={nodeDialogOpen}
        onOpenChange={setNodeDialogOpen}
        node={selectedNode}
        interfaceCount={nodeStats.interfaces}
        portCount={nodeStats.ports}
        onSave={handleSaveNode}
        onResetLayout={handleResetNodeLayout}
        onDelete={handleDeleteNode}
      />
      <LinkEditorDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        link={editingLink}
        nodes={visibleNodes}
        defaultSourceId={selectedNodeId}
        onSave={handleSaveLink}
        onDelete={handleDeleteLink}
      />

      <AlertDialog
        open={!!deleteNodeTarget}
        onOpenChange={(open) => !open && setDeleteNodeTarget(null)}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('topology.deleteNodeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('topology.deleteNodeDesc', {
                name: deleteNodeTarget ? nodeLabel(deleteNodeTarget) : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="topology-delete-node-confirm"
              onClick={() => {
                if (deleteNodeTarget) handleDeleteNode(deleteNodeTarget.id);
                setDeleteNodeTarget(null);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={bulkDeleteTargets.length > 0}
        onOpenChange={(open) => !open && setBulkDeleteTargets([])}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('topology.deleteSelectedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('topology.deleteSelectedDesc', { count: bulkDeleteTargets.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="topology-delete-selected-confirm"
              onClick={() => {
                handleDeleteNodes(bulkDeleteTargets.map(node => node.id));
                setBulkDeleteTargets([]);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteLinkTarget}
        onOpenChange={(open) => !open && setDeleteLinkTarget(null)}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('topology.linkDialog.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('topology.linkDialog.deleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteLinkTarget) handleDeleteLink(deleteLinkTarget.id);
                setDeleteLinkTarget(null);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ══ detail panels ════════════════════════════════════════════════════════ */

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="truncate text-xs text-foreground">{children}</div>
    </div>
  );
}

interface NodeDetailsProps {
  readonly node: NetworkNode;
  readonly interfaceCount: number;
  readonly portCount: number;
  readonly ports: NetworkPort[];
  readonly onOpenPort: (port: NetworkPort) => void;
  readonly onEdit: () => void;
  readonly onHide: () => void;
  readonly onDelete: () => void;
}

function NodeDetails({
  node,
  interfaceCount,
  portCount,
  ports,
  onOpenPort,
  onEdit,
  onHide,
  onDelete,
}: NodeDetailsProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <p className="truncate text-sm font-medium text-foreground">{nodeLabel(node)}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {node.primaryIp || '—'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <DetailRow label={t('topology.node.hostname')}>{node.hostname || '—'}</DetailRow>
        <DetailRow label={t('topology.node.os')}>{node.osName || '—'}</DetailRow>
        <DetailRow label={t('topology.nodeDialog.environment')}>
          {node.environment
            ? t(`topology.environment.${node.environment}`, { defaultValue: node.environment })
            : '—'}
        </DetailRow>
        <DetailRow label={t('topology.nodeDialog.nodeType')}>
          {node.nodeType
            ? t(`topology.nodeType.${node.nodeType}`, { defaultValue: node.nodeType })
            : '—'}
        </DetailRow>
        <DetailRow label={t('topology.node.roleHint')}>
          {t(`topology.role.${node.roleHint}`, { defaultValue: node.roleHint })}
        </DetailRow>
        <DetailRow label={t('topology.node.lastProbeStatus')}>
          {t(`topology.probeStatus.${node.lastProbeStatus}`)}
        </DetailRow>
        <DetailRow label={t('topology.node.interfaceCount')}>{interfaceCount}</DetailRow>
        <DetailRow label={t('topology.node.portCount')}>{portCount}</DetailRow>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-foreground">{t('network.portTopology.serverPorts')}</p>
        {ports.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t('network.portTopology.empty')}</p>
        ) : (
          <div className="max-h-44 overflow-auto rounded-md border border-border">
            {ports.map((port) => (
              <button
                key={port.id}
                type="button"
                data-testid={`server-port-${port.id}`}
                onClick={() => onOpenPort(port)}
                title={t('network.portTopology.drillDown')}
                className="flex w-full items-center gap-1.5 border-b border-border px-2 py-1.5 text-left text-[11px] transition-colors last:border-b-0 hover:bg-accent"
              >
                <span className="font-mono">{port.port}</span>
                <span className="text-[9px] uppercase text-muted-foreground">{port.protocol}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {[port.listenAddr, port.serviceName, port.processName].filter(Boolean).join(' · ')}
                </span>
                <span className="font-mono text-[9px] text-muted-foreground">{port.state || '—'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {node.notes && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 text-[11px] text-foreground">
          {node.notes}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onEdit}>
          <Pencil className="h-3 w-3" />
          {t('common.edit')}
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onHide}>
          {node.hidden ? (
            <Eye className="h-3 w-3" />
          ) : (
            <EyeOff className="h-3 w-3" />
          )}
          {node.hidden ? t('topology.unhideNode') : t('topology.hideNode')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
          {t('common.delete')}
        </Button>
      </div>
    </div>
  );
}

interface LinkDetailsProps {
  readonly link: NetworkLink;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

function LinkDetails({ link, sourceLabel, targetLabel, onEdit, onDelete }: LinkDetailsProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
            link.linkType === 'ssh' && 'bg-chart-1',
            link.linkType === 'http' && 'bg-chart-2',
            link.linkType === 'database' && 'bg-chart-3',
            link.linkType === 'cache' && 'bg-chart-5',
            link.linkType === 'messaging' && 'bg-chart-4',
            (link.linkType === 'custom' || link.linkType === 'unknown') && 'bg-muted-foreground',
          )}
        />
        <p className="truncate text-sm font-medium text-foreground">
          {t(`topology.linkType.${link.linkType}`, { defaultValue: link.linkType })}
        </p>
        <Badge variant="outline" className={cn('text-[10px]', LINK_TYPE_BADGE[link.linkType])}>
          {t(`topology.source.${link.source}`)}
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {sourceLabel} <span className="mx-1">→</span> {targetLabel}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <DetailRow label={t('topology.linkDialog.protocol')}>
          {t(`topology.protocol.${link.protocol}`)}
        </DetailRow>
        <DetailRow label={t('topology.linkDialog.port')}>{link.port ?? '—'}</DetailRow>
        <DetailRow label={t('topology.linkDialog.status')}>
          {t(`topology.linkStatus.${link.status}`, { defaultValue: link.status })}
        </DetailRow>
        <DetailRow label={t('topology.source.title')}>
          {t(`topology.source.${link.source}`)}
        </DetailRow>
        <DetailRow label={t('topology.link.firstSeenAt')}>
          {formatTimestamp(link.firstSeenAt)}
        </DetailRow>
        <DetailRow label={t('topology.link.lastConfirmedAt')}>
          {formatTimestamp(link.lastConfirmedAt)}
        </DetailRow>
      </div>
      {link.manualLabel && (
        <p className="text-xs text-foreground">{link.manualLabel}</p>
      )}
      {link.description && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 text-[11px] text-foreground">
          {link.description}
        </p>
      )}
      {link.evidence && (
        <p className="break-all rounded-md bg-muted px-2.5 py-2 font-mono text-[10px] text-muted-foreground">
          {link.evidence}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onEdit}>
          <Pencil className="h-3 w-3" />
          {t('common.edit')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
          {t('common.delete')}
        </Button>
      </div>
    </div>
  );
}
