import { expect } from '@wdio/globals';
import { waitForVisible, unlockApp } from './helpers/webkit';

describe('NexTerm native desktop smoke', () => {
  before(async () => {
    // Embedded WebDriver already targets the main window. Mark it explicit so
    // the service does not issue unsupported focus IPC before every command.
    await browser.tauri.switchWindow('main');
  });

  it('sets up an isolated lock profile and opens the vault workspace', async () => {
    const password = `E2E_${Date.now()}`;

    // WebKit isDisplayed returns false for form controls (see helpers/webkit.ts);
    // unlockApp verifies real visibility via getBoundingClientRect instead.
    await unlockApp(password);

    const vaultNavigation = await waitForVisible('button[aria-label="Vault"], button[aria-label="记录本"]');
    await vaultNavigation.click();
    await expect(vaultNavigation).toHaveAttribute('aria-current', 'page');

    await browser.saveScreenshot('./test-results/wdio/smoke-vault.png');
  });
});
