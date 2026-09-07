import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, Radar } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NodeSummary } from './node-summary';
import { InterfaceTable } from './interface-table';
import { RouteTable } from './route-table';
import { FirewallView } from './firewall-view';
import { PortTable } from './port-table';
import { PortTopologyView } from './port-topology';
import { ProbeEmptyState } from './probe-empty-state';
import { cn } from '@/lib/utils';
import { applyProbeResult, probeServerTopology } from '@/lib/network/topology-api';
import {
  getNodeByConnectionId,
  getNodeFirewall,
  getNodeFirewallRules,
  getNode,
  getNodeInterfaces,
  getNodePorts,
  getNodeRoutes,
  listPortLinks,
  patchFirewallRuleManual,
  patchInterfaceManual,
  patchPortManual,
  patchRouteManual,
  subscribeTopology,
  upsertNode,
} from '@/lib/network/topology-storage';
import type {
  NetworkFirewall,
  NetworkFirewallRule,
  NetworkInterface,
  NetworkNode,
  NetworkPort,
  NetworkPortLink,
  NetworkRoute,
  ProbeSections,
  ProbeStatus,
} from '@/lib/network/topology-types';

/* ════════════════════════════════════════════════════════════════════════
 * HARD CONSTRAINT — PROBING IS MANUAL ONLY
 * ────────────────────────────────────────────────────────────────────────
 * Nothing in this file may ever trigger `probeServerTopology` from a
 * `useEffect`. The only call site is the click handler below (`handleProbe`).
 * Mounting this panel,
 * switching servers, or starting the app must produce ZERO network activity.
 * Reading already-persisted data via the storage getters is allowed — that is
 * a local read, not a probe.
 * ════════════════════════════════════════════════════════════════════════ */

/** Everything the panel renders for one server, read from local storage. */
interface NodePanelData {
  node: NetworkNode;
  interfaces: NetworkInterface[];
  routes: NetworkRoute[];
  firewall: NetworkFirewall | null;
  rules: NetworkFirewallRule[];
  ports: NetworkPort[];
  portLinks: NetworkPortLink[];
}

const PROBE_STATUS_CLASSES: Record<ProbeStatus, string> = {
  ok: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  partial: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
  failed: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
  never: 'border-transparent bg-muted text-muted-foreground',
};

const PROBE_STATUS_KEYS = {
  ok: 'network.statusOk',
  partial: 'network.statusPartial',
  failed: 'network.statusFailed',
  never: 'network.statusNever',
} as const satisfies Record<ProbeStatus, string>;

const SECTION_LABEL_KEYS = {
  hostname: 'network.section.hostname',
  os: 'network.section.os',
  interfaces: 'network.section.interfaces',
  routes: 'network.section.routes',
  firewall: 'network.section.firewall',
  rules: 'network.section.rules',
  ports: 'network.section.ports',
  peers: 'network.section.peers',
  procSockets: 'network.section.procSockets',
} as const satisfies Record<keyof ProbeSections, string>;

function readNodeData(assetId: string): NodePanelData | null {
  const node = getNodeByConnectionId(assetId);
  if (!node) return null;
  return {
    node,
    interfaces: getNodeInterfaces(node.id),
    routes: getNodeRoutes(node.id),
    firewall: getNodeFirewall(node.id),
    rules: getNodeFirewallRules(node.id),
    ports: getNodePorts(node.id),
    portLinks: listPortLinks(),
  };
}

type EntityCounts = { interfaces: number; routes: number; rules: number; ports: number };

function sumCounts(counts: EntityCounts): number {
  return counts.interfaces + counts.routes + counts.rules + counts.ports;
}

export interface NetworkPanelProps {
  /** SSH session id (`tab.id`) — passed straight to `probeServerTopology`. */
  connectionId: string;
  /** Display name of the tab, stored on the node. */
  connectionName: string;
  /** Display host used by port labels; never used to open a connection. */
  host: string;
  /** Stable id used to locate the persisted node: `originalConnectionId ?? connectionId`. */
  assetConnectionId?: string;
}

export function NetworkPanel({
  connectionId,
  connectionName,
  host,
  assetConnectionId,
}: NetworkPanelProps) {
  const { t } = useTranslation();
  const assetId = assetConnectionId ?? connectionId;

  const [data, setData] = useState<NodePanelData | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  const [probing, setProbing] = useState(false);
  const [lastSections, setLastSections] = useState<ProbeSections | null>(null);
  const [activeTab, setActiveTab] = useState('summary');
  /** Level-2 drill-down: when set, the panel shows that port's topology. */
  const [selectedPort, setSelectedPort] = useState<{ nodeId: string; portId: string; host: string } | null>(null);

  // Drives the "3 分钟前" label forward. UI-only — never triggers a probe.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Local storage read + subscription ──────────────────────────────────
  // Pure local reads (no network). Re-runs when the server changes or when the
  // global topology view edits the store.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating from an external store is an effect
    setData(readNodeData(assetId));
    setLastSections(null);
  }, [assetId, storeVersion]);

  // Drilling into a port is scoped to one server; leaving it resets the view.
  useEffect(() => {
    setSelectedPort(null);
  }, [assetId]);

  useEffect(() => subscribeTopology(() => setStoreVersion(v => v + 1)), []);

  const hasProbeData = data !== null && data.node.lastProbeAt !== null;

  // ── Manual probe ───────────────────────────────────────────────────────
  const handleProbe = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const result = await probeServerTopology(connectionId);
      const summary = applyProbeResult({ connectionId: assetId, connectionName, result });

      setData(readNodeData(assetId));
      setLastSections(result.sections);
      setStoreVersion(v => v + 1);

      toast.success(t('network.probe.success'), {
        description: t('network.probe.successDetail', {
          added: sumCounts(summary.added),
          updated: sumCounts(summary.updated),
          missing: sumCounts(summary.missing),
        }),
      });
    } catch (err) {
      toast.error(t('network.probe.failed'), {
        description: err instanceof Error ? err.message : String(err),
      });
      setStoreVersion(v => v + 1);
    } finally {
      setProbing(false);
    }
  };

  // ── Manual-field patches (never touched by a re-probe) ─────────────────
  const node = data?.node;
  const handleNodePatch = (
    patch: Partial<Pick<NetworkNode, 'displayName' | 'nodeType' | 'environment' | 'notes'>>,
  ) => {
    if (!node) return;
    const [updated] = upsertNode({ ...node, ...patch });
    if (updated) setData(current => (current ? { ...current, node: updated } : current));
    setStoreVersion(v => v + 1);
  };

  const refresh = () => setStoreVersion(v => v + 1);

  const degradedSections = lastSections
    ? (Object.keys(lastSections) as Array<keyof ProbeSections>)
        .map(key => ({ key, section: lastSections[key] }))
        .filter(entry => entry.section.status !== 'ok' && entry.section.note.trim() !== '')
    : [];

  const status: ProbeStatus = node?.lastProbeStatus ?? 'never';

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      {/* ── top status bar ──────────────────────────────────────────────── */}
      <div className="max-h-[45%] shrink-0 space-y-1.5 overflow-y-auto">
        <Button
          type="button"
          size="sm"
          className="h-7 w-full gap-1.5 px-2 text-[11px]"
          onClick={() => void handleProbe()}
          disabled={probing}
        >
          {probing ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Radar className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">
            {probing ? t('network.probeButtonProbing') : t('network.probeButton')}
          </span>
        </Button>

        {probing && (
          <div className="h-0.5 w-full overflow-hidden rounded bg-muted">
            <div className="h-full w-1/3 animate-pulse bg-primary" />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <Badge
            variant="outline"
            className={cn('h-4 px-1 text-[9px]', PROBE_STATUS_CLASSES[status])}
          >
            {t(PROBE_STATUS_KEYS[status])}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {node?.lastProbeAt
              ? t('network.lastProbeAt', { time: formatRelative(node.lastProbeAt, now, t) })
              : t('network.lastProbeNever')}
          </span>
        </div>

        {node?.lastProbeError && (
          <p className="rounded bg-red-500/10 px-1.5 py-1 text-[9px] leading-relaxed text-red-700 dark:text-red-300">
            {node.lastProbeError}
          </p>
        )}

        {degradedSections.length > 0 && (
          <div className="space-y-0.5 rounded bg-amber-500/10 px-1.5 py-1">
            <p className="text-[9px] font-medium text-amber-700 dark:text-amber-300">
              {t('network.statusPartialHint')}
            </p>
            {degradedSections.map(entry => (
              <p key={entry.key} className="text-[9px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
                {t(SECTION_LABEL_KEYS[entry.key])}: {entry.section.note}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* ── body ────────────────────────────────────────────────────────── */}
      {!hasProbeData || !data || !node ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ProbeEmptyState />
        </div>
      ) : selectedPort ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <PortTopologyView
            key={`${selectedPort.nodeId}:${selectedPort.portId}`}
            nodeId={selectedPort.nodeId}
            portId={selectedPort.portId}
            host={selectedPort.host}
            onBack={() => setSelectedPort(null)}
            onOpenPort={(peerNodeId, peerPortId) => {
              const peer = getNode(peerNodeId);
              setSelectedPort({ nodeId: peerNodeId, portId: peerPortId, host: peer?.primaryIp || host });
            }}
          />
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col gap-1.5"
        >
          <TabsList className="flex h-7 w-full shrink-0 rounded-md p-0.5">
            <TabsTrigger value="summary" className="h-6 min-w-0 flex-1 rounded px-1 text-[10px]">
              {t('network.tabs.summary')}
            </TabsTrigger>
            <TabsTrigger value="interfaces" className="h-6 min-w-0 flex-1 rounded px-1 text-[10px]">
              {t('network.tabs.interfaces')}
            </TabsTrigger>
            <TabsTrigger value="routes" className="h-6 min-w-0 flex-1 rounded px-1 text-[10px]">
              {t('network.tabs.routes')}
            </TabsTrigger>
            <TabsTrigger value="firewall" className="h-6 min-w-0 flex-1 rounded px-1 text-[10px]">
              {t('network.tabs.firewall')}
            </TabsTrigger>
            <TabsTrigger value="ports" className="h-6 min-w-0 flex-1 rounded px-1 text-[10px]">
              {t('network.tabs.ports')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="animate-in fade-in-0 pr-2 duration-200">
                <NodeSummary
                  node={node}
                  interfaceCount={data.interfaces.length}
                  portCount={data.ports.length}
                  onPatch={handleNodePatch}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="interfaces" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="animate-in fade-in-0 pr-2 duration-200">
                <InterfaceTable
                  interfaces={data.interfaces}
                  onPatchLabel={(ifaceId, manualLabel) => {
                    patchInterfaceManual(node.id, ifaceId, { manualLabel });
                    refresh();
                  }}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="routes" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="animate-in fade-in-0 pr-2 duration-200">
                <RouteTable
                  routes={data.routes}
                  onPatchNote={(routeId, manualNote) => {
                    patchRouteManual(node.id, routeId, { manualNote });
                    refresh();
                  }}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="firewall" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="animate-in fade-in-0 pr-2 duration-200">
                <FirewallView
                  firewall={data.firewall}
                  rules={data.rules}
                  onPatchPurpose={(ruleId, manualPurpose) => {
                    patchFirewallRuleManual(node.id, ruleId, { manualPurpose });
                    refresh();
                  }}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="ports" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="animate-in fade-in-0 pr-2 duration-200">
                <PortTable
                  ports={data.ports}
                  host={host}
                  links={data.portLinks}
                  onDrillDown={(port) => setSelectedPort({ nodeId: node.id, portId: port.id, host })}
                  onPatch={(portId, patch) => {
                    patchPortManual(node.id, portId, patch);
                    refresh();
                  }}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      )}

    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */

function formatRelative(timestamp: number, now: number, t: TFunction): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return t('network.time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('network.time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('network.time.hoursAgo', { count: hours });
  return t('network.time.daysAgo', { count: Math.round(hours / 24) });
}
