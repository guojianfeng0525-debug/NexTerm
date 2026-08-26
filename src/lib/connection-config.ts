/**
 * Mapping helpers between the persisted connection model (ConnectionData)
 * and the dialog form model (ConnectionConfig).
 */
import type { ConnectionData } from './connection-storage';
import type { ConnectionConfig } from '../components/connection-dialog';

/**
 * Build a ConnectionConfig from a persisted ConnectionData.
 *
 * Carries every field the edit dialog can display — including the proxy,
 * jump host and default-directory settings — so that saved config survives
 * a round-trip through storage and is shown again when the connection is
 * edited. Dropping any field here silently erases it from the edit dialog
 * (and a later save would overwrite the stored value with an empty one).
 */
export function toConnectionConfig(data: ConnectionData): ConnectionConfig {
  return {
    id: data.id,
    name: data.name,
    protocol: data.protocol as ConnectionConfig['protocol'],
    host: data.host,
    port: data.port,
    username: data.username,
    description: data.description,
    authMethod: data.authMethod || 'password',
    password: data.password,
    privateKeyPath: data.privateKeyPath,
    passphrase: data.passphrase,
    ftpsEnabled: data.ftpsEnabled,
    domain: data.domain,
    rdpResolution: data.rdpResolution as ConnectionConfig['rdpResolution'],
    vncColorDepth: data.vncColorDepth as ConnectionConfig['vncColorDepth'],
    proxyType: data.proxyType ?? 'none',
    proxyHost: data.proxyHost,
    proxyPort: data.proxyPort ?? 8080,
    proxyUsername: data.proxyUsername,
    proxyPassword: data.proxyPassword,
    jumpHost: data.jumpHost,
    jumpPort: data.jumpPort ?? 22,
    jumpUsername: data.jumpUsername,
    jumpPassword: data.jumpPassword,
    jumpUseKey: data.jumpUseKey,
    hostKeyFingerprint: data.hostKeyFingerprint,
    jumpHostKeyFingerprint: data.jumpHostKeyFingerprint,
    defaultDirectory: data.defaultDirectory,
    terminalEncoding: data.terminalEncoding,
    terminalStartupMode: data.terminalStartupMode,
    keepAlive: data.keepAlive,
    keepAliveInterval: data.keepAliveInterval,
    serverAliveCountMax: data.serverAliveCountMax,
  };
}
