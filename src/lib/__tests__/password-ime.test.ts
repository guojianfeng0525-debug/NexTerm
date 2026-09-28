import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { installPasswordImeHandling } from '../password-ime';

afterEach(() => {
  document.body.replaceChildren();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invoke.mockClear();
});

describe('Windows password IME handling', () => {
  it('closes IME for password focus and restores it after focus leaves', async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    const dispose = installPasswordImeHandling(document, true);
    input.focus();
    expect(invoke).toHaveBeenCalledWith('set_password_ime', { active: true });
    input.blur();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_password_ime', { active: false }));
    dispose();
  });

  it('recognizes revealed password fields and reapplies Latin mode on composition', () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.passwordInput = '';
    document.body.append(input);
    const dispose = installPasswordImeHandling(document, true);
    input.focus();
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(invoke).toHaveBeenCalledTimes(2);
    dispose();
  });
});
