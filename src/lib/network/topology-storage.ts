/**
 * SQLite-backed storage for the Network Topology & Diagnostics module.
 *
 * Mirrors the shape of `src/lib/toolbox/toolbox-storage.ts`: a synchronous
 * in-memory cache hydrated once after app unlock, synchronous reads for the
 * UI, and fire-and-forget `rowUpsert` / `rowDelete` writes that broadcast a
 * change event so subscribers can re-render.
 *
 * ── Persistence safety (docs/network-topology-design.md §9) ────────────────
 * · NO credential is ever written. None of the eight `net_*` tables has a
 *   password / privateKey / passphrase / token column, and every row mapper in
 *   this file is deliberately built from an explicit field list — a node
 *   references its saved connection by `connection_id` only and never copies
 *   the connection's auth material. Code review must verify this on every
 *   change to the `*ToRow` functions below.
 * · Manual ("M") fields are only ever written by the `patchXxxManual`
 *   helpers. The probe pipeline goes through `topology-merge`, which cannot
 *   reach them — see the whitelist rule documented there.
 *
 * ── No encryption ──────────────────────────────────────────────────────────
 * Unlike the toolbox tables, nothing here is sensitive: hostnames, IPs, port
 * numbers and free-text notes about the user's own servers. `encField` /
 * `decField` are intentionally NOT used.
 */
import { type DbTable, type Row, rowDelete, rowList, rowUpsert } from '../toolbox/db';
import type {
  NetworkFirewall,
  NetworkFirewallRule,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkPort,
  NetworkPortLink,
  NetworkRoute,
  NodeSnapshot,
  PortProbeRecord,
} from './topology-types';

/** event.detail carries the mutated kind so views can filter cheaply. */
export const TOPOLOGY_CHANGED_EVENT = 'nexterm:topology-changed';

type Kind =
  | 'nodes'
  | 'interfaces'
  | 'routes'
  | 'firewalls'
  | 'rules'
  | 'ports'
  | 'probes'
  | 'links'
  | 'port_links';

const TABLES: Record<Kind, DbTable> = {
  nodes: 'net_nodes',
  interfaces: 'net_interfaces',
  routes: 'net_routes',
  firewalls: 'net_firewalls',
  rules: 'net_firewall_rules',
  ports: 'net_ports',
  probes: 'net_port_probes',
  links: 'net_links',
  port_links: 'net_port_links',
};

// In-memory cache (synchronous reads for the UI).
const cache: Record<Kind, unknown[]> = {
  nodes: [],
  interfaces: [],
  routes: [],
  firewalls: [],
  rules: [],
  ports: [],
  probes: [],
  links: [],
  port_links: [],
};

let initialized = false;

/* ── coercion helpers (SQLite hands back unknown-typed rows) ─────────────── */

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Nullable text: SQL NULL and empty string both hydrate as `null`. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** SQLite stores booleans as 0/1; tolerate real booleans too. */
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

function jsonToStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function stringsToJson(v: readonly string[] | null | undefined): string {
  return JSON.stringify(v ?? []);
}

/* ── row mapping (never includes a credential field) ─────────────────────── */

function nodeToRow(n: NetworkNode): Row {
  return {
    id: n.id,
    connection_id: n.connectionId,
    hostname: n.hostname,
    os_name: n.osName,
    primary_ip: n.primaryIp,
    role_hint: n.roleHint,
    display_name: n.displayName,
    node_type: n.nodeType,
    environment: n.environment,
    notes: n.notes,
    hidden: boolToInt(n.hidden),
    pos_x: n.posX ?? null,
    pos_y: n.posY ?? null,
    last_probe_at: n.lastProbeAt ?? null,
    last_probe_status: n.lastProbeStatus,
    last_probe_error: n.lastProbeError ?? null,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

function rowToNode(row: Row): NetworkNode {
  return {
    id: str(row.id),
    connectionId: str(row.connection_id),
    hostname: str(row.hostname),
    osName: str(row.os_name),
    primaryIp: str(row.primary_ip),
    roleHint: (row.role_hint as NetworkNode['roleHint']) || 'unknown',
    displayName: str(row.display_name),
    nodeType: str(row.node_type),
    environment: str(row.environment),
    notes: str(row.notes),
    hidden: bool(row.hidden),
    posX: numOrNull(row.pos_x),
    posY: numOrNull(row.pos_y),
    lastProbeAt: numOrNull(row.last_probe_at),
    lastProbeStatus: (row.last_probe_status as NetworkNode['lastProbeStatus']) || 'never',
    lastProbeError: strOrNull(row.last_probe_error),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function interfaceToRow(i: NetworkInterface): Row {
  return {
    id: i.id,
    node_id: i.nodeId,
    iface_name: i.ifaceName,
    mac: i.mac,
    state: i.state,
    mtu: i.mtu ?? null,
    is_loopback: boolToInt(i.isLoopback),
    ipv4_addrs: stringsToJson(i.ipv4Addrs),
    ipv6_addrs: stringsToJson(i.ipv6Addrs),
    manual_label: i.manualLabel,
    last_seen_at: i.lastSeenAt,
    missing_since: i.missingSince ?? null,
    created_at: i.createdAt,
  };
}

function rowToInterface(row: Row): NetworkInterface {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    ifaceName: str(row.iface_name),
    mac: str(row.mac),
    state: str(row.state),
    mtu: numOrNull(row.mtu),
    isLoopback: bool(row.is_loopback),
    ipv4Addrs: jsonToStrings(row.ipv4_addrs),
    ipv6Addrs: jsonToStrings(row.ipv6_addrs),
    manualLabel: str(row.manual_label),
    lastSeenAt: num(row.last_seen_at),
    missingSince: numOrNull(row.missing_since),
    createdAt: num(row.created_at),
  };
}

function routeToRow(r: NetworkRoute): Row {
  return {
    id: r.id,
    node_id: r.nodeId,
    destination: r.destination,
    gateway: r.gateway,
    genmask: r.genmask,
    flags: r.flags,
    metric: r.metric ?? null,
    iface: r.iface,
    route_type: r.routeType,
    manual_note: r.manualNote,
    last_seen_at: r.lastSeenAt,
    missing_since: r.missingSince ?? null,
  };
}

function rowToRoute(row: Row): NetworkRoute {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    destination: str(row.destination),
    gateway: str(row.gateway),
    genmask: str(row.genmask),
    flags: str(row.flags),
    metric: numOrNull(row.metric),
    iface: str(row.iface),
    routeType: (row.route_type as NetworkRoute['routeType']) || 'unknown',
    manualNote: str(row.manual_note),
    lastSeenAt: num(row.last_seen_at),
    missingSince: numOrNull(row.missing_since),
  };
}

function firewallToRow(f: NetworkFirewall): Row {
  return {
    id: f.id,
    node_id: f.nodeId,
    fw_type: f.fwType,
    active: boolToInt(f.active),
    default_in_policy: f.defaultInPolicy,
    default_out_policy: f.defaultOutPolicy,
    version: f.version,
    zones: stringsToJson(f.zones),
    detect_note: f.detectNote,
    manual_note: f.manualNote,
    last_seen_at: f.lastSeenAt,
    missing_since: f.missingSince ?? null,
  };
}

function rowToFirewall(row: Row): NetworkFirewall {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    fwType: (row.fw_type as NetworkFirewall['fwType']) || 'unknown',
    active: bool(row.active),
    defaultInPolicy: str(row.default_in_policy),
    defaultOutPolicy: str(row.default_out_policy),
    version: str(row.version),
    zones: jsonToStrings(row.zones),
    detectNote: str(row.detect_note),
    manualNote: str(row.manual_note),
    lastSeenAt: num(row.last_seen_at),
    missingSince: numOrNull(row.missing_since),
  };
}

function ruleToRow(r: NetworkFirewallRule): Row {
  return {
    id: r.id,
    node_id: r.nodeId,
    firewall_id: r.firewallId,
    table_name: r.tableName,
    chain: r.chain,
    action: r.action,
    protocol: r.protocol,
    src: r.src,
    dst: r.dst,
    src_port: r.srcPort,
    dst_port: r.dstPort,
    in_iface: r.inIface,
    out_iface: r.outIface,
    raw_rule: r.rawRule,
    rule_hash: r.ruleHash,
    manual_purpose: r.manualPurpose,
    last_seen_at: r.lastSeenAt,
    missing_since: r.missingSince ?? null,
  };
}

function rowToRule(row: Row): NetworkFirewallRule {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    firewallId: str(row.firewall_id),
    tableName: str(row.table_name),
    chain: str(row.chain),
    action: str(row.action),
    protocol: str(row.protocol),
    src: str(row.src),
    dst: str(row.dst),
    srcPort: str(row.src_port),
    dstPort: str(row.dst_port),
    inIface: str(row.in_iface),
    outIface: str(row.out_iface),
    rawRule: str(row.raw_rule),
    ruleHash: str(row.rule_hash),
    manualPurpose: str(row.manual_purpose),
    lastSeenAt: num(row.last_seen_at),
    missingSince: numOrNull(row.missing_since),
  };
}

function portToRow(p: NetworkPort): Row {
  return {
    id: p.id,
    node_id: p.nodeId,
    protocol: p.protocol,
    port: p.port,
    listen_addr: p.listenAddr,
    state: p.state,
    process_name: p.processName,
    pid: p.pid ?? null,
    process_user: p.processUser,
    reachability: p.reachability,
    reachability_at: p.reachabilityAt ?? null,
    service_name: p.serviceName,
    purpose: p.purpose,
    notes: p.notes,
    tags: stringsToJson(p.tags),
    hidden: boolToInt(p.hidden),
    last_seen_at: p.lastSeenAt,
    missing_since: p.missingSince ?? null,
    created_at: p.createdAt,
  };
}

function rowToPort(row: Row): NetworkPort {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    port: num(row.port),
    listenAddr: str(row.listen_addr),
    state: str(row.state),
    processName: str(row.process_name),
    pid: numOrNull(row.pid),
    processUser: str(row.process_user),
    reachability: (row.reachability as NetworkPort['reachability']) || 'untested',
    reachabilityAt: numOrNull(row.reachability_at),
    serviceName: str(row.service_name),
    purpose: str(row.purpose),
    notes: str(row.notes),
    tags: jsonToStrings(row.tags),
    hidden: bool(row.hidden),
    lastSeenAt: num(row.last_seen_at),
    missingSince: numOrNull(row.missing_since),
    createdAt: num(row.created_at),
  };
}

function probeToRow(p: PortProbeRecord): Row {
  return {
    id: p.id,
    node_id: p.nodeId,
    port_id: p.portId ?? null,
    protocol: p.protocol,
    port: p.port,
    target_host: p.targetHost,
    status: p.status,
    tcp_ok: boolToInt(p.tcpOk),
    latency_ms: p.latencyMs ?? null,
    error_text: p.errorText ?? null,
    probed_at: p.probedAt,
    triggered_by: p.triggeredBy,
  };
}

function rowToProbe(row: Row): PortProbeRecord {
  return {
    id: str(row.id),
    nodeId: str(row.node_id),
    portId: strOrNull(row.port_id),
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    port: num(row.port),
    targetHost: str(row.target_host),
    status: (row.status as PortProbeRecord['status']) || 'error',
    tcpOk: bool(row.tcp_ok),
    latencyMs: numOrNull(row.latency_ms),
    errorText: strOrNull(row.error_text),
    probedAt: num(row.probed_at),
    triggeredBy: 'manual',
  };
}

function linkToRow(l: NetworkLink): Row {
  return {
    id: l.id,
    source_node_id: l.sourceNodeId,
    target_node_id: l.targetNodeId,
    protocol: l.protocol,
    port: l.port ?? null,
    link_type: l.linkType,
    status: l.status,
    source: l.source,
    evidence: l.evidence,
    description: l.description,
    manual_label: l.manualLabel,
    hidden: boolToInt(l.hidden),
    first_seen_at: l.firstSeenAt,
    last_confirmed_at: l.lastConfirmedAt,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

function rowToLink(row: Row): NetworkLink {
  return {
    id: str(row.id),
    sourceNodeId: str(row.source_node_id),
    targetNodeId: str(row.target_node_id),
    protocol: row.protocol === 'udp' ? 'udp' : 'tcp',
    port: numOrNull(row.port),
    linkType: (row.link_type as NetworkLink['linkType']) || 'unknown',
    status: (row.status as NetworkLink['status']) || 'unknown',
    source: row.source === 'manual' ? 'manual' : 'auto',
    evidence: str(row.evidence),
    description: str(row.description),
    manualLabel: str(row.manual_label),
    hidden: bool(row.hidden),
    firstSeenAt: num(row.first_seen_at),
    lastConfirmedAt: num(row.last_confirmed_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function portLinkToRow(l: NetworkPortLink): Row {
  return {
    id: l.id,
    source_node_id: l.sourceNodeId ?? '',
    source_port_id: l.sourcePortId ?? '',
    source_ip: l.sourceIp ?? null,
    source_protocol: l.sourceProtocol,
    source_port: l.sourcePort,
    target_node_id: l.targetNodeId ?? null,
    target_port_id: l.targetPortId ?? null,
    target_protocol: l.targetProtocol,
    target_port: l.targetPort,
    target_ip: l.targetIp ?? null,
    status: l.status,
    source: l.source,
    evidence: l.evidence,
    description: l.description,
    manual_label: l.manualLabel,
    hidden: boolToInt(l.hidden),
    first_seen_at: l.firstSeenAt,
    last_confirmed_at: l.lastConfirmedAt ?? null,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

function rowToPortLink(row: Row): NetworkPortLink {
  const sourceNodeId = str(row.source_node_id);
  const sourcePortId = str(row.source_port_id);
  const targetNodeId = str(row.target_node_id);
  const targetPortId = str(row.target_port_id);
  const targetIp = str(row.target_ip);
  return {
    id: str(row.id),
    sourceNodeId: sourceNodeId || null,
    sourcePortId: sourcePortId || null,
    sourceIp: strOrNull(row.source_ip),
    sourceProtocol: row.source_protocol === 'udp' ? 'udp' : 'tcp',
    sourcePort: num(row.source_port),
    targetNodeId: targetNodeId || null,
    targetPortId: targetPortId || null,
    targetProtocol: row.target_protocol === 'udp' ? 'udp' : 'tcp',
    targetPort: num(row.target_port),
    targetIp: targetIp || null,
    status: (row.status as NetworkPortLink['status']) || 'unknown',
    source: row.source === 'manual' ? 'manual' : 'auto',
    evidence: str(row.evidence),
    description: str(row.description),
    manualLabel: str(row.manual_label),
    hidden: bool(row.hidden),
    firstSeenAt: num(row.first_seen_at),
    lastConfirmedAt: numOrNull(row.last_confirmed_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toRow(kind: Kind, item: { readonly id: string }): Row {
  switch (kind) {
    case 'nodes':
      return nodeToRow(item as NetworkNode);
    case 'interfaces':
      return interfaceToRow(item as NetworkInterface);
    case 'routes':
      return routeToRow(item as NetworkRoute);
    case 'firewalls':
      return firewallToRow(item as NetworkFirewall);
    case 'rules':
      return ruleToRow(item as NetworkFirewallRule);
    case 'ports':
      return portToRow(item as NetworkPort);
    case 'probes':
      return probeToRow(item as PortProbeRecord);
    case 'links':
      return linkToRow(item as NetworkLink);
    case 'port_links':
      return portLinkToRow(item as NetworkPortLink);
  }
}

/* ── hydration / persistence ─────────────────────────────────────────────── */

/** Load every `net_*` table into the in-memory cache (call once after unlock). */
export async function initializeTopologyStore(): Promise<void> {
  const [nodes, interfaces, routes, firewalls, rules, ports, probes, links, portLinks] = await Promise.all([
    rowList(TABLES.nodes),
    rowList(TABLES.interfaces),
    rowList(TABLES.routes),
    rowList(TABLES.firewalls),
    rowList(TABLES.rules),
    rowList(TABLES.ports),
    rowList(TABLES.probes),
    rowList(TABLES.links),
    rowList(TABLES.port_links),
  ]);
  cache.nodes = nodes.map(rowToNode);
  cache.interfaces = interfaces.map(rowToInterface);
  cache.routes = routes.map(rowToRoute);
  cache.firewalls = firewalls.map(rowToFirewall);
  cache.rules = rules.map(rowToRule);
  cache.ports = ports.map(rowToPort);
  cache.probes = probes.map(rowToProbe);
  cache.links = links.map(rowToLink);
  cache.port_links = portLinks.map(rowToPortLink);
  initialized = true;
}

export function isTopologyStoreInitialized(): boolean {
  return initialized;
}

/** Drop the in-memory cache (test helper / simulated app restart). */
export function resetTopologyStore(): void {
  cache.nodes = [];
  cache.interfaces = [];
  cache.routes = [];
  cache.firewalls = [];
  cache.rules = [];
  cache.ports = [];
  cache.probes = [];
  cache.links = [];
  cache.port_links = [];
  initialized = false;
}

function list<T>(kind: Kind): T[] {
  return cache[kind] as T[];
}

/**
 * Broadcast a "topology data changed" event. Views subscribe with
 * `subscribeTopology` (e.g. via `useSyncExternalStore`) to re-render when the
 * probe pipeline or another view mutates the store.
 */
export function notifyTopologyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(TOPOLOGY_CHANGED_EVENT));
  } catch {
    /* non-DOM environment (tests) */
  }
}

function commitUpsert(kind: Kind, row: Row): void {
  void rowUpsert(TABLES[kind], row).then(() => undefined);
}

function commitDelete(kind: Kind, id: string): void {
  void rowDelete(TABLES[kind], id).then(() => undefined);
}

/** Insert or replace one row in the cache, then persist + notify. */
function upsert<T extends { readonly id: string }>(kind: Kind, item: T): T[] {
  const items = list<T>(kind);
  const index = items.findIndex((i) => i.id === item.id);
  const next = [...items];
  if (index === -1) next.push(item);
  else next[index] = item;
  cache[kind] = next;
  commitUpsert(kind, toRow(kind, item));
  notifyTopologyChanged();
  return list<T>(kind);
}

/**
 * Replace every row of `kind` owned by `nodeId` with `items`.
 *
 * Used by the probe pipeline: a merge produces the node's full detail set in
 * one shot, so rows are written in a single batch with a single notification
 * instead of one event per row. Rows that left the set are deleted from
 * SQLite (the merge itself never drops them — only an explicit user cleanup
 * can, which keeps manual annotations safe).
 */
function replaceNodeRows<T extends { readonly id: string; readonly nodeId: string }>(
  kind: Kind,
  nodeId: string,
  items: readonly T[],
): void {
  const rows = list<T>(kind);
  const previous = rows.filter((r) => r.nodeId === nodeId);
  const keptIds = new Set(items.map((i) => i.id));
  cache[kind] = [...rows.filter((r) => r.nodeId !== nodeId), ...items];
  for (const gone of previous) {
    if (!keptIds.has(gone.id)) commitDelete(kind, gone.id);
  }
  for (const item of items) commitUpsert(kind, toRow(kind, item));
  notifyTopologyChanged();
}

/* ── nodes ───────────────────────────────────────────────────────────────── */

export function listNodes(): NetworkNode[] {
  return list<NetworkNode>('nodes');
}

export function getNode(id: string): NetworkNode | undefined {
  return list<NetworkNode>('nodes').find((n) => n.id === id);
}

export function getNodeByConnectionId(connectionId: string): NetworkNode | undefined {
  return list<NetworkNode>('nodes').find((n) => n.connectionId === connectionId);
}

export function upsertNode(node: NetworkNode): NetworkNode[] {
  return upsert('nodes', node);
}

/** Persist a partial update to a node's user-maintained fields. */
export function patchNodeManual(
  nodeId: string,
  patch: Partial<
    Pick<NetworkNode, 'displayName' | 'nodeType' | 'environment' | 'notes' | 'hidden' | 'posX' | 'posY'>
  >,
): NetworkNode | undefined {
  const node = getNode(nodeId);
  if (!node) return undefined;
  const next: NetworkNode = { ...node, ...patch, updatedAt: Date.now() };
  upsert('nodes', next);
  return next;
}

/**
 * Delete a node and everything hanging off it: interfaces, routes, firewalls,
 * firewall rules, ports, probe history, and every link that touches the node
 * (as source or target).
 */
export function removeNode(id: string): void {
  const kinds: Kind[] = ['interfaces', 'routes', 'firewalls', 'rules', 'ports', 'probes'];
  for (const kind of kinds) {
    const rows = list<{ readonly id: string; readonly nodeId: string }>(kind);
    const owned = rows.filter((r) => r.nodeId === id);
    if (owned.length === 0) continue;
    cache[kind] = rows.filter((r) => r.nodeId !== id);
    for (const row of owned) commitDelete(kind, row.id);
  }

  const links = list<NetworkLink>('links');
  const doomed = links.filter((l) => l.sourceNodeId === id || l.targetNodeId === id);
  if (doomed.length > 0) {
    cache.links = links.filter((l) => l.sourceNodeId !== id && l.targetNodeId !== id);
    for (const link of doomed) commitDelete('links', link.id);
  }

  // Port links hang off a node as source; an unprobed peer target is referenced
  // by `targetIp` only (targetNodeId is NULL), so cascade on the source side and
  // on a resolved target node. A target that was never probed simply keeps its
  // dangling targetIp — it is not orphaned because it has no node to lose.
  const portLinks = list<NetworkPortLink>('port_links');
  const doomedPortLinks = portLinks.filter((l) => l.sourceNodeId === id || l.targetNodeId === id);
  if (doomedPortLinks.length > 0) {
    cache.port_links = portLinks.filter((l) => l.sourceNodeId !== id && l.targetNodeId !== id);
    for (const link of doomedPortLinks) commitDelete('port_links', link.id);
  }

  cache.nodes = list<NetworkNode>('nodes').filter((n) => n.id !== id);
  commitDelete('nodes', id);
  notifyTopologyChanged();
}

/* ── detail reads ────────────────────────────────────────────────────────── */

export function listInterfaces(): NetworkInterface[] {
  return list<NetworkInterface>('interfaces');
}

export function getNodeInterfaces(nodeId: string): NetworkInterface[] {
  return list<NetworkInterface>('interfaces').filter((i) => i.nodeId === nodeId);
}

export function listRoutes(): NetworkRoute[] {
  return list<NetworkRoute>('routes');
}

export function getNodeRoutes(nodeId: string): NetworkRoute[] {
  return list<NetworkRoute>('routes').filter((r) => r.nodeId === nodeId);
}

/** Every firewall row of a node, most-recently-seen first. */
export function getNodeFirewalls(nodeId: string): NetworkFirewall[] {
  return list<NetworkFirewall>('firewalls')
    .filter((f) => f.nodeId === nodeId)
    .sort((a, b) => Number(b.missingSince === null) - Number(a.missingSince === null));
}

/**
 * The firewall currently reported for a node. A node can briefly own two rows
 * when the implementation changes (firewalld → ufw): the previous one is kept
 * and marked missing, so prefer the row that is still being seen.
 */
export function getNodeFirewall(nodeId: string): NetworkFirewall | null {
  return getNodeFirewalls(nodeId)[0] ?? null;
}

export function getNodeFirewallRules(nodeId: string): NetworkFirewallRule[] {
  return list<NetworkFirewallRule>('rules').filter((r) => r.nodeId === nodeId);
}

/** All listening ports of a node, hidden ones included — filtering is a UI concern. */
export function getNodePorts(nodeId: string): NetworkPort[] {
  return list<NetworkPort>('ports').filter((p) => p.nodeId === nodeId);
}

/** Every persisted port across all servers; used only for local correlation. */
export function listPorts(): NetworkPort[] {
  return list<NetworkPort>('ports');
}

/* ── manual-field patches (never called by the probe pipeline) ───────────── */

function patchRow<T extends { readonly id: string; readonly nodeId: string }>(
  kind: Kind,
  nodeId: string,
  rowId: string,
  patch: Partial<T>,
): T | undefined {
  const rows = list<T>(kind);
  const row = rows.find((r) => r.id === rowId && r.nodeId === nodeId);
  if (!row) return undefined;
  const next = { ...row, ...patch };
  const index = rows.findIndex((r) => r.id === rowId);
  const copy = [...rows];
  copy[index] = next;
  cache[kind] = copy;
  commitUpsert(kind, toRow(kind, next));
  notifyTopologyChanged();
  return next;
}

export function patchPortManual(
  nodeId: string,
  portId: string,
  patch: Partial<Pick<NetworkPort, 'serviceName' | 'purpose' | 'notes' | 'tags' | 'hidden'>>,
): NetworkPort | undefined {
  return patchRow<NetworkPort>('ports', nodeId, portId, patch);
}

export function patchInterfaceManual(
  nodeId: string,
  ifaceId: string,
  patch: Partial<Pick<NetworkInterface, 'manualLabel'>>,
): NetworkInterface | undefined {
  return patchRow<NetworkInterface>('interfaces', nodeId, ifaceId, patch);
}

export function patchRouteManual(
  nodeId: string,
  routeId: string,
  patch: Partial<Pick<NetworkRoute, 'manualNote'>>,
): NetworkRoute | undefined {
  return patchRow<NetworkRoute>('routes', nodeId, routeId, patch);
}

export function patchFirewallRuleManual(
  nodeId: string,
  ruleId: string,
  patch: Partial<Pick<NetworkFirewallRule, 'manualPurpose'>>,
): NetworkFirewallRule | undefined {
  return patchRow<NetworkFirewallRule>('rules', nodeId, ruleId, patch);
}

/** Replace one port's reachability verdict (written after a manual TCP test). */
export function patchPortReachability(
  nodeId: string,
  portId: string,
  reachability: NetworkPort['reachability'],
  at: number,
): NetworkPort | undefined {
  return patchRow<NetworkPort>('ports', nodeId, portId, { reachability, reachabilityAt: at });
}

/* ── port probe history ──────────────────────────────────────────────────── */

export function getPortProbes(nodeId: string): PortProbeRecord[] {
  return list<PortProbeRecord>('probes').filter((p) => p.nodeId === nodeId);
}

/** Append one TCP probe result. History is append-only (bounded by the UI). */
export function appendPortProbe(record: PortProbeRecord): void {
  upsert('probes', record);
}

/* ── links ───────────────────────────────────────────────────────────────── */

export function listLinks(): NetworkLink[] {
  return list<NetworkLink>('links');
}

export function upsertLink(link: NetworkLink): NetworkLink[] {
  return upsert('links', link);
}

export function removeLink(id: string): void {
  cache.links = list<NetworkLink>('links').filter((l) => l.id !== id);
  commitDelete('links', id);
  notifyTopologyChanged();
}

/* ── port links (level-2 drill-down) ─────────────────────────────────────── */

/** Every port link in the store (hidden ones included — filtering is a UI concern). */
export function listPortLinks(): NetworkPortLink[] {
  return list<NetworkPortLink>('port_links');
}

/** Port links where `nodeId` is the source owning server. */
export function getPortLinksForNode(nodeId: string): NetworkPortLink[] {
  return list<NetworkPortLink>('port_links').filter((l) => l.sourceNodeId === nodeId);
}

/**
 * Port links touching a specific port of a node, in either direction:
 *   · as source  → the port connects OUT to a target (出站)
 *   · as target  → something connects IN to the port (入站)
 */
export function getPortLinksForPort(
  nodeId: string,
  portId: string,
): { inbound: NetworkPortLink[]; outbound: NetworkPortLink[] } {
  const all = list<NetworkPortLink>('port_links');
  const inbound: NetworkPortLink[] = [];
  const outbound: NetworkPortLink[] = [];
  for (const l of all) {
    if (l.sourceNodeId === nodeId && l.sourcePortId === portId) outbound.push(l);
    else if (l.targetNodeId === nodeId && l.targetPortId === portId) inbound.push(l);
  }
  return { inbound, outbound };
}

/** Insert or replace one port link (used by manual edits and auto inference). */
export function upsertPortLink(link: NetworkPortLink): NetworkPortLink[] {
  return upsert('port_links', link);
}

export function removePortLink(id: string): void {
  cache.port_links = list<NetworkPortLink>('port_links').filter((l) => l.id !== id);
  commitDelete('port_links', id);
  notifyTopologyChanged();
}

/** Replace the whole port-link set (only rows that vanished are deleted). */
export function savePortLinks(items: readonly NetworkPortLink[]): void {
  const rows = list<NetworkPortLink>('port_links');
  const keptIds = new Set(items.map((i) => i.id));
  cache.port_links = [...items];
  for (const gone of rows) {
    if (!keptIds.has(gone.id)) commitDelete('port_links', gone.id);
  }
  for (const item of items) commitUpsert('port_links', toRow('port_links', item));
  notifyTopologyChanged();
}

/** Patch a port link's user-maintained fields (never called by the probe pipeline). */
export function patchPortLinkManual(
  linkId: string,
  patch: Partial<Pick<NetworkPortLink, 'description' | 'manualLabel' | 'hidden'>>,
): NetworkPortLink | undefined {
  const rows = list<NetworkPortLink>('port_links');
  const row = rows.find((r) => r.id === linkId);
  if (!row) return undefined;
  const next: NetworkPortLink = { ...row, ...patch, updatedAt: Date.now() };
  const index = rows.findIndex((r) => r.id === linkId);
  const copy = [...rows];
  copy[index] = next;
  cache.port_links = copy;
  commitUpsert('port_links', toRow('port_links', next));
  notifyTopologyChanged();
  return next;
}

/* ── batch writers used by the probe pipeline ────────────────────────────── */

export function saveNodeInterfaces(nodeId: string, items: readonly NetworkInterface[]): void {
  replaceNodeRows('interfaces', nodeId, items);
}

export function saveNodeRoutes(nodeId: string, items: readonly NetworkRoute[]): void {
  replaceNodeRows('routes', nodeId, items);
}

export function saveNodeFirewalls(nodeId: string, items: readonly NetworkFirewall[]): void {
  replaceNodeRows('firewalls', nodeId, items);
}

export function saveNodeFirewallRules(nodeId: string, items: readonly NetworkFirewallRule[]): void {
  replaceNodeRows('rules', nodeId, items);
}

export function saveNodePorts(nodeId: string, items: readonly NetworkPort[]): void {
  replaceNodeRows('ports', nodeId, items);
}

/** Replace the whole link set (only rows that vanished are deleted). */
export function saveLinks(items: readonly NetworkLink[]): void {
  const rows = list<NetworkLink>('links');
  const keptIds = new Set(items.map((i) => i.id));
  cache.links = [...items];
  for (const gone of rows) {
    if (!keptIds.has(gone.id)) commitDelete('links', gone.id);
  }
  for (const item of items) commitUpsert('links', toRow('links', item));
  notifyTopologyChanged();
}

/* ── aggregation ─────────────────────────────────────────────────────────── */

/** Everything the per-server panel needs for one node, in one call. */
export function getNodeSnapshot(nodeId: string): NodeSnapshot | null {
  const node = getNode(nodeId);
  if (!node) return null;
  return {
    node,
    interfaces: getNodeInterfaces(nodeId),
    routes: getNodeRoutes(nodeId),
    firewall: getNodeFirewall(nodeId),
    firewallRules: getNodeFirewallRules(nodeId),
    ports: getNodePorts(nodeId),
  };
}

/* ── change subscription ─────────────────────────────────────────────────── */

/**
 * Subscribe to topology store mutations. Returns an unsubscribe function, so
 * it plugs straight into `useSyncExternalStore` or a `useEffect` cleanup.
 */
export function subscribeTopology(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (): void => listener();
  window.addEventListener(TOPOLOGY_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TOPOLOGY_CHANGED_EVENT, handler);
}
