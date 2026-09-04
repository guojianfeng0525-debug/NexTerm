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
 * 注册仍在使用的终端，确保清空共享 glyph atlas 后能刷新所有持有者。
 *
 * 字体、主题和 DPR 配置相同的终端会共享同一个纹理 atlas。
 * @xterm/addon-webgl 0.19 的 clearTextureAtlas() 只会让调用方自己的渲染
 * 模型失效，其他持有者可能继续保留过期纹理坐标，并在主题/字体变化后画出
 * 错误 glyph。因此任意持有者清空共享 atlas 后，必须刷新所有存活持有者。
 */
export function registerTerminalForAtlasRefresh(terminal: Terminal): () => void {
  terminalsSharingAtlasRefreshes.add(terminal);
  return () => {
    terminalsSharingAtlasRefreshes.delete(terminal);
  };
}

export function clearSharedTextureAtlas(terminal: Terminal): void {
  // 该公开方法属于特定渲染器；测试替身或 DOM 渲染器可能没有这个方法。
  if (typeof terminal.clearTextureAtlas !== 'function') return;

  terminal.clearTextureAtlas();
  for (const otherTerminal of terminalsSharingAtlasRefreshes) {
    if (otherTerminal.rows > 0) {
      otherTerminal.refresh(0, otherTerminal.rows - 1);
    }
  }
}

/**
 * 销毁 xterm WebGL addon，并确定性地释放它的 GPU context。
 *
 * @xterm/addon-webgl 0.19 销毁时只移除 canvas，Chromium 会把底层 WebGL2
 * context 保留到垃圾回收。终端工作区长期开关标签/分栏时，这些僵尸 context
 * 会持续累积，直到 Chromium 强制驱逐最旧的存活 context（许多 Windows/
 * WebView2 配置约为 16 个）。被驱逐的可能是仍在屏幕上的终端，随后就会
 * 出现花屏或空白 glyph。
 *
 * WEBGL_lose_context.loseContext() 是标准的显式释放入口。上游尚未发布
 * 修复（xterm.js#6068/#6069），因此在稳定版补丁发布前，由应用生命周期
 * 边界释放渲染器的私有 GL context。
 */
export function disposeWebglAddon(addon: WebglAddon | null): void {
  if (!addon) return;

  let gl: WebGL2RenderingContext | null | undefined;
  try {
    gl = (addon as unknown as WebglAddonWithRenderer)._renderer?._gl;
    addon.dispose();
  } catch (error) {
    // context-loss 竞争中渲染器可能已被销毁。关键是继续执行下方逻辑，
    // 释放旧的 GL 句柄。
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
