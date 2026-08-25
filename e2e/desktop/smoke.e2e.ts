import { expect } from '@wdio/globals';

describe('NexTerm native desktop smoke', () => {
  before(async () => {
    // Embedded WebDriver already targets the main window. Mark it explicit so
    // the service does not issue unsupported focus IPC before every command.
    await browser.tauri.switchWindow('main');
  });

  it('sets up an isolated lock profile and opens the vault workspace', async () => {
    const password = `E2E_${Date.now()}`;

    await $('#app-lock-password').waitForDisplayed();
    await $('#app-lock-password').setValue(password);
    await $('#app-lock-confirm').setValue(password);
    await $('#app-lock-submit, button.w-full').click();

    const vaultNavigation = await $('button[aria-label="Vault"], button[aria-label="记录本"]');
    await vaultNavigation.waitForDisplayed();
    await vaultNavigation.click();
    await expect(vaultNavigation).toHaveAttribute('aria-current', 'page');

    await browser.saveScreenshot('./test-results/wdio/smoke-vault.png');
  });
});
