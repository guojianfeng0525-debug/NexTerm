/**
 * Address-scope rules for topology rendering.
 *
 * NexTerm is a server workspace, not a container inspector. The topology only
 * keeps the server's own addresses, connections between those servers, and
 * listener sockets that can be reached from a server network. Loopback and
 * container/Kubernetes infrastructure addresses are deliberately excluded.
 */

/** Strip CIDR/zone syntax and IPv4-mapped IPv6 wrapping. */
export function normalizeScopeAddress(value: string): string {
  let out = (value ?? '').trim();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const slash = out.indexOf('/');
  if (slash !== -1) out = out.slice(0, slash);
  const zone = out.indexOf('%');
  if (zone !== -1) out = out.slice(0, zone);
  if (out.toLowerCase().startsWith('::ffff:')) out = out.slice('::ffff:'.length);
  return out.trim();
}

function ipv4ToInt(value: string): number | null {
  const parts = normalizeScopeAddress(value).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    out = (out * 256) + byte;
  }
  return out;
}

export function isIpv4InCidr(value: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const address = ipv4ToInt(value);
  const base = ipv4ToInt(network ?? '');
  const prefix = Number(prefixText);
  if (address === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((base & mask) >>> 0);
}

export function isLoopbackAddress(value: string): boolean {
  const ip = normalizeScopeAddress(value);
  if (!ip) return true;
  if (ip === '::1' || ip.toLowerCase() === 'localhost') return true;
  return isIpv4InCidr(ip, '127.0.0.0/8');
}

export function isUnspecifiedAddress(value: string): boolean {
  const ip = normalizeScopeAddress(value);
  return ip === '0.0.0.0' || ip === '::' || ip === '*';
}

/** Interface names used by common container runtimes, CNI plugins and pod networks. */
function isContainerInterfaceName(name: string): boolean {
  const value = (name ?? '').trim().toLowerCase();
  if (!value) return false;
  return /^(docker\d*|br-[0-9a-f]+|veth.*|cni.*|cali.*|tunl0|flannel.*|kube-ipvs0|cilium.*|vxlan\.calico|weave.*|podman.*|virbr.*)$/.test(value);
}

/** Well-known pod/service ranges which must never become server assets. */
function isKnownContainerRange(value: string): boolean {
  const ip = normalizeScopeAddress(value);
  if (isLoopbackAddress(ip)) return true;
  return [
    '10.42.0.0/16', // k3s pods
    '10.43.0.0/16', // k3s services
    '10.96.0.0/12', // Kubernetes default service CIDR
    '10.244.0.0/16', // Flannel default pod CIDR
    '100.64.0.0/10', // Cilium / carrier-grade cluster range
    '172.16.0.0/12', // Docker/Podman default bridge pool
    '169.254.0.0/16', // link-local / cloud metadata
    'fe80::/10', // IPv6 link-local
    'fc00::/7', // IPv6 unique-local container networks
  ].some(cidr => ip.includes(':') ? isIpv6ScopeOnly(ip) : isIpv4InCidr(ip, cidr));
}

function isIpv6ScopeOnly(ip: string): boolean {
  const value = ip.toLowerCase();
  return value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
    || value.startsWith('fd') || value === '::1';
}

/**
 * An address is a server address when its owning interface is not a container
 * bridge/pod link and the address is not loopback/link-local/pod-service space.
 */
export function isServerInterfaceAddress(value: string, ifaceName = ''): boolean {
  const ip = normalizeScopeAddress(value);
  if (!ip || isLoopbackAddress(ip) || isUnspecifiedAddress(ip)) return false;
  if (isContainerInterfaceName(ifaceName)) return false;
  if (isKnownContainerRange(ip)) return false;
  return true;
}

/** A peer seen on an actual server address may become a topology endpoint. */
export function isServerPeerAddress(value: string): boolean {
  const ip = normalizeScopeAddress(value);
  return Boolean(ip) && !isKnownContainerRange(ip);
}

/**
 * A listener is externally interesting only for wildcard sockets or an exact
 * server address. This excludes `127.0.0.1:6379`, `127.0.0.11:...`, Docker
 * bridge sockets and IPv6 link-local listeners.
 */
export function isExternallyBoundListenAddress(
  listenAddr: string,
  serverAddresses: readonly { address: string; ifaceName?: string }[] = [],
): boolean {
  const ip = normalizeScopeAddress(listenAddr);
  if (isUnspecifiedAddress(ip)) return true;
  if (!isServerPeerAddress(ip)) return false;
  if (serverAddresses.length === 0) return true;
  return serverAddresses.some(item =>
    normalizeScopeAddress(item.address) === ip && isServerInterfaceAddress(item.address, item.ifaceName ?? ''));
}

export const SERVER_GROUP_ROOT = 'All Connections';
