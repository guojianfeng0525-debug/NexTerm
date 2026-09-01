/**
 * Save-to-notes dialog (PostgreSQL) tests.
 *
 * The dialog was reworked into a type-and-select combobox:
 *   - the target picker lists existing notes (title + language + line count)
 *     and filters live as the user types
 *   - a trim-exact match against an existing note title = append mode;
 *     anything else creates a new note with the typed title
 *   - the UI announces the current mode (append / create)
 *   - keyboard ↑/↓ highlight, Enter selects, Esc closes the dropdown
 *   - a required SQL comment is written into the note as the `-- comment`
 *     header line on both the append and the create path
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToolPostgres } from '../../../components/toolbox/tool-postgres';
import { invoke } from '@tauri-apps/api/core';
import { PostgresConnectionsStorage } from '../../../lib/toolbox/postgres-storage';
import { NotesStorage, resetToolboxStore } from '../../../lib/toolbox/toolbox-storage';
import type { NoteItem } from '../../../lib/toolbox/toolbox-types';
import { toast } from 'sonner';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// jsdom does not implement scrollIntoView; cmdk calls it when rendering and
// keyboard-navigating command items, which would otherwise crash the tests.
Element.prototype.scrollIntoView = vi.fn();

vi.mock('@/lib/connection-storage', () => ({
  ConnectionStorageManager: {
    getConnections: vi.fn(() => []),
  },
}));

vi.mock('@/lib/toolbox/postgres-storage', () => ({
  PostgresConnectionsStorage: {
    load: vi.fn(),
    upsert: vi.fn(async () => true),
  },
}));

// CodeMirror is heavy — stub it with a controlled textarea so tests can edit
// the query tab SQL through the editor's value/onChange contract.
vi.mock('@/components/code-editor', () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (sql: string) => void;
  }) => (
    <textarea
      data-testid="code-editor-mock"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const SQL = 'SELECT current_database(), current_user;';

let noteIdSeq = 0;
function makeNote(overrides: Partial<NoteItem> = {}): NoteItem {
  noteIdSeq += 1;
  return {
    id: `note-${noteIdSeq}`,
    title: 'Untitled',
    language: 'plain',
    content: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function seedNotes(notes: NoteItem[]) {
  NotesStorage.save(notes);
}

/** Render the tool and open the save-to-notes dialog from the toolbar. */
async function openDialog() {
  render(<ToolPostgres />);
  const saveButton = await screen.findByTestId('postgres-save-to-notes');
  await act(async () => {
    fireEvent.click(saveButton);
  });
  expect(screen.getByTestId('postgres-save-note-confirm')).toBeTruthy();
}

/** Open the note-target combobox popover and clear the prefilled title so the
 *  full note list is visible (cmdk filters items by the input value). */
async function openCombobox() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('postgres-save-note-target'));
  });
  const input = screen.getByTestId('postgres-save-note-title');
  await act(async () => {
    fireEvent.change(input, { target: { value: '' } });
  });
  return screen.getByTestId('postgres-save-note-title');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetToolboxStore();
  noteIdSeq = 0;
  localStorage.clear();
  vi.mocked(PostgresConnectionsStorage.load).mockReturnValue([]);
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe('ToolPostgres save-to-notes combobox', () => {
  it('a. lists existing notes with title, language and line count', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: '-- a\nSELECT 1;\nSELECT 2;' }),
      makeNote({ title: 'Snippets', language: 'json', content: '{"a":1}' }),
    ]);
    await openDialog();
    await openCombobox();

    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(2);
    const daily = items.find((item) => item.textContent?.includes('Daily report'));
    expect(daily).toBeTruthy();
    expect(daily!.textContent).toContain('SQL');
    expect(daily!.textContent).toContain('3 lines');
    const snippets = items.find((item) => item.textContent?.includes('Snippets'));
    expect(snippets!.textContent).toContain('JSON');
    expect(snippets!.textContent).toContain('1 line');
  });

  it('b. filters the note list live as the user types', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
      makeNote({ title: 'Snippets', language: 'json', content: '{}' }),
    ]);
    await openDialog();
    const input = await openCombobox();

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Dail' } });
    });
    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Daily report');
    expect(screen.queryByText('Snippets')).toBeNull();
    // Empty state appears once nothing matches.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'zzz' } });
    });
    expect(screen.getByText('No matching note — a new one will be created')).toBeTruthy();
  });

  it('c. a trim-exact title match switches to append mode', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();

    // Exact match with surrounding whitespace still counts.
    await act(async () => {
      fireEvent.change(input, { target: { value: '  Daily report  ' } });
    });
    const mode = screen.getByTestId('postgres-save-note-mode');
    expect(mode.textContent).toContain('Append mode');
    // Selected-note preview: language, line count and first line.
    expect(mode.textContent).toContain('SQL');
    expect(mode.textContent).toContain('1 line');
    expect(mode.textContent).toContain('SELECT 1;');
    expect(
      screen.getByTestId('postgres-save-note-confirm').textContent,
    ).toContain('Append to this note');
  });

  it('d. a non-matching title switches to create mode', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Weekly report' } });
    });
    expect(screen.getByTestId('postgres-save-note-mode').textContent).toContain('Create mode');
    expect(
      screen.getByTestId('postgres-save-note-confirm').textContent,
    ).toContain('Create & save');
  });

  it('e. supports ↑/↓ highlight, Enter select and Esc close', async () => {
    seedNotes([
      makeNote({ title: 'Alpha', language: 'sql', content: 'SELECT 1;' }),
      makeNote({ title: 'Beta', language: 'sql', content: 'SELECT 2;' }),
    ]);
    await openDialog();
    const input = await openCombobox();

    // The list opens with the first item highlighted; one ArrowDown moves to
    // the second item (cmdk wraps around, so two presses would land back on
    // the first). Enter picks the highlighted item.
    await act(async () => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    // ArrowDown moved the highlight to the second item.
    expect(
      screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')
        ?.textContent,
    ).toContain('Beta');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    // Popover closed, trigger shows the picked title, mode is append.
    expect(screen.queryByTestId('postgres-save-note-title')).toBeNull();
    expect(screen.getByTestId('postgres-save-note-target').textContent).toContain('Beta');
    expect(screen.getByTestId('postgres-save-note-mode').textContent).toContain('Append mode');

    // Re-open and Esc closes only the dropdown — the dialog stays open.
    await openCombobox();
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('postgres-save-note-title'), { key: 'Escape' });
    });
    expect(screen.queryByTestId('postgres-save-note-title')).toBeNull();
    expect(screen.getByTestId('postgres-save-note-confirm')).toBeTruthy();
  });

  it('f. requires the SQL comment before confirming', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Daily report' } });
    });

    const confirm = screen.getByTestId('postgres-save-note-confirm');
    expect(confirm.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      fireEvent.change(screen.getByTestId('postgres-save-note-comment'), {
        target: { value: 'list orders' },
      });
    });
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });

  it('g1. appends with a `-- comment` header line to the matched note', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'plain', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Daily report' } });
      fireEvent.change(screen.getByTestId('postgres-save-note-comment'), {
        target: { value: 'list orders' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('postgres-save-note-confirm'));
    });

    const notes = NotesStorage.load();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Daily report');
    expect(notes[0].language).toBe('sql');
    expect(notes[0].content).toBe(`SELECT 1;\n-- list orders\n${SQL}`);
    expect(toast.success).toHaveBeenCalledWith('Saved to Daily report', expect.anything());
    // The dialog closes after saving.
    expect(screen.queryByTestId('postgres-save-note-confirm')).toBeNull();
    // Last-save target is remembered so the next save preselects the note.
    expect(localStorage.getItem('nexterm.notes.lastSaveTarget')).toBe(notes[0].id);
  });

  it('g2. creates a new note with a `-- comment` header line', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Weekly report' } });
      fireEvent.change(screen.getByTestId('postgres-save-note-comment'), {
        target: { value: 'top sellers' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('postgres-save-note-confirm'));
    });

    const notes = NotesStorage.load();
    expect(notes).toHaveLength(2);
    const created = notes.find((note) => note.title === 'Weekly report');
    expect(created).toBeTruthy();
    expect(created!.language).toBe('sql');
    expect(created!.content).toBe(`-- top sellers\n${SQL}`);
    expect(toast.success).toHaveBeenCalledWith('Saved to Weekly report', expect.anything());
  });

  it('g3. blocks re-appending the same comment block (duplicate detection)', async () => {
    seedNotes([
      makeNote({ title: 'Daily report', language: 'sql', content: 'SELECT 1;' }),
    ]);
    await openDialog();
    const input = await openCombobox();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Daily report' } });
      fireEvent.change(screen.getByTestId('postgres-save-note-comment'), {
        target: { value: 'list orders' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('postgres-save-note-confirm'));
    });
    expect(NotesStorage.load()[0].content).toContain('-- list orders');

    // Re-open and try to save the same comment again.
    await act(async () => {
      fireEvent.click(screen.getByTestId('postgres-save-to-notes'));
    });
    await openCombobox();
    await act(async () => {
      fireEvent.change(screen.getByTestId('postgres-save-note-title'), {
        target: { value: 'Daily report' },
      });
      fireEvent.change(screen.getByTestId('postgres-save-note-comment'), {
        target: { value: 'list orders' },
      });
    });
    const duplicate = screen.getByTestId('postgres-save-note-duplicate');
    expect(duplicate).toBeTruthy();
    expect(duplicate.className).toContain('bg-destructive/10');
    expect(duplicate.querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('postgres-save-note-confirm').hasAttribute('disabled')).toBe(true);
  });

  it('h. constrains long titles to the combobox and dialog viewport', async () => {
    await openDialog();
    const input = await openCombobox();
    const longTitle = 'A very long note title '.repeat(20);

    await act(async () => {
      fireEvent.change(input, { target: { value: longTitle } });
    });

    const triggerValue = screen.getByTestId('postgres-save-note-target').firstElementChild;
    expect(triggerValue?.className).toContain('min-w-0');
    expect(triggerValue?.className).toContain('flex-1');
    expect(triggerValue?.className).toContain('truncate');

    expect(input.className).toContain('truncate');
    const popover = input.closest<HTMLElement>('[data-slot="popover-content"]');
    expect(popover).toBeTruthy();
    expect(popover!.className).toContain('max-w-[calc(100vw-3rem)]');
    expect(popover!.style.width).toBe('min(var(--radix-popover-trigger-width), calc(100vw - 3rem))');
  });
});
