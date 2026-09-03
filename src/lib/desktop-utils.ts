/**
 * Desktop viewer utility functions for coordinate translation and scaling.
 */

/**
 * Compute the scale factor for "Fit to Window" mode.
 * Returns a factor that preserves the aspect ratio while fitting the desktop
 * entirely within the container.
 */
export function computeFitScale(
  desktopWidth: number,
  desktopHeight: number,
  containerWidth: number,
  containerHeight: number,
): number {
  if (desktopWidth <= 0 || desktopHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return 1;
  }
  const scaleX = containerWidth / desktopWidth;
  const scaleY = containerHeight / desktopHeight;
  return Math.min(scaleX, scaleY);
}

/**
 * Resolve the effective CapsLock state from a keyboard event.
 *
 * `getModifierState('CapsLock')` is reliable for ordinary typing in most
 * browsers, but Windows WebView can report stale lock state. When the event
 * carries a produced ASCII letter, that letter is authoritative: uppercase is
 * produced by exactly one of Shift and CapsLock, never both.
 */
export function resolveCapsLockState(event: {
  key: string;
  shiftKey: boolean;
  getModifierState(key: string): boolean;
}): boolean {
  const { key, shiftKey } = event;
  if (key.length === 1 && ((key >= 'a' && key <= 'z') || (key >= 'A' && key <= 'Z'))) {
    const producedUppercase = key >= 'A' && key <= 'Z';
    return producedUppercase !== shiftKey;
  }
  return event.getModifierState('CapsLock');
}

/**
 * Translate browser mouse coordinates (relative to the displayed area) into
 * remote desktop coordinates, accounting for scaling and centering offset.
 *
 * Returns clamped coordinates within [0, desktopWidth) × [0, desktopHeight).
 */
export function translateCoordinates(
  browserX: number,
  browserY: number,
  desktopWidth: number,
  desktopHeight: number,
  displayedWidth: number,
  displayedHeight: number,
): { x: number; y: number } {
  if (displayedWidth <= 0 || displayedHeight <= 0) {
    return { x: 0, y: 0 };
  }
  const scaleX = desktopWidth / displayedWidth;
  const scaleY = desktopHeight / displayedHeight;
  const x = Math.max(0, Math.min(Math.round(browserX * scaleX), desktopWidth - 1));
  const y = Math.max(0, Math.min(Math.round(browserY * scaleY), desktopHeight - 1));
  return { x, y };
}
