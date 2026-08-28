import { expect } from '@wdio/globals';
import { unlockApp } from './helpers/webkit';

describe('TOFU diag', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
  });

  it('dumps initial UI state after unlock', async () => {
    await unlockApp(`diag${Date.now()}`);
    await browser.pause(1500);
    const info = await browser.execute(() => {
      const lang = document.documentElement.lang || 'n/a';
      const buttons = Array.from(document.querySelectorAll('button'));
      const visibleTexts = buttons
        .map((b) => ({ text: (b.textContent || '').trim().slice(0, 30), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, d: getComputedStyle(b).display }))
        .filter((b) => b.w > 0 && b.h > 0 && b.d !== 'none');
      const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((t) => (t.textContent || '').trim());
      return {
        lang,
        html: document.body.innerText.slice(0, 500),
        visibleButtons: visibleTexts.slice(0, 30),
        tabs,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).length,
      };
    });
    console.log('DIAG_LANG:', info.lang);
    console.log('DIAG_BODY:', JSON.stringify(info.html));
    console.log('DIAG_BUTTONS:', JSON.stringify(info.visibleButtons));
    console.log('DIAG_TABS:', JSON.stringify(info.tabs));
    console.log('DIAG_DIALOGS:', info.dialogs);
    expect(true).toBe(true);
  });
});
