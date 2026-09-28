import { invoke } from '@tauri-apps/api/core';

const PASSWORD_SELECTOR = 'input[type="password"], input[data-password-input]';

function isPasswordInput(element: Element | null): boolean {
  return element instanceof HTMLInputElement && element.matches(PASSWORD_SELECTOR);
}

/** Keep Windows IME closed only while a password field has focus. */
export function installPasswordImeHandling(
  documentRoot: Document = document,
  windows = /Windows/i.test(navigator.userAgent),
): () => void {
  if (!windows || !('__TAURI_INTERNALS__' in window)) return () => undefined;
  let passwordFocused = false;
  let blurTimer: number | undefined;

  const apply = (active: boolean) => {
    if (passwordFocused === active) return;
    passwordFocused = active;
    void invoke('set_password_ime', { active }).catch((error: unknown) => {
      console.error('[password-ime] failed to update Windows input mode:', error);
    });
  };
  const sync = () => apply(isPasswordInput(documentRoot.activeElement));
  const onFocusIn = () => {
    window.clearTimeout(blurTimer);
    sync();
  };
  const onFocusOut = () => {
    // Focus often moves directly between two password fields. Check the final
    // active element after that transition instead of reopening IME briefly.
    blurTimer = window.setTimeout(sync, 0);
  };
  const onCompositionStart = (event: CompositionEvent) => {
    if (!isPasswordInput(event.target as Element | null)) return;
    // The user may manually reopen an IME while the field is focused.
    void invoke('set_password_ime', { active: true }).catch((error: unknown) => {
      console.error('[password-ime] failed to restore Latin input mode:', error);
    });
  };

  documentRoot.addEventListener('focusin', onFocusIn);
  documentRoot.addEventListener('focusout', onFocusOut);
  documentRoot.addEventListener('compositionstart', onCompositionStart);
  sync();
  return () => {
    window.clearTimeout(blurTimer);
    documentRoot.removeEventListener('focusin', onFocusIn);
    documentRoot.removeEventListener('focusout', onFocusOut);
    documentRoot.removeEventListener('compositionstart', onCompositionStart);
    apply(false);
  };
}
