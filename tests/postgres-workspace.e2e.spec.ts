import { expect, test } from '@playwright/test';

test.describe('PostgreSQL workspace', () => {
  test('opens the Navicat-style workspace and connection settings', async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => {
            if (command === 'postgres_connect') {
              return Promise.resolve({ serverVersion: '16.0' });
            }
            if (command === 'postgres_catalog_schemas') {
              return Promise.resolve(['public']);
            }
            if (command === 'postgres_catalog_search') {
              return Promise.resolve([]);
            }
            return Promise.resolve(undefined);
          },
        },
      });
    });
    await page.goto('/');
    const setupPassword = page.getByRole('button', { name: 'Set Password' });
    if (await setupPassword.isVisible()) {
      await page.getByRole('textbox', { name: 'New password' }).fill('e2e-password');
      await page.getByRole('textbox', { name: 'Confirm password' }).fill('e2e-password');
      await setupPassword.click();
    }
    await page.getByTestId('toolbox-nav-postgres').click();
    await expect(page.getByTestId('postgres-workspace')).toBeVisible();
    await expect(page.getByTestId('postgres-toolbar')).toBeVisible();
    await expect(page.getByTestId('postgres-run')).toBeDisabled();
    await expect(page.getByTestId('postgres-explain')).toBeDisabled();
    await expect(page.getByTestId('postgres-connect')).toBeEnabled();
    await expect(page.getByTestId('postgres-disconnect')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/postgres/01-main-workspace.png', fullPage: true });

    await page.getByTestId('postgres-new-connection').click();
    const dialog = page.getByTestId('postgres-connection-dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(Math.abs((box!.x + box!.width / 2) - viewport!.width / 2)).toBeLessThan(2);
    expect(Math.abs((box!.y + box!.height / 2) - viewport!.height / 2)).toBeLessThan(2);
    await page.screenshot({ path: 'test-results/postgres/07-connection-general.png', fullPage: true });
    await dialog.getByRole('button', { name: 'SSH' }).click();
    await page.screenshot({ path: 'test-results/postgres/08-connection-ssh.png', fullPage: true });
    await dialog.getByRole('button', { name: 'SSL / TLS' }).click();
    await page.screenshot({ path: 'test-results/postgres/09-connection-tls.png', fullPage: true });

    await dialog.getByRole('button', { name: 'General' }).click();
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('postgres-disconnect')).toBeEnabled();
    await page.getByTestId('postgres-disconnect').click();
    await expect(page.getByTestId('postgres-disconnect')).toHaveCount(0);
    await expect(page.getByTestId('postgres-connect')).toBeEnabled();
  });
});
