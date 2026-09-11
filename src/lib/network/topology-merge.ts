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
 * · Peer addresses are only ever correlated against known/observed nodes.
 *   Unknown IPs receive a display-only observed node, never port data, and are
 *   never connected to (see the "no LAN scanning" rule in the design doc).
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
  type DetectedServiceLink,
  type FirewallType,
  type LinkStatus,
  type LinkType,
  type MergeOutcome,
  type NetworkFirewall,
  type NetworkFirewallRule,
  type NetworkInterface,
  type NetworkLink,
  type NetworkNode,
  type NetworkPort,
  type NetworkPortLink,
  type NetworkRoute,
  type NodeRoleHint,
  type ProbeData,
  type ProbeResult,
  type ProbeSections,
  type ProbeStatus,
  type RouteType,
  type SectionStatus,
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
import {
  SERVER_GROUP_ROOT,
  isExternallyBoundListenAddress,
  isServerInterfaceAddress,
  isServerPeerAddress,
  normalizeScopeAddress,
} from './address-scope';

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
export function normalizeTopologyAddress(value: string): string {
  let out = value.trim();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const slash = out.indexOf('/');
  if (slash !== -1) out = out.slice(0, slash);
  return out;
}

function normalizeAddr(value: string): string {
  let out = normalizeTopologyAddress(value);
  const lower = out.toLowerCase();
  const mappedPrefix = '::ffff:';
  if (lower.startsWith(mappedPrefix)) {
    out = out.slice(mappedPrefix.length);
  }
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
  /** Saved-server folder path used for topology isolation. */
  readonly groupPath?: string;
}

function emptyNode(connectionId: string, now: number): NetworkNode {
  return {
    id: generateId('node'),
    connectionId,
    groupPath: SERVER_GROUP_ROOT,
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
  const groupPath = options.groupPath?.trim() || base.groupPath?.trim() || SERVER_GROUP_ROOT;

  const auto: Partial<NetworkNode> = {
    hostname: detected?.hostname ?? '',
    osName: detected?.osName ?? '',
    primaryIp: detected?.primaryIp ?? '',
    roleHint,
  };

  // A display-only observed node is promoted in place when the user explicitly
  // probes the matching saved connection. Keeping its id preserves every edge.
  const next: NetworkNode = { ...base, connectionId, groupPath };
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

/**
 * Reduce a raw probe payload to the server-facing information requested by the
 * topology. Container/loopback listeners and peers never enter the store.
 */
export function sanitizeProbeData(data: ProbeData): ProbeData {
  const interfaces = (data?.interfaces ?? []).filter((iface) =>
    !iface.isLoopback && isServerInterfaceAddress(iface.ipv4Addrs?.[0] ?? iface.ipv6Addrs?.[0] ?? '', iface.ifaceName));

  // A container/pod address can otherwise be selected as the primary IP when a
  // host has no default-route sample. Prefer the interface chosen by the probe
  // only if it survives the scope rules.
  const primaryFromProbe = normalizeScopeAddress(data?.primaryIp ?? '');
  const primaryCandidate = interfaces
    .flatMap(iface => [
      ...(iface.ipv4Addrs ?? []),
      ...(iface.ipv6Addrs ?? []),
    ].map(address => ({ address, ifaceName: iface.ifaceName })))
    .find(item => isServerInterfaceAddress(item.address, item.ifaceName));
  const primaryIp = isServerInterfaceAddress(primaryFromProbe)
    ? primaryFromProbe
    : normalizeScopeAddress(primaryCandidate?.address ?? '');

  const serverAddresses = interfaces.flatMap(iface => [
    ...(iface.ipv4Addrs ?? []),
    ...(iface.ipv6Addrs ?? []),
  ].map(address => ({ address, ifaceName: iface.ifaceName })));

  return {
    ...data,
    primaryIp,
    interfaces,
    ports: (data?.ports ?? []).filter(port =>
      isListenerState(port.state)
      && isExternallyBoundListenAddress(port.listenAddr, serverAddresses)),
    peers: (data?.peers ?? []).filter(peer =>
      isServerPeerAddress(peer?.localAddr ?? '')
      && isServerPeerAddress(peer?.remoteAddr ?? '')),
    // Service links are already filtered remote-side (loopback / unspecified /
    // self dropped by the Rust parser); keep the pass-through explicit.
    serviceLinks: data?.serviceLinks ?? [],
  };
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
      notes: '',
      tags: [],
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

/**
 * Stable identity for a server seen as a socket peer but not explicitly probed.
 *
 * v2.18.1: the id is the normalized IP ONLY — an address is one asset no
 * matter which folder observed it. The old group-scoped ids
 * (`observed:<group>:<ip>`) are migrated at startup by
 * `migrateObservedNodeIds`.
 */
export function observedNodeId(ip: string): string {
  return `observed:${normalizeAddr(ip ?? '')}`;
}

export function isObservedNode(node: Pick<NetworkNode, 'connectionId'>): boolean {
  return node.connectionId.startsWith('observed:');
}

/**
 * Peer addresses that must never become nodes: loopback, unspecified and
 * link-local. The v2.18.0 container-range blacklist (172.16/12, 100.64/10 …)
 * is GONE from the visibility path — those are legitimate private/Tailscale
 * ranges and hiding them made edges silently disappear.
 */
function isExcludedPeerIp(ip: string): boolean {
  if (!ip || isUnspecified(ip)) return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets[0] === 127) return true; // loopback
    if (octets[0] === 169 && octets[1] === 254) return true; // link-local
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === 'localhost') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // IPv6 link-local
  }
  if (lower.startsWith('::ffff:')) {
    return isExcludedPeerIp(lower.slice('::ffff:'.length));
  }
  return false;
}

function isListenerState(state: string): boolean {
  const value = (state ?? '').trim().toUpperCase();
  return value.includes('LISTEN') || value.includes('UNCONN');
}

function isActiveSocketState(state: string): boolean {
  const value = (state ?? '').trim().toUpperCase();
  return value === 'ESTABLISHED' || value === 'ESTAB' || value === 'SYN_SENT' || value === 'SYN_RECV';
}

function listenerMatches(
  port: NetworkPort,
  protocol: string,
  portNumber: number,
  localAddr: string,
): boolean {
  return port.protocol === protocol
    && port.port === portNumber
    && (
      port.listenAddr === localAddr
      || port.listenAddr === '0.0.0.0'
      || port.listenAddr === '*'
      || port.listenAddr === '::'
      || port.listenAddr === '[::]'
    );
}

export function makeObservedNode(ip: string, now: number, groupPath = SERVER_GROUP_ROOT): NetworkNode {
  const normalized = normalizeAddr(ip ?? '');
  return {
    id: observedNodeId(normalized),
    connectionId: observedNodeId(normalized),
    // Inherited from the observing node; purely informational now that node
    // identity is the IP — the group dropdown is a view filter, not a scope.
    groupPath: groupPath?.trim() || SERVER_GROUP_ROOT,
    hostname: normalized,
    osName: '',
    primaryIp: normalized,
    roleHint: 'general',
    displayName: '',
    nodeType: 'observed-server',
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
 * Materialize display-only nodes for addresses already present in the probe's
 * peer data (service links first, raw peers as macOS fallback). This is not
 * discovery and performs no I/O. Unknown OUTBOUND peers deliberately do not
 * create nodes — see `inferServiceLinks`.
 */
export function inferObservedNodes(params: {
  nodeId: string;
  peers: DetectedPeer[];
  serviceLinks?: DetectedServiceLink[];
  knownNodes: NetworkNode[];
  now: number;
}): NetworkNode[] {
  const { nodeId, peers, serviceLinks, knownNodes, now } = params;
  const currentNode = (knownNodes ?? []).find(node => node.id === nodeId);
  const group = currentNode?.groupPath?.trim() || SERVER_GROUP_ROOT;
  const byId = new Map((knownNodes ?? []).map((node) => [node.id, node]));
  for (const link of serviceLinks ?? []) {
    if (link.direction === 'outbound') continue; // only inbound strangers become nodes
    const ip = normalizeAddr(link?.remoteAddr ?? '');
    if (isExcludedPeerIp(ip)) continue;
    const id = observedNodeId(ip);
    if (!byId.has(id)) byId.set(id, makeObservedNode(ip, now, group));
  }
  for (const peer of peers ?? []) {
    const ip = normalizeAddr(peer?.remoteAddr ?? '');
    if (isExcludedPeerIp(ip)) continue;
    const id = observedNodeId(ip);
    if (!byId.has(id)) byId.set(id, makeObservedNode(ip, now, group));
  }
  return [...byId.values()].filter((node) => node.id !== nodeId);
}

function isUnspecified(ip: string): boolean {
  return ip === '0.0.0.0' || ip === '::';
}

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
 * v2.18.1: the index is GLOBAL — one IP maps to exactly one node regardless of
 * folder. That is the "one IP, one node" contract: a peer address observed by
 * any server always resolves to the same asset.
 */
export function buildInterfaceIpIndex(
  nodes: readonly NetworkNode[],
  allInterfaces: readonly NetworkInterface[],
): Map<string, string> {
  const known = new Set((nodes ?? []).map((n) => n.id));
  const owners = new Map<string, Set<string>>();
  const index = new Map<string, string>();
  for (const iface of allInterfaces ?? []) {
    if (!known.has(iface.nodeId)) continue;
    for (const addr of [...(iface.ipv4Addrs ?? []), ...(iface.ipv6Addrs ?? [])]) {
      const ip = normalizeAddr(addr);
      if (!ip || isExcludedPeerIp(ip)) continue;
      const set = owners.get(ip) ?? new Set<string>();
      set.add(iface.nodeId);
      owners.set(ip, set);
      if (set.size === 1) index.set(ip, iface.nodeId);
      else index.delete(ip); // ambiguous → no owner
    }
  }
  // Interface rows are authoritative when a node has multiple addresses; its
  // primary IP is still enough to resolve a display-only observed node.
  for (const node of nodes ?? []) {
    const ip = normalizeAddr(node.primaryIp ?? '');
    if (!ip || isExcludedPeerIp(ip)) continue;
    const owner = owners.get(ip);
    if (!owner) {
      owners.set(ip, new Set([node.id]));
      index.set(ip, node.id);
    } else if (owner.size === 1) {
      index.set(ip, [...owner][0] ?? node.id);
    }
  }
  return index;
}

/**
 * Turn observed service dependencies into server-level topology links.
 *
 * ── Primary input: service links (v2.18.1) ─────────────────────────────────
 * `serviceLinks` carry direction + both LISTENING endpoints. Inbound rows
 * (`peer → me:listener`) create/confirm `remote → me` edges even when the peer
 * is unknown (it becomes a display-only observed node — someone connected TO
 * us, that must stay visible). Outbound rows only land when the peer is
 * already known, so stray public endpoints (apt mirrors, DNS) never become
 * nodes.
 *
 * ── Fallback: raw peers (macOS/BSD payloads) ───────────────────────────────
 * When no service links are present, the legacy peer-derived path still runs:
 * direction is derived from the listener match and unknown peers become
 * observed nodes exactly as before.
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
  serviceLinks?: DetectedServiceLink[];
  knownNodes?: NetworkNode[];
  interfacesIndex: Map<string, string>;
  nodePorts?: NetworkPort[];
  existingLinks: NetworkLink[];
  now: number;
}): { links: NetworkLink[]; added: number; confirmed: number } {
  const { nodeId, peers, serviceLinks, interfacesIndex, nodePorts = [], existingLinks, now } = params;

  const existing = existingLinks ?? [];
  const byKey = new Map<string, NetworkLink>();
  for (const link of existing) byKey.set(linkNaturalKey(link), link);
  const links: NetworkLink[] = [...existing];

  let added = 0;
  let confirmed = 0;
  const addressOwner = (ip: string): string | undefined => interfacesIndex.get(ip);
  const listeningPorts = (nodePorts ?? []).filter(
    (port) => port.missingSince === null && isListenerState(port.state),
  );

  const upsert = (
    sourceNodeId: string,
    targetNodeId: string,
    protocol: 'tcp' | 'udp',
    port: number | null,
    status: LinkStatus,
    evidence: string,
  ): void => {
    if (sourceNodeId === targetNodeId) return;
    const key = linkNaturalKey({ sourceNodeId, targetNodeId, protocol, port });
    const prev = byKey.get(key);
    if (prev) {
      // Re-confirm only: manual fields, source and evidence stay untouched.
      const next: NetworkLink = {
        ...prev,
        status,
        lastConfirmedAt: now,
        updatedAt: now,
      };
      const index = links.findIndex((l) => l.id === prev.id);
      if (index !== -1) links[index] = next;
      byKey.set(key, next);
      confirmed += 1;
      return;
    }
    const link: NetworkLink = {
      id: generateId('link'),
      sourceNodeId,
      targetNodeId,
      protocol,
      port,
      linkType: inferLinkType(port ?? 0, ''),
      status,
      source: 'auto',
      evidence,
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
  };

  if ((serviceLinks ?? []).length > 0) {
    for (const link of serviceLinks ?? []) {
      const ip = normalizeAddr(link?.remoteAddr ?? '');
      if (isExcludedPeerIp(ip)) continue;
      const remoteNodeId = addressOwner(ip);
      const protocol = link.protocol === 'udp' ? 'udp' : 'tcp';
      const status: LinkStatus = isActiveSocketState(link.state) ? 'active' : 'observed';
      const countSuffix = link.connections > 1 ? ` (×${link.connections})` : '';
      if (link.direction === 'inbound') {
        // Peer → my listener. Unknown peers MUST stay visible.
        const sourceNodeId = remoteNodeId ?? observedNodeId(ip);
        const port = link.localPort ?? null;
        upsert(
          sourceNodeId,
          nodeId,
          protocol,
          port,
          status,
          `/proc ${link.state}: ${ip} → 本机:${port ?? ''}${countSuffix}`,
        );
      } else {
        // Outbound: only land on KNOWN peers — a stranger never becomes a
        // node just because we called out to it.
        if (!remoteNodeId) continue;
        const port = link.remotePort ?? null;
        const p1 = link.localPort ?? null;
        upsert(
          nodeId,
          remoteNodeId,
          protocol,
          port,
          status,
          `/proc ${link.state}: 本机${p1 != null ? `:${p1}` : ''} → ${ip}:${port ?? ''}${countSuffix}`,
        );
      }
    }
    return { links, added, confirmed };
  }

  // ── legacy fallback: derive from raw peers (macOS/BSD / old payloads) ──
  const handled = new Set<string>();
  for (const peer of peers ?? []) {
    const remoteAddr = peer?.remoteAddr ?? '';
    if (!remoteAddr) continue;

    const ip = normalizeAddr(remoteAddr);
    if (isExcludedPeerIp(ip)) continue;
    const targetNodeId = addressOwner(ip) ?? observedNodeId(ip);
    // Self-links are not topology edges. Unknown peers become observed nodes;
    // they are never probed and never receive synthetic port data.
    if (targetNodeId === nodeId) continue;

    const protocol = peer.protocol === 'udp' ? 'udp' : 'tcp';
    const localAddr = normalizeAddr(peer.localAddr ?? '');
    const inbound = peer.localPort != null
      && listeningPorts.some((port) => listenerMatches(port, protocol, peer.localPort as number, localAddr));
    const sourceNodeId = inbound ? targetNodeId : nodeId;
    const destinationNodeId = inbound ? nodeId : targetNodeId;
    const port = inbound ? peer.localPort : peer.remotePort;
    const status: LinkStatus = isActiveSocketState(peer.state) ? 'active' : 'observed';
    const key = linkNaturalKey({ sourceNodeId, targetNodeId: destinationNodeId, protocol, port });
    if (handled.has(key)) continue;
    handled.add(key);
    upsert(
      sourceNodeId,
      destinationNodeId,
      protocol,
      port,
      status,
      inbound
        ? `/proc ${peer.state}: ${ip} -> local:${port ?? ''}`
        : `/proc ${peer.state}: local -> ${ip}:${peer.remotePort ?? ''}`,
    );
  }

  return { links, added, confirmed };
}

/* ══ port-level links (level-2 drill-down) ════════════════════════════════ */

export function portLinkNaturalKey(item: {
  sourceNodeId: string | null;
  sourcePortId: string | null;
  sourceIp: string | null;
  sourceProtocol: string;
  sourcePort: number;
  targetNodeId: string | null;
  targetPortId?: string | null;
  targetIp: string | null;
  targetProtocol: string;
  targetPort: number | null;
}): string {
  // A client ephemeral port is internal evidence, not a UI entity. Server-only
  // endpoints therefore key by owner, while persisted listener endpoints key by
  // their real port-row id.
  const source = item.sourcePortId ?? item.sourceNodeId ?? item.sourceIp ?? '';
  const target = item.targetPortId
    ?? item.targetNodeId
    ?? item.targetIp
    ?? (item.targetPort === null ? '' : String(item.targetPort));
  return [
    source,
    item.sourceProtocol,
    item.sourcePortId ? item.sourcePort : '',
    target,
    item.targetProtocol,
    item.targetPortId ? item.targetPort : (item.targetPort ?? ''),
  ].join('|');
}

/**
 * Turn observed ESTABLISHED peer connections into port-level links anchored at
 * the probed server's listening port.
 *
 * ── Level-2 drill-down ─────────────────────────────────────────────────────
 * Where `inferLinksFromPeers` connects two *servers*, this connects two
 * *ports*: `源服务器:源端口 → 目标服务器:目标端口`. Direction follows the
 * socket shape instead of assuming the probed server is always the client.
 *
 * ── Unknown peers are KEPT, never probed ───────────────────────────────────
 * An unknown peer is represented by a display-only observed server node. It
 * receives no port rows until the user explicitly probes that server; that
 * probe promotes the observed node in place so existing edges and annotations
 * survive.
 *
 * ── No clobbering ──────────────────────────────────────────────────────────
 * An already-known link is only re-confirmed. Manual fields, `source` and
 * `evidence` are left alone.
 */
export function inferPortLinksFromPeers(params: {
  nodeId: string;
  peers: DetectedPeer[];
  serviceLinks?: DetectedServiceLink[];
  nodePorts: NetworkPort[];
  allPorts?: NetworkPort[];
  interfacesIndex: Map<string, string>;
  knownNodes?: NetworkNode[];
  existingPortLinks: NetworkPortLink[];
  now: number;
}): { links: NetworkPortLink[]; added: number; confirmed: number } {
  const { nodeId, peers, serviceLinks, nodePorts, allPorts = nodePorts, interfacesIndex, existingPortLinks, now } = params;
  const addressOwner = (ip: string): string | undefined => interfacesIndex.get(ip);

  const portIdForNode = (owner: string | null, protocol: string, port: number) => {
    if (!owner) return null;
    const matches = allPorts.filter((p) =>
      p.nodeId === owner &&
      p.protocol === protocol &&
      p.port === port &&
      p.missingSince === null &&
      isListenerState(p.state),
    );
    // Do not silently choose among several real listeners on different bind
    // addresses/namespaces; the edge remains server-only until evidence or the
    // user resolves the exact endpoint.
    return matches.length === 1 ? matches[0].id : null;
  };

  const resolveMyListenerId = (protocol: string, port: number, address: string | null) => {
    const listeners = nodePorts.filter((p) =>
      p.nodeId === nodeId
      && p.missingSince === null
      && isListenerState(p.state)
      && p.protocol === protocol
      && p.port === port);
    if (address) {
      const normalized = normalizeAddr(address);
      const exact = listeners.filter((p) => normalizeAddr(p.listenAddr) === normalized);
      if (exact.length === 1) return exact[0].id;
      const wildcard = listeners.filter((p) => ['0.0.0.0', '*', '::', '[::]'].includes(p.listenAddr));
      if (wildcard.length === 1) return wildcard[0].id;
      return null;
    }
    return listeners.length === 1 ? listeners[0].id : null;
  };

  const listeningPorts = (nodePorts ?? []).filter(
    (p) => p.missingSince === null && isListenerState(p.state),
  );

  const existing = existingPortLinks ?? [];
  const links: NetworkPortLink[] = [...existing];

  let added = 0;
  let confirmed = 0;

  /**
   * Merge one inferred candidate into the store.
   *
   * Beyond the exact natural-key match this performs the v2.18.1 bidirectional
   * reconciliation: the same service dependency `A:p1 → B:p2` is reported as a
   * degraded inbound row by B's probe (source port unknown) and as an
   * attributed outbound row by A's probe. The two rows share
   * (sourceNode, protocol, targetNode, targetPort) but differ in
   * `sourcePortId`, so they must UPGRADE each other in place instead of
   * duplicating. Manual links are only ever confirmed, never rewritten.
   */
  const mergeCandidate = (candidate: NetworkPortLink): void => {
    const key = portLinkNaturalKey(candidate);
    const existingIndex = links.findIndex((l) => portLinkNaturalKey(l) === key);
    if (existingIndex >= 0) {
      const prev = links[existingIndex];
      links[existingIndex] = prev.source === 'manual'
        ? { ...prev, lastConfirmedAt: now, updatedAt: now }
        : { ...prev, ...candidate, id: prev.id, source: 'auto', description: prev.description, manualLabel: prev.manualLabel, hidden: prev.hidden, firstSeenAt: prev.firstSeenAt, createdAt: prev.createdAt };
      confirmed += 1;
      return;
    }
    // Upgrade match: a degraded row (no source port row) and an attributed row
    // describe the same dependency when everything else aligns.
    if (candidate.sourcePortId !== null) {
      const degradedIndex = links.findIndex((l) =>
        l.sourcePortId === null
        && l.sourceNodeId === candidate.sourceNodeId
        && l.sourceProtocol === candidate.sourceProtocol
        && l.targetNodeId === candidate.targetNodeId
        && l.targetProtocol === candidate.targetProtocol
        && l.targetPort === candidate.targetPort);
      if (degradedIndex >= 0) {
        const prev = links[degradedIndex];
        links[degradedIndex] = prev.source === 'manual'
          ? { ...prev, lastConfirmedAt: now, updatedAt: now }
          : { ...candidate, id: prev.id, description: prev.description, manualLabel: prev.manualLabel, hidden: prev.hidden, firstSeenAt: prev.firstSeenAt, createdAt: prev.createdAt };
        confirmed += 1;
        return;
      }
    }
    links.push({ ...candidate, id: generateId('plink') });
    added += 1;
  };

  if ((serviceLinks ?? []).length > 0) {
    for (const link of serviceLinks ?? []) {
      const ip = normalizeAddr(link?.remoteAddr ?? '');
      if (!ip || isExcludedPeerIp(ip)) continue;
      if (addressOwner(ip) === nodeId) continue; // own interface
      const protocol = link.protocol === 'udp' ? 'udp' : 'tcp';
      const status: LinkStatus = isActiveSocketState(link.state) ? 'active' : 'observed';
      const countSuffix = link.connections > 1 ? ` (×${link.connections})` : '';
      const remoteNodeId = addressOwner(ip);
      if (link.direction === 'inbound') {
        // Peer → my listener. Unknown peers MUST stay visible (observed node).
        const sourceNodeId = remoteNodeId ?? observedNodeId(ip);
        const localPort = link.localPort;
        if (localPort == null) continue;
        mergeCandidate({
          id: '',
          sourceNodeId,
          sourcePortId: null,
          sourceIp: null,
          sourceProtocol: protocol,
          sourcePort: 0, // peer's ephemeral port deliberately unknown
          targetNodeId: nodeId,
          targetPortId: resolveMyListenerId(protocol, localPort, link.localAddr ?? null),
          targetProtocol: protocol,
          targetPort: localPort,
          targetIp: null,
          status,
          source: 'auto',
          evidence: `/proc ${link.state}: ${ip} → 本机:${localPort}${countSuffix}`,
          description: '',
          manualLabel: '',
          hidden: false,
          firstSeenAt: now,
          lastConfirmedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        // Outbound: only when the peer is already a known node.
        if (!remoteNodeId) continue;
        const targetPort = link.remotePort;
        if (targetPort == null) continue;
        const p1 = link.localPort ?? null;
        mergeCandidate({
          id: '',
          sourceNodeId: nodeId,
          sourcePortId: p1 != null ? resolveMyListenerId(protocol, p1, link.localAddr ?? null) : null,
          sourceIp: null,
          sourceProtocol: protocol,
          sourcePort: p1 ?? 0, // 0 = attribution unavailable, never fabricated
          targetNodeId: remoteNodeId,
          targetPortId: portIdForNode(remoteNodeId, protocol, targetPort),
          targetProtocol: protocol,
          targetPort,
          targetIp: null,
          status,
          source: 'auto',
          evidence: `/proc ${link.state}: 本机${p1 != null ? `:${p1}` : ''} → ${ip}:${targetPort}${countSuffix}`,
          description: '',
          manualLabel: '',
          hidden: false,
          firstSeenAt: now,
          lastConfirmedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return { links, added, confirmed };
  }

  // ── legacy fallback: derive from raw peers (macOS/BSD / old payloads) ──
  for (const peer of peers ?? []) {
    const localPort = peer?.localPort ?? null;
    if (localPort == null) continue;
    const protocol = peer.protocol === 'udp' ? 'udp' : 'tcp';
    const ip = normalizeAddr(peer?.remoteAddr ?? '');
    if (!ip) continue;
    const targetPort = peer.remotePort ?? null;
    if (targetPort == null) continue;
    if (addressOwner(ip) === nodeId || isExcludedPeerIp(ip)) {
      continue; // loopback / own interface
    }

    const peerNodeId = addressOwner(ip) ?? observedNodeId(ip);
    const localListener = listeningPorts.find((port) =>
      listenerMatches(port, protocol, localPort, normalizeAddr(peer.localAddr ?? '')));
    const normalizedProcess = (peer.processName ?? '').trim().toLowerCase();
    const processListeners = peer.processPid != null
      ? listeningPorts.filter((p) => p.pid === peer.processPid)
      : listeningPorts.filter((p) => normalizedProcess !== '' && p.processName.trim().toLowerCase() === normalizedProcess);
    const processListener = processListeners.length === 1 ? processListeners[0] : undefined;

    // A listening local socket is the server side of the connection. Keep the
    // TCP direction truthful: remote:remotePort → currentNode:localPort.
    if (localListener) {
      mergeCandidate({
        id: '',
        sourceNodeId: peerNodeId,
        // The remote endpoint is a client socket. Its ephemeral port is not a
        // listener entity and must never be linked to a same-number port row.
        sourcePortId: null,
        sourceIp: null,
        sourceProtocol: protocol,
        sourcePort: 0,
        targetNodeId: nodeId,
        targetPortId: localListener.id,
        targetProtocol: protocol,
        targetPort: localPort,
        targetIp: null,
        status: isActiveSocketState(peer.state) ? 'active' : 'observed',
        source: 'auto',
        evidence: `/proc ${peer.state}: ${ip} -> local:${localPort}`,
        description: '',
        manualLabel: '',
        hidden: false,
        firstSeenAt: now,
        lastConfirmedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    // An outbound client socket is anchored to a real same-process listener
    // when process evidence exists. Without that evidence the edge still runs
    // from the server itself; the ephemeral client port is never materialized.
    mergeCandidate({
      id: '',
      sourceNodeId: nodeId,
      sourcePortId: processListener?.id ?? null,
      sourceIp: null,
      sourceProtocol: protocol,
      sourcePort: processListener?.port ?? 0,
      targetNodeId: peerNodeId,
      targetPortId: portIdForNode(peerNodeId, protocol, targetPort),
      targetProtocol: protocol,
      targetPort,
      targetIp: null,
      status: isActiveSocketState(peer.state) ? 'active' : 'observed',
      source: 'auto',
      evidence: `/proc ${peer.state}: local -> ${ip}:${targetPort}`,
      description: '',
      manualLabel: '',
      hidden: false,
      firstSeenAt: now,
      lastConfirmedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { links, added, confirmed };
}

/**
 * After a node is probed, resolve dangling port-link endpoints whose IP matches
 * one of that node's interface addresses. This only correlates data already in
 * the store; it never probes the formerly unknown peer.
 */
export function resolvePortLinkTargets(params: {
  nodeId: string;
  nodePorts: NetworkPort[];
  interfacesIndex: Map<string, string>;
  knownNodes?: NetworkNode[];
  existingPortLinks: NetworkPortLink[];
  now: number;
}): { links: NetworkPortLink[]; resolved: number } {
  const { nodeId, nodePorts, interfacesIndex, existingPortLinks, now } = params;
  const addressOwner = (ip: string): string | undefined => interfacesIndex.get(ip);

  const resolveListenerId = (
    protocol: string,
    portNumber: number,
    address: string | null,
  ): string | null => {
    const listeners = (nodePorts ?? []).filter((port) =>
      port.missingSince === null
      && isListenerState(port.state)
      && port.protocol === protocol
      && port.port === portNumber);
    if (address) {
      const normalized = normalizeAddr(address);
      const exact = listeners.filter((port) => normalizeAddr(port.listenAddr) === normalized);
      if (exact.length === 1) return exact[0].id;
      const wildcard = listeners.filter((port) => ['0.0.0.0', '*', '::', '[::]'].includes(port.listenAddr));
      if (wildcard.length === 1) return wildcard[0].id;
      return null;
    }
    return listeners.length === 1 ? listeners[0].id : null;
  };

  let resolved = 0;
  const links = (existingPortLinks ?? []).map((l): NetworkPortLink => {
    let next = l;

    if (next.targetIp && isServerPeerAddress(next.targetIp) && addressOwner(next.targetIp) === nodeId) {
      next = {
        ...next,
        targetNodeId: nodeId,
        targetPortId: resolveListenerId(next.targetProtocol, next.targetPort, next.targetIp),
        targetIp: null,
        lastConfirmedAt: now,
        updatedAt: now,
      };
      resolved += 1;
    } else if (next.targetNodeId === nodeId && next.targetPortId === null) {
      const portId = resolveListenerId(next.targetProtocol, next.targetPort, null);
      if (portId) {
        next = { ...next, targetPortId: portId, updatedAt: now };
        resolved += 1;
      }
    }

    if (next.sourceIp && isServerPeerAddress(next.sourceIp) && addressOwner(next.sourceIp) === nodeId) {
      next = {
        ...next,
        sourceNodeId: nodeId,
        // A dangling source was normally an ephemeral client socket. Resolving
        // its server ownership must not invent a listener endpoint.
        sourcePortId: null,
        sourceIp: null,
        lastConfirmedAt: now,
        updatedAt: now,
      };
      resolved += 1;
    } else if (next.sourceNodeId === nodeId && next.sourcePortId === null) {
      if (next.sourcePort === 0) {
        next = { ...next, updatedAt: now };
        resolved += 1;
      }
    }

    return next;
  });

  return { links, resolved };
}

/* ══ probe result → overall verdict (convenience for the API layer) ═════════ */

/** Derive the node-level probe verdict straight from a `ProbeResult`. */
export function deriveNodeProbeStatus(result: ProbeResult): ProbeStatus {
  return deriveProbeStatus(result);
}
