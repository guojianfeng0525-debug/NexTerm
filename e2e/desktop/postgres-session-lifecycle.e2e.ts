import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

const NAME = `PG Lifecycle ${Date.now()}`;

async function setSql(sql: string) {
  await browser.execute((value: string) => {
    const content = document.querySelector('.cm-content') as HTMLElement | null;
    content?.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, value);
  }, sql);
}

describe('PostgreSQL session lifecycle', () => {
  it('saves SQL, closes its tabs on disconnect, and restores it after double-click reconnect', async () => {
    await browser.tauri.switchWindow('main');
    await unlockApp(`E2E_${Date.now()}`);
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    await inputs[0].setValue(NAME);
    await inputs[1].setValue('127.0.0.1');
    await browser.execute((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '55432'); input.dispatchEvent(new Event('input', { bubbles: true }));
    }, inputs[2]);
    await inputs[3].setValue('nexterm_e2e'); await inputs[4].setValue('nexterm_e2e'); await inputs[5].setValue('nexterm_e2e');
    await dialog.$('button=连接').click();
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
    await setSql('SELECT 4242 AS lifecycle_value;');
    await $('[data-testid="postgres-save-sql"]').click();
    await $('[data-testid="postgres-disconnect"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="postgres-disconnect"]').isExisting()), { timeout: 10000 });
    const node = await $(`button=${NAME}`);
    await browser.execute((element: HTMLElement) => element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), node);
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
    expect(await $('.cm-content').getText()).toContain('4242');
  });
});
