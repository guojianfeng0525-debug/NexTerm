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
    if (cmd === 'topology_write_batch') return;
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
  applyProbeResult,
  probeServerTopology,
} from '../topology-api';
import {
  getNodeByConnectionId,
  getNodeFirewall,
  getNodeFirewallRules,
  getNodeFirewalls,
  getNodeInterfaces,
  getNodePorts,
  getNodeSnapshot,
  listLinks,
  listNodes,
  listPortLinks,
  patchFirewallRuleManual,
  patchInterfaceManual,
  patchNodeManual,
  patchPortManual,
  patchPortReachability,
  resetTopologyStore,
} from '../topology-storage';
import {
  detectedFirewall,
  detectedInterface,
  detectedPeer,
  detectedPort,
  detectedRoute,
  detectedRule,
  probeResult,
  section,
  sections,
  probeData,
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
    expect(backend.calls[0]).toEqual({
      cmd: 'probe_network_topology',
      args: { connectionId: 'conn-a', includeFirewall: true },
    });
  });

  it('passes includeFirewall=false through for TTL-cached re-probes', async () => {
    const payload = probeResult({ probedAtMs: 5_000 });
    backend.handler = () => payload;

    await probeServerTopology('conn-a', { includeFirewall: false });
    expect(backend.calls[0]).toEqual({
      cmd: 'probe_network_topology',
      args: { connectionId: 'conn-a', includeFirewall: false },
    });
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
          firewallCollected: true,
          ports: [detectedPort()],
          peers: [],
          serviceLinks: [],
        },
      }),
      probeAt: 1_000,
    });

    const node = getNodeByConnectionId('conn-a');
    expect(node?.id).toBe(summary.nodeId);
    expect(node?.displayName).toBe('我的服务器');
    expect(node?.hostname).toBe('web-01');
    expect(node?.lastProbeStatus).toBe('ok');

    // Routes are no longer collected (dropped v2.18.1); firewall/rules still
    // merge when the probe ran with includeFirewall (default true).
    expect(summary.added).toEqual({ interfaces: 1, routes: 0, rules: 1, ports: 1 });
    expect(getNodeInterfaces(summary.nodeId)).toHaveLength(1);
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
    const ruleId = getNodeFirewallRules(nodeId)[0].id;
    const fwId = getNodeFirewall(nodeId)?.id ?? '';

    patchPortManual(nodeId, portId, { serviceName: '官网', purpose: '对外 HTTP', hidden: true });
    patchPortReachability(nodeId, portId, 'blocked', 1_500);
    patchInterfaceManual(nodeId, ifaceId, { manualLabel: '内网网卡' });
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
          serviceLinks: [],
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
    // Routes are no longer collected; previously stored rows are left alone.
    expect(getNodeFirewallRules(nodeId)[0].manualPurpose).toBe('放行运维 SSH');
    expect(getNodeFirewall(nodeId)?.active).toBe(false);
    expect(getNodeFirewall(nodeId)?.id).toBe(fwId);

    expect(getNodeSnapshot(nodeId)?.node.id).toBe(nodeId);
  });

  it('draws unknown peers as port-less observed servers and promotes them in place', () => {
    applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'a',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.5/24'] })],
          peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432, processName: 'app' })],
          serviceLinks: [],
        },
      }),
      probeAt: 1_000,
    });

    // B has not been probed. Its IP is still drawn as an observed server, but
    // NexTerm does not connect to it and invents no port/interface data.
    const observed = listNodes().find((node) => node.primaryIp === '10.0.0.6');
    expect(listNodes()).toHaveLength(2);
    expect(observed).toMatchObject({
      connectionId: 'observed:10.0.0.6',
      nodeType: 'observed-server',
      lastProbeStatus: 'never',
    });
    expect(getNodePorts(observed?.id ?? '')).toHaveLength(0);
    expect(listLinks()).toHaveLength(1);
    expect(listLinks()[0].targetNodeId).toBe(observed?.id);
    expect(listPortLinks()[0]).toMatchObject({
      sourceNodeId: expect.any(String),
      targetNodeId: observed?.id,
      targetPort: 5432,
      targetPortId: null,
    });

    applyProbeResult({
      connectionId: 'conn-b',
      connectionName: 'B',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'b',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.6/24'] })],
          ports: [detectedPort({ port: 5432, processName: 'postgres', pid: 201 })],
          peers: [detectedPeer({ localAddr: '10.0.0.6', remoteAddr: '203.0.113.9', remotePort: 443 })],
          serviceLinks: [],
        },
      }),
      probeAt: 2_000,
    });
    // The explicitly probed B reuses the observed node id, preserving the edge.
    const promoted = getNodeByConnectionId('conn-b');
    expect(promoted?.id).toBe(observed?.id);
    expect(promoted?.connectionId).toBe('conn-b');
    expect(getNodePorts(promoted?.id ?? '')).toHaveLength(1);
    expect(listLinks()).toHaveLength(2);

    // Re-probing A confirms the same edge instead of duplicating it, and the
    // target port now points at B's real 5432 row.
    const summary = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A',
      result: probeResult({
        data: {
          ...probeResult().data,
          hostname: 'a',
          interfaces: [detectedInterface({ ifaceName: 'eth0', ipv4Addrs: ['10.0.0.5/24'] })],
          peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432, processName: 'app' })],
          serviceLinks: [],
        },
      }),
      probeAt: 3_000,
    });

    expect(summary.linksAdded).toBe(0);
    expect(summary.linksConfirmed).toBe(1);
    const aToB = listLinks().filter((link) => link.sourceNodeId !== promoted?.id);
    expect(aToB).toHaveLength(1);
    expect(aToB[0]).toMatchObject({
      source: 'auto',
      status: 'active',
      linkType: 'database',
      port: 5432,
      evidence: '/proc ESTABLISHED: local -> 10.0.0.6:5432',
    });
  });

  it('keeps independent saved connections separate when their private IPs overlap', () => {
    const first = applyProbeResult({
      connectionId: 'conn-a',
      connectionName: 'A alias',
      result: probeResult({ data: { ...probeResult().data, primaryIp: '10.0.0.5' } }),
      probeAt: 1_000,
    });
    const second = applyProbeResult({
      connectionId: 'conn-b',
      connectionName: 'B alias',
      result: probeResult({ data: { ...probeResult().data, primaryIp: '10.0.0.5' } }),
      probeAt: 2_000,
    });

    expect(second.nodeId).not.toBe(first.nodeId);
    expect(listNodes()).toHaveLength(2);
    expect(getNodeByConnectionId('conn-b')?.id).toBe(second.nodeId);
    expect(getNodeByConnectionId('conn-a')?.id).toBe(first.nodeId);
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
      serviceLinks: [],
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

describe('incremental evidence reliability', () => {
  it('retains uncertain peers without inventing outbound ports from a truncated listener table', () => {
    applyProbeResult({ connectionId: 'a', connectionName: 'A', result: probeResult({
      sections: sections({ ports: section('partial', 'sample limit'), peers: section('partial', 'sample limit') }),
      data: probeData({ ports: [], peers: [detectedPeer({ localPort: 8080, remotePort: 45000 })] }),
    }) });
    expect(listNodes()).toHaveLength(2);
    expect(listLinks()).toEqual([]);
    expect(listPortLinks()).toEqual([]);
  });

  it.each(['a', 'b'])('converges reciprocal observations starting from %s without duplicate port edges', first => {
    const sample = (server: string) => {
      const ip = server === 'a' ? '10.0.0.1' : '10.0.0.2';
      return probeResult({ data: probeData({ primaryIp: ip,
        interfaces: [detectedInterface({ ipv4Addrs: [ip + '/24'] })],
        ports: [detectedPort({ port: server === 'a' ? 8080 : 5432 })],
        peers: [], serviceLinks: [{ localAddr: ip,
          remoteAddr: server === 'a' ? '10.0.0.2' : '10.0.0.1',
          direction: server === 'a' ? 'outbound' : 'inbound',
          localPort: server === 'a' ? 8080 : 5432,
          remotePort: server === 'a' ? 5432 : null,
          protocol: 'tcp', state: 'ESTABLISHED', connections: 1,
        }],
      }) });
    };
    [first, first === 'a' ? 'b' : 'a', 'a', 'b'].forEach((server, index) => {
      applyProbeResult({ connectionId: server, connectionName: server, result: sample(server), probeAt: 1000 + index });
    });
    expect(listNodes()).toHaveLength(2);
    expect(listLinks()).toHaveLength(1);
    expect(listPortLinks()).toHaveLength(1);
    expect(listPortLinks()[0]).toMatchObject({
      sourceNodeId: getNodeByConnectionId('a')?.id,
      targetNodeId: getNodeByConnectionId('b')?.id,
      sourcePort: 8080, targetPort: 5432,
    });
    expect(listPortLinks()[0].targetPortId).toBeTruthy();
  });

  it('retains all last good rows and identity after a timeout', () => {
    const first = applyProbeResult({ connectionId: 'a', connectionName: 'A', result: probeResult(), probeAt: 1000 });
    const previous = getNodeSnapshot(first.nodeId)!;
    applyProbeResult({ connectionId: 'a', connectionName: 'A', result: probeResult({ success: false, error: 'timeout', data: probeData({ hostname: '', osName: '', primaryIp: '', interfaces: [], ports: [], firewall: null, firewallRules: [], peers: [], serviceLinks: [] }) }), probeAt: 2000 });
    const current = getNodeSnapshot(first.nodeId)!;
    expect(current.node.hostname).toBe(previous.node.hostname);
    expect(current.node.primaryIp).toBe(previous.node.primaryIp);
    expect(current.node.lastProbeStatus).toBe('failed');
    expect(current.interfaces).toEqual(previous.interfaces);
    expect(current.ports).toEqual(previous.ports);
    expect(current.firewallRules).toEqual(previous.firewallRules);
  });

  it('adds partial evidence without marking unseen rows missing', () => {
    const first = applyProbeResult({ connectionId: 'a', connectionName: 'A', result: probeResult(), probeAt: 1000 });
    applyProbeResult({ connectionId: 'a', connectionName: 'A', result: probeResult({ sections: sections({ ports: section('partial', 'interrupted') }), data: probeData({ ports: [detectedPort({ port: 443 })] }) }), probeAt: 2000 });
    expect(getNodePorts(first.nodeId).map(p => [p.port, p.missingSince])).toEqual([[443, null], [80, null]]);
  });

  it('accumulates A → B → C, promotes B without re-probing A and retains history', () => {
    const sample = (ip: string, remote: string | null) => probeResult({ data: probeData({ primaryIp: ip,
      interfaces: [detectedInterface({ ipv4Addrs: [ip + '/24'] })], ports: [detectedPort()],
      peers: remote ? [detectedPeer({ localAddr: ip, remoteAddr: remote, localPort: 45000, remotePort: 80 })] : [],
    }) });
    const a = applyProbeResult({ connectionId: 'a', connectionName: 'A', result: sample('172.20.0.1', '172.20.0.2'), probeAt: 1000 });
    expect(listLinks()).toHaveLength(1);
    const b = applyProbeResult({ connectionId: 'b', connectionName: 'B', result: sample('172.20.0.2', '172.20.0.3'), probeAt: 2000 });
    expect(listLinks()).toHaveLength(2);
    expect(listLinks().some(l => l.sourceNodeId === a.nodeId && l.targetNodeId === b.nodeId)).toBe(true);
    expect(listPortLinks().find(l => l.targetNodeId === b.nodeId)?.targetPortId).toBeTruthy();
    const c = applyProbeResult({ connectionId: 'c', connectionName: 'C', result: sample('172.20.0.3', null), probeAt: 3000 });
    expect(listLinks()).toHaveLength(2);
    expect(listNodes()).toHaveLength(3);
    expect(listPortLinks().find(l => l.targetNodeId === c.nodeId)?.targetPortId).toBeTruthy();
    applyProbeResult({ connectionId: 'a', connectionName: 'A', result: sample('172.20.0.1', null), probeAt: 4000 });
    expect(listLinks()).toHaveLength(2);
    expect(listLinks().find(l => l.sourceNodeId === a.nodeId)).toMatchObject({ status: 'observed', lastConfirmedAt: 1000 });
    expect(backend.calls.every(call => call.cmd === 'topology_write_batch' || call.cmd.startsWith('row_'))).toBe(true);
  });
});
