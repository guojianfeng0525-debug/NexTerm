import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API layer owns two Tauri commands plus the probe orchestration. The
 * backend is stubbed with a swappable handler so each test can drive the exact
 * command it cares about; `row_*` calls fall through to a no-op SQLite double
 * (the orchestration reads the in-memory cache, not SQLite).
 */
const backend = vi.hoisted(() => ({
  handler: (cmd: string, _args: Record<string, unknown>): unknown => {
    throw new Error(`unhandled command: ${cmd}`);
  },
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    backend.calls.push({ cmd, args });
    if (cmd.startsWith('row_')) {
      if (cmd === 'row_upsert') return true;
      if (cmd === 'row_list') return [];
      if (cmd === 'row_get') return null;
      return null;
    }
    return backend.handler(cmd, args);
  },
}));

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_PROBE_PORTS,
  applyProbeResult,
  probeServerTopology,
  probeTcpPorts,
} from '../topology-api';
import {
  getNodeByConnectionId,
  getNodeFirewall,
  getNodeFirewallRules,
  getNodeFirewalls,
  getNodeInterfaces,
  getNodePorts,
  getNodeRoutes,
  getNodeSnapshot,
  listLinks,
  listNodes,
  patchFirewallRuleManual,
  patchInterfaceManual,
  patchNodeManual,
  patchPortManual,
  patchPortReachability,
  patchRouteManual,
  resetTopologyStore,
} from '../topology-storage';
import type { TcpProbeResult } from '../topology-types';
import {
  detectedFirewall,
  detectedInterface,
  detectedPeer,
  detectedPort,
  detectedRoute,
  detectedRule,
  probeResult,
  section,
} from './fixtures';

beforeEach(() => {
  resetTopologyStore();
  backend.calls.length = 0;
  backend.handler = () => {
    throw new Error('no handler configured');
  };
});

afterEach(() => {
  resetTopologyStore();
});

/* ══ command wrappers ══════════════════════════════════════════════════════ */

describe('probeServerTopology', () => {
  it('returns the backend payload', async () => {
    const payload = probeResult({ probedAtMs: 5_000 });
    backend.handler = () => payload;

    await expect(probeServerTopology('conn-a')).resolves.toEqual(payload);
    expect(backend.calls[0]).toEqual({ cmd: 'probe_network_topology', args: { connectionId: 'conn-a' } });
  });

  it('normalizes a string rejection into an Error', async () => {
    backend.handler = () => {
      // Tauri serializes a `Result<_, String>` rejection as a bare string.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'SSH 会话不存在';
    };
    await expect(probeServerTopology('conn-a')).rejects.toThrow('SSH 会话不存在');
  });

  it('re-throws a real Error unchanged', async () => {
    backend.handler = () => {
      throw new Error('boom');
    };
    await expect(probeServerTopology('conn-a')).rejects.toThrow('boom');
  });
});

describe('probeTcpPorts', () => {
  it('de-duplicates, filters and forwards the sanitized port list', async () => {
    backend.handler = () => [];
    const ports = [80, 80, 443, 0, -1, 65536, 70000, 22.5, 8080];

    await probeTcpPorts('10.0.0.5', ports);

    const call = backend.calls.find((c) => c.cmd === 'probe_tcp_ports');
    expect(call?.args.host).toBe('10.0.0.5');
    expect(call?.args.ports).toEqual([80, 443, 8080]);
    expect(call?.args.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('honours an explicit timeout within bounds', async () => {
    backend.handler = () => [];
    await probeTcpPorts('h', [80], 3_000);
    expect(backend.calls.at(-1)?.args.timeoutMs).toBe(3_000);

    await probeTcpPorts('h', [80], 10);
    expect(backend.calls.at(-1)?.args.timeoutMs).toBe(100);

    await probeTcpPorts('h', [80], 999_999);
    expect(backend.calls.at(-1)?.args.timeoutMs).toBe(30_000);
  });

  it('caps the batch at 200 ports', async () => {
    backend.handler = () => [];
    const ports = Array.from({ length: 500 }, (_, i) => i + 1);
    await probeTcpPorts('h', ports);
    expect((backend.calls.at(-1)?.args.ports as number[]).length).toBe(MAX_PROBE_PORTS);
  });

  it('short-circuits without an IPC round-trip when nothing is valid', async () => {
    await expect(probeTcpPorts('h', [0, -3, 99999])).resolves.toEqual([]);
    expect(backend.calls.some((c) => c.cmd === 'probe_tcp_ports')).toBe(false);
  });

  it('rejects an empty host instead of probing nothing', async () => {
    await expect(probeTcpPorts('   ', [80])).rejects.toThrow('缺少目标主机');
  });

  it('returns the backend verdicts and normalizes failures', async () => {
    const results: TcpProbeResult[] = [
      { port: 80, status: 'reachable', tcpOk: true, latencyMs: 3, errorText: null },
    ];
    backend.handler = () => results;
    await expect(probeTcpPorts('h', [80])).resolves.toEqual(results);

    backend.handler = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'connect failed';
    };
    await expect(probeTcpPorts('h', [80])).rejects.toThrow('connect failed');
  });
});

/* ══ applyProbeResult orchestration ════════════════════════════════════════ */

describe('applyProbeResult', () => {
  it('creates the node and seeds every table', () => {
    const summary = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: '我的服务器',
      result: probeResult({
        data: {
          hostname: 'web-01',
          osName: 'Ubuntu 22.04',
          primaryIp: '10.0.0.5',
          interfaces: [detectedInterface()],
          routes: [detectedRoute()],
          firewall: detectedFirewall(),
          firewallRules: [detectedRule()],
          ports: [detectedPort()],
          peers: [],
        },
      }),
      probeAt: 1_000,
    });

    const node = getNodeByConnectionId('conn-a');
    expect(node?.id).toBe(summary.nodeId);
    expect(node?.displayName).toBe('我的服务器');
    expect(node?.hostname).toBe('web-01');
    expect(node?.lastProbeStatus).toBe('ok');

    expect(summary.added).toEqual({ interfaces: 1, routes: 1, rules: 1, ports: 1 });
    expect(getNodeInterfaces(summary.nodeId)).toHaveLength(1);
    expect(getNodeRoutes(summary.nodeId)).toHaveLength(1);
    expect(getNodeFirewall(summary.nodeId)?.fwType).toBe('firewalld');
    expect(getNodeFirewallRules(summary.nodeId)).toHaveLength(1);
    expect(getNodePorts(summary.nodeId)).toHaveLength(1);
  });

  it('keeps every manual edit across a second probe while refreshing auto fields', () => {
    const first = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: '我的服务器',
      result: probeResult(),
      probeAt: 1_000,
    });
    const nodeId = first.nodeId;

    // ── the user annotates everything ──
    patchNodeManual(nodeId, {
      displayName: '生产 Web-01',
      nodeType: '虚拟机',
      environment: '生产',
      notes: '勿动',
      hidden: true,
      posX: 42,
      posY: 84,
    });
    const portId = getNodePorts(nodeId)[0].id;
    const ifaceId = getNodeInterfaces(nodeId)[0].id;
    const routeId = getNodeRoutes(nodeId)[0].id;
    const ruleId = getNodeFirewallRules(nodeId)[0].id;
    const fwId = getNodeFirewall(nodeId)?.id ?? '';

    patchPortManual(nodeId, portId, { serviceName: '官网', purpose: '对外 HTTP', hidden: true });
    patchPortReachability(nodeId, portId, 'blocked', 1_500);
    patchInterfaceManual(nodeId, ifaceId, { manualLabel: '内网网卡' });
    patchRouteManual(nodeId, routeId, { manualNote: '默认出口' });
    patchFirewallRuleManual(nodeId, ruleId, { manualPurpose: '放行运维 SSH' });

    // ── second probe: the server changed, and one port disappeared ──
    const second = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: '连接名（不应覆盖）',
      result: probeResult({
        data: {
          hostname: 'web-01-new',
          osName: 'Ubuntu 24.04',
          primaryIp: '10.0.0.9',
          interfaces: [detectedInterface({ mac: 'new-mac', ipv4Addrs: ['10.0.0.9/24'] })],
          routes: [detectedRoute()],
          firewall: detectedFirewall({ active: false }),
          firewallRules: [detectedRule()],
          ports: [detectedPort({ port: 8080, processName: 'node' })],
          peers: [],
        },
        sections: {
          ...probeResult().sections,
          firewall: section('partial', '需要 root 权限'),
        },
      }),
      probeAt: 2_000,
    });

    expect(second.nodeId).toBe(nodeId);
    expect(second.added.ports).toBe(1); // 8080 is new
    expect(second.missing.ports).toBe(1); // 80 stopped listening but is retained
    expect(second.updated.interfaces).toBe(1);

    // ── auto fields were refreshed ──
    const node = getNodeByConnectionId('conn-a');
    expect(node?.hostname).toBe('web-01-new');
    expect(node?.osName).toBe('Ubuntu 24.04');
    expect(node?.primaryIp).toBe('10.0.0.9');
    expect(node?.lastProbeAt).toBe(2_000);
    expect(node?.lastProbeStatus).toBe('partial');

    // ── manual fields survived (the whole point of the merge engine) ──
    expect(node?.displayName).toBe('生产 Web-01');
    expect(node?.nodeType).toBe('虚拟机');
    expect(node?.environment).toBe('生产');
    expect(node?.notes).toBe('勿动');
    expect(node?.hidden).toBe(true);
    expect(node?.posX).toBe(42);
    expect(node?.posY).toBe(84);

    const oldPort = getNodePorts(nodeId).find((p) => p.port === 80);
    expect(oldPort?.serviceName).toBe('官网');
    expect(oldPort?.purpose).toBe('对外 HTTP');
    expect(oldPort?.hidden).toBe(true);
    expect(oldPort?.reachability).toBe('blocked');
    expect(oldPort?.reachabilityAt).toBe(1_500);
    expect(oldPort?.missingSince).toBe(2_000);

    expect(getNodeInterfaces(nodeId)[0].manualLabel).toBe('内网网卡');
    expect(getNodeInterfaces(nodeId)[0].mac).toBe('new-mac');
    expect(getNodeRoutes(nodeId)[0].manualNote).toBe('默认出口');
    expect(getNodeFirewallRules(nodeId)[0].manualPurpose).toBe('放行运维 SSH');
    expect(getNodeFirewall(nodeId)?.active).toBe(false);
    expect(getNodeFirewall(nodeId)?.id).toBe(fwId);

    expect(getNodeSnapshot(nodeId)?.node.id).toBe(nodeId);
  });

  it('links two probed servers without ever inventing a node for an unknown peer', () => {
    applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'a',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.5/24'] })],
          peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432, processName: 'app' })],
        },
      }),
      probeAt: 1_000,
    });

    // B has not been probed yet → the peer is discarded, no node, no link.
    expect(listNodes()).toHaveLength(1);
    expect(listLinks()).toHaveLength(0);

    applyProbeResult({
      connectionId: 'conn-b',
      connectionName: 'B',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'b',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.6/24'] })],
          peers: [detectedPeer({ remoteAddr: '203.0.113.9', remotePort: 443 })],
        },
      }),
      probeAt: 2_000,
    });
    expect(listNodes()).toHaveLength(2);
    expect(listLinks()).toHaveLength(0);

    // Re-probing A now resolves the peer to node B.
    const summary = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'a',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.5/24'] })],
          peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432, processName: 'app' })],
        },
      }),
      probeAt: 3_000,
    });

    expect(summary.linksAdded).toBe(1);
    expect(listLinks()).toHaveLength(1);
    expect(listLinks()[0]).toMatchObject({
      source: 'auto',
      status: 'observed',
      linkType: 'database',
      port: 5432,
      evidence: 'ss ESTABLISHED 10.0.0.6:5432',
    });
  });

  it('only re-confirms an existing link on a repeat probe', () => {
    const data = probeResult().data;
    const peerData = {
      ...data,
      hostname: 'a',
      interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.5/24'] })],
      peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 22 })],
    };
    const bData = {
      ...data,
      hostname: 'b',
      interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.6/24'] })],
      peers: [],
    };

    applyProbeResult({ connectionId: 'conn-b', connectionName: 'B', result: probeResult({ data: bData }), probeAt: 1_000 });
    applyProbeResult({ connectionId: 'conn-a', connectionName: 'A', result: probeResult({ data: peerData }), probeAt: 2_000 });
    const again = applyProbeResult({ connectionId: 'conn-a', connectionName: 'A', result: probeResult({ data: peerData }), probeAt: 3_000 });

    expect(again.linksAdded).toBe(0);
    expect(again.linksConfirmed).toBe(1);
    expect(listLinks()).toHaveLength(1);
    expect(listLinks()[0].lastConfirmedAt).toBe(3_000);
  });

  it('retains the previous firewall row when the implementation changes', () => {
    const nodeId = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({ data: { ...probeResult().data, firewall: detectedFirewall({ fwType: 'firewalld' }) } }),
      probeAt: 1_000,
    }).nodeId;

    const ruleId = getNodeFirewallRules(nodeId)[0].id;
    patchFirewallRuleManual(nodeId, ruleId, { manualPurpose: '放行 SSH' });

    applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({ data: { ...probeResult().data, firewall: detectedFirewall({ fwType: 'ufw' }) } }),
      probeAt: 2_000,
    });

    // The firewalld row is kept (marked missing) instead of being dropped, so
    // the note on its rules survives.
    expect(getNodeFirewalls(nodeId)).toHaveLength(2);
    expect(getNodeFirewall(nodeId)?.fwType).toBe('ufw');
    expect(getNodeFirewallRules(nodeId)[0].manualPurpose).toBe('放行 SSH');
  });

  it('marks a failed probe on the node', () => {
    const summary = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({ success: false, error: '连接已断开', data: { ...probeResult().data, hostname: '' } }),
      probeAt: 4_000,
    });

    expect(getNodeByConnectionId('conn-a')?.lastProbeStatus).toBe('failed');
    expect(getNodeByConnectionId('conn-a')?.lastProbeError).toBe('连接已断开');
    expect(getNodeByConnectionId('conn-a')?.id).toBe(summary.nodeId);
  });
});
