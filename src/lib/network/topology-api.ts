/**
 * Tauri command wrappers + the probe orchestration entry point.
 *
 * ── Triggering ─────────────────────────────────────────────────────────────
 * Nothing in this module runs automatically. Both commands are only ever
 * invoked from a user action (「探测当前服务器」/「测试 TCP 连通性」); do not
 * add a call from an effect, a mount handler or an interval.
 *
 * ── Errors ─────────────────────────────────────────────────────────────────
 * Backend commands return `Result<_, String>`, so a rejection arrives as a
 * bare string. Every rejection is normalized to an `Error` and re-thrown — the
 * UI decides how to surface it. Failures are never swallowed here.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ApplyProbeSummary, ProbeResult, TcpProbeResult } from './topology-types';
import {
  buildInterfaceIpIndex,
  deriveProbeStatus,
  inferLinksFromPeers,
  inferPortLinksFromPeers,
  inferObservedNodes,
  isObservedNode,
  mergeFirewallRules,
  mergeFirewalls,
  mergeInterfaces,
  mergeNode,
  mergePorts,
  mergeRoutes,
  normalizeTopologyAddress,
  resolvePortLinkTargets,
} from './topology-merge';
import {
  getNodeByConnectionId,
  getNodeInterfaces,
  getNodePorts,
  getNodeRoutes,
  getNodeFirewallRules,
  getNodeFirewalls,
  listInterfaces,
  listLinks,
  listNodes,
  listPortLinks,
  listPorts,
  saveLinks,
  saveNodeFirewallRules,
  saveNodeFirewalls,
  saveNodeInterfaces,
  saveNodePorts,
  saveNodeRoutes,
  savePortLinks,
  upsertNode,
} from './topology-storage';

/**
 * `ApplyProbeSummary` is part of the shared contract and now lives in
 * `./topology-types`; it is re-exported here so existing imports from this
 * module keep working. New code should import it from `topology-types`.
 */
export type { ApplyProbeSummary } from './topology-types';

/** Hard ceiling on ports sent to one `probe_tcp_ports` call. */
export const MAX_PROBE_PORTS = 200;
/** Default per-port connect timeout (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/**
 * Tauri serializes command rejections as plain strings; normalize every shape
 * (string, Error, arbitrary object) into a real `Error`.
 */
function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'string' && err.trim()) return new Error(err);
  return new Error(fallback);
}

/** Run the full read-only probe against the server bound to `connectionId`. */
export async function probeServerTopology(connectionId: string): Promise<ProbeResult> {
  try {
    return await invoke<ProbeResult>('probe_network_topology', { connectionId });
  } catch (err) {
    throw toError(err, '探测网络拓扑失败');
  }
}

/**
 * TCP-connect a list of ports on `host` from the selected SSH server.
 *
 * The existing SSH session is the probe origin, so a server reached through a
 * jump host is tested through that same route. No local-machine path is used.
 *
 * Front-end sanitization before hitting the backend: de-duplicate, drop
 * anything outside 1..65535, and cap the batch at `MAX_PROBE_PORTS`. An empty
 * result list short-circuits without an IPC round-trip.
 */
export async function probeTcpPorts(
  connectionId: string,
  host: string,
  ports: number[],
  timeoutMs?: number,
): Promise<TcpProbeResult[]> {
  const origin = (connectionId ?? '').trim();
  if (!origin) throw new Error('缺少 SSH 会话');
  const target = (host ?? '').trim();
  if (!target) throw new Error('缺少目标主机');

  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const port of ports ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    normalized.push(port);
    if (normalized.length >= MAX_PROBE_PORTS) break;
  }
  if (normalized.length === 0) return [];

  const rawTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const timeout = Math.min(Math.max(rawTimeout, 100), 30_000);

  try {
    return await invoke<TcpProbeResult[]>('probe_tcp_ports', {
      connectionId: origin,
      host: target,
      ports: normalized,
      timeoutMs: timeout,
    });
  } catch (err) {
    throw toError(err, 'TCP 连通性测试失败');
  }
}

/* ══ orchestration ═════════════════════════════════════════════════════════ */

export interface ApplyProbeInput {
  /** Saved-connection id of the probed server (`originalConnectionId ?? tabId`). */
  connectionId: string;
  /** Seed for a newly created node's `displayName`; ignored afterwards. */
  connectionName: string;
  result: ProbeResult;
  /** Probe timestamp; defaults to `Date.now()`. */
  probeAt?: number;
}

/**
 * Probe → merge → persist, in one call.
 *
 * Every table goes through the incremental merge in `topology-merge`, so this
 * writes auto fields only: a second probe updates what the server reports
 * while leaving the user's display name, port purposes, notes, hidden flags
 * and layout coordinates exactly as they were.
 *
 * Unknown peer IPs become display-only observed nodes so their server edges are
 * visible. They are not probed and receive no port data until explicitly selected.
 */
export function applyProbeResult(input: ApplyProbeInput): ApplyProbeSummary {
  const probeAt = input.probeAt ?? Date.now();
  const data = input.result?.data;
  const status = deriveProbeStatus(input.result);
  const detectedAddresses = new Set<string>();
  const interfaceAddresses = (data?.interfaces ?? []).flatMap((item) => [
    ...(item.ipv4Addrs ?? []),
    ...(item.ipv6Addrs ?? []),
  ]);
  for (const addr of [data?.primaryIp ?? '', ...interfaceAddresses]) {
    const normalized = normalizeTopologyAddress(addr);
    if (normalized) detectedAddresses.add(normalized);
  }
  const observedCandidate = data
    ? listNodes().find((node) => isObservedNode(node) && detectedAddresses.has(normalizeTopologyAddress(node.primaryIp)))
    : undefined;

  const node = mergeNode(
    getNodeByConnectionId(input.connectionId) ?? observedCandidate,
    data,
    input.connectionId,
    probeAt,
    probeAt,
    { status, error: input.result?.error ?? null, initialDisplayName: input.connectionName ?? '' },
  );
  upsertNode(node);
  const nodeId = node.id;

  const interfaces = mergeInterfaces(getNodeInterfaces(nodeId), data?.interfaces ?? [], nodeId, probeAt);
  saveNodeInterfaces(nodeId, interfaces.items);

  const routes = mergeRoutes(getNodeRoutes(nodeId), data?.routes ?? [], nodeId, probeAt);
  saveNodeRoutes(nodeId, routes.items);

  // Merge against EVERY stored row, not just the current one: a firewall
  // implementation switch produces a second row while the old one is retained
  // (marked missing) so the user's note on it survives.
  const firewalls = mergeFirewalls(getNodeFirewalls(nodeId), data?.firewall ?? null, nodeId, probeAt);
  const firewall = firewalls.items.find((f) => f.missingSince === null) ?? firewalls.items[0] ?? null;
  saveNodeFirewalls(nodeId, firewalls.items);

  const rules = mergeFirewallRules(
    getNodeFirewallRules(nodeId),
    data?.firewallRules ?? [],
    nodeId,
    firewall?.id ?? '',
    probeAt,
  );
  saveNodeFirewallRules(nodeId, rules.items);

  const ports = mergePorts(getNodePorts(nodeId), data?.ports ?? [], nodeId, probeAt);
  saveNodePorts(nodeId, ports.items);

  const nodesBefore = listNodes();
  const knownNodes = inferObservedNodes({
    nodeId,
    peers: data?.peers ?? [],
    knownNodes: nodesBefore,
    now: probeAt,
  });
  const knownIds = new Set(nodesBefore.map((item) => item.id));
  for (const observed of knownNodes) {
    if (!knownIds.has(observed.id)) upsertNode(observed);
  }
  const interfacesIndex = buildInterfaceIpIndex(knownNodes, listInterfaces());
  const linkResult = inferLinksFromPeers({
    nodeId,
    peers: data?.peers ?? [],
    knownNodes,
    interfacesIndex,
    existingLinks: listLinks(),
    now: probeAt,
  });
  saveLinks(linkResult.links);

  // ── port-level links (level-2 drill-down) ──
  // Infer port links from the same observed peers, anchored at the probed
  // node's listening ports. Unknown peers become observed server nodes with no
  // port rows; they are never auto-probed.
  const portLinkResult = inferPortLinksFromPeers({
    nodeId,
    peers: data?.peers ?? [],
    nodePorts: getNodePorts(nodeId),
    allPorts: listPorts(),
    interfacesIndex,
    existingPortLinks: listPortLinks(),
    now: probeAt,
  });
  savePortLinks(portLinkResult.links);

  // Resolve any dangling port links whose target IP now matches this node's
  // freshly-probed interfaces ("探测后关联", without re-probing the peer).
  const portLinkResolution = resolvePortLinkTargets({
    nodeId,
    nodePorts: getNodePorts(nodeId),
    interfacesIndex,
    existingPortLinks: listPortLinks(),
    now: probeAt,
  });
  if (portLinkResolution.resolved > 0) savePortLinks(portLinkResolution.links);

  return {
    nodeId,
    added: {
      interfaces: interfaces.added,
      routes: routes.added,
      rules: rules.added,
      ports: ports.added,
    },
    updated: {
      interfaces: interfaces.updated,
      routes: routes.updated,
      rules: rules.updated,
      ports: ports.updated,
    },
    missing: {
      interfaces: interfaces.missing,
      routes: routes.missing,
      rules: rules.missing,
      ports: ports.missing,
    },
    linksAdded: linkResult.added,
    linksConfirmed: linkResult.confirmed,
    portLinksAdded: portLinkResult.added,
    portLinksConfirmed: portLinkResult.confirmed,
    portLinksResolved: portLinkResolution.resolved,
  };
}
