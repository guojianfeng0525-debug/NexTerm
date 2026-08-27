import { expect } from '@wdio/globals';
import fs from 'node:fs';
import { unlockApp, waitForVisible } from './helpers/webkit';

fs.mkdirSync('./test-results/create-table', { recursive: true });

/**
 * New-table designer (B23 extension): right-click the navigator "tables"
 * group → 新建表 → empty designer (createMode) → type a name, add a column,
 * save → the CREATE TABLE lands and the table appears in the navigator.
 */

const WORKSPACE_SELECTOR = '[data-testid="postgres-workspace"]';

async function connectPostgres() {
  const password = `E2E_${Date.now()}`;
  await unlockApp(password, '[data-testid="postgres-disconnect"]');
  const postgres = await waitForVisible('[data-testid="toolbox-nav-postgres"]');
  if (await $('[data-testid="postgres-disconnect"]').isExisting()) return;
  await postgres.click();
  await $('[data-testid="postgres-new-connection"]').click();
  const dialog = await $('[data-testid="postgres-connection-dialog"]');
  const inputs = await dialog.$$('input');
  for (const input of inputs) await input.clearValue();
  await inputs[0].setValue(`Create Table ${Date.now()}`);
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
}

/** Expands a navigator node matching all `parts` substrings of its id. */
async function expandNode(parts: string[]) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const nodes = await $$('[data-testid="database-navigator-node"]');
    for (const node of nodes) {
      const nodeId = (await node.getAttribute('data-node-id')) || '';
      if (parts.every((part) => nodeId.includes(part))) {
        if (await node.$('.lucide-chevron-down').isExisting()) return;
        await node.click();
        await browser.pause(700);
        return;
      }
    }
    await browser.pause(400);
  }
  throw new Error(`Navigator node not found: ${parts.join(' / ')}`);
}

/** Right-clicks a navigator node and clicks a menu item by label. */
async function contextMenuAction(nodePart: string, menuLabel: string) {
  await browser.execute((idPart: string) => {
    const btn = Array.from(
      document.querySelectorAll('[data-testid="database-navigator-node"]'),
    ).find((n) => (n.getAttribute('data-node-id') || '').includes(idPart)) as HTMLElement | undefined;
    btn?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
    );
  }, nodePart);
  const menu = await $('[data-testid="database-navigator-context-menu"]');
  await menu.waitForDisplayed({ timeout: 5000 });
  await menu.$(`[role="menuitem"]*=${menuLabel}`).click();
  await browser.pause(600);
}

describe('New Table via designer (createMode)', () => {
  before(async () => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await browser.tauri.switchWindow('main');
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await browser.pause(3000);
      }
    }
  });

  it('right-click tables group → 新建表 → add column → save creates the table', async function () {
    this.timeout(150_000);
    const tableName = `e2e_new_${Date.now() % 100000}`;
    await connectPostgres();
    await expandNode(['/group:tables']);
    await contextMenuAction('/group:tables', '新建表');

    const designerRoot = await waitForVisible('[data-testid="table-designer-root"]');
    await browser.saveScreenshot('./test-results/create-table/01-empty-designer.png');

    // createMode: table-name input is editable.
    const nameInput = await designerRoot.$('[data-testid="designer-table-name"]');
    await nameInput.waitForDisplayed({ timeout: 10_000 });
    await nameInput.setValue(tableName);

    // Add a column and fill its stable name/type controls.
    await designerRoot.$('[data-testid="designer-add-column"]').click();
    await browser.pause(500);
    const nameCell = await designerRoot.$('[data-testid="designer-column-name-0"]');
    const typeCell = await designerRoot.$('[data-testid="designer-column-type-0"]');
    await nameCell.setValue('id');
    await typeCell.setValue('serial');
    await browser.pause(800);
    await browser.saveScreenshot('./test-results/create-table/02-column-added.png');

    // DDL preview shows CREATE TABLE (debounced dry-run via apply confirmed=false).
    await browser.pause(1200);
    // eslint-disable-next-line no-console
    console.log('CREATE_DUMP ' + JSON.stringify(await browser.execute(() => {
      const el = document.querySelector('[data-testid="table-designer-tab"]');
      return el ? (el as HTMLElement).innerText.slice(0, 600) : 'NO DESIGNER';
    })));
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(() => {
          const el = document.querySelector('[data-testid="table-designer-tab"]');
          return el ? (el as HTMLElement).innerText : '';
        });
        return text.includes('CREATE TABLE');
      },
      { timeout: 15_000, timeoutMsg: 'CREATE TABLE preview did not appear' },
    );

    // Save → the table is created.
    await designerRoot.$('[data-testid="designer-save"]').click();
    await browser.pause(2500);

    // Navigator refresh shows the new table.
    await $('[data-testid="postgres-refresh"]').click();
    await browser.pause(1200);
    await expandNode(['/group:tables']);
    const found = await browser.execute((name: string) =>
      Array.from(document.querySelectorAll('[data-testid="database-navigator-node"]')).some(
        (n) => (n.getAttribute('data-node-id') || '').includes(`object:${name}`),
      ),
      tableName,
    );
    expect(found).toBe(true);
    await browser.saveScreenshot('./test-results/create-table/03-created-in-navigator.png');

    // Cleanup: drop the created table via the query editor.
    await $('[data-testid="postgres-new-query"]').click();
    const editors = await $(WORKSPACE_SELECTOR).$$('.cm-content');
    const editor = editors[editors.length - 1];
    await editor.click();
    await editor.setValue(`DROP TABLE IF EXISTS public.${tableName};`);
    await $('[data-testid="postgres-run"]').click();
    await browser.pause(1500);
  });
});
