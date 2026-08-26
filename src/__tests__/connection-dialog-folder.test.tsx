/**
 * Tests for ConnectionDialog folder pre-selection via initialFolder prop:
 * - Pre-select folder when initialFolder is provided (new connection from folder context menu)
 * - Ignore initialFolder when editing an existing connection
 * - Defaults to the first available folder when no initialFolder is set
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionDialog } from '../components/connection-dialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const mockFolders = [
  { path: 'All Connections' },
  { path: 'Work' },
  { path: 'Personal' },
  { path: 'Work/ProjectA' },
];

vi.mock('../lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getValidFolders: vi.fn(() => mockFolders),
    getConnections: vi.fn(() => []),
  },
}));

vi.mock('../lib/connection-profiles', () => ({
  ConnectionProfileManager: {
    getProfiles: vi.fn(() => []),
  },
}));

const defaultConnection = {
  name: 'My Server',
  host: '192.168.1.1',
  port: 22,
  username: 'admin',
  protocol: 'SSH' as const,
  authMethod: 'password' as const,
  folder: 'Personal',
  id: 'conn-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: get the folder select trigger. The dialog now has more than two
 * <Select>s (protocol, terminal encoding, terminal startup mode, folder), so
 * the folder select is identified by an explicit data-testid instead of a
 * positional combobox index.
 */
function getFolderSelect() {
  return screen.getByTestId('connection-folder-select');
}

describe('ConnectionDialog folder pre-selection', () => {
  function renderDialog(props: Partial<React.ComponentProps<typeof ConnectionDialog>> = {}) {
    return render(
      <ConnectionDialog
        open={true}
        onOpenChange={vi.fn()}
        onConnect={vi.fn()}
        editingConnection={null}
        {...props}
      />,
    );
  }

  it('pre-selects the folder when initialFolder is provided', () => {
    renderDialog({ initialFolder: 'Work' });

    const folderSelect = getFolderSelect();
    expect(folderSelect.textContent).toContain('Work');
  });

  it('defaults to the first real folder (not the root) when no initialFolder is set', () => {
    renderDialog({ initialFolder: undefined });

    const folderSelect = getFolderSelect();
    // The root "All Connections" is not a saveable folder — the dialog must
    // visibly pre-select the first real folder ("Personal" after sorting).
    expect(folderSelect.textContent).toContain('Personal');
    expect(folderSelect.textContent).not.toContain('All Connections');
  });

  it('hides the folder select when editing (initialFolder is ignored gracefully)', () => {
    renderDialog({
      initialFolder: 'Work',
      editingConnection: { ...defaultConnection, folder: 'Personal' },
    });

    // When editing, saveAsConnection is false, so the folder select is not rendered.
    // The protocol select (combobox) should still be present.
    expect(screen.queryByTestId('connection-folder-select')).toBeNull();
    const combos = screen.getAllByRole('combobox');
    expect(combos.length).toBeGreaterThan(0);
    expect(combos[0].textContent).toContain('SSH');
  });

  it('uses folder from initialFolder over default "All Connections"', () => {
    renderDialog({ initialFolder: 'Work/ProjectA' });

    const folderSelect = getFolderSelect();
    expect(folderSelect.textContent).toContain('Work/ProjectA');
  });
});
