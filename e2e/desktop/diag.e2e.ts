import { expect } from '@wdio/globals';

/**
 * Diagnostic spec: inspect the WebView DOM state directly (no app-lock
 * interaction) to determine whether the frontend rendered at all.
 * Used to debug "app-lock not displayed" failures (S1-6 dist rebuild saga).
 */
describe('WebView diagnostics', () => {
  before(async () => {
    try {
      await browser.tauri.switchWindow('main');
    } catch {
      /* window switch may fail; the execute below will reveal state */
    }
  });

  it('reports WebView DOM state', async () => {
    const state = await browser.execute(() => {
      const lock = document.querySelector('#app-lock-password') as HTMLElement | null;
      const rect = lock?.getBoundingClientRect();
      const style = lock ? window.getComputedStyle(lock) : null;
      const topEl = lock && rect
        ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        : null;
      const topTag = topEl ? `${topEl.tagName}.${topEl.className}`.slice(0, 80) : null;
      const overlay = document.querySelector('[role="dialog"], .overlay, [class*="loading"], [class*="splash"]');
      return {
        ready: document.readyState,
        hasLock: !!lock,
        lockRect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        lockStyle: style
          ? { display: style.display, visibility: style.visibility, opacity: style.opacity, z: style.zIndex }
          : null,
        topAtLock: topTag,
        overlays: overlay ? overlay.className : null,
        win: { innerW: window.innerWidth, innerH: window.innerHeight },
        screen: { availW: screen.availWidth, availH: screen.availHeight, y: screenY },
      };
    });
    // eslint-disable-next-line no-console
    console.log('WEBVIEW_DIAG2 ' + JSON.stringify(state));
    // WebDriver-layer isDisplayed (the API waitForDisplayed relies on):
    const el = await $('#app-lock-password');
    let wdDisplayed = 'unknown';
    try {
      wdDisplayed = String(await el.isDisplayed());
    } catch (e) {
      wdDisplayed = 'err:' + String(e).slice(0, 80);
    }
    // eslint-disable-next-line no-console
    console.log('WD_ISDISPLAYED ' + wdDisplayed);
    // Can we interact despite isDisplayed=false? (bypass feasibility)
    let interact = 'unknown';
    try {
      await el.setValue('probe-pass');
      await el.setValue('');
      interact = 'setValue OK';
    } catch (e) {
      interact = 'err:' + String(e).slice(0, 100);
    }
    // eslint-disable-next-line no-console
    console.log('WD_INTERACT ' + interact);
    expect(state.hasLock).toBe(true);
  });
});
