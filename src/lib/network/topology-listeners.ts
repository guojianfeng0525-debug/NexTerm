import { normalizeScopeAddress } from './address-scope';
import type { NetworkPort } from './topology-types';

export function isListenerState(state: string): boolean {
  return ['LISTEN', 'LISTENING', 'UNCONN'].includes((state ?? '').trim().toUpperCase());
}

type ListenerEndpoint = Pick<NetworkPort, 'protocol' | 'port' | 'listenAddr' | 'state'> & { missingSince?: number | null };

/** IPv4-mapped local socket evidence also proves use of an IPv6 listener. */
export function listenerMatches(port: ListenerEndpoint, protocol: string, number: number | null, address: string): boolean {
  if (port.missingSince != null || !isListenerState(port.state)
    || port.protocol !== protocol || port.port !== number) return false;
  const bind = normalizeScopeAddress(port.listenAddr);
  const ip = normalizeScopeAddress(address);
  return Boolean(ip) && (bind === ip || bind === '*'
    || (bind === '0.0.0.0' && !ip.includes(':'))
    || (bind === '::' && address.includes(':')));
}

/** Prefer an exact bind, otherwise a unique compatible wildcard; never guess. */
export function selectListener(
  ports: readonly NetworkPort[], nodeId: string, protocol: string, number: number, address?: string | null,
): NetworkPort | undefined {
  const eligible = ports.filter(port => port.nodeId === nodeId && port.protocol === protocol
    && port.port === number && port.missingSince === null && isListenerState(port.state));
  if (!address) return eligible.length === 1 ? eligible[0] : undefined;
  const ip = normalizeScopeAddress(address);
  if (!ip) return undefined;
  const exact = eligible.filter(port => normalizeScopeAddress(port.listenAddr) === ip);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const wildcard = eligible.filter(port => listenerMatches(port, protocol, number, address));
  return wildcard.length === 1 ? wildcard[0] : undefined;
}
