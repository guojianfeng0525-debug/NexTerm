import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestIpc } from "./helpers/test-ipc";
import { setupAppLock } from "../toolbox/app-lock";
import {
  hydrateMySQLConnections,
  MySQLConnectionsStorage,
  resetMySQLConnections,
} from "../toolbox/mysql-storage";
import type { MySQLConnectionProfile } from "../database/mysql-profile";

const ipc = createTestIpc();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

const profile: MySQLConnectionProfile = {
  id: "mysql-1",
  name: "Fixture",
  providerId: "mysql",
  environment: "test",
  createdAt: 1,
  updatedAt: 1,
  providerConfig: {
    host: "127.0.0.1",
    port: 3306,
    database: "nexterm_e2e",
    username: "nexterm_e2e",
    password: "isolated-fixture-secret",
  },
};

beforeEach(async () => {
  for (const key of Object.keys(ipc.DB)) delete ipc.DB[key];
  resetMySQLConnections();
  await setupAppLock("test-pass");
  await hydrateMySQLConnections();
});

describe("MySQL profile storage", () => {
  it("persists CRUD mutations first and restores encrypted secrets with stable IDs", async () => {
    await expect(MySQLConnectionsStorage.upsert(profile)).resolves.toBe(true);
    const raw = ipc.DB.database_mysql_connections?.[0];
    expect(String(raw?.password)).not.toContain("isolated-fixture-secret");
    expect(raw).toMatchObject({ id: "mysql-1", host: "127.0.0.1", port: 3306 });

    const edited = { ...profile, name: "Fixture edited", updatedAt: 2 };
    await expect(MySQLConnectionsStorage.upsert(edited)).resolves.toBe(true);
    expect(MySQLConnectionsStorage.load()).toEqual([edited]);

    resetMySQLConnections();
    await hydrateMySQLConnections();
    expect(MySQLConnectionsStorage.load()).toEqual([edited]);

    await expect(MySQLConnectionsStorage.remove(edited.id)).resolves.toBe(true);
    expect(MySQLConnectionsStorage.load()).toEqual([]);
    expect(ipc.DB.database_mysql_connections).toEqual([]);
  });

  it("does not mutate the in-memory profile when persistence fails", async () => {
    (ipc.invokeMock as unknown as { mockRejectedValueOnce: (error: Error) => void })
      .mockRejectedValueOnce(new Error("SQLite unavailable"));

    await expect(MySQLConnectionsStorage.upsert(profile)).resolves.toBe(false);
    expect(MySQLConnectionsStorage.load()).toEqual([]);
  });
});
