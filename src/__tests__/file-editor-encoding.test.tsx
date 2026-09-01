import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
  },
}));

vi.mock('../components/code-editor', () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="code-editor-mock"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="file-editor-encoding"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const { FileEditorView } = await import('../components/file-editor-view');

function renderEditor() {
  return render(
    <FileEditorView
      connectionId="connection-1"
      filePath="/tmp/encoding.txt"
      fileName="encoding.txt"
      isConnected
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === 'read_file_content_with_encoding') {
      return Promise.resolve({ content: 'UTF-8 内容', hadErrors: false });
    }
    return Promise.resolve(true);
  });
});

describe('FileEditorView encoding conversion', () => {
  it('loads text through the selected encoding', async () => {
    renderEditor();

    const editor = await screen.findByTestId('code-editor-mock');
    expect((editor as HTMLTextAreaElement).value).toBe('UTF-8 内容');
    expect(mocks.invoke).toHaveBeenCalledWith('read_file_content_with_encoding', {
      connectionId: 'connection-1',
      path: '/tmp/encoding.txt',
      encoding: 'utf-8',
    });
  });

  it('reloads a clean buffer when the encoding selection changes', async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file_content_with_encoding') {
        return Promise.resolve({ content: 'GBK 内容', hadErrors: false });
      }
      return Promise.resolve(true);
    });
    renderEditor();
    await screen.findByTestId('code-editor-mock');

    fireEvent.change(screen.getByTestId('file-editor-encoding'), {
      target: { value: 'gbk' },
    });

    const editor = await screen.findByTestId('code-editor-mock');
    await waitFor(() => {
      expect((editor as HTMLTextAreaElement).value).toBe('GBK 内容');
    });
    expect(mocks.invoke).toHaveBeenCalledWith('read_file_content_with_encoding', {
      connectionId: 'connection-1',
      path: '/tmp/encoding.txt',
      encoding: 'gbk',
    });
  });

  it('defers a dirty buffer conversion until save', async () => {
    renderEditor();
    const editor = (await screen.findByTestId('code-editor-mock')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '转换后的内容' } });
    fireEvent.change(screen.getByTestId('file-editor-encoding'), {
      target: { value: 'gbk' },
    });

    // One initial load only: changing encoding on a dirty buffer must not
    // discard the user's edits by reloading from the server.
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('create_file_with_encoding', {
        connectionId: 'connection-1',
        path: '/tmp/encoding.txt',
        content: '转换后的内容',
        encoding: 'gbk',
      });
    });
  });
});
