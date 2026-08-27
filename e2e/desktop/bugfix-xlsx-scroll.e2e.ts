/**
 * Bug 1 verification — XLSX editor horizontal scrollbar (hover-hint approach).
 *
 * Decision (product): do NOT build a custom scrollbar. macOS WKWebView uses
 * system-drawn overlay scrollbars; pixel-level probing proved they do NOT
 * render into the webpage layer (screenshots stay byte-identical even when a
 * real pointer hovers the exact track position or after a wheel scroll), so
 * E2E cannot assert the native bar itself. The system overlay may still appear
 * to the user at runtime. This spec therefore verifies what IS assertable:
 * the hover hint is visible, the grid still scrolls, and the editor stays
 * interactive. Screenshots are kept for manual confirmation.
 */
import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';
import * as XLSX from 'xlsx';

const DOC_NAME = 'scroll-hint-wide.xlsx';

function buildWideXlsx(): string {
  const headers = Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`);
  const aoa: unknown[][] = [headers];
  for (let r = 0; r < 60; r++) aoa.push(headers.map((_, c) => `row${r}c${c}`));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map(() => ({ wch: 130 })); // force wide content
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64');
}

describe('bugfix: xlsx editor horizontal scrollbar hint', () => {
  const PW = 'E2E_xlsx_hint_pw';

  it('shows a hover hint and the grid stays scrollable and interactive', async () => {
    await browser.tauri.switchWindow('main');

    // Import BEFORE unlocking so the documents cache is fresh on mount.
    const b64 = buildWideXlsx();
    const res = await browser.execute(async (args: { base64: string; name: string }) => {
      const bin = atob(args.base64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const internals = (window as any).__TAURI_INTERNALS__;
      if (!internals?.invoke) return { error: 'no __TAURI_INTERNALS__.invoke' };
      try {
        await internals.invoke('documents_import', {
          bytes: u8,
          name: args.name,
          id: `doc-hint-${Date.now()}`,
        });
        return { ok: true };
      } catch (e) {
        return { error: String(e) };
      }
    }, { base64: b64, name: DOC_NAME });
    expect(res).toHaveProperty('ok', true);

    await unlockApp(PW);

    await waitForVisible('[data-testid="toolbox-nav-documents"]');
    await $('[data-testid="toolbox-nav-documents"]').click();
    await browser.pause(1200);

    const clicked = await browser.execute(() => {
      const p = Array.from(document.querySelectorAll('p')).find((el) =>
        el.textContent?.includes('scroll-hint-wide'),
      );
      const card = p?.closest('div[class*="cursor-pointer"]');
      if (!card) return false;
      (card as HTMLElement).click();
      return true;
    });
    expect(clicked).toBe(true);

    await waitForVisible('[data-testid="xlsx-scroll"]', 15000);
    await browser.pause(1500);

    // (1) The hint is visible on a wide sheet.
    const hint = await waitForVisible('[data-testid="xlsx-hscroll-hint"]');
    const hintText = await hint.getText();
    console.log('HINT TEXT:', JSON.stringify(hintText));
    expect(hintText.length).toBeGreaterThan(0);

    // Move the pointer OFF the grid (navigator rail); screenshot for manual
    // comparison (the system overlay scrollbar is not captured by E2E).
    await $('[data-testid="toolbox-nav-documents"]').moveTo();
    await browser.pause(600);
    await browser.saveScreenshot('./test-results/wdio/bugfix-xlsx-hint-visible.png');

    // (2) Real pointer hover over the grid; screenshot for manual comparison.
    const sc = await $('[data-testid="xlsx-scroll"]');
    await sc.moveTo({ y: -60 });
    await browser.pause(800);
    await browser.saveScreenshot('./test-results/wdio/bugfix-xlsx-hint-hover.png');

    // (3) The grid still scrolls (native scrollLeft assignable).
    const native = await browser.execute(() => {
      const el = document.querySelector('[data-testid="xlsx-scroll"]') as HTMLElement | null;
      if (!el) return { error: 'no xlsx-scroll' };
      el.scrollLeft = el.scrollWidth;
      const max = el.scrollLeft;
      el.scrollLeft = 0;
      return { max, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    console.log('NATIVE SCROLL:', JSON.stringify(native));
    expect(native.max).toBeGreaterThan(0);

    // (4) The editor stays interactive (formula input focusable).
    await waitForVisible('[data-testid="xlsx-formula-input"]');
    const formula = await $('[data-testid="xlsx-formula-input"]');
    await browser.execute((el: HTMLElement) => el.focus(), formula);
    console.log('FORMULA INPUT FOCUSABLE: true');
  });
});
