import { describe, expect, it } from 'vitest';
import { evaluatePortFirewall, filterNetworkPorts, getPortLinkStats } from '../port-insights';
import { makeFirewall, makePort, makePortLink, makeRule } from './fixtures';

describe('evaluatePortFirewall', () => {
  it('reports an explicit allow rule separately from client reachability', () => {
    const port = makePort({ port: 3306, protocol: 'tcp', reachability: 'blocked' });
    const firewall = makeFirewall({ active: true, defaultInPolicy: 'drop' });
    const rule = makeRule({ action: 'ACCEPT', protocol: 'tcp', dstPort: '3306' });
    expect(evaluatePortFirewall(port, firewall, [rule])).toBe('allowed');
  });

  it('does not treat a loopback listener as network-wide firewall access', () => {
    const port = makePort({ listenAddr: '127.0.0.1:3306', port: 3306 });
    const firewall = makeFirewall({ active: true, defaultInPolicy: 'accept' });
    expect(evaluatePortFirewall(port, firewall, [])).toBe('allowed');
    // Reachability remains a separate field; listening/allow never overwrite it.
    expect(port.reachability).toBe('untested');
  });

  it('returns unknown for an unresolved firewalld service alias', () => {
    const port = makePort({ port: 22 });
    const firewall = makeFirewall({ active: true, defaultInPolicy: '' });
    const rule = makeRule({ action: 'accept', protocol: '', dstPort: 'ssh' });
    expect(evaluatePortFirewall(port, firewall, [rule])).toBe('unknown');
  });
});

describe('port filtering and link counts', () => {
  const webA = makePort({ id: 'a8080', nodeId: 'a', port: 8080, serviceName: 'gateway', purpose: 'web' });
  const dbA = makePort({ id: 'a3306', nodeId: 'a', port: 3306, serviceName: 'mysql' });
  const webB = makePort({ id: 'b8080', nodeId: 'b', port: 8080, serviceName: 'api' });
  const links = [
    makePortLink({ sourceNodeId: 'a', sourcePortId: 'a8080', sourcePort: 8080, targetNodeId: 'b', targetPortId: 'b8080', targetPort: 8080 }),
  ];

  it('counts inbound and outbound relations for one exact server port', () => {
    expect(getPortLinkStats('a', 'a8080', links)).toEqual({ inbound: 0, outbound: 1, statuses: ['active'] });
    expect(getPortLinkStats('b', 'b8080', links)).toEqual({ inbound: 1, outbound: 0, statuses: ['active'] });
    expect(getPortLinkStats('a', 'a3306', links)).toEqual({ inbound: 0, outbound: 0, statuses: [] });
  });

  it('filters by service/purpose and exact IP:PORT without mixing servers', () => {
    const base = {
      reachability: 'all' as const,
      connection: 'all' as const,
      host: '',
      hostByNode: { a: '10.10.1.20', b: '10.10.1.21' },
    };
    expect(filterNetworkPorts([webA, dbA, webB], links, { ...base, protocol: 'all', search: 'gateway' }).map((port) => port.id))
      .toEqual(['a8080']);
    expect(filterNetworkPorts([webA, dbA, webB], links, { ...base, protocol: 'all', search: '10.10.1.20:8080' }).map((port) => port.id))
      .toEqual(['a8080']);
    expect(filterNetworkPorts([webA, dbA, webB], links, { ...base, protocol: 'all', search: '10.10.1.21:8080' }).map((port) => port.id))
      .toEqual(['b8080']);
  });
});
