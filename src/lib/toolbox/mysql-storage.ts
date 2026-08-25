/** SQLite-backed MySQL profiles. Passwords are encrypted per field. */
import type { MySQLConnectionProfile } from "../database/mysql-profile";
import { decField, encField, rowClear, rowDelete, rowList, rowUpsert } from "./db";

const cache: MySQLConnectionProfile[] = [];
let initialized = false;
const str = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;

async function toRow(profile: MySQLConnectionProfile): Promise<Record<string, unknown>> {
  return { id: profile.id, name: profile.name, group_name: profile.group ?? null, environment: profile.environment, host: profile.providerConfig.host, port: profile.providerConfig.port, database_name: profile.providerConfig.database, username: profile.providerConfig.username, password: await encField(profile.providerConfig.password), created_at: profile.createdAt, updated_at: profile.updatedAt };
}
async function fromRow(row: Record<string, unknown>): Promise<MySQLConnectionProfile> {
  const environment = row.environment === "production" || row.environment === "test" ? row.environment : "development";
  return { id: str(row.id) ?? "", name: str(row.name) ?? "", providerId: "mysql", environment, group: str(row.group_name), createdAt: Number(row.created_at ?? Date.now()), updatedAt: Number(row.updated_at ?? Date.now()), providerConfig: { host: str(row.host) ?? "", port: Number(row.port ?? 3306), database: str(row.database_name) ?? "", username: str(row.username) ?? "", password: (await decField(str(row.password))) ?? str(row.password) } };
}
function notify(): void { window.dispatchEvent(new CustomEvent("nexterm:toolbox-changed", { detail: { kind: "mysql" } })); }
export async function hydrateMySQLConnections(): Promise<void> { cache.splice(0, cache.length, ...(await Promise.all((await rowList("database_mysql_connections")).map(fromRow)))); initialized = true; }
export const MySQLConnectionsStorage = {
  initialized: () => initialized,
  load: (): MySQLConnectionProfile[] => [...cache],
  async upsert(profile: MySQLConnectionProfile): Promise<boolean> { if (!(await rowUpsert("database_mysql_connections", await toRow(profile)))) return false; const index = cache.findIndex((item) => item.id === profile.id); if (index === -1) cache.push(profile); else cache[index] = profile; notify(); return true; },
  async remove(id: string): Promise<boolean> { try { await rowDelete("database_mysql_connections", id); } catch { return false; } const index = cache.findIndex((item) => item.id === id); if (index !== -1) cache.splice(index, 1); notify(); return true; },
  async replace(items: MySQLConnectionProfile[]): Promise<void> { cache.splice(0, cache.length, ...items); await rowClear("database_mysql_connections"); await Promise.all(items.map(async (item) => rowUpsert("database_mysql_connections", await toRow(item)))); notify(); },
};

export function resetMySQLConnections(): void {
  cache.splice(0, cache.length);
  initialized = false;
}
