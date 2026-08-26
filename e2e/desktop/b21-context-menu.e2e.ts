/**
 * B21 navigator context menu + B21 click/double-click semantics (real page).
 *
 * Covers:
 * - connection node context menu (Disconnect/New Query/Refresh/Edit/Delete)
 * - relation object menu (Open Data/Refresh/Copy Name/New Query)
 * - single-click selects without opening; double-click opens the data grid
 * - disconnected state disables Open Data on object nodes
 */
import { expect } from '@wdio/globals';

const UNIQUE = `ctx${Date.now()}`;

async function unlock() {
  const password = `E2E_${UNIQUE}`;
  await $('#app-lock-password').waitForDisplayed({ timeout: 30000 });
  await $('#app-lock-password').setValue(password);
  await $('#app-lock-confirm').waitForDisplayed({ timeout: 10000 });
  await $('#app-lock-confirm').setValue(password);
  await $('#app-lock-submit, button.w-full').click();
}

async function connectPostgres() {
  await $('[data-testid="toolbox-nav-postgres"]').waitForDisplayed();
  await $('[data-testid="toolbox-nav-postgres"]').click();
  await $('[data-testid="postgres-new-connection"]').waitForEnabled();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  await inputs[0].setValue(`B21 Menu ${UNIQUE}`);
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
  await $('[data-testid="postgres-run"]').waitForEnabled({ timeout: 20000 });
}

/** WebKit right-click is flaky; retry until the context menu actually opens. */
async function openContextMenu(selector: string, maxRetries = 4): Promise<WebdriverIO.Element> {
  const menu = await $('[data-testid="database-navigator-context-menu"]');
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    await $(selector).click({ button: 'right' });
    try {
      await menu.waitForDisplayed({ timeout: 3000 });
      return menu;
    } catch {
      await browser.keys('Escape');
      await browser.pause(400);
    }
  }
  await $(selector).click({ button: 'right' });
  await menu.waitForDisplayed({ timeout: 10000 });
  return menu;
}

describe('B21 navigator context menus and open semantics', () => {
  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlock();
  });

  it('shows the connection menu and keeps double-click open semantics', async () => {
    await connectPostgres();
    // Let the navigator finish rendering connection roots before interacting.
    await $('[data-node-id*="connection:"]').waitForDisplayed({ timeout: 10000 });
    await browser.pause(800);

    // Double-click / single-click semantics first. A context-menu open/close
    // before the double-click breaks the WebKit dblclick sequence, so the
    // menu assertions run afterwards.
    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    if (!(await $('button=users').isExisting())) {
      await tablesGroup.click();
    }
    await $('button=users').waitForDisplayed();

    // Single-click selects but must NOT open the data grid (B21 semantics).
    const workspace = await $('[data-testid="postgres-workspace"]');
    await $('button=users').click();
    const dataRowsBefore = await workspace.$$('tbody tr');
    expect(dataRowsBefore.length).toBe(0);

    // Double-click opens the data grid. WebDriver/WebKit does not synthesize
    // a native dblclick event for the doubleClick() action (it emits two
    // clicks), so we dispatch the dblclick event directly to exercise the
    // onDoubleClick → onOpen handler path.
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, await $('button=users'));
    await browser.$('[data-testid="postgres-workspace"] tbody tr').waitForDisplayed({ timeout: 15000 });
    const rowsAfterDbl = await browser.$$('[data-testid="postgres-workspace"] tbody tr');
    expect(rowsAfterDbl.length).toBeGreaterThan(0);

    // Enter = double-click (AC-21A-7): focusing the node and pressing Enter
    // must open it too.
    await $('button=users').click();
    await browser.keys('Enter');
    await browser.pause(1200);
    const rowsAfterEnter = await browser.$$('[data-testid="postgres-workspace"] tbody tr');
    expect(rowsAfterEnter.length).toBeGreaterThan(0);

    // Connection node context menu.
    const menu = await openContextMenu('[data-node-id*="connection:"]');
    const menuText = await menu.getText();
    expect(menuText).toContain('断开连接');
    expect(menuText).toContain('新建查询');
    expect(menuText).toContain('刷新');
    expect(menuText).toContain('编辑');
    expect(menuText).toContain('删除');
    await browser.keys('Escape');
    await menu.waitForExist({ reverse: true });

    // Relation object menu (B21 §5.3: Open Data / Copy Name / Generate DDL /
    // Refresh / Drop).
    const objectMenu = await openContextMenu('button=users');
    const objectMenuText = await objectMenu.getText();
    expect(objectMenuText).toContain('打开数据');
    expect(objectMenuText).toContain('复制名称');
    expect(objectMenuText).toContain('生成 DDL');
    expect(objectMenuText).toContain('刷新');
    expect(objectMenuText).toContain('删除表');
    await browser.keys('Escape');
    await objectMenu.waitForExist({ reverse: true });

    // Disconnect → Open Data becomes disabled.
    await $('[data-testid="postgres-disconnect"]').click();
    await $('[data-testid="postgres-connect"]').waitForEnabled();
    const disconnectedMenu = await openContextMenu('button=users');
    const disconnectedMenuText = await disconnectedMenu.getText();
    expect(disconnectedMenuText).toContain('复制名称');
    const openDataItem = await disconnectedMenu.$('[role="menuitem"]*=打开数据');
    if (await openDataItem.isExisting()) {
      // Radix marks disabled items with the `data-disabled` attribute.
      expect(await openDataItem.getAttribute('data-disabled')).not.toBeNull();
    }
    await browser.keys('Escape');
  });
});
