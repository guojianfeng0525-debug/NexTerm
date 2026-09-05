/**
 * Shared fixtures for the network-topology unit tests.
 *
 * Not a `.test.ts` file on purpose — every builder here is reused by the
 * merge, storage and API suites so they all assert against identical shapes.
 */
import type {
  DetectedFirewall,
  DetectedFirewallRule,
  DetectedInterface,
  DetectedPeer,
  DetectedPort,
  DetectedRoute,
  NetworkFirewall,
  NetworkFirewallRule,
  NetworkInterface,
  NetworkLink,
  NetworkNode,
  NetworkPort,
  NetworkPortLink,
  NetworkRoute,
  PortProbeRecord,
  ProbeData,
  ProbeResult,
  ProbeSection,
  ProbeSections,
  SectionStatus,
} from '../topology-types';

export function section(status: SectionStatus = 'ok', note = ''): ProbeSection {
  return { status, note };
}

export function sections(over: Partial<ProbeSections> = {}): ProbeSections {
  return {
    hostname: section(),
    os: section(),
    interfaces: section(),
    routes: section(),
    firewall: section(),
    rules: section(),
    ports: section(),
    peers: section(),
    ...over,
  };
}

export function detectedPort(over: Partial<DetectedPort> = {}): DetectedPort {
  return {
    protocol: 'tcp',
    port: 80,
    listenAddr: '0.0.0.0',
    state: 'LISTEN',
    processName: 'nginx',
    pid: 100,
    processUser: 'root',
    ...over,
  };
}

export function detectedInterface(over: Partial<DetectedInterface> = {}): DetectedInterface {
  return {
    ifaceName: 'eth0',
    mac: 'aa:bb:cc:dd:ee:ff',
    state: 'UP',
    mtu: 1500,
    isLoopback: false,
    ipv4Addrs: ['10.0.0.5/24'],
    ipv6Addrs: [],
    ...over,
  };
}

export function detectedRoute(over: Partial<DetectedRoute> = {}): DetectedRoute {
  return {
    destination: 'default',
    gateway: '10.0.0.1',
    genmask: '0.0.0.0',
    flags: 'UG',
    metric: 100,
    iface: 'eth0',
    // `unknown` by default so the fixtures exercise the local classification
    // fallback unless a test explicitly simulates the Rust parser's verdict.
    routeType: 'unknown',
    ...over,
  };
}

export function detectedFirewall(over: Partial<DetectedFirewall> = {}): DetectedFirewall {
  return {
    fwType: 'firewalld',
    active: true,
    defaultInPolicy: 'drop',
    defaultOutPolicy: 'accept',
    version: '1.0',
    zones: ['public'],
    detectNote: '',
    ...over,
  };
}

export function detectedRule(over: Partial<DetectedFirewallRule> = {}): DetectedFirewallRule {
  return {
    tableName: 'filter',
    chain: 'INPUT',
    action: 'ACCEPT',
    protocol: 'tcp',
    src: '0.0.0.0/0',
    dst: '0.0.0.0/0',
    srcPort: '',
    dstPort: '22',
    inIface: '',
    outIface: '',
    rawRule: '-A INPUT -p tcp --dport 22 -j ACCEPT',
    // Empty by default so the fixtures exercise the `hashRule` fallback unless
    // a test explicitly simulates the hash emitted by `network_probe.rs`.
    ruleHash: '',
    ...over,
  };
}

export function detectedPeer(over: Partial<DetectedPeer> = {}): DetectedPeer {
  return {
    remoteAddr: '10.0.0.6',
    remotePort: 5432,
    localPort: 45678,
    protocol: 'tcp',
    processName: 'app',
    processPid: 100,
    state: 'ESTABLISHED',
    ...over,
  };
}

export function probeData(over: Partial<ProbeData> = {}): ProbeData {
  return {
    hostname: 'web-01',
    osName: 'Ubuntu 22.04',
    primaryIp: '10.0.0.5',
    interfaces: [detectedInterface()],
    routes: [detectedRoute()],
    firewall: detectedFirewall(),
    firewallRules: [detectedRule()],
    ports: [detectedPort()],
    peers: [],
    ...over,
  };
}

export function probeResult(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    success: true,
    error: null,
    sections: sections(),
    data: probeData(),
    probedAtMs: 1_000,
    rawExcerpt: null,
    ...over,
  };
}

/* ── persisted entities ──────────────────────────────────────────────────── */

export function makeNode(over: Partial<NetworkNode> = {}): NetworkNode {
  return {
    id: 'node-a',
    connectionId: 'conn-a',
    hostname: 'web-01',
    osName: 'Ubuntu 22.04',
    primaryIp: '10.0.0.5',
    roleHint: 'web',
    displayName: '',
    nodeType: '',
    environment: '',
    notes: '',
    hidden: false,
    posX: null,
    posY: null,
    lastProbeAt: 1_000,
    lastProbeStatus: 'ok',
    lastProbeError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

export function makeInterface(over: Partial<NetworkInterface> = {}): NetworkInterface {
  return {
    id: 'iface-a',
    nodeId: 'node-a',
    ifaceName: 'eth0',
    mac: 'aa:bb:cc:dd:ee:ff',
    state: 'UP',
    mtu: 1500,
    isLoopback: false,
    ipv4Addrs: ['10.0.0.5/24'],
    ipv6Addrs: ['fe80::1/64'],
    manualLabel: '',
    lastSeenAt: 1_000,
    missingSince: null,
    createdAt: 1_000,
    ...over,
  };
}

export function makeRoute(over: Partial<NetworkRoute> = {}): NetworkRoute {
  return {
    id: 'route-a',
    nodeId: 'node-a',
    destination: 'default',
    gateway: '10.0.0.1',
    genmask: '0.0.0.0',
    flags: 'UG',
    metric: 100,
    iface: 'eth0',
    routeType: 'default',
    manualNote: '',
    lastSeenAt: 1_000,
    missingSince: null,
    ...over,
  };
}

export function makeFirewall(over: Partial<NetworkFirewall> = {}): NetworkFirewall {
  return {
    id: 'fw-a',
    nodeId: 'node-a',
    fwType: 'firewalld',
    active: true,
    defaultInPolicy: 'drop',
    defaultOutPolicy: 'accept',
    version: '1.0',
    zones: ['public'],
    detectNote: '',
    manualNote: '',
    lastSeenAt: 1_000,
    missingSince: null,
    ...over,
  };
}

export function makeRule(over: Partial<NetworkFirewallRule> = {}): NetworkFirewallRule {
  return {
    id: 'rule-a',
    nodeId: 'node-a',
    firewallId: 'fw-a',
    tableName: 'filter',
    chain: 'INPUT',
    action: 'ACCEPT',
    protocol: 'tcp',
    src: '0.0.0.0/0',
    dst: '0.0.0.0/0',
    srcPort: '',
    dstPort: '22',
    inIface: '',
    outIface: '',
    rawRule: '-A INPUT -p tcp --dport 22 -j ACCEPT',
    ruleHash: 'hash-a',
    manualPurpose: '',
    lastSeenAt: 1_000,
    missingSince: null,
    ...over,
  };
}

export function makePort(over: Partial<NetworkPort> = {}): NetworkPort {
  return {
    id: 'port-a',
    nodeId: 'node-a',
    protocol: 'tcp',
    port: 80,
    listenAddr: '0.0.0.0',
    state: 'LISTEN',
    processName: 'nginx',
    pid: 100,
    processUser: 'root',
    serviceName: '',
    purpose: '',
    notes: '',
    tags: [],
    hidden: false,
    reachability: 'untested',
    reachabilityAt: null,
    lastSeenAt: 1_000,
    missingSince: null,
    createdAt: 1_000,
    ...over,
  };
}

export function makeProbe(over: Partial<PortProbeRecord> = {}): PortProbeRecord {
  return {
    id: 'probe-a',
    nodeId: 'node-a',
    portId: 'port-a',
    protocol: 'tcp',
    port: 80,
    targetHost: '10.0.0.5',
    status: 'reachable',
    tcpOk: true,
    latencyMs: 12,
    errorText: null,
    probedAt: 1_000,
    triggeredBy: 'manual',
    ...over,
  };
}

export function makeLink(over: Partial<NetworkLink> = {}): NetworkLink {
  return {
    id: 'link-a',
    sourceNodeId: 'node-a',
    targetNodeId: 'node-b',
    protocol: 'tcp',
    port: 5432,
    linkType: 'database',
    status: 'observed',
    source: 'auto',
    evidence: 'ss ESTABLISHED 10.0.0.6:5432',
    description: '',
    manualLabel: '',
    hidden: false,
    firstSeenAt: 1_000,
    lastConfirmedAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

export function makePortLink(over: Partial<NetworkPortLink> = {}): NetworkPortLink {
  return {
    id: 'plink-a',
    sourceNodeId: 'node-a',
    sourcePortId: 'port-a',
    sourceIp: null,
    sourceProtocol: 'tcp',
    sourcePort: 80,
    targetNodeId: 'node-b',
    targetPortId: 'port-b',
    targetProtocol: 'tcp',
    targetPort: 3306,
    targetIp: null,
    status: 'active',
    source: 'auto',
    evidence: 'ss ESTABLISHED local:45678 -> 10.0.0.6:3306',
    description: '',
    manualLabel: '',
    hidden: false,
    firstSeenAt: 1_000,
    lastConfirmedAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}
