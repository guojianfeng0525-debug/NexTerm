import { describe, expect, it } from 'vitest';
import {
  isExternallyBoundListenAddress,
  isLoopbackAddress,
  isServerInterfaceAddress,
  isServerPeerAddress,
} from '../address-scope';

describe('address scope', () => {
  it('excludes loopback and container/pod addresses from server identity', () => {
    expect(isServerPeerAddress('127.0.0.1')).toBe(false);
    expect(isServerPeerAddress('::1')).toBe(false);
    expect(isServerPeerAddress('172.21.0.3')).toBe(false);
    expect(isServerPeerAddress('10.244.1.5')).toBe(false);
    expect(isServerPeerAddress('10.96.0.10')).toBe(false);
    expect(isServerPeerAddress('203.0.113.9')).toBe(true);
  });

  it('excludes container interfaces even when their range overlaps a server network', () => {
    expect(isServerInterfaceAddress('172.17.0.2/16', 'docker0')).toBe(false);
    expect(isServerInterfaceAddress('10.244.1.5/24', 'cni0')).toBe(false);
    expect(isServerInterfaceAddress('192.168.50.9/24', 'eth0')).toBe(true);
  });

  it('keeps wildcard and exact server listeners but hides loopback listeners', () => {
    const serverAddresses = [{ address: '192.168.50.9/24', ifaceName: 'eth0' }];
    expect(isExternallyBoundListenAddress('0.0.0.0', serverAddresses)).toBe(true);
    expect(isExternallyBoundListenAddress('::', serverAddresses)).toBe(true);
    expect(isExternallyBoundListenAddress('192.168.50.9', serverAddresses)).toBe(true);
    expect(isExternallyBoundListenAddress('127.0.0.1', serverAddresses)).toBe(false);
    expect(isExternallyBoundListenAddress('172.17.0.2', serverAddresses)).toBe(false);
  });

  it('treats empty and loopback values as non-servers', () => {
    expect(isLoopbackAddress('')).toBe(true);
    expect(isLoopbackAddress('127.0.0.11')).toBe(true);
  });
});
