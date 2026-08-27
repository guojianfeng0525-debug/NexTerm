/**
 * Bug 2 fix verification — the global contextmenu suppression (bubble-phase
 * preventDefault on window) must:
 *   (a) cancel the native WebKit menu for areas without a custom handler, and
 *   (b) NOT break Radix context menus (navigator node right-click).
 *
 * Real-app evidence: b21-context-menu.e2e.ts passes with the fix in place;
 * this spec additionally asserts the global cancellation and the menu opening.
 */
import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

const UNIQUE = `ctx${Date.now()}`;

async function connectPostgres() {
  await waitForVisible('[data-testid="toolbox-nav-postgres"]');
  await $('[data-testid="toolbox-nav-postgres"]').click();
  await $('[data-testid="postgres-new-connection"]').waitForEnabled();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  await inputs[0].setValue(`BugFix Menu ${UNIQUE}`);
  await inputs[1].setValue('127.0.0.1');
  await browser.execute((input: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '55432');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, inputs[2]);
  await inputs[3].setValue('nexterm_e2e');
  await inputs[4].setValue('nexterm_e2e');
  await inputs[5].setValue('nexterm_e2e');
  await dialog.$('button=连接').click();
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
}

describe('bugfix: global contextmenu suppression', () => {
  const PW = 'E2E_ctx_fix_pw';

  it('cancels the native menu and keeps Radix context menus working', async () => {
    await browser.tauri.switchWindow('main');
    await unlockApp(PW);

    // (a) A contextmenu event dispatched on blank space must be cancelled.
    const prevented = await browser.execute(() => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 });
      const dispatchReturned = document.body.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, dispatchReturned };
    });
    console.log('CTXMENU SUPPRESSED:', JSON.stringify(prevented));
    expect(prevented).toEqual({ defaultPrevented: true, dispatchReturned: false });

    // (b) Radix custom menu on a navigator node still opens on real right-click.
    await connectPostgres();
    await $('[data-node-id*="connection:"]').waitForDisplayed({ timeout: 10000 });
    await browser.pause(600);
    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    if (!(await $('button=users').isExisting())) {
      await tablesGroup.click();
    }
    await waitForVisible('button=users');

    const menu = await $('[data-testid="database-navigator-context-menu"]');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await $('button=users').click({ button: 'right' });
      try {
        await waitForVisible('[data-testid="database-navigator-context-menu"]', 3000);
        break;
      } catch {
        await browser.keys('Escape');
        await browser.pause(400);
      }
    }
    const menuText = await menu.getText();
    console.log('CONTEXT MENU TEXT:', JSON.stringify(menuText));
    expect(menuText).toContain('打开数据');
    expect(menuText).toContain('复制名称');
    await browser.keys('Escape');
    await menu.waitForExist({ reverse: true });
  });
});
