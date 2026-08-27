import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

describe('PostgreSQL quick execution', () => {
  it('executes SQL through the selected connection event', async () => {
    await browser.tauri.switchWindow('main');
    await unlockApp(`E2E_${Date.now()}`);
    await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    const name = `Quick ${Date.now()}`;
    await inputs[0].setValue(name); await inputs[1].setValue('127.0.0.1');
    await browser.execute((input: HTMLInputElement) => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, '55432'); input.dispatchEvent(new Event('input', { bubbles: true })); }, inputs[2]);
    await inputs[3].setValue('nexterm_e2e'); await inputs[4].setValue('nexterm_e2e'); await inputs[5].setValue('nexterm_e2e');
    await dialog.$('button=保存').click(); await browser.keys('Escape');
    const rows = await browser.execute(() => (window as any).__TAURI_INTERNALS__.invoke('row_list', { table: 'postgres_connections' }));
    const row = (rows as any[]).find((item) => item.name === name);
    await browser.execute((connectionId: string) => window.dispatchEvent(new CustomEvent('nexterm:quick-execute-postgres', { detail: { connectionId, content: 'SELECT 7331 AS quick_value' } })), row.id);
    await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
    await browser.waitUntil(async () => (await $('.cm-content').getText()).includes('7331'), { timeout: 10000 });
    expect(await $('[data-testid="postgres-tab-connection"]').getText()).toContain(name);
  });
});
