import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __tunnelStartArgs?: unknown[];
    __tunnelRows?: Record<string, unknown>[];
  }
}

test.describe('Remote tunnel jump-host security', () => {
  test('requires and persists user-approved jump-host fingerprint before tunnel start', async ({ page }) => {
    await page.addInitScript(() => {
      const started: unknown[] = [];
      const rows: Record<string, unknown>[] = [];
      Object.assign(window, {
        __tunnelStartArgs: started,
        __tunnelRows: rows,
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: { table?: string; row?: Record<string, unknown> },
          ) => {
            if (command === 'row_list') return Promise.resolve([]);
            if (command === 'row_upsert') {
              rows.push(args.row ?? {});
              return Promise.resolve();
            }
            if (command === 'tunnel_list') return Promise.resolve([]);
            if (command === 'ssh_host_key_fingerprint') {
              return Promise.resolve({ fingerprint: 'SHA256:tunnel-host-key' });
            }
            if (command === 'tunnel_start') {
              started.push(args);
              return Promise.resolve({ id: 'tunnel-1', active: true });
            }
            return Promise.resolve(undefined);
          },
        },
      });
    });

    await page.goto('/');
    const setup = page.getByRole('button', { name: 'Set Password' });
    if (await setup.isVisible()) {
      await page.getByRole('textbox', { name: 'New password' }).fill('e2e-password');
      await page.getByRole('textbox', { name: 'Confirm password' }).fill('e2e-password');
      await setup.click();
    }

    await page.getByTestId('toolbox-nav-tunnels').click();
    await page.getByRole('button', { name: 'Add tunnel' }).click();
    await page.locator('#tun-name').fill('Pinned jump tunnel');
    await page.locator('#tun-listen').fill('18022');
    await page.locator('#tun-host').fill('database.internal');
    await page.locator('#tun-remote-port').fill('5432');
    await page.locator('#tun-jump-host').fill('bastion.internal');
    await page.locator('#tun-jump-port').fill('22');
    await page.locator('#tun-jump-user').fill('jumpuser');
    await page.locator('#tun-jump-pass').fill('jumppass');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const trustDialog = page.getByRole('alertdialog');
    await expect(trustDialog).toContainText('Trust jump-host key?');
    await expect(trustDialog).toContainText('bastion.internal:22');
    await expect(trustDialog).toContainText('SHA256:tunnel-host-key');
    await trustDialog.screenshot({
      path: 'test-results/tunnels-host-key/trust-dialog.png',
    });

    await trustDialog.getByRole('button', { name: 'Trust and start' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__tunnelStartArgs?.length ?? 0))
      .toBe(1);
    const request = await page.evaluate(() => window.__tunnelStartArgs?.[0]);
    expect(request).toMatchObject({
      request: {
        jump_host: 'bastion.internal',
        jump_host_key_fingerprint: 'SHA256:tunnel-host-key',
      },
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__tunnelRows
              ?.filter((row) => row.jump_host === 'bastion.internal')
              .at(-1)?.jump_host_key_fingerprint,
        ),
      )
      .toBe('SHA256:tunnel-host-key');
    await expect(page.getByText('Running')).toBeVisible();
    await page.screenshot({
      path: 'test-results/tunnels-host-key/running-with-pinned-jump.png',
      fullPage: true,
    });
  });
});
