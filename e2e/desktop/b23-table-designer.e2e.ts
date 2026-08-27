/**
 * B23 Table Designer + View Builder visual gate (Step 3 v2.10.0).
 *
 * Captures the full lifecycle of the table designer and view builder against
 * the live PostgreSQL fixture (nexterm-postgres-visual / 55432). Each
 * operation is screenshotted into test-results/b23/.
 */
import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

mkdirSync('./test-results/b23', { recursive: true });

async function rightClick(element: WebdriverIO.Element) {
  await element.click({ button: 'right' });
}

async function configureTheme(label: '深色' | '浅色') {
  await $('button:has(svg.lucide-settings)').click();
  const settingsDialog = await $('[role="dialog"]');
  await settingsDialog.$('button=界面').click();
  await settingsDialog.$('[role="combobox"]').click();
  await $(`[role="option"]=${label}`).click();
  await settingsDialog.$('button=保存设置').click();
  await settingsDialog.waitForExist({ reverse: true });
}

describe('B23 Table Designer + View Builder', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
  });

  it('captures the table designer + view builder lifecycle', async () => {
    const password = `E2E_${Date.now()}`;
    await unlockApp(password);
    await configureTheme('浅色');
    const screenshotDir = './test-results/b23';
    await browser.saveScreenshot(`${screenshotDir}/00-start.png`);

    // ── 1. Connect to the existing fixture ──────────────────────────────────
    const postgres = await waitForVisible('[data-testid="toolbox-nav-postgres"]');
    await postgres.click();
    await $('[data-testid="postgres-new-connection"]').click();
    const dialog = await $('[data-testid="postgres-connection-dialog"]');
    await browser.saveScreenshot(`${screenshotDir}/01-connection-dialog.png`);
    const inputs = await dialog.$$('input');
    for (const input of inputs) await input.clearValue();
    await inputs[0].setValue('NexTerm B23');
    await inputs[1].setValue('127.0.0.1');
    await browser.execute((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '55432');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, inputs[2]);
    await inputs[3].setValue('nexterm_e2e');
    await inputs[4].setValue('nexterm_e2e');
    await inputs[5].setValue('nexterm_e2e');
    await dialog.$('button=连接').click();

    await $('[data-testid="postgres-run"]').waitForEnabled();
    await expect($('[data-testid="postgres-run"]')).toBeEnabled();
    await browser.saveScreenshot(`${screenshotDir}/02-connected.png`);

    // ── 2. Open the existing `orders` table via the navigator ───────────────
    // Expand the tables group if it is collapsed (chevron-down present =
    // already expanded), then wait for the orders row.
    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    if (!(await tablesGroup.$('.lucide-chevron-down').isExisting())) {
      await tablesGroup.click();
      await browser.pause(800);
    }
    await waitForVisible('button=orders');
    await browser.saveScreenshot(`${screenshotDir}/03-navigator.png`);

    // ── 3. Right-click → "设计表" launches the designer ────────────────────
    const ordersBtn = await $('button=orders');
    await rightClick(ordersBtn);
    const ctxMenu = await $('[data-testid="database-navigator-context-menu"]');
    await ctxMenu.waitForDisplayed();
    await browser.saveScreenshot(`${screenshotDir}/04-context-menu.png`);
    const designTableItem = await $('[data-testid="database-navigator-context-menu"]')
      .$('[role="menuitem"]*=设计表');
    await designTableItem.click();
    const designerRoot = await waitForVisible('[data-testid="table-designer-root"]');
    await browser.saveScreenshot(`${screenshotDir}/05-designer-loaded.png`);

    // ── 4. Designer should show the orders columns ──────────────────────────
    // Columns load async (postgres_design_load); wait until the name inputs
    // appear, then assert via input.value (React keeps controlled values as
    // DOM properties, not always as value attributes).
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            Array.from(
              document.querySelectorAll('[data-testid="table-designer-root"] input'),
            ).map((i) => (i as HTMLInputElement).value),
        )).includes('id'),
      { timeout: 15000, timeoutMsg: 'designer columns did not load' },
    );
    const designerInputs = (await browser.execute(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="table-designer-root"] input'),
        ).map((i) => (i as HTMLInputElement).value),
    )) as string[];
    expect(designerInputs).toContain('id');
    expect(designerInputs).toContain('user_id');

    // ── 5. Toggle to the constraints tab ────────────────────────────────────
    await designerRoot.$('button=约束').click();
    await browser.saveScreenshot(`${screenshotDir}/06-designer-constraints.png`);

    // ── 6. Toggle to the foreign keys tab ───────────────────────────────────
    await designerRoot.$('button=外键').click();
    await browser.saveScreenshot(`${screenshotDir}/07-designer-foreign-keys.png`);

    // ── 7. Add a column → DDL preview should refresh ────────────────────────
    // The columns view is the default (no "列" tab — constraints/FKs are
    // collapsible Accordion sections), so the add-column button is visible.
    await designerRoot.$('[data-testid="designer-add-column"]').click();
    await browser.saveScreenshot(`${screenshotDir}/08-designer-after-add-column.png`);

    // ── 8. Revert to baseline so we don't leave the schema dirty ────────────
    await designerRoot.$('[data-testid="designer-revert"]').click();
    await browser.saveScreenshot(`${screenshotDir}/09-designer-reverted.png`);

    // ── 9. Right-click the products view → 视图只读 / design view ────────────
    const tablesRoot = await $('[data-node-id*="/group:views"]');
    if (await tablesRoot.isExisting()) {
      await tablesRoot.click();
    }
    const productsView = await $('button=e2e_orders_view');
    if (await productsView.isExisting()) {
      await rightClick(productsView);
      await $('[data-testid="database-navigator-context-menu"]').waitForDisplayed();
      const designViewItem = await $('[data-testid="database-navigator-context-menu"]')
        .$('button=设计视图');
      await designViewItem.click();
      const viewRoot = await waitForVisible('[data-testid="view-designer-root"]');
      await browser.saveScreenshot(`${screenshotDir}/10-view-builder.png`);
    } else {
      await browser.saveScreenshot(`${screenshotDir}/10-no-view-skip.png`);
    }

    // ── 10. Window-size combinations (visual gate) ─────────────────────────
    await browser.setWindowSize(960, 700);
    await browser.saveScreenshot(`${screenshotDir}/11-designer-960x700.png`);
    await browser.setWindowSize(2048, 1200);
    await browser.saveScreenshot(`${screenshotDir}/12-designer-2048x1200.png`);

    // ── 11. Dark-mode capture ───────────────────────────────────────────────
    await configureTheme('深色');
    await browser.saveScreenshot(`${screenshotDir}/13-designer-dark.png`);

    // ── 12. Done ────────────────────────────────────────────────────────────
    await browser.saveScreenshot(`${screenshotDir}/99-final.png`);
  });
});
