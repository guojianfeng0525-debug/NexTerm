/**
 * Builds the `ssh_connect` invoke request payload.
 *
 * The connection dialog stores advanced SSH options (compression, keepalive)
 * and proxy options on ConnectionConfig / ConnectionData, but the backend only
 * applies them if they are actually sent across IPC. This helper centralises
 * the mapping so every connect path (dialog, quick connect, restore, duplicate,
 * reconnect) carries the same fields.
 */

/** Subset of ConnectionConfig / ConnectionData that the SSH connect request needs. */
export interface SshConnectRequestSource {
  host: string;
  port: number;
  username: string;
  authMethod?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  compression?: boolean;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  serverAliveCountMax?: number;
  proxyType?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string;
  jumpUseKey?: boolean;
  hostKeyFingerprint?: string;
  jumpHostKeyFingerprint?: string;
}

export interface SshConnectRequest {
  connection_id: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  password: string | null;
  key_path: string | null;
  passphrase: string | null;
  compression: boolean;
  keepalive_enabled: boolean;
  keepalive_interval: number | null;
  keepalive_max: number | null;
  proxy_type: string;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_password: string | null;
  jump_host: string | null;
  jump_port: number | null;
  jump_username: string | null;
  jump_password: string | null;
  jump_use_key: boolean;
  host_key_fingerprint: string | null;
  jump_host_key_fingerprint: string | null;
}

/** Standalone SFTP accepts the same authentication and jump-host fields. */
export interface SftpConnectRequest {
  connection_id: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  password: string | null;
  key_path: string | null;
  passphrase: string | null;
  jump_host: string | null;
  jump_port: number | null;
  jump_username: string | null;
  jump_password: string | null;
  jump_use_key: boolean;
  host_key_fingerprint: string | null;
  jump_host_key_fingerprint: string | null;
}

/**
 * Build the `ssh_connect` request payload from a connection config.
 *
 * Defaults mirror the connection dialog UI: compression and keepalive enabled
 * (60 s interval, 3 max), no proxy. When keepalive or proxy is disabled the
 * corresponding fields are sent as null so the backend disables them.
 */
export function buildSshConnectRequest(
  connectionId: string,
  source: SshConnectRequestSource,
): SshConnectRequest {
  const keepAlive = source.keepAlive !== false;
  const proxyType = source.proxyType ?? 'none';
  const proxyEnabled = proxyType !== 'none';
  const jumpEnabled = !!source.jumpHost?.trim();

  return {
    connection_id: connectionId,
    host: source.host,
    port: source.port || 22,
    username: source.username,
    auth_method: source.authMethod || 'password',
    // Nullish coalescing so an intentionally empty password stays `""` instead
    // of becoming `null` (the backend rejects `null` with "Password required").
    password: source.password ?? null,
    key_path: source.privateKeyPath || null,
    passphrase: source.passphrase || null,
    compression: source.compression !== false,
    keepalive_enabled: keepAlive,
    keepalive_interval: keepAlive ? (source.keepAliveInterval ?? 60) : null,
    keepalive_max: keepAlive ? (source.serverAliveCountMax ?? 3) : null,
    proxy_type: proxyType,
    proxy_host: proxyEnabled ? (source.proxyHost || null) : null,
    proxy_port: proxyEnabled ? (source.proxyPort ?? null) : null,
    proxy_username: proxyEnabled ? (source.proxyUsername || null) : null,
    proxy_password: proxyEnabled ? (source.proxyPassword || null) : null,
    jump_host: jumpEnabled ? (source.jumpHost || null) : null,
    jump_port: jumpEnabled ? (source.jumpPort ?? 22) : null,
    jump_username: jumpEnabled ? (source.jumpUsername || null) : null,
    jump_password: jumpEnabled && !source.jumpUseKey ? (source.jumpPassword ?? null) : null,
    jump_use_key: jumpEnabled && !!source.jumpUseKey,
    host_key_fingerprint: source.hostKeyFingerprint || null,
    jump_host_key_fingerprint: jumpEnabled ? (source.jumpHostKeyFingerprint || null) : null,
  };
}

/** Build an SFTP request so every connect path retains jump-host settings. */
export function buildSftpConnectRequest(
  connectionId: string,
  source: SshConnectRequestSource,
): SftpConnectRequest {
  const jumpEnabled = !!source.jumpHost?.trim();

  return {
    connection_id: connectionId,
    host: source.host,
    port: source.port || 22,
    username: source.username,
    auth_method: source.authMethod || 'password',
    password: source.password ?? null,
    key_path: source.privateKeyPath || null,
    passphrase: source.passphrase || null,
    jump_host: jumpEnabled ? (source.jumpHost || null) : null,
    jump_port: jumpEnabled ? (source.jumpPort ?? 22) : null,
    jump_username: jumpEnabled ? (source.jumpUsername || null) : null,
    jump_password: jumpEnabled && !source.jumpUseKey ? (source.jumpPassword ?? null) : null,
    jump_use_key: jumpEnabled && !!source.jumpUseKey,
    host_key_fingerprint: source.hostKeyFingerprint || null,
    jump_host_key_fingerprint: jumpEnabled ? (source.jumpHostKeyFingerprint || null) : null,
  };
}
