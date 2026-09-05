/**
 * Type contract for the Network Topology & Diagnostics module.
 *
 * This file is the single source of truth shared by the storage layer, the
 * merge engine, the per-server panel and the global topology graph. Rust
 * payload shapes (`ProbeData` and friends) mirror
 * `src-tauri/src/network_probe.rs` — keep both sides in sync.
 *
 * ── Field ownership ────────────────────────────────────────────────────────
 * Every persisted entity splits its fields into two disjoint groups:
 *
 *   A (auto)    written by a probe run; a re-probe MAY overwrite them
 *   M (manual)  written only by the user; a re-probe MUST NEVER touch them
 *   S (system)  bookkeeping maintained by the storage layer
 *
 * The `*_AUTO_KEYS` / `*_MANUAL_KEYS` arrays below are the enforcement
 * surface: the merge engine copies only the auto keys, so a manual edit can
 * never be clobbered by a later probe. Adding a column to the database
 * without classifying it here is a bug.
 *
 * ── Hard constraints ───────────────────────────────────────────────────────
 * · No type in this file may ever carry a credential (password, private key,
 *   passphrase, token). Nodes reference a saved connection by id only.
 * · Probing is exclusively user-triggered. Nothing in this module schedules
 *   or auto-runs a probe.
 */

/* ══ shared scalars ═══════════════════════════════════════════════════════ */

/** Outcome of the last probe run against a node. */
export type ProbeStatus = 'ok' | 'partial' | 'failed' | 'never';

/** Per-section outcome inside a single probe run. */
export type SectionStatus = 'ok' | 'partial' | 'failed' | 'unavailable';

/** Server-side firewall implementation family. */
export type FirewallType =
  | 'firewalld'
  | 'ufw'
  | 'iptables'
  | 'nftables'
  | 'pf'
  | 'none'
  | 'unknown';

/** Transport protocol of a listening port or a topology link. */
export type NetProtocol = 'tcp' | 'udp';

/**
 * Cross-referenced reachability verdict: combines "the server reports the
 * port is listening" with "the Windows client could complete a TCP connect".
 */
export type ReachabilityStatus =
  | 'reachable' // listening + firewall allowed + network reachable
  | 'blocked' // listening, but the client connect timed out (firewall/network drop)
  | 'not_listening' // listening per probe, but the peer actively refused (stale data)
  | 'unreachable' // not listening and unreachable
  | 'unexpected_open' // not reported listening, yet the client connected
  | 'dns_error' // target host could not be resolved
  | 'error' // probe itself failed
  | 'untested'; // never tested from the client

/** Who produced a topology relationship. */
export type LinkSource = 'auto' | 'manual';

/** Observed state of a topology relationship. */
export type LinkStatus = 'active' | 'observed' | 'stale' | 'unknown';

/** Logical kind of a topology relationship, used for edge styling. */
export type LinkType = 'ssh' | 'http' | 'database' | 'cache' | 'messaging' | 'custom' | 'unknown';

/** Role hint derived from listening ports — advisory only, user-overridable. */
export type NodeRoleHint = 'web' | 'database' | 'cache' | 'gateway' | 'messaging' | 'general' | 'unknown';

/* ══ nodes ════════════════════════════════════════════════════════════════ */

export interface NetworkNode {
  readonly id: string;
  /** Saved-connection id this node describes (`originalConnectionId ?? tabId`). */
  readonly connectionId: string;

  /* ── A: probe-collected ── */
  hostname: string;
  osName: string;
  primaryIp: string;
  roleHint: NodeRoleHint;

  /* ── M: user-maintained ── */
  displayName: string; // falls back to hostname when empty
  nodeType: string; // 物理机 / 虚拟机 / 容器 / 网关 / …
  environment: string; // 生产 / 预发 / 测试 / 开发
  notes: string;
  hidden: boolean;
  posX: number | null; // manual layout position; null = auto layout
  posY: number | null;

  /* ── S: bookkeeping ── */
  lastProbeAt: number | null;
  lastProbeStatus: ProbeStatus;
  lastProbeError: string | null;
  readonly createdAt: number;
  updatedAt: number;
}

export const NODE_AUTO_KEYS = ['hostname', 'osName', 'primaryIp', 'roleHint'] as const;
export const NODE_MANUAL_KEYS = [
  'displayName',
  'nodeType',
  'environment',
  'notes',
  'hidden',
  'posX',
  'posY',
] as const;

/* ══ network interfaces ═══════════════════════════════════════════════════ */

export interface NetworkInterface {
  readonly id: string;
  readonly nodeId: string;

  /* A */
  ifaceName: string;
  mac: string;
  state: string; // UP / DOWN / UNKNOWN
  mtu: number | null;
  isLoopback: boolean;
  ipv4Addrs: string[]; // CIDR notation, e.g. "10.0.0.5/24"
  ipv6Addrs: string[];

  /* M */
  manualLabel: string;

  /* S */
  lastSeenAt: number;
  missingSince: number | null;
  readonly createdAt: number;
}

export const INTERFACE_AUTO_KEYS = [
  'ifaceName',
  'mac',
  'state',
  'mtu',
  'isLoopback',
  'ipv4Addrs',
  'ipv6Addrs',
] as const;
export const INTERFACE_MANUAL_KEYS = ['manualLabel'] as const;

/* ══ routes ═══════════════════════════════════════════════════════════════ */

export type RouteType = 'default' | 'unicast' | 'link' | 'local' | 'unknown';

export interface NetworkRoute {
  readonly id: string;
  readonly nodeId: string;

  /* A */
  destination: string;
  gateway: string;
  genmask: string;
  flags: string;
  metric: number | null;
  iface: string;
  routeType: RouteType;

  /* M */
  manualNote: string;

  /* S */
  lastSeenAt: number;
  missingSince: number | null;
}

export const ROUTE_AUTO_KEYS = [
  'destination',
  'gateway',
  'genmask',
  'flags',
  'metric',
  'iface',
  'routeType',
] as const;
export const ROUTE_MANUAL_KEYS = ['manualNote'] as const;

/* ══ firewall ═════════════════════════════════════════════════════════════ */

export interface NetworkFirewall {
  readonly id: string;
  readonly nodeId: string;

  /* A */
  fwType: FirewallType;
  active: boolean;
  defaultInPolicy: string;
  defaultOutPolicy: string;
  version: string;
  zones: string[];
  /** Degradation note, e.g. "需要 root 权限" — surfaced in the UI, never silent. */
  detectNote: string;

  /* M */
  manualNote: string;

  /* S */
  lastSeenAt: number;
  missingSince: number | null;
}

export const FIREWALL_AUTO_KEYS = [
  'fwType',
  'active',
  'defaultInPolicy',
  'defaultOutPolicy',
  'version',
  'zones',
  'detectNote',
] as const;
export const FIREWALL_MANUAL_KEYS = ['manualNote'] as const;

export interface NetworkFirewallRule {
  readonly id: string;
  readonly nodeId: string;
  readonly firewallId: string;

  /* A */
  tableName: string;
  chain: string;
  action: string;
  protocol: string;
  src: string;
  dst: string;
  srcPort: string;
  dstPort: string;
  inIface: string;
  outIface: string;
  rawRule: string;
  /** Stable natural key: hash of the normalized rule text. */
  ruleHash: string;

  /* M */
  manualPurpose: string;

  /* S */
  lastSeenAt: number;
  missingSince: number | null;
}

export const FIREWALL_RULE_AUTO_KEYS = [
  'tableName',
  'chain',
  'action',
  'protocol',
  'src',
  'dst',
  'srcPort',
  'dstPort',
  'inIface',
  'outIface',
  'rawRule',
  'ruleHash',
] as const;
export const FIREWALL_RULE_MANUAL_KEYS = ['manualPurpose'] as const;

/* ══ listening ports ══════════════════════════════════════════════════════ */

export interface NetworkPort {
  readonly id: string;
  readonly nodeId: string;

  /* A */
  protocol: NetProtocol;
  port: number;
  listenAddr: string;
  state: string; // LISTEN / ESTABLISHED / …
  processName: string;
  pid: number | null;
  processUser: string;

  /* M */
  serviceName: string;
  purpose: string;
  /** Free-text user annotation for the port (never written by a probe). */
  notes: string;
  /** User tags for grouping/filtering (never written by a probe). */
  tags: string[];
  hidden: boolean;

  /* S */
  reachability: ReachabilityStatus;
  reachabilityAt: number | null;
  lastSeenAt: number;
  missingSince: number | null;
  readonly createdAt: number;
}

export const PORT_AUTO_KEYS = [
  'protocol',
  'port',
  'listenAddr',
  'state',
  'processName',
  'pid',
  'processUser',
] as const;
export const PORT_MANUAL_KEYS = ['serviceName', 'purpose', 'notes', 'tags', 'hidden'] as const;

/* ══ TCP reachability probes ══════════════════════════════════════════════ */

export interface PortProbeRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly portId: string | null;

  protocol: NetProtocol;
  port: number;
  targetHost: string;
  status: ReachabilityStatus;
  tcpOk: boolean;
  latencyMs: number | null;
  errorText: string | null;
  probedAt: number;
  triggeredBy: 'manual';
}

/* ══ topology links ═══════════════════════════════════════════════════════ */

export interface NetworkLink {
  readonly id: string;
  sourceNodeId: string;
  targetNodeId: string;

  /* A — inferred from observed peer connections */
  protocol: NetProtocol;
  port: number | null;
  linkType: LinkType;
  status: LinkStatus;
  /** `auto` = inferred from an observed connection; `manual` = user-authored. */
  source: LinkSource;
  /** How an auto link was inferred, e.g. "ss ESTABLISHED 10.0.0.5:5432". */
  evidence: string;

  /* M */
  description: string;
  manualLabel: string;
  hidden: boolean;

  /* S */
  firstSeenAt: number;
  lastConfirmedAt: number;
  readonly createdAt: number;
  updatedAt: number;
}

export const LINK_AUTO_KEYS = ['protocol', 'port', 'linkType', 'status', 'source', 'evidence'] as const;
export const LINK_MANUAL_KEYS = ['description', 'manualLabel', 'hidden'] as const;

/* ══ port-level topology links ════════════════════════════════════════════ */
/**
 * A port-level connection: `源服务器:源端口 → 目标服务器:目标端口`.
 *
 * This is the level-2 drill-down of `NetworkLink`. Where `NetworkLink`
 * connects two *servers*, a port link connects two *ports*. Either endpoint
 * may be:
 *
 *   · a port on another already-probed node (`targetNodeId` set), or
 *   · a bare `IP:port` peer seen in an ESTABLISHED connection but never probed
 *     by NexTerm (`sourceNodeId` / `targetNodeId === null`). Such an endpoint
 *     is recorded but NEVER auto-probed; it resolves to a node only once the
 *     user manually probes that server.
 *
 * Field ownership follows the same A/M/S discipline as every other entity:
 * a re-probe may overwrite auto fields but must never touch a manual link's
 * `description` / `manualLabel` / `hidden`, nor downgrade its `source`.
 */

/** Who produced a port-level connection. */
export type PortLinkSource = 'auto' | 'manual';

/** Observed state of a port-level connection. */
export type PortLinkStatus = 'active' | 'observed' | 'stale' | 'unknown';

export interface NetworkPortLink {
  readonly id: string;
  /**
   * Source server node id. NULL when an observed client is only known by IP.
   * Unknown endpoints are never probed; they resolve after a user probes that
   * server and its interface addresses match.
   */
  readonly sourceNodeId: string | null;
  /** Source port row id; NULL for an ephemeral/unknown-source socket. */
  readonly sourcePortId: string | null;
  /** Bare IP for an unprobed source endpoint; NULL once `sourceNodeId` resolves. */
  readonly sourceIp: string | null;
  sourceProtocol: NetProtocol;
  sourcePort: number;

  /**
   * Target server node id. NULL when the target is an unprobed peer — in that
   * case only `targetIp` / `targetProtocol` / `targetPort` carry identity and
   * the link is NEVER auto-probed. Resolved to a node once that server is
   * probed and its interfaces/ports correlate.
   */
  targetNodeId: string | null;
  /** Resolved target port row id; NULL until the target node is probed. */
  targetPortId: string | null;
  targetProtocol: NetProtocol;
  targetPort: number;
  /** Bare IP for an unprobed peer target; NULL once `targetNodeId` resolves. */
  targetIp: string | null;

  /* A — inferred from observed peer connections / TCP reachability checks */
  status: PortLinkStatus;
  /** `auto` = inferred from an observed peer; `manual` = user-authored. */
  source: PortLinkSource;
  /** How an auto link was inferred, e.g. "ss ESTABLISHED 10.0.0.5:5432". */
  evidence: string;

  /* M */
  description: string;
  manualLabel: string;
  hidden: boolean;

  /* S */
  firstSeenAt: number;
  lastConfirmedAt: number | null;
  readonly createdAt: number;
  updatedAt: number;
}

export const PORT_LINK_AUTO_KEYS = [
  'sourceProtocol',
  'sourcePort',
  'sourceIp',
  'targetProtocol',
  'targetPort',
  'targetIp',
  'status',
  'evidence',
  'lastConfirmedAt',
] as const;
export const PORT_LINK_MANUAL_KEYS = ['description', 'manualLabel', 'hidden'] as const;

/* ══ probe payload (Rust ↔ TS) ════════════════════════════════════════════ */

/** A remote command's raw section output plus its outcome. */
export interface ProbeSection {
  status: SectionStatus;
  /** Human-readable reason for `partial` / `failed` / `unavailable`. */
  note: string;
}

export interface ProbeSections {
  hostname: ProbeSection;
  os: ProbeSection;
  interfaces: ProbeSection;
  routes: ProbeSection;
  firewall: ProbeSection;
  rules: ProbeSection;
  ports: ProbeSection;
  peers: ProbeSection;
}

export interface DetectedInterface {
  ifaceName: string;
  mac: string;
  state: string;
  mtu: number | null;
  isLoopback: boolean;
  ipv4Addrs: string[];
  ipv6Addrs: string[];
}

export interface DetectedRoute {
  destination: string;
  gateway: string;
  genmask: string;
  flags: string;
  metric: number | null;
  iface: string;
  /**
   * Emitted by the Rust parser (`network_probe.rs`) so the frontend does not
   * re-derive it. Mirrors `NetworkRoute.routeType`; listed in ROUTE_AUTO_KEYS.
   */
  routeType: RouteType;
}

export interface DetectedFirewall {
  fwType: FirewallType;
  active: boolean;
  defaultInPolicy: string;
  defaultOutPolicy: string;
  version: string;
  zones: string[];
  detectNote: string;
}

export interface DetectedFirewallRule {
  tableName: string;
  chain: string;
  action: string;
  protocol: string;
  src: string;
  dst: string;
  srcPort: string;
  dstPort: string;
  inIface: string;
  outIface: string;
  rawRule: string;
  /**
   * Stable natural key computed in `network_probe.rs` from the normalized
   * rule text (whitespace collapsed), so the same rule hashes identically
   * across probe runs. Listed in FIREWALL_RULE_AUTO_KEYS.
   */
  ruleHash: string;
}

export interface DetectedPort {
  protocol: NetProtocol;
  port: number;
  listenAddr: string;
  state: string;
  processName: string;
  pid: number | null;
  processUser: string;
}

/**
 * An established connection observed on the probed server. Peer addresses are
 * used ONLY to correlate against already-probed nodes — the client never
 * connects to a peer on its own.
 */
export interface DetectedPeer {
  remoteAddr: string;
  remotePort: number | null;
  localPort: number | null;
  protocol: NetProtocol;
  processName: string;
  processPid: number | null;
  state: string;
}

export interface ProbeData {
  hostname: string;
  osName: string;
  primaryIp: string;
  interfaces: DetectedInterface[];
  routes: DetectedRoute[];
  firewall: DetectedFirewall | null;
  firewallRules: DetectedFirewallRule[];
  ports: DetectedPort[];
  peers: DetectedPeer[];
}

/** Response of the `probe_network_topology` Tauri command. */
export interface ProbeResult {
  success: boolean;
  error: string | null;
  sections: ProbeSections;
  data: ProbeData;
  probedAtMs: number;
  /** Truncated (<=2000 chars) raw excerpt for troubleshooting only. */
  rawExcerpt: string | null;
}

/** Response item of the `probe_tcp_ports` Tauri command. */
export interface TcpProbeResult {
  port: number;
  status: ReachabilityStatus;
  tcpOk: boolean;
  latencyMs: number | null;
  errorText: string | null;
}

/** Aggregated snapshot handed to the UI after a probe + merge completes. */
export interface NodeSnapshot {
  node: NetworkNode;
  interfaces: NetworkInterface[];
  routes: NetworkRoute[];
  firewall: NetworkFirewall | null;
  firewallRules: NetworkFirewallRule[];
  ports: NetworkPort[];
}

/** Result of an incremental merge — what changed during the last probe. */
export interface MergeOutcome<T> {
  items: T[];
  added: number;
  updated: number;
  /** Items present before but absent from this probe; retained, marked stale. */
  missing: number;
}

/** Per-table row counters produced by one merge pass over a node's details. */
export interface ProbeTableCounts {
  interfaces: number;
  routes: number;
  rules: number;
  ports: number;
}

/**
 * What `applyProbeResult` reports back after a probe → merge → persist pass.
 *
 * Lives in the contract file (not in `topology-api`) because views consume it
 * to render the post-probe summary without depending on the command layer.
 * `missing` counts rows that newly stopped being reported — they are retained
 * and marked stale, never deleted.
 */
export interface ApplyProbeSummary {
  /** Node the probe was merged into (created when it did not exist yet). */
  nodeId: string;
  /** Rows discovered for the first time by this probe. */
  added: ProbeTableCounts;
  /** Existing rows whose auto fields were refreshed. */
  updated: ProbeTableCounts;
  /** Rows absent from this probe, kept and stamped `missingSince`. */
  missing: ProbeTableCounts;
  /** Topology links inferred from observed peers for the first time. */
  linksAdded: number;
  /** Topology links re-observed by this probe. */
  linksConfirmed: number;
  /** Port-level links inferred from observed peers for the first time. */
  portLinksAdded: number;
  /** Port-level links re-observed by this probe. */
  portLinksConfirmed: number;
  /** Dangling port links resolved to a node after this probe. */
  portLinksResolved: number;
}
