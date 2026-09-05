/**
 * Pure port-topology helpers shared by the port list and drill-down view.
 * They read already-persisted data only and never issue network requests.
 */
import type {
  NetProtocol,
  NetworkFirewall,
  NetworkFirewallRule,
  NetworkPort,
  NetworkPortLink,
  PortLinkStatus,
  ReachabilityStatus,
} from './topology-types';

export type PortFirewallStatus = 'allowed' | 'denied' | 'conflict' | 'inactive' | 'unknown';
export type PortConnectionFilter = 'all' | 'listening' | 'missing' | 'connected' | 'disconnected';

export interface PortLinkStats {
  inbound: number;
  outbound: number;
  statuses: PortLinkStatus[];
}

export interface PortFilterCriteria {
  protocol: NetProtocol | 'all';
  reachability: ReachabilityStatus | 'all';
  connection: PortConnectionFilter;
  search: string;
  host: string;
  /** Optional per-server host map for searches spanning multiple nodes. */
  hostByNode?: Record<string, string>;
}

function portInRange(value: string, port: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'any' || normalized === 'all') return true;
  // Service aliases (for example firewalld's "ssh") cannot be resolved without a
  // service catalogue; report the port as unknown rather than guessing.
  if (!/^\d/.test(normalized)) return false;
  const part = normalized.split(',')[0] ?? '';
  if (part.includes(':')) {
    const [startRaw, endRaw] = part.split(':');
    const start = Number.parseInt(startRaw ?? '', 10);
    const end = Number.parseInt(endRaw ?? '', 10);
    return start <= port && port <= end;
  }
  if (part.includes('-')) {
    const [startRaw, endRaw] = part.split('-');
    const start = Number.parseInt(startRaw ?? '', 10);
    const end = Number.parseInt(endRaw ?? '', 10);
    return start <= port && port <= end;
  }
  const single = Number.parseInt(part, 10);
  return single === port;
}

function protocolMatches(rule: NetworkFirewallRule, protocol: NetProtocol): boolean {
  const value = rule.protocol.trim().toLowerCase();
  return value === '' || value === 'all' || value === 'ip' || value === protocol || value === `${protocol}6` || value === `${protocol}4`;
}

function actionMatches(rule: NetworkFirewallRule, kind: 'allow' | 'deny'): boolean {
  const action = rule.action.trim().toLowerCase();
  if (kind === 'allow') return ['allow', 'accept', 'pass'].includes(action);
  return ['deny', 'drop', 'reject', 'block'].includes(action);
}

/** Conservative firewall verdict. This never implies actual network reachability. */
export function evaluatePortFirewall(
  port: NetworkPort,
  firewall: NetworkFirewall | null | undefined,
  rules: readonly NetworkFirewallRule[] = [],
): PortFirewallStatus {
  if (!firewall) return 'unknown';
  if (!firewall.active) return 'inactive';

  const active = rules.filter((rule) => rule.missingSince === null && protocolMatches(rule, port.protocol) && portInRange(rule.dstPort, port.port));
  const allowed = active.some((rule) => actionMatches(rule, 'allow'));
  const denied = active.some((rule) => actionMatches(rule, 'deny'));
  if (allowed && denied) return 'conflict';
  if (allowed) return 'allowed';
  if (denied) return 'denied';

  const policy = firewall.defaultInPolicy.trim().toLowerCase();
  if (policy === 'accept' || policy === 'allow') return 'allowed';
  if (policy === 'drop' || policy === 'reject' || policy === 'deny') return 'denied';
  return 'unknown';
}

export function getPortLinkStats(
  nodeId: string,
  portId: string,
  links: readonly NetworkPortLink[],
): PortLinkStats {
  const inbound = links.filter((link) => link.targetNodeId === nodeId && link.targetPortId === portId);
  const outbound = links.filter((link) => link.sourceNodeId === nodeId && link.sourcePortId === portId);
  return {
    inbound: inbound.length,
    outbound: outbound.length,
    statuses: [...inbound, ...outbound].map((link) => link.status),
  };
}

function exactEndpointMatches(query: string, port: NetworkPort, criteria: PortFilterCriteria): boolean {
  const trimmed = query.trim().toLowerCase();
  const index = trimmed.lastIndexOf(':');
  if (index <= 0) return false;
  const ip = trimmed.slice(0, index).replace(/^\[|\]$/g, '');
  const portNumber = Number.parseInt(trimmed.slice(index + 1), 10);
  if (!Number.isInteger(portNumber) || portNumber <= 0) return false;
  const host = criteria.hostByNode?.[port.nodeId] ?? criteria.host;
  const addresses = [host, port.listenAddr].map((value) => value.trim().toLowerCase()).filter(Boolean);
  return port.port === portNumber && addresses.includes(ip);
}

export function filterNetworkPorts(
  ports: readonly NetworkPort[],
  links: readonly NetworkPortLink[],
  criteria: PortFilterCriteria,
): NetworkPort[] {
  const term = criteria.search.trim().toLowerCase();
  return ports.filter((port) => {
    if (criteria.protocol !== 'all' && port.protocol !== criteria.protocol) return false;
    if (criteria.reachability !== 'all' && port.reachability !== criteria.reachability) return false;

    const stats = getPortLinkStats(port.nodeId, port.id, links);
    const state = port.state.trim().toUpperCase();
    const isListening = port.missingSince === null && (state.includes('LISTEN') || state.includes('UNCONN'));
    const hasActualConnection = stats.statuses.some((status) => status === 'active' || status === 'observed');
    if (criteria.connection === 'listening' && !isListening) return false;
    if (criteria.connection === 'missing' && port.missingSince === null) return false;
    if (criteria.connection === 'connected' && !hasActualConnection) return false;
    if (criteria.connection === 'disconnected' && hasActualConnection) return false;

    if (!term) return true;
    if (exactEndpointMatches(term, port, criteria)) return true;
    const haystack = [
      String(port.port),
      port.protocol,
      port.listenAddr,
      criteria.hostByNode?.[port.nodeId] ?? criteria.host,
      port.processName,
      port.pid === null ? '' : String(port.pid),
      port.serviceName,
      port.purpose,
      port.notes,
      port.tags.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(term);
  });
}
