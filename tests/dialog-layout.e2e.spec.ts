import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page, kind: string, lang = 'en') {
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: {
      invoke: (command: string) => Promise.resolve(command === 'row_list' || command.startsWith('list_') ? [] : command === 'row_get' ? null : undefined),
      transformCallback: () => 1,
    } });
  });
  await page.goto(`/tests/fixtures/dialog-layout.html?case=${kind}&lang=${lang}`);
  const dialog = page.locator('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]').last();
  await expect(dialog).toBeVisible();
  await dialog.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  return dialog;
}

async function expectInViewport(dialog: Locator, page: Page) {
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const rect = await dialog.boundingBox();
    return !!rect && rect.x >= 15 && rect.y >= 15 && rect.x + rect.width <= viewport.width - 15 && rect.y + rect.height <= viewport.height - 15;
  }).toBe(true);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.y).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 15);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 15);
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 600 }, { width: 640, height: 480 }, { width: 375, height: 480 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    for (const kind of ['alert', 'long-alert', 'files', 'upload-conflicts', 'wide-confirm', 'form', 'connection', 'settings', 'log', 'database', 'node', 'sync']) {
      test(`${kind} stays centered and bounded with reachable actions`, async ({ page }) => {
        const dialog = await openFixture(page, kind);
        await expectInViewport(dialog, page);
        const confirmationWidths: Record<string, number> = { alert: 400, 'long-alert': 400, files: 480, 'upload-conflicts': 560, 'wide-confirm': 560 };
        if (confirmationWidths[kind]) expect((await dialog.boundingBox())!.width).toBeCloseTo(Math.min(confirmationWidths[kind], viewport.width - 32), 0);
        const footer = dialog.locator('[data-slot="dialog-footer"], [data-slot="alert-dialog-footer"]');
        if (await footer.count()) {
          const box = (await footer.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual(15);
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 15);
        }
        if (kind === 'database') {
          const body = dialog.locator('.overflow-y-auto').last();
          expect(await body.evaluate(el => el.clientHeight > 80 && el.scrollHeight > el.clientHeight)).toBe(true);
        }
        if (kind === 'sync') {
          await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
          await expect(dialog.getByRole('button', { name: 'Re-compare' })).toBeVisible();
          await expectInViewport(dialog, page);
          expect((await dialog.locator('[data-slot="dialog-footer"]').boundingBox())!.y).toBeLessThan(viewport.height - 40);
        }
      });
    }
    test('confirmation focuses Cancel, scrolls long paths, and confirms only on action', async ({ page }) => {
      const dialog = await openFixture(page, 'files', 'zh-CN');
      await expectInViewport(dialog, page);
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('confirmed')).toHaveText('0');
      await page.getByRole('button', { name: 'Open fixture' }).click();
      const list = dialog.locator('ul');
      expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(dialog.getByRole('button', { name: '删除 80 个项目', exact: true })).toBeInViewport();
      await dialog.getByRole('button', { name: '删除 80 个项目', exact: true }).click();
      await expect(page.getByTestId('confirmed')).toHaveText('1');
    });
  });
}

test('ordinary dialog closes on outside click and Escape; alert ignores outside clicks', async ({ page }) => {
  let dialog = await openFixture(page, 'form');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Open fixture' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  dialog = await openFixture(page, 'alert');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
});

test('connection and settings tabs retain scrollable bodies and visible footer actions after resize', async ({ page }) => {
  for (const kind of ['connection', 'settings']) {
    await page.setViewportSize({ width: 900, height: 600 });
    const dialog = await openFixture(page, kind);
    const tabs = dialog.getByRole('tab');
    for (let i = 0; i < await tabs.count(); i++) {
      await tabs.nth(i).click();
      await expectInViewport(dialog, page);
      await expect(dialog.locator('[data-slot="dialog-footer"]').last()).toBeInViewport();
    }
    await page.setViewportSize({ width: 640, height: 480 });
    await expectInViewport(dialog, page);
    await expect(dialog.locator('[data-slot="dialog-footer"]').last()).toBeInViewport();
  }
});

test('nested settings confirmation is bounded and Cancel restores the parent dialog', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  const parent = await openFixture(page, 'settings');
  await parent.getByRole('button', { name: 'Reset to Defaults' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expectInViewport(confirmation, page);
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toBeHidden();
  await expect(parent).toBeVisible();
  // Safari does not focus buttons on pointer clicks; restore the prior focused
  // control inside the parent instead of imposing Chromium's mouse behavior.
  await expect.poll(() => parent.evaluate(el => el.contains(document.activeElement))).toBe(true);
});

async function openFileBrowser(page: Page, kind = 'file-browser') {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    Object.assign(window, { __fileTestCalls: calls, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        if (command === 'get_home_directory') return Promise.resolve('/local');
        if (command === 'list_files' || command === 'list_local_files' || command === 'list_remote_files') return Promise.resolve([
          { name: 'alpha.txt', size: 10, file_type: 'File', modified: null, permissions: null },
          { name: 'beta.txt', size: 20, file_type: 'File', modified: null, permissions: null },
          { name: 'docs', size: 0, file_type: 'Directory', modified: null, permissions: null },
        ]);
        if (command === 'plugin:dialog|open') return Promise.resolve(['/local/alpha.txt', '/local/new.txt']);
        if (command === 'inspect_remote_uploads') return Promise.resolve((args.paths as string[]).map(path => ({ path,
          version: path.endsWith('/alpha.txt') ? { kind: 'File', size: 10, modified: '2026-10-14 10:00:00' } : null })));
        if (command === 'stat_local_path') return Promise.resolve({ exists: true, size: 30, modified: '2026-10-14 11:00:00' });
        if (command === 'upload_remote_file') return Promise.resolve({ success: true, destination_path: args.remotePath });
        if (command === 'row_get') return Promise.resolve(null);
        if (command === 'row_list' || command.startsWith('list_')) return Promise.resolve([]);
        return Promise.resolve(true);
      },
    } });
  });
  await page.goto(`/tests/fixtures/dialog-layout.html?case=${kind}&lang=en`);
  if (kind === 'file-browser') {
    await expect(page.getByTitle('/srv/app', { exact: true })).toBeVisible();
    await expect(page.locator('[data-file-path="/srv/app/alpha.txt"]')).toBeVisible();
  } else {
    await expect(page.getByTestId('dual-active').locator('[data-panel-mode="local"]').getByText('alpha.txt', { exact: true })).toBeVisible();
  }
  await page.waitForTimeout(350);
}

test('file right-click preserves multi-selection and deletion targets the full batch', async ({ page }) => {
  await openFileBrowser(page);
  const alpha = page.locator('[data-file-path="/srv/app/alpha.txt"]');
  const beta = page.locator('[data-file-path="/srv/app/beta.txt"]');
  await alpha.click(); await beta.click({ modifiers: ['ControlOrMeta'] });
  await beta.click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(alpha).toHaveAttribute('data-selected', 'true');
  await expect(beta).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(beta).toHaveAttribute('data-selected', 'true');
  await beta.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete 2 items', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('/srv/app/alpha.txt', { exact: true })).toBeVisible();
  await expect(dialog.getByText('/srv/app/beta.txt', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete 2 items', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string }> }).__fileTestCalls.filter(call => call.command === 'delete_file').length)).toBe(2);
});

test('manual browsing pauses terminal following until explicitly resumed', async ({ page }) => {
  await openFileBrowser(page);
  const folder = page.locator('[data-file-path="/srv/app/docs"]');
  await folder.click();
  await expect(page.getByTitle('/srv/app', { exact: true })).toBeVisible();
  await folder.dblclick();
  await expect(page.getByTitle('/srv/app/docs', { exact: true })).toBeVisible();
  await page.getByTestId('terminal-cd').click();
  await expect(page.getByTitle('/srv/app/docs', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ssh-file-workspace').getByRole('status')).toHaveText('Following paused');
  await page.getByTitle('Follow terminal directory', { exact: true }).click();
  await expect(page.getByTitle('/var/log', { exact: true })).toBeVisible();
});

test('upload conflicts are approved together and retain their original directory', async ({ page }) => {
  await openFileBrowser(page);
  await page.getByTitle('Upload files', { exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible(); await expectInViewport(dialog, page);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').length)).toBe(0);
  await dialog.getByRole('combobox', { name: 'Action for /srv/app/alpha.txt', exact: true }).selectOption('replace');
  // A background terminal event cannot retarget this upload batch.
  await page.getByTestId('terminal-cd').evaluate((button: HTMLButtonElement) => button.click());
  await dialog.getByRole('button', { name: 'Continue upload', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').length)).toBe(2);
  const uploads = await page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string; args: Record<string, unknown> }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').map(call => call.args));
  expect(uploads.map(args => args.remotePath)).toEqual(['/srv/app/alpha.txt', '/srv/app/new.txt']);
  expect(uploads[0].conflictPolicy).toBe('replace');
});

test('standalone right-click selects its file before initiating upload', async ({ page }) => {
  await openFileBrowser(page, 'file-browser-dual');
  await page.getByTestId('dual-active').locator('[data-panel-mode="local"]').getByText('alpha.txt', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Upload to remote', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('/local/alpha.txt', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').length)).toBe(0);
});

test('cross-panel drops cannot enqueue uploads in another mounted workspace', async ({ page }) => {
  await openFileBrowser(page, 'file-browser-dual');
  await page.getByTestId('dual-active').locator('[data-panel-mode="remote"]').evaluate(panel => {
    panel.dispatchEvent(new CustomEvent('nexterm-drop-transfer', { bubbles: true, detail: {
      targetMode: 'remote', targetPath: '/', sourcePath: '/local', files: [{ name: 'new.txt', size: 30, file_type: 'File' }],
    } }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').length)).toBe(1);
  const owners = await page.evaluate(() => (window as unknown as { __fileTestCalls: Array<{ command: string; args: Record<string, unknown> }> }).__fileTestCalls.filter(call => call.command === 'upload_remote_file').map(call => call.args.connectionId));
  expect(owners).toEqual(['fixture-dual']);
});
