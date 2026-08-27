/**
 * Per-provider query history (feature-design §5.1).
 *
 * Stored in localStorage under `nexterm.dbQueryHistory.<providerId>` — SQL text
 * is not a credential (same rationale as `nexterm.postgres.savedQueries.*`), so
 * plain storage is acceptable and it deliberately does NOT reuse
 * `lib/command-history.ts` (terminal-oriented, encrypted, no connection
 * semantics). Mutations dispatch `nexterm:db-query-history-changed` with
 * `{ providerId }` so open dialogs can refresh (tool-command-history pattern).
 */

export interface QueryHistoryEntry {
  readonly id: string;
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly providerId: "postgresql" | "mysql" | "sqlite";
  readonly executedAt: number;
  readonly success: boolean;
}

const HISTORY_KEY_PREFIX = "nexterm.dbQueryHistory.";
const MAX_ENTRIES = 200;

export const QUERY_HISTORY_CHANGED_EVENT = "nexterm:db-query-history-changed";

function storageKey(providerId: string): string {
  return `${HISTORY_KEY_PREFIX}${providerId}`;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadQueryHistory(providerId: string): readonly QueryHistoryEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(providerId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueryHistoryEntry);
  } catch {
    return [];
  }
}

function isQueryHistoryEntry(value: unknown): value is QueryHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<QueryHistoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.sql === "string" &&
    typeof entry.connectionId === "string" &&
    typeof entry.connectionName === "string" &&
    (entry.providerId === "postgresql" ||
      entry.providerId === "mysql" ||
      entry.providerId === "sqlite") &&
    typeof entry.executedAt === "number" &&
    typeof entry.success === "boolean"
  );
}

function persist(providerId: string, entries: readonly QueryHistoryEntry[]): void {
  localStorage.setItem(storageKey(providerId), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

function dispatchChanged(providerId: string): void {
  window.dispatchEvent(
    new CustomEvent(QUERY_HISTORY_CHANGED_EVENT, { detail: { providerId } }),
  );
}

/**
 * Records a query execution. Entries with the same `sql` + `connectionId` are
 * de-duplicated: the stored entry's success state and timestamp are refreshed
 * and the entry moves to the top. The list is truncated to MAX_ENTRIES (oldest
 * dropped).
 */
export function addQueryHistory(
  entry: Omit<QueryHistoryEntry, "id" | "executedAt">,
): void {
  const { providerId, sql, connectionId } = entry;
  const current = loadQueryHistory(providerId).filter(
    (existing) => !(existing.sql === sql && existing.connectionId === connectionId),
  );
  const next: QueryHistoryEntry = {
    ...entry,
    id: generateId(),
    executedAt: Date.now(),
  };
  persist(providerId, [next, ...current]);
  dispatchChanged(providerId);
}

export function removeQueryHistory(providerId: string, id: string): void {
  const next = loadQueryHistory(providerId).filter((entry) => entry.id !== id);
  persist(providerId, next);
  dispatchChanged(providerId);
}

export function clearQueryHistory(providerId: string): void {
  localStorage.removeItem(storageKey(providerId));
  dispatchChanged(providerId);
}
