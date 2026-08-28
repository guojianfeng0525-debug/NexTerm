import type { TerminalGroupState, TerminalGroup, TerminalTab, GridNode } from './terminal-group-types';
import { rowList, rowUpsert, rowClear, legacyDbGet, type Row } from './toolbox/db';

/** Coerce an unknown DB value to string ('' when absent). */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
export const STORAGE_KEY = 'nexterm-terminal-groups';
export const STATE_VERSION = 1;

interface SerializedState {
  version: number;
  data: TerminalGroupState;
}

/* ── sync cache (hydrated once after unlock) ──────────────────────────────── */

let cachedState: TerminalGroupState | null = null;
let hydrated = false;

export function isWorkspaceHydrated(): boolean {
  return hydrated;
}

/* ── serialize / deserialize (legacy blob format, used for migration) ─────── */

export function serialize(state: TerminalGroupState): string {
  const envelope: SerializedState = { version: STATE_VERSION, data: state };
  return JSON.stringify(envelope);
}

export function deserialize(json: string): TerminalGroupState | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isSerializedState(parsed)) return null;
    if (parsed.version !== STATE_VERSION) return null;
    if (!isValidState(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * saveState — persist state into the normalized workspace tables (one row per
 * tab / group / grid node) when hydrated, else keep it in the in-memory cache.
 * Editor tabs are ephemeral and excluded from persistence.
 */
export function saveState(state: TerminalGroupState): void {
  const filtered = stripEditorTabs(state);
  cachedState = filtered;
  if (hydrated) {
    void queueWorkspacePersist(filtered);
  }
}

/* Serializes the clear+rewrite cycles: concurrent persistWorkspace runs could
 * interleave their table clears/upserts (stale rows resurrecting, transient
 * empty tables). One promise chain, latest state wins within a run. */
let workspacePersistQueue: Promise<void> = Promise.resolve();

function queueWorkspacePersist(state: TerminalGroupState): Promise<void> {
  workspacePersistQueue = workspacePersistQueue
    .then(() => persistWorkspace(state))
    .catch((error: unknown) => {
      console.error('[workspace] persistence failed:', error);
    });
  return workspacePersistQueue;
}

function stripEditorTabs(state: TerminalGroupState): TerminalGroupState {
  const filtered: TerminalGroupState = {
    ...state,
    groups: Object.fromEntries(
      Object.entries(state.groups).map(([id, group]) => {
        const tabs = group.tabs.filter(t => t.tabType !== 'editor');
        return [id, {
          ...group,
          tabs,
          activeTabId: tabs.find(t => t.id === group.activeTabId) ? group.activeTabId : (tabs[0]?.id ?? null),
        }];
      }),
    ),
    tabToGroupMap: Object.fromEntries(
      Object.entries(state.tabToGroupMap).filter(([tabId]) => {
        const group = state.groups[state.tabToGroupMap[tabId]];
        const tab = group?.tabs.find(t => t.id === tabId);
        return tab?.tabType !== 'editor';
      }),
    ),
  };
  return filtered;
}

/**
 * loadState — return the in-memory workspace cache (hydrated or not).
 */
export function loadState(): TerminalGroupState | null {
  return cachedState;
}

/* ── normalized table persistence ─────────────────────────────────────────── */

function tabToRow(groupId: string, position: number, tab: TerminalTab): Row {
  return {
    tab_id: tab.id,
    group_id: groupId,
    position,
    name: tab.name,
    tab_type: tab.tabType ?? null,
    protocol: tab.protocol ?? null,
    host: tab.host ?? null,
    username: tab.username ?? null,
    original_connection_id: tab.originalConnectionId ?? null,
    connection_status: tab.connectionStatus,
    reconnect_count: tab.reconnectCount,
    editor_file_path: tab.editorFilePath ?? null,
    editor_connection_id: tab.editorConnectionId ?? null,
    tools_tab_view: tab.toolsTabView ?? null,
  };
}

function rowToTab(row: Row): TerminalTab {
  const tab: TerminalTab = {
    id: String(row.tab_id),
    name: str(row.name),
    tabType: (row.tab_type as TerminalTab['tabType']) ?? undefined,
    protocol: (row.protocol as string) ?? undefined,
    host: (row.host as string) ?? undefined,
    username: (row.username as string) ?? undefined,
    originalConnectionId: (row.original_connection_id as string) ?? undefined,
    connectionStatus: (row.connection_status as TerminalTab['connectionStatus']) ?? 'disconnected',
    reconnectCount: (row.reconnect_count as number) ?? 0,
    editorFilePath: (row.editor_file_path as string) ?? undefined,
    editorConnectionId: (row.editor_connection_id as string) ?? undefined,
    toolsTabView: (row.tools_tab_view as TerminalTab['toolsTabView']) ?? undefined,
  };
  return tab;
}

/** Flatten the grid tree into rows keyed by DFS path ("0", "0/0", ...). */
function flattenGrid(node: GridNode, path: string, parentId: string | null, position: number, size: number, rows: Row[]): void {
  if (node.type === 'leaf') {
    rows.push({ node_id: path, type: 'leaf', direction: null, parent_id: parentId, position, size, group_id: node.groupId });
    return;
  }
  rows.push({ node_id: path, type: 'branch', direction: node.direction, parent_id: parentId, position, size: 1, group_id: null });
  node.children.forEach((child, i) => {
    flattenGrid(child, `${path}/${i}`, path, i, node.sizes[i], rows);
  });
}

function buildGrid(row: Row, childrenByParent: Map<string, Row[]>): GridNode {
  const children = childrenByParent.get(String(row.node_id)) ?? [];
  children.sort((a, b) => ((a.position as number) ?? 0) - ((b.position as number) ?? 0));
  if (String(row.type) === 'leaf') {
    return { type: 'leaf', groupId: String(row.group_id) };
  }
  return {
    type: 'branch',
    direction: String(row.direction) === 'vertical' ? 'vertical' : 'horizontal',
    children: children.map(buildGridChild),
    sizes: children.map(c => (c.size as number) ?? 1),
  };
}

function buildGridChild(row: Row): GridNode {
  // Wrapper so buildGrid's signature stays compatible for recursion.
  return buildGrid(row, new Map());
}

/** Persist the whole workspace state (clear + rewrite all four tables). */
async function persistWorkspace(state: TerminalGroupState): Promise<void> {
  await Promise.all([
    rowClear('workspace_meta'),
    rowClear('workspace_groups'),
    rowClear('workspace_tabs'),
    rowClear('workspace_grid_nodes'),
  ]);

  await rowUpsert('workspace_meta', {
    id: 1,
    active_group_id: state.activeGroupId,
    next_group_id: state.nextGroupId,
    updated_at: Date.now(),
  });

  const groupIds = Object.keys(state.groups);
  await Promise.all(
    groupIds.map(async (groupId, index) => {
      const group = state.groups[groupId];
      await rowUpsert('workspace_groups', {
        group_id: groupId,
        position: index,
        active_tab_id: group.activeTabId ?? null,
      });
      await Promise.all(
        group.tabs.map((tab, tabIndex) => rowUpsert('workspace_tabs', tabToRow(groupId, tabIndex, tab))),
      );
    }),
  );

  const gridRows: Row[] = [];
  flattenGrid(state.gridLayout, '0', null, 0, 1, gridRows);
  await Promise.all(gridRows.map(row => rowUpsert('workspace_grid_nodes', row)));
}

/** Rebuild a TerminalGroupState from the normalized workspace tables. */
async function rebuildState(): Promise<TerminalGroupState | null> {
  const [metaRows, groupRows, tabRows, nodeRows] = await Promise.all([
    rowList('workspace_meta'),
    rowList('workspace_groups'),
    rowList('workspace_tabs'),
    rowList('workspace_grid_nodes'),
  ]);
  if (metaRows.length === 0 && groupRows.length === 0 && nodeRows.length === 0) {
    return null;
  }

  const meta = metaRows[0] ?? {};
  const groups: Record<string, TerminalGroup> = {};
  const tabToGroupMap: Record<string, string> = {};

  for (const gRow of groupRows) {
    const groupId = String(gRow.group_id);
    groups[groupId] = {
      id: groupId,
      tabs: [],
      activeTabId: (gRow.active_tab_id as string) ?? null,
    };
  }
  const sortedTabs = [...tabRows].sort((a, b) => ((a.position as number) ?? 0) - ((b.position as number) ?? 0));
  for (const tRow of sortedTabs) {
    const groupId = String(tRow.group_id);
    const tab = rowToTab(tRow);
    groups[groupId]?.tabs.push(tab);
    tabToGroupMap[tab.id] = groupId;
  }

  // Rebuild the grid tree from parent/position rows.
  const childrenByParent = new Map<string, Row[]>();
  let root: Row | null = null;
  for (const n of nodeRows) {
    const parent = n.parent_id as string | null;
    if (parent === null || parent === undefined) {
      root = n;
    } else {
      const list = childrenByParent.get(parent) ?? [];
      list.push(n);
      childrenByParent.set(parent, list);
    }
  }
  if (!root) {
    // Fallback: single leaf group.
    const firstGroupId = groupIdsOf(groups)[0];
    if (firstGroupId) {
      root = { node_id: '0', type: 'leaf', direction: null, parent_id: null, position: 0, size: 1, group_id: firstGroupId };
    }
  }
  const gridLayout = root ? buildGrid(root, childrenByParent) : { type: 'leaf', groupId: groupIdsOf(groups)[0] ?? '' };

  return {
    groups,
    activeGroupId: str(meta.active_group_id) || groupIdsOf(groups)[0] || '',
    gridLayout: gridLayout as GridNode,
    nextGroupId: (meta.next_group_id as number) ?? 1,
    tabToGroupMap,
  };
}

function groupIdsOf(groups: Record<string, TerminalGroup>): string[] {
  return Object.keys(groups);
}

/** Hydrate the workspace cache from SQLite (call after unlock). */
export async function hydrateWorkspace(): Promise<void> {
  try {
    cachedState = await rebuildState();
    if (!cachedState) {
      // Migrate the legacy layout blob from the `workspace_legacy` key-value
      // table (previous normalized builds) into the normalized tables.
      try {
        const raw: string | null = await legacyDbGet('workspace_legacy', STORAGE_KEY);
        if (raw !== null) {
          const legacy = deserialize(raw);
          if (legacy) {
            cachedState = legacy;
            await persistWorkspace(legacy);
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    cachedState = null;
  }
  hydrated = true;
}

/** Reset caches (used by tests for isolation). */
export function resetWorkspaceCache(): void {
  cachedState = null;
  hydrated = false;
}

// ── Validation helpers ──

function isSerializedState(value: unknown): value is SerializedState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.version === 'number' && typeof obj.data === 'object' && obj.data !== null;
}

function isValidState(value: unknown): value is TerminalGroupState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.groups !== 'object' || obj.groups === null) return false;
  if (typeof obj.activeGroupId !== 'string') return false;
  if (typeof obj.nextGroupId !== 'number') return false;
  if (!isValidGridNode(obj.gridLayout)) return false;

  // tabToGroupMap is optional for backward compatibility — initializeState rebuilds it
  if (obj.tabToGroupMap !== undefined && typeof obj.tabToGroupMap !== 'object') return false;

  // Validate each group has required fields
  const groups = obj.groups as Record<string, unknown>;
  for (const key of Object.keys(groups)) {
    const group = groups[key] as Record<string, unknown>;
    if (typeof group !== 'object' || group === null) return false;
    if (typeof group.id !== 'string') return false;
    if (!Array.isArray(group.tabs)) return false;
    if (group.activeTabId !== null && typeof group.activeTabId !== 'string') return false;
  }

  return true;
}

function isValidGridNode(value: unknown): value is GridNode {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.type === 'leaf') {
    return typeof obj.groupId === 'string';
  }

  if (obj.type === 'branch') {
    if (obj.direction !== 'horizontal' && obj.direction !== 'vertical') return false;
    if (!Array.isArray(obj.children)) return false;
    if (!Array.isArray(obj.sizes)) return false;
    if (obj.children.length !== obj.sizes.length) return false;
    return obj.children.every(isValidGridNode);
  }

  return false;
}

// Re-export createDefaultState for convenience
export { createDefaultState } from './terminal-group-reducer';
