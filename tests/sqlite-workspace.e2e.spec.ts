import { expect, test } from '@playwright/test';

test.describe('SQLite workspace', () => {
  test('uses the registered SQLite provider through shared workspace UI', async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => {
            if (command === 'row_list') return Promise.resolve([]);
            if (command === 'sqlite_connect') return Promise.resolve({ connectionId: 'sqlite-e2e', connected: true });
            if (command === 'sqlite_catalog_objects') return Promise.resolve([{ name: 'projects' }, { name: 'users' }]);
            if (command === 'sqlite_execute') {
              return Promise.resolve({
                columns: ['id', 'name'],
                rows: [['1', 'Alice'], ['2', 'Bob']],
                commandTags: [],
                truncated: false,
              });
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

    // MySQL/SQLite have no dedicated nav entry since FEATURE BATCH 21+22 —
    // they are provider switches inside the database workspace. Enter via the
    // same CustomEvent the PG connection dialog's provider select dispatches.
    // Wait for the app shell (nav rail) first: the provider-selection listener
    // mounts with AppContent after storage hydration.
    await expect(page.getByTestId('toolbox-nav-postgres')).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('nexterm:database-provider-selected', { detail: 'sqlite' }));
    });
    const workspace = page.getByTestId('sqlite-workspace');
    await expect(workspace).toBeVisible();
    await expect(workspace.getByTestId('sqlite-run')).toBeDisabled();
    await page.getByTestId('sqlite-new-connection').click();

    const dialog = page.getByTestId('sqlite-connection-dialog');
    await page.getByTestId('database-provider-select').click();
    await expect(page.getByRole('option', { name: 'PostgreSQL' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'SQLite (Experimental)' })).toBeVisible();
    await page.getByRole('option', { name: 'SQLite (Experimental)' }).click();
    await expect(dialog).not.toContainText('Host');
    await expect(dialog).not.toContainText('Username');
    await expect(dialog).not.toContainText('SSH');
    await expect(dialog).not.toContainText('SSL / TLS');

    const inputs = dialog.locator('input');
    await inputs.nth(0).fill('SQLite Fixture');
    await inputs.nth(1).fill('/tmp/nexterm-renderer-fixture.db');
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(workspace.getByTestId('sqlite-disconnect')).toBeEnabled();
    await expect(workspace.getByTestId('sqlite-new-query')).toBeEnabled();
    await expect(workspace.getByRole('button', { name: 'users', exact: true })).toBeVisible();

    const editor = workspace.locator('.cm-content');
    await editor.click();
    await editor.fill('SELECT id, name FROM users ORDER BY id');
    await workspace.getByTestId('sqlite-run').click();
    const resultGrid = workspace.locator('table');
    await expect(resultGrid).toContainText('Alice');
    await expect(resultGrid).toContainText('Bob');
    await expect(workspace.getByRole('button', { name: 'Explain', exact: true })).toHaveCount(0);

    await page.getByTestId('sqlite-edit-connection').click();
    await dialog.locator('input').nth(0).fill('SQLite Fixture Edited');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('input').nth(0)).toHaveValue('SQLite Fixture Edited');
    await page.keyboard.press('Escape');
    await page.getByTestId('sqlite-delete-connection').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('sqlite-edit-connection')).toBeDisabled();
  });
});
