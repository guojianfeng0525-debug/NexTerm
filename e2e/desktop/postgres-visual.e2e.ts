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
    await expect($('[data-testid="postgres-new-query"]')).toBeDisabled();
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
    if (!(await $('[data-testid="postgres-run"]').isEnabled())) {
      const errors = await $$('[data-sonner-toast][data-type="error"]');
      const details: string[] = [];
      for (const toast of errors) details.push(await toast.getText());
      throw new Error(`PostgreSQL E2E connection did not complete: ${details.join(' | ') || 'no error toast found'}`);
    }
    await expect($('[data-testid="postgres-run"]')).toBeEnabled();
    await expect($('[data-testid="postgres-explain"]')).toBeEnabled();
    await expect($('[data-testid="postgres-new-query"]')).toBeEnabled();
    await expect($('[data-testid="postgres-disconnect"]')).toBeEnabled();
    await $('button=users').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/02-database-tree.png');
    await browser.saveScreenshot('./test-results/postgres/03-object-list.png');

    const workspace = await $('[data-testid="postgres-workspace"]');
    const editor = await workspace.$('.cm-content');
    await editor.click();
    await editor.clearValue();
    await expect($('[data-testid="postgres-run"]')).toBeEnabled();
    await editor.setValue('SELECT pg_sleep(1);');
    await $('[data-testid="postgres-run"]').click();
    await expect($('[data-testid="postgres-run"]')).toBeDisabled();
    await expect($('[data-testid="postgres-run"]')).toBeEnabled();
    await editor.clearValue();
    await editor.setValue(
      'SELECT id, username, email, age, active, credit, created_at, last_login FROM public.users ORDER BY username LIMIT 20;',
    );
    await browser.saveScreenshot('./test-results/postgres/04-query-editor.png');
    await $('[data-testid="postgres-run"]').click();
    await workspace.$('table').waitForDisplayed();
    expect((await workspace.$$('tbody tr')).length).toBeGreaterThan(0);
    await browser.saveScreenshot('./test-results/postgres/05-query-result.png');

    const tablesGroup = await $('[data-node-id*="/group:relations"]');
    await tablesGroup.click();
    await expect($('button=users')).not.toBeExisting();
    await tablesGroup.click();
    await expect($('button=users')).toBeDisplayed();
    await $('[data-testid="postgres-refresh"]').click();
    await browser.pause(500);
    await $('button=users').click();
    await browser.pause(500);
    await browser.saveScreenshot('./test-results/postgres/06-table-data.png');
    await expect($('button=users')).toBeDisplayed();

    await $('[data-testid="postgres-disconnect"]').click();
    await expect($('[data-testid="postgres-connect"]')).toBeEnabled();
    await expect($('[data-testid="postgres-disconnect"]')).not.toBeExisting();
  });
});
