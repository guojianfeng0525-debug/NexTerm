import { describe, expect, it, vi } from 'vitest';
import type { WebglAddon } from '@xterm/addon-webgl';
import {
  clearSharedTextureAtlas,
  disposeWebglAddon,
  registerTerminalForAtlasRefresh,
} from '../webgl-lifecycle';

describe('disposeWebglAddon', () => {
  it('disposes the addon and explicitly releases its renderer GL context', () => {
    const order: string[] = [];
    const loseContext = vi.fn(() => order.push('loseContext'));
    const getExtension = vi.fn(() => ({ loseContext }));
    const addon = {
      dispose: vi.fn(() => order.push('dispose')),
      _renderer: {
        _gl: {
          getExtension,
        },
      },
    } as unknown as WebglAddon;

    disposeWebglAddon(addon);

    expect(order).toEqual(['dispose', 'loseContext']);
    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
  });

  it('still releases the GL context when addon disposal throws during a loss race', () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn(() => ({ loseContext }));
    const addon = {
      dispose: vi.fn(() => {
        throw new Error('already disposed');
      }),
      _renderer: {
        _gl: {
          getExtension,
        },
      },
    } as unknown as WebglAddon;

    disposeWebglAddon(addon);

    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });
});

describe('clearSharedTextureAtlas', () => {
  it('refreshes every live terminal sharing the atlas after one owner clears it', () => {
    const terminalA = {
      rows: 3,
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
    };
    const terminalB = {
      rows: 2,
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
    };
    const unregisterA = registerTerminalForAtlasRefresh(terminalA as never);
    const unregisterB = registerTerminalForAtlasRefresh(terminalB as never);

    try {
      clearSharedTextureAtlas(terminalA as never);
    } finally {
      unregisterA();
      unregisterB();
    }

    expect(terminalA.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(terminalB.clearTextureAtlas).not.toHaveBeenCalled();
    expect(terminalA.refresh).toHaveBeenCalledWith(0, 2);
    expect(terminalB.refresh).toHaveBeenCalledWith(0, 1);
  });

  it('is safe when the active renderer does not expose clearTextureAtlas', () => {
    expect(() => clearSharedTextureAtlas({ rows: 2 } as never)).not.toThrow();
  });
});
