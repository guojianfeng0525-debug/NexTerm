import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Portals and hidden tabs stay mounted. Their actions must still belong to a visible workspace. */
export function isWorkspaceVisible(root: HTMLElement | null): boolean {
  if (!root?.isConnected) return false;
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    if (element.hidden || element.classList.contains('hidden')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

export function ownsWorkspaceKey(root: HTMLElement | null, event: {
  target: EventTarget | null;
  defaultPrevented: boolean;
  isComposing?: boolean;
}): boolean {
  return !event.defaultPrevented && !event.isComposing && isWorkspaceVisible(root)
    && event.target instanceof Element && Boolean(root?.contains(event.target))
    && !event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
    && !document.querySelector('[role="dialog"], [role="alertdialog"]');
}

/** Observe ancestor visibility too: the tab portal's React owner is outside the page DOM. */
export function useWorkspaceActivity(rootRef: RefObject<HTMLElement | null>, enabled = true) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [visible, setVisible] = useState(false);
  const isCurrent = useCallback(() => enabledRef.current && isWorkspaceVisible(rootRef.current), [rootRef]);

  useLayoutEffect(() => {
    const update = () => setVisible(isCurrent());
    update();
    const observer = new MutationObserver((records) => {
      const root = rootRef.current;
      if (!root || records.some(record =>
        record.target instanceof Element && record.target.contains(root)
        || [...record.addedNodes, ...record.removedNodes].some(node => node.contains(root)),
      )) update();
    });
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    return () => observer.disconnect();
  }, [enabled, isCurrent, rootRef]);

  return { active: enabled && visible, isCurrent };
}
