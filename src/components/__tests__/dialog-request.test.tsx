import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDialogRequest } from '../ui/use-dialog-request';
import '@testing-library/jest-dom/vitest';

function Harness({ active = true, scope = 'server-a:/first', canConfirm = () => true, onResult }: {
  active?: boolean; scope?: string; canConfirm?: () => boolean; onResult: (value: unknown) => void;
}) {
  const { prompt, confirm, dialog } = useDialogRequest({ active, scopeKey: scope, canConfirm });
  return <>{dialog}<button onClick={() => { void confirm('Delete this local connection?').then(onResult); }}>Ask confirmation</button>
    <button onClick={() => { void prompt('Rename folder', 'old-name', name => !name.includes('/')).then(onResult); }}>Ask name</button></>;
}

describe('scoped styled dialog requests', () => {
  it('focuses Cancel and requires an explicit confirmation', async () => {
    const result = vi.fn();
    render(<Harness onResult={result} />);
    fireEvent.click(screen.getByText('Ask confirmation'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByText('Ask confirmation'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(true));
  });

  it('validates names and returns the typed value without trimming it', async () => {
    const result = vi.fn();
    render(<Harness onResult={result} />);
    fireEvent.click(screen.getByText('Ask name'));
    const input = screen.getByRole('textbox', { name: 'Rename folder' });
    expect(input).toHaveValue('old-name');
    fireEvent.change(input, { target: { value: '../other' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.change(input, { target: { value: ' spaced name ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(result).toHaveBeenCalledWith(' spaced name '));
  });

  it.each(['page', 'directory'])('cancels an open request on %s changes', async kind => {
    const result = vi.fn();
    const view = render(<Harness onResult={result} />);
    fireEvent.click(screen.getByText('Ask name'));
    view.rerender(<Harness onResult={result} active={kind !== 'page'} scope={kind === 'directory' ? 'server-b:/other' : undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(result).toHaveBeenCalledWith(null));
  });

  it('rechecks ownership even before visibility observers update', async () => {
    const result = vi.fn();
    let current = true;
    render(<Harness onResult={result} canConfirm={() => current} />);
    fireEvent.click(screen.getByText('Ask confirmation'));
    current = false;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
  });

  it('resolves pending requests as cancellation on unmount', async () => {
    const result = vi.fn();
    const view = render(<Harness onResult={result} />);
    fireEvent.click(screen.getByText('Ask name'));
    await act(async () => view.unmount());
    expect(result).toHaveBeenCalledWith(null);
  });
});
