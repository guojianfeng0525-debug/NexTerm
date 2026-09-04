import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

interface WebglAddonWithRenderer {
  dispose(): void;
  _renderer?: {
    _gl?: WebGL2RenderingContext | null;
  } | null;
}

interface WebGLLoseContextExtension {
  loseContext(): void;
}

const terminalsSharingAtlasRefreshes = new Set<Terminal>();

/**
 * Register a live terminal so clearing a shared glyph atlas can refresh it.
 *
 * Terminals with identical font/theme/DPR options share one texture atlas.
 * @xterm/addon-webgl 0.19's clearTextureAtlas() only invalidates the caller's
 * render model, so another owner can keep stale texture coordinates and draw
 * wrong glyphs after a theme/font change. Refresh every live owner after any
 * owner clears the shared atlas.
 */
export function registerTerminalForAtlasRefresh(terminal: Terminal): () => void {
  terminalsSharingAtlasRefreshes.add(terminal);
  return () => {
    terminalsSharingAtlasRefreshes.delete(terminal);
  };
}

export function clearSharedTextureAtlas(terminal: Terminal): void {
  // This public method is renderer-specific and may be absent in tests or when
  // the DOM renderer is active.
  if (typeof terminal.clearTextureAtlas !== 'function') return;

  terminal.clearTextureAtlas();
  for (const otherTerminal of terminalsSharingAtlasRefreshes) {
    if (otherTerminal.rows > 0) {
      otherTerminal.refresh(0, otherTerminal.rows - 1);
    }
  }
}

/**
 * Dispose an xterm WebGL addon and deterministically release its GPU context.
 *
 * @xterm/addon-webgl 0.19 removes its canvas on dispose, but Chromium keeps
 * the underlying WebGL2 context alive until garbage collection. In a terminal
 * workspace that opens and closes tabs/splits over its lifetime, those zombie
 * contexts accumulate until Chromium force-evicts the oldest LIVE context
 * (about 16 contexts on many Windows/WebView2 configurations). The evicted
 * context can belong to an on-screen terminal, which then renders garbled or
 * blank glyphs.
 *
 * WEBGL_lose_context.loseContext() is the standard explicit release path.
 * Upstream has not released the fix yet (xterm.js#6068/#6069), so release the
 * private renderer context from the app lifecycle boundary until a patched
 * stable addon is available.
 */
export function disposeWebglAddon(addon: WebglAddon | null): void {
  if (!addon) return;

  let gl: WebGL2RenderingContext | null | undefined;
  try {
    gl = (addon as unknown as WebglAddonWithRenderer)._renderer?._gl;
    addon.dispose();
  } catch (error) {
    // The renderer can already be disposed during a context-loss race. The
    // important part is to continue below and release the old GL handle.
    console.warn('[PTY Terminal] WebGL addon dispose failed:', error);
  } finally {
    try {
      const extension = gl?.getExtension('WEBGL_lose_context') as WebGLLoseContextExtension | null;
      extension?.loseContext();
    } catch (error) {
      console.warn('[PTY Terminal] WebGL context release failed:', error);
    }
  }
}
