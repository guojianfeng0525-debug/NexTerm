import { expect } from '@wdio/globals';

async function configureTheme(label: '深色' | '浅色') {
  await $('button:has(svg.lucide-settings)').click();
  const settingsDialog = await $('[role="dialog"]');
  await settingsDialog.$('button=界面').click();
  await settingsDialog.$('[role="combobox"]').click();
  await $(`[role="option"]=${label}`).click();
  await settingsDialog.$('button=保存设置').click();
  await settingsDialog.waitForExist({ reverse: true });
}

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
    await configureTheme('深色');

    await $('[data-testid="toolbox-nav-sqlite"]').waitForDisplayed();
    await $('[data-testid="toolbox-nav-sqlite"]').click();
    await $('[data-testid="sqlite-new-connection"]').click();
    const dialog = await $('[data-testid="sqlite-connection-dialog"]');
    await browser.saveScreenshot('./test-results/database-visual/sqlite-dialog-after.png');
    await browser.keys('Escape');
    await dialog.waitForExist({ reverse: true });
    await configureTheme('浅色');
    await $('[data-testid="sqlite-new-connection"]').click();
    const lightDialog = await $('[data-testid="sqlite-connection-dialog"]');
    await browser.saveScreenshot('./test-results/database-visual/sqlite-dialog-light-after.png');
    await browser.setWindowSize(960, 700);
    await browser.saveScreenshot('./test-results/database-visual/sqlite-dialog-small-after.png');
    await browser.setWindowSize(2048, 1200);
    const inputs = await lightDialog.$$('input');
    await inputs[0]!.clearValue();
    await inputs[0]!.setValue('NexTerm Native SQLite');
    await inputs[1]!.setValue(fixturePath);
    await lightDialog.$('button=打开').click();

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
