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
    for (const kind of ['alert', 'long-alert', 'files', 'form', 'connection', 'settings', 'log', 'database', 'node', 'sync']) {
      test(`${kind} stays centered and bounded with reachable actions`, async ({ page }) => {
        const dialog = await openFixture(page, kind);
        await expectInViewport(dialog, page);
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
