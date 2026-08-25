import { describe, expect, it } from "vitest";
import {
  adaptPostgreSQLPersistedProfile,
  toPostgreSQLPersistedProfile,
  type PostgreSQLPersistedProfile,
} from "@/lib/database/postgresql-profile-adapter";
import type { DatabaseConnectionProfile } from "@/lib/database/profile-types";
import type { SQLiteConnectionProfile } from "@/lib/database/sqlite-profile";

const persisted: PostgreSQLPersistedProfile = {
  id: "postgres-existing-id",
  name: "Existing PostgreSQL",
  group: "Production",
  environment: "production",
  host: "db.example.test",
  port: 5432,
  database: "app",
  username: "app_user",
  password: "secret",
  defaultSchema: "app",
  readOnly: true,
  autoCommit: false,
  sslMode: "verify-full",
  sslRootCert: "root certificate",
  sslClientCert: "client certificate",
  sslClientKey: "client key",
  sslKeyPassphrase: "tls secret",
  sshEnabled: true,
  sshConnectionId: "jump-profile",
  sshHost: "jump.example.test",
  sshPort: 22,
  sshUsername: "jump_user",
  sshAuthMethod: "privateKey",
  sshPassword: "jump secret",
  sshPrivateKey: "private key",
  sshPrivateKeyPath: "~/.ssh/id_ed25519",
  sshPrivateKeyPassphrase: "key secret",
  sshHostKeyFingerprint: "SHA256:trusted",
  createdAt: 1,
  updatedAt: 2,
};

describe("shared database connection profile", () => {
  it("adapts an existing PostgreSQL persisted profile without changing fields", () => {
    const profile = adaptPostgreSQLPersistedProfile(persisted);

    expect(profile.providerId).toBe("postgresql");
    expect(profile.id).toBe(persisted.id);
    expect(profile.providerConfig).toMatchObject({
      host: persisted.host,
      readOnly: true,
      sslMode: "verify-full",
      sshHostKeyFingerprint: "SHA256:trusted",
    });
    expect(toPostgreSQLPersistedProfile(profile)).toEqual(persisted);
  });

  it("preserves absent optional fields through the adapter", () => {
    const profile = adaptPostgreSQLPersistedProfile({
      ...persisted,
      group: undefined,
      password: undefined,
      sshConnectionId: undefined,
      sslClientKey: undefined,
    });

    expect(toPostgreSQLPersistedProfile(profile)).toEqual({
      ...persisted,
      group: undefined,
      password: undefined,
      sshConnectionId: undefined,
      sslClientKey: undefined,
    });
  });

  it("does not require network fields in the shared envelope", () => {
    const sqliteLike: DatabaseConnectionProfile<"sqlite", { readonly filename: string }> = {
      id: "local-file",
      name: "Local",
      providerId: "sqlite",
      environment: "development",
      createdAt: 1,
      updatedAt: 1,
      providerConfig: { filename: "/tmp/local.db" },
    };

    expect(sqliteLike.providerConfig.filename).toBe("/tmp/local.db");
  });

  it("represents SQLite profiles with only file-backed provider settings", () => {
    const profile: SQLiteConnectionProfile = {
      id: "sqlite-local",
      name: "Local database",
      providerId: "sqlite",
      environment: "test",
      createdAt: 1,
      updatedAt: 2,
      providerConfig: { filePath: "/fixtures/local.db", readOnly: true },
    };

    expect(profile.providerConfig).toEqual({ filePath: "/fixtures/local.db", readOnly: true });
    expect("host" in profile.providerConfig).toBe(false);
    expect("sshEnabled" in profile.providerConfig).toBe(false);
    expect("sslMode" in profile.providerConfig).toBe(false);
  });
});
