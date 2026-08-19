/**
 * API debugger persistence — normalized SQLite tables.
 *
 * Saved requests live one-per-row in `api_collections` (the request
 * configuration — which may contain auth tokens — is encrypted per-field),
 * environments one-per-row in `api_environments` (variables encrypted), and
 * the active environment id lives in the `preferences` table. A synchronous
 * cache is hydrated by `hydrateApiDebugStorage()` after unlock.
 */
import { rowList, rowUpsert, rowDelete, encField, decField } from './db';
import { getApiActiveEnv, setApiActiveEnv as persistActiveEnv } from '../preferences';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export type BodyType = 'none' | 'json' | 'text' | 'form';

export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'apikey';
  username: string;
  password: string;
  token: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: 'header' | 'query';
}

export interface RequestConfig {
  id: string;
  name: string;
  group: string;
  method: string;
  url: string;
  params: [string, string][];
  headers: [string, string][];
  bodyType: BodyType;
  bodyText: string;
  auth: AuthConfig;
  timeoutMs: number;
  updatedAt: number;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  variables: [string, string][];
}

let collection: RequestConfig[] = [];
let environments: ApiEnvironment[] = [];
let activeEnvId = '';
let hydrated = false;

export function isApiDebugStorageHydrated(): boolean {
  return hydrated;
}

export function getCollection(): RequestConfig[] {
  return collection;
}

export function getEnvironments(): ApiEnvironment[] {
  return environments;
}

export function getActiveEnvId(): string {
  return activeEnvId;
}

async function rowToRequest(row: Record<string, unknown>): Promise<RequestConfig | null> {
  const raw = await decField(row.request as string);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RequestConfig;
  } catch {
    return null;
  }
}

async function rowToEnvironment(row: Record<string, unknown>): Promise<ApiEnvironment | null> {
  const raw = await decField(row.variables as string);
  let variables: [string, string][] = [];
  if (raw) {
    try {
      variables = JSON.parse(raw) as [string, string][];
    } catch {
      variables = [];
    }
  }
  return { id: str(row.id), name: str(row.name), variables };
}

/** Load requests, environments and the active env id from SQLite. */
export async function hydrateApiDebugStorage(): Promise<void> {
  try {
    const [cRows, eRows] = await Promise.all([rowList('api_collections'), rowList('api_environments')]);
    const requests: RequestConfig[] = [];
    for (const row of cRows) {
      const r = await rowToRequest(row);
      if (r) requests.push(r);
    }
    collection = requests;
    environments = [];
    for (const row of eRows) {
      const e = await rowToEnvironment(row);
      if (e) environments.push(e);
    }
    // Active env id (app_settings column).
    activeEnvId = getApiActiveEnv();
  } catch {
    collection = [];
    environments = [];
    activeEnvId = '';
  }
  hydrated = true;
}

function persistRequest(r: RequestConfig): void {
  void (async () => {
    const request = await encField(JSON.stringify(r));
    if (!request) return;
    await rowUpsert('api_collections', {
      id: r.id,
      name: r.name,
      group_name: r.group || null,
      request,
      created_at: r.updatedAt,
      updated_at: r.updatedAt,
    });
  })();
}

function persistEnvironment(e: ApiEnvironment): void {
  void (async () => {
    const variables = await encField(JSON.stringify(e.variables));
    await rowUpsert('api_environments', {
      id: e.id,
      name: e.name,
      variables: variables ?? '[]',
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  })();
}

export function setCollection(items: RequestConfig[]): void {
  const removed = collection.filter(c => !items.some(n => n.id === c.id));
  collection = items;
  for (const item of items) persistRequest(item);
  for (const item of removed) void rowDelete('api_collections', item.id);
}

export function setEnvironments(items: ApiEnvironment[]): void {
  const removed = environments.filter(e => !items.some(n => n.id === e.id));
  environments = items;
  for (const item of items) persistEnvironment(item);
  for (const item of removed) void rowDelete('api_environments', item.id);
}

export function setActiveEnvId(id: string): void {
  activeEnvId = id;
  persistActiveEnv(id);
}
