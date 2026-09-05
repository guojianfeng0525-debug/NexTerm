import { describe, expect, it } from 'vitest';
import {
  buildInterfaceIpIndex,
  classifyRouteType,
  deriveProbeStatus,
  hashRule,
  inferLinkType,
  inferLinksFromPeers,
  inferPortLinksFromPeers,
  inferRoleHint,
  interfaceNaturalKey,
  linkNaturalKey,
  mergeDetected,
  mergeFirewallRules,
  mergeFirewalls,
  mergeInterfaces,
  mergeNode,
  mergePorts,
  mergeRoutes,
  portNaturalKey,
  resolvePortLinkTargets,
  resolveReachability,
  resolveRouteType,
  resolveRuleHash,
} from '../topology-merge';
import type {
  DetectedRoute,
  MergeOutcome,
  NetworkLink,
  RouteType,
  TcpProbeResult,
} from '../topology-types';
import {
  detectedFirewall,
  detectedInterface,
  detectedPeer,
  detectedPort,
  detectedRoute,
  detectedRule,
  makeFirewall,
  makeInterface,
  makeLink,
  makePortLink,
  makeNode,
  makePort,
  makeRoute,
  makeRule,
  probeData,
  probeResult,
  section,
} from './fixtures';

/* ══ mergeDetected (generic engine) ════════════════════════════════════════ */

interface Row {
  id: string;
  nodeId: string;
  key: string;
  name: string; // A
  value: number; // A
  label: string; // M
  note: string; // M
  lastSeenAt: number;
  missingSince: number | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    nodeId: 'node-a',
    key: 'k1',
    name: 'alpha',
    value: 1,
    label: '',
    note: '',
    lastSeenAt: 100,
    missingSince: null,
    ...over,
  };
}

function mergeRows(
  existing: Row[],
  detected: Partial<Row>[],
  probeAt: number,
): MergeOutcome<Row> {
  return mergeDetected<Row>({
    existing,
    detected,
    autoKeys: ['name', 'value'],
    manualKeys: ['label', 'note'],
    naturalKey: (item) => `${item.nodeId ?? ''}|${item.key ?? ''}`,
    probeAt,
    create: (incoming) =>
      row({
        id: `gen-${incoming.key ?? 'x'}`,
        name: incoming.name ?? '',
        value: incoming.value ?? 0,
        lastSeenAt: probeAt,
      }),
  });
}

describe('mergeDetected', () => {
  it('updates only auto fields on a hit and leaves manual fields untouched', () => {
    const existing = row({ label: '人工标签', note: '人工备注', name: 'old', value: 1 });
    const out = mergeRows([existing], [{ nodeId: 'node-a', key: 'k1', name: 'new', value: 2 }], 200);

    expect(out.items).toHaveLength(1);
    expect(out.items[0].name).toBe('new');
    expect(out.items[0].value).toBe(2);
    // ── the red line ──
    expect(out.items[0].label).toBe('人工标签');
    expect(out.items[0].note).toBe('人工备注');
    expect(out.added).toBe(0);
    expect(out.updated).toBe(1);
    expect(out.missing).toBe(0);
  });

  it('never lets a payload carrying manual keys clobber stored manual values', () => {
    const existing = row({ label: 'keep-me', note: 'keep-me-too' });
    // A hostile/accidental payload that also carries the manual columns.
    const out = mergeRows(
      [existing],
      [{ nodeId: 'node-a', key: 'k1', name: 'x', label: 'CLOBBERED', note: 'CLOBBERED' }],
      200,
    );

    expect(out.items[0].label).toBe('keep-me');
    expect(out.items[0].note).toBe('keep-me-too');
  });

  it('accepts a manual key list that is documentation-only — the whitelist is what enforces it', () => {
    // `note` is deliberately left OUT of autoKeys, so it survives even though
    // it is not listed in manualKeys either.
    const existing = row({ note: 'unlisted-manual' });
    const out = mergeDetected<Row>({
      existing: [existing],
      detected: [{ nodeId: 'node-a', key: 'k1', note: 'CLOBBERED' }],
      autoKeys: ['name', 'value'],
      manualKeys: ['label'],
      naturalKey: (i) => `${i.nodeId ?? ''}|${i.key ?? ''}`,
      probeAt: 200,
      create: (d) => row({ name: d.name ?? '', lastSeenAt: 200 }),
    });
    expect(out.items[0].note).toBe('unlisted-manual');
  });

  it('rejects a field declared as both auto and manual', () => {
    expect(() =>
      mergeRows([row()], [{ nodeId: 'node-a', key: 'k1' }], 200),
    ).not.toThrow();
    expect(() =>
      mergeDetected<Row>({
        existing: [row()],
        detected: [{ nodeId: 'node-a', key: 'k1' }],
        autoKeys: ['name', 'label'],
        manualKeys: ['label'],
        naturalKey: (i) => `${i.nodeId ?? ''}|${i.key ?? ''}`,
        probeAt: 200,
        create: (d) => row({ name: d.name ?? '' }),
      }),
    ).toThrow(/both auto and manual/);
  });

  it('creates new rows with default manual values', () => {
    const out = mergeRows([], [{ nodeId: 'node-a', key: 'k2', name: 'fresh', value: 9 }], 300);

    expect(out.items).toHaveLength(1);
    expect(out.items[0].name).toBe('fresh');
    expect(out.items[0].value).toBe(9);
    expect(out.items[0].label).toBe('');
    expect(out.items[0].note).toBe('');
    expect(out.items[0].lastSeenAt).toBe(300);
    expect(out.items[0].missingSince).toBeNull();
    expect(out.added).toBe(1);
  });

  it('keeps vanished rows and stamps missingSince once', () => {
    const gone = row({ id: 'row-1', key: 'k1', lastSeenAt: 100 });
    const stays = row({ id: 'row-2', key: 'k2', lastSeenAt: 100 });

    const first = mergeRows([gone, stays], [{ nodeId: 'node-a', key: 'k2' }], 200);
    expect(first.items).toHaveLength(2);
    expect(first.items.find((r) => r.key === 'k1')?.missingSince).toBe(200);
    expect(first.items.find((r) => r.key === 'k2')?.missingSince).toBeNull();
    expect(first.missing).toBe(1);

    // Second consecutive miss: the row survives, timestamp is NOT rewritten and
    // it is not counted again.
    const second = mergeRows(first.items, [{ nodeId: 'node-a', key: 'k2' }], 300);
    expect(second.items.find((r) => r.key === 'k1')?.missingSince).toBe(200);
    expect(second.missing).toBe(0);
  });

  it('clears missingSince when a vanished row reappears', () => {
    const stale = row({ key: 'k1', missingSince: 150, lastSeenAt: 100 });
    const out = mergeRows([stale], [{ nodeId: 'node-a', key: 'k1', name: 'back' }], 400);

    expect(out.items).toHaveLength(1);
    expect(out.items[0].missingSince).toBeNull();
    expect(out.items[0].lastSeenAt).toBe(400);
    expect(out.updated).toBe(1);
  });

  it('deduplicates repeated natural keys inside one payload', () => {
    const out = mergeRows(
      [],
      [
        { nodeId: 'node-a', key: 'k1', name: 'first' },
        { nodeId: 'node-a', key: 'k1', name: 'second' },
      ],
      500,
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0].name).toBe('first');
    expect(out.added).toBe(1);
  });
});

/* ══ classification helpers ════════════════════════════════════════════════ */

describe('classifyRouteType', () => {
  const cases: [Partial<DetectedRoute>, string][] = [
    [{ destination: 'default', gateway: '10.0.0.1' }, 'default'],
    [{ destination: '0.0.0.0', gateway: '10.0.0.1' }, 'default'],
    [{ destination: '::/0', gateway: 'fe80::1' }, 'default'],
    [{ destination: '10.0.0.5', gateway: '', genmask: '255.255.255.255' }, 'local'],
    [{ destination: '10.0.0.5/32', gateway: '10.0.0.1', genmask: '255.255.255.255' }, 'local'],
    [{ destination: '10.0.0.0/24', gateway: '', iface: 'eth0' }, 'link'],
    [{ destination: '10.0.0.0/24', gateway: '0.0.0.0' }, 'link'],
    [{ destination: '172.16.0.0/12', gateway: '10.0.0.1', genmask: '255.240.0.0' }, 'unicast'],
    [{ destination: '', gateway: '' }, 'unknown'],
  ];

  it.each(cases)('classifies %j as %s', (over, expected) => {
    expect(classifyRouteType(detectedRoute(over))).toBe(expected);
  });
});

describe('resolveRouteType', () => {
  // Each row below classifies differently on its own, so a passing assertion
  // proves the parser's verdict — not the local fallback — was stored.
  const provided: [RouteType, Partial<DetectedRoute>][] = [
    ['default', { destination: '10.0.0.0/24', gateway: '' }], // locally `link`
    ['unicast', { destination: '10.0.0.0/24', gateway: '' }], // locally `link`
    ['link', { destination: '172.16.0.0/12', gateway: '10.0.0.1', genmask: '255.240.0.0' }], // locally `unicast`
  ];

  it.each(provided)('uses the parser verdict %s even when local classification disagrees', (routeType, over) => {
    expect(resolveRouteType(detectedRoute({ ...over, routeType }))).toBe(routeType);
  });

  it('falls back to local classification when routeType is unknown, empty or missing', () => {
    expect(resolveRouteType(detectedRoute({ destination: '10.0.0.0/24', gateway: '', routeType: 'unknown' }))).toBe(
      'link',
    );
    expect(resolveRouteType(detectedRoute({ destination: 'default', gateway: '10.0.0.1', routeType: '' as never }))).toBe(
      'default',
    );

    // A degraded payload (no root, `netstat -rn` fallback, older backend) can
    // omit the field entirely — the local classifier must still recover a type
    // instead of persisting `unknown`.
    const legacy = {
      destination: '10.0.0.0/24',
      gateway: '',
      genmask: '255.255.255.0',
      flags: 'U',
      metric: 100,
      iface: 'eth0',
    } as DetectedRoute;
    expect(resolveRouteType(legacy)).toBe('link');
  });

  it('classifies a whole routing table through mergeRoutes', () => {
    const out = mergeRoutes(
      [],
      [
        detectedRoute({ routeType: 'default' }),
        detectedRoute({ destination: '10.0.0.0/24', gateway: '', routeType: 'link' }),
        detectedRoute({ destination: '172.16.0.0/12', gateway: '10.0.0.1', genmask: '255.240.0.0', routeType: 'unicast' }),
      ],
      'node-a',
      1_000,
    );
    expect(out.items.map((r) => r.routeType)).toEqual(['default', 'link', 'unicast']);
  });
});

describe('inferRoleHint', () => {
  it('returns database for a postgres/mysql host', () => {
    expect(inferRoleHint([detectedPort({ port: 5432 }), detectedPort({ port: 22 })])).toBe('database');
    expect(inferRoleHint([detectedPort({ port: 3306 })])).toBe('database');
  });

  it('returns cache for redis/memcached', () => {
    expect(inferRoleHint([detectedPort({ port: 6379 })])).toBe('cache');
    expect(inferRoleHint([detectedPort({ port: 11211 })])).toBe('cache');
  });

  it('returns web for http listeners and gateway for ssh-only hosts', () => {
    expect(inferRoleHint([detectedPort({ port: 443 })])).toBe('web');
    expect(inferRoleHint([detectedPort({ port: 8080 })])).toBe('web');
    expect(inferRoleHint([detectedPort({ port: 22 })])).toBe('gateway');
  });

  it('resolves multiple hits by priority', () => {
    expect(inferRoleHint([detectedPort({ port: 80 }), detectedPort({ port: 6379 })])).toBe('cache');
    expect(inferRoleHint([detectedPort({ port: 22 }), detectedPort({ port: 80 })])).toBe('web');
    expect(inferRoleHint([detectedPort({ port: 9092 }), detectedPort({ port: 3306 })])).toBe('database');
  });

  it('falls back to general when nothing matches', () => {
    expect(inferRoleHint([])).toBe('general');
    expect(inferRoleHint([detectedPort({ port: 45678 })])).toBe('general');
  });
});

describe('inferLinkType', () => {
  it('maps well-known ports', () => {
    expect(inferLinkType(22, '')).toBe('ssh');
    expect(inferLinkType(443, '')).toBe('http');
    expect(inferLinkType(8080, '')).toBe('http');
    expect(inferLinkType(5432, '')).toBe('database');
    expect(inferLinkType(3306, '')).toBe('database');
    expect(inferLinkType(6379, '')).toBe('cache');
    expect(inferLinkType(5672, '')).toBe('messaging');
    expect(inferLinkType(9092, '')).toBe('messaging');
  });

  it('falls back to the process name, then to unknown', () => {
    expect(inferLinkType(45678, 'redis-server')).toBe('cache');
    expect(inferLinkType(45678, 'nginx')).toBe('http');
    expect(inferLinkType(45678, 'my-app')).toBe('unknown');
    expect(inferLinkType(0, '')).toBe('unknown');
  });
});

/* ══ resolveReachability (design doc §5) ═══════════════════════════════════ */

function tcp(over: Partial<TcpProbeResult> = {}): TcpProbeResult {
  return { port: 80, status: 'reachable', tcpOk: true, latencyMs: 5, errorText: null, ...over };
}

describe('resolveReachability', () => {
  const cases: [string, { listening: boolean; tcp: TcpProbeResult }, string][] = [
    ['listening + connect ok → reachable', { listening: true, tcp: tcp({ status: 'reachable' }) }, 'reachable'],
    [
      'listening + refused → not_listening (stale server data)',
      { listening: true, tcp: tcp({ status: 'not_listening', tcpOk: false }) },
      'not_listening',
    ],
    [
      'listening + timeout → blocked (firewall drop)',
      { listening: true, tcp: tcp({ status: 'blocked', tcpOk: false }) },
      'blocked',
    ],
    [
      'not listening + connect ok → unexpected_open',
      { listening: false, tcp: tcp({ status: 'reachable' }) },
      'unexpected_open',
    ],
    [
      'not listening + timeout → unreachable',
      { listening: false, tcp: tcp({ status: 'blocked', tcpOk: false }) },
      'unreachable',
    ],
    [
      'dns failure wins over the listening flag',
      { listening: true, tcp: tcp({ status: 'dns_error', tcpOk: false }) },
      'dns_error',
    ],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(resolveReachability(input)).toBe(expected);
  });

  it('treats a refused connection as not_listening even when the port is not reported', () => {
    expect(resolveReachability({ listening: false, tcp: tcp({ status: 'not_listening', tcpOk: false }) })).toBe(
      'not_listening',
    );
  });

  it('propagates a transport error and leaves an untested port untested', () => {
    expect(resolveReachability({ listening: true, tcp: tcp({ status: 'error', tcpOk: false }) })).toBe('error');
    expect(resolveReachability({ listening: true, tcp: tcp({ status: 'untested', tcpOk: false }) })).toBe('untested');
  });
});

/* ══ deriveProbeStatus ═════════════════════════════════════════════════════ */

describe('deriveProbeStatus', () => {
  it('maps section statuses to an overall verdict', () => {
    expect(deriveProbeStatus(probeResult())).toBe('ok');
    expect(deriveProbeStatus(probeResult({ sections: { ...probeResult().sections, ports: section('partial', 'no root') } }))).toBe('partial');
    expect(deriveProbeStatus(probeResult({ success: false, error: 'boom' }))).toBe('failed');
  });
});

/* ══ mergeNode ═════════════════════════════════════════════════════════════ */

describe('mergeNode', () => {
  it('creates a node with manual defaults and the seeded display name', () => {
    const node = mergeNode(undefined, probeData(), 'conn-a', 1_000, 1_000, {
      initialDisplayName: '我的服务器',
    });
    expect(node.connectionId).toBe('conn-a');
    expect(node.hostname).toBe('web-01');
    expect(node.roleHint).toBe('web');
    expect(node.displayName).toBe('我的服务器');
    expect(node.nodeType).toBe('');
    expect(node.hidden).toBe(false);
    expect(node.posX).toBeNull();
    expect(node.lastProbeAt).toBe(1_000);
    expect(node.lastProbeStatus).toBe('ok');
  });

  it('keeps every manual field on re-probe while refreshing auto fields', () => {
    const existing = makeNode({
      hostname: 'old-host',
      displayName: '生产 Web',
      nodeType: '虚拟机',
      environment: '生产',
      notes: '勿动',
      hidden: true,
      posX: 120,
      posY: 240,
      lastProbeAt: 1_000,
    });

    const next = mergeNode(
      existing,
      probeData({ hostname: 'new-host', primaryIp: '10.0.0.9', ports: [detectedPort({ port: 5432 })] }),
      'conn-a',
      2_000,
      2_000,
      { status: 'partial', error: '需要 root 权限' },
    );

    expect(next.hostname).toBe('new-host');
    expect(next.primaryIp).toBe('10.0.0.9');
    expect(next.roleHint).toBe('database');

    expect(next.displayName).toBe('生产 Web');
    expect(next.nodeType).toBe('虚拟机');
    expect(next.environment).toBe('生产');
    expect(next.notes).toBe('勿动');
    expect(next.hidden).toBe(true);
    expect(next.posX).toBe(120);
    expect(next.posY).toBe(240);

    expect(next.lastProbeAt).toBe(2_000);
    expect(next.lastProbeStatus).toBe('partial');
    expect(next.lastProbeError).toBe('需要 root 权限');
    expect(next.createdAt).toBe(existing.createdAt);
  });

  it('does not re-seed displayName on an existing node', () => {
    const existing = makeNode({ displayName: '用户改过' });
    const next = mergeNode(existing, probeData(), 'conn-a', 2_000, 2_000, {
      initialDisplayName: '连接名',
    });
    expect(next.displayName).toBe('用户改过');
  });
});

/* ══ detail merges ═════════════════════════════════════════════════════════ */

describe('mergeInterfaces', () => {
  it('preserves manualLabel while refreshing addresses', () => {
    const existing = makeInterface({ ifaceName: 'eth0', mac: 'old', manualLabel: '内网', ipv4Addrs: ['10.0.0.5/24'] });
    const out = mergeInterfaces(
      [existing],
      [detectedInterface({ ifaceName: 'eth0', mac: 'new', ipv4Addrs: ['10.0.0.5/24', '10.0.1.5/24'] })],
      'node-a',
      2_000,
    );

    expect(out.items).toHaveLength(1);
    expect(out.items[0].mac).toBe('new');
    expect(out.items[0].ipv4Addrs).toEqual(['10.0.0.5/24', '10.0.1.5/24']);
    expect(out.items[0].manualLabel).toBe('内网');
    expect(out.items[0].lastSeenAt).toBe(2_000);
    expect(out.updated).toBe(1);
  });

  it('adds new interfaces and marks removed ones', () => {
    const existing = makeInterface({ id: 'i1', ifaceName: 'eth0' });
    const out = mergeInterfaces(
      [existing],
      [detectedInterface({ ifaceName: 'eth1' })],
      'node-a',
      2_000,
    );
    expect(out.added).toBe(1);
    expect(out.missing).toBe(1);
    expect(out.items.find((i) => i.ifaceName === 'eth0')?.missingSince).toBe(2_000);
    expect(out.items.find((i) => i.ifaceName === 'eth1')?.missingSince).toBeNull();
  });

  it('keys rows by node + interface name', () => {
    expect(interfaceNaturalKey({ nodeId: 'n', ifaceName: 'eth0' })).toBe('n|eth0');
  });
});

describe('mergeRoutes', () => {
  it('preserves manualNote and classifies the route type', () => {
    const existing = makeRoute({ destination: '10.0.0.0/24', gateway: '', manualNote: '业务网段' });
    const out = mergeRoutes(
      [existing],
      [detectedRoute({ destination: '10.0.0.0/24', gateway: '', iface: 'eth0', metric: 200 })],
      'node-a',
      2_000,
    );

    expect(out.items).toHaveLength(1);
    expect(out.items[0].routeType).toBe('link');
    expect(out.items[0].metric).toBe(200);
    expect(out.items[0].manualNote).toBe('业务网段');
  });

  it('marks a route that disappeared without losing its note', () => {
    const existing = makeRoute({ id: 'r1', manualNote: '保留我' });
    const out = mergeRoutes([existing], [], 'node-a', 2_000);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].manualNote).toBe('保留我');
    expect(out.items[0].missingSince).toBe(2_000);
    expect(out.missing).toBe(1);
  });
});

describe('mergeFirewalls', () => {
  it('preserves manualNote when the firewall is re-detected', () => {
    const existing = makeFirewall({ fwType: 'firewalld', active: false, manualNote: '别关' });
    const out = mergeFirewalls([existing], detectedFirewall({ active: true }), 'node-a', 2_000);

    expect(out.items[0].active).toBe(true);
    expect(out.items[0].manualNote).toBe('别关');
    expect(out.updated).toBe(1);
  });

  it('marks the stored row as missing when no firewall is reported', () => {
    const existing = makeFirewall({ manualNote: '备注' });
    const out = mergeFirewalls([existing], null, 'node-a', 2_000);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].missingSince).toBe(2_000);
    expect(out.items[0].manualNote).toBe('备注');
  });
});

describe('mergeFirewallRules', () => {
  it('keys by rule hash and preserves manualPurpose', () => {
    const rule = detectedRule();
    const hash = hashRule(rule);
    const existing = makeRule({ ruleHash: hash, manualPurpose: '放行运维 SSH' });

    const out = mergeFirewallRules([existing], [rule], 'node-a', 'fw-a', 2_000);

    expect(out.items).toHaveLength(1);
    expect(out.items[0].manualPurpose).toBe('放行运维 SSH');
    expect(out.items[0].lastSeenAt).toBe(2_000);
    expect(out.added).toBe(0);
    expect(out.updated).toBe(1);
  });

  it('treats reordered/rewritten rules with identical content as the same row', () => {
    const a = detectedRule({ rawRule: '-A INPUT -p tcp --dport 22 -j ACCEPT' });
    const b = detectedRule({ rawRule: '-A INPUT  -p   tcp --dport 22 -j ACCEPT' });
    expect(hashRule(a)).toBe(hashRule(b));
  });

  it('uses the hash emitted by the Rust parser as the natural key', () => {
    const rule = detectedRule({ ruleHash: 'rust-hash-1' });
    expect(resolveRuleHash(rule)).toBe('rust-hash-1');

    // The backend hash must survive a re-probe, otherwise every rule would be
    // re-created instead of updated.
    const first = mergeFirewallRules([], [rule], 'node-a', 'fw-a', 1_000);
    expect(first.items[0].ruleHash).toBe('rust-hash-1');

    const second = mergeFirewallRules(first.items, [rule], 'node-a', 'fw-a', 2_000);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.items).toHaveLength(1);
  });

  it('falls back to the local hash when the backend omits it', () => {
    const rule = detectedRule({ ruleHash: '' });
    expect(resolveRuleHash(rule)).toBe(hashRule(rule));
    expect(mergeFirewallRules([], [rule], 'node-a', 'fw-a', 1_000).items[0].ruleHash).toBe(hashRule(rule));
  });

  it('adds new rules and marks dropped ones', () => {
    const existing = makeRule({ ruleHash: 'gone', manualPurpose: '老规则' });
    const out = mergeFirewallRules([existing], [detectedRule()], 'node-a', 'fw-a', 2_000);

    expect(out.added).toBe(1);
    expect(out.missing).toBe(1);
    expect(out.items.find((r) => r.ruleHash === 'gone')?.manualPurpose).toBe('老规则');
  });
});

describe('mergePorts', () => {
  it('preserves serviceName / purpose / hidden / reachability on a hit', () => {
    const existing = makePort({
      protocol: 'tcp',
      port: 80,
      listenAddr: '0.0.0.0',
      processName: 'nginx-old',
      serviceName: '官网',
      purpose: '对外 HTTP',
      notes: '人工备注',
      tags: ['web', '内网'],
      hidden: true,
      reachability: 'blocked',
      reachabilityAt: 1_500,
    });
    const out = mergePorts(
      [existing],
      [detectedPort({ port: 80, listenAddr: '0.0.0.0', processName: 'nginx', pid: 999 })],
      'node-a',
      2_000,
    );

    expect(out.items).toHaveLength(1);
    expect(out.items[0].processName).toBe('nginx');
    expect(out.items[0].pid).toBe(999);
    expect(out.items[0].serviceName).toBe('官网');
    expect(out.items[0].purpose).toBe('对外 HTTP');
    expect(out.items[0].notes).toBe('人工备注');
    expect(out.items[0].tags).toEqual(['web', '内网']);
    expect(out.items[0].hidden).toBe(true);
    expect(out.items[0].reachability).toBe('blocked');
    expect(out.items[0].reachabilityAt).toBe(1_500);
  });

  it('distinguishes the same port on different listen addresses', () => {
    const existing = makePort({ listenAddr: '0.0.0.0', purpose: '公网' });
    const out = mergePorts(
      [existing],
      [detectedPort({ listenAddr: '127.0.0.1' })],
      'node-a',
      2_000,
    );
    expect(out.added).toBe(1);
    expect(out.items.find((p) => p.listenAddr === '0.0.0.0')?.purpose).toBe('公网');
    expect(out.items.find((p) => p.listenAddr === '127.0.0.1')?.purpose).toBe('');
  });

  it('newly discovered ports start untested and visible', () => {
    const out = mergePorts([], [detectedPort({ port: 3306 })], 'node-a', 2_000);
    expect(out.added).toBe(1);
    expect(out.items[0].reachability).toBe('untested');
    expect(out.items[0].hidden).toBe(false);
    expect(out.items[0].serviceName).toBe('');
  });

  it('keys rows by node + protocol + listen address + port', () => {
    expect(portNaturalKey({ nodeId: 'n', protocol: 'tcp', listenAddr: '0.0.0.0', port: 80 })).toBe(
      'n|tcp|0.0.0.0|80',
    );
  });

  it('never merges the same protocol/port on two different servers', () => {
    const serverA = makePort({ nodeId: 'node-a', port: 8080 });
    const out = mergePorts([serverA], [detectedPort({ port: 8080 })], 'node-b', 2_000);
    expect(out.items).toHaveLength(2);
    expect(out.items.map((port) => port.nodeId).sort()).toEqual(['node-a', 'node-b']);
  });
});

/* ══ topology links ════════════════════════════════════════════════════════ */

describe('buildInterfaceIpIndex', () => {
  it('strips CIDR suffixes and scopes the index to known nodes', () => {
    const nodes = [makeNode({ id: 'node-a' }), makeNode({ id: 'node-b', connectionId: 'conn-b' })];
    const ifaces = [
      makeInterface({ nodeId: 'node-a', ipv4Addrs: ['10.0.0.5/24'], ipv6Addrs: ['fe80::1/64'] }),
      makeInterface({ id: 'i2', nodeId: 'node-b', ipv4Addrs: ['10.0.0.6/24'] }),
      makeInterface({ id: 'i3', nodeId: 'node-unknown', ipv4Addrs: ['10.0.0.9/24'] }),
    ];

    const index = buildInterfaceIpIndex(nodes, ifaces);
    expect(index.get('10.0.0.5')).toBe('node-a');
    expect(index.get('10.0.0.6')).toBe('node-b');
    expect(index.get('fe80::1')).toBe('node-a');
    expect(index.has('10.0.0.9')).toBe(false);
  });
});

describe('inferLinksFromPeers', () => {
  const nodes = [makeNode({ id: 'node-a' }), makeNode({ id: 'node-b', connectionId: 'conn-b' })];
  const index = buildInterfaceIpIndex(nodes, [
    makeInterface({ nodeId: 'node-a', ipv4Addrs: ['10.0.0.5/24'] }),
    makeInterface({ id: 'i2', nodeId: 'node-b', ipv4Addrs: ['10.0.0.6/24'] }),
  ]);

  it('creates an auto link for a peer that matches a probed node', () => {
    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432, processName: 'app' })],
      knownNodes: nodes,
      interfacesIndex: index,
      existingLinks: [],
      now: 2_000,
    });

    expect(out.added).toBe(1);
    expect(out.confirmed).toBe(0);
    const link = out.links[0];
    expect(link.sourceNodeId).toBe('node-a');
    expect(link.targetNodeId).toBe('node-b');
    expect(link.port).toBe(5432);
    expect(link.linkType).toBe('database');
    expect(link.source).toBe('auto');
    expect(link.status).toBe('observed');
    expect(link.evidence).toBe('ss ESTABLISHED 10.0.0.6:5432');
    expect(link.description).toBe('');
    expect(link.firstSeenAt).toBe(2_000);
  });

  it('discards unknown peers — no node and no link is created', () => {
    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [
        detectedPeer({ remoteAddr: '203.0.113.9', remotePort: 443 }),
        detectedPeer({ remoteAddr: '10.0.0.99', remotePort: 22 }),
        detectedPeer({ remoteAddr: '', remotePort: 22 }),
      ],
      knownNodes: nodes,
      interfacesIndex: index,
      existingLinks: [],
      now: 2_000,
    });

    expect(out.links).toHaveLength(0);
    expect(out.added).toBe(0);
    expect(out.confirmed).toBe(0);
  });

  it('ignores a peer that resolves back to the probed node itself', () => {
    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({ remoteAddr: '10.0.0.5', remotePort: 22 })],
      knownNodes: nodes,
      interfacesIndex: index,
      existingLinks: [],
      now: 2_000,
    });
    expect(out.links).toHaveLength(0);
  });

  it('re-confirms an existing auto link without touching manual fields', () => {
    const existing = makeLink({
      id: 'link-1',
      sourceNodeId: 'node-a',
      targetNodeId: 'node-b',
      protocol: 'tcp',
      port: 5432,
      source: 'auto',
      description: '主从复制',
      manualLabel: 'DB 同步',
      hidden: true,
      firstSeenAt: 1_000,
      lastConfirmedAt: 1_000,
    });

    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432 })],
      knownNodes: nodes,
      interfacesIndex: index,
      existingLinks: [existing],
      now: 2_000,
    });

    expect(out.added).toBe(0);
    expect(out.confirmed).toBe(1);
    const link = out.links[0];
    expect(link.id).toBe('link-1');
    expect(link.description).toBe('主从复制');
    expect(link.manualLabel).toBe('DB 同步');
    expect(link.hidden).toBe(true);
    expect(link.source).toBe('auto');
    expect(link.lastConfirmedAt).toBe(2_000);
    expect(link.firstSeenAt).toBe(1_000);
  });

  it('never downgrades a manual link to auto nor overwrites its description', () => {
    const manual: NetworkLink = makeLink({
      id: 'link-manual',
      source: 'manual',
      status: 'active',
      description: '手工标注的专线',
      manualLabel: '专线',
      evidence: '',
      lastConfirmedAt: 1_000,
    });

    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({ remoteAddr: '10.0.0.6', remotePort: 5432 })],
      knownNodes: nodes,
      interfacesIndex: index,
      existingLinks: [manual],
      now: 2_000,
    });

    expect(out.added).toBe(0);
    expect(out.confirmed).toBe(1);
    const link = out.links.find((l) => l.id === 'link-manual');
    expect(link?.source).toBe('manual');
    expect(link?.description).toBe('手工标注的专线');
    expect(link?.manualLabel).toBe('专线');
    expect(link?.evidence).toBe('');
    expect(link?.status).toBe('observed');
    expect(link?.lastConfirmedAt).toBe(2_000);
  });

  it('normalizes bracketed IPv6 peers and de-duplicates within one run', () => {
    const v6Index = buildInterfaceIpIndex(nodes, [
      makeInterface({ nodeId: 'node-b', ipv6Addrs: ['2001:db8::6/64'] }),
    ]);
    const out = inferLinksFromPeers({
      nodeId: 'node-a',
      peers: [
        detectedPeer({ remoteAddr: '[2001:db8::6]', remotePort: 22 }),
        detectedPeer({ remoteAddr: '2001:db8::6', remotePort: 22 }),
      ],
      knownNodes: nodes,
      interfacesIndex: v6Index,
      existingLinks: [],
      now: 2_000,
    });

    expect(out.added).toBe(1);
    expect(out.links[0].linkType).toBe('ssh');
  });

  it('builds a stable natural key', () => {
    expect(linkNaturalKey({ sourceNodeId: 'a', targetNodeId: 'b', protocol: 'tcp', port: null })).toBe(
      'a|b|tcp|',
    );
  });
});

describe('port-level topology links', () => {
  const interfacesIndex = new Map([
    ['10.10.1.20', 'node-a'],
    ['10.10.1.21', 'node-b'],
  ]);
  const currentPorts = [
    makePort({ id: 'port-a8080', nodeId: 'node-a', port: 8080, processName: 'app', pid: 10 }),
  ];
  const allPorts = [
    ...currentPorts,
    makePort({ id: 'port-b3306', nodeId: 'node-b', port: 3306, processName: 'postgres', pid: 20 }),
  ];

  it('maps an outbound ephemeral socket to the service port of the same process', () => {
    const result = inferPortLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({
        remoteAddr: '10.10.1.21',
        remotePort: 3306,
        localPort: 45678,
        processName: 'app',
        processPid: 10,
      })],
      nodePorts: currentPorts,
      allPorts,
      interfacesIndex,
      existingPortLinks: [],
      now: 2_000,
    });

    expect(result.added).toBe(1);
    expect(result.links[0]).toMatchObject({
      sourceNodeId: 'node-a',
      sourcePortId: 'port-a8080',
      sourcePort: 8080,
      targetNodeId: 'node-b',
      targetPortId: 'port-b3306',
      targetPort: 3306,
      status: 'active',
      source: 'auto',
    });
    expect(result.links[0].sourceProtocol).toBe('tcp');
    expect(result.links[0].targetProtocol).toBe('tcp');
  });

  it('keeps an inbound listening socket directed remote → current, including unknown IPs', () => {
    const serverPorts = [makePort({ id: 'port-b8080', nodeId: 'node-b', port: 8080, processName: 'app' })];
    const result = inferPortLinksFromPeers({
      nodeId: 'node-b',
      peers: [detectedPeer({ remoteAddr: '203.0.113.9', remotePort: 51000, localPort: 8080 })],
      nodePorts: serverPorts,
      allPorts: serverPorts,
      interfacesIndex,
      existingPortLinks: [],
      now: 2_000,
    });

    expect(result.added).toBe(1);
    expect(result.links[0]).toMatchObject({
      sourceNodeId: null,
      sourcePortId: null,
      sourceIp: '203.0.113.9',
      sourcePort: 51000,
      targetNodeId: 'node-b',
      targetPortId: 'port-b8080',
      targetPort: 8080,
      status: 'active',
    });
  });

  it('re-confirms a matching manual relation without changing its status or annotations', () => {
    const existing = makePortLink({
      sourceNodeId: 'node-a',
      sourcePortId: 'port-a8080',
      sourcePort: 8080,
      targetNodeId: 'node-b',
      targetPortId: 'port-b3306',
      targetPort: 3306,
      status: 'unknown',
      source: 'manual',
      description: '业务专线',
      manualLabel: '订单库',
      hidden: true,
    });
    const result = inferPortLinksFromPeers({
      nodeId: 'node-a',
      peers: [detectedPeer({ remoteAddr: '10.10.1.21', remotePort: 3306, localPort: 45678, processName: 'app', processPid: 10 })],
      nodePorts: currentPorts,
      allPorts,
      interfacesIndex,
      existingPortLinks: [existing],
      now: 2_000,
    });

    expect(result.added).toBe(0);
    expect(result.confirmed).toBe(1);
    expect(result.links[0]).toMatchObject({
      id: existing.id,
      status: 'unknown',
      source: 'manual',
      description: '业务专线',
      manualLabel: '订单库',
      hidden: true,
      lastConfirmedAt: 2_000,
    });
  });

  it('resolves unknown source and target endpoints after that server is probed', () => {
    const danglingTarget = makePortLink({
      id: 'plink-target',
      sourceNodeId: 'node-a',
      sourcePortId: 'port-a8080',
      sourcePort: 8080,
      targetNodeId: null,
      targetPortId: null,
      targetIp: '10.10.1.21',
      targetPort: 3306,
    });
    const danglingSource = makePortLink({
      id: 'plink-source',
      sourceNodeId: null,
      sourcePortId: null,
      sourceIp: '10.10.1.21',
      sourcePort: 8080,
      targetNodeId: 'node-b',
      targetPortId: 'port-b3306',
      targetPort: 3306,
    });
    const result = resolvePortLinkTargets({
      nodeId: 'node-b',
      nodePorts: [makePort({ id: 'port-b3306', nodeId: 'node-b', port: 3306 })],
      interfacesIndex,
      existingPortLinks: [danglingTarget, danglingSource],
      now: 2_000,
    });

    expect(result.resolved).toBeGreaterThanOrEqual(2);
    expect(result.links.find((link) => link.id === 'plink-target')).toMatchObject({
      targetNodeId: 'node-b',
      targetPortId: 'port-b3306',
      targetIp: null,
    });
    expect(result.links.find((link) => link.id === 'plink-source')).toMatchObject({
      sourceNodeId: 'node-b',
      sourcePortId: null,
      sourceIp: null,
    });
  });
});
