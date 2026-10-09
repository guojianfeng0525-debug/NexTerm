import { useRef } from 'react';
import { isWorkspaceVisible } from '@/lib/workspace-activity';

/** Controlled dialogs often have no Radix Trigger to receive focus on close. */
export function useDialogFocus(onOpen?: (event: Event) => void, onClose?: (event: Event) => void) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      previousFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement : null;
      onOpen?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onClose?.(event);
      if (!event.defaultPrevented && isWorkspaceVisible(previousFocus.current)) {
        event.preventDefault();
        previousFocus.current?.focus({ preventScroll: true });
      }
    },
  };
}
