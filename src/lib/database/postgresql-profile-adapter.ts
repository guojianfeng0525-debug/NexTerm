import type { DatabaseConnectionProfile } from "./profile-types";

export type PostgreSQLSslMode =
  | "disable"
  | "allow"
  | "prefer"
  | "require"
  | "verify-ca"
  | "verify-full";

export type PostgreSQLSshAuthMethod = "password" | "privateKey";

export interface PostgreSQLConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password?: string;
  readonly defaultSchema?: string;
  readonly readOnly: boolean;
  readonly autoCommit: boolean;
  readonly sslMode: PostgreSQLSslMode;
  readonly sslRootCert?: string;
  readonly sslClientCert?: string;
  readonly sslClientKey?: string;
  readonly sslKeyPassphrase?: string;
  readonly sshEnabled: boolean;
  readonly sshConnectionId?: string;
  readonly sshHost?: string;
  readonly sshPort?: number;
  readonly sshUsername?: string;
  readonly sshAuthMethod?: PostgreSQLSshAuthMethod;
  readonly sshPassword?: string;
  readonly sshPrivateKey?: string;
  readonly sshPrivateKeyPath?: string;
  readonly sshPrivateKeyPassphrase?: string;
  readonly sshHostKeyFingerprint?: string;
}

export type PostgreSQLConnectionProfile = DatabaseConnectionProfile<
  "postgresql",
  PostgreSQLConnectionConfig
>;

/** The legacy SQLite/archive shape. Keep this exact while persistence remains frozen. */
export interface PostgreSQLPersistedProfile {
  readonly id: string;
  readonly name: string;
  readonly group?: string;
  readonly environment: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password?: string;
  readonly defaultSchema?: string;
  readonly readOnly: boolean;
  readonly autoCommit: boolean;
  readonly sslMode: PostgreSQLSslMode;
  readonly sslRootCert?: string;
  readonly sslClientCert?: string;
  readonly sslClientKey?: string;
  readonly sslKeyPassphrase?: string;
  readonly sshEnabled: boolean;
  readonly sshConnectionId?: string;
  readonly sshHost?: string;
  readonly sshPort?: number;
  readonly sshUsername?: string;
  readonly sshAuthMethod?: PostgreSQLSshAuthMethod;
  readonly sshPassword?: string;
  readonly sshPrivateKey?: string;
  readonly sshPrivateKeyPath?: string;
  readonly sshPrivateKeyPassphrase?: string;
  readonly sshHostKeyFingerprint?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function adaptPostgreSQLPersistedProfile(
  profile: PostgreSQLPersistedProfile,
): PostgreSQLConnectionProfile {
  const {
    id,
    name,
    group,
    environment,
    createdAt,
    updatedAt,
    ...providerConfig
  } = profile;
  return {
    id,
    name,
    providerId: "postgresql",
    group,
    environment,
    createdAt,
    updatedAt,
    providerConfig,
  };
}

export function toPostgreSQLPersistedProfile(
  profile: PostgreSQLConnectionProfile,
): PostgreSQLPersistedProfile {
  return {
    id: profile.id,
    name: profile.name,
    group: profile.group,
    environment: profile.environment,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...profile.providerConfig,
  };
}
