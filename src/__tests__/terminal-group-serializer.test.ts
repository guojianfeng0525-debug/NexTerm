import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestIpc } from '../lib/__tests__/helpers/test-ipc';
import {
  serialize,
  deserialize,
  saveState,
  loadState,
  resetWorkspaceCache,
  createDefaultState,
  STATE_VERSION,
} from '../lib/terminal-group-serializer';
import type { TerminalGroupState, TerminalTab } from '../lib/terminal-group-types';

const ipc = createTestIpc();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => ipc.invokeMock(...args),
}));

// ── Helpers ──

function makeTab(id: string): TerminalTab {
  return {
    id,
    name: id,
    connectionStatus: 'connected',
    reconnectCount: 0,
  };
}

function makeState(): TerminalGroupState {
  return {
    groups: {
      '1': { id: '1', tabs: [makeTab('t1')], activeTabId: 't1' },
    },
    activeGroupId: '1',
    tabToGroupMap: { t1: '1' },
    gridLayout: { type: 'leaf', groupId: '1' },
    nextGroupId: 2,
  };
}

// ── Tests ──

describe('serialize / deserialize', () => {
  it('round-trips a valid state', () => {
    const state = makeState();
    const json = serialize(state);
    const result = deserialize(json);
    expect(result).toEqual(state);
  });

  it('wraps state with version number', () => {
    const state = makeState();
    const json = serialize(state);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(STATE_VERSION);
    expect(parsed.data).toEqual(state);
  });

  it('returns null for invalid JSON', () => {
    expect(deserialize('not json')).toBeNull();
  });

  it('returns null for wrong version', () => {
    const json = JSON.stringify({ version: 999, data: makeState() });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for missing version', () => {
    const json = JSON.stringify({ data: makeState() });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for missing data', () => {
    const json = JSON.stringify({ version: STATE_VERSION });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for invalid state structure (missing groups)', () => {
    const json = JSON.stringify({
      version: STATE_VERSION,
      data: { activeGroupId: '1', nextGroupId: 2, gridLayout: { type: 'leaf', groupId: '1' } },
    });
    expect(deserialize(json)).toBeNull();
  });

  it('returns null for invalid gridLayout', () => {
    const json = JSON.stringify({
      version: STATE_VERSION,
      data: {
        groups: { '1': { id: '1', tabs: [], activeTabId: null } },
        activeGroupId: '1',
        nextGroupId: 2,
        gridLayout: { type: 'unknown' },
      },
    });
    expect(deserialize(json)).toBeNull();
  });

  it('round-trips a state with branch grid layout', () => {
    const state: TerminalGroupState = {
      groups: {
        '1': { id: '1', tabs: [makeTab('t1')], activeTabId: 't1' },
        '2': { id: '2', tabs: [makeTab('t2')], activeTabId: 't2' },
      },
      activeGroupId: '1',
      gridLayout: {
        type: 'branch',
        direction: 'horizontal',
        children: [
          { type: 'leaf', groupId: '1' },
          { type: 'leaf', groupId: '2' },
        ],
        sizes: [50, 50],
      },
      nextGroupId: 3,
    };
    expect(deserialize(serialize(state))).toEqual(state);
  });

  it('round-trips default state', () => {
    const state = createDefaultState();
    expect(deserialize(serialize(state))).toEqual(state);
  });
});

describe('saveState / loadState', () => {
  beforeEach(() => {
    resetWorkspaceCache();
  });

  it('saves and loads state via the in-memory cache', () => {
    const state = makeState();
    saveState(state);
    const loaded = loadState();
    expect(loaded).toEqual(state);
  });

  it('returns null when nothing is stored', () => {
    expect(loadState()).toBeNull();
  });
});

describe('workspace SQLite persistence (save → restart → restore)', () => {
  beforeEach(async () => {
    for (const k of Object.keys(ipc.DB)) delete ipc.DB[k];
    resetWorkspaceCache();
  });

  it('persists layout to the workspace tables and restores it after re-hydrate', async () => {
    const { hydrateWorkspace } = await import('../lib/terminal-group-serializer');
    // Unlock-time hydrate: empty store → nothing cached.
    await hydrateWorkspace();
    expect(loadState()).toBeNull();

    // User arranges the workspace.
    const state: TerminalGroupState = {
      groups: {
        'g1': { id: 'g1', tabs: [makeTab('t1'), makeTab('t2')], activeTabId: 't2' },
      },
      activeGroupId: 'g1',
      tabToGroupMap: { t1: 'g1', t2: 'g1' },
      gridLayout: { type: 'leaf', groupId: 'g1' },
      nextGroupId: 3,
    };
    saveState(state);
    await new Promise(r => setTimeout(r, 10));

    // The normalized tables now hold the rows.
    expect(ipc.DB.workspace_meta?.length ?? 0).toBeGreaterThan(0);
    expect(ipc.DB.workspace_groups?.length ?? 0).toBeGreaterThan(0);
    expect(ipc.DB.workspace_tabs?.length ?? 0).toBe(2);

    // Simulate app restart: drop the in-memory cache and reload from SQLite.
    resetWorkspaceCache();
    await hydrateWorkspace();
    expect(loadState()).toEqual(state);
  });

  it('drops editor tabs from persistence (ephemeral, never restored)', async () => {
    const { hydrateWorkspace } = await import('../lib/terminal-group-serializer');
    await hydrateWorkspace();

    const state: TerminalGroupState = {
      groups: {
        'g1': {
          id: 'g1',
          tabs: [
            makeTab('t-term'),
            { id: 't-editor', name: 'editor', tabType: 'editor', connectionStatus: 'connected', reconnectCount: 0 },
          ],
          activeTabId: 't-editor',
        },
      },
      activeGroupId: 'g1',
      tabToGroupMap: { 't-term': 'g1', 't-editor': 'g1' },
      gridLayout: { type: 'leaf', groupId: 'g1' },
      nextGroupId: 2,
    };
    saveState(state);
    await new Promise(r => setTimeout(r, 10));

    // Only the terminal tab survives.
    expect(ipc.DB.workspace_tabs?.length ?? 0).toBe(1);

    resetWorkspaceCache();
    await hydrateWorkspace();
    const restored = loadState();
    expect(restored?.groups.g1.tabs.map(t => t.id)).toEqual(['t-term']);
    expect(restored?.groups.g1.activeTabId).toBe('t-term');
  });
});

describe('createDefaultState', () => {
  it('returns a single group with empty tabs', () => {
    const state = createDefaultState();
    const groupIds = Object.keys(state.groups);
    expect(groupIds).toHaveLength(1);
    const group = state.groups[groupIds[0]];
    expect(group.tabs).toEqual([]);
    expect(group.activeTabId).toBeNull();
  });

  it('has a leaf grid layout matching the group', () => {
    const state = createDefaultState();
    expect(state.gridLayout.type).toBe('leaf');
    if (state.gridLayout.type === 'leaf') {
      expect(state.gridLayout.groupId).toBe(state.activeGroupId);
    }
  });
});
