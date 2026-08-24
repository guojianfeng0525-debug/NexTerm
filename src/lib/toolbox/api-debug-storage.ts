/**
 * API debugger persistence — normalized SQLite tables.
 *
 * Saved requests live one-per-row in `api_collections` (the request
 * configuration — which may contain auth tokens — is encrypted per-field),
 * environments one-per-row in `api_environments` (variables encrypted), and
 * the active environment id lives in the `preferences` table. A synchronous
 * cache is hydrated by `hydrateApiDebugStorage()` after unlock.
 */
import { rowList, rowUpsert, rowDelete, rowClear, encField, decField } from './db';
import { getApiActiveEnv, setApiActiveEnv as persistActiveEnv } from '../preferences';
/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export type BodyType = 'none' | 'json' | 'text' | 'form' | 'multipart';

export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'apikey';
  username: string;
  password: string;
  token: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: 'header' | 'query';
}

/** Declarative response check. Values are data only; no scripts are executed. */
export type ApiAssertion =
  | { target: 'status'; operator: 'equals'; value: string }
  | { target: 'header'; name: string; operator: 'equals' | 'contains'; value: string }
  | { target: 'body'; path: string; operator: 'equals' | 'contains'; value: string }
  | { target: 'responseTime'; operator: 'lessThanOrEqual'; value: string };

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
  /** Structured URL-encoded or multipart text fields. File contents are never persisted. */
  formFields?: [string, string][];
  auth: AuthConfig;
  timeoutMs: number;
  assertions: ApiAssertion[];
  updatedAt: number;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  variables: [string, string][];
}

export interface ApiRequestHistory {
  id: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  timestamp: number;
  config: RequestConfig;
  responsePreview: string;
  responseBodyIsBase64: boolean;
}

export const API_REQUEST_HISTORY_LIMIT = 100;
export const API_REQUEST_HISTORY_PREVIEW_CHARS = 8_000;

let collection: RequestConfig[] = [];
let environments: ApiEnvironment[] = [];
let activeEnvId = '';
let history: ApiRequestHistory[] = [];
let historyPersistence: Promise<void> = Promise.resolve();
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

export function getApiRequestHistory(): ApiRequestHistory[] {
  return history;
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

async function rowToHistory(row: Record<string, unknown>): Promise<ApiRequestHistory | null> {
  const raw = await decField(row.details as string);
  if (!raw) return null;
  try {
    const details = JSON.parse(raw) as Omit<ApiRequestHistory, 'id' | 'method' | 'status' | 'durationMs' | 'timestamp'>;
    if (!details.url || !details.config) return null;
    return {
      id: str(row.id),
      method: str(row.method),
      status: Number(row.status) || 0,
      durationMs: Number(row.duration_ms) || 0,
      timestamp: Number(row.timestamp) || 0,
      ...details,
    };
  } catch {
    return null;
  }
}

/** Load requests, environments and the active env id from SQLite. */
export async function hydrateApiDebugStorage(): Promise<void> {
  try {
    const [cRows, eRows, hRows] = await Promise.all([
      rowList('api_collections'),
      rowList('api_environments'),
      rowList('api_request_history'),
    ]);
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
    const loadedHistory: ApiRequestHistory[] = [];
    for (const row of hRows) {
      const item = await rowToHistory(row);
      if (item) loadedHistory.push(item);
    }
    loadedHistory.sort((a, b) => b.timestamp - a.timestamp);
    history = loadedHistory.slice(0, API_REQUEST_HISTORY_LIMIT);
    for (const item of loadedHistory.slice(API_REQUEST_HISTORY_LIMIT)) void rowDelete('api_request_history', item.id);
  } catch {
    collection = [];
    environments = [];
    activeEnvId = '';
    history = [];
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

/** Store an encrypted request snapshot and a bounded response preview. */
export function addApiRequestHistory(item: Omit<ApiRequestHistory, 'id' | 'timestamp' | 'responsePreview'> & { responsePreview?: string }): void {
  const entry: ApiRequestHistory = {
    ...item,
    id: `api-history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    responsePreview: (item.responsePreview ?? '').slice(0, API_REQUEST_HISTORY_PREVIEW_CHARS),
  };
  const removed = history.slice(API_REQUEST_HISTORY_LIMIT - 1).map((old) => old.id);
  history = [entry, ...history].slice(0, API_REQUEST_HISTORY_LIMIT);
  historyPersistence = historyPersistence.then(async () => {
    const details = await encField(JSON.stringify({
      url: entry.url,
      statusText: entry.statusText,
      config: entry.config,
      responsePreview: entry.responsePreview,
      responseBodyIsBase64: entry.responseBodyIsBase64,
    }));
    if (!details) return;
    await rowUpsert('api_request_history', {
      id: entry.id,
      method: entry.method,
      status: entry.status,
      duration_ms: entry.durationMs,
      timestamp: entry.timestamp,
      details,
    });
    for (const id of removed) await rowDelete('api_request_history', id);
  }, async () => {
    // A prior failed write must not block subsequent history records.
    const details = await encField(JSON.stringify({
      url: entry.url,
      statusText: entry.statusText,
      config: entry.config,
      responsePreview: entry.responsePreview,
      responseBodyIsBase64: entry.responseBodyIsBase64,
    }));
    if (!details) return;
    await rowUpsert('api_request_history', {
      id: entry.id,
      method: entry.method,
      status: entry.status,
      duration_ms: entry.durationMs,
      timestamp: entry.timestamp,
      details,
    });
    for (const id of removed) await rowDelete('api_request_history', id);
  });
}

export function clearApiRequestHistory(): void {
  history = [];
  historyPersistence = historyPersistence.then(
    () => rowClear('api_request_history'),
    () => rowClear('api_request_history'),
  );
}
