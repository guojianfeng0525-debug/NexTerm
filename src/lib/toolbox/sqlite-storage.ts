import type { SQLiteConnectionProfile } from "../database/sqlite-profile";
import { invoke } from "@tauri-apps/api/core";
import { rowClear, rowList, rowUpsert } from "./db";

const cache: SQLiteConnectionProfile[] = [];
let initialized = false;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fromRow(row: Record<string, unknown>): SQLiteConnectionProfile {
  const environment = row.environment === "production" || row.environment === "test" ? row.environment : "development";
  return {
    id: stringValue(row.id), name: stringValue(row.name), providerId: "sqlite", environment,
    group: typeof row.group_name === "string" ? row.group_name : undefined,
    createdAt: Number(row.created_at ?? Date.now()), updatedAt: Number(row.updated_at ?? Date.now()),
    providerConfig: { filePath: stringValue(row.file_path), readOnly: Boolean(row.read_only) },
  };
}

function toRow(profile: SQLiteConnectionProfile): Record<string, unknown> {
  return {
    id: profile.id, name: profile.name, group_name: profile.group ?? null, environment: profile.environment,
    file_path: profile.providerConfig.filePath, read_only: Number(profile.providerConfig.readOnly),
    created_at: profile.createdAt, updated_at: profile.updatedAt,
  };
}

function notify(): void {
  window.dispatchEvent(new CustomEvent("nexterm:toolbox-changed", { detail: { kind: "sqlite" } }));
}

export async function hydrateSqliteConnections(): Promise<void> {
  const rows = await rowList("database_sqlite_connections");
  cache.splice(0, cache.length, ...rows.map(fromRow));
  initialized = true;
}

export const SqliteConnectionsStorage = {
  initialized: () => initialized,
  load: (): SQLiteConnectionProfile[] => [...cache],
  async upsert(profile: SQLiteConnectionProfile): Promise<boolean> {
    if (!(await rowUpsert("database_sqlite_connections", toRow(profile)))) return false;
    const index = cache.findIndex((item) => item.id === profile.id);
    if (index === -1) cache.push(profile); else cache[index] = profile;
    notify();
    return true;
  },
  async remove(id: string): Promise<boolean> {
    try {
      await invoke("row_delete", { table: "database_sqlite_connections", key: id });
    } catch {
      return false;
    }
    const index = cache.findIndex((item) => item.id === id);
    if (index !== -1) cache.splice(index, 1);
    notify();
    return true;
  },
  async replace(items: SQLiteConnectionProfile[]): Promise<void> {
    cache.splice(0, cache.length, ...items);
    await rowClear("database_sqlite_connections");
    await Promise.all(items.map((item) => rowUpsert("database_sqlite_connections", toRow(item))));
    notify();
  },
};
