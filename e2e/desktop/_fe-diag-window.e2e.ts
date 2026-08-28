/**
 * fe-dev 临时诊断 — 验证窗口化在 query tab 与 table browse tab 的 DOM 行数。
 * 用完即删。
 */
import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

async function switchMain() {
  for (let i = 0; i < 4; i += 1) {
    try {
      await browser.tauri.switchWindow('main');
      return;
    } catch {
      await browser.pause(3000);
    }
  }
}

async function connect() {
  await (await waitForVisible('[data-testid="toolbox-nav-postgres"]')).click();
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await waitForVisible('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(`DiagWindow ${Date.now()}`);
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

async function countRows(): Promise<{ rows: number; spacers: number; windowRows: number; sectionH: number }> {
  return browser.execute(() => {
    const tbody = document.querySelector('[data-testid="postgres-workspace"] tbody') as HTMLElement | null;
    const section = tbody?.closest('section[class*="overflow-auto"]') as HTMLElement | null;
    const all = tbody ? tbody.querySelectorAll('tr').length : 0;
    const spacers = tbody ? tbody.querySelectorAll('[data-testid^="database-result-window-spacer"]').length : 0;
    return {
      rows: all,
      spacers,
      windowRows: all - spacers,
      sectionH: section?.clientHeight ?? -1,
      sectionClass: section?.className.slice(0, 60) ?? '',
    };
  });
}

describe('窗口化诊断', () => {
  it('query tab 200 行 + table tab users 70 行', async function () {
    this.timeout(180_000);
    await switchMain();
    await browser.setWindowSize(1600, 1000);
    await browser.pause(500);
    await unlockApp(`E2E_${Date.now()}`, '[data-testid="toolbox-nav-postgres"]');
    await connect();

    // Query tab: 200-row result set.
    await $('[data-testid="postgres-new-query"]').click();
    const workspace = await $('[data-testid="postgres-workspace"]');
    const editors = await workspace.$$('.cm-content');
    const editor = editors[editors.length - 1];
    await editor.click();
    await editor.clearValue();
    await editor.setValue('SELECT g AS id, g AS v1, g AS v2, g AS v3, g AS v4 FROM generate_series(1,200) g');
    await browser.pause(150);
    await $('[data-testid="postgres-run"]').click();
    await browser.pause(1500);
    const query = await countRows();
    console.log(`DIAG query-200 => ${JSON.stringify(query)}`);
    expect(query.windowRows).toBeLessThan(60);
    expect(query.spacers).toBeGreaterThan(0);

    // Table tab: users (70 rows).
    const tablesGroup = await $('[data-node-id*="/group:tables"]');
    if (!(await $('button=users').isExisting())) await tablesGroup.click();
    await waitForVisible('button=users', 15_000);
    await browser.execute((node: HTMLElement) => {
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }, await $('button=users'));
    await $('[data-testid="postgres-workspace"] tbody tr').waitForDisplayed({ timeout: 15000 });
    await browser.pause(600);
    const table = await countRows();
    console.log(`DIAG table-users => ${JSON.stringify(table)}`);
    expect(table.windowRows).toBeLessThan(60);
    expect(table.spacers).toBeGreaterThan(0);
  });
});
