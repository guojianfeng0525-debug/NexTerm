import { expect } from '@wdio/globals';

describe('SQLite native workspace', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
  });

  it('opens a temporary real SQLite database and verifies a real query result', async () => {
    const fixturePath = process.env.NEXTERM_SQLITE_E2E_PATH;
    if (!fixturePath) throw new Error('SQLite E2E fixture path is unavailable');

    const password = `E2E_${Date.now()}`;
    await $('#app-lock-password').waitForDisplayed();
    await $('#app-lock-password').setValue(password);
    await $('#app-lock-confirm').setValue(password);
    await $('#app-lock-submit, button.w-full').click();

    await $('[data-testid="toolbox-nav-sqlite"]').waitForDisplayed();
    await $('[data-testid="toolbox-nav-sqlite"]').click();
    await $('[data-testid="sqlite-new-connection"]').click();
    const dialog = await $('[data-testid="sqlite-connection-dialog"]');
    await browser.saveScreenshot('./test-results/database-visual/sqlite-dialog-after.png');
    const inputs = await dialog.$$('input');
    await inputs[0]!.clearValue();
    await inputs[0]!.setValue('NexTerm Native SQLite');
    await inputs[1]!.setValue(fixturePath);
    await dialog.$('button=打开').click();

    await expect($('[data-testid="sqlite-disconnect"]')).toBeEnabled();
    await $('button=users').waitForDisplayed();
    const workspace = await $('[data-testid="sqlite-workspace"]');
    const editor = await workspace.$('.cm-content');
    await editor.click();
    await editor.clearValue();
    await editor.setValue('SELECT id, name FROM users ORDER BY id');
    await $('[data-testid="sqlite-run"]').click();
    const result = await workspace.$('table');
    await result.waitForDisplayed();
    expect(await result.getText()).toContain('Alice');
    expect(await result.getText()).toContain('Bob');
    await browser.saveScreenshot('./test-results/database-visual/sqlite-workspace-after.png');
    await expect($('[data-testid="sqlite-explain"]')).not.toBeExisting();

    await $('[data-testid="sqlite-delete-connection"]').click();
    await $('button=删除').click();
    await expect($('[data-testid="sqlite-edit-connection"]')).toBeDisabled();
  });
});
