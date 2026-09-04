import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, Radar } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NodeSummary } from './node-summary';
import { InterfaceTable } from './interface-table';
import { RouteTable } from './route-table';
import { FirewallView } from './firewall-view';
import { PortTable, ReachabilityBadge } from './port-table';
import { ProbeEmptyState } from './probe-empty-state';
import { cn } from '@/lib/utils';
import { applyProbeResult, probeServerTopology, probeTcpPorts } from '@/lib/network/topology-api';
import {
  appendPortProbe,
  getNodeByConnectionId,
  getNodeFirewall,
  getNodeFirewallRules,
  getNodeInterfaces,
  getNodePorts,
  getNodeRoutes,
  getPortProbes,
  patchFirewallRuleManual,
  patchInterfaceManual,
  patchPortManual,
  patchPortReachability,
  patchRouteManual,
  subscribeTopology,
  upsertNode,
} from '@/lib/network/topology-storage';
import { resolveReachability } from '@/lib/network/topology-merge';
import { generateId } from '@/lib/toolbox/toolbox-storage';
import type {
  NetworkFirewall,
  NetworkFirewallRule,
  NetworkInterface,
  NetworkNode,
  NetworkPort,
  NetworkRoute,
  PortProbeRecord,
  ProbeSections,
  ProbeStatus,
  TcpProbeResult,
} from '@/lib/network/topology-types';

/* ════════════════════════════════════════════════════════════════════════
 * HARD CONSTRAINT — PROBING IS MANUAL ONLY
 * ────────────────────────────────────────────────────────────────────────
 * Nothing in this file may ever trigger `probeServerTopology` or
 * `probeTcpPorts` from a `useEffect`. The only call sites are the two click
 * handlers below (`handleProbe` / `handleTcpRun`). Mounting this panel,
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
  portProbes: PortProbeRecord[];
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
} as const satisfies Record<keyof ProbeSections, string>;

const DEFAULT_TCP_TIMEOUT_MS = 1500;

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
    portProbes: getPortProbes(node.id),
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
  /** Target host for the client-side TCP reachability test. */
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

  // Manual TCP reachability state. Keyed by assetId so switching servers can
  // never show another server's results.
  const [tcpRunning, setTcpRunning] = useState(false);
  const [tcpRun, setTcpRun] = useState<{ assetId: string; results: TcpProbeResult[] } | null>(null);
  const [tcpDialogOpen, setTcpDialogOpen] = useState(false);
  const [tcpDialogKey, setTcpDialogKey] = useState(0);

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

  // ── Manual TCP reachability test ───────────────────────────────────────
  const tcpCandidates = (data?.ports ?? []).filter(
    port => port.protocol === 'tcp' && port.state.trim().toUpperCase().includes('LISTEN'),
  );

  const handleTcpRun = async (ports: number[], timeoutMs: number) => {
    const nodeId = data?.node.id;
    if (tcpRunning || ports.length === 0 || !nodeId) return;
    setTcpRunning(true);
    try {
      const raw = await probeTcpPorts(host, ports, timeoutMs);

      // Cross-reference the client-side TCP verdict with "does the server
      // report this port as listening" (design doc §5). `tcpCandidates` only
      // holds LISTEN tcp ports, so a hit means listening === true.
      const byPort = new Map(tcpCandidates.map(port => [port.port, port]));
      const resolved = raw.map(item => ({
        ...item,
        status: resolveReachability({ listening: byPort.has(item.port), tcp: item }),
      }));

      const probedAt = Date.now();
      for (const item of resolved) {
        const port = byPort.get(item.port);
        appendPortProbe({
          id: generateId('probe'),
          nodeId,
          portId: port?.id ?? null,
          protocol: 'tcp',
          port: item.port,
          targetHost: host,
          status: item.status,
          tcpOk: item.tcpOk,
          latencyMs: item.latencyMs,
          errorText: item.errorText,
          probedAt,
          triggeredBy: 'manual',
        });
        if (port) patchPortReachability(nodeId, port.id, item.status, probedAt);
      }

      setTcpRun({ assetId, results: resolved });
      setStoreVersion(v => v + 1);
      toast.success(t('network.tcp.done'), {
        description: t('network.tcp.doneDetail', { count: resolved.length }),
      });
    } catch (err) {
      toast.error(t('network.tcp.failed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTcpRunning(false);
    }
  };

  const openTcpDialog = () => {
    setTcpDialogKey(k => k + 1); // remount → fresh selection / timeout state
    setTcpDialogOpen(true);
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

  // Latest verdict per `protocol:port`, built once per render. Live results
  // from the current session shadow the persisted history.
  const liveReachability = new Map<string, TcpProbeResult>();
  if (tcpRun?.assetId === assetId) {
    for (const item of tcpRun.results) liveReachability.set(`tcp:${item.port}`, item);
  }
  const storedReachability = new Map<string, PortProbeRecord>();
  for (const record of data?.portProbes ?? []) {
    const key = `${record.protocol}:${record.port}`;
    const prev = storedReachability.get(key);
    if (!prev || record.probedAt > prev.probedAt) storedReachability.set(key, record);
  }

  const reachabilityOf = (port: NetworkPort) => {
    const key = `${port.protocol}:${port.port}`;
    const live = liveReachability.get(key);
    if (live) return { status: live.status, latencyMs: live.latencyMs };
    const stored = storedReachability.get(key);
    return stored ? { status: stored.status, latencyMs: stored.latencyMs } : undefined;
  };

  const degradedSections = lastSections
    ? (Object.keys(lastSections) as Array<keyof ProbeSections>)
        .map(key => ({ key, section: lastSections[key] }))
        .filter(entry => entry.section.status !== 'ok' && entry.section.note.trim() !== '')
    : [];

  const status: ProbeStatus = node?.lastProbeStatus ?? 'never';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* ── top status bar ──────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-1.5">
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
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex min-h-0 flex-1 flex-col gap-1.5"
        >
          <TabsList className="h-7 w-full shrink-0 rounded-md p-0.5">
            <TabsTrigger value="summary" className="h-6 rounded px-1 text-[10px]">
              {t('network.tabs.summary')}
            </TabsTrigger>
            <TabsTrigger value="interfaces" className="h-6 rounded px-1 text-[10px]">
              {t('network.tabs.interfaces')}
            </TabsTrigger>
            <TabsTrigger value="routes" className="h-6 rounded px-1 text-[10px]">
              {t('network.tabs.routes')}
            </TabsTrigger>
            <TabsTrigger value="firewall" className="h-6 rounded px-1 text-[10px]">
              {t('network.tabs.firewall')}
            </TabsTrigger>
            <TabsTrigger value="ports" className="h-6 rounded px-1 text-[10px]">
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
                  reachabilityOf={reachabilityOf}
                  testing={tcpRunning}
                  tcpDisabled={host.trim() === ''}
                  onTestConnectivity={openTcpDialog}
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

      <TcpProbeDialog
        key={tcpDialogKey}
        open={tcpDialogOpen}
        onOpenChange={setTcpDialogOpen}
        host={host}
        candidates={tcpCandidates}
        running={tcpRunning}
        results={tcpRun?.assetId === assetId ? tcpRun.results : []}
        onRun={ports => void handleTcpRun(ports, DEFAULT_TCP_TIMEOUT_MS)}
      />
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

interface TcpProbeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: string;
  candidates: NetworkPort[];
  running: boolean;
  results: TcpProbeResult[];
  onRun: (ports: number[], timeoutMs: number) => void;
}

/**
 * Manual TCP reachability dialog. Selecting ports and pressing the button is
 * the only thing that opens outbound connections from the client.
 */
function TcpProbeDialog({
  open,
  onOpenChange,
  host,
  candidates,
  running,
  results,
  onRun,
}: TcpProbeDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<number>>(() => new Set(candidates.map(p => p.port)));
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_TCP_TIMEOUT_MS));

  const parsedTimeout = Number.parseInt(timeoutMs, 10);
  const effectiveTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_TCP_TIMEOUT_MS;
  const selectedPorts = candidates
    .map(port => port.port)
    .filter(port => selected.has(port));
  const allSelected = selectedPorts.length === candidates.length && candidates.length > 0;

  const toggleAll = (next: boolean) => {
    setSelected(next ? new Set(candidates.map(port => port.port)) : new Set<number>());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-md flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('network.tcp.title')}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('network.tcp.description', { host: host || t('network.common.na') })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {t('network.tcp.timeout')}
            <Input
              value={timeoutMs}
              inputMode="numeric"
              onChange={event => setTimeoutMs(event.target.value.replace(/[^0-9]/g, ''))}
              className="h-6 w-20 px-1.5 text-[11px]"
              aria-label={t('network.tcp.timeout')}
            />
            ms
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            disabled={candidates.length === 0}
            onClick={() => toggleAll(!allSelected)}
          >
            {allSelected ? t('network.tcp.selectNone') : t('network.tcp.selectAll')}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {t('network.tcp.selected', { count: selectedPorts.length })}
          </span>
        </div>

        {candidates.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground">
            {t('network.tcp.noCandidates')}
          </p>
        ) : (
          <ScrollArea className="h-48 rounded-md border">
            <div className="space-y-1 p-1.5">
              {candidates.map(port => (
                <label
                  key={port.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-accent"
                >
                  <Checkbox
                    checked={selected.has(port.port)}
                    onCheckedChange={checked => {
                      setSelected(prev => {
                        const next = new Set(prev);
                        if (checked === true) next.add(port.port);
                        else next.delete(port.port);
                        return next;
                      });
                    }}
                  />
                  <span className="w-14 shrink-0 font-mono">{port.port}/tcp</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {port.serviceName || port.processName || t('network.common.na')}
                  </span>
                </label>
              ))}
            </div>
          </ScrollArea>
        )}

        {results.length > 0 && (
          <div className="space-y-1 rounded-md border p-1.5">
            <p className="text-[10px] font-medium text-muted-foreground">{t('network.tcp.results')}</p>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {results.map(item => (
                <div key={item.port} className="flex items-center gap-2 text-[11px]">
                  <span className="w-14 shrink-0 font-mono">{item.port}/tcp</span>
                  <ReachabilityBadge status={item.status} latencyMs={item.latencyMs} />
                  {item.errorText && (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={item.errorText}>
                      {item.errorText}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={running || selectedPorts.length === 0}
            onClick={() => onRun(selectedPorts, effectiveTimeout)}
          >
            {running && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {running ? t('network.tcp.running') : t('network.tcp.run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
