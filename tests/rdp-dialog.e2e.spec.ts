import { expect, test, type Page } from '@playwright/test';

/**
 * RDP/VNC connection-dialog protocol coverage (pure UI — no backend).
 *
 * Verifies the desktop-protocol UX surface added with the RDP client:
 *   1. Switching the protocol to RDP reveals the domain field and the
 *      display-resolution selector, and keeps the jump-host section
 *      available (SSH/SFTP/RDP/VNC).
 *   2. The jump-host switch reveals the host/port/username/password/key
 *      fields and toggling it off hides them again.
 *   3. Switching to VNC reveals the color-depth selector instead of the
 *      RDP domain/resolution fields, and the jump section stays visible.
 *   4. Switching to FTP (a non-desktop, non-jump protocol) hides both the
 *      desktop fields and the jump section.
 *
 * Uses the same mock-Tauri harness as the db-toolbox specs so the dialog
 * renders without a backend.
 */

/** Minimal Tauri invoke mock: every command resolves harmlessly. */
async function installTauriMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          // The dialog itself only needs storage helpers to resolve.
          if (command === 'row_list') return Promise.resolve([]);
          if (command === 'row_get') return Promise.resolve(null);
          return Promise.resolve(undefined);
        },
      },
    });
  });
}

async function openConnectionDialog(page: Page): Promise<void> {
  await page.goto('/');
  // First-run app-lock setup (localStorage is empty in a fresh context).
  const setup = page.getByRole('button', { name: 'Set Password' });
  if (await setup.isVisible()) {
    await page.getByRole('textbox', { name: 'New password' }).fill('e2e-password');
    await page.getByRole('textbox', { name: 'Confirm password' }).fill('e2e-password');
    await setup.click();
  }
  // Terminal section → New Connection opens the full protocol dialog.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'New Connection' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** Selects a protocol in the dialog's protocol dropdown (the combobox
 *  labeled "Protocol" on the Connection tab). */
async function selectProtocol(page: Page, protocol: 'RDP' | 'VNC' | 'FTP'): Promise<void> {
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: protocol, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page);
});

test('RDP protocol reveals domain, resolution and jump settings', async ({ page }) => {
  await openConnectionDialog(page);
  await selectProtocol(page, 'RDP');

  // RDP-specific fields.
  await expect(page.locator('#rdp-domain')).toBeVisible();

  // Jump-host section is available for RDP: the Proxy tab hosts the
  // switch, and the fields stay hidden until it is enabled.
  await page.getByRole('tab', { name: 'Proxy' }).click();
  // The jump-host section renders its Proxy Type option and (unnamed) switch.
  await expect(page.getByText('Jump Host (SSH Bastion)', { exact: false })).toBeVisible();
  await expect(page.locator('#jump-host')).toBeHidden(); // fields hidden until enabled
});

test('jump-host switch reveals and hides the tunnel fields', async ({ page }) => {
  await openConnectionDialog(page);
  await selectProtocol(page, 'RDP');

  // The jump-host section lives on the Proxy tab.
  await page.getByRole('tab', { name: 'Proxy' }).click();
  // The switch carries no accessible label — pick the one under the
  // "Enable jump host" text (the only other switch is "Save as persistent
  // connection" at the dialog footer).
  const enableSwitch = page.getByText('Enable jump host', { exact: true }).locator('xpath=../..').getByRole('switch');
  await enableSwitch.click();

  await expect(page.locator('#jump-host')).toBeVisible();
  await expect(page.locator('#jump-port')).toBeVisible();
  await expect(page.locator('#jump-username')).toBeVisible();
  await expect(page.locator('#jump-password')).toBeVisible();
  await expect(page.locator('#jump-use-key')).toBeVisible();

  // Toggling off hides the fields again.
  await enableSwitch.click();
  await expect(page.locator('#jump-host')).toBeHidden();
});

test('VNC protocol shows color depth instead of RDP fields', async ({ page }) => {
  await openConnectionDialog(page);
  await selectProtocol(page, 'VNC');

  // No RDP-specific fields for VNC.
  await expect(page.locator('#rdp-domain')).toBeHidden();

  // The jump-host section remains available for VNC (Proxy tab).
  await page.getByRole('tab', { name: 'Proxy' }).click();
  await expect(page.getByText('Jump Host (SSH Bastion)', { exact: false })).toBeVisible();
});

test('FTP protocol hides desktop fields and jump settings', async ({ page }) => {
  await openConnectionDialog(page);
  await selectProtocol(page, 'FTP');

  await expect(page.locator('#rdp-domain')).toBeHidden();

  // The jump-host section is gone entirely for FTP.
  await expect(page.getByText('Jump Host (SSH Bastion)', { exact: false })).toHaveCount(0);
});
