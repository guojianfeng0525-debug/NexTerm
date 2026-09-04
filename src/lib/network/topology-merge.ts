/**
 * Incremental merge engine for the Network Topology & Diagnostics module.
 *
 * ── The one hard rule ──────────────────────────────────────────────────────
 * A probe run may ONLY overwrite the fields listed in a table's `*_AUTO_KEYS`
 * array. Fields listed in `*_MANUAL_KEYS` (and every system/bookkeeping field
 * that is not explicitly an auto key) are user-owned and must survive a
 * re-probe untouched.
 *
 * That is why this module never writes `{ ...existing, ...detected }`. A
 * spread merge looks harmless but silently drags every key present on the
 * detected payload over the user's edits — and worse, it can *delete* manual
 * keys that the payload happens not to carry. Every merge below copies keys
 * one by one, filtered through the auto-key whitelist.
 *
 * ── Other invariants ───────────────────────────────────────────────────────
 * · Disappeared rows are never deleted — they are marked `missingSince` so the
 *   UI can grey them out ("not seen in this probe") without losing annotations.
 * · Peer addresses are only ever correlated against ALREADY-PROBED nodes.
 *   Unknown IPs are discarded; this module never creates nodes for them and
 *   never connects anywhere (see the "no LAN scanning" rule in the design doc).
 * · No credential is ever read, produced or persisted here.
 *
 * Every exported function is pure — same input, same output, no I/O.
 */
import {
  type DetectedFirewall,
  type DetectedFirewallRule,
  type DetectedInterface,
  type DetectedPeer,
  type DetectedPort,
  type DetectedRoute,
  type FirewallType,
  type LinkType,
  type MergeOutcome,
  type NetworkFirewall,
  type NetworkFirewallRule,
  type NetworkInterface,
  type NetworkLink,
  type NetworkNode,
  type NetworkPort,
  type NetworkRoute,
  type NodeRoleHint,
  type ProbeData,
  type ProbeResult,
  type ProbeSections,
  type ProbeStatus,
  type ReachabilityStatus,
  type RouteType,
  type SectionStatus,
  type TcpProbeResult,
  FIREWALL_AUTO_KEYS,
  FIREWALL_MANUAL_KEYS,
  FIREWALL_RULE_AUTO_KEYS,
  FIREWALL_RULE_MANUAL_KEYS,
  INTERFACE_AUTO_KEYS,
  INTERFACE_MANUAL_KEYS,
  NODE_AUTO_KEYS,
  PORT_AUTO_KEYS,
  PORT_MANUAL_KEYS,
  ROUTE_AUTO_KEYS,
  ROUTE_MANUAL_KEYS,
} from './topology-types';
import { generateId } from '../toolbox/toolbox-storage';

/* ══ shared helpers ════════════════════════════════════════════════════════ */

/** Staleness bookkeeping shared by every detail table (`network_*` rows). */
interface Staleness {
  lastSeenAt?: number;
  missingSince?: number | null;
}

/**
 * Copy `keys` from `source` onto `target`, one field at a time.
 *
 * ── Why this exists instead of a spread ────────────────────────────────────
 * `Object.assign(target, source)` / `{ ...target, ...source }` copies *every*
 * key the payload carries, so an unexpected or renamed key silently lands on
 * the record, and a key the payload omits keeps whatever happens to be there.
 * Neither behaviour is acceptable for user-owned fields. Whitelisting is the
 * whole point: a field not listed in `*_AUTO_KEYS` can never be written by a
 * probe, no matter what the payload looks like.
 *
 * Returns true when at least one field actually changed.
 */
function copyAutoFields<T extends object>(
  target: T,
  source: Partial<T>,
  keys: Iterable<keyof T>,
): boolean {
  const writable = target as Record<string, unknown>;
  const readable = source as Record<string, unknown>;
  let changed = false;
  for (const field of keys) {
    const value = readable[field as string];
    if (value === undefined) continue;
    if (!Object.is(writable[field as string], value)) {
      writable[field as string] = value;
      changed = true;
    }
  }
  return changed;
}

/**
 * Incremental merge driven by a natural key.
 *
 * Semantics (design doc §6):
 *  - hit    → copy ONLY `autoKeys` from the detected payload; every other field
 *             keeps its stored value; `lastSeenAt = probeAt`; `missingSince = null`
 *  - new    → built by `create()`; manual fields fall back to their defaults
 *  - gone   → NOT deleted; `missingSince` is stamped once (only when still null)
 *
 * `manualKeys` is documentation *and* an assertion surface: a key that appears
 * in both lists is a contract bug and is rejected loudly instead of silently
 * picking a winner.
 *
 * `missing` counts rows that transitioned to "missing" during THIS run (rows
 * previously flagged stay flagged and are not counted again), so the number
 * can be reported as "newly disappeared" to the user.
 */
export function mergeDetected<T extends { id: string }>(params: {
  existing: readonly T[];
  detected: readonly Partial<T>[];
  autoKeys: readonly (keyof T)[];
  manualKeys: readonly (keyof T)[];
  // `Pick<T, any>` is fixed by the module contract: a payload row is a partial
  // of T, so the key extractor must accept any subset of its fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  naturalKey: (item: Pick<T, any>) => string;
  probeAt: number;
  create: (detected: Partial<T>, probeAt: number) => T;
}): MergeOutcome<T> {
  const { existing, detected, autoKeys, manualKeys, naturalKey, probeAt, create } = params;
  const autoSet = new Set<keyof T>(autoKeys);

  // A field claimed by both owners is a broken contract — fail fast so it can
  // never manifest as "the user's edit disappeared after a probe".
  const conflict = manualKeys.filter((k) => autoSet.has(k));
  if (conflict.length > 0) {
    throw new Error(
      `[topology-merge] field(s) declared both auto and manual: ${conflict.map(String).join(', ')}`,
    );
  }

  const existingByKey = new Map<string, T>();
  for (const item of existing) existingByKey.set(naturalKey(item), item);

  const items: T[] = [];
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const incoming of detected) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the contract note above
    const key = naturalKey(incoming as Pick<T, any>);
    // Duplicate natural keys inside one payload: first wins, rest ignored.
    if (seen.has(key)) continue;
    seen.add(key);

    const prev = existingByKey.get(key);
    if (!prev) {
      items.push(create(incoming, probeAt));
      added += 1;
      continue;
    }

    // ── HARD RULE ────────────────────────────────────────────────────────
    // Start from the STORED row and pull across whitelisted auto fields only.
    // Never `{ ...prev, ...incoming }` — that would let an unexpected payload
    // key (or a missing one) clobber / drop a user-maintained value.
    const next: T = { ...prev };
    const stale = next as T & Staleness;

    // Whitelist copy — see the HARD RULE comment in `copyAutoFields`.
    let changed = copyAutoFields(next, incoming, autoSet);

    if (stale.lastSeenAt !== probeAt) {
      stale.lastSeenAt = probeAt;
      changed = true;
    }
    if (stale.missingSince !== null) {
      stale.missingSince = null;
      changed = true;
    }

    items.push(next);
    if (changed) updated += 1;
  }

  let missing = 0;
  for (const item of existing) {
    const key = naturalKey(item);
    if (seen.has(key)) continue;
    const next = { ...item } as T & Staleness;
    if (next.missingSince === null || next.missingSince === undefined) {
      next.missingSince = probeAt;
      missing += 1;
    }
    items.push(next);
  }

  return { items, added, updated, missing };
}

/* ══ classification / inference (pure helpers) ═════════════════════════════ */

/** Strip a CIDR suffix and any bracket wrapping: `10.0.0.5/24` → `10.0.0.5`. */
function normalizeAddr(value: string): string {
  let out = value.trim();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const slash = out.indexOf('/');
  if (slash !== -1) out = out.slice(0, slash);
  return out;
}

/**
 * Classify a routing-table row. `ip route` and `netstat -rn` both express the
 * same shapes, so the decision is made from the row content alone:
 *
 *  default  → the catch-all gateway route
 *  local    → a host route (a single address, /32 or a 255.255.255.255 mask)
 *  link     → on-link / scope-link route, i.e. reachable without a gateway
 *  unicast  → a normal prefixed route via a gateway
 */
export function classifyRouteType(route: DetectedRoute): RouteType {
  const destination = route.destination?.trim() ?? '';
  const gateway = route.gateway?.trim() ?? '';
  const genmask = route.genmask?.trim() ?? '';

  if (!destination) return 'unknown';
  if (destination === 'default' || destination === '0.0.0.0' || destination === '::/0' || destination === '::') {
    return 'default';
  }
  if (genmask === '255.255.255.255' || destination.endsWith('/32') || destination.endsWith('/128')) {
    return 'local';
  }
  if (!gateway || gateway === '0.0.0.0' || gateway === '*' || gateway === '::' || gateway === 'link') {
    return 'link';
  }
  return 'unicast';
}

/** Port → role-hint buckets. First match wins; lower index = higher priority. */
const ROLE_PORT_BUCKETS: readonly { role: NodeRoleHint; ports: readonly number[] }[] = [
  { role: 'database', ports: [5432, 3306, 1433, 1521, 27017] },
  { role: 'cache', ports: [6379, 11211] },
  { role: 'messaging', ports: [5672, 9092] },
  { role: 'web', ports: [80, 443, 8080, 8000, 8443, 3000] },
  { role: 'gateway', ports: [22, 1194, 51820] },
];

/**
 * Guess a server's role from its listening ports — advisory only; the user can
 * always override it. Multiple hits are resolved by bucket priority (database >
 * cache > messaging > web > gateway); no hit yields `general`.
 */
export function inferRoleHint(ports: DetectedPort[]): NodeRoleHint {
  if (!ports || ports.length === 0) return 'general';
  const listening = new Set(ports.map((p) => p.port));
  for (const bucket of ROLE_PORT_BUCKETS) {
    if (bucket.ports.some((p) => listening.has(p))) return bucket.role;
  }
  return 'general';
}

/** Port → link kind, used to style inferred topology edges. */
const LINK_TYPE_BY_PORT: readonly { type: LinkType; ports: readonly number[] }[] = [
  { type: 'ssh', ports: [22] },
  { type: 'http', ports: [80, 443, 8080, 8000, 3000, 8443] },
  { type: 'database', ports: [5432, 3306, 1433, 27017, 1521] },
  { type: 'cache', ports: [6379, 11211] },
  { type: 'messaging', ports: [5672, 9092] },
];

/** Process-name fallback for ports outside the well-known table. */
const LINK_TYPE_BY_PROCESS: readonly { type: LinkType; needle: string }[] = [
  { type: 'ssh', needle: 'ssh' },
  { type: 'http', needle: 'nginx' },
  { type: 'http', needle: 'httpd' },
  { type: 'http', needle: 'apache' },
  { type: 'database', needle: 'postgres' },
  { type: 'database', needle: 'mysql' },
  { type: 'database', needle: 'mongo' },
  { type: 'cache', needle: 'redis' },
  { type: 'cache', needle: 'memcach' },
  { type: 'messaging', needle: 'rabbit' },
  { type: 'messaging', needle: 'kafka' },
];

/**
 * Infer the logical kind of a connection from the remote port (authoritative)
 * and, failing that, from the process name observed on the server.
 */
export function inferLinkType(port: number, processName: string): LinkType {
  if (Number.isInteger(port) && port > 0) {
    for (const bucket of LINK_TYPE_BY_PORT) {
      if (bucket.ports.includes(port)) return bucket.type;
    }
  }
  const proc = (processName ?? '').toLowerCase();
  if (proc) {
    for (const bucket of LINK_TYPE_BY_PROCESS) {
      if (proc.includes(bucket.needle)) return bucket.type;
    }
  }
  return 'unknown';
}

/**
 * Cross-reference "the server says this port is listening" with "the client
 * could actually complete a TCP connect" (design doc §5).
 *
 * The Rust `probe_tcp_ports` command reports a *transport-level* verdict, so
 * the final answer depends on both inputs:
 *
 *  | tcp verdict      | listening | result            |
 *  |------------------|-----------|-------------------|
 *  | dns_error        | —         | dns_error         |
 *  | error            | —         | error             |
 *  | refused          | —         | not_listening     |
 *  | timed out        | yes       | blocked           |
 *  | timed out        | no        | unreachable       |
 *  | connected        | yes       | reachable         |
 *  | connected        | no        | unexpected_open   |
 *
 * A refused connection always wins over the listening flag: the server-side
 * snapshot is simply stale at that point.
 */
export function resolveReachability(params: {
  listening: boolean;
  tcp: TcpProbeResult;
}): ReachabilityStatus {
  const { listening, tcp } = params;
  const status = tcp?.status;

  if (status === 'dns_error') return 'dns_error';
  if (status === 'error') return 'error';
  if (status === 'not_listening') return 'not_listening';
  if (status === 'blocked') return listening ? 'blocked' : 'unreachable';

  const connected = status === 'reachable' || tcp?.tcpOk === true;
  if (connected) return listening ? 'reachable' : 'unexpected_open';

  // No usable verdict yet (`untested`, unknown status, …) — leave it untouched.
  return status === 'untested' ? 'untested' : 'error';
}

/** Overall probe verdict derived from the per-section statuses. */
export function deriveProbeStatus(result: {
  success: boolean;
  error: string | null;
  sections: ProbeSections;
}): ProbeStatus {
  if (!result.success) return 'failed';
  const sections = result.sections;
  const sectionKeys = (sections ? Object.keys(sections) : []) as (keyof ProbeSections)[];
  const statuses: SectionStatus[] = sectionKeys.map((key) => sections[key]?.status ?? 'unavailable');
  if (statuses.length === 0) return 'failed';
  if (statuses.every((s) => s === 'ok')) return 'ok';
  if (statuses.every((s) => s === 'failed' || s === 'unavailable')) return 'failed';
  return 'partial';
}

/* ══ node ══════════════════════════════════════════════════════════════════ */

export interface MergeNodeOptions {
  /** Overall verdict of the run; defaults to `ok`. */
  readonly status?: ProbeStatus;
  /** Failure reason (already truncated upstream); defaults to null. */
  readonly error?: string | null;
  /** Seed for `displayName` when the node is created — never applied later. */
  readonly initialDisplayName?: string;
}

function emptyNode(connectionId: string, now: number): NetworkNode {
  return {
    id: generateId('node'),
    connectionId,
    hostname: '',
    osName: '',
    primaryIp: '',
    roleHint: 'unknown',
    // ── M: user-maintained, always start at their defaults ──
    displayName: '',
    nodeType: '',
    environment: '',
    notes: '',
    hidden: false,
    posX: null,
    posY: null,
    lastProbeAt: null,
    lastProbeStatus: 'never',
    lastProbeError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Merge one probe payload into a node.
 *
 * Only `NODE_AUTO_KEYS` (hostname / osName / primaryIp / roleHint) plus the
 * probe bookkeeping are written; `displayName`, `nodeType`, `environment`,
 * `notes`, `hidden` and the layout coordinates are left exactly as the user
 * set them.
 */
export function mergeNode(
  existing: NetworkNode | undefined,
  detected: ProbeData,
  connectionId: string,
  probeAt: number,
  now: number,
  options: MergeNodeOptions = {},
): NetworkNode {
  const status = options.status ?? 'ok';
  const error = options.error ?? null;
  const roleHint = inferRoleHint(detected?.ports ?? []);

  const base: NetworkNode = existing ?? { ...emptyNode(connectionId, now), displayName: options.initialDisplayName ?? '' };

  const auto: Partial<NetworkNode> = {
    hostname: detected?.hostname ?? '',
    osName: detected?.osName ?? '',
    primaryIp: detected?.primaryIp ?? '',
    roleHint,
  };

  const next: NetworkNode = { ...base };
  // Whitelist copy — `displayName` / `nodeType` / `environment` / `notes` /
  // `hidden` / `posX` / `posY` are manual and are deliberately absent from
  // NODE_AUTO_KEYS, so they survive here untouched.
  copyAutoFields(next, auto, NODE_AUTO_KEYS);

  next.lastProbeAt = probeAt;
  next.lastProbeStatus = status;
  next.lastProbeError = error;
  next.updatedAt = now;
  return next;
}

/* ══ interfaces ════════════════════════════════════════════════════════════ */

/**
 * Natural keys are declared with optional members so they satisfy
 * `mergeDetected`'s `Pick<T, any>` parameter (a payload row is a partial). The
 * concrete exported helpers below still document the exact key composition.
 */
export function interfaceNaturalKey(item: { nodeId?: string; ifaceName?: string }): string {
  return `${item.nodeId ?? ''}|${item.ifaceName ?? ''}`;
}

export function mergeInterfaces(
  existing: readonly NetworkInterface[],
  detected: readonly DetectedInterface[],
  nodeId: string,
  probeAt: number,
): MergeOutcome<NetworkInterface> {
  const now = probeAt;
  return mergeDetected<NetworkInterface>({
    existing,
    detected: (detected ?? []).map((d) => ({ ...d, nodeId })),
    autoKeys: INTERFACE_AUTO_KEYS,
    manualKeys: INTERFACE_MANUAL_KEYS,
    naturalKey: interfaceNaturalKey,
    probeAt,
    create: (incoming) => ({
      id: generateId('iface'),
      nodeId,
      ifaceName: incoming.ifaceName ?? '',
      mac: incoming.mac ?? '',
      state: incoming.state ?? '',
      mtu: incoming.mtu ?? null,
      isLoopback: incoming.isLoopback ?? false,
      ipv4Addrs: incoming.ipv4Addrs ?? [],
      ipv6Addrs: incoming.ipv6Addrs ?? [],
      // ── M ──
      manualLabel: '',
      lastSeenAt: now,
      missingSince: null,
      createdAt: now,
    }),
  });
}

/* ══ routes ════════════════════════════════════════════════════════════════ */

export function routeNaturalKey(item: {
  nodeId?: string;
  destination?: string;
  gateway?: string;
  iface?: string;
}): string {
  return `${item.nodeId ?? ''}|${item.destination ?? ''}|${item.gateway ?? ''}|${item.iface ?? ''}`;
}

/**
 * Route classification for a detected row.
 *
 * The Rust parser already emits `routeType`, so its verdict is authoritative.
 * `classifyRouteType` stays as the fallback for payloads that predate the
 * field or could not classify the row (`unknown`) — never store a weaker
 * answer than the one we can derive locally.
 */
export function resolveRouteType(route: DetectedRoute): RouteType {
  const provided = route?.routeType?.trim();
  if (provided && provided !== 'unknown') return provided as RouteType;
  return classifyRouteType(route);
}

export function mergeRoutes(
  existing: readonly NetworkRoute[],
  detected: readonly DetectedRoute[],
  nodeId: string,
  probeAt: number,
): MergeOutcome<NetworkRoute> {
  const now = probeAt;
  return mergeDetected<NetworkRoute>({
    existing,
    detected: (detected ?? []).map((d) => ({
      ...d,
      nodeId,
      routeType: resolveRouteType(d),
    })),
    autoKeys: ROUTE_AUTO_KEYS,
    manualKeys: ROUTE_MANUAL_KEYS,
    naturalKey: routeNaturalKey,
    probeAt,
    create: (incoming) => ({
      id: generateId('route'),
      nodeId,
      destination: incoming.destination ?? '',
      gateway: incoming.gateway ?? '',
      genmask: incoming.genmask ?? '',
      flags: incoming.flags ?? '',
      metric: incoming.metric ?? null,
      iface: incoming.iface ?? '',
      routeType: incoming.routeType ?? 'unknown',
      // ── M ──
      manualNote: '',
      lastSeenAt: now,
      missingSince: null,
    }),
  });
}

/* ══ firewalls ═════════════════════════════════════════════════════════════ */

export function firewallNaturalKey(item: { nodeId?: string; fwType?: FirewallType }): string {
  return `${item.nodeId ?? ''}|${item.fwType ?? ''}`;
}

/**
 * Merge the firewall overview. A server reports at most one implementation, so
 * a null payload keeps the stored row and only stamps it as missing (the UI
 * greys it out instead of losing the user's note).
 */
export function mergeFirewalls(
  existing: readonly NetworkFirewall[],
  detected: DetectedFirewall | null,
  nodeId: string,
  probeAt: number,
): MergeOutcome<NetworkFirewall> {
  const now = probeAt;
  return mergeDetected<NetworkFirewall>({
    existing,
    detected: detected ? [{ ...detected, nodeId }] : [],
    autoKeys: FIREWALL_AUTO_KEYS,
    manualKeys: FIREWALL_MANUAL_KEYS,
    naturalKey: firewallNaturalKey,
    probeAt,
    create: (incoming) => ({
      id: generateId('fw'),
      nodeId,
      fwType: incoming.fwType ?? 'unknown',
      active: incoming.active ?? false,
      defaultInPolicy: incoming.defaultInPolicy ?? '',
      defaultOutPolicy: incoming.defaultOutPolicy ?? '',
      version: incoming.version ?? '',
      zones: incoming.zones ?? [],
      detectNote: incoming.detectNote ?? '',
      // ── M ──
      manualNote: '',
      lastSeenAt: now,
      missingSince: null,
    }),
  });
}

/* ══ firewall rules ════════════════════════════════════════════════════════ */

/**
 * Stable hash of a normalized rule — the natural key of `net_firewall_rules`.
 * Rules are re-listed in full on every probe, so the key has to be derived
 * purely from the rule content to survive reordering elsewhere in the chain.
 *
 * This is only the FALLBACK: `network_probe.rs` now computes `ruleHash` itself
 * and its value is preferred (see `resolveRuleHash`), so the two sides agree
 * on what counts as "the same rule". Kept for payloads that omit the field.
 *
 * Not cryptographic: it exists to dedupe rows, not to resist collisions.
 */
export function hashRule(rule: DetectedFirewallRule): string {
  const normalized = [
    rule.tableName ?? '',
    rule.chain ?? '',
    rule.action ?? '',
    rule.protocol ?? '',
    rule.src ?? '',
    rule.dst ?? '',
    rule.srcPort ?? '',
    rule.dstPort ?? '',
    rule.inIface ?? '',
    rule.outIface ?? '',
    (rule.rawRule ?? '').replace(/\s+/g, ' ').trim(),
  ].join('|');

  // FNV-1a 32-bit — short, dependency-free and stable across processes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Natural-key hash for a detected rule.
 *
 * The backend-computed hash wins so both sides identify a rule identically;
 * `hashRule` covers payloads that predate the field. The source must be stable
 * across runs — flipping between the two would duplicate every rule row.
 */
export function resolveRuleHash(rule: DetectedFirewallRule): string {
  const provided = rule?.ruleHash?.trim();
  return provided || hashRule(rule);
}

export function ruleNaturalKey(item: { nodeId?: string; ruleHash?: string }): string {
  return `${item.nodeId ?? ''}|${item.ruleHash ?? ''}`;
}

export function mergeFirewallRules(
  existing: readonly NetworkFirewallRule[],
  detected: readonly DetectedFirewallRule[],
  nodeId: string,
  firewallId: string,
  probeAt: number,
): MergeOutcome<NetworkFirewallRule> {
  const now = probeAt;
  return mergeDetected<NetworkFirewallRule>({
    existing,
    detected: (detected ?? []).map((d) => ({
      ...d,
      nodeId,
      firewallId,
      ruleHash: resolveRuleHash(d),
    })),
    autoKeys: FIREWALL_RULE_AUTO_KEYS,
    manualKeys: FIREWALL_RULE_MANUAL_KEYS,
    naturalKey: ruleNaturalKey,
    probeAt,
    create: (incoming) => ({
      id: generateId('rule'),
      nodeId,
      firewallId: incoming.firewallId ?? firewallId,
      tableName: incoming.tableName ?? '',
      chain: incoming.chain ?? '',
      action: incoming.action ?? '',
      protocol: incoming.protocol ?? '',
      src: incoming.src ?? '',
      dst: incoming.dst ?? '',
      srcPort: incoming.srcPort ?? '',
      dstPort: incoming.dstPort ?? '',
      inIface: incoming.inIface ?? '',
      outIface: incoming.outIface ?? '',
      rawRule: incoming.rawRule ?? '',
      ruleHash: incoming.ruleHash ?? '',
      // ── M ──
      manualPurpose: '',
      lastSeenAt: now,
      missingSince: null,
    }),
  });
}

/* ══ listening ports ═══════════════════════════════════════════════════════ */

export function portNaturalKey(item: {
  nodeId?: string;
  protocol?: string;
  listenAddr?: string;
  port?: number;
}): string {
  return `${item.nodeId ?? ''}|${item.protocol ?? ''}|${item.listenAddr ?? ''}|${item.port ?? ''}`;
}

export function mergePorts(
  existing: readonly NetworkPort[],
  detected: readonly DetectedPort[],
  nodeId: string,
  probeAt: number,
): MergeOutcome<NetworkPort> {
  const now = probeAt;
  return mergeDetected<NetworkPort>({
    existing,
    detected: (detected ?? []).map((d) => ({ ...d, nodeId })),
    autoKeys: PORT_AUTO_KEYS,
    manualKeys: PORT_MANUAL_KEYS,
    naturalKey: portNaturalKey,
    probeAt,
    create: (incoming) => ({
      id: generateId('port'),
      nodeId,
      protocol: incoming.protocol ?? 'tcp',
      port: incoming.port ?? 0,
      listenAddr: incoming.listenAddr ?? '',
      state: incoming.state ?? '',
      processName: incoming.processName ?? '',
      pid: incoming.pid ?? null,
      processUser: incoming.processUser ?? '',
      // ── M ──
      serviceName: '',
      purpose: '',
      hidden: false,
      // ── S ──
      reachability: 'untested',
      reachabilityAt: null,
      lastSeenAt: now,
      missingSince: null,
      createdAt: now,
    }),
  });
}

/* ══ topology links ════════════════════════════════════════════════════════ */

export function linkNaturalKey(item: {
  sourceNodeId: string;
  targetNodeId: string;
  protocol: string;
  port: number | null;
}): string {
  return `${item.sourceNodeId}|${item.targetNodeId}|${item.protocol}|${item.port ?? ''}`;
}

/**
 * Index every interface address of the given nodes → owning node id.
 *
 * Addresses are normalized (CIDR suffix and IPv6 brackets removed) so a peer
 * seen as `10.0.0.5` matches the stored `10.0.0.5/24`.
 */
export function buildInterfaceIpIndex(
  nodes: readonly NetworkNode[],
  allInterfaces: readonly NetworkInterface[],
): Map<string, string> {
  const known = new Set((nodes ?? []).map((n) => n.id));
  const index = new Map<string, string>();
  for (const iface of allInterfaces ?? []) {
    if (!known.has(iface.nodeId)) continue;
    for (const addr of [...(iface.ipv4Addrs ?? []), ...(iface.ipv6Addrs ?? [])]) {
      const ip = normalizeAddr(addr);
      if (ip && !index.has(ip)) index.set(ip, iface.nodeId);
    }
  }
  return index;
}

/**
 * Turn observed ESTABLISHED peer addresses into topology links.
 *
 * ── No LAN scanning ────────────────────────────────────────────────────────
 * A peer IP is used ONLY to look it up in `interfacesIndex`. When it does not
 * belong to an already-probed node it is DISCARDED: no node is created for it,
 * nothing is recorded, and no connection is ever opened towards it. This is
 * what keeps the feature inside its "current server only" boundary.
 *
 * ── No clobbering ─────────────────────────────────────────────────────────
 * An already-known link is only re-confirmed (`lastConfirmedAt` + `status`).
 * Its `source`, `description`, `manualLabel` and `hidden` are left alone, so a
 * hand-authored (`source: 'manual'`) relationship is never downgraded to
 * `auto` and never loses its note.
 */
export function inferLinksFromPeers(params: {
  nodeId: string;
  peers: DetectedPeer[];
  knownNodes: NetworkNode[];
  interfacesIndex: Map<string, string>;
  existingLinks: NetworkLink[];
  now: number;
}): { links: NetworkLink[]; added: number; confirmed: number } {
  const { nodeId, peers, interfacesIndex, existingLinks, now } = params;
  // `knownNodes` is part of the contract but is already folded into
  // `interfacesIndex` by `buildInterfaceIpIndex`; nothing here may reach for a
  // node that is not in the index (see the no-LAN-scanning rule above).

  const existing = existingLinks ?? [];
  const byKey = new Map<string, NetworkLink>();
  for (const link of existing) byKey.set(linkNaturalKey(link), link);
  const links: NetworkLink[] = [...existing];

  let added = 0;
  let confirmed = 0;
  const handled = new Set<string>();

  for (const peer of peers ?? []) {
    const remoteAddr = peer?.remoteAddr ?? '';
    if (!remoteAddr) continue;

    const ip = normalizeAddr(remoteAddr);
    const targetNodeId = interfacesIndex.get(ip);
    // Unknown (or self) peer → discard. Never invent a node, never connect.
    if (!targetNodeId || targetNodeId === nodeId) continue;

    const protocol = peer.protocol === 'udp' ? 'udp' : 'tcp';
    const port = peer.remotePort ?? null;
    const key = linkNaturalKey({ sourceNodeId: nodeId, targetNodeId, protocol, port });
    if (handled.has(key)) continue;
    handled.add(key);

    const prev = byKey.get(key);
    if (prev) {
      // Re-confirm only: manual fields, source and evidence stay untouched.
      const next: NetworkLink = {
        ...prev,
        // Re-confirm only (`status` + `lastConfirmedAt`); `source`, `evidence`,
        // `description`, `manualLabel` and `hidden` keep their stored values.
        status: 'observed',
        lastConfirmedAt: now,
        updatedAt: now,
      };
      const index = links.findIndex((l) => l.id === prev.id);
      if (index !== -1) links[index] = next;
      byKey.set(key, next);
      confirmed += 1;
      continue;
    }

    const link: NetworkLink = {
      id: generateId('link'),
      sourceNodeId: nodeId,
      targetNodeId,
      protocol,
      port,
      linkType: inferLinkType(port ?? 0, peer.processName ?? ''),
      status: 'observed',
      source: 'auto',
      evidence: `ss ESTABLISHED ${ip}:${port ?? ''}`,
      // ── M ──
      description: '',
      manualLabel: '',
      hidden: false,
      firstSeenAt: now,
      lastConfirmedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    links.push(link);
    byKey.set(key, link);
    added += 1;
  }

  return { links, added, confirmed };
}

/* ══ probe result → overall verdict (convenience for the API layer) ═════════ */

/** Derive the node-level probe verdict straight from a `ProbeResult`. */
export function deriveNodeProbeStatus(result: ProbeResult): ProbeStatus {
  return deriveProbeStatus(result);
}
