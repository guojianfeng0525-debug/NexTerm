import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storage layer talks to SQLite through `invoke`, so the whole backend is
 * replaced by an in-memory table map. That keeps these tests focused on the
 * row mappers and the cache semantics — and lets us hydrate straight back
 * from the "database" to prove a full round-trip.
 */
const store = vi.hoisted(() => {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  return { tables, calls };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    store.calls.push({ cmd, args });
    const table = args.table as string;
    const tableRows = () => {
      let t = store.tables.get(table);
      if (!t) {
        t = new Map<string, Record<string, unknown>>();
        store.tables.set(table, t);
      }
      return t;
    };

    switch (cmd) {
      case 'row_upsert': {
        const row = args.row as Record<string, unknown>;
        const rawKey: unknown = row.id ?? row.key ?? '';
        if (typeof rawKey !== 'string' || !rawKey) throw new Error('row_upsert without a primary key');
        tableRows().set(rawKey, { ...row });
        return true;
      }
      case 'row_list':
        return [...(store.tables.get(table)?.values() ?? [])].map((r) => ({ ...r }));
      case 'row_get': {
        const row = store.tables.get(table)?.get(args.key as string);
        return row ? { ...row } : null;
      }
      case 'row_delete':
        store.tables.get(table)?.delete(args.key as string);
        return null;
      case 'row_clear':
        store.tables.get(table)?.clear();
        return null;
      default:
        throw new Error(`unexpected tauri command: ${cmd}`);
    }
  },
}));

import {
  TOPOLOGY_CHANGED_EVENT,
  appendPortProbe,
  getNode,
  getNodeByConnectionId,
  getNodeFirewall,
  getNodeFirewallRules,
  getNodeInterfaces,
  getNodePorts,
  getNodeRoutes,
  getNodeSnapshot,
  getPortProbes,
  initializeTopologyStore,
  isTopologyStoreInitialized,
  listInterfaces,
  listLinks,
  listNodes,
  patchFirewallRuleManual,
  patchInterfaceManual,
  patchNodeManual,
  patchPortManual,
  patchPortReachability,
  patchRouteManual,
  removeLink,
  removeNode,
  resetTopologyStore,
  saveNodeFirewallRules,
  saveNodeFirewalls,
  saveNodeInterfaces,
  saveNodePorts,
  saveNodeRoutes,
  subscribeTopology,
  upsertLink,
  upsertNode,
} from '../topology-storage';
import {
  makeFirewall,
  makeInterface,
  makeLink,
  makeNode,
  makePort,
  makeProbe,
  makeRoute,
  makeRule,
} from './fixtures';

/** Let the fire-and-forget `rowUpsert` promises settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.tables.clear();
  store.calls.length = 0;
  resetTopologyStore();
});

afterEach(() => {
  resetTopologyStore();
});

/* ══ row mapping round-trip ════════════════════════════════════════════════ */

describe('row mapping round-trip', () => {
  it('hydrates every entity back with identical fields', async () => {
    const node = makeNode({
      id: 'node-1',
      connectionId: 'conn-1',
      hostname: 'web-01',
      osName: 'Ubuntu 22.04',
      primaryIp: '10.0.0.5',
      roleHint: 'web',
      displayName: '生产 Web',
      nodeType: '虚拟机',
      environment: '生产',
      notes: '备注',
      hidden: true,
      posX: 120.5,
      posY: -40,
      lastProbeAt: 1_000,
      lastProbeStatus: 'partial',
      lastProbeError: '需要 root 权限',
      createdAt: 900,
      updatedAt: 1_000,
    });
    const iface = makeInterface({ id: 'iface-1', nodeId: 'node-1', ipv4Addrs: ['10.0.0.5/24'], ipv6Addrs: ['fe80::1/64'], manualLabel: '内网', missingSince: 500 });
    const route = makeRoute({ id: 'route-1', nodeId: 'node-1', metric: null, manualNote: '业务网段' });
    const firewall = makeFirewall({ id: 'fw-1', nodeId: 'node-1', zones: ['public', 'dmz'], active: false });
    const rule = makeRule({ id: 'rule-1', nodeId: 'node-1', firewallId: 'fw-1', manualPurpose: '放行 SSH' });
    const port = makePort({ id: 'port-1', nodeId: 'node-1', pid: null, reachability: 'blocked', reachabilityAt: 1_500, hidden: true, serviceName: '官网', purpose: '对外' });
    const probe = makeProbe({ id: 'probe-1', nodeId: 'node-1', portId: null, latencyMs: null, errorText: 'timeout' });
    const link = makeLink({ id: 'link-1', sourceNodeId: 'node-1', targetNodeId: 'node-2', port: null, source: 'manual', hidden: true, description: '专线' });

    upsertNode(node);
    saveNodePorts('node-1', [port]);
    appendPortProbe(probe);
    upsertLink(link);
    // interfaces / routes / firewalls / rules go through their batch writers,
    // which is the path the probe pipeline actually uses.
    saveNodeInterfaces('node-1', [iface]);
    saveNodeRoutes('node-1', [route]);
    saveNodeFirewalls('node-1', [firewall]);
    saveNodeFirewallRules('node-1', [rule]);
    await flush();

    // Simulate an app restart: empty the cache and re-read from SQLite.
    resetTopologyStore();
    expect(isTopologyStoreInitialized()).toBe(false);
    await initializeTopologyStore();
    expect(isTopologyStoreInitialized()).toBe(true);

    expect(getNode('node-1')).toEqual(node);
    expect(getNodeInterfaces('node-1')).toEqual([iface]);
    expect(getNodeRoutes('node-1')).toEqual([route]);
    expect(getNodeFirewall('node-1')).toEqual(firewall);
    expect(getNodePorts('node-1')).toEqual([port]);
    expect(getPortProbes('node-1')).toEqual([probe]);
    expect(listLinks()).toEqual([link]);
    expect(getNodeFirewallRules('node-1')).toEqual([rule]);
  });

  it('never persists a credential column (design doc §9)', async () => {
    upsertNode(makeNode({ id: 'n1' }));
    saveNodePorts('n1', [makePort({ id: 'p1', nodeId: 'n1' })]);
    upsertLink(makeLink({ id: 'l1' }));
    await flush();

    const forbidden = ['password', 'passwd', 'privatekey', 'private_key', 'passphrase', 'token', 'secret', 'credential'];
    for (const [table, rows] of store.tables) {
      for (const row of rows.values()) {
        for (const column of Object.keys(row)) {
          const lower = column.toLowerCase();
          expect(
            forbidden.some((f) => lower.includes(f)),
            `column ${table}.${column} looks like a credential`,
          ).toBe(false);
        }
      }
    }
    expect(store.tables.size).toBeGreaterThan(0);
  });

  it('writes booleans as 0/1 and reads them back as booleans', async () => {
    upsertNode(makeNode({ id: 'n1', hidden: true }));
    await flush();

    const raw = store.tables.get('net_nodes')?.get('n1');
    expect(raw?.hidden).toBe(1);

    resetTopologyStore();
    await initializeTopologyStore();
    expect(getNode('n1')?.hidden).toBe(true);
  });
});

/* ══ cache semantics ═══════════════════════════════════════════════════════ */

describe('node cache', () => {
  it('resolves a node by connection id and upserts by id', () => {
    upsertNode(makeNode({ id: 'n1', connectionId: 'conn-1', hostname: 'a' }));
    expect(getNodeByConnectionId('conn-1')?.id).toBe('n1');

    upsertNode(makeNode({ id: 'n1', connectionId: 'conn-1', hostname: 'b' }));
    expect(listNodes()).toHaveLength(1);
    expect(getNode('n1')?.hostname).toBe('b');
  });

  it('patches only user-maintained node fields', () => {
    upsertNode(makeNode({ id: 'n1', hostname: 'web-01' }));
    const patched = patchNodeManual('n1', { displayName: '生产 Web', posX: 10, hidden: true });

    expect(patched?.displayName).toBe('生产 Web');
    expect(patched?.posX).toBe(10);
    expect(patched?.hidden).toBe(true);
    expect(patched?.hostname).toBe('web-01');
    expect(patchNodeManual('missing', { displayName: 'x' })).toBeUndefined();
  });

  it('cascades a node delete to every detail table and to touching links', async () => {
    upsertNode(makeNode({ id: 'n1' }));
    upsertNode(makeNode({ id: 'n2', connectionId: 'conn-2' }));
    saveNodeInterfaces('n1', [makeInterface({ id: 'i1', nodeId: 'n1' })]);
    saveNodeInterfaces('n2', [makeInterface({ id: 'i2', nodeId: 'n2' })]);
    saveNodeRoutes('n1', [makeRoute({ id: 'r1', nodeId: 'n1' })]);
    saveNodeFirewalls('n1', [makeFirewall({ id: 'f1', nodeId: 'n1' })]);
    saveNodeFirewallRules('n1', [makeRule({ id: 'x1', nodeId: 'n1' })]);
    saveNodePorts('n1', [makePort({ id: 'p1', nodeId: 'n1' })]);
    appendPortProbe(makeProbe({ id: 'pr1', nodeId: 'n1' }));
    upsertLink(makeLink({ id: 'l1', sourceNodeId: 'n1', targetNodeId: 'n2' }));
    upsertLink(makeLink({ id: 'l2', sourceNodeId: 'n2', targetNodeId: 'n1' }));
    upsertLink(makeLink({ id: 'l3', sourceNodeId: 'n2', targetNodeId: 'n3' }));
    await flush();

    removeNode('n1');
    await flush();

    expect(listNodes().map((n) => n.id)).toEqual(['n2']);
    expect(listInterfaces().map((i) => i.id)).toEqual(['i2']);
    expect(getNodeRoutes('n1')).toEqual([]);
    expect(getNodeFirewall('n1')).toBeNull();
    expect(getNodePorts('n1')).toEqual([]);
    expect(getPortProbes('n1')).toEqual([]);
    expect(listLinks().map((l) => l.id)).toEqual(['l3']);

    // SQLite was cleaned up too, not just the cache.
    expect(store.tables.get('net_interfaces')?.has('i1')).toBe(false);
    expect(store.tables.get('net_ports')?.has('p1')).toBe(false);
    expect(store.tables.get('net_nodes')?.has('n1')).toBe(false);
    expect(store.tables.get('net_links')?.has('l1')).toBe(false);
  });
});

describe('manual patches', () => {
  it('updates the editable columns of ports, interfaces, routes and rules', () => {
    upsertNode(makeNode({ id: 'n1' }));
    saveNodePorts('n1', [makePort({ id: 'p1', nodeId: 'n1' })]);

    saveNodeInterfaces('n1', [makeInterface({ id: 'i1', nodeId: 'n1' })]);
    saveNodeRoutes('n1', [makeRoute({ id: 'r1', nodeId: 'n1' })]);
    saveNodeFirewallRules('n1', [makeRule({ id: 'x1', nodeId: 'n1' })]);

    expect(patchPortManual('n1', 'p1', { serviceName: '官网', purpose: '对外', hidden: true })).toMatchObject({
      serviceName: '官网',
      purpose: '对外',
      hidden: true,
    });
    // scope guard: a patch for another node must not apply
    expect(patchPortManual('other', 'p1', { purpose: 'nope' })).toBeUndefined();
    expect(patchInterfaceManual('n1', 'i1', { manualLabel: '内网' })?.manualLabel).toBe('内网');
    expect(patchRouteManual('n1', 'r1', { manualNote: '业务网段' })?.manualNote).toBe('业务网段');
    expect(patchFirewallRuleManual('n1', 'x1', { manualPurpose: '放行 SSH' })?.manualPurpose).toBe('放行 SSH');
  });

  it('records a reachability verdict without touching manual columns', () => {
    upsertNode(makeNode({ id: 'n1' }));
    saveNodePorts('n1', [makePort({ id: 'p1', nodeId: 'n1', purpose: '对外' })]);

    const patched = patchPortReachability('n1', 'p1', 'unexpected_open', 2_000);
    expect(patched?.reachability).toBe('unexpected_open');
    expect(patched?.reachabilityAt).toBe(2_000);
    expect(patched?.purpose).toBe('对外');
  });
});

describe('links', () => {
  it('upserts, lists and removes links', () => {
    upsertLink(makeLink({ id: 'l1' }));
    upsertLink({ ...makeLink({ id: 'l1' }), description: '编辑过' });
    expect(listLinks()).toHaveLength(1);
    expect(listLinks()[0].description).toBe('编辑过');

    removeLink('l1');
    expect(listLinks()).toEqual([]);
  });
});

describe('snapshot + subscription', () => {
  it('assembles every table for one node', () => {
    upsertNode(makeNode({ id: 'n1' }));
    saveNodeInterfaces('n1', [makeInterface({ id: 'i1', nodeId: 'n1' })]);
    saveNodeRoutes('n1', [makeRoute({ id: 'r1', nodeId: 'n1' })]);
    saveNodeFirewalls('n1', [makeFirewall({ id: 'f1', nodeId: 'n1' })]);
    saveNodeFirewallRules('n1', [makeRule({ id: 'x1', nodeId: 'n1' })]);
    saveNodePorts('n1', [makePort({ id: 'p1', nodeId: 'n1' })]);

    const snapshot = getNodeSnapshot('n1');
    expect(snapshot?.node.id).toBe('n1');
    expect(snapshot?.interfaces).toHaveLength(1);
    expect(snapshot?.routes).toHaveLength(1);
    expect(snapshot?.firewall?.id).toBe('f1');
    expect(snapshot?.firewallRules).toHaveLength(1);
    expect(snapshot?.ports).toHaveLength(1);
    expect(getNodeSnapshot('missing')).toBeNull();
  });

  it('notifies subscribers on write and stops after unsubscribe', () => {
    let hits = 0;
    const unsubscribe = subscribeTopology(() => {
      hits += 1;
    });

    upsertNode(makeNode({ id: 'n1' }));
    expect(hits).toBe(1);

    unsubscribe();
    upsertNode(makeNode({ id: 'n2', connectionId: 'conn-2' }));
    expect(hits).toBe(1);
  });

  it('dispatches the documented event name', () => {
    const listener = vi.fn();
    window.addEventListener(TOPOLOGY_CHANGED_EVENT, listener);
    upsertNode(makeNode({ id: 'n1' }));
    window.removeEventListener(TOPOLOGY_CHANGED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

