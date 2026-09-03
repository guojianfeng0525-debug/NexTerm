import { describe, expect, it } from 'vitest';

import { resolveCapsLockState } from '../desktop-utils';

function keyboardEvent(options: {
  key: string;
  shiftKey?: boolean;
  capsLock?: boolean;
}) {
  return {
    key: options.key,
    shiftKey: options.shiftKey ?? false,
    getModifierState: (modifier: string) =>
      modifier === 'CapsLock' && (options.capsLock ?? false),
  };
}

describe('resolveCapsLockState', () => {
  it('derives CapsLock from the produced letter rather than stale WebView state', () => {
    // Windows can report false after CapsLock was enabled; the produced 'A'
    // proves that CapsLock is effectively on.
    expect(resolveCapsLockState(keyboardEvent({ key: 'A', capsLock: false }))).toBe(true);
    expect(resolveCapsLockState(keyboardEvent({ key: 'a', capsLock: true }))).toBe(false);
  });

  it('combines CapsLock with Shift using XOR semantics', () => {
    expect(resolveCapsLockState(keyboardEvent({ key: 'A', shiftKey: true }))).toBe(false);
    expect(resolveCapsLockState(keyboardEvent({ key: 'a', shiftKey: true }))).toBe(true);
  });

  it('falls back to getModifierState for non-letter keys', () => {
    expect(resolveCapsLockState(keyboardEvent({ key: 'CapsLock', capsLock: true }))).toBe(true);
    expect(resolveCapsLockState(keyboardEvent({ key: '1', capsLock: false }))).toBe(false);
  });
});
