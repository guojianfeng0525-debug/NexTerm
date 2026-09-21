/**
 * Tauri command wrappers + the probe orchestration entry point.
 *
 * ── Triggering ─────────────────────────────────────────────────────────────
 * Nothing in this module runs automatically. The command is only ever
 * invoked from a user action (「探测当前服务器」); do not
 * add a call from an effect, a mount handler or an interval.
 *
 * ── Errors ─────────────────────────────────────────────────────────────────
 * Backend commands return `Result<_, String>`, so a rejection arrives as a
 * bare string. Every rejection is normalized to an `Error` and re-thrown — the
 * UI decides how to surface it. Failures are never swallowed here.
 */
import { invoke } from '@tauri-apps/api/core';
import { ConnectionStorageManager } from '../connection-storage';
import type {
  ApplyProbeSummary,
  MergeOutcome,
  NetworkFirewallRule,
  ProbeSection,
  ProbeResult,
} from './topology-types';
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
  normalizeTopologyAddress,
  resolvePortLinkTargets,
  sanitizeProbeData,
} from './topology-merge';
import {
  getNodeByConnectionId,
  getNodeInterfaces,
  getNodePorts,
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
  savePortLinks,
  upsertNode,
  removeNode,
  commitTopologyProbe,
} from './topology-storage';

/**
 * `ApplyProbeSummary` is part of the shared contract and now lives in
 * `./topology-types`; it is re-exported here so existing imports from this
 * module keep working. New code should import it from `topology-types`.
 */
export type { ApplyProbeSummary } from './topology-types';

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
export async function probeServerTopology(
  connectionId: string,
  options?: { includeFirewall?: boolean },
): Promise<ProbeResult> {
  try {
    return await invoke<ProbeResult>('probe_network_topology', {
      connectionId,
      includeFirewall: options?.includeFirewall ?? true,
    });
  } catch (err) {
    throw toError(err, '探测网络拓扑失败');
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

/** Partial samples can add evidence but cannot prove that old rows vanished. */
function mergeSection<T extends { id: string; missingSince: number | null; lastSeenAt: number }>(
  section: ProbeSection | undefined, existing: T[], merge: () => MergeOutcome<T>,
): MergeOutcome<T> {
  if (!section || !['ok', 'partial'].includes(section.status)) {
    return { items: existing, added: 0, updated: 0, missing: 0 };
  }
  const outcome = merge();
  if (section.status === 'ok') return outcome;
  const previous = new Map(existing.map(item => [item.id, item]));
  return { ...outcome, missing: 0, items: outcome.items.map(item => {
    const old = previous.get(item.id);
    return old && item.lastSeenAt === old.lastSeenAt ? old : item;
  }) };
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
  const data = sanitizeProbeData(input.result?.data ?? {
    hostname: '', osName: '', primaryIp: '', interfaces: [], routes: [],
    firewall: null, firewallRules: [], ports: [], peers: [], serviceLinks: [],
  });
  const status = deriveProbeStatus(input.result);
  const sections = input.result.sections;
  const readable = (key: keyof typeof sections) => input.result.success
    && ['ok', 'partial'].includes(sections[key]?.status);
  const section = (key: keyof typeof sections) => input.result.success ? sections[key] : undefined;
  const groupPath = ConnectionStorageManager.getConnection(input.connectionId)?.folder || 'All Connections';
  const detectedAddresses = new Set<string>();
  const interfaceAddresses = (data?.interfaces ?? []).flatMap((item) => [
    ...(item.ipv4Addrs ?? []),
    ...(item.ipv6Addrs ?? []),
  ]);
  for (const addr of [data?.primaryIp ?? '', ...interfaceAddresses]) {
    const normalized = normalizeTopologyAddress(addr);
    if (normalized) detectedAddresses.add(normalized);
  }
  const existingByConnection = getNodeByConnectionId(input.connectionId);
  const hasKnownClaim = listNodes().some(node => !isObservedNode(node)
    && (detectedAddresses.has(normalizeTopologyAddress(node.primaryIp))
      || getNodeInterfaces(node.id).some(iface => [...iface.ipv4Addrs, ...iface.ipv6Addrs]
        .some(addr => detectedAddresses.has(normalizeTopologyAddress(addr))))));
  const observedCandidate = readable('interfaces') && !hasKnownClaim
    ? listNodes().find(node => isObservedNode(node) && detectedAddresses.has(normalizeTopologyAddress(node.primaryIp)))
    : undefined;
  const existing = existingByConnection ?? observedCandidate;
  // Failed/unavailable sections only update attempt bookkeeping. Last known
  // identity and topology evidence survive until a successful sample replaces them.
  if (!readable('hostname')) data.hostname = existing?.hostname ?? '';
  if (!readable('os')) data.osName = existing?.osName ?? '';
  if (!readable('interfaces')) data.primaryIp = existing?.primaryIp ?? '';
  if (!readable('peers')) { data.peers = []; data.serviceLinks = []; }

  const node = mergeNode(
    existing,
    data,
    input.connectionId,
    probeAt,
    probeAt,
    {
      status,
      error: input.result?.error ?? null,
      initialDisplayName: input.connectionName ?? '',
      groupPath,
    },
  );
  if (!readable('ports') && existing) node.roleHint = existing.roleHint;
  upsertNode(node);
  const nodeId = node.id;

  const interfaces = mergeSection(section('interfaces'), getNodeInterfaces(nodeId),
    () => mergeInterfaces(getNodeInterfaces(nodeId), data.interfaces, nodeId, probeAt));
  saveNodeInterfaces(nodeId, interfaces.items);

  // Routes are no longer collected (dropped in 2.18.1): skip the merge so the
  // rows already in the store are neither refreshed nor marked missing.

  // Firewall dumps run behind a 10-minute TTL; when the probe skipped them
  // (`firewallCollected === false`) the stored rows must stay untouched —
  // merging an empty payload would wrongly mark them missing.
  const firewallCollected = data?.firewallCollected !== false;
  // Zeroed when the firewall sections were skipped (TTL cache); the summary
  // fields stay for contract stability.
  let rulesOutcome: MergeOutcome<NetworkFirewallRule> = { items: [], added: 0, updated: 0, missing: 0 };
  if (firewallCollected) {
    // Merge against EVERY stored row, not just the current one: a firewall
    // implementation switch produces a second row while the old one is retained
    // (marked missing) so the user's note on it survives.
    const firewalls = mergeSection(section('firewall'), getNodeFirewalls(nodeId),
      () => mergeFirewalls(getNodeFirewalls(nodeId), data.firewall, nodeId, probeAt));
    const firewall = firewalls.items.find((f) => f.missingSince === null) ?? firewalls.items[0] ?? null;
    saveNodeFirewalls(nodeId, firewalls.items);

    rulesOutcome = mergeSection(section('rules'), getNodeFirewallRules(nodeId), () => mergeFirewallRules(
      getNodeFirewallRules(nodeId),
      data?.firewallRules ?? [],
      nodeId,
      firewall?.id ?? '',
      probeAt,
    ));
    saveNodeFirewallRules(nodeId, rulesOutcome.items);
  }

  const ports = mergeSection(section('ports'), getNodePorts(nodeId),
    () => mergePorts(getNodePorts(nodeId), data.ports, nodeId, probeAt));
  saveNodePorts(nodeId, ports.items);

  const nodesBefore = listNodes();
  const knownNodes = inferObservedNodes({
    nodeId,
    peers: data?.peers ?? [],
    serviceLinks: data?.serviceLinks ?? [],
    knownNodes: nodesBefore,
    interfacesIndex: buildInterfaceIpIndex(nodesBefore, listInterfaces()),
    now: probeAt,
  });
  const knownIds = new Set(nodesBefore.map((item) => item.id));
  for (const observed of knownNodes) {
    if (!knownIds.has(observed.id)) upsertNode(observed);
  }
  const interfacesIndex = buildInterfaceIpIndex(knownNodes, listInterfaces());
  const aliases = new Map<string, string>();
  for (const observed of knownNodes.filter(isObservedNode)) {
    const owner = interfacesIndex.get(normalizeTopologyAddress(observed.primaryIp));
    if (owner && owner !== observed.id) aliases.set(observed.id, owner);
  }
  if (aliases.size > 0) {
    saveLinks(listLinks().map(link => ({ ...link,
      sourceNodeId: aliases.get(link.sourceNodeId) ?? link.sourceNodeId,
      targetNodeId: aliases.get(link.targetNodeId) ?? link.targetNodeId,
    })));
    savePortLinks(listPortLinks().map(link => ({ ...link,
      sourceNodeId: aliases.get(link.sourceNodeId ?? '') ?? link.sourceNodeId,
      targetNodeId: aliases.get(link.targetNodeId ?? '') ?? link.targetNodeId,
    })));
    // Do not delete a placeholder on which the user has left annotations.
    for (const observed of knownNodes.filter(item => aliases.has(item.id))) {
      if (!observed.notes && !observed.displayName && !observed.environment
        && observed.nodeType === 'observed-server' && observed.posX === null && observed.posY === null && !observed.hidden) removeNode(observed.id);
    }
  }
  const nodePorts = getNodePorts(nodeId);
  const portsComplete = section('ports')?.status === 'ok';
  // A missing listener in a truncated/failed snapshot does not prove that a
  // socket is outbound. Keep unknown peers as nodes, but defer its direction.
  const relationPeers = portsComplete ? data.peers : data.peers.filter(peer =>
    readable('ports') && data.ports.some(port => port.protocol === peer.protocol
      && port.port === peer.localPort
      && ['0.0.0.0', '::', '*', normalizeTopologyAddress(peer.localAddr ?? '')]
        .includes(normalizeTopologyAddress(port.listenAddr))));
  const relationServices = portsComplete ? data.serviceLinks
    : data.serviceLinks.filter(link => link.direction === 'inbound' && readable('ports')
      && data.ports.some(port => port.protocol === link.protocol && port.port === link.localPort));
  // Resolve any dangling port links whose target IP now matches this node's
  // freshly-probed interfaces ("探测后关联", without re-probing the peer).
  const portLinkResolution = resolvePortLinkTargets({
    nodeId,
    nodePorts,
    interfacesIndex,
    knownNodes,
    existingPortLinks: listPortLinks(),
    now: probeAt,
  });
  if (portLinkResolution.resolved > 0) savePortLinks(portLinkResolution.links);

  const linkResult = inferLinksFromPeers({
    nodeId,
    peers: relationPeers,
    serviceLinks: relationServices,
    knownNodes,
    interfacesIndex,
    nodePorts,
    existingLinks: listLinks(),
    now: probeAt,
  });
  const completePeers = portsComplete && readable('peers') && sections.peers.status === 'ok';
  saveLinks(linkResult.links.map(link => completePeers && link.source === 'auto'
    && (link.sourceNodeId === nodeId || link.targetNodeId === nodeId)
    && (link.lastConfirmedAt ?? 0) < probeAt && link.status === 'active'
    ? { ...link, status: 'observed', updatedAt: probeAt } : link));

  // ── port-level links (level-2 drill-down) ──
  // Service links carry both LISTENING endpoints (A:p1 → B:p2); raw peers are
  // the macOS/BSD fallback. Unknown inbound peers become observed server nodes
  // with no port rows; they are never auto-probed.
  const portLinkResult = inferPortLinksFromPeers({
    nodeId,
    peers: relationPeers,
    serviceLinks: relationServices,
    nodePorts,
    allPorts: listPorts(),
    interfacesIndex,
    knownNodes,
    existingPortLinks: listPortLinks(),
    now: probeAt,
  });
  savePortLinks(portLinkResult.links.map(link => completePeers && link.source === 'auto'
    && (link.sourceNodeId === nodeId || link.targetNodeId === nodeId)
    && (link.lastConfirmedAt ?? 0) < probeAt && link.status === 'active'
    ? { ...link, status: 'observed', updatedAt: probeAt } : link));

  return {
    nodeId,
    added: {
      interfaces: interfaces.added,
      // Routes are no longer collected (dropped v2.18.1); the summary field
      // stays for contract stability and always reports zero.
      routes: 0,
      rules: rulesOutcome.added,
      ports: ports.added,
    },
    updated: {
      interfaces: interfaces.updated,
      routes: 0,
      rules: rulesOutcome.updated,
      ports: ports.updated,
    },
    missing: {
      interfaces: interfaces.missing,
      routes: 0,
      rules: rulesOutcome.missing,
      ports: ports.missing,
    },
    linksAdded: linkResult.added,
    linksConfirmed: linkResult.confirmed,
    portLinksAdded: portLinkResult.added,
    portLinksConfirmed: portLinkResult.confirmed,
    portLinksResolved: portLinkResolution.resolved,
  };
}

/** Production entry point: success means the whole observation is durable. */
let probeCommitQueue: Promise<unknown> = Promise.resolve();
export function persistProbeResult(input: ApplyProbeInput): Promise<ApplyProbeSummary> {
  const result = probeCommitQueue.then(() => commitTopologyProbe(() => applyProbeResult(input)));
  probeCommitQueue = result.catch(() => undefined);
  return result;
}
