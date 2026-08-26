import { expect } from '@wdio/globals';

async function rightClick(element: WebdriverIO.Element) {
  await element.click({ button: 'right' });
}

async function configureTheme(label: '深色' | '浅色') {
  await $('button:has(svg.lucide-settings)').click();
  const settingsDialog = await $('[role="dialog"]');
  await settingsDialog.$('button=界面').click();
  await settingsDialog.$('[role="combobox"]').click();
  await $(`[role="option"]=${label}`).click();
  await settingsDialog.$('button=保存设置').click();
  await settingsDialog.waitForExist({ reverse: true });
}

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
    await configureTheme('深色');

    const postgres = await $('[data-testid="toolbox-nav-postgres"]');
    await postgres.waitForDisplayed();
    await postgres.click();
    await expect($('[data-testid="postgres-new-query"]')).toBeDisabled();
    await $('[data-testid="postgres-new-connection"]').click();

    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    await browser.saveScreenshot('./test-results/database-visual/postgres-dialog-after.png');
    await browser.keys('Escape');
    await dialog.waitForExist({ reverse: true });
    await configureTheme('浅色');
    await $('[data-testid="postgres-new-connection"]').click();
    const lightDialog = await $('[data-testid="postgres-connection-dialog"]');
    await browser.saveScreenshot('./test-results/database-visual/postgres-dialog-light-after.png');
    await browser.setWindowSize(960, 700);
    await browser.saveScreenshot('./test-results/database-visual/postgres-dialog-small-after.png');
    await browser.setWindowSize(2048, 1200);
    const inputs = await lightDialog.$$('input');
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
    await lightDialog.$('button=连接').click();

    await $('[data-testid="postgres-run"]').waitForEnabled();
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
    await rightClick(await workspace.$('td:nth-child(2)'));
    await $('[data-testid="database-result-context-menu"]').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/05a-result-context-menu.png');
    await browser.keys('Escape');
    await configureTheme('深色');
    await browser.saveScreenshot('./test-results/database-visual/postgres-workspace-after.png');
    await configureTheme('浅色');
    await browser.saveScreenshot('./test-results/database-visual/postgres-workspace-light-after.png');
    await browser.setWindowSize(960, 700);
    await browser.saveScreenshot('./test-results/database-visual/postgres-workspace-small-after.png');
    await browser.setWindowSize(2048, 1200);

    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    await tablesGroup.click();
    await expect($('button=users')).not.toBeExisting();
    await tablesGroup.click();
    await expect($('button=users')).toBeDisplayed();
    await rightClick(await $('button=users'));
    await $('[data-testid="database-navigator-context-menu"]').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/06a-navigator-context-menu.png');
    await browser.keys('Escape');

    const connectionNode = await $('[data-node-id*="connection:"]');
    await rightClick(connectionNode);
    await $('[data-testid="database-navigator-context-menu"]').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/06b-connection-context-menu.png');
    await browser.keys('Escape');

    await $('[data-testid="postgres-refresh"]').click();
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, await $('button=users'));
    await workspace.$('tbody tr').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/06-table-data.png');
    await expect($('button=users')).toBeDisplayed();

    await workspace.$('button=Query').click();
    const queryEditor = await workspace.$('.cm-content');
    await queryEditor.click();
    await queryEditor.clearValue();
    await queryEditor.setValue('CREATE OR REPLACE VIEW public.e2e_users_view AS SELECT id, username FROM public.users;');
    await $('[data-testid="postgres-run"]').click();
    await $('[data-testid="postgres-refresh"]').click();
    const viewsGroup = await $('[data-node-id*="/group:views"]');
    await viewsGroup.click();
    await $('button=e2e_users_view').waitForDisplayed();
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, await $('button=e2e_users_view'));
    await workspace.$('tbody tr').waitForDisplayed();
    await browser.saveScreenshot('./test-results/postgres/06b-view-data.png');

    await $('[data-testid="postgres-disconnect"]').click();
    await expect($('[data-testid="postgres-connect"]')).toBeEnabled();
    await expect($('[data-testid="postgres-disconnect"]')).not.toBeExisting();
  });
});
