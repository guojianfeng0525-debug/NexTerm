import { expect } from '@wdio/globals';

describe('PostgreSQL visual workspace', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
  });

  it('captures an isolated PostgreSQL workspace with live catalog data', async () => {
    const password = `E2E_${Date.now()}`;
    await $('#app-lock-password').waitForDisplayed();
    await $('#app-lock-password').setValue(password);
    await $('#app-lock-confirm').setValue(password);
    await $('#app-lock-submit, button.w-full').click();

    const postgres = await $('[data-testid="toolbox-nav-postgres"]');
    await postgres.waitForDisplayed();
    await postgres.click();
    await $('[data-testid="postgres-new-connection"]').click();

    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    const inputs = await dialog.$$('input');
    for (const input of inputs) await input.clearValue();
    await inputs[0].setValue('NexTerm Visual PostgreSQL');
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

    await browser.pause(2_000);
    await browser.saveScreenshot('./test-results/postgres/debug-after-connect.png');
    await expect($('[data-testid="postgres-explain"]')).toBeEnabled();
    await $('button=users').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/02-database-tree.png');
    await browser.saveScreenshot('./test-results/postgres/03-object-list.png');

    const workspace = await $('[data-testid="postgres-workspace"]');
    const editor = await workspace.$('.cm-content');
    await editor.click();
    await editor.setValue(
      'SELECT id, username, email, age, active, credit, created_at, last_login FROM public.users ORDER BY username LIMIT 20;',
    );
    await browser.saveScreenshot('./test-results/postgres/04-query-editor.png');
    await workspace.$('button[title="运行"]').click();
    await workspace.$('table').waitForDisplayed();
    await expect(await workspace.$$('tbody tr')).toBeElementsArrayOfSize(20);
    await browser.saveScreenshot('./test-results/postgres/05-query-result.png');

    await $('button=users').doubleClick();
    await browser.pause(500);
    await browser.saveScreenshot('./test-results/postgres/06-table-data.png');
    await expect($('button=users')).toBeDisplayed();
  });
});
